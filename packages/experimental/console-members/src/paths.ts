/**
 * The form two root paths are compared in.
 *
 * A path is compared as the file system reads it: the longest leading part
 * that exists is replaced by its real path and the rest is joined back on, so
 * a symbolic link to a root, a root reached through a linked directory, and a
 * root that does not exist yet all compare by the directory they name. On
 * macOS and Windows the result is also folded, because APFS and NTFS ignore
 * letter case by default and APFS also ignores the Unicode normalization form;
 * the fold maps a few pairs the file systems keep apart, such as `ı` and `I`,
 * to one form, and treats them as one root.
 * @module @deepseek-ai/dsh-experimental-console-members/src/paths
 */

import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

/** The platforms whose default file systems ignore letter case. */
const CASE_FOLDING: ReadonlySet<NodeJS.Platform> = new Set(['darwin', 'win32'])

/**
 * The path with the real path of its longest existing leading part.
 * @param path - an absolute path.
 * @returns the path as the file system reads it, unfolded.
 * @throws {Error} when that leading part is a symbolic link whose target does not exist; the message carries no path.
 */
export function canonicalPath(path: string): string {
  let existing = path
  let entry = entryAt(existing)
  while (entry === undefined && dirname(existing) !== existing) {
    existing = dirname(existing)
    entry = entryAt(existing)
  }
  if (entry?.isSymbolicLink() === true && !existsSync(existing)) {
    throw new Error('console-members: a root path leads through a symbolic link whose target does not exist')
  }
  return join(realpathSync.native(existing), relative(existing, path))
}

/**
 * The key two canonical root paths are compared by.
 * @param canonical - a path {@link canonicalPath} returned.
 * @param platform - the platform the row runs on, which decides whether the key is folded.
 * @returns the path, folded on platforms whose file systems ignore case.
 */
export function rootKey(canonical: string, platform: NodeJS.Platform): string {
  return CASE_FOLDING.has(platform) ? foldName(canonical) : canonical
}

/**
 * Fold a name so that names APFS or NTFS read as one compare equal: Unicode
 * NFC, lower case, upper case, lower case again, NFC again. The pass through
 * upper case maps pairs such as `ß` and `ss`, `σ` and `ς`, or `ſ` and `s` to
 * one form, which lower case alone keeps apart.
 * @param name - a name or a path.
 * @returns the folded form.
 */
export function foldName(name: string): string {
  return name.normalize('NFC').toLowerCase().toUpperCase().toLowerCase().normalize('NFC')
}

/**
 * Whether two compared keys name one directory or one lies inside the other.
 * @param left - one key from {@link rootKey}.
 * @param right - another key from {@link rootKey}.
 * @returns `true` when the two overlap.
 */
export function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left)
}

/**
 * Whether one key is another or lies inside it.
 * @param outer - the containing key.
 * @param inner - the key that may lie inside it.
 * @returns `true` when `inner` is `outer` or a descendant of it.
 */
export function contains(outer: string, inner: string): boolean {
  const path = relative(outer, inner)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

/**
 * The directory entry at one path, its last segment not followed.
 * @param path - an absolute path.
 * @returns the entry, or `undefined` when none can be read there.
 */
function entryAt(path: string): Stats | undefined {
  try {
    return lstatSync(path)
  } catch (_unreadable) {
    // No entry here, or none this process may read: the walk continues at the parent.
    return undefined
  }
}
