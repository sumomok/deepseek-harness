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
  bootMove, checkHealth, CLEANUP_PROMPT_AFTER, cleanupPrompt, countSessions, lockPlaces, moveFacts, passHealthCheck, quarantinedPlugins,
  relaunchHome,
} from '../src/move-boot.ts'
import {
  beginDataMove, checkDataMove, handOverToMove, installPlaces, withdrawRequestAtBoot, withdrawRequestedMove, type MoveRequest,
  type MoveStartProbes,
} from '../src/move-start.ts'
import { ABANDONED_FILENAME, JOURNAL_FILENAME, moveDir, readJournal, type MoveJournal } from '../src/move/journal.ts'
import { LOCK_FILENAME } from '../src/move/lock.ts'
import { nodePreflightProbes } from '../src/move/preflight.ts'
import { DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME, profileDirectory, writeMigrationMarker } from '../src/profile-seed.ts'
import { stopServerTree } from '../src/process-tree.ts'
import type { TerminalSnapshot } from '../src/terminal-env.ts'
import { entry, fakeSystem } from './fake-processes.ts'
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
    forbidden: { install: [], userData, updateCache: join(f.root, 'cache'), workspaces: [], cloud: [], temp: [] },
    workspaces: 3, pid: process.pid, now: new Date('2026-09-28T00:00:00Z'),
  }
  const probes: MoveStartProbes = {
    preflight: nodePreflightProbes(process.platform),
    snapshotTerminal: async () => snapshot,
    readTerminal: async () => ({ kind: 'unset' }),
    lock: {
      startTimeOf: async pid => pid === process.pid ? 'Mon Sep 28 09:00:00 2026' : isAlive() ? 'Mon Sep 28 08:00:00 2026' : undefined,
      now: () => request.now,
    },
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
    expect(JSON.parse(readFileSync(join(f.home, LOCK_FILENAME), 'utf8'))).toEqual({
      userData: request.userData, pid: process.pid, startedAt: 'Mon Sep 28 09:00:00 2026', heartbeatAt: request.now.toISOString(),
    })
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

  it('refuses a second move, a location the preflight refuses, and another installation\'s lock, running or not', async () => {
    const { f, request, probes } = await setup()
    expect((await beginDataMove({ ...request, chosen: join(f.home, 'sessions') }, probes)))
      .toMatchObject({ kind: 'refused', refusal: { kind: 'preflight' } })
    const elsewhere = { userData: '/elsewhere', pid: 7, startedAt: 'Mon Sep 28 08:00:00 2026', heartbeatAt: '2026-01-01T00:00:00Z' }
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify(elsewhere))
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'locked', lock: { kind: 'held', owner: elsewhere } } })
    const gone = (await setup(SNAPSHOT, () => false)).probes
    expect(await beginDataMove(request, gone))
      .toEqual({ kind: 'refused', refusal: { kind: 'locked', lock: { kind: 'unfinished', owner: elsewhere, path: join(f.home, LOCK_FILENAME) } } })
    expect(existsSync(join(moveDir(request.userData), JOURNAL_FILENAME))).toBe(false)
    writeFileSync(join(f.home, LOCK_FILENAME), JSON.stringify({ ...elsewhere, userData: request.userData, pid: 99 }))
    expect((await beginDataMove(request, probes)).kind).toBe('started')
    expect(await beginDataMove(request, probes)).toEqual({ kind: 'refused', refusal: { kind: 'in-progress' } })
  })

  it('takes back a move that was only requested, and refuses once it went further', async () => {
    const { f, request, probes } = await setup()
    const outcome = await beginDataMove(request, probes)
    if (outcome.kind !== 'started') throw new Error(outcome.kind)
    withdrawRequestedMove(outcome.journal, request)
    expect(readJournal(moveDir(request.userData))).toBeUndefined()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
    expect(existsSync(join(moveDir(request.userData), 'last-result.json'))).toBe(false)
    const again = await beginDataMove(request, probes)
    if (again.kind !== 'started') throw new Error(again.kind)
    writeFileSync(join(moveDir(request.userData), JOURNAL_FILENAME), JSON.stringify({ ...again.journal, phase: 'copying' }))
    expect(() => { withdrawRequestedMove(again.journal, request) }).toThrow('no longer only requested')
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(true)
  })

  it('withdraws at launch a move that never started copying, lock included, and leaves any other move alone', async () => {
    const { f, request, probes } = await setup()
    const dir = moveDir(request.userData)
    expect(withdrawRequestAtBoot(bootMove(dir), request)).toEqual({ kind: 'none' })
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(true)
    expect(withdrawRequestAtBoot(bootMove(dir), request)).toEqual({ kind: 'none' })
    expect(readJournal(dir)).toBeUndefined()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
    const again = await beginDataMove(request, probes)
    if (again.kind !== 'started') throw new Error(again.kind)
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...again.journal, phase: 'copying' }))
    expect(withdrawRequestAtBoot(bootMove(dir), request)).toMatchObject({ kind: 'resume' })
    expect(readJournal(dir)?.phase).toBe('copying')
  })

  posixOnly('reports a move it cannot withdraw at launch instead of going on, with the journal kept', async () => {
    const { f, request, probes } = await setup()
    const dir = moveDir(request.userData)
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    chmodSync(dir, 0o500)
    try {
      expect(withdrawRequestAtBoot(bootMove(dir), request)).toMatchObject({ kind: 'withdraw-failed', path: dir })
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(bootMove(dir)).toMatchObject({ kind: 'requested' })
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(true)
    // The journal went, the lock could not: only this installation's lock is left, which the launch releases.
    chmodSync(f.home, 0o500)
    try {
      expect(withdrawRequestAtBoot(bootMove(dir), request)).toMatchObject({ kind: 'withdraw-failed' })
    } finally {
      chmodSync(f.home, 0o700)
    }
    expect(bootMove(dir)).toEqual({ kind: 'none' })
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(true)
  })

  posixOnly('gives back the lock at the new location when the health check passes, and leaves the one in the hidden original', async () => {
    const { request, probes } = await setup()
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    const dir = moveDir(request.userData)
    const journal = started.journal
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'switched' }))
    for (const place of [journal.target, journal.hidden]) {
      mkdirSync(place, { recursive: true })
      writeFileSync(join(place, LOCK_FILENAME), readFileSync(join(journal.source, LOCK_FILENAME)))
    }
    passHealthCheck(dir, request, () => undefined)
    expect(readJournal(dir)?.phase).toBe('cleanup')
    expect(existsSync(join(journal.target, LOCK_FILENAME))).toBe(false)
    expect(existsSync(join(journal.hidden, LOCK_FILENAME))).toBe(true)
    // A lock that cannot be removed is logged; the health check stays recorded.
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'switched' }))
    writeFileSync(join(journal.target, LOCK_FILENAME), readFileSync(join(journal.hidden, LOCK_FILENAME)))
    const logged: string[] = []
    chmodSync(journal.target, 0o500)
    try {
      passHealthCheck(dir, request, (line) => { logged.push(line) })
    } finally {
      chmodSync(journal.target, 0o700)
    }
    expect(readJournal(dir)?.phase).toBe('cleanup')
    expect(logged.join('')).toContain('could not give back the lock')
  })

  it('checks a move without writing anything, and knows where the application is installed', async () => {
    const { f, request, probes } = await setup()
    const verdict = await checkDataMove(request, probes.preflight)
    expect(verdict.ok).toBe(true)
    expect(readJournal(moveDir(request.userData))).toBeUndefined()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
    // The check names the same place the start then moves to.
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    expect(started.journal.target).toBe(verdict.target.target)
    withdrawRequestedMove(started.journal, request)
    const inside = await checkDataMove({ ...request, chosen: join(f.home, 'sessions') }, probes.preflight)
    expect(inside.ok).toBe(false)
    expect(installPlaces({ platform: 'darwin', execPath: '/Applications/Beiming.app/Contents/MacOS/Beiming', appPath: '/x/app.asar' }))
      .toEqual(['/Applications/Beiming.app', '/x/app.asar'])
    expect(installPlaces({ platform: 'win32', execPath: 'C:\\Program Files\\DSH\\DSH.exe', appPath: 'C:\\Program Files\\DSH\\resources\\app.asar' }))
      .toEqual(['C:\\Program Files\\DSH', 'C:\\Program Files\\DSH\\resources\\app.asar'])
    expect(installPlaces({ platform: 'linux', execPath: '/opt/dsh/dsh', appPath: '/opt/dsh' })).toEqual(['/opt/dsh'])
  })

  it('hands the data to the move only once the server tree is gone, and otherwise takes the move back and restarts the server', async () => {
    const { f, request, probes } = await setup()
    const first = await beginDataMove(request, probes)
    if (first.kind !== 'started') throw new Error(first.kind)
    let restarts = 0
    const restartServer = async (): Promise<void> => { restarts += 1 }
    // The server's MCP child never dies.
    const system = fakeSystem([entry(1, 0), entry(4000, 1, 'node'), entry(4242, 4000, 'mcp'), entry(4243, 4000, 'terminal')], [4242])
    const stopTree = (): ReturnType<typeof stopServerTree> => stopServerTree({
      pid: 4000, stop: async () => { system.stopServer(4000) }, sweep: async () => undefined, probes: system.probes,
    })
    const refused = await handOverToMove(first.journal, request, { stopServerTree: stopTree, restartServer })
    expect(refused).toEqual({ kind: 'refused', refusal: { kind: 'server-still-running', pids: [4242] } })
    expect(restarts).toBe(1)
    expect(readJournal(moveDir(request.userData))).toBeUndefined()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
    const second = await beginDataMove(request, probes)
    if (second.kind !== 'started') throw new Error(second.kind)
    // A process list that cannot be read confirms nothing.
    const blind = { list: async () => [], kill: async () => undefined, sleep: async () => undefined }
    const unconfirmed = await handOverToMove(second.journal, request, {
      stopServerTree: () => stopServerTree({ pid: 4000, stop: async () => undefined, sweep: async () => undefined, probes: blind }),
      restartServer,
    })
    expect(unconfirmed).toEqual({ kind: 'refused', refusal: { kind: 'server-still-running', pids: [] } })
    expect(restarts).toBe(2)
    const third = await beginDataMove(request, probes)
    if (third.kind !== 'started') throw new Error(third.kind)
    const clean = fakeSystem([entry(1, 0), entry(4000, 1, 'node'), entry(4001, 4000, 'mcp')])
    const handed = await handOverToMove(third.journal, request, {
      stopServerTree: () => stopServerTree({
        pid: 4000, stop: async () => { clean.stopServer(4000) }, sweep: async () => undefined, probes: clean.probes,
      }),
      restartServer,
    })
    expect(handed).toEqual({ kind: 'go' })
    expect(restarts).toBe(2)
    expect(readJournal(moveDir(request.userData))?.phase).toBe('requested')
  })

  it('prompts about a cleanup only once enough removals in a row left files behind, and only in phase cleanup', async () => {
    const { request, probes } = await setup()
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    const dir = moveDir(request.userData)
    const write = (fields: Partial<MoveJournal>): void => {
      writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...started.journal, ...fields }))
    }
    expect(cleanupPrompt(dir)).toBeUndefined()
    write({ phase: 'cleanup', cleanupAttempts: CLEANUP_PROMPT_AFTER - 1, cleanupLeftoverBytes: 35 })
    expect(cleanupPrompt(dir)).toBeUndefined()
    write({ phase: 'cleanup', cleanupAttempts: CLEANUP_PROMPT_AFTER, cleanupLeftoverBytes: 35 })
    expect(cleanupPrompt(dir)).toEqual({ leftoverBytes: 35 })
    write({ phase: 'cleanup', cleanupAttempts: CLEANUP_PROMPT_AFTER, cleanupLeftoverBytes: 0 })
    expect(cleanupPrompt(dir)).toBeUndefined()
    write({ phase: 'switched', cleanupAttempts: CLEANUP_PROMPT_AFTER, cleanupLeftoverBytes: 35 })
    expect(cleanupPrompt(dir)).toBeUndefined()
    writeFileSync(join(dir, JOURNAL_FILENAME), '{')
    expect(cleanupPrompt(dir)).toBeUndefined()
    expect(CLEANUP_PROMPT_AFTER).toBe(3)
  })

  it('tells /state whether a move is recorded, whether its cleanup runs now, and the cleanup prompt', async () => {
    const { request, probes } = await setup()
    const dir = moveDir(request.userData)
    const idle = { moving: false, cleanupRunning: false, cleanupWaiting: false }
    expect(moveFacts(dir, true)).toEqual(idle)
    expect(moveFacts(dir, false)).toEqual(idle)
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    const neither = { moving: true, cleanupRunning: false, cleanupWaiting: false }
    // A move asked for and not yet carried, and one switched and waiting for its health check, remove nothing.
    expect(moveFacts(dir, true)).toEqual(neither)
    expect(moveFacts(dir, false)).toEqual(neither)
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...started.journal, phase: 'switched' }))
    expect(moveFacts(dir, true)).toEqual(neither)
    expect(moveFacts(dir, false)).toEqual(neither)
    const cleanup = { ...started.journal, phase: 'cleanup', cleanupAttempts: CLEANUP_PROMPT_AFTER, cleanupLeftoverBytes: 7 }
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify(cleanup))
    expect(moveFacts(dir, false)).toEqual({ moving: true, cleanupRunning: false, cleanupWaiting: true, cleanup: { leftoverBytes: 7 } })
    expect(moveFacts(dir, true)).toEqual({ moving: true, cleanupRunning: true, cleanupWaiting: false, cleanup: { leftoverBytes: 7 } })
  })

  it('takes the move back and restarts the server when stopping it fails', async () => {
    const { f, request, probes } = await setup()
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    let restarts = 0
    await expect(handOverToMove(started.journal, request, {
      stopServerTree: async () => { throw new Error('taskkill: access denied') },
      restartServer: async () => { restarts += 1 },
    })).rejects.toThrow('taskkill: access denied')
    expect(restarts).toBe(1)
    expect(readJournal(moveDir(request.userData))).toBeUndefined()
    expect(existsSync(join(f.home, LOCK_FILENAME))).toBe(false)
  })

  it('restarts the server even when the move cannot be taken back', async () => {
    const { request, probes } = await setup()
    const started = await beginDataMove(request, probes)
    if (started.kind !== 'started') throw new Error(started.kind)
    let restarts = 0
    // The journal names another move by now, so taking this one back is refused.
    await expect(handOverToMove({ ...started.journal, moveId: 'other' as typeof started.journal.moveId }, request, {
      stopServerTree: async () => ({ kind: 'unconfirmed', detail: 'ps failed' }),
      restartServer: async () => { restarts += 1 },
    })).rejects.toThrow('no longer only requested')
    expect(restarts).toBe(1)
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
    expect(bootMove(dir)).toMatchObject({ kind: 'requested' })
    writeFileSync(join(dir, JOURNAL_FILENAME), JSON.stringify({ ...readJournal(dir), phase: 'copying' }))
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
