/**
 * One walk over a directory tree before it is moved: every entry with the
 * facts the copier, the checker, and the space estimate need, and the name
 * clashes a different file system would turn into overwrites.
 *
 * The walk never follows a link: a link is an entry of its own, recorded with
 * the target text `readlink` returns. Sizes are added up per path, not per
 * inode, because a copy to another volume writes every hard-linked path as a
 * file of its own (pnpm links package files into the profiles that way).
 *
 * Relative paths use `/` on every platform, so a journal written on Windows
 * reads the same as one written on macOS; {@link nativePath} turns one back
 * into a path under a root.
 * @module @deepseek-ai/dsh-desktop-shell/move/tree
 */

import { lstat, readdir, readlink } from 'node:fs/promises'
import { join, posix, win32 } from 'node:path'

/**
 * Entries under the Harness home that the server rebuilds by itself, so a move
 * leaves them behind (design doc 1.2): the attachment request cache, the
 * session search index, and the session projection cache.
 */
export const REBUILDABLE_ENTRIES: readonly string[] = [
  'cache',
  'session-search',
  'storages/session_projcache',
  'storages/session_projcache.json',
]

/**
 * File that marks a directory as a move in progress (a partial copy, a hidden
 * source, or a target that has no identity yet). Its content is the move id.
 */
export const MOVE_STATE_FILENAME = '.dsh-move-state'

/** One entry of a scanned tree. `rel` is relative to the root, `/`-separated. */
export type TreeEntry =
  | { kind: 'dir'; rel: string; mode: number }
  | { kind: 'file'; rel: string; size: number; mtimeMs: number; ino: number; mode: number }
  | { kind: 'link'; rel: string; target: string }
  | { kind: 'other'; rel: string }

/** What one walk found. */
export interface TreeScan {
  /** The directory walked. */
  root: string
  /** Every entry below the root, each directory before what it holds, names in code-unit order. */
  entries: TreeEntry[]
  files: number
  dirs: number
  links: number
  /** Sockets, pipes, and devices: nothing a copy can recreate, so none is copied. */
  others: number
  /** Sum of the sizes of every file path. */
  bytes: number
  /** Excluded relative paths that exist. */
  excluded: string[]
  /** Groups of paths in one directory whose names differ only in letter case. */
  caseCollisions: string[][]
  /** Groups of paths in one directory whose names differ only in Unicode normalization. */
  normalizationCollisions: string[][]
  /** Length in characters of the longest relative path. */
  longestRelative: number
}

/** Options of {@link scanTree}. */
export interface ScanOptions {
  /** Relative paths (`/`-separated) left out together with everything below them. */
  exclude: readonly string[]
  /** Stops the walk between entries. */
  signal?: AbortSignal
}

/**
 * The path of `rel` under `root`.
 * @param root - an absolute directory.
 * @param rel - a `/`-separated path relative to it; empty for the root itself.
 * @returns the native path.
 */
export function nativePath(root: string, rel: string): string {
  return rel === '' ? root : join(root, ...rel.split('/'))
}

/**
 * Whether `path` is `root` or lies below it, compared by path text after
 * resolving both. Windows compares without regard to letter case, as its file
 * systems do.
 * @param path - an absolute path.
 * @param root - an absolute directory.
 * @param platform - whose path rules apply.
 * @returns true when `path` is inside `root` or equal to it.
 */
export function isInsidePath(path: string, root: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? win32 : posix
  const rel = api.relative(api.resolve(root), api.resolve(path))
  if (rel === '') return true
  if (api.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${api.sep}`)
}

/**
 * Groups of names that collapse to the same key.
 * @param names - the names in one directory.
 * @param key - the folding that a file system might apply.
 * @returns every group with more than one name.
 */
function clashes(names: readonly string[], key: (name: string) => string): string[][] {
  const groups = new Map<string, string[]>()
  for (const name of names) {
    const folded = key(name)
    const group = groups.get(folded)
    if (group === undefined) groups.set(folded, [name])
    else group.push(name)
  }
  return [...groups.values()].filter(group => group.length > 1)
}

/**
 * Walk `root` without following links.
 * @param root - an existing real directory; a link here is refused, so the caller passes its `realpath`.
 * @param options - what to leave out, and the abort signal.
 * @returns every entry and the totals.
 * @throws when the root is not a real directory, the walk is aborted, or an entry cannot be read.
 */
export async function scanTree(root: string, options: ScanOptions): Promise<TreeScan> {
  const rootStats = await lstat(root)
  if (!rootStats.isDirectory()) throw new Error(`${root} is not a directory (a link is refused: pass its real path)`)
  const exclude = new Set(options.exclude)
  const scan: TreeScan = {
    root, entries: [], files: 0, dirs: 0, links: 0, others: 0, bytes: 0, excluded: [],
    caseCollisions: [], normalizationCollisions: [], longestRelative: 0,
  }
  const walk = async (rel: string): Promise<void> => {
    const names = (await readdir(nativePath(root, rel))).sort()
    const within = (name: string): string => rel === '' ? name : `${rel}/${name}`
    for (const group of clashes(names, name => name.normalize('NFC').toLowerCase())) {
      if (new Set(group.map(name => name.normalize('NFC'))).size > 1) scan.caseCollisions.push(group.map(within))
    }
    for (const group of clashes(names, name => name.normalize('NFC'))) scan.normalizationCollisions.push(group.map(within))
    for (const name of names) {
      options.signal?.throwIfAborted()
      const child = within(name)
      if (exclude.has(child)) {
        scan.excluded.push(child)
        continue
      }
      scan.longestRelative = Math.max(scan.longestRelative, child.length)
      const path = nativePath(root, child)
      const stats = await lstat(path)
      if (stats.isSymbolicLink()) {
        scan.entries.push({ kind: 'link', rel: child, target: await readlink(path) })
        scan.links += 1
      } else if (stats.isDirectory()) {
        scan.entries.push({ kind: 'dir', rel: child, mode: stats.mode & 0o7777 })
        scan.dirs += 1
        await walk(child)
      } else if (stats.isFile()) {
        scan.entries.push({
          kind: 'file', rel: child, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, mode: stats.mode & 0o7777,
        })
        scan.files += 1
        scan.bytes += stats.size
      } else {
        scan.entries.push({ kind: 'other', rel: child })
        scan.others += 1
      }
    }
  }
  await walk('')
  return scan
}
