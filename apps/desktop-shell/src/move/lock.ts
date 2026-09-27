/**
 * The move lock: `.dsh-move.lock` in the data directory while a data move
 * runs, naming the app installation (its user-data directory), the process
 * that holds it with that process's start time, and a heartbeat the holder
 * refreshes. The journal lives in the installation's own user data, so
 * another installation (a development build, a second install) sharing the
 * same `~/.dsh` cannot see it; it sees this file instead.
 *
 * Only the installation that wrote a lock may take it over: its journal
 * decides what happens next. Another installation's lock stands for a move
 * that installation has not finished, whether its process still runs
 * (`held`) or not (`unfinished`), and that data is not used until the other
 * installation has finished the move. A process is taken for the holder only
 * when its id and start time both match, so a later process that reused the
 * id is not; when the system cannot be asked, a heartbeat younger than
 * {@link HEARTBEAT_STALE_MS} counts as alive.
 *
 * A lock is written complete before it appears: created through a hard link
 * to a finished temporary file (or, on a file system without hard links,
 * written exclusively and read back), taken over by renaming it away first so
 * only one process can claim it, and refreshed by an atomic rename.
 * @module @deepseek-ai/dsh-desktop-shell/move/lock
 */

import { randomBytes } from 'node:crypto'
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The lock file's name, in the data directory being moved. */
export const LOCK_FILENAME = '.dsh-move.lock'

/** How often the holder refreshes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 30_000

/** A heartbeat older than this does not by itself keep a holder alive. */
export const HEARTBEAT_STALE_MS = 120_000

/** This installation and process, as a lock records them. */
export interface LockSelf {
  /** The installation's user-data directory. */
  userData: string
  pid: number
  /** The process's start time as {@link LockProbes.startTimeOf} reports it; empty when the system could not be asked. */
  startedAt: string
}

/** Who holds a lock. */
export interface LockOwner extends LockSelf {
  /** When the holder last refreshed the lock, ISO 8601. */
  heartbeatAt: string
}

/** What is at a data directory's lock. */
export type LockState =
  | { kind: 'none' }
  /** This installation wrote it: its own move, possibly from a process that has since exited. */
  | { kind: 'ours'; owner: LockOwner }
  /** Another installation's process that is still running holds it. */
  | { kind: 'held'; owner: LockOwner }
  /** Another installation holds it and its process is gone: that installation has a move it has not finished. */
  | { kind: 'unfinished'; owner: LockOwner; path: string }
  /** The file cannot be read as a lock; nothing tells whose it is. */
  | { kind: 'unreadable'; path: string; detail: string }

/** What deciding whether a holder lives needs from the system; replaced in tests. */
export interface LockProbes {
  /** A process's start time; `undefined` when no such process runs, `unknown` when the system cannot be asked. */
  startTimeOf: (pid: number) => Promise<string | undefined>
  now: () => Date
}

/** What {@link LockProbes.startTimeOf} returns when the system cannot be asked. */
export const START_TIME_UNKNOWN = 'unknown'

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
    // SyntaxError: text that is not JSON is not a lock.
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { userData, pid, startedAt, heartbeatAt } = value as Record<string, unknown>
  if (typeof userData !== 'string' || typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return undefined
  if (typeof startedAt !== 'string' || typeof heartbeatAt !== 'string') return undefined
  return { userData, pid, startedAt, heartbeatAt }
}

/**
 * The lock's text for an owner.
 * @param owner - the owner.
 * @returns the text.
 */
function lockText(owner: LockOwner): string {
  return `${JSON.stringify(owner)}\n`
}

/** A lock as read, before anything is decided about it. */
type LockRead = { kind: 'lock'; owner: LockOwner } | { kind: 'none' } | { kind: 'unreadable'; path: string; detail: string }

/**
 * Read a lock without deciding anything.
 * @param dir - the data directory.
 * @returns the owner, `none`, or why it cannot be read.
 * @throws when the file exists but cannot be read for a reason other than its absence.
 */
function readLock(dir: string): LockRead {
  const path = join(dir, LOCK_FILENAME)
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'none' }
    throw error
  }
  const owner = parseLock(text)
  return owner === undefined ? { kind: 'unreadable', path, detail: 'the file is not a move lock' } : { kind: 'lock', owner }
}

