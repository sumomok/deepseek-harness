/**
 * Comparing link targets as `readlinkSync` reports them. Only `node:path`, so
 * the move worker and the plain-Node move executor can load it without the
 * rest of the profile seeding.
 * @module @deepseek-ai/dsh-desktop-shell/link-target
 */

import { resolve } from 'node:path'

/**
 * Whether a link Windows or POSIX reported already resolves to `target`.
 *
 * `readlinkSync` does not return the string that created the link. Windows
 * reads a junction back in its extended-length form — `\\?\C:\dir\`, with the
 * prefix and a trailing separator `target` never carries — so a plain string
 * comparison is false for a correct link and the launch deletes and rebuilds it
 * every time. A relative read resolves against the link's own directory, which
 * is what a symbolic link means.
 * @param read - what `readlinkSync` returned for the link.
 * @param target - the directory the link is supposed to resolve to.
 * @param linkDir - the directory holding the link, the base of a relative read.
 * @returns true when the existing link already points at `target`.
 */
export function sameLinkTarget(read: string, target: string, linkDir: string): boolean {
  const canonical = (path: string): string => resolve(linkDir, fromExtendedLengthPath(path))
  return canonical(read) === canonical(target)
}

/**
 * A Windows path in its ordinary form: `\\?\C:\dir` becomes `C:\dir`, and
 * `\\?\UNC\server\share\dir` becomes `\\server\share\dir`. Removing only the
 * four-character prefix from the second would leave `UNC\server\share\dir`,
 * which resolves as a relative path.
 * @param path - a path as `readlinkSync` returned it.
 * @returns the path without its extended-length prefix; any other path unchanged.
 */
export function fromExtendedLengthPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`
  return path.startsWith('\\\\?\\') ? path.slice(4) : path
}
