/**
 * The move lock: `.dsh-move.lock` in the data directory while a data move
 * runs, created exclusively and naming the app installation (its user-data
 * directory) and the process that holds it. The journal's process id only
 * keeps a second instance of the same installation away; another
 * installation (a development build, a second install) sharing the same
 * `~/.dsh` sees this file instead, and neither starts nor begins a move of
 * its own while a live process holds it.
 *
 * A lock whose process is gone is stale and is taken over. A lock the same
 * installation holds belongs to its unfinished move, which a relaunch resumes.
 * @module @deepseek-ai/dsh-desktop-shell/move/lock
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The lock file's name, in the data directory being moved. */
export const LOCK_FILENAME = '.dsh-move.lock'

/** Who holds a lock. */
export interface LockOwner {
  /** The installation's user-data directory. */
  userData: string
  pid: number
}

/** What is at a data directory's lock. */
export type LockState =
  | { kind: 'none' }
  /** This installation holds it: its own move, possibly from a process that has since exited. */
  | { kind: 'ours'; owner: LockOwner }
  /** Another installation's live process holds it. */
  | { kind: 'held'; owner: LockOwner }
  /** Another installation held it, and its process is gone (or the file cannot be read). */
  | { kind: 'stale'; detail: string }

/**
 * Whether a process is running.
 * @param pid - the process id.
 * @returns false only when the system says there is no such process.
 */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process. EPERM: it exists but belongs to someone else, which still counts as alive.
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/**
 * Parse a lock file's text.
 * @param text - the text.
 * @returns the owner, or `undefined` when it is not a lock.
 */
function parseLock(text: string): LockOwner | undefined {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    // SyntaxError: a lock cut short by a crash reads as no owner.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { userData, pid } = value as Record<string, unknown>
  if (typeof userData !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  return { userData, pid }
}

/**
 * Read a data directory's lock.
 * @param dir - the data directory.
 * @param self - this installation.
 * @param isAlive - whether a process runs ({@link processIsAlive} in the app).
 * @returns what holds it.
 * @throws when the file exists but cannot be read for a reason other than its absence.
 */
export function inspectMoveLock(dir: string, self: LockOwner, isAlive: (pid: number) => boolean): LockState {
  let text: string
  try {
    text = readFileSync(join(dir, LOCK_FILENAME), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' }
    throw error
  }
  const owner = parseLock(text)
  if (owner === undefined) return { kind: 'stale', detail: 'the lock file is not readable' }
  if (owner.userData === self.userData) return { kind: 'ours', owner }
  if (isAlive(owner.pid)) return { kind: 'held', owner }
  return { kind: 'stale', detail: `process ${String(owner.pid)} of ${owner.userData} is gone` }
}

/**
 * Take a data directory's lock: create it exclusively, or take over this
 * installation's own lock or a stale one.
 * @param dir - the data directory.
 * @param self - this installation and process.
 * @param isAlive - whether a process runs.
 * @returns `taken`, or the live owner that holds it.
 * @throws when the lock cannot be written, or other processes keep taking it.
 */
export function acquireMoveLock(
  dir: string, self: LockOwner, isAlive: (pid: number) => boolean,
): { kind: 'taken' } | { kind: 'held'; owner: LockOwner } {
  const path = join(dir, LOCK_FILENAME)
  const text = `${JSON.stringify(self)}\n`
  // One takeover at most: a second EEXIST means another process took it in between.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
      return { kind: 'taken' }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const state = inspectMoveLock(dir, self, isAlive)
    if (state.kind === 'held') return state
    if (state.kind === 'ours' && state.owner.pid === self.pid) return { kind: 'taken' }
    unlinkIfPresent(path)
  }
  const state = inspectMoveLock(dir, self, isAlive)
  if (state.kind === 'held') return state
  throw new Error(`the move lock in ${dir} was taken and released while this process tried to take it`)
}

/**
 * Remove this installation's lock from each directory that has it. A lock
 * another installation holds is left alone.
 * @param dirs - where the data may be now (the source, the target, the hidden original).
 * @param self - this installation.
 * @throws when a lock of ours cannot be removed.
 */
export function releaseMoveLock(dirs: readonly string[], self: LockOwner): void {
  for (const dir of dirs) {
    let state: LockState
    try {
      state = inspectMoveLock(dir, self, () => true)
    } catch {
      // The directory cannot be read (its drive is away): there is no lock of ours to remove there now.
      continue
    }
    if (state.kind === 'ours') unlinkIfPresent(join(dir, LOCK_FILENAME))
  }
}

/**
 * Delete a file that may already be gone.
 * @param path - the file.
 * @throws when it exists and cannot be deleted.
 */
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
