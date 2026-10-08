/**
 * The rule that keeps the directories one row's configuration names apart.
 *
 * The pack root and the organization root are each replaced whole, and the
 * delivery directory is never written, so no two of the three may be one
 * directory or lie one inside the other. Each directory is written at the path
 * its configuration resolves to; only the comparison reads another form of
 * that path, the one the file system reads it as.
 *
 * That form follows every symbolic link the path passes through: the longest
 * leading part of the path that exists is replaced by its real path, and the
 * rest is joined back on unchanged. A path whose longest leading part that
 * exists is a symbolic link whose target does not exist, a link in a loop
 * among them, is refused instead: the directory would be created wherever
 * the link points, and the comparison would read the link's own path. On macOS and Windows it is also folded by
 * {@link collisionKey}, the key the pack rules compare names with, because
 * APFS and NTFS ignore letter case by default and APFS also ignores which
 * Unicode normalization form a name is written in. One fold serves both
 * platforms, and it is wider than either file system's: a pair that differs
 * only in normalization is refused on Windows too, where NTFS keeps the two
 * apart, and so is a pair such as `ı` and `I`, which the key folds and APFS
 * keeps apart.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/directories
 */

import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { collisionKey } from './delivery.ts'

/** One directory a row's configuration names. */
export interface ConfiguredDirectory {
  /** The configuration field, as a refusal names it. */
  readonly field: string
  /** The resolved absolute path, which every write uses. */
  readonly path: string
}

/** The platforms whose default file systems ignore letter case, and whose comparison folds names. */
const FOLDING_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'win32'])

/**
 * Refuse any two configured directories that are one directory, or one of
 * which lies inside the other, as the file system reads them.
 * @param directories - every directory the row configures, in the order a refusal names them.
 * @param platform - the platform the row runs on, which decides whether names are folded.
 * @throws {Error} naming the first such pair, by field and resolved path, and the forms they were compared in; or
 *   naming the first directory reached through a symbolic link whose target does not exist, by field, resolved path
 *   and the link's path.
 */
export function refuseSharedDirectories(directories: readonly ConfiguredDirectory[], platform: NodeJS.Platform): void {
  const compared = directories.map(directory => ({ ...directory, key: comparedPath(directory, platform) }))
  for (const [index, left] of compared.entries()) {
    for (const right of compared.slice(index + 1)) {
      if (!within(left.key, right.key) && !within(right.key, left.key)) continue
      throw new Error(`skill-pack: ${left.field} ${JSON.stringify(left.path)} and ${right.field} ${JSON.stringify(right.path)} `
        + 'must be separate directories, neither inside the other, because replacing one would write into the other; '
        + `they are compared as ${JSON.stringify(left.key)} and ${JSON.stringify(right.key)}`)
    }
  }
}

/**
 * The form one configured directory is compared in.
 *
 * The walk up reads each leading part without following its last segment, so
 * the part it stops at is the longest one that exists as a directory entry,
 * a symbolic link included. A file-system root always exists, so the walk
 * ends there at the latest; a root that does not, such as a Windows drive
 * that is not mounted, fails the real-path read and so the load.
 * @param directory - the configured directory, its path resolved and absolute.
 * @param platform - the platform the row runs on.
 * @returns the path with the real path of its longest existing leading part, folded where the platform folds names.
 * @throws {Error} when that leading part is a symbolic link whose target does not exist.
 */
function comparedPath(directory: ConfiguredDirectory, platform: NodeJS.Platform): string {
  const { field, path } = directory
  let existing = path
  let entry = entryAt(existing)
  while (entry === undefined && dirname(existing) !== existing) {
    existing = dirname(existing)
    entry = entryAt(existing)
  }
  if (entry !== undefined && entry.isSymbolicLink() && !existsSync(existing)) {
    throw new Error(`skill-pack: ${field} ${JSON.stringify(path)} resolves through the symbolic link ${JSON.stringify(existing)}, `
      + 'whose target does not exist, so the real path of the directory it names cannot be read')
  }
  const real = join(realpathSync.native(existing), relative(existing, path))
  return FOLDING_PLATFORMS.has(platform) ? collisionKey(real) : real
}

/**
 * The directory entry at one path, its last segment not followed.
 * @param path - an absolute path.
 * @returns the entry, or `undefined` when none can be read there.
 */
function entryAt(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (_noEntry) {
    // Absent, under a file, under a link in a loop, or under a directory this
    // process cannot search: there is no entry to read, and the walk goes on
    // to the parent.
    return undefined
  }
}

/**
 * Whether one absolute path is another, or lies inside it.
 * @param outer - the containing path.
 * @param inner - the path that may be inside it.
 * @returns `true` when `inner` is `outer` or a descendant of it.
 */
function within(outer: string, inner: string): boolean {
  const path = relative(outer, inner)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}
