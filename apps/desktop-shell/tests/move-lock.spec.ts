/**
 * The move lock: exclusive creation, another installation's live lock
 * refused, a stale or own lock taken over, and release touching only our own.
 * Every directory is under a temporary root.
 * @module
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { acquireMoveLock, inspectMoveLock, LOCK_FILENAME, processIsAlive, releaseMoveLock } from '../src/move/lock.ts'
import { MOVE_MARKERS } from '../src/move/run.ts'

let dir: string
const self = { userData: '/u/this', pid: 111 }
const other = { userData: '/u/other', pid: 222 }
const alive = (): boolean => true
const dead = (): boolean => false

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-move-lock-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('the move lock', () => {
  it('is created with its owner and is never copied with the data', () => {
    expect(inspectMoveLock(dir, self, alive)).toEqual({ kind: 'none' })
    expect(acquireMoveLock(dir, self, alive)).toEqual({ kind: 'taken' })
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILENAME), 'utf8'))).toEqual(self)
    expect(inspectMoveLock(dir, self, alive)).toEqual({ kind: 'ours', owner: self })
    expect(MOVE_MARKERS).toContain(LOCK_FILENAME)
  })

  it('refuses another installation\'s live lock and leaves it alone', () => {
    writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify(other))
    expect(inspectMoveLock(dir, self, alive)).toEqual({ kind: 'held', owner: other })
    expect(acquireMoveLock(dir, self, alive)).toEqual({ kind: 'held', owner: other })
    releaseMoveLock([dir], self)
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILENAME), 'utf8'))).toEqual(other)
  })

  it('takes over a lock whose process is gone, one that cannot be read, and its own from an earlier process', () => {
    writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify(other))
    expect(inspectMoveLock(dir, self, dead)).toMatchObject({ kind: 'stale' })
    expect(acquireMoveLock(dir, self, dead)).toEqual({ kind: 'taken' })
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILENAME), 'utf8'))).toEqual(self)
    writeFileSync(join(dir, LOCK_FILENAME), '{"userData":')
    expect(acquireMoveLock(dir, self, alive)).toEqual({ kind: 'taken' })
    writeFileSync(join(dir, LOCK_FILENAME), JSON.stringify({ ...self, pid: 999 }))
    expect(acquireMoveLock(dir, self, alive)).toEqual({ kind: 'taken' })
    expect(JSON.parse(readFileSync(join(dir, LOCK_FILENAME), 'utf8'))).toEqual(self)
  })

  it('releases only its own lock, in every place the data may be', () => {
    const second = join(dir, 'second')
    acquireMoveLock(dir, self, alive)
    releaseMoveLock([dir, second, join(dir, 'gone')], self)
    expect(inspectMoveLock(dir, self, alive)).toEqual({ kind: 'none' })
  })

  it('tells a running process from one that is gone', () => {
    expect(processIsAlive(process.pid)).toBe(true)
    expect(processIsAlive(2 ** 22 + 12345)).toBe(false)
  })
})
