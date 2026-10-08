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
 * The most bytes of UTF-8 one name may take: a pack name, which is a
 * directory name, and each segment of a pack file path. It is a limit of the
 * file systems a root lives on, not a deployment choice. ext4 holds a name of
 * at most 255 bytes; APFS and NTFS hold one of at most 255 UTF-16 code units,
 * and a name never has more UTF-16 code units than UTF-8 bytes, so a name
 * within 255 bytes is within all three limits.
 */
export const NAME_BYTES_MAX = 255

/**
 * The form two names are compared in to find the ones a file system ignoring
 * letter case and Unicode normalization reads as one name: Unicode NFC, lower
 * case, upper case, lower case again, and NFC again. Lower case alone keeps
 * apart pairs APFS reads as one, among them `ß` and `ss`, `σ` and `ς`, `µ`
 * and `μ`, and `ſ` and `s`; the pass through upper case maps each pair to one
 * form. The key folds more widely than any one file system does: it also makes
 * one name of a few pairs that file systems keep apart, such as `ı` and `I`,
 * and refuses them, because refusing a pair costs less than writing two names
 * into one directory.
 * @param name - a name or a path.
 * @returns the folded form; two names with equal forms collide.
 */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')
}

/**
 * Hold a delivered set to the pack rules, whatever read produced it.
 * @param packs - the packs as the delivery names them.
 * @returns the same packs, once every name and every path has passed.
 * @throws {PackInstallError} when a pack name is not one directory name, a pack or a path is
 *   delivered twice — two names or two paths of one pack whose {@link collisionKey} forms are equal
 *   count as one, and so does a path one pack uses both as a file and as the directory of another
 *   path, by the same comparison — a path leaves its pack, a pack name or a path segment holds a
 *   lone UTF-16 surrogate or is over {@link NAME_BYTES_MAX} bytes of UTF-8, either of which some
 *   file system cannot hold as written, or a file carries an extension a pack may not carry. A
 *   name a file system refuses for another reason passes, and writing it fails.
 */
export function validatePacks(packs: readonly DeliveredPack[]): DeliveredPack[] {
  const names = new Set<string>()
  return packs.map((pack) => {
    const name = requirePackName(pack.name)
    if (names.has(collisionKey(name))) {
      throw new PackInstallError('duplicate-entry', name, 'a delivery names each pack once when names are folded the way skill-pack compares them')
    }
    names.add(collisionKey(name))
    const paths = new Set<string>()
    const directories = new Set<string>()
    const files = pack.files.map((file) => {
      const checked = checkFile(name, file)
      const key = collisionKey(checked.path)
      if (paths.has(key)) {
        throw new PackInstallError('duplicate-entry', `${name}/${checked.path}`, 'a pack carries each path once when paths are folded the way skill-pack compares them')
      }
      const ancestors = directoriesOf(key)
      if (directories.has(key) || ancestors.some(directory => paths.has(directory))) {
        throw new PackInstallError(
          'duplicate-entry',
          `${name}/${checked.path}`,
          'a pack uses no path as both a file and a directory when paths are folded the way skill-pack compares them',
        )
      }
      paths.add(key)
      for (const directory of ancestors) directories.add(directory)
      return checked
    })
    return { name, files }
  })
}

/**
 * The directories a pack-relative path lies in, inside its pack.
 * @param path - a pack-relative path, `/`-separated; a {@link collisionKey} form keeps every `/` of the path.
 * @returns each leading part of the path short of the whole, shortest first: `a/b/c.md` gives `a` and `a/b`.
 */
function directoriesOf(path: string): string[] {
  const segments = path.split('/')
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join('/'))
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

/** Refuse a pack directory name that is not one path segment, or that holds a lone UTF-16 surrogate or is too long for ext4. */
function requirePackName(name: string): string {
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes(sep) || name.includes('\0')) {
    throw new PackInstallError('path-escape', name, 'a pack name is one directory name')
  }
  requireWritableName(name, name)
  return name
}

/**
 * Refuse the two kinds of name some file system cannot hold as written, the
 * only two this package checks before writing. Node writes a lone UTF-16
 * surrogate as U+FFFD, so two names differing only in one would land in one
 * directory entry. A name over {@link NAME_BYTES_MAX} bytes of UTF-8 does not
 * fit ext4, and is refused on every platform, so the longest name a set may
 * use is the same everywhere. A name the file system refuses for another
 * reason, such as one holding a code point APFS refuses, fails the write.
 * @param entry - the entry, as a refusal names it.
 * @param name - one pack name or one path segment.
 * @throws {PackInstallError} `path-escape`, when the name holds a lone surrogate or is too long.
 */
function requireWritableName(entry: string, name: string): void {
  if (!name.isWellFormed()) throw new PackInstallError('path-escape', entry, 'a name holds no lone UTF-16 surrogate')
  if (Buffer.byteLength(name, 'utf8') > NAME_BYTES_MAX) {
    throw new PackInstallError('path-escape', entry, `a name is at most ${String(NAME_BYTES_MAX)} bytes of UTF-8`)
  }
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
  for (const segment of segments) requireWritableName(entry, segment)
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
