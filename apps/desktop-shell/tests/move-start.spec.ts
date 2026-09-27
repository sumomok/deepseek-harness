/**
 * Starting a data move and what a launch does about one: the checks before
 * the journal is written, the lock, the baseline, the boot decision, the
 * health check, and where the application relaunches. Every directory is
 * under a temporary root; the terminal reads are stand-ins.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  bootMove, checkHealth, countSessions, lockPlaces, quarantinedPlugins, relaunchHome,
} from '../src/move-boot.ts'
import { beginDataMove, type MoveRequest, type MoveStartProbes } from '../src/move-start.ts'
import { ABANDONED_FILENAME, JOURNAL_FILENAME, moveDir, readJournal, type MoveJournal } from '../src/move/journal.ts'
import { LOCK_FILENAME } from '../src/move/lock.ts'
import { nodePreflightProbes } from '../src/move/preflight.ts'
import { DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME, profileDirectory, writeMigrationMarker } from '../src/profile-seed.ts'
import type { TerminalSnapshot } from '../src/terminal-env.ts'
import { buildFixture, type Fixture } from './move-fixture.ts'

const fixtures: Fixture[] = []
const posixOnly = process.platform === 'win32' ? it.skip : it

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    chmodSync(fixture.root, 0o700)
    await rm(fixture.root, { recursive: true, force: true })
  }
})

const SNAPSHOT: TerminalSnapshot = { kind: 'profile', file: '/p/.zshrc', hadBlock: false, backupExisted: false }

/** A fixture with a request to move its home and probes that answer. */
interface Setup {
  f: Fixture
  request: MoveRequest
  probes: MoveStartProbes
}

/** A fixture, a request to move its home, and probes that answer. */
async function setup(snapshot: TerminalSnapshot = SNAPSHOT, isAlive = (): boolean => true): Promise<Setup> {
  const f = await buildFixture({ bigBytes: 10_000 })
  fixtures.push(f)
  const userData = join(f.root, 'userData')
  mkdirSync(userData)
  const request: MoveRequest = {
    chosen: f.targetParent, home: f.home, userData, defaultHome: join(f.root, 'os-home', '.dsh'), platform: process.platform,
    forbidden: { install: [], userData, updateCache: join(f.root, 'cache'), workspaces: [], cloud: [] },
    workspaces: 3, pid: process.pid, now: new Date('2026-09-28T00:00:00Z'),
  }
  const probes: MoveStartProbes = {
    preflight: nodePreflightProbes(process.platform),
    snapshotTerminal: async () => snapshot,
    readTerminal: async () => ({ kind: 'unset' }),
    isAlive,
  }
  return { f, request, probes }
}

describe('starting a data move', () => {
  it('writes the journal with the snapshot and the baseline, and takes the lock in the data directory', async () => {
    const { f, request, probes } = await setup()
    const outcome = await beginDataMove(request, probes)
    expect(outcome.kind).toBe('started')
    const journal = readJournal(moveDir(request.userData))
    expect(journal).toMatchObject({
      phase: 'requested', source: f.home, target: f.targetParent, targetPreexisting: true, terminalSnapshot: SNAPSHOT,
      terminalBefore: { kind: 'unset' }, baseline: { sessions: countSessions(f.home), workspaces: 3, quarantined: [] },
    })
    expect(countSessions(f.home)).toBeGreaterThan(0)
    expect(JSON.parse(readFileSync(join(f.home, LOCK_FILENAME), 'utf8'))).toEqual({ userData: request.userData, pid: process.pid })
  })

  it('refuses without a readable terminal setting, and writes nothing', async () => {
    const { f, request, probes } = await setup({ kind: 'unknown', detail: 'login shell timed out' })
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'terminal-unreadable', detail: 'login shell timed out' } })
    expect(existsSync(join(moveDir(request.userData), JOURNAL_FILENAME))).toBe(false)
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
  })

  it('refuses while the record of abandoned copies cannot be read, and leaves it alone', async () => {
    const { request, probes } = await setup()
    mkdirSync(moveDir(request.userData))
    const record = join(moveDir(request.userData), ABANDONED_FILENAME)
    writeFileSync(record, '{')
    const outcome = await beginDataMove(request, probes)
    expect(outcome).toMatchObject({ kind: 'refused', refusal: { kind: 'abandoned-unreadable', path: record } })
    expect(readFileSync(record, 'utf8')).toBe('{')
  })

  it('refuses a second move, a location the preflight refuses, and another installation\'s live lock', async () => {
    const { f, request, probes } = await setup()
    expect((await beginDataMove({ ...request, chosen: join(f.home, 'sessions') }, probes)))
      .toMatchObject({ kind: 'refused', refusal: { kind: 'preflight' } })
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ userData: '/elsewhere', pid: 7 }))
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'locked', owner: { userData: '/elsewhere', pid: 7 } } })
    expect(existsSync(join(moveDir(request.userData), JOURNAL_FILENAME))).toBe(false)
    const stale = { ...probes, isAlive: () => false }
    expect((await beginDataMove(request, stale)).kind).toBe('started')
    expect(await beginDataMove(request, stale)).toEqual({ kind: 'refused', refusal: { kind: 'in-progress' } })
  })

  posixOnly('gives the lock back when the journal cannot be written', async () => {
    const { f, request, probes } = await setup()
    mkdirSync(moveDir(request.userData))
    chmodSync(moveDir(request.userData), 0o500)
    try {
      await expect(beginDataMove(request, probes)).rejects.toThrow()
    } finally {
      chmodSync(moveDir(request.userData), 0o700)
    }
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
  })
})

