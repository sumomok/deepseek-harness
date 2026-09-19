/**
 * Replacing a pack root with a delivered set of packs.
 *
 * The operation is a replacement, not a merge: after it, the pack root holds
 * the delivered packs and nothing else. A pack that was retired upstream is
 * gone, and a pack somebody dropped into the root by hand is gone with it, so
 * the root always says what the delivery says and a deployment never has to be
 * told which of the two to believe.
 *
 * A delivery arrives as a directory, as the packs themselves, or as one
 * archive file; the three differ only in how the set is read. All of them pass
 * the same pack rules, and an archive is verified against its own manifest
 * before any of it is staged.
 *
 * Nothing is written into the live root. The delivered set is staged into a
 * sibling directory, verified there, and then swapped in by rename, so a
 * failure part-way through leaves the root exactly as it was and a reader
 * never observes a half-written root.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/install
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { readPackArchive } from './archive.ts'
import { readSourceDirectory, validatePacks } from './delivery.ts'
import type { DeliveredPack, PackArchiveDelivery, PackDelivery, PackSetIdentity } from './types.ts'

/** What one {@link syncPackRoot} call did. */
export interface SyncPackRootResult {
  /** Whether the root's contents differed from the delivered set and were replaced. */
  readonly changed: boolean
  /** Every pack the root now holds, in name order. */
  readonly packs: readonly string[]
  /** Every pack the root held and no longer does, in name order. */
  readonly retired: readonly string[]
  /** Which set was delivered, for an archive delivery; a directory and packs in hand carry no identity. */
  readonly set?: PackSetIdentity
}

/** What one archive install did. An archive states which set it is, so the result carries that identity. */
export interface PackArchiveSyncResult extends SyncPackRootResult {
  /** The set the archive's manifest stated. */
  readonly set: PackSetIdentity
}

/**
 * Make a pack root hold exactly the packs one archive delivers.
 * @param targetRoot - absolute path of the pack root to replace.
 * @param delivery - the archive, the name a refusal reports it under, and the limits it is read under.
 * @returns what the root now holds, what was retired, and which set the archive delivered.
 * @throws {PackInstallError} when the archive is over a limit, is unreadable, disagrees with its own
 *   manifest, or carries a pack file a pack may not carry.
 */
export function syncPackRoot(targetRoot: string, delivery: PackArchiveDelivery): Promise<PackArchiveSyncResult>
/**
 * Make a pack root hold exactly the delivered packs.
 * @param targetRoot - absolute path of the pack root to replace.
 * @param delivery - the packs to install, the directory holding them, or the archive carrying them.
 * @returns what the root now holds and what was retired.
 * @throws {PackInstallError} when a delivered entry is a symbolic link, leaves its pack directory,
 *   is not a pack directory, carries an extension a pack may not carry, or is delivered twice.
 */
export function syncPackRoot(targetRoot: string, delivery: PackDelivery): Promise<SyncPackRootResult>
/**
 * Running the same delivery twice writes nothing the second time: the call
 * compares the root against the delivered set first and returns unchanged when
 * every pack, every path and every byte already matches.
 */
