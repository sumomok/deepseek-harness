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
 *
 * The staged tree is verified as a pack root and not only as a set of files:
 * every pack's manifest parses, every pack stating an anchor format states one
 * this build reads, every pack declaring views states a view format this build
 * reads, and every declared view file is there and is a view. A delivery failing any of it is refused whole, because a pack root
 * that installs a broken view only says so on the status route, long after the
 * operator who copied the file has gone. A requirement this deployment does
 * not meet yet is the opposite case and installs: a pack naming a plugin, a
 * part or a platform version that is not here is a delivery that arrived
 * before its plugin, and it activates by itself when that row is composed.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/install
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { readPackArchive } from './archive.ts'
import { readSourceDirectory, validatePacks } from './delivery.ts'
import { anchorFormatMissing, readsDeclaredViews, viewFormatMissing } from './manifest.ts'
import { describeMissing, type PackObservation } from './reconcile.ts'
import { PackInstallError } from './refusal.ts'
import { PACK_ENTRY_FILE, readPackRoot } from './scan.ts'
import type { DeliveredPack, PackArchiveDelivery, PackDelivery, PackSetIdentity } from './types.ts'

/** One pack of a delivered set, read out of the staged tree the way a pack root is read. */
export interface StagedPack extends PackObservation {
  /** The pack's own directory name inside the delivered set, which a refusal names it by. */
  readonly name: string
}

/** One staged pack a caller's own surface will not accept: which pack, which file, and why. */
export interface StagedPackRefusal {
  /** The pack's directory name, as {@link StagedPack.name} carries it. */
  readonly pack: string
  /** Pack-relative path of the file the refusal is about, such as `views/space-layer.yml`. */
  readonly file: string
  /** What is wrong with it, in the words that surface refuses it in. */
  readonly reason: string
}

/**
 * How a caller judges a delivered set against the surface it composes.
 *
 * The judgement a view really needs — does this deployment offer the part the
 * view places, and will it accept these values — belongs to the component
 * catalog, which this package must not import and a delivery-side caller does
 * not have. It is therefore a parameter: a caller holding a composed surface
 * passes one, a caller holding none passes nothing, and the structural checks
 * above run either way.
 * @param packs - every pack of the delivered set, each with a manifest that
 *   parsed and view files that all parsed.
 * @returns the first pack that surface refuses, or `undefined` when it refuses none.
 */
export type VerifyStagedPacks = (packs: readonly StagedPack[]) => StagedPackRefusal | undefined

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
 * @param verify - how the delivered views are judged against a composed surface; absent where the caller composes none.
 * @returns what the root now holds, what was retired, and which set the archive delivered.
 * @throws {PackInstallError} when the archive is over a limit, is unreadable, disagrees with its own
 *   manifest, or carries a pack file a pack may not carry.
 */
export function syncPackRoot(targetRoot: string, delivery: PackArchiveDelivery, verify?: VerifyStagedPacks): Promise<PackArchiveSyncResult>
/**
 * Make a pack root hold exactly the delivered packs.
 * @param targetRoot - absolute path of the pack root to replace.
 * @param delivery - the packs to install, the directory holding them, or the archive carrying them.
 * @param verify - how the delivered views are judged against a composed surface; absent where the caller composes none.
 * @returns what the root now holds and what was retired.
 * @throws {PackInstallError} when a delivered entry is a symbolic link, leaves its pack directory,
 *   is not a pack directory, carries an extension a pack may not carry, or is delivered twice, and when
 *   a delivered pack's manifest, view format or view file is one this deployment will not read.
 */
export function syncPackRoot(targetRoot: string, delivery: PackDelivery, verify?: VerifyStagedPacks): Promise<SyncPackRootResult>
/**
 * Running the same delivery twice writes nothing the second time: the call
 * compares the root against the delivered set first and returns unchanged when
 * every pack, every path and every byte already matches. Nothing is verified
 * on that path either, because nothing is being installed.
 */
export async function syncPackRoot(targetRoot: string, delivery: PackDelivery, verify?: VerifyStagedPacks): Promise<SyncPackRootResult> {
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
    await verifyStaged(staging, verify)
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

/**
 * Re-read the staged tree and refuse anything a pack root may not hold, before
 * it becomes the live one.
 *
 * Read the way the live root is read, so what passes here is what the provider
 * will make of it. A directory carrying no readable `SKILL.md` frontmatter is
 * not a pack and is not judged as one; a directory that is a pack has its
 * manifest, its anchor format, its view format and each of its declared view
 * files held to the rules a pack is offered under.
 * @param staging - absolute path of the staged tree.
 * @param verify - the caller's own surface, where it composes one.
 * @throws {PackInstallError} naming the pack, the file and what is wrong with it.
 */
async function verifyStaged(staging: string, verify: VerifyStagedPacks | undefined): Promise<void> {
  validatePacks(await readSourceDirectory(staging))
  const packs = (await readPackRoot(staging)).map((source): StagedPack => ({
    name: basename(source.directory),
    skill: source.skill,
    manifest: source.manifest,
    views: source.views,
  }))
  for (const pack of packs) {
    const entry = `${pack.name}/${PACK_ENTRY_FILE}`
    if (!pack.manifest.ok) {
      const { field, reason } = pack.manifest
      throw new PackInstallError('pack-manifest', entry, describeMissing({ kind: 'manifest-invalid', field, reason }))
    }
    const anchorFormat = anchorFormatMissing(pack.manifest.manifest)
    if (anchorFormat !== undefined) throw new PackInstallError('pack-anchor-format', entry, describeMissing(anchorFormat))
    if (!readsDeclaredViews(pack.manifest.manifest)) {
      throw new PackInstallError('pack-view-format', entry, describeMissing(viewFormatMissing(pack.manifest.manifest)))
    }
    for (const view of pack.views) {
      if (!view.ok) throw new PackInstallError('pack-view', `${pack.name}/${view.path}`, view.reason)
    }
  }
  const refusal = verify?.(packs)
  if (refusal !== undefined) {
    throw new PackInstallError('pack-view-refused', `${refusal.pack}/${refusal.file}`, refusal.reason)
  }
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