/**
 * Whether the process a lock names still runs. A running process with that
 * id but another start time is a later process that reused the id, so the
 * holder is gone at once. When no process on this machine has that id (the
 * holder may run on another machine sharing the drive), or the system cannot
 * be asked, only the heartbeat tells: the holder counts as gone once its
 * heartbeat is {@link HEARTBEAT_STALE_MS} old, so a holder on this machine
 * that stopped is seen as gone up to two minutes after its last heartbeat.
 * @param owner - the lock's owner.
 * @param probes - the process start times and the clock.
 * @returns true when its id and start time match a running process, or its heartbeat is recent.
 */
export async function holderIsAlive(owner: LockOwner, probes: LockProbes): Promise<boolean> {
  const started = await probes.startTimeOf(owner.pid)
  if (started !== undefined && started !== START_TIME_UNKNOWN && owner.startedAt !== '') return started === owner.startedAt
  const beat = Date.parse(owner.heartbeatAt)
  return Number.isFinite(beat) && probes.now().getTime() - beat < HEARTBEAT_STALE_MS
}

/**
 * Read a data directory's lock and decide what it stands for.
 * @param dir - the data directory.
 * @param self - this installation.
 * @param probes - the process start times and the clock.
 * @returns what holds it.
 * @throws when the file exists but cannot be read for a reason other than its absence.
 */
export async function inspectMoveLock(dir: string, self: Pick<LockSelf, 'userData'>, probes: LockProbes): Promise<LockState> {
  const lock = readLock(dir)
  if (lock.kind !== 'lock') return lock
  if (lock.owner.userData === self.userData) return { kind: 'ours', owner: lock.owner }
  if (await holderIsAlive(lock.owner, probes)) return { kind: 'held', owner: lock.owner }
  return { kind: 'unfinished', owner: lock.owner, path: join(dir, LOCK_FILENAME) }
}

/**
 * Create the lock file only if none exists, complete from its first byte.
 * @param path - the lock file.
 * @param text - its content.
 * @returns whether this call created it.
 * @throws when it cannot be written.
 */
function createExclusively(path: string, text: string): boolean {
  const temporary = `${path}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, text, { mode: 0o600 })
  try {
    return linkIntoPlace(temporary, path, text)
  } finally {
    unlinkIfPresent(temporary)
  }
}

/**
 * Put a file holding `text` at `path` unless something is there: a hard link
 * from `from`, or, on a file system without hard links (exFAT, FAT), an
 * exclusive write read back ({@link createByExclusiveWrite}).
 * @param from - a file holding `text`.
 * @param path - where it goes.
 * @param text - its content.
 * @returns whether this call put it there.
 * @throws when neither can be done for a reason other than a file already there.
 */
function linkIntoPlace(from: string, path: string, text: string): boolean {
  try {
    linkSync(from, path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP' && code !== 'ENOSYS') throw error
    return createByExclusiveWrite(path, text)
  }
}

/**
 * Create the lock file by an exclusive write and read it back.
 * @param path - the lock file.
 * @param text - its content.
 * @returns whether this call created it and it reads back as written.
 * @throws when it cannot be written.
 */
export function createByExclusiveWrite(path: string, text: string): boolean {
  try {
    writeFileSync(path, text, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
    throw error
  }
  return readFileSync(path, 'utf8') === text
}

/**
 * Remove a lock only if it is still the lock that was read: this
 * installation's old lock before a new one is created, or another
 * installation's unfinished move's lock the person chose to discard. It is
 * renamed to a name no other process uses, and a lock that changed in
 * between (another process took it over or refreshed it first) is linked
 * back into place and kept.
 * @param path - the lock file.
 * @param expected - the lock that was read.
 * @returns `claimed` when the old lock was removed, `changed` when another lock was put back, `gone` when there was none.
 * @throws when the lock cannot be renamed or read.
 */
export function claimLock(path: string, expected: LockOwner): 'claimed' | 'changed' | 'gone' {
  const claim = `${path}.claim-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  try {
    renameSync(path, claim)
  } catch (error) {
    // ENOENT: another process renamed it first.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
    throw error
  }
  try {
    const text = readFileSync(claim, 'utf8')
    const found = parseLock(text)
    if (found !== undefined && lockText(found) === lockText(expected)) return 'claimed'
    // False when yet another lock appeared meanwhile; it stays, and the caller looks again.
    linkIntoPlace(claim, path, text)
    return 'changed'
  } finally {
    unlinkIfPresent(claim)
  }
}

/**
 * Take a data directory's lock: create it, or take over this installation's
 * own lock by renaming it away first, so two processes never both claim it.
 * Another installation's lock, or one that cannot be read, is never taken.
 * @param dir - the data directory.
 * @param self - this installation and process.
 * @param probes - the process start times and the clock.
 * @returns `taken`, or what holds it.
 * @throws when the lock cannot be written, or other processes keep changing it.
 */
