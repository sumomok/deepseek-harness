/**
 * The rules a delivered set obeys, and the read that turns a source directory
 * into one.
 *
 * A pack carries instructions, view files and pictures. It carries no code:
 * every other extension is refused by name, because a pack root is a directory
 * a delivery writes into, and a pack that could carry an executable file would
 * be an install path for one.
 *
 * Every delivery passes through {@link validatePacks}, whatever it arrived as,
 * so a directory, the packs themselves and an archive are held to one set of
 * rules and a refusal reads the same for all three.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/delivery
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, posix, sep } from 'node:path'
import { PackInstallError } from './refusal.ts'
import type { DeliveredFile, DeliveredPack } from './types.ts'

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

/**
 * The form two names are compared in to find the ones a file system ignoring
 * letter case and Unicode normalization reads as one name: Unicode NFC, then
 * lower case.
 * @param name - a name or a path.
 * @returns the folded form; two names with equal forms collide.
 */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase()
}

/**
 * Hold a delivered set to the pack rules, whatever read produced it.
 * @param packs - the packs as the delivery names them.
 * @returns the same packs, once every name and every path has passed.
 * @throws {PackInstallError} when a pack name is not one directory name, a pack or a path is
 *   delivered twice, a path leaves its pack, or a file carries an extension a pack may not carry.
 */
export function validatePacks(packs: readonly DeliveredPack[]): DeliveredPack[] {
  const names = new Set<string>()
  return packs.map((pack) => {
    const name = requirePackName(pack.name)
    if (names.has(name)) {
      throw new PackInstallError('duplicate-entry', name, 'a delivery names each pack once')
    }
    names.add(name)
    const paths = new Set<string>()
    const files = pack.files.map((file) => {
      const checked = checkFile(name, file)
      if (paths.has(checked.path)) {
        throw new PackInstallError('duplicate-entry', `${name}/${checked.path}`, 'a pack carries each path once')
      }
      paths.add(checked.path)
      return checked
    })
    return { name, files }
  })
}

/**
 * Read a source directory into a delivered set, refusing anything that is not a pack.
 * @param source - absolute path of the directory whose immediate children are pack directories.
 * @returns one delivered pack per child directory, in the order the directory lists them.
 * @throws {PackInstallError} when the directory holds a symbolic link or an entry that is not a directory.
 */
export async function readSourceDirectory(source: string): Promise<DeliveredPack[]> {
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
