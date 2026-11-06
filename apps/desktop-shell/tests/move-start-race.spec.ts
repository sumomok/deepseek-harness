/**
 * Two starts of a move racing for one installation: a second call while the
 * first is still checking, and a move another process recorded between the
 * first journal check and taking the lock. The journal module is wrapped so
 * a test can act at the moment the check after the lock reads the journal.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as journalModule from '../src/move/journal.ts'
import { beginDataMove, type MoveRequest, type MoveStartProbes } from '../src/move-start.ts'
import { JOURNAL_FILENAME, moveDir, readJournal } from '../src/move/journal.ts'
import { LOCK_FILENAME } from '../src/move/lock.ts'
import { nodePreflightProbes } from '../src/move/preflight.ts'
import { buildFixture, type Fixture } from './move-fixture.ts'

/** Called on each journal read; a test sets it to act in the middle of a start. */
let onRead: (dir: string) => void = () => undefined

vi.mock('../src/move/journal.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof journalModule>()
  return {
    ...actual,
    readJournal: (dir: string) => {
      onRead(dir)
      return actual.readJournal(dir)
    },
  }
})

const fixtures: Fixture[] = []
const posixOnly = process.platform === 'win32' ? it.skip : it

afterEach(async () => {
  onRead = () => undefined
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.root, 0o700)
    await rm(fixture.root, { recursive: true, force: true })
  }
})

/** A fixture, a request to move its home, and probes that answer. */
async function setup(): Promise<{ f: Fixture; request: MoveRequest; probes: MoveStartProbes }> {
  const f = await buildFixture({ bigBytes: 10_000 })
  fixtures.push(f)
  const userData = join(f.root, 'userData')
  mkdirSync(userData)
  const request: MoveRequest = {
    chosen: f.targetParent, home: f.home, userData, defaultHome: join(f.root, 'os-home', '.dsh'), platform: process.platform,
    forbidden: { install: [], userData, updateCache: join(f.root, 'cache'), workspaces: [], cloud: [], temp: [] },
    workspaces: 3, pid: process.pid, now: new Date('2026-09-28T00:00:00Z'),
  }
  const probes: MoveStartProbes = {
    preflight: nodePreflightProbes(process.platform),
    snapshotTerminal: async () => ({ kind: 'profile', file: '/p/.zshrc', hadBlock: false, backupExisted: false }),
    readTerminal: async () => ({ kind: 'unset' }),
    lock: { startTimeOf: async () => 'T', now: () => request.now },
  }
  return { f, request, probes }
}

describe('two starts at once', () => {
  it('starts one and refuses the other as in progress, keeping the started move\'s lock', async () => {
    const { f, request, probes } = await setup()
    const outcomes = await Promise.all([beginDataMove(request, probes), beginDataMove(request, probes)])
    expect(outcomes.map(one => one.kind).sort()).toEqual(['refused', 'started'])
    expect(outcomes.find(one => one.kind === 'refused')).toEqual({ kind: 'refused', refusal: { kind: 'in-progress' } })
    expect(readJournal(moveDir(request.userData))?.phase).toBe('requested')
    expect(JSON.parse(readFileSync(join(f.home, LOCK_FILENAME), 'utf8'))).toMatchObject({ userData: request.userData, pid: process.pid })
  })

  it('lets the installation start again once the first call has finished', async () => {
    const { request, probes } = await setup()
    await beginDataMove({ ...request, chosen: join(request.home, 'sessions') }, probes)
    expect((await beginDataMove(request, probes)).kind).toBe('started')
  })
})

describe('a move recorded while this call took the lock', () => {
  it('is refused as in progress, and the lock this call wrote is removed', async () => {
    const { f, request, probes } = await setup()
    const dir = moveDir(request.userData)
    let reads = 0
    onRead = (at) => {
      if (at !== dir) return
      reads += 1
      // The second read is the check after the lock: another process has recorded a move by now.
      if (reads === 2) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, JOURNAL_FILENAME), '{')
      }
    }
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'in-progress' } })
    expect(reads).toBe(2)
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
    expect(readFileSync(join(dir, JOURNAL_FILENAME), 'utf8')).toBe('{')
  })

  it('leaves a lock another process of this installation put in place of this call\'s', async () => {
    const { f, request, probes } = await setup()
    const dir = moveDir(request.userData)
    const theirs = JSON.stringify({ userData: request.userData, pid: 424242, startedAt: 'S', heartbeatAt: '2026-09-28T00:00:01.000Z' })
    let reads = 0
    onRead = (at) => {
      if (at !== dir) return
      reads += 1
      if (reads === 2) {
        writeFileSync(join(f.home, LOCK_FILENAME), theirs)
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, JOURNAL_FILENAME), '{')
      }
    }
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'in-progress' } })
    expect(readFileSync(join(f.home, LOCK_FILENAME), 'utf8')).toBe(theirs)
  })

  posixOnly('removes this call\'s own lock when writing the journal fails', async () => {
    const { f, request, probes } = await setup()
    const dir = moveDir(request.userData)
    let reads = 0
    onRead = (at) => {
      if (at !== dir) return
      reads += 1
      // The move directory becomes read-only, so writing the journal throws.
      if (reads === 2) {
        mkdirSync(dir, { recursive: true })
        chmodSync(dir, 0o500)
      }
    }
    await expect(beginDataMove(request, probes)).rejects.toThrow()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
  })
})