export async function acquireMoveLock(
  dir: string, self: LockSelf, probes: LockProbes,
): Promise<{ kind: 'taken' } | Exclude<LockState, { kind: 'none' } | { kind: 'ours' }>> {
  const path = join(dir, LOCK_FILENAME)
  const text = lockText({ ...self, heartbeatAt: probes.now().toISOString() })
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (createExclusively(path, text)) return { kind: 'taken' }
    const state = await inspectMoveLock(dir, self, probes)
    if (state.kind === 'none') continue
    if (state.kind !== 'ours') return state
    claimLock(path, state.owner)
  }
  throw new Error(`the move lock in ${dir} kept changing while this process tried to take it`)
}

/** Whether this move still holds its lock where the data is. */
export type LockCheck = { kind: 'ours' } | { kind: 'lost'; detail: string }

/**
 * Thrown when a move no longer holds its lock where the data is: another
 * installation discarded it or took the data over, so the move stops.
 */
export class MoveLockLostError extends Error {
  /** @param detail - which place lost the lock, and how. */
  constructor(detail: string) {
    super(`data move: the move lock is no longer this move's: ${detail}`)
    this.name = 'MoveLockLostError'
  }
}

/**
 * Check that each place where the data is holds this move's lock: this
 * installation's, written by this process (the same id and start time) or by
 * the process the journal records.
 * @param dirs - where the lock must be (see `lockExpectedAt`).
 * @param self - this installation and process.
 * @param recordedPid - the process the journal records.
 * @returns `ours`, or `lost` naming the first place that does not hold it.
 */
export function checkOwnLock(dirs: readonly string[], self: LockSelf, recordedPid: number): LockCheck {
  for (const dir of dirs) {
    let lock: LockRead
    try {
      lock = readLock(dir)
    } catch (error) {
      return { kind: 'lost', detail: `${dir}: the lock cannot be read: ${String(error)}` }
    }
    if (lock.kind === 'none') return { kind: 'lost', detail: `${dir}: no lock` }
    if (lock.kind === 'unreadable') return { kind: 'lost', detail: `${dir}: ${lock.detail}` }
    const owner = lock.owner
    if (owner.userData !== self.userData) return { kind: 'lost', detail: `${dir}: held by ${owner.userData}` }
    const thisProcess = owner.pid === self.pid && owner.startedAt === self.startedAt
    if (!thisProcess && owner.pid !== recordedPid) return { kind: 'lost', detail: `${dir}: held by process ${String(owner.pid)}` }
  }
  return { kind: 'ours' }
}

/**
 * Refresh the heartbeat of this move's lock in each place where the data is,
 * recording this process as its holder (a move resumed after a relaunch takes
 * its lock over this way). A place that does not hold this move's lock
 * ({@link checkOwnLock}) stops the refresh before anything is written: the
 * lock was discarded or taken, and the move must stop.
 * @param dirs - where the lock must be.
 * @param self - this installation and process.
 * @param now - the time to record.
 * @param recordedPid - the process the journal records.
 * @returns `ours` once every place was refreshed, or `lost`.
 * @throws when a lock cannot be written.
 */
export function refreshMoveLock(dirs: readonly string[], self: LockSelf, now: Date, recordedPid: number): LockCheck {
  const check = checkOwnLock(dirs, self, recordedPid)
  if (check.kind === 'lost') return check
  for (const dir of dirs) {
    const path = join(dir, LOCK_FILENAME)
    const temporary = `${path}.${String(process.pid)}.tmp`
    writeFileSync(temporary, lockText({ ...self, heartbeatAt: now.toISOString() }), { mode: 0o600 })
    renameSync(temporary, path)
  }
  return check
}

/**
 * Remove this installation's lock from each directory that has it. A lock
 * another installation holds, or one that cannot be read, is left alone.
 * @param dirs - where the data may be now (the source, the target, the hidden original).
 * @param self - this installation.
 * @throws when a lock of ours cannot be removed.
 */
export function releaseMoveLock(dirs: readonly string[], self: Pick<LockSelf, 'userData'>): void {
  for (const dir of dirs) {
    let lock: LockRead
    try {
      lock = readLock(dir)
    } catch {
      // The directory cannot be read (its drive is away): there is no lock of ours to remove there now.
      continue
    }
    if (lock.kind === 'lock' && lock.owner.userData === self.userData) unlinkIfPresent(join(dir, LOCK_FILENAME))
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
