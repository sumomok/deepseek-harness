/**
 * The move lock: created complete, another installation's lock refused
 * whether its process runs or not, a holder told from a later process that
 * reused its id, this installation's own lock taken over atomically, the
 * heartbeat refreshed only where the lock is, and release touching only our
 * own. Every directory is under a temporary root; process start times are
 * stand-ins.
 * @module
 */

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireMoveLock, checkOwnLock, claimLock, createByExclusiveWrite, HEARTBEAT_STALE_MS, holderIsAlive, inspectMoveLock, LOCK_FILENAME,
  refreshMoveLock,
  releaseMoveLock, START_TIME_UNKNOWN, type LockOwner, type LockProbes,
} from '../src/move/lock.ts'
import { MOVE_MARKERS } from '../src/move/run.ts'
import { startTimeOf } from '../src/process-tree.ts'

let dir: string
const NOW = new Date('2026-09-28T12:00:00Z')
const self = { userData: '/u/this', pid: 111, startedAt: 'Mon Sep 28 09:00:00 2026' }
const other: LockOwner = { userData: '/u/other', pid: 222, startedAt: 'Mon Sep 28 08:00:00 2026', heartbeatAt: NOW.toISOString() }

/** Probes answering start times from a table. */
function probes(times: Record<number, string | undefined>, now = NOW): LockProbes {
  return { startTimeOf: async pid => times[pid], now: () => now }
}

