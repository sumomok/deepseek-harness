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
 * An entry that changes between its `lstat` and the `readdir` of it (a
 * directory replaced by a link, say) is read as whatever `readdir` then
 * finds; the copier and the check read every entry again, so the change is
 * caught there rather than here.
 *
 * Relative paths use `/` on every platform, so a journal written on Windows
 * reads the same as one written on macOS; {@link nativePath} turns one back
 * into a path under a root.
 * @module @deepseek-ai/dsh-desktop-shell/move/tree
 */

import { createHash } from 'node:crypto'
import { lstatSync, readdirSync } from 'node:fs'
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

/** Allocation unit assumed for the target volume (APFS and NTFS both default to 4 KiB). */
export const ESTIMATED_BLOCK_BYTES = 4096

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
  /**
   * Space the files and directories take on a volume with
   * {@link ESTIMATED_BLOCK_BYTES} blocks: every file rounded up to whole blocks,
   * one block per directory and link.
   */
  allocatedBytes: number
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
  signal?: AbortSignal | undefined
  /** Called after each entry is read, so a watcher can tell a slow walk from a hung one. */
  onActivity?: (() => void) | undefined
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
 * resolving both. On macOS and Windows the comparison ignores letter case
 * (and, on macOS, Unicode normalization), as their default file systems do,
 * so `/Users/p/DATA` counts as inside `/Users/p/Data`. On a case-sensitive
 * volume there this errs toward "inside", which only ever refuses more.
 * @param path - an absolute path.
 * @param root - an absolute directory.
 * @param platform - whose path rules apply.
 * @returns true when `path` is inside `root` or equal to it.
 */
export function isInsidePath(path: string, root: string, platform: NodeJS.Platform): boolean {
  const api = platform === 'win32' ? win32 : posix
  const fold = (value: string): string => {
    if (platform === 'win32') return value.toLowerCase()
    return platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value
  }
  const rel = api.relative(fold(api.resolve(root)), fold(api.resolve(path)))
  if (rel === '') return true
  if (api.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${api.sep}`)
}

/**
 * Names the operating system's file browser drops into any folder it shows
 * (Finder's `.DS_Store` and `.localized`, Explorer's `desktop.ini` and
 * `Thumbs.db`). A folder holding only these counts as empty, and they are
 * deleted with it.
 */
export const IGNORABLE_NAMES: readonly string[] = ['.DS_Store', '.localized', 'desktop.ini', 'Thumbs.db']

/**
 * Whether a name is one of {@link IGNORABLE_NAMES}. macOS and Windows file
 * systems ignore letter case, so there `THUMBS.DB` is `Thumbs.db`.
 * @param name - a directory entry's name.
 * @param platform - whose name rules apply.
 * @returns true for a file browser's own file.
 */
export function isIgnorableName(name: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform !== 'darwin' && platform !== 'win32') return IGNORABLE_NAMES.includes(name)
  const folded = name.toLowerCase()
  return IGNORABLE_NAMES.some(ignorable => ignorable.toLowerCase() === folded)
}

/**
 * The names of a directory listing that are not {@link IGNORABLE_NAMES}.
 * @param names - the listing.
 * @param platform - whose name rules apply.
 * @returns the names that make the folder non-empty.
 */
export function meaningfulNames(names: readonly string[], platform: NodeJS.Platform = process.platform): string[] {
  return names.filter(name => !isIgnorableName(name, platform))
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
    root, entries: [], files: 0, dirs: 0, links: 0, others: 0, bytes: 0, allocatedBytes: 0, excluded: [],
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
      options.onActivity?.()
      scan.allocatedBytes += stats.isFile() ? Math.ceil(stats.size / ESTIMATED_BLOCK_BYTES) * ESTIMATED_BLOCK_BYTES : ESTIMATED_BLOCK_BYTES
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

/** What a print records of one entry. */
export interface PrintEntry {
  /** `/`-separated, relative to the root. */
  rel: string
  size: bigint
  mtimeNs: bigint
  ctimeNs: bigint
  ino: bigint
}

/**
 * A hash over entries: each entry's relative path, size, modification and
 * status-change times in nanoseconds, and inode number, in path order. Any
 * difference in any of them gives a different hash.
 * @param entries - the entries, in any order.
 * @returns the hash, hex.
 */
export function printOf(entries: readonly PrintEntry[]): string {
  const hash = createHash('sha256')
  const sorted = [...entries].sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0)
  for (const entry of sorted) {
    hash.update(`${entry.rel}\0${String(entry.size)}\0${String(entry.mtimeNs)}\0${String(entry.ctimeNs)}\0${String(entry.ino)}\n`)
  }
  return hash.digest('hex')
}

/**
 * Print a tree, synchronously and without following links: every entry below
 * the root except the excluded relative paths (with everything under them)
 * and {@link IGNORABLE_NAMES}. A directory is recorded by its path only; a
 * file or a link by every field of {@link PrintEntry}. The root's own entry
 * is left out, since the move writes and removes its markers there.
 * @param root - the directory.
 * @param exclude - relative paths (`/`-separated) to leave out.
 * @param platform - whose name rules apply to the ignorable names.
 * @returns the hash ({@link printOf}).
 * @throws when an entry cannot be read, or the root is not there.
 */
export function fingerprintTree(root: string, exclude: readonly string[], platform: NodeJS.Platform = process.platform): string {
  const excluded = new Set(exclude)
  const entries: PrintEntry[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(nativePath(root, rel))) {
      const child = rel === '' ? name : `${rel}/${name}`
      if (excluded.has(child) || isIgnorableName(name, platform)) continue
      let stats
      try {
        stats = lstatSync(nativePath(root, child), { bigint: true })
      } catch (error) {
        // Removed between the listing and the stat: it is not part of the tree any more.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (stats.isDirectory()) {
        // A directory's own times and size change with what is in it, which is printed entry by entry already;
        // recording them would also count a file browser's files in it as a change.
        entries.push({ rel: child, size: 0n, mtimeNs: 0n, ctimeNs: 0n, ino: 0n })
        walk(child)
      } else {
        entries.push({ rel: child, size: stats.size, mtimeNs: stats.mtimeNs, ctimeNs: stats.ctimeNs, ino: stats.ino })
      }
    }
  }
  walk('')
  return printOf(entries)
}
