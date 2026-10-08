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
 * rest is joined back on unchanged. On macOS and Windows it is also folded to
 * Unicode NFC and lower case, because APFS and NTFS ignore letter case by
 * default and APFS also ignores which Unicode normalization form a name is
 * written in. A pair that differs only in normalization is therefore refused
 * on Windows too, where NTFS would keep the two apart.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/directories
 */

import { existsSync, realpathSync } from 'node:fs'
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
 * @throws {Error} naming the first such pair, by field and resolved path, and the forms they were compared in.
 */
export function refuseSharedDirectories(directories: readonly ConfiguredDirectory[], platform: NodeJS.Platform): void {
  const compared = directories.map(directory => ({ ...directory, key: comparedPath(directory.path, platform) }))
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
 * The form one resolved path is compared in.
 *
 * A file-system root always exists, so the walk up ends there at the latest;
 * a root that does not, such as a Windows drive that is not mounted, fails the
 * real-path read and so the load.
 * @param path - the resolved absolute path.
 * @param platform - the platform the row runs on.
 * @returns the path with the real path of its longest existing leading part, folded where the platform folds names.
 */
function comparedPath(path: string, platform: NodeJS.Platform): string {
  let existing = path
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing)
  const real = join(realpathSync.native(existing), relative(existing, path))
  return FOLDING_PLATFORMS.has(platform) ? collisionKey(real) : real
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