/** Read the lock file. */
function lockFile(): unknown {
  return JSON.parse(readFileSync(join(dir, LOCK_FILENAME), 'utf8'))
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-move-lock-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the move lock', () => {
  it('is created complete, with the holder\'s start time and heartbeat, and is never copied with the data', async () => {
    expect(await inspectMoveLock(dir, self, probes({}))).toEqual({ kind: 'none' })
    expect(await acquireMoveLock(dir, self, probes({}))).toEqual({ kind: 'taken' })
    expect(lockFile()).toEqual({ ...self, heartbeatAt: NOW.toISOString() })
    expect(readdirSync(dir)).toEqual([LOCK_FILENAME])
    expect(await inspectMoveLock(dir, self, probes({}))).toMatchObject({ kind: 'ours' })
    expect(MOVE_MARKERS).toContain(LOCK_FILENAME)
  })

  it('refuses another installation\'s lock whether its process runs or not, and never takes it', async () => {
    writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify(other))
    expect(await acquireMoveLock(dir, self, probes({ 222: other.startedAt }))).toEqual({ kind: 'held', owner: other })
    // No process has that id here and the heartbeat is fresh: it may run on another machine sharing the drive.
    expect(await acquireMoveLock(dir, self, probes({}))).toEqual({ kind: 'held', owner: other })
    const stale = new Date(NOW.getTime() + HEARTBEAT_STALE_MS + 1)
    expect(await acquireMoveLock(dir, self, probes({}, stale))).toEqual({ kind: 'unfinished', owner: other, path: join(dir, LOCK_FILENAME) })
    releaseMoveLock([dir], self)
    expect(lockFile()).toEqual(other)
  })

  it('tells the holder from a later process that reused its id, and trusts a recent heartbeat when the system cannot be asked', async () => {
    expect(await holderIsAlive(other, probes({ 222: other.startedAt }))).toBe(true)
    expect(await holderIsAlive(other, probes({ 222: 'Mon Sep 28 11:59:00 2026' }))).toBe(false)
    expect(await holderIsAlive(other, probes({}))).toBe(true)
    expect(await holderIsAlive(other, probes({}, new Date(NOW.getTime() + HEARTBEAT_STALE_MS + 1)))).toBe(false)
    expect(await holderIsAlive(other, probes({ 222: START_TIME_UNKNOWN }))).toBe(true)
    const later = new Date(NOW.getTime() + HEARTBEAT_STALE_MS + 1)
    expect(await holderIsAlive(other, probes({ 222: START_TIME_UNKNOWN }, later))).toBe(false)
    expect(await holderIsAlive({ ...other, startedAt: '' }, probes({ 222: 'anything' }))).toBe(true)
    expect(await holderIsAlive({ ...other, startedAt: '' }, probes({ 222: 'anything' }, later))).toBe(false)
  })

  it('never takes a lock it cannot read', async () => {
    writeFileSync(join(dir, LOCK_FILENAME), '{"userData":')
    expect(await acquireMoveLock(dir, self, probes({}))).toMatchObject({ kind: 'unreadable', path: join(dir, LOCK_FILENAME) })
    expect(readFileSync(join(dir, LOCK_FILENAME), 'utf8')).toBe('{"userData":')
  })

  it('takes over this installation\'s own lock from an earlier process by renaming it away first', async () => {
    writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify({ ...self, pid: 999, heartbeatAt: '2026-01-01T00:00:00Z' }))
    expect(await acquireMoveLock(dir, self, probes({}))).toEqual({ kind: 'taken' })
    expect(lockFile()).toEqual({ ...self, heartbeatAt: NOW.toISOString() })
    expect(readdirSync(dir)).toEqual([LOCK_FILENAME])
  })

  it('claims an old lock only while it is still the one that was read, and puts back one that changed', () => {
    const path = join(dir, LOCK_FILENAME)
    const old: LockOwner = { ...self, pid: 999, heartbeatAt: '2026-01-01T00:00:00Z' }
    const fresh = JSON.stringify({ ...self, pid: 555, heartbeatAt: NOW.toISOString() })
    writeFileSync(path, fresh)
    expect(claimLock(path, old)).toBe('changed')
    expect(readFileSync(path, 'utf8')).toBe(fresh)
    expect(readdirSync(dir)).toEqual([LOCK_FILENAME])
    writeFileSync(path, JSON.stringify(old))
    expect(claimLock(path, old)).toBe('claimed')
    expect(readdirSync(dir)).toEqual([])
    expect(claimLock(path, old)).toBe('gone')
  })

  it('writes exclusively and reads back where hard links are not available', () => {
    const path = join(dir, LOCK_FILENAME)
    expect(createByExclusiveWrite(path, 'a\n')).toBe(true)
    expect(createByExclusiveWrite(path, 'b\n')).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe('a\n')
  })

  it('refreshes the heartbeat where the lock must be, taking over any earlier run\'s, and stops where it is not this move\'s', async () => {
    const path = join(dir, LOCK_FILENAME)
    const none = { startTimeOf: async () => undefined }
    writeFileSync(path, JSON.stringify({ ...self, pid: 999, startedAt: 'earlier', heartbeatAt: '2026-01-01T00:00:00Z' }))
    expect(await refreshMoveLock([dir], self, NOW, none)).toEqual({ kind: 'ours' })
    expect(lockFile()).toEqual({ ...self, heartbeatAt: NOW.toISOString() })
    // Discarded by another installation: the refresh never recreates it.
    rmSync(path)
    expect(await refreshMoveLock([dir], self, NOW, none)).toMatchObject({ kind: 'lost' })
    expect(existsSync(path)).toBe(false)
    writeFileSync(path, JSON.stringify(other))
    expect(await refreshMoveLock([dir], self, NOW, none)).toMatchObject({ kind: 'lost' })
    expect(lockFile()).toEqual(other)
    // A relaunch of this installation that was itself cut short wrote it: ours, whatever the journal records.
    const cutShort = { ...self, pid: 555, startedAt: 'P2', heartbeatAt: NOW.toISOString() }
    writeFileSync(path, JSON.stringify(cutShort))
    expect(await checkOwnLock([dir], self, none)).toEqual({ kind: 'ours' })
    expect(await checkOwnLock([dir], self, { startTimeOf: async () => 'a later process' })).toEqual({ kind: 'ours' })
    // The same process id in an earlier boot: ours.
    writeFileSync(path, JSON.stringify({ ...self, startedAt: 'another boot', heartbeatAt: NOW.toISOString() }))
    expect(await checkOwnLock([dir], self, none)).toEqual({ kind: 'ours' })
    // Another process of this installation that still runs holds it.
    writeFileSync(path, JSON.stringify(cutShort))
    expect(await checkOwnLock([dir], self, { startTimeOf: async () => 'P2' })).toMatchObject({ kind: 'lost' })
    writeFileSync(path, '{')
    expect(await checkOwnLock([dir], self, none)).toMatchObject({ kind: 'lost' })
    // Another installation's, even one naming this process id and start time.
    writeFileSync(path, JSON.stringify({ ...self, userData: '/u/other', heartbeatAt: NOW.toISOString() }))
    expect(await checkOwnLock([dir], self, none)).toMatchObject({ kind: 'lost', detail: `${dir}: held by /u/other` })
    expect(await checkOwnLock([], self, none)).toEqual({ kind: 'ours' })
  })

  it('releases only its own lock, in every place the data may be', async () => {
    await acquireMoveLock(dir, self, probes({}))
    releaseMoveLock([dir, join(dir, 'gone')], self)
    expect(await inspectMoveLock(dir, self, probes({}))).toEqual({ kind: 'none' })
  })

  it('looks a start time up in the process list', async () => {
    const entry = { pid: 5, ppid: 1, startedAt: 'T', command: 'x' }
    expect(await startTimeOf(5, { list: async () => [entry] })).toBe('T')
    expect(await startTimeOf(6, { list: async () => [entry] })).toBeUndefined()
    expect(await startTimeOf(5, { list: async () => [] })).toBe(START_TIME_UNKNOWN)
  })
})
