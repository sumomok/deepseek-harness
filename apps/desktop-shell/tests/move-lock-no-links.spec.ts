/**
 * The move lock on a file system without hard links (exFAT, FAT): every hard
 * link fails with `ENOTSUP`, so creating a lock and putting back a lock that
 * changed during a claim both fall back to an exclusive write read back.
 * @module
 */

import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireMoveLock, claimLock, LOCK_FILENAME, type LockOwner } from '../src/move/lock.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return {
    ...actual,
    linkSync: () => { throw Object.assign(new Error('ENOTSUP: operation not supported on socket, link'), { code: 'ENOTSUP' }) },
  }
})

let dir: string
const NOW = new Date('2026-09-28T12:00:00Z')
const self = { userData: '/u/this', pid: 111, startedAt: 'T' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-move-lock-nolinks-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the move lock without hard links', () => {
  it('is created by an exclusive write, and a second one is refused', async () => {
    expect(() => { fs.linkSync(join(dir, 'a'), join(dir, 'b')) }).toThrow('ENOTSUP')
    expect(await acquireMoveLock(dir, self, { startTimeOf: async () => undefined, now: () => NOW })).toEqual({ kind: 'taken' })
    expect(JSON.parse(fs.readFileSync(join(dir, LOCK_FILENAME), 'utf8'))).toEqual({ ...self, heartbeatAt: NOW.toISOString() })
    expect(fs.readdirSync(dir)).toEqual([LOCK_FILENAME])
  })

  it('puts back a lock that changed during a claim', () => {
    const path = join(dir, LOCK_FILENAME)
    const read: LockOwner = { ...self, pid: 999, heartbeatAt: '2026-01-01T00:00:00.000Z' }
    const fresh = `${JSON.stringify({ ...read, heartbeatAt: NOW.toISOString() })}\n`
    fs.writeFileSync(path, fresh)
    expect(claimLock(path, read)).toBe('changed')
    expect(fs.readFileSync(path, 'utf8')).toBe(fresh)
    expect(fs.readdirSync(dir)).toEqual([LOCK_FILENAME])
  })
})