describe('a launch with a move on disk', () => {
  it('names the phase that decides whether the server may start', async () => {
    const { request, probes } = await setup()
    const dir = moveDir(request.userData)
    expect(bootMove(dir)).toEqual({ kind: 'none' })
    await beginDataMove(request, probes)
    expect(bootMove(dir)).toMatchObject({ kind: 'resume' })
    const journal = JSON.parse(readFileSync(join(dir, JOURNAL_FILENAME), 'utf8')) as MoveJournal
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'switched' }))
    expect(bootMove(dir)).toMatchObject({ kind: 'health-check' })
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'cleanup' }))
    expect(bootMove(dir)).toMatchObject({ kind: 'cleanup' })
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'rolling-back' }))
    expect(bootMove(dir)).toMatchObject({ kind: 'resume' })
    writeFileSync(join(dir, JOURNAL_FILENAME), '{')
    expect(bootMove(dir)).toMatchObject({ kind: 'unreadable', path: join(dir, JOURNAL_FILENAME) })
  })

  it('checks the new location against the baseline', () => {
    const baseline = { sessions: 3, workspaces: 2, quarantined: ['a'] }
    expect(checkHealth(baseline, { sessions: 3, quarantined: ['a'], workspaces: 2 }).healthy).toBe(true)
    expect(checkHealth(baseline, { sessions: 4, quarantined: [], workspaces: 2 }).healthy).toBe(true)
    expect(checkHealth(baseline, { sessions: 2, quarantined: ['a'], workspaces: 2 })).toMatchObject({ healthy: false, detail: 'sessions 2 < 3' })
    expect(checkHealth(baseline, { sessions: 3, quarantined: ['a', 'b'], workspaces: 2 })).toMatchObject({ healthy: false })
    expect(checkHealth(baseline, { sessions: 3, quarantined: ['a'], workspaces: 1 })).toMatchObject({ healthy: false })
    const unknown = checkHealth(baseline, { sessions: 3, quarantined: ['a'] })
    expect(unknown.healthy).toBe(true)
    expect(unknown.detail).toContain('not compared')
    expect(checkHealth({ sessions: 3, quarantined: [] }, { sessions: 3, quarantined: [], workspaces: 9 }).healthy).toBe(true)
  })

  it('reads the quarantined plugins from the desktop profile\'s marker', async () => {
    const { f } = await setup()
    const profile = profileDirectory(f.home, DESKTOP_PROFILE)
    mkdirSync(profile, { recursive: true })
    writeMigrationMarker(join(profile, MIGRATION_MARKER_FILENAME), {
      from: 'web', migrated: [], removed: [],
      defective: [{ name: 'z-plugin', kind: 'load-failed', detail: 'x', at: 1 }, { name: 'a-plugin', kind: 'load-failed', detail: 'y', at: 2 }],
    })
    expect(quarantinedPlugins(f.home)).toEqual(['a-plugin', 'z-plugin'])
  })

  it('relaunches onto the new location once switched or moved, onto the original otherwise, and not while blocked', () => {
    const journal = { source: '/s', target: '/t', hidden: '/h' } as Pick<MoveJournal, 'source' | 'target' | 'hidden'>
    const base = { version: 1 as const, moveId: 'm' as MoveJournal['moveId'], source: '/s', target: '/t', leftovers: [], finishedAt: '' }
    const full = journal as MoveJournal
    expect(relaunchHome(full, { kind: 'switched' })).toBe('/t')
    expect(relaunchHome(full, { kind: 'ended', result: { ...base, outcome: 'moved' } })).toBe('/t')
    expect(relaunchHome(full, { kind: 'ended', result: { ...base, outcome: 'failed' } })).toBe('/s')
    expect(relaunchHome(full, { kind: 'ended', result: { ...base, outcome: 'cancelled' } })).toBe('/s')
    expect(relaunchHome(full, { kind: 'blocked', reason: 'choice-needed', dataAt: [], choices: [], targetPrint: null })).toBeUndefined()
    expect(lockPlaces(full, { ...base, outcome: 'failed', unusedCopy: { path: '/u' } })).toEqual(['/s', '/t', '/h', '/u'])
  })
})
