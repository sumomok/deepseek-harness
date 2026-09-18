/**
 * Replacing a pack root with a delivered set of packs.
 *
 * The operation is a replacement, not a merge: after it, the pack root holds
 * the delivered packs and nothing else. A pack that was retired upstream is
 * gone, and a pack somebody dropped into the root by hand is gone with it, so
 * the root always says what the delivery says and a deployment never has to be
 * told which of the two to believe.
 *
 * Nothing is written into the live root. The delivered set is staged into a
 * sibling directory, verified there, and then swapped in by rename, so a
 * failure part-way through leaves the root exactly as it was and a reader
 * never observes a half-written root.
 *
 * A pack carries instructions, view files and pictures. It carries no code:
 * every other extension is refused by name, because a pack root is a directory
 * a delivery writes into, and a pack that could carry an executable file would
 * be an install path for one.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/install
 */

import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, posix, sep } from 'node:path'

/** File extensions a pack may carry, lowercase and including the dot. */
const PACK_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  '.md',
  '.yml',
  '.yaml',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
])

/** What a {@link PackInstallError} refused. */
export type PackInstallRefusal =
  /** The file's extension is not one a pack may carry. */
  | 'code-file'
  /** The path leaves the pack directory, or names no pack directory at all. */
  | 'path-escape'
  /** The entry is a symbolic link, which would carry the root's contents outside it. */
  | 'symlink'
  /** The delivered set holds an entry that is not a pack directory. */
  | 'not-a-pack'

/** A delivery this package refused, naming the entry and what was wrong with it. */
export class PackInstallError extends Error {
  /** Which rule refused the entry. */
  readonly refusal: PackInstallRefusal
  /** The entry, as the delivery named it. */
  readonly entry: string

  /**
   * @param refusal - which rule refused the entry.
   * @param entry - the entry, as the delivery named it.
   * @param detail - the sentence stating what the rule requires.
   */
  constructor(refusal: PackInstallRefusal, entry: string, detail: string) {
    super(`skill-pack: refused ${entry} — ${detail}`)
    this.name = 'PackInstallError'
    this.refusal = refusal
    this.entry = entry
  }
}

/** One file inside a delivered pack. */
export interface DeliveredFile {
  /** Pack-relative path, written with `/` separators. */
  readonly path: string
  /** The file's bytes; a string is written as UTF-8. */
  readonly content: string | Uint8Array
}

/** One pack in a delivered set. */
export interface DeliveredPack {
  /** The pack's directory name inside the pack root. */
  readonly name: string
  /** Every file the pack carries, in any order. */
  readonly files: readonly DeliveredFile[]
}

/** Where the delivered set comes from. */
export type PackDelivery =
  /** A directory whose immediate children are pack directories. */
  | { readonly kind: 'directory'; readonly path: string }
  /** The packs themselves, already in hand. */
  | { readonly kind: 'packs'; readonly packs: readonly DeliveredPack[] }

/** What one {@link syncPackRoot} call did. */
export interface SyncPackRootResult {
  /** Whether the root's contents differed from the delivered set and were replaced. */
  readonly changed: boolean
  /** Every pack the root now holds, in name order. */
  readonly packs: readonly string[]
  /** Every pack the root held and no longer does, in name order. */
  readonly retired: readonly string[]
}

/**
 * Make a pack root hold exactly the delivered packs.
 *
 * Running the same delivery twice writes nothing the second time: the call
 * compares the root against the delivered set first and returns unchanged when
 * every pack, every path and every byte already matches.
 * @param targetRoot - absolute path of the pack root to replace.
 * @param delivery - the packs to install, or the directory holding them.
 * @returns what the root now holds and what was retired.
 * @throws {PackInstallError} when a delivered entry is a symbolic link, leaves its pack directory,
 *   is not a pack directory, or carries an extension a pack may not carry.
 */
export async function syncPackRoot(targetRoot: string, delivery: PackDelivery): Promise<SyncPackRootResult> {
  const delivered = await collectDelivery(delivery)
  const present = await readInstalledPacks(targetRoot)
  const packs = delivered.map(pack => pack.name).sort()
  const retired = [...present.packs.keys()].filter(name => !packs.includes(name)).sort()
  if (matchesInstalled(delivered, present)) {
    return { changed: false, packs, retired: [] }
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
  return { changed: true, packs, retired }
}

/** Read the delivered set, walking the source directory when the delivery names one. */
async function collectDelivery(delivery: PackDelivery): Promise<DeliveredPack[]> {
  const packs = delivery.kind === 'packs' ? delivery.packs : await readSourceDirectory(delivery.path)
  return packs.map(pack => ({ name: requirePackName(pack.name), files: pack.files.map(file => checkFile(pack.name, file)) }))
}

/** Walk a source directory into delivered packs, refusing anything that is not one. */
async function readSourceDirectory(source: string): Promise<DeliveredPack[]> {
  const entries = await readdir(source, { withFileTypes: true, encoding: 'utf8' })
  const packs: DeliveredPack[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new PackInstallError('symlink', entry.name, 'a pack root follows no symbolic link')
    if (!entry.isDirectory()) throw new PackInstallError('not-a-pack', entry.name, 'a pack root holds pack directories only')
    packs.push({ name: entry.name, files: await readPackFiles(join(source, entry.name), '') })
  }
  return packs
}

/** Read one pack directory's files, pack-relative, refusing symbolic links at any depth. */
async function readPackFiles(directory: string, prefix: string): Promise<DeliveredFile[]> {
  const entries = await readdir(directory, { withFileTypes: true, encoding: 'utf8' })
  const files: DeliveredFile[] = []
  for (const entry of entries) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) throw new PackInstallError('symlink', relative, 'a pack carries no symbolic link')
    if (entry.isDirectory()) {
      files.push(...await readPackFiles(join(directory, entry.name), relative))
      continue
    }
    files.push({ path: relative, content: await readFile(join(directory, entry.name)) })
  }
  return files
}

/** Refuse a pack directory name that is not one path segment. */
function requirePackName(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes(sep) || name.includes('\0')) {
    throw new PackInstallError('path-escape', name, 'a pack name is one directory name')
  }
  return name
}

/** Refuse a pack-relative path that escapes its pack, and any extension a pack may not carry. */
function checkFile(pack: string, file: DeliveredFile): DeliveredFile {
  const entry = `${pack}/${file.path}`
  const segments = file.path.split('/')
  if (file.path === '' || file.path.startsWith('/') || file.path.includes('\0')
    || segments.some(segment => segment === '' || segment === '.' || segment === '..')
    || posix.normalize(file.path) !== file.path) {
    throw new PackInstallError('path-escape', entry, 'a pack file path stays inside its pack')
  }
  requirePackExtension(entry)
  return file
}

/** Refuse an extension a pack may not carry, naming the set it may. */
function requirePackExtension(entry: string): void {
  const name = entry.slice(entry.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  const extension = dot <= 0 ? '' : name.slice(dot).toLowerCase()
  if (!PACK_FILE_EXTENSIONS.has(extension)) {
    throw new PackInstallError(
      'code-file',
      entry,
      `a pack carries only ${[...PACK_FILE_EXTENSIONS].join(', ')}`,
    )
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
  for (const pack of await readSourceDirectory(staging)) {
    requirePackName(pack.name)
    for (const file of pack.files) checkFile(pack.name, file)
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