export async function syncPackRoot(targetRoot: string, delivery: PackDelivery): Promise<SyncPackRootResult> {
  const read = await readDelivery(delivery)
  const delivered = validatePacks(read.packs)
  const identity = read.set === undefined ? {} : { set: read.set }
  const present = await readInstalledPacks(targetRoot)
  const packs = delivered.map(pack => pack.name).sort()
  const retired = [...present.packs.keys()].filter(name => !packs.includes(name)).sort()
  if (matchesInstalled(delivered, present)) {
    return { changed: false, packs, retired: [], ...identity }
  }
  const staging = `${targetRoot}.staging-${randomUUID()}`
  try {
    await stage(staging, delivered)
    await verifyStaged(staging)
    await swap(targetRoot, staging)
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
  return { changed: true, packs, retired, ...identity }
}

/** The delivered set as the delivery carries it, before the pack rules have seen it. */
interface ReadDelivery {
  /** The packs the delivery names. */
  readonly packs: readonly DeliveredPack[]
  /** The set an archive says it is; absent for the other two deliveries. */
  readonly set?: PackSetIdentity
}

/** Read the delivered set, walking a source directory or verifying an archive when the delivery is one. */
async function readDelivery(delivery: PackDelivery): Promise<ReadDelivery> {
  switch (delivery.kind) {
    case 'packs':
      return { packs: delivery.packs }
    case 'directory':
      return { packs: await readSourceDirectory(delivery.path) }
    case 'archive':
      return readPackArchive(delivery.name, delivery.bytes, delivery.limits)
    /* v8 ignore start -- PackDelivery is a closed union; a future member must fail compilation here. */
    default:
      return assertNever(delivery, 'PackDelivery.kind')
    /* v8 ignore stop */
  }
}

/** The pack root as it stands, and whether it holds anything a delivery would not have written. */
interface InstalledRoot {
  /** Pack directory name to pack-relative path to bytes. */
  readonly packs: ReadonlyMap<string, ReadonlyMap<string, Buffer>>
  /** A loose file at the top of the root, or a symbolic link at any depth. Drift is always replaced. */
  readonly drift: boolean
}

/** Read the pack root as it stands. */
async function readInstalledPacks(root: string): Promise<InstalledRoot> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    // Swallowed here and nowhere else: a pack root that does not exist yet is
    // the first install, which this function reports as an empty root.
    return { packs: new Map(), drift: false }
  }
  const packs = new Map<string, Map<string, Buffer>>()
  let drift = false
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      drift = true
      continue
    }
    const read = await readPackFilesUnchecked(join(root, entry.name), '')
    drift ||= read.drift
    packs.set(entry.name, read.files)
  }
  return { packs, drift }
}

/** Read a directory the delivery did not write, so its contents are compared rather than judged. */
async function readPackFilesUnchecked(directory: string, prefix: string): Promise<{ files: Map<string, Buffer>; drift: boolean }> {
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  const files = new Map<string, Buffer>()
  let drift = false
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      drift = true
      continue
    }
    if (entry.isDirectory()) {
      const nested = await readPackFilesUnchecked(join(directory, entry.name), relative)
      drift ||= nested.drift
      for (const [path, content] of nested.files) files.set(path, content)
      continue
    }
    files.set(relative, await readFile(join(directory, entry.name)))
  }
  return { files, drift }
}

/** Whether the root already holds exactly the delivered packs, path for path and byte for byte. */
function matchesInstalled(delivered: readonly DeliveredPack[], present: InstalledRoot): boolean {
  if (present.drift || delivered.length !== present.packs.size) return false
  return delivered.every((pack) => {
    const files = present.packs.get(pack.name)
    if (files === undefined || files.size !== pack.files.length) return false
    return pack.files.every(file => files.get(file.path)?.equals(Buffer.from(file.content)) === true)
  })
}

/** Write the delivered set into a fresh staging directory. */
async function stage(staging: string, delivered: readonly DeliveredPack[]): Promise<void> {
  await mkdir(staging, { recursive: true })
  for (const pack of delivered) {
    const directory = join(staging, pack.name)
    await mkdir(directory, { recursive: true })
    for (const file of pack.files) {
      const target = join(directory, ...file.path.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, file.content)
    }
  }
}

/** Re-read the staged tree and refuse anything a pack may not carry, before it becomes the live root. */
async function verifyStaged(staging: string): Promise<void> {
  validatePacks(await readSourceDirectory(staging))
}

/** Replace the root with the staged tree: the old root moves aside, the new one takes its name, the old one is removed. */
async function swap(targetRoot: string, staging: string): Promise<void> {
  await mkdir(dirname(targetRoot), { recursive: true })
  const retired = `${targetRoot}.retired-${randomUUID()}`
  let moved = false
  try {
    await rename(targetRoot, retired)
    moved = true
  } catch {
    // Swallowed here and nowhere else: the first install has no root to move
    // aside, and every other rename failure surfaces from the rename below.
  }
  await rename(staging, targetRoot)
  if (moved) await rm(retired, { recursive: true, force: true })
}
