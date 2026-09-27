/**
 * Deleting a directory tree without ever following a link.
 *
 * Every entry is examined with `lstat`. A link or Windows junction is removed
 * with `unlink`, which removes the link itself and refuses a real directory,
 * so nothing it points to is touched: the Harness home holds junctions into
 * the installation, and following one while deleting is how a data directory
 * deletion can reach the application (design doc 4). Only real directories are
 * descended into, and each is removed with `rmdir` once empty. Recursive
 * `rm` is never used.
 *
 * Windows keeps a file open by an indexer, a virus scanner, or Explorer's
 * preview from being deleted for a moment; such an entry is retried with a
 * growing delay. What still cannot be removed is reported, not thrown, so the
 * caller can say how much is left and try again later.
 * @module @deepseek-ai/dsh-desktop-shell/move/remove
 */

import { chmod, lstat, readdir, rmdir, unlink } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

/** Attempts per entry before it counts as left over (design doc 3.2 step 6). */
export const REMOVE_ATTEMPTS = 5
/** Delay before the second attempt; each later attempt waits twice as long. */
export const REMOVE_FIRST_DELAY_MS = 100

/** Error codes that a moment later may no longer apply. */
const TRANSIENT = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EMFILE', 'ENFILE'])

/** What removal reads from `lstat`. */
export interface RemoveStats {
  isSymbolicLink: () => boolean
  isDirectory: () => boolean
  size: number
}

/** The file-system calls removal makes; replaced in tests to stand in for Windows. */
export interface RemoveFs {
  lstat: (path: string) => Promise<RemoveStats>
  readdir: (path: string) => Promise<string[]>
  unlink: (path: string) => Promise<void>
  rmdir: (path: string) => Promise<void>
  chmod: (path: string, mode: number) => Promise<void>
}

/** The real file system. */
export const NODE_REMOVE_FS: RemoveFs = { lstat, readdir: path => readdir(path), unlink, rmdir, chmod }

/** One entry that could not be removed. */
export interface Leftover {
  path: string
  code: string
  /** Bytes it holds, for a file; zero otherwise. */
  bytes: number
}

/** What a removal achieved. */
export interface RemoveReport {
  /** Entries removed, links counted as one each. */
  removed: number
  /** Entries still there, innermost first; directories that only hold leftovers are not listed again. */
  leftovers: Leftover[]
  /** Bytes of the files still there. */
  leftoverBytes: number
}

/** Options of {@link removeTree}. */
export interface RemoveOptions {
  platform: NodeJS.Platform
  fs?: RemoveFs
  /** Waits between attempts; `timers/promises` in the app. */
  sleep?: (ms: number) => Promise<void>
}

/**
 * The error code of a thrown value.
 * @param error - what was thrown.
 * @returns its `code`, or `UNKNOWN`.
 */
function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
}

/**
 * Remove `root` and everything below it, never following a link.
 * @param root - the directory, link, or file to remove; an absent path is already removed.
 * @param options - the platform, and replacements for the file system and the wait.
 * @returns how much was removed and what is left.
 */
export async function removeTree(root: string, options: RemoveOptions): Promise<RemoveReport> {
  const fs = options.fs ?? NODE_REMOVE_FS
  const sleep = options.sleep ?? (async (ms: number) => { await delay(ms) })
  const report: RemoveReport = { removed: 0, leftovers: [], leftoverBytes: 0 }
  const api = options.platform === 'win32' ? win32 : posix

  /**
   * Run one removal, retrying transient failures. A permission failure first
   * makes the entry writable (Windows read-only files) or its directory
   * writable (a read-only directory inside the tree on POSIX).
   * @returns the code of the last failure, or `undefined` when it succeeded.
   */
  const attempt = async (path: string, remove: (path: string) => Promise<void>, insideTree: boolean): Promise<string | undefined> => {
    let wait = REMOVE_FIRST_DELAY_MS
    for (let tries = 1; ; tries += 1) {
      let code: string
      try {
        await remove(path)
        return undefined
      } catch (error) {
        code = codeOf(error)
      }
      if (code === 'ENOENT') return undefined
      if (!TRANSIENT.has(code) || tries >= REMOVE_ATTEMPTS) return code
      if (code === 'EPERM' || code === 'EACCES') await makeRemovable(path, insideTree)
      await sleep(wait)
      wait *= 2
    }
  }

  /**
   * Make an entry removable: on Windows clear its read-only attribute; on
   * POSIX give its directory write permission, but only a directory inside
   * the tree being removed.
   */
  const makeRemovable = async (path: string, insideTree: boolean): Promise<void> => {
    const target = options.platform === 'win32' ? path : api.dirname(path)
    if (options.platform !== 'win32' && !insideTree) return
    try {
      await fs.chmod(target, options.platform === 'win32' ? 0o666 : 0o700)
    } catch {
      // EPERM when the entry belongs to someone else: the next attempt fails
      // the same way and the entry is reported as left over.
    }
  }

  const leave = (path: string, code: string, bytes: number): void => {
    report.leftovers.push({ path, code, bytes })
    report.leftoverBytes += bytes
  }

  /**
   * Remove one entry.
   * @param path - the entry.
   * @param insideTree - whether its parent directory is part of the tree.
   * @returns true when it is gone.
   */
  const removeEntry = async (path: string, insideTree: boolean): Promise<boolean> => {
    let stats: RemoveStats
    try {
      stats = await fs.lstat(path)
    } catch (error) {
      const code = codeOf(error)
      if (code === 'ENOENT') return true
      leave(path, code, 0)
      return false
    }
    if (!stats.isSymbolicLink() && stats.isDirectory()) {
      let names: string[]
      try {
        names = await fs.readdir(path)
      } catch (error) {
        leave(path, codeOf(error), 0)
        return false
      }
      let empty = true
      for (const name of names) {
        if (!await removeEntry(api.join(path, name), true)) empty = false
      }
      if (!empty) return false
      const code = await attempt(path, fs.rmdir, insideTree)
      if (code !== undefined) {
        leave(path, code, 0)
        return false
      }
      report.removed += 1
      return true
    }
    // A link (a junction on Windows included) or a file: unlink removes the
    // entry itself and never what a link points to.
    const code = await attempt(path, fs.unlink, insideTree)
    if (code !== undefined) {
      leave(path, code, stats.isSymbolicLink() ? 0 : stats.size)
      return false
    }
    report.removed += 1
    return true
  }

  await removeEntry(root, false)
  return report
}
