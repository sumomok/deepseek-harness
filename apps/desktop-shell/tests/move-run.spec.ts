/**
 * The data move from start to end on a fixture home, in process: a move to
 * another volume and a rename on one, cancel, a failed check, a failed health
 * check rolled back from both starting points, a pre-existing empty target,
 * cleanup that has to be retried, and the journal's validation and step table.
 * @module
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DATA_ID_FILENAME, dataReference, GENERATION_FILENAME, readDataId, readGeneration, readPointer, resolveDataLocation, setAsideReason,
  writeGeneration, type Resolution,
} from '../src/data-location.ts'
import { calibrateHomeLink } from '../src/home-link.ts'
import { processDshHome } from '../src/terminal-env.ts'
import {
  abandonedCopiesText, isAbandonedCopy, JOURNAL_FILENAME, JournalError, MAX_REPAIR_ROUNDS, mayStartServer, MOVE_PHASES, nextAction,
  readAbandonedCopies, readJournal, readMoveResult, RESULT_FILENAME, RETIRED_FILENAME, validateJournal,
  type DirFacts, type MoveFacts, type MoveId, type MoveJournal,
} from '../src/move/journal.ts'
import {
  advanceMove, canonicalPath, failureKindOf, MOVE_MARKERS, MoveStuckError, nodeMoveFs, PRINT_EXCLUDE, recordHealth, resolveBlocked,
  pointerSeeingTerminal, readPointerFiles, retireAbandonedCopies, abandonMove, lockExpectedAt, rollBackMove, rolledBackPointer, startMove,
  StepFailure,
  type BlockedView, type MoveEffects, type MoveOutcome,
} from '../src/move/run.ts'
import { CopyMismatchError } from '../src/move/copier.ts'
import { acquireMoveLock, checkOwnLock, LOCK_FILENAME, MoveLockLostError } from '../src/move/lock.ts'
import { keptFolderName } from '../src/move/names.ts'
import { MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES } from '../src/move/tree.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'
import {
  HARNESS_ID, harnessEffects, INTRUDER_ID, plantIntruder, prepareMove, terminalValue, type MoveSetup, type Start,
} from './move-harness.ts'

const fixtures: Fixture[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    for (const line of listTree(fixture.root)) {
      if (line.startsWith('dir ')) chmodSync(join(fixture.root, line.slice(4)), 0o700)
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
})

const posixOnly = process.platform === 'win32' ? it.skip : it
const PID = 4242

/** A prepared move and the home's listing before it. */
interface Scenario {
  f: Fixture
  setup: MoveSetup
  target: string
  before: string[]
  pointerBefore: { main?: string; backup?: string }
}

/**
 * Build a fixture and prepare a move.
 * @param options - the variant.
 * @returns the scenario.
 */
async function scenario(options: { sameVolume: boolean; start: Start; targetPreexisting?: boolean }): Promise<Scenario> {
  const f = await buildFixture({ bigBytes: 200_000 })
  fixtures.push(f)
  const target = join(f.targetParent, 'DSH-Data')
  const setup = prepareMove({ root: f.root, home: f.home, target, ...options })
  startMove(setup.dir, setup.start, { pid: PID, now: new Date() })
  return { f, setup, target, before: listTree(f.home), pointerBefore: setup.start.pointerBefore }
}

/**
 * What the next launch does on the new location before the health check:
 * point `~/.dsh` at it.
 * @param s - the scenario.
 */
function bootOnTarget(s: Scenario): void {
  calibrateHomeLink({ defaultHome: s.setup.defaultHome, dataHome: s.target, dataId: HARNESS_ID, platform: process.platform })
}

/**
 * The data files of a listing: every file line except the identity, the move and retired markers, and the rebuildable entries.
 * @param listing - a {@link listTree} listing.
 * @returns the file lines.
 */
function dataFiles(listing: readonly string[]): string[] {
  return listing.filter(line => line.startsWith('file ')
    && !line.startsWith('file .dsh-data-id ')
    && !line.startsWith('file .dsh-data-id.moved ')
    && !line.startsWith(`file ${MOVE_STATE_FILENAME} `)
    && !line.startsWith(`file ${RETIRED_FILENAME} `)
    && !line.startsWith('file .dsh-data-generation ')
    && !REBUILDABLE_ENTRIES.some(entry => line.startsWith(`file ${entry}/`) || line.startsWith(`file ${entry} `)))
}

/**
 * The original's listing without its generation file, which a rollback adds
 * (a number above the copy's); everything else must be as before the move.
 * @param s - the scenario.
 * @returns the listing.
 */
function originalListing(s: Scenario): string[] {
  return listTree(s.f.home).filter(line => !line.startsWith('file .dsh-data-generation '))
}

/**
 * Read a pointer file's text.
 * @param s - the scenario.
 * @param name - the file name.
 * @returns its text, or `undefined`.
 */
function pointerText(s: Scenario, name: string): string | undefined {
  const path = join(s.setup.userData, name)
  return existsSync(path) ? readFileSync(path, 'utf8') : undefined
}

/**
 * Switch, fail the check, and stop the rollback inside the step that records
 * what a terminal reads: the restore wrote the old setting and then failed,
 * the first read of the setting failed, and the stop comes right after the
 * pointer write, before the step's flag is saved.
 * @param s - the scenario.
 */
async function stopAfterRecordedPointer(s: Scenario): Promise<void> {
  await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
  recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
  const real = harnessEffects(s.setup)
  const stop = new Error('stop after the pointer write')
  let reading = false
  const interrupted: MoveEffects = {
    ...real,
    restoreTerminal: async (snapshot) => {
      await real.restoreTerminal(snapshot)
      throw new Error('EPERM: operation not permitted, chmod \'.zshrc\'')
    },
    terminalSeen: async () => {
      reading = true
      throw new Error('the login shell timed out reading DSH_HOME')
    },
    writePointer: (pointer) => {
      real.writePointer(pointer)
      if (reading) throw stop
    },
  }
  await expect(advanceMove(s.setup.dir, interrupted, { pid: PID })).rejects.toBe(stop)
  expect(readJournal(s.setup.dir)).toMatchObject({ terminalRestoreFailed: 'EPERM: operation not permitted, chmod \'.zshrc\'' })
  expect(readJournal(s.setup.dir)?.terminalRecordedAsSeen).toBeUndefined()
  expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, lastSeenEnv: s.target } })
}

/**
 * Run the move to its end, passing or failing the health check.
 * @param s - the scenario.
 * @param healthy - the health check's verdict.
 * @param effects - the effects.
 * @returns the last outcome.
 */
async function runToEnd(s: Scenario, healthy: boolean, effects: MoveEffects = harnessEffects(s.setup)): Promise<MoveOutcome> {
  const first = await advanceMove(s.setup.dir, effects, { pid: PID })
  expect(first).toEqual({ kind: 'switched' })
  bootOnTarget(s)
  recordHealth(s.setup.dir, healthy ? undefined : { detail: 'sessions missing', failures: ['fewer-sessions'] })
  return advanceMove(s.setup.dir, effects, { pid: PID })
}

/**
 * What a page showing a blocked outcome would send back with the person's choice.
 * @param outcome - the blocked outcome.
 * @returns its reason and print.
 */
function seenOf(outcome: MoveOutcome): BlockedView {
  if (outcome.kind !== 'blocked') throw new Error(`not blocked: ${outcome.kind}`)
  return { reason: outcome.reason, targetPrint: outcome.targetPrint }
}

/** The unused copy a result names, in the target's parent. */
const UNUSED_PREFIX = 'DSH-Data (unused copy '

/**
 * The folders in the target's parent that are unused copies.
 * @param s - the scenario.
 * @returns their names.
 */
function unusedCopies(s: Scenario): string[] {
  return readdirSync(s.f.targetParent).filter(name => name.startsWith(UNUSED_PREFIX))
}

describe('a move to another volume', () => {
  posixOnly('copies, hides the source, switches the pointer and the terminal, then deletes the old copy', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const calls: string[] = []
    const real = harnessEffects(s.setup)
    const effects: MoveEffects = {
      ...real,
      writePointer: (pointer) => {
        calls.push('pointer')
        real.writePointer(pointer)
      },
      syncTerminal: async (target) => {
        calls.push('terminal')
        return real.syncTerminal(target)
      },
    }
    const first = await advanceMove(s.setup.dir, effects, { pid: PID })
    expect(first).toEqual({ kind: 'switched' })
    expect(calls).toEqual(['pointer', 'pointer', 'terminal', 'pointer'])
    const journal = readJournal(s.setup.dir)
    expect(journal?.phase).toBe('switched')
    expect(existsSync(s.f.home)).toBe(false)
    expect(existsSync(journal?.hidden ?? '')).toBe(true)
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    expect(existsSync(join(s.target, MOVE_STATE_FILENAME))).toBe(false)
    expect(JSON.parse(pointerText(s, 'data-location.json') ?? '{}')).toMatchObject({ path: s.target, dataId: HARNESS_ID, lastSeenEnv: s.target })
    expect(terminalValue(s.setup)).toBe(s.target)
    bootOnTarget(s)
    recordHealth(s.setup.dir, undefined)
    const last = await advanceMove(s.setup.dir, effects, { pid: PID })
    expect(last).toMatchObject({ kind: 'ended', result: { outcome: 'moved', source: s.f.home, target: s.target } })
    expect(existsSync(journal?.hidden ?? '')).toBe(false)
    expect(readdirSync(s.setup.dir)).toEqual(['last-result.json'])
    expect(readMoveResult(s.setup.dir)?.outcome).toBe('moved')
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
    expect(readlinkSync(join(s.target, 'profiles', 'desktop-shell', 'node_modules', 'clsx')))
      .toBe(join(s.target, 'profiles', 'desktop-shell', '.dsh-module-fallback', 'node_modules', 'clsx'))
    expect(readFileSync(join(s.f.sentinel, 'keep.txt'), 'utf8')).toBe('sentinel\n')
    expect(readlinkSync(s.setup.defaultHome)).toBe(s.target)
  })

  posixOnly('moves ~/.dsh itself: the old name becomes a link to the target', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    expect(await runToEnd(s, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readlinkSync(s.setup.defaultHome)).toBe(s.target)
    expect(existsSync(hidden)).toBe(false)
    expect(JSON.parse(pointerText(s, 'data-location.json') ?? '{}')).toMatchObject({ path: s.target, dataId: HARNESS_ID })
    expect(terminalValue(s.setup)).toBe(s.target)
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
  })

  posixOnly('rolls back a failed health check to exactly where it started from a pointer, retiring the copy', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const outcome = await runToEnd(s, false)
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: 'sessions missing' } })
    expect(readMoveResult(s.setup.dir)?.failure).toEqual({ kind: 'fewer-sessions' })
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    // The copy was exposed (the pointer and the terminal were told about it), so it is kept, retired, beside where it was.
    const [unused] = unusedCopies(s)
    expect(unused).toBeDefined()
    const unusedPath = join(s.f.targetParent, unused ?? '')
    expect(outcome.kind === 'ended' ? outcome.result.unusedCopy : undefined).toEqual({ path: unusedPath })
    expect(readMoveResult(s.setup.dir)?.unusedCopy).toEqual({ path: unusedPath })
    expect(dataFiles(listTree(unusedPath))).toEqual(dataFiles(s.before))
    expect(existsSync(join(unusedPath, '.dsh-data-id'))).toBe(false)
    expect(JSON.parse(readFileSync(join(unusedPath, RETIRED_FILENAME), 'utf8'))).toMatchObject({ dataId: HARNESS_ID })
    // The pointer is the one from before, numbered as the original is now; the backup is as it was.
    expect(pointerText(s, 'data-location.json')).toBe(rolledBackPointer(s.pointerBefore, readGeneration(s.f.home)).main)
    expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, generation: readGeneration(s.f.home) } })
    expect(readGeneration(s.f.home)).toBeGreaterThan(readGeneration(unusedPath))
    expect(pointerText(s, 'data-location.json.bak')).toBe(s.pointerBefore.backup)
    expect(readlinkSync(s.setup.defaultHome)).toBe(s.f.home)
    expect(terminalValue(s.setup)).toBe(s.f.home)
    expect(readdirSync(s.f.targetParent)).toEqual([unused])
  })

  it('numbers the pointer a rollback writes back no lower than the original, and leaves other files as they were', () => {
    const main = `${JSON.stringify({ version: 1, path: '/data', dataId: HARNESS_ID, generation: 5 }, null, 2)}\n`
    expect(JSON.parse(rolledBackPointer({ main, backup: 'b' }, 7).main ?? '')).toMatchObject({ path: '/data', generation: 7 })
    expect(rolledBackPointer({ main, backup: 'b' }, 7).backup).toBe('b')
    expect(JSON.parse(rolledBackPointer({ main }, 3).main ?? '')).toMatchObject({ generation: 5 })
    expect(rolledBackPointer({ backup: 'b' }, 7)).toEqual({ backup: 'b' })
    expect(rolledBackPointer({ main: '{ damaged' }, 7)).toEqual({ main: '{ damaged' })
  })

  posixOnly('keeps a copy older after a rollback even when the original loses its number', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await runToEnd(s, false)
    const [unused] = unusedCopies(s)
    const copyGeneration = readGeneration(join(s.f.targetParent, unused ?? ''))
    expect(copyGeneration).toBeGreaterThan(0)
    // The same data turns up at a path nothing recorded, still carrying its identity and number.
    const elsewhere = join(s.f.targetParent, 'Remounted')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, DATA_ID_FILENAME), `${HARNESS_ID}\n`)
    writeGeneration(elsewhere, copyGeneration)
    unlinkSync(join(s.f.home, GENERATION_FILENAME))
    const reference = dataReference(readPointer(s.setup.userData), s.setup.defaultHome)
    expect(reference?.generation).toBeGreaterThan(copyGeneration)
    expect(setAsideReason(elsewhere, { abandoned: [], reference })).toBe('older')
  })

  posixOnly('rolls back a move of ~/.dsh itself: the link to the target goes and the real directory comes back', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    bootOnTarget(s)
    expect(lstatSync(s.setup.defaultHome).isSymbolicLink()).toBe(true)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(lstatSync(s.setup.defaultHome).isDirectory()).toBe(true)
    expect(originalListing(s)).toEqual(s.before)
    expect(pointerText(s, 'data-location.json')).toBeUndefined()
    expect(pointerText(s, 'data-location.json.bak')).toBeUndefined()
    expect(terminalValue(s.setup)).toBe('')
  })

  posixOnly('replaces an empty folder the person picked', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    expect(await runToEnd(s, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
  })

  posixOnly('puts the empty folder the person picked back on rollback', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    const outcome = await runToEnd(s, false)
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(readdirSync(s.target)).toEqual([])
  })

  it('cancels while copying: the partial copy goes and nothing else changed', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const controller = new AbortController()
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), {
      pid: PID, cancel: controller.signal, onProgress: (progress) => { if (progress.stage === 'copying') controller.abort() },
    })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'cancelled' } })
    expect(originalListing(s)).toEqual(s.before)
    expect(readdirSync(s.f.targetParent)).toEqual([])
    expect(pointerText(s, 'data-location.json')).toBe(s.pointerBefore.main)
  })

  it('ignores a cancel once the copy has been put in place', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const controller = new AbortController()
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), {
      pid: PID, cancel: controller.signal, onProgress: (progress) => { if (progress.phase === 'finalizing') controller.abort() },
    })
    expect(outcome).toEqual({ kind: 'switched' })
  })

  it('gives up after repeated failed checks and deletes the copy', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    let checks = 0
    const effects: MoveEffects = {
      ...harnessEffects(s.setup),
      verify: async () => {
        checks += 1
        return [{ kind: 'content', rel: 'attachments/v1/objects/big.bin' }]
      },
    }
    const outcome = await advanceMove(s.setup.dir, effects, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'copy-mismatch' } } })
    expect(outcome.kind === 'ended' ? outcome.result.detail : undefined).toContain('big.bin')
    expect(checks).toBe(MAX_REPAIR_ROUNDS + 1)
    expect(originalListing(s)).toEqual(s.before)
    expect(readdirSync(s.f.targetParent)).toEqual([])
  })

  it('gives up before copying when the source lost its identity', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    writeFileSync(join(s.f.home, '.dsh-data-id'), '99999999-8888-4777-8666-555555555555\n')
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'source-changed' } } })
    expect(readdirSync(s.f.targetParent)).toEqual([])
  })

  posixOnly('keeps retrying the cleanup until the old copy is gone', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const real = harnessEffects(s.setup)
    const stubborn: MoveEffects = { ...real, remove: async () => ({ removed: 0, leftovers: [{ path: 'x', code: 'EBUSY', bytes: 35 }], leftoverBytes: 35 }) }
    await advanceMove(s.setup.dir, stubborn, { pid: PID })
    recordHealth(s.setup.dir, undefined)
    expect(await advanceMove(s.setup.dir, stubborn, { pid: PID })).toEqual({ kind: 'cleanup-incomplete', attempts: 1, leftoverBytes: 35 })
    expect(readJournal(s.setup.dir)).toMatchObject({ phase: 'cleanup', cleanupAttempts: 1, cleanupLeftoverBytes: 35 })
    expect(await advanceMove(s.setup.dir, stubborn, { pid: PID })).toEqual({ kind: 'cleanup-incomplete', attempts: 2, leftoverBytes: 35 })
    expect(await advanceMove(s.setup.dir, real, { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
  })

  it('stops instead of repeating a step that changes nothing', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const real = harnessEffects(s.setup)
    const effects: MoveEffects = { ...real, fs: { ...real.fs, writeFile: () => {} } }
    await expect(advanceMove(s.setup.dir, effects, { pid: PID })).rejects.toBeInstanceOf(MoveStuckError)
  })
})

describe('a directory a terminal made at the old path', () => {
  posixOnly('blocks the rollback of a move to another volume, keeping the original and the copy, until it is gone', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    expect(plantIntruder(s.f.home)).toBe(true)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'source-occupied', dataAt: [hidden, s.target], choices: ['keep-target'] })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    expect(readJournal(s.setup.dir)?.phase).toBe('rolling-back')
    expect(dataFiles(listTree(hidden))).toEqual(dataFiles(s.before))
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    expect(readFileSync(join(s.f.home, '.dsh-data-id'), 'utf8').trim()).toBe(INTRUDER_ID)
    expect(existsSync(join(s.f.home, MOVE_STATE_FILENAME))).toBe(false)
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(outcome))).toBe('refused')
    await rm(s.f.home, { recursive: true })
    // The obstruction is gone, but a blocked rollback waits for the person.
    const waiting = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(waiting).toMatchObject({ kind: 'blocked', reason: 'choice-needed', dataAt: [hidden, s.target], choices: ['keep-target', 'rollback'] })
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(waiting))).toBe('applied')
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(waiting))).toBe('not-blocked')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(originalListing(s)).toEqual(s.before)
    expect(unusedCopies(s)).toHaveLength(1)
  })

  posixOnly('keeps the new location when the person chooses it, and deletes the original once it is healthy', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('not-blocked')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(true)
    recordHealth(s.setup.dir, undefined)
    const moved = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(moved).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    // The rollback's cause stays in the log's detail; the result names no failure, since the kept location passed.
    expect(moved.kind === 'ended' ? moved.result.failure : 'not ended').toBeUndefined()
    expect(existsSync(hidden)).toBe(false)
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
    expect(readFileSync(join(s.f.home, '.dsh-data-id'), 'utf8').trim()).toBe(INTRUDER_ID)
  })

  posixOnly('keeps the original in a visible folder, never a leftover, when the kept location fails its health check again', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const blocked = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(blocked))).toBe('applied')
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'sessions 1 < 2; newly quarantined: p', failures: ['fewer-sessions', 'plugin-quarantined'] })
    const removed: string[] = []
    const real = harnessEffects(s.setup)
    const recording: MoveEffects = { ...real, remove: async (path) => { removed.push(path); return real.remove(path) } }
    const outcome = await advanceMove(s.setup.dir, recording, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'moved', leftovers: [] } })
    const result = outcome.kind === 'ended' ? outcome.result : undefined
    expect(result?.failure).toEqual({ kind: 'fewer-sessions', also: ['plugin-quarantined'] })
    expect(readMoveResult(s.setup.dir)?.failure).toEqual({ kind: 'fewer-sessions', also: ['plugin-quarantined'] })
    const kept = result?.keptOriginal?.path ?? ''
    expect(kept).toBe(join(dirname(s.f.home), keptFolderName('en', 'original', new Date(), 1)))
    expect(readMoveResult(s.setup.dir)?.keptOriginal).toEqual({ path: kept })
    expect(removed).toEqual([])
    expect(existsSync(hidden)).toBe(false)
    expect(dataFiles(listTree(kept))).toEqual(dataFiles(s.before))
    expect(existsSync(join(kept, RETIRED_FILENAME))).toBe(true)
    // Removing everything the result lists as left over, as a later "Try Again" does, never reaches the kept original.
    for (const left of result?.leftovers ?? []) await real.remove(left.path)
    expect(result?.leftovers.some(left => kept.startsWith(left.path) || left.path.startsWith(kept))).toBe(false)
    expect(dataFiles(listTree(kept))).toEqual(dataFiles(s.before))
  })

  posixOnly('tells the person about work written at the new location after the rollback began, and keeps it', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    mkdirSync(join(s.target, 'sessions', 'new'), { recursive: true })
    writeFileSync(join(s.target, 'sessions', 'new', 'log'), 'NEW WORK\n')
    await rm(s.f.home, { recursive: true })
    // With the old path free again, the page says the new location changed.
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'target-changed', choices: ['keep-target', 'rollback'] })
    expect(resolveBlocked(s.setup.dir, 'rollback', { ...seenOf(outcome), reason: 'choice-needed' })).toBe('refused')
    expect(readFileSync(join(s.target, 'sessions', 'new', 'log'), 'utf8')).toBe('NEW WORK\n')
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    // Keeping the new location takes the work with it; the original is hidden again first.
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(existsSync(s.f.home)).toBe(false)
    recordHealth(s.setup.dir, undefined)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readFileSync(join(s.target, 'sessions', 'new', 'log'), 'utf8')).toBe('NEW WORK\n')
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
  })

  posixOnly('never deletes the new location on the way back: work written anywhere in it stays in the unused copy', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    // Written by a terminal DSH while the move was switched, before the check failed.
    mkdirSync(join(s.target, 'skills', 'mine'), { recursive: true })
    writeFileSync(join(s.target, 'skills', 'mine', 'SKILL.md'), 'hand written\n')
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    const unused = outcome.kind === 'ended' ? outcome.result.unusedCopy?.path ?? '' : ''
    expect(readFileSync(join(unused, 'skills', 'mine', 'SKILL.md'), 'utf8')).toBe('hand written\n')
  })

  posixOnly('keeps what a failing step recorded: a terminal written before the failure is restored, and the copy is retired', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const real = harnessEffects(s.setup)
    const failing: MoveEffects = {
      ...real,
      syncTerminal: async (target) => {
        await real.syncTerminal(target)
        throw new Error('injected: the read-back failed')
      },
    }
    const outcome = await advanceMove(s.setup.dir, failing, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: 'injected: the read-back failed', failure: { kind: 'other' } } })
    expect(terminalValue(s.setup)).toBe(s.f.home)
    expect(originalListing(s)).toEqual(s.before)
    expect(outcome.kind === 'ended' ? outcome.result.unusedCopy : undefined).toBeDefined()
  })

  posixOnly.each([
    { start: 'pointer', sameVolume: false },
    { start: 'pointer', sameVolume: true },
    { start: 'default-home', sameVolume: false },
    { start: 'default-home', sameVolume: true },
  ] as const)('finishes a rollback whose terminal setting cannot be put back, and keeps the next launch that inherits it on the original (start $start, same volume $sameVolume)', async ({ start, sameVolume }) => {
    const s = await scenario({ sameVolume, start })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(terminalValue(s.setup)).toBe(s.target)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const stuck: MoveEffects = {
      ...harnessEffects(s.setup),
      restoreTerminal: async () => { throw new Error('PowerShell exited with 1 restoring DSH_HOME') },
    }
    const outcome = await advanceMove(s.setup.dir, stuck, { pid: PID })
    expect(outcome).toMatchObject({
      kind: 'ended',
      result: { outcome: 'failed', detail: 'the health check failed', failure: { kind: 'fewer-sessions' }, terminalNotRestored: { path: s.target } },
    })
    expect(readMoveResult(s.setup.dir)).toMatchObject({ failure: { kind: 'fewer-sessions' }, terminalNotRestored: { path: s.target } })
    expect(readJournal(s.setup.dir)).toBeUndefined()
    expect(terminalValue(s.setup)).toBe(s.target)
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    const read = readPointer(s.setup.userData)
    expect(read).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, dataId: HARNESS_ID, lastSeenEnv: s.target } })
    if (start === 'pointer') {
      const restored = rolledBackPointer(s.pointerBefore, readGeneration(s.f.home)).main ?? ''
      expect(read.kind === 'ok' ? read.pointer : undefined).toEqual({ ...JSON.parse(restored), lastSeenEnv: s.target })
    }
    // The next launch inherits the setting the rollback could not put back, as Windows' user variable is inherited.
    const next = resolveDataLocation({
      read,
      env: processDshHome({ DSH_HOME: terminalValue(s.setup) }),
      defaultHome: s.setup.defaultHome,
      abandoned: readAbandonedCopies(s.setup.dir),
    })
    expect(next).toEqual({ kind: 'ready', home: s.f.home, via: 'pointer' })
  })

  posixOnly.each([
    { start: 'pointer', x: 'other-harness-data' },
    { start: 'pointer', x: 'missing' },
    { start: 'default-home', x: 'other-harness-data' },
    { start: 'default-home', x: 'missing' },
  ] as const)('leaves a terminal the person\'s own DSH_HOME overrides as it was before the move when the restore fails (start $start, that folder $x)', async ({ start, x }) => {
    const f = await buildFixture({ bigBytes: 200_000 })
    fixtures.push(f)
    const target = join(f.targetParent, 'DSH-Data')
    const prepared = prepareMove({ root: f.root, home: f.home, target, sameVolume: false, start })
    const own = join(f.root, 'my-terminal-home')
    if (x === 'other-harness-data') {
      mkdirSync(join(own, 'sessions'), { recursive: true })
      writeFileSync(join(own, '.dsh-data-id'), `${INTRUDER_ID}\n`)
    }
    if (start === 'pointer') {
      writeFileSync(join(prepared.userData, 'data-location.json'), `${JSON.stringify({ version: 1, path: f.home, dataId: HARNESS_ID, lastSeenEnv: own }, null, 2)}\n`)
    }
    writeFileSync(prepared.terminalFile, own)
    const setup: MoveSetup = {
      ...prepared,
      start: {
        ...prepared.start,
        pointerBefore: readPointerFiles(prepared.userData),
        ...start === 'pointer' ? { lastSeenEnvBefore: own } : {},
        terminalBefore: { kind: 'set', value: own, source: 'login-shell' },
      },
    }
    const launch = (): Resolution => resolveDataLocation({
      read: readPointer(setup.userData), env: own, defaultHome: setup.defaultHome, abandoned: readAbandonedCopies(setup.dir),
    })
    const beforeMove = launch()
    startMove(setup.dir, setup.start, { pid: PID, now: new Date() })
    // The block is written, but a line of the person's own later in the profile keeps their value.
    const overridden: MoveEffects = { ...harnessEffects(setup), syncTerminal: async () => own }
    expect(await advanceMove(setup.dir, overridden, { pid: PID })).toEqual({ kind: 'switched' })
    expect(readPointer(setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: target, lastSeenEnv: own } })
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const stuck: MoveEffects = { ...overridden, restoreTerminal: async () => { throw new Error('EACCES: permission denied, open \'.zshrc\'') } }
    expect(await advanceMove(setup.dir, stuck, { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed', terminalNotRestored: { path: target } } })
    expect(terminalValue(setup)).toBe(own)
    if (start === 'pointer') {
      const restored = rolledBackPointer(setup.start.pointerBefore, readGeneration(f.home)).main ?? ''
      expect(readFileSync(join(setup.userData, 'data-location.json'), 'utf8')).toBe(restored)
    } else {
      expect(readPointer(setup.userData)).toEqual({ kind: 'absent' })
    }
    expect(launch()).toEqual(beforeMove)
    expect(launch()).not.toMatchObject({ via: 'followed-env' })
    expect(launch()).not.toMatchObject({ kind: 'confirm-env' })
  })

  posixOnly.each([
    { start: 'pointer', sameVolume: false },
    { start: 'pointer', sameVolume: true },
    { start: 'default-home', sameVolume: false },
    { start: 'default-home', sameVolume: true },
  ] as const)('keeps the pointer as it was before the move when the restore wrote the old setting and then failed (start $start, same volume $sameVolume)', async ({ start, sameVolume }) => {
    const s = await scenario({ sameVolume, start })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const real = harnessEffects(s.setup)
    const late: MoveEffects = {
      ...real,
      restoreTerminal: async (snapshot) => {
        await real.restoreTerminal(snapshot)
        throw new Error('EPERM: operation not permitted, chmod \'.zshrc\'')
      },
    }
    const outcome = await advanceMove(s.setup.dir, late, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', terminalNotRestored: { path: s.target } } })
    const before = s.setup.start.terminalBefore
    expect(terminalValue(s.setup)).toBe(before.kind === 'set' ? before.value : '')
    if (start === 'pointer') {
      expect(pointerText(s, 'data-location.json')).toBe(rolledBackPointer(s.pointerBefore, readGeneration(s.f.home)).main)
      expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, lastSeenEnv: s.f.home } })
    } else {
      expect(readPointer(s.setup.userData)).toEqual({ kind: 'absent' })
    }
    const next = resolveDataLocation({
      read: readPointer(s.setup.userData),
      env: processDshHome({ DSH_HOME: terminalValue(s.setup) }),
      defaultHome: s.setup.defaultHome,
      abandoned: readAbandonedCopies(s.setup.dir),
    })
    expect(next).toEqual({ kind: 'ready', home: s.f.home, via: start === 'pointer' ? 'pointer' : 'default' })
  })

  posixOnly('takes a terminal setting it cannot read after a failed restore to name the new location', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const blind: MoveEffects = {
      ...harnessEffects(s.setup),
      restoreTerminal: async () => { throw new Error('PowerShell exited with 1 restoring DSH_HOME') },
      terminalSeen: async () => { throw new Error('PowerShell exited with 1 reading DSH_HOME') },
    }
    await advanceMove(s.setup.dir, blind, { pid: PID })
    expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, lastSeenEnv: s.target } })
  })

  posixOnly('records a failed restore once, so a rollback resumed after it does not try again', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    let restores = 0
    const stop = new Error('stop after the restore')
    const failing: MoveEffects = {
      ...harnessEffects(s.setup),
      restoreTerminal: async () => {
        restores += 1
        throw new Error('PowerShell exited with 1 restoring DSH_HOME')
      },
    }
    // Stop the rollback right after the failed restore is recorded, before it finishes.
    await expect(advanceMove(s.setup.dir, failing, {
      pid: PID, guard: async (journal) => { if (journal.terminalRestoreFailed !== undefined) throw stop },
    })).rejects.toBe(stop)
    expect(readJournal(s.setup.dir)).toMatchObject({ terminalWritten: false, terminalRestoreFailed: 'PowerShell exited with 1 restoring DSH_HOME' })
    expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home } })
    expect(readPointer(s.setup.userData)).not.toMatchObject({ pointer: { lastSeenEnv: s.target } })
    const outcome = await advanceMove(s.setup.dir, failing, { pid: PID })
    expect(restores).toBe(1)
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', terminalNotRestored: { path: s.target } } })
    expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, lastSeenEnv: s.target } })
  })

  posixOnly.each([
    { start: 'pointer', sameVolume: false },
    { start: 'pointer', sameVolume: true },
    { start: 'default-home', sameVolume: false },
    { start: 'default-home', sameVolume: true },
  ] as const)('puts the pointer back as the rollback left it when a step resumed after its pointer write reads the setting from before the move (start $start, same volume $sameVolume)', async ({ start, sameVolume }) => {
    const s = await scenario({ sameVolume, start })
    await stopAfterRecordedPointer(s)
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', terminalNotRestored: { path: s.target } } })
    expect(readPointerFiles(s.setup.userData)).toEqual(rolledBackPointer(s.pointerBefore, readGeneration(s.f.home)))
    const next = resolveDataLocation({
      read: readPointer(s.setup.userData),
      env: processDshHome({ DSH_HOME: terminalValue(s.setup) }),
      defaultHome: s.setup.defaultHome,
      abandoned: readAbandonedCopies(s.setup.dir),
    })
    expect(next).toEqual({ kind: 'ready', home: s.f.home, via: start === 'pointer' ? 'pointer' : 'default' })
  })

  posixOnly('writes the pointer over the rolled-back files when a step resumed after its pointer write reads another value', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await stopAfterRecordedPointer(s)
    const elsewhere = join(s.f.root, 'my-terminal-home')
    await advanceMove(s.setup.dir, { ...harnessEffects(s.setup), terminalSeen: async () => elsewhere }, { pid: PID })
    const rolledBack = rolledBackPointer(s.pointerBefore, readGeneration(s.f.home))
    expect(readPointer(s.setup.userData)).toMatchObject({ kind: 'ok', pointer: { path: s.f.home, lastSeenEnv: elsewhere } })
    expect(pointerText(s, 'data-location.json.bak')).toBe(rolledBack.main)
  })

  it('names the original without a pointer before the move, and leaves a main file that was not a valid pointer as it was', () => {
    const journal = { pointerBefore: {}, originalGeneration: 2, source: '/data/original', target: '/data/new', dataId: HARNESS_ID }
    expect(pointerSeeingTerminal({ ...journal, pointerBefore: { main: '{ torn' } }, '/data/new')).toBeUndefined()
    expect(pointerSeeingTerminal(journal, '/data/new')).toEqual({
      version: 1, path: '/data/original', dataId: HARNESS_ID, generation: 2, lastSeenEnv: '/data/new',
    })
  })

  posixOnly('leaves the retired copy where it is when it cannot be renamed, and still goes back', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const real = harnessEffects(s.setup)
    const held: MoveEffects = {
      ...real,
      fs: {
        ...real.fs,
        rename: (from, to) => {
          if (from === s.target) throw Object.assign(new Error('injected: busy'), { code: 'EBUSY' })
          real.fs.rename(from, to)
        },
      },
    }
    const outcome = await advanceMove(s.setup.dir, held, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', unusedCopy: { path: s.target } } })
    expect(originalListing(s)).toEqual(s.before)
    expect(pointerText(s, 'data-location.json')).toBe(rolledBackPointer(s.pointerBefore, readGeneration(s.f.home)).main)
    expect(terminalValue(s.setup)).toBe(s.f.home)
    expect(existsSync(join(s.target, RETIRED_FILENAME))).toBe(true)
    expect(existsSync(join(s.target, '.dsh-data-id'))).toBe(false)
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
  })

  posixOnly('treats the target as exposed from the pointer write: a failure there retires the copy instead of deleting it', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const real = harnessEffects(s.setup)
    const journals: Array<boolean | undefined> = []
    const failing: MoveEffects = {
      ...real,
      writePointer: () => {
        journals.push(readJournal(s.setup.dir)?.targetExposed)
        throw new Error('injected: cannot write the pointer')
      },
    }
    const outcome = await advanceMove(s.setup.dir, failing, { pid: PID })
    expect(journals).toEqual([true])
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: 'injected: cannot write the pointer' } })
    expect(outcome.kind === 'ended' ? outcome.result.unusedCopy : undefined).toBeDefined()
    expect(originalListing(s)).toEqual(s.before)
    expect(terminalValue(s.setup)).toBe(s.f.home)
  })

  posixOnly('refuses a choice made on a page whose print is out of date, and applies one made on a fresh page', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    await rm(s.f.home, { recursive: true })
    writeFileSync(join(s.target, 'AGENTS.md'), 'first edit\n')
    const shown = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(shown).toMatchObject({ kind: 'blocked', reason: 'target-changed' })
    // More work arrives after the page was drawn: same reason, different print.
    writeFileSync(join(s.target, 'late.txt'), 'never shown\n')
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(shown))).toBe('refused')
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(shown))).toBe('refused')
    expect(readJournal(s.setup.dir)?.awaitingChoice).toBe(true)
    const fresh = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(seenOf(fresh).targetPrint).not.toBe(seenOf(shown).targetPrint)
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(fresh))).toBe('applied')
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const unused = ended.kind === 'ended' ? ended.result.unusedCopy?.path ?? '' : ''
    expect(readFileSync(join(unused, 'late.txt'), 'utf8')).toBe('never shown\n')
    expect(readFileSync(join(unused, 'AGENTS.md'), 'utf8')).toBe('first edit\n')
  })

  posixOnly('counts a missing print as a change', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    await rm(s.f.home, { recursive: true })
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'blocked', reason: 'choice-needed' })
    const journal = readJournal(s.setup.dir)
    expect(journal?.targetFingerprint).toBeDefined()
    const { targetFingerprint: _dropped, ...withoutPrint } = journal ?? ({} as MoveJournal)
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), JSON.stringify(withoutPrint))
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'blocked', reason: 'target-changed' })
  })

  posixOnly('lets the person roll back without a copy whose disk is away', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const away = join(s.f.root, 'unplugged')
    renameSync(s.target, away)
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'target-missing', choices: ['rollback'], targetPrint: null })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('refused')
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(outcome))).toBe('applied')
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    // The rollback the person chose went on from the failed check, whose cause it keeps.
    expect(ended).toMatchObject({ kind: 'ended', result: { outcome: 'failed', abandonedCopy: { path: s.target }, failure: { kind: 'fewer-sessions' } } })
    expect(ended.kind === 'ended' ? ended.result.unusedCopy : 'x').toBeUndefined()
    expect(originalListing(s)).toEqual(s.before)
    const moveId = readMoveResult(s.setup.dir)?.moveId
    expect(readAbandonedCopies(s.setup.dir)).toMatchObject([{ path: s.target, dataId: HARNESS_ID, moveId }])
    // The drive comes back: the copy still carries the identity, and A7 refuses it by its recorded path.
    renameSync(away, s.target)
    const samePath = (a: string, b: string): boolean => a === b
    expect(isAbandonedCopy(readAbandonedCopies(s.setup.dir), s.target, HARNESS_ID, samePath)).toBe(true)
    expect(isAbandonedCopy(readAbandonedCopies(s.setup.dir), s.f.home, HARNESS_ID, samePath)).toBe(false)
    // Retiring it: the identity goes, the marker comes, and it is renamed beside itself.
    const retired = await retireAbandonedCopies(s.setup.dir, s.f.home, harnessEffects(s.setup), samePath)
    expect(retired).toEqual([join(s.f.targetParent, unusedCopies(s)[0] ?? '')])
    expect(existsSync(s.target)).toBe(false)
    expect(existsSync(join(retired[0] ?? '', '.dsh-data-id'))).toBe(false)
    expect(existsSync(join(retired[0] ?? '', RETIRED_FILENAME))).toBe(true)
    expect(dataFiles(listTree(retired[0] ?? ''))).toEqual(dataFiles(s.before))
    expect(readAbandonedCopies(s.setup.dir)).toEqual([])
    expect(await retireAbandonedCopies(s.setup.dir, s.f.home, harnessEffects(s.setup), samePath)).toEqual([])
  })

  posixOnly('blocks a rollback whose exposed copy vanished after the original was back, until the person chooses', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const away = join(s.f.root, 'unplugged')
    const real = harnessEffects(s.setup)
    // The drive goes away right after the original is back at its path.
    const effects: MoveEffects = {
      ...real,
      fs: {
        ...real.fs,
        unlink: (path) => {
          real.fs.unlink(path)
          if (path === join(s.f.home, MOVE_STATE_FILENAME)) renameSync(s.target, away)
        },
      },
    }
    const outcome = await advanceMove(s.setup.dir, effects, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'target-missing', choices: ['rollback'] })
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(join(away, RETIRED_FILENAME))).toBe(true)
    expect(existsSync(join(away, '.dsh-data-id'))).toBe(false)
  })

  posixOnly('offers to keep the new location when the original is gone', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    renameSync(hidden, join(s.f.root, 'lost'))
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'original-missing', dataAt: [s.target], choices: ['keep-target'] })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, undefined)
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(ended).toMatchObject({ kind: 'ended', result: { outcome: 'moved', abandonedOriginal: { path: s.f.home } } })
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
    const moveId = readMoveResult(s.setup.dir)?.moveId
    expect(readAbandonedCopies(s.setup.dir)).toMatchObject([{ path: s.f.home, moveId }, { path: hidden, moveId }])
    // The drive with the original comes back: it is retired as an unused copy, never taken for the data.
    renameSync(join(s.f.root, 'lost'), hidden)
    const samePath = (a: string, b: string): boolean => a === b
    expect(isAbandonedCopy(readAbandonedCopies(s.setup.dir), hidden, HARNESS_ID, samePath)).toBe(true)
    const retired = await retireAbandonedCopies(s.setup.dir, s.target, harnessEffects(s.setup), samePath)
    expect(retired).toHaveLength(1)
    expect(existsSync(hidden)).toBe(false)
    expect(existsSync(join(retired[0] ?? '', RETIRED_FILENAME))).toBe(true)
    expect(dataFiles(listTree(retired[0] ?? ''))).toEqual(dataFiles(s.before))
    expect(readAbandonedCopies(s.setup.dir)).toMatchObject([{ path: s.f.home }])
  })

  posixOnly('reports a missing original as abandoned, not kept, when the kept location fails again', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    renameSync(hidden, join(s.f.root, 'lost'))
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(ended).toMatchObject({ kind: 'ended', result: { outcome: 'moved', abandonedOriginal: { path: s.f.home } } })
    expect(ended.kind === 'ended' ? ended.result.keptOriginal : 'x').toBeUndefined()
  })

  posixOnly('records nothing as abandoned when the original comes back before the move ends', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    renameSync(hidden, join(s.f.root, 'lost'))
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(readJournal(s.setup.dir)?.originalAbandoned).toBe(true)
    renameSync(join(s.f.root, 'lost'), hidden)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(readJournal(s.setup.dir)?.originalAbandoned).toBe(false)
    recordHealth(s.setup.dir, undefined)
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(ended.kind === 'ended' ? ended.result.abandonedOriginal : 'x').toBeUndefined()
    expect(existsSync(hidden)).toBe(false)
    expect(readAbandonedCopies(s.setup.dir)).toEqual([])
  })

  posixOnly('never retires a link at a recorded path, nor the data in use', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await runToEnd(s, true)
    const moveId = readMoveResult(s.setup.dir)?.moveId ?? ''
    const linked = join(s.f.root, 'linked')
    symlinkSync(s.target, linked)
    writeFileSync(join(s.setup.dir, 'abandoned-copies.json'), abandonedCopiesText([
      { path: linked, dataId: HARNESS_ID, moveId: moveId as MoveId, abandonedAt: '' },
      { path: s.target, dataId: HARNESS_ID, moveId: moveId as MoveId, abandonedAt: '' },
    ]))
    const samePath = (a: string, b: string): boolean => a === b
    expect(await retireAbandonedCopies(s.setup.dir, s.target, harnessEffects(s.setup), samePath)).toEqual([])
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    expect(readAbandonedCopies(s.setup.dir)).toMatchObject([{ path: s.target }])
  })

  posixOnly('records paths by their real path, and forgets a record that names the new location in other letter case', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const linkedParent = join(s.f.root, 'linked-parent')
    symlinkSync(s.f.targetParent, linkedParent)
    expect(canonicalPath(join(linkedParent, 'not', 'there'))).toBe(join(realpathSync(s.f.targetParent), 'not', 'there'))
    expect(canonicalPath(`${s.f.targetParent}/`)).toBe(realpathSync(s.f.targetParent))
    if (process.platform !== 'darwin') return
    await rm(s.setup.dir, { recursive: true })
    mkdirSync(s.setup.dir, { recursive: true })
    writeFileSync(join(s.setup.dir, 'abandoned-copies.json'), abandonedCopiesText([
      { path: `${s.target.toUpperCase()}/`, dataId: HARNESS_ID, moveId: 'm0' as MoveId, abandonedAt: '' },
    ]))
    startMove(s.setup.dir, s.setup.start, { pid: PID, now: new Date() })
    expect(readAbandonedCopies(s.setup.dir)).toEqual([])
  })

  posixOnly('records an abandoned copy by its real path when the new location was named through a link', async () => {
    const f = await buildFixture({ bigBytes: 1000 })
    fixtures.push(f)
    const linkedParent = join(f.root, 'linked-parent')
    symlinkSync(f.targetParent, linkedParent)
    const target = join(linkedParent, 'DSH-Data')
    const setup = prepareMove({ root: f.root, home: f.home, target, sameVolume: false, start: 'pointer' })
    startMove(setup.dir, setup.start, { pid: PID, now: new Date() })
    await advanceMove(setup.dir, harnessEffects(setup), { pid: PID })
    recordHealth(setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    renameSync(join(f.targetParent, 'DSH-Data'), join(f.root, 'unplugged'))
    const blocked = await advanceMove(setup.dir, harnessEffects(setup), { pid: PID })
    expect(resolveBlocked(setup.dir, 'rollback', seenOf(blocked))).toBe('applied')
    await advanceMove(setup.dir, harnessEffects(setup), { pid: PID })
    expect(readAbandonedCopies(setup.dir).map(copy => copy.path)).toEqual([join(realpathSync(f.targetParent), 'DSH-Data')])
  })

  posixOnly('stops before the next step once another installation discarded the lock, hiding and deleting nothing', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const self = { userData: s.setup.userData, pid: PID, startedAt: '' }
    await acquireMoveLock(s.f.home, self, { startTimeOf: async () => undefined, now: () => new Date() })
    const real = harnessEffects(s.setup)
    // Discarded while the copy runs: the copy only writes the partial folder.
    const effects: MoveEffects = {
      ...real, copy: async (...args) => { await real.copy(...args); unlinkSync(join(s.f.home, LOCK_FILENAME)) },
    }
    const seen: string[][] = []
    const guard = async (journal: Parameters<typeof lockExpectedAt>[0], facts: Parameters<typeof lockExpectedAt>[1]): Promise<void> => {
      seen.push(lockExpectedAt(journal, facts))
      const check = await checkOwnLock(lockExpectedAt(journal, facts), self, { startTimeOf: async () => undefined })
      if (check.kind === 'lost') throw new MoveLockLostError(check.detail)
    }
    const before = listTree(s.f.home).filter(line => !line.includes(LOCK_FILENAME))
    await expect(advanceMove(s.setup.dir, effects, { pid: PID, guard })).rejects.toThrow(MoveLockLostError)
    expect(seen[0]).toEqual([])
    expect(seen.at(-1)).toEqual([s.f.home])
    const journal = readJournal(s.setup.dir)
    expect(journal?.phase).toBe('verifying')
    expect(listTree(s.f.home)).toEqual(before)
    expect(existsSync(journal?.hidden ?? '')).toBe(false)
    expect(existsSync(journal?.partial ?? '')).toBe(true)
    expect(existsSync(s.target)).toBe(false)
    // Once hiding began, the original can no longer be left as it was: no abandoning.
    const journalText = readFileSync(join(s.setup.dir, JOURNAL_FILENAME), 'utf8')
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'hiding-source' }))
    expect(() => { abandonMove(s.setup.dir, 'x') }).toThrow(JournalError)
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), journalText)
    // Before hiding began, nothing needs taking back: the move is abandoned instead.
    for (const phase of ['copying', 'verifying', 'catching-up', 'finalizing'] as const) {
      writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase }))
      expect(() => { rollBackMove(s.setup.dir, 'x') }).toThrow(JournalError)
    }
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), journalText)
    // Abandoned: the partial copy goes, unguarded, and nothing else changes.
    abandonMove(s.setup.dir, 'the move lock was lost')
    const ended = await advanceMove(s.setup.dir, effects, { pid: PID, guard })
    expect(ended).toMatchObject({ kind: 'ended', result: { outcome: 'failed', source: s.f.home, failure: { kind: 'lock-lost' } } })
    expect(readJournal(s.setup.dir)).toBeUndefined()
    expect(existsSync(journal?.partial ?? '')).toBe(false)
    expect(listTree(s.f.home)).toEqual(before)
    expect(pointerText(s, 'data-location.json')).toBe(s.pointerBefore.main)
    expect(() => { abandonMove(s.setup.dir, 'x') }).toThrow(JournalError)
  })

  posixOnly('never copies, prints, or checks the lock\'s temporary files or the AppleDouble companions of the markers', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const leftovers = [
      `._${LOCK_FILENAME}`, '._.dsh-data-id', `${LOCK_FILENAME}.4242.tmp`, `${LOCK_FILENAME}.4242.0a1b2c3d.tmp`,
      `${LOCK_FILENAME}.claim-4242-0a1b2c3d`, `._${LOCK_FILENAME}.4242.tmp`,
    ]
    for (const name of leftovers) writeFileSync(join(s.f.home, name), 'left over')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(readdirSync(s.target).filter(name => name.startsWith('._') || name.startsWith(LOCK_FILENAME))).toEqual([])
    const fs = nodeMoveFs(() => undefined)
    const before = fs.fingerprint(s.target, PRINT_EXCLUDE)
    for (const name of [`._${GENERATION_FILENAME}`, `${LOCK_FILENAME}.9.tmp`]) writeFileSync(join(s.target, name), 'left over')
    expect(fs.fingerprint(s.target, PRINT_EXCLUDE)).toBe(before)
  })

  it('never copies or prints the generation file: the copy gets its own number', () => {
    expect(MOVE_MARKERS).toContain(GENERATION_FILENAME)
    expect(PRINT_EXCLUDE).toContain(GENERATION_FILENAME)
  })

  posixOnly('forgets a record naming the new location of a later move', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await rm(s.setup.dir, { recursive: true })
    mkdirSync(s.setup.dir, { recursive: true })
    const other = { path: '/elsewhere', dataId: HARNESS_ID, moveId: 'm1' as MoveId, abandonedAt: '' }
    writeFileSync(join(s.setup.dir, 'abandoned-copies.json'), abandonedCopiesText([
      { path: s.target, dataId: HARNESS_ID, moveId: 'm0' as MoveId, abandonedAt: '' }, other,
    ]))
    startMove(s.setup.dir, s.setup.start, { pid: PID, now: new Date() })
    expect(readAbandonedCopies(s.setup.dir)).toEqual([other])
  })

  posixOnly('blocks the rollback of a rename, leaving the data at the target the pointer names', async () => {
    const s = await scenario({ sameVolume: true, start: 'default-home' })
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(plantIntruder(s.f.home)).toBe(true)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'source-occupied', dataAt: [s.target], choices: ['keep-target'] })
    expect(JSON.parse(pointerText(s, 'data-location.json') ?? '{}')).toMatchObject({ path: s.target })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(outcome))).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, undefined)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
  })

  posixOnly('is ignored once the original is hidden: the move finishes on the target', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    const real = harnessEffects(s.setup)
    let planted = false
    const effects: MoveEffects = {
      ...real,
      fs: {
        ...real.fs,
        rename: (from, to) => {
          real.fs.rename(from, to)
          if (from === s.f.home) planted = plantIntruder(s.f.home)
        },
      },
    }
    expect(await runToEnd(s, true, effects)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(planted).toBe(true)
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
    expect(readFileSync(join(s.f.home, '.dsh-data-id'), 'utf8').trim()).toBe(INTRUDER_ID)
    expect(existsSync(join(s.f.home, MOVE_STATE_FILENAME))).toBe(false)
  })
})

describe('generations: a left-behind copy is older wherever it is mounted', () => {
  /**
   * Where the launch step would go now for a `DSH_HOME` naming `env`, with no abandoned record.
   * @param s - the scenario.
   * @param env - the changed `DSH_HOME`.
   * @returns the decision.
   */
  function resolveWith(s: Scenario, env: string): Resolution {
    return resolveDataLocation({ read: readPointer(s.setup.userData), env, defaultHome: s.setup.defaultHome, abandoned: [] })
  }

  for (const start of ['pointer', 'default-home'] as const) {
    posixOnly(`sets aside a copy a rollback went without, remounted at another path (${start})`, async () => {
      const s = await scenario({ sameVolume: false, start })
      await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
      recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
      const away = join(s.f.root, 'unplugged')
      renameSync(s.target, away)
      const blocked = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
      expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(blocked))).toBe('applied')
      expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
      // The drive comes back under another name ("/Volumes/X 1"), so the record's path no longer matches it.
      const remounted = join(s.f.root, 'remounted 1')
      renameSync(away, remounted)
      expect(readGeneration(s.f.home)).toBeGreaterThan(readGeneration(remounted))
      expect(readDataId(remounted)).toEqual({ kind: 'ok', id: HARNESS_ID })
      const pointer = start === 'pointer' ? readPointer(s.setup.userData) : undefined
      if (pointer?.kind === 'ok') {
        expect(resolveWith(s, remounted)).toMatchObject({ kind: 'confirm-env', reason: 'older' })
      } else {
        // Without a pointer the default home is the reference.
        expect(resolveDataLocation({ read: { kind: 'absent' }, env: remounted, defaultHome: s.setup.defaultHome, abandoned: [] }))
          .toMatchObject({ kind: 'unavailable', reason: 'older', escapable: true })
        expect(resolveDataLocation({ read: { kind: 'absent' }, env: undefined, defaultHome: s.setup.defaultHome, abandoned: [] }))
          .toMatchObject({ kind: 'ready', home: s.setup.defaultHome })
      }
    })
  }

  posixOnly('sets aside an original the person moved on without, when it comes back at another path', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    renameSync(hidden, join(s.f.root, 'lost'))
    const blocked = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', seenOf(blocked))).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, undefined)
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const pointer = readPointer(s.setup.userData)
    expect(pointer.kind === 'ok' ? pointer.pointer.generation : undefined).toBe(readGeneration(s.target))
    // The original, with its retired identity given back by hand, mounted somewhere else.
    const back = join(s.f.root, 'original again')
    renameSync(join(s.f.root, 'lost'), back)
    renameSync(join(back, '.dsh-data-id.moved'), join(back, '.dsh-data-id'))
    unlinkSync(join(back, MOVE_STATE_FILENAME))
    expect(resolveWith(s, back)).toMatchObject({ kind: 'confirm-env', reason: 'older' })
  })

  posixOnly('gives the copy a number above the original on every switch, and the original one above the copy on every rollback', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    writeGeneration(s.f.home, 7)
    await rm(s.setup.dir, { recursive: true })
    startMove(s.setup.dir, { ...s.setup.start, originalGeneration: 7 }, { pid: PID, now: new Date() })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(readGeneration(s.target)).toBe(8)
    const pointer = readPointer(s.setup.userData)
    expect(pointer.kind === 'ok' ? pointer.pointer.generation : undefined).toBe(8)
    recordHealth(s.setup.dir, { detail: 'the health check failed', failures: ['fewer-sessions'] })
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(readGeneration(s.f.home)).toBe(9)
    expect(readGeneration(ended.kind === 'ended' ? ended.result.unusedCopy?.path ?? '' : '')).toBe(8)
  })
})

describe('a picked empty folder', () => {
  it('still counts as empty with a file browser\'s files in it, which go with it', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    writeFileSync(join(s.target, '.DS_Store'), 'finder')
    writeFileSync(join(s.target, 'Thumbs.db'), 'explorer')
    expect(await runToEnd(s, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(existsSync(join(s.target, '.DS_Store'))).toBe(false)
    expect(existsSync(join(s.target, 'Thumbs.db'))).toBe(false)
  })

  it('is not taken over when it holds anything else', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    writeFileSync(join(s.target, 'notes.txt'), 'mine')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(readFileSync(join(s.target, 'notes.txt'), 'utf8')).toBe('mine')
  })
})

describe('nodeMoveFs', () => {
  it('flushes the directory of an unlinked file before returning', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const flushed: string[] = []
    const fs = nodeMoveFs((dir) => { flushed.push(dir) })
    writeFileSync(join(s.f.targetParent, 'gone.txt'), 'x')
    fs.unlink(join(s.f.targetParent, 'gone.txt'))
    expect(flushed).toEqual([s.f.targetParent])
  })

  it('flushes the directories on both sides of a rename before returning', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const flushed: string[] = []
    const fs = nodeMoveFs((dir) => { flushed.push(dir) })
    const from = join(s.f.root, 'a.txt')
    writeFileSync(from, 'x')
    fs.rename(from, join(s.f.targetParent, 'b.txt'))
    expect(flushed).toEqual([s.f.targetParent, s.f.root])
    fs.rename(join(s.f.targetParent, 'b.txt'), join(s.f.targetParent, 'c.txt'))
    expect(flushed.slice(2)).toEqual([s.f.targetParent])
  })
})

describe('a move by rename on one volume', () => {
  posixOnly('renames the home and rewrites its links in place', async () => {
    const s = await scenario({ sameVolume: true, start: 'pointer' })
    expect(await runToEnd(s, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(existsSync(s.f.home)).toBe(false)
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    const nm = join(s.target, 'profiles', 'desktop-shell', 'node_modules')
    expect(readlinkSync(join(nm, 'clsx'))).toBe(join(s.target, 'profiles', 'desktop-shell', '.dsh-module-fallback', 'node_modules', 'clsx'))
    expect(readlinkSync(join(nm, 'clsx-relative'))).toBe('../.dsh-module-fallback/node_modules/clsx')
    expect(readlinkSync(join(nm, 'outside'))).toBe(s.f.sentinel)
    expect(listTree(s.target).filter(line => line.startsWith('file '))).toEqual(s.before.filter(line => line.startsWith('file ')))
  })

  posixOnly('renames ~/.dsh itself and leaves a link to the target at the old name', async () => {
    const s = await scenario({ sameVolume: true, start: 'default-home' })
    expect(await runToEnd(s, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readlinkSync(s.setup.defaultHome)).toBe(s.target)
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    expect(terminalValue(s.setup)).toBe(s.target)
  })

  posixOnly('rolls back a rename with its link rewrites', async () => {
    const s = await scenario({ sameVolume: true, start: 'pointer' })
    expect(await runToEnd(s, false)).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'fewer-sessions' } } })
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    expect(pointerText(s, 'data-location.json')).toBe(s.pointerBefore.main)
  })
})

describe('why a move failed', () => {
  for (const [code, kind] of [['ENOSPC', 'no-space'], ['EACCES', 'no-permission']] as const) {
    it(`names a copy that stopped on ${code} as ${kind}, and gives the move up`, async () => {
      const s = await scenario({ sameVolume: false, start: 'pointer' })
      const effects: MoveEffects = {
        ...harnessEffects(s.setup),
        copy: async () => { throw Object.assign(new Error(`injected: ${code}`), { code }) },
      }
      const outcome = await advanceMove(s.setup.dir, effects, { pid: PID })
      expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: `injected: ${code}`, failure: { kind } } })
      expect(readMoveResult(s.setup.dir)?.failure).toEqual({ kind })
      expect(originalListing(s)).toEqual(s.before)
    })
  }

  it('names something already at the new location', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    mkdirSync(s.target)
    writeFileSync(join(s.target, 'notes.txt'), 'not the data\n')
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'target-occupied' } } })
    expect(readFileSync(join(s.target, 'notes.txt'), 'utf8')).toBe('not the data\n')
  })

  posixOnly('names a move taken back after it lost its lock', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    rollBackMove(s.setup.dir, 'the move lock was lost: gone')
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'lock-lost' } } })
    expect(originalListing(s)).toEqual(s.before)
  })

  posixOnly('names what blocked a move the person took back before anything failed', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    const real = harnessEffects(s.setup)
    const taken: MoveEffects = {
      ...real,
      fs: {
        ...real.fs,
        rename: (from, to) => {
          real.fs.rename(from, to)
          if (to !== hidden) return
          // Right after the original is hidden, a folder that is not the copy takes the new location's path.
          renameSync(s.target, join(s.f.root, 'copy-aside'))
          mkdirSync(s.target)
          writeFileSync(join(s.target, 'notes.txt'), 'not the data\n')
        },
      },
    }
    const blocked = await advanceMove(s.setup.dir, taken, { pid: PID })
    expect(blocked).toMatchObject({ kind: 'blocked', reason: 'target-occupied', choices: ['rollback'] })
    expect(readJournal(s.setup.dir)?.failure).toBeUndefined()
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(blocked))).toBe('applied')
    const outcome = await advanceMove(s.setup.dir, real, { pid: PID })
    expect(outcome).toMatchObject({
      kind: 'ended', result: { outcome: 'failed', detail: 'the person chose to go back (target-occupied)', failure: { kind: 'target-occupied' } },
    })
    expect(originalListing(s)).toEqual(s.before)
    expect(readFileSync(join(s.target, 'notes.txt'), 'utf8')).toBe('not the data\n')
  })

  posixOnly('names a refused change while hiding the original, and a full drive while switching, and rolls the move back', async () => {
    for (const [step, kind] of [['hiding', 'no-permission'], ['switching', 'no-space']] as const) {
      const s = await scenario({ sameVolume: false, start: 'pointer' })
      const hidden = readJournal(s.setup.dir)?.hidden ?? ''
      const real = harnessEffects(s.setup)
      let thrown = false
      const failing: MoveEffects = {
        ...real,
        fs: {
          ...real.fs,
          rename: (from, to) => {
            if (step === 'hiding' && to === hidden) throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
            real.fs.rename(from, to)
          },
        },
        writePointer: (pointer) => {
          if (step === 'switching' && !thrown) {
            thrown = true
            throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
          }
          real.writePointer(pointer)
        },
      }
      const outcome = await advanceMove(s.setup.dir, failing, { pid: PID })
      expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind } } })
      expect(readMoveResult(s.setup.dir)?.failure).toEqual({ kind })
      expect(originalListing(s)).toEqual(s.before)
    }
  })

  posixOnly('names a copy that went away once the original was hidden, and keeps that cause through the rollback the person chooses', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const away = join(s.f.root, 'unplugged')
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    const real = harnessEffects(s.setup)
    const unplugged: MoveEffects = {
      ...real,
      fs: {
        ...real.fs,
        rename: (from, to) => {
          real.fs.rename(from, to)
          // The new location's drive goes away right after the original is hidden.
          if (to === hidden) renameSync(s.target, away)
        },
      },
    }
    const outcome = await advanceMove(s.setup.dir, unplugged, { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'target-missing' })
    expect(readJournal(s.setup.dir)?.failure).toMatchObject({ phase: 'hiding-source', detail: 'the copy is gone', kind: 'copy-gone' })
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(outcome))).toBe('applied')
    const ended = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(ended).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: 'the copy is gone', failure: { kind: 'copy-gone' } } })
    expect(originalListing(s)).toEqual(s.before)
    expect(existsSync(away)).toBe(true)
  })

  posixOnly('names a copy that went away as what blocked a move the person kept, then took back before anything failed', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const stop = new Error('the original is hidden')
    await expect(advanceMove(s.setup.dir, harnessEffects(s.setup), {
      pid: PID,
      guard: (journal, facts) => { if (journal.phase === 'hiding-source' && facts.hidden.exists) throw stop },
    })).rejects.toBe(stop)
    // The person chose earlier to keep the new location; then its drive goes away.
    const journal = readJournal(s.setup.dir)
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, keepTarget: true }))
    renameSync(s.target, join(s.f.root, 'unplugged'))
    const blocked = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(blocked).toMatchObject({ kind: 'blocked', reason: 'target-missing', choices: ['rollback'] })
    expect(readJournal(s.setup.dir)?.failure).toBeUndefined()
    expect(resolveBlocked(s.setup.dir, 'rollback', seenOf(blocked))).toBe('applied')
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({
      kind: 'ended',
      result: { outcome: 'failed', detail: 'the person chose to go back (target-missing)', failure: { kind: 'copy-gone' }, abandonedCopy: { path: s.target } },
    })
    expect(originalListing(s)).toEqual(s.before)
  })

  it('names a failed move whose journal records no failure as other', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const journal = readJournal(s.setup.dir)
    // An older build's rollback the person chose recorded no failure.
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), JSON.stringify({ ...journal, phase: 'abandoning' }))
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind: 'other' } } })
    expect(outcome.kind === 'ended' ? outcome.result.detail : 'not ended').toBeUndefined()
  })

  it('names a cancelled move\'s result without a failure', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const controller = new AbortController()
    controller.abort()
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID, cancel: controller.signal })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'cancelled' } })
    expect(outcome.kind === 'ended' ? outcome.result.failure : 'not ended').toBeUndefined()
  })

  for (const [change, kind] of [['something is put at the new location', 'target-occupied'], ['the copy is removed', 'copy-gone']] as const) {
    posixOnly(`names the cause when ${change} after the move looked and before the copy is put in place`, async () => {
      const s = await scenario({ sameVolume: false, start: 'pointer' })
      const partial = readJournal(s.setup.dir)?.partial ?? ''
      const real = harnessEffects(s.setup)
      const raced: MoveEffects = {
        ...real,
        fs: {
          ...real.fs,
          rename: (from, to) => {
            if (from === partial && to === s.target) {
              if (kind === 'target-occupied') {
                mkdirSync(s.target)
                writeFileSync(join(s.target, 'notes.txt'), 'not the data\n')
              } else {
                renameSync(partial, join(s.f.root, 'copy-aside'))
              }
            }
            real.fs.rename(from, to)
          },
        },
      }
      const outcome = await advanceMove(s.setup.dir, raced, { pid: PID })
      expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', failure: { kind } } })
      expect(readMoveResult(s.setup.dir)?.failure).toEqual({ kind })
      expect(originalListing(s)).toEqual(s.before)
      if (kind === 'target-occupied') expect(readFileSync(join(s.target, 'notes.txt'), 'utf8')).toBe('not the data\n')
    })
  }

  it('classifies what a step threw', () => {
    expect(failureKindOf(new CopyMismatchError('a/b'))).toBe('copy-mismatch')
    for (const code of ['ENOSPC', 'EDQUOT']) expect(failureKindOf(Object.assign(new Error(code), { code }))).toBe('no-space')
    for (const code of ['EACCES', 'EPERM', 'EROFS']) expect(failureKindOf(Object.assign(new Error(code), { code }))).toBe('no-permission')
    expect(failureKindOf(Object.assign(new Error('busy'), { code: 'EBUSY' }))).toBe('other')
    expect(failureKindOf(new Error('no code'))).toBe('other')
    expect(failureKindOf('a string')).toBe('other')
    const named = new StepFailure('target-occupied', Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' }))
    expect(failureKindOf(named)).toBe('target-occupied')
    expect(named.message).toBe('ENOTEMPTY: directory not empty')
    expect(new StepFailure('copy-gone', 'gone').message).toBe('gone')
  })

  it('reads a result an older build wrote, without a failure, and leaves out a failure it cannot read', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const base = {
      version: 1, moveId: 'm', outcome: 'failed', source: s.f.home, target: s.target, detail: 'x', leftovers: [], finishedAt: '2026-10-03T00:00:00.000Z',
    }
    const read = (failure: unknown): unknown => {
      writeFileSync(join(s.setup.dir, RESULT_FILENAME), JSON.stringify(failure === undefined ? base : { ...base, failure }))
      return readMoveResult(s.setup.dir)
    }
    expect(read(undefined)).toEqual(base)
    expect(read({ kind: 'copy-gone' })).toEqual({ ...base, failure: { kind: 'copy-gone' } })
    expect(read({ kind: 'not-started', also: ['unreadable', 'gremlins'] })).toEqual({ ...base, failure: { kind: 'not-started', also: ['unreadable', 'other'] } })
    expect(read({ kind: 'gremlins' })).toEqual({ ...base, failure: { kind: 'other' } })
    expect(read({ kind: 3 })).toEqual(base)
    expect(read({ kind: 'copy-gone', also: 'unreadable' })).toEqual(base)
    expect(read('copy-gone')).toEqual(base)
    writeFileSync(join(s.setup.dir, RESULT_FILENAME), JSON.stringify({ ...base, terminalNotRestored: { path: s.target } }))
    expect(readMoveResult(s.setup.dir)).toEqual({ ...base, terminalNotRestored: { path: s.target } })
    writeFileSync(join(s.setup.dir, RESULT_FILENAME), JSON.stringify({ ...base, terminalNotRestored: s.target }))
    expect(readMoveResult(s.setup.dir)).toEqual(base)
  })
})

describe('the journal', () => {
  it('refuses a second move while one is recorded', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    expect(() => startMove(s.setup.dir, s.setup.start, { pid: PID, now: new Date() })).toThrow(JournalError)
  })

  it('reads back what it wrote and refuses a damaged file', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const journal = readJournal(s.setup.dir)
    expect(journal).toBeDefined()
    expect(validateJournal(JSON.parse(JSON.stringify(journal)))).toEqual(journal)
    const bad = (change: Record<string, unknown>): void => {
      expect(() => validateJournal({ ...journal, ...change })).toThrow(JournalError)
    }
    bad({ version: 2 })
    bad({ phase: 'teleporting' })
    bad({ source: 'relative/path' })
    bad({ dataId: 'not-a-uuid' })
    bad({ sourceAliases: [] })
    bad({ terminalBefore: { kind: 'set', value: '/x', source: 'nowhere' } })
    bad({ homeLinkBefore: { kind: 'link' } })
    bad({ terminalSnapshot: undefined })
    bad({ terminalSnapshot: { kind: 'profile', file: '/p', content: 7, hadBlock: false } })
    bad({ linkRewrites: [{ rel: 'a' }] })
    bad({ pointerWritten: 'yes' })
    bad({ terminalRestoreFailed: 7 })
    bad({ terminalRecordedAsSeen: 'yes' })
    bad({ failure: { phase: 'nope', detail: 'x' } })
    bad({ failure: { phase: 'copying', detail: 'x', kind: 7 } })
    bad({ failure: { phase: 'copying', detail: 'x', kind: 'no-space', also: 'fewer-sessions' } })
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), '{ torn')
    expect(() => readJournal(s.setup.dir)).toThrow(JournalError)
  })

  it('reads a failure an older build recorded without a kind, or with a kind this build does not know, as other', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const journal = readJournal(s.setup.dir)
    expect(validateJournal({ ...journal, failure: { phase: 'copying', detail: 'x' } }).failure)
      .toEqual({ phase: 'copying', detail: 'x', kind: 'other' })
    expect(validateJournal({ ...journal, failure: { phase: 'switched', detail: 'x', kind: 'gremlins', also: ['fewer-sessions', 'trolls'] } }).failure)
      .toEqual({ phase: 'switched', detail: 'x', kind: 'other', also: ['fewer-sessions', 'other'] })
    expect(validateJournal({ ...journal, failure: { phase: 'copying', detail: 'x', kind: 'no-space' } }).failure)
      .toEqual({ phase: 'copying', detail: 'x', kind: 'no-space' })
  })

  it('names no health check to record outside the switched phase', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    expect(() => { recordHealth(s.setup.dir, undefined) }).toThrow(JournalError)
  })
})

/**
 * Facts for one directory.
 * @param facts - the fields that differ from an absent directory.
 * @returns the facts.
 */
function dir(facts: Partial<DirFacts> = {}): DirFacts {
  return { exists: false, dataId: 'none', movedId: false, retired: false, generation: 0, state: 'none', empty: false, ...facts }
}

describe('nextAction', () => {
  const journal = (changes: Partial<MoveJournal>): MoveJournal => ({
    version: 1, moveId: 'm' as MoveJournal['moveId'], phase: 'requested', pid: 1, source: '/s', sourceAliases: ['/s'], target: '/t',
    targetPreexisting: false, partial: '/p', hidden: '/h', sameVolume: false, dataId: HARNESS_ID, pointerBefore: {},
    terminalBefore: { kind: 'unset' }, terminalSnapshot: { kind: 'unknown', detail: '' }, homeLinkBefore: { kind: 'absent' }, baseline: { sessions: 0, workspaces: 0, quarantined: [] },
    linkRewrites: [], repairRounds: 0, pointerWritten: false, terminalWritten: false, homeLinkRestored: false, targetExposed: false,
    retiredInPlace: false, originalGeneration: 0, cleanupAttempts: 0, cleanupLeftoverBytes: 0,
    awaitingChoice: false, keepTarget: false, keepOriginal: false, targetAbandoned: false, originalAbandoned: false,
    leftovers: [], startedAt: '', ...changes,
  })
  const facts = (changes: Partial<MoveFacts>): MoveFacts => ({ source: dir(), partial: dir(), target: dir(), hidden: dir(), ...changes })
  const ours = dir({ exists: true, dataId: 'ours' })

  it('expects the lock wherever the original data is, and nowhere while only requested or cleaning up', () => {
    const across = journal({ phase: 'copying' })
    expect(lockExpectedAt(across, facts({ source: ours }))).toEqual(['/s'])
    expect(lockExpectedAt(across, facts({ source: dir({ exists: true, movedId: true }) }))).toEqual(['/s'])
    // Something else at the old path, or the original's drive away: nothing to check there.
    expect(lockExpectedAt(across, facts({ source: dir({ exists: true, dataId: 'other' }) }))).toEqual([])
    expect(lockExpectedAt({ ...across, phase: 'switching' }, facts({ hidden: dir({ exists: true }), target: ours }))).toEqual(['/h'])
    const one = journal({ phase: 'switching', sameVolume: true })
    expect(lockExpectedAt(one, facts({ target: ours, hidden: dir({ exists: true }) }))).toEqual(['/t'])
    expect(lockExpectedAt({ ...across, phase: 'requested' }, facts({ source: ours }))).toEqual([])
    for (const phase of ['cleanup', 'rolling-back', 'cancelling', 'abandoning'] as const) {
      expect(lockExpectedAt({ ...across, phase }, facts({ source: ours, hidden: dir({ exists: true }) }))).toEqual([])
    }
  })

  it('hides the source before it names the target, one step at a time', () => {
    const hiding = journal({ phase: 'hiding-source', targetGeneration: 1 })
    const target = dir({ exists: true, state: 'ours', generation: 1 })
    expect(nextAction(hiding, facts({ source: ours, target }), false).kind).toBe('retire-source-id')
    expect(nextAction(hiding, facts({ source: dir({ exists: true, movedId: true }), target }), false).kind).toBe('mark-source')
    expect(nextAction(hiding, facts({ source: dir({ exists: true, movedId: true, state: 'ours' }), target }), false).kind).toBe('rename-source-to-hidden')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target }), false).kind).toBe('write-target-id')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target: dir({ exists: true, dataId: 'ours', state: 'ours', generation: 1 }) }), false).kind)
      .toBe('clear-target-state')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target: dir({ exists: true, dataId: 'ours', generation: 1 }) }), false))
      .toEqual({ kind: 'set-phase', phase: 'switching' })
  })

  it('numbers the copy above the original before naming it, and the original above the copy before it takes its identity back', () => {
    const hidden = dir({ exists: true, state: 'ours', movedId: true })
    const copy = (generation: number): DirFacts => dir({ exists: true, state: 'ours', generation })
    // Not yet chosen, not yet written, or not above the original (a rollback raised it): write it first.
    for (const [changes, target] of [
      [{}, copy(0)], [{ targetGeneration: 3 }, copy(0)], [{ targetGeneration: 3, originalGeneration: 4 }, copy(3)],
    ] as const) {
      expect(nextAction(journal({ phase: 'hiding-source', originalGeneration: 2, ...changes }), facts({ hidden, target }), false).kind)
        .toBe('write-target-generation')
    }
    expect(nextAction(journal({ phase: 'hiding-source', originalGeneration: 2, targetGeneration: 3 }), facts({ hidden, target: copy(3) }), false).kind)
      .toBe('write-target-id')
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true, originalGeneration: 2, targetGeneration: 3 })
    const back = dir({ exists: true, movedId: true, state: 'ours', generation: 2 })
    expect(nextAction(rolling, facts({ source: back }), false).kind).toBe('write-original-generation')
    expect(nextAction({ ...rolling, originalGeneration: 4 }, facts({ source: back }), false).kind).toBe('write-original-generation')
    expect(nextAction({ ...rolling, originalGeneration: 4 }, facts({ source: { ...back, generation: 4 } }), false).kind).toBe('restore-source-id')
    // A move that never numbered a copy leaves the original's number alone.
    expect(nextAction(journal({ phase: 'rolling-back', homeLinkRestored: true }), facts({ source: back }), false).kind).toBe('restore-source-id')
  })

  it('invalidates the target before the source takes its identity back', () => {
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true })
    const hidden = dir({ exists: true, movedId: true, state: 'ours' })
    expect(nextAction(rolling, facts({ target: ours, hidden }), false).kind).toBe('mark-target')
    expect(nextAction(rolling, facts({ target: dir({ exists: true, dataId: 'ours', state: 'ours' }), hidden }), false).kind).toBe('mark-target-retired')
    expect(nextAction(rolling, facts({ target: dir({ exists: true, dataId: 'ours', state: 'ours', retired: true }), hidden }), false).kind)
      .toBe('unlink-target-id')
    expect(nextAction(rolling, facts({ target: dir({ exists: true, state: 'ours' }), hidden }), false).kind).toBe('rename-hidden-to-source')
    expect(nextAction(journal({ phase: 'rolling-back' }), facts({ target: ours, hidden }), false).kind).toBe('restore-home-link')
  })

  it('names why it gives a move up or rolls it back', () => {
    const occupied = dir({ exists: true })
    const failureOf = (action: ReturnType<typeof nextAction>): string | undefined =>
      action.kind === 'abandon' || action.kind === 'roll-back' ? `${action.kind} ${action.failure}` : undefined
    expect(failureOf(nextAction(journal({}), facts({}), false))).toBe('abandon source-changed')
    expect(failureOf(nextAction(journal({}), facts({ source: ours, target: occupied }), false))).toBe('abandon target-occupied')
    const finalizing = journal({ phase: 'finalizing' })
    expect(failureOf(nextAction(finalizing, facts({ partial: dir({ exists: true, state: 'ours' }), target: occupied }), false)))
      .toBe('abandon target-occupied')
    expect(failureOf(nextAction(finalizing, facts({}), false))).toBe('abandon copy-gone')
    expect(failureOf(nextAction(journal({ phase: 'switching' }), facts({}), false))).toBe('roll-back copy-gone')
    const hidden = dir({ exists: true, state: 'ours', movedId: true })
    expect(failureOf(nextAction(journal({ phase: 'hiding-source' }), facts({ hidden }), false))).toBe('roll-back copy-gone')
    expect(failureOf(nextAction(journal({ phase: 'hiding-source', sameVolume: true }), facts({ source: ours, target: occupied }), false)))
      .toBe('abandon target-occupied')
  })

  it('writes the pointer before the terminal', () => {
    expect(nextAction(journal({ phase: 'switching' }), facts({ target: ours }), false).kind).toBe('write-pointer')
    expect(nextAction(journal({ phase: 'switching', pointerWritten: true }), facts({ target: ours }), false).kind).toBe('sync-terminal')
  })

  it('switches only to a target that is still this data', () => {
    const switching = journal({ phase: 'switching' })
    expect(nextAction(switching, facts({}), false).kind).toBe('roll-back')
    expect(nextAction(switching, facts({ target: dir({ exists: true, dataId: 'ours', state: 'ours' }) }), false).kind).toBe('roll-back')
    expect(nextAction(switching, facts({ target: dir({ exists: true, dataId: 'other' }) }), false).kind).toBe('roll-back')
  })

  it('honors a cancel only while the copy is partial', () => {
    for (const phase of ['requested', 'copying', 'verifying', 'catching-up'] as const) {
      expect(nextAction(journal({ phase }), facts({ source: ours }), true).kind).toBe('cancel')
    }
    const target = dir({ exists: true, state: 'ours' })
    expect(nextAction(journal({ phase: 'finalizing' }), facts({ source: ours, target }), true).kind).toBe('set-phase')
  })

  it('ignores the old path once the original is hidden, and blocks when the original is nowhere', () => {
    const hiding = journal({ phase: 'hiding-source', targetGeneration: 1 })
    const other = dir({ exists: true, dataId: 'other' })
    const target = dir({ exists: true, state: 'ours', generation: 1 })
    expect(nextAction(hiding, facts({ source: other, hidden: dir({ exists: true, state: 'ours' }), target }), false).kind).toBe('write-target-id')
    expect(nextAction(hiding, facts({ source: other, target }), false))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: ['/t'], choices: ['keep-target'] })
    expect(nextAction(hiding, facts({ target }), false)).toEqual({ kind: 'blocked', reason: 'original-missing', dataAt: ['/t'], choices: ['keep-target'] })
    const kept = journal({ phase: 'hiding-source', keepTarget: true, targetGeneration: 1 })
    expect(nextAction(kept, facts({ source: other, target }), false).kind).toBe('write-target-id')
    expect(nextAction(kept, facts({ source: other }), false)).toMatchObject({ kind: 'blocked', reason: 'target-missing' })
    expect(nextAction(hiding, facts({ source: other, hidden: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('roll-back')
  })

  it('never names a folder at the target path that is not the checked copy', () => {
    const hiding = journal({ phase: 'hiding-source' })
    const hidden = dir({ exists: true, state: 'ours', movedId: true })
    for (const target of [dir({ exists: true }), dir({ exists: true, dataId: 'other' }), dir({ exists: true, state: 'other' })]) {
      expect(nextAction(hiding, facts({ hidden, target }), false))
        .toEqual({ kind: 'blocked', reason: 'target-occupied', dataAt: ['/h'], choices: ['rollback'] })
    }
  })

  it('blocks a rename on one volume whose data is in neither place', () => {
    const other = dir({ exists: true, dataId: 'other' })
    const hiding = journal({ phase: 'hiding-source', sameVolume: true })
    expect(nextAction(hiding, facts({}), false)).toEqual({ kind: 'blocked', reason: 'original-missing', dataAt: [], choices: [] })
    expect(nextAction(hiding, facts({ target: other }), false).kind).toBe('blocked')
    expect(nextAction(hiding, facts({ source: other }), false))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: [], choices: [] })
  })

  it('never marks a directory that is not the original', () => {
    const hiding = journal({ phase: 'hiding-source' })
    const target = dir({ exists: true, state: 'ours' })
    expect(nextAction(hiding, facts({ source: dir({ exists: true, movedId: true }), target }), false).kind).toBe('mark-source')
    expect(nextAction(hiding, facts({ source: dir({ exists: true }), target }), false).kind).toBe('blocked')
  })

  it('blocks a rollback before touching the copy while the old path is occupied', () => {
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true })
    const hidden = dir({ exists: true, movedId: true, state: 'ours' })
    const other = dir({ exists: true, dataId: 'other' })
    expect(nextAction(rolling, facts({ source: other, target: ours, hidden }), false))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: ['/h', '/t'], choices: ['keep-target'] })
    expect(nextAction(rolling, facts({ target: ours }), false)).toMatchObject({ kind: 'blocked', reason: 'original-missing' })
    expect(nextAction(rolling, facts({ hidden }), false))
      .toEqual({ kind: 'blocked', reason: 'target-missing', dataAt: ['/h'], choices: ['rollback'] })
    expect(nextAction(journal({ phase: 'rolling-back', homeLinkRestored: true, targetAbandoned: true }), facts({ hidden }), false).kind)
      .toBe('rename-hidden-to-source')
    const same = journal({ phase: 'rolling-back', homeLinkRestored: true, sameVolume: true })
    expect(nextAction(same, facts({ source: other, target: ours }), false))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: ['/t'], choices: ['keep-target'] })
    expect(nextAction(same, facts({ target: ours }), false).kind).toBe('return-target-to-source')
  })

  it('neither deletes the copy nor finishes while the old path holds another identity beside the retired one', () => {
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true })
    const mixed = dir({ exists: true, dataId: 'other', movedId: true })
    expect(nextAction(rolling, facts({ source: mixed, target: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('blocked')
    expect(nextAction(rolling, facts({ source: mixed }), false).kind).toBe('blocked')
  })

  it('waits for the person once a rollback was blocked, even with nothing in the way', () => {
    const waiting = journal({ phase: 'rolling-back', homeLinkRestored: true, awaitingChoice: true })
    const hidden = dir({ exists: true, movedId: true, state: 'ours' })
    expect(nextAction(waiting, facts({ hidden, target: ours }), false))
      .toEqual({ kind: 'blocked', reason: 'choice-needed', dataAt: ['/h', '/t'], choices: ['keep-target', 'rollback'] })
  })

  it('deletes a copy nothing outside the move could have used, and retires an exposed one whatever its print', () => {
    const marked = dir({ exists: true, state: 'ours', retired: true })
    const early = journal({ phase: 'rolling-back', homeLinkRestored: true })
    expect(nextAction(early, facts({ source: ours, target: marked }), false).kind).toBe('remove-target')
    for (const targetFingerprint of ['a', 'b', undefined]) {
      const exposed = journal({ phase: 'rolling-back', homeLinkRestored: true, targetExposed: true, ...targetFingerprint === undefined ? {} : { targetFingerprint } })
      const now = { ...facts({ source: ours, target: marked }), targetPrint: 'a' }
      expect(nextAction(exposed, { ...now, target: dir({ exists: true, state: 'ours' }) }, false).kind).toBe('mark-target-retired')
      expect(nextAction(exposed, now, false).kind).toBe('name-unused-copy')
      const named = journal({ ...exposed, unusedCopy: '/u' })
      expect(nextAction(named, now, false).kind).toBe('rename-target-to-unused')
      expect(nextAction(named, { ...now, unusedCopy: dir({ exists: true }) }, false).kind).toBe('name-unused-copy')
      expect(nextAction(named, facts({ source: ours, unusedCopy: dir({ exists: true, state: 'ours', retired: true }) }), false).kind).toBe('finish')
      expect(nextAction(named, facts({ source: ours }), false)).toMatchObject({ kind: 'blocked', reason: 'target-missing', choices: ['rollback'] })
    }
  })

  it('names the new location as changed only while waiting for the person, from its print', () => {
    const hidden = dir({ exists: true, movedId: true, state: 'ours' })
    const waiting = journal({ phase: 'rolling-back', homeLinkRestored: true, awaitingChoice: true, targetFingerprint: 'a' })
    expect(nextAction(waiting, { ...facts({ hidden, target: ours }), targetPrint: 'a' }, false)).toMatchObject({ reason: 'choice-needed' })
    expect(nextAction(waiting, { ...facts({ hidden, target: ours }), targetPrint: 'b' }, false)).toMatchObject({ reason: 'target-changed' })
    const unprinted = journal({ phase: 'rolling-back', homeLinkRestored: true, awaitingChoice: true })
    expect(nextAction(unprinted, { ...facts({ hidden, target: ours }), targetPrint: 'a' }, false)).toMatchObject({ reason: 'target-changed' })
  })

  it('clears a retired marker before naming a target the person chose to keep', () => {
    const kept = journal({ phase: 'hiding-source', keepTarget: true })
    const hidden = dir({ exists: true, state: 'ours', movedId: true })
    expect(nextAction(kept, facts({ hidden, target: dir({ exists: true, state: 'ours', retired: true }) }), false).kind).toBe('clear-target-retired')
    expect(nextAction(kept, facts({ hidden, target: dir({ exists: true, dataId: 'ours', state: 'ours', retired: true }) }), false).kind)
      .toBe('clear-target-retired')
  })

  it('keeps the original in a visible folder, never removing it, once the kept location failed again', () => {
    const cleanup = journal({ phase: 'cleanup', keepOriginal: true })
    const hidden = dir({ exists: true, state: 'ours', movedId: true })
    expect(nextAction(cleanup, facts({ hidden }), false).kind).toBe('mark-hidden-retired')
    expect(nextAction(cleanup, facts({ hidden: { ...hidden, retired: true } }), false).kind).toBe('name-kept-original')
    const named = journal({ phase: 'cleanup', keepOriginal: true, keptOriginal: '/k' })
    expect(nextAction(named, facts({ hidden: { ...hidden, retired: true } }), false).kind).toBe('rename-hidden-to-kept')
    expect(nextAction(named, facts({ keptOriginal: dir({ exists: true, retired: true }) }), false)).toEqual({ kind: 'finish', outcome: 'moved' })
    expect(nextAction(journal({ phase: 'cleanup', keepOriginal: true }), facts({ hidden: dir({ exists: true }) }), false))
      .toEqual({ kind: 'finish', outcome: 'moved' })
  })

  it('lets the server start only once the move switched or is cleaning up', () => {
    expect(mayStartServer(undefined)).toBe(true)
    for (const phase of MOVE_PHASES) {
      expect(mayStartServer(journal({ phase }))).toBe(phase === 'switched' || phase === 'cleanup')
    }
  })

  it('removes only folders marked as this move, or empty', () => {
    const cleanup = journal({ phase: 'cleanup' })
    expect(nextAction(cleanup, facts({ hidden: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('remove-hidden')
    expect(nextAction(cleanup, facts({ hidden: dir({ exists: true }) }), false)).toEqual({ kind: 'keep-unmarked', path: '/h' })
    const abandoning = journal({ phase: 'abandoning' })
    expect(nextAction(abandoning, facts({ source: ours, partial: dir({ exists: true, empty: true }) }), false).kind).toBe('remove-partial')
    expect(nextAction(abandoning, facts({ source: ours, partial: dir({ exists: true }) }), false)).toEqual({ kind: 'keep-unmarked', path: '/p' })
  })

  it('does not remove a target that is not marked as this move', () => {
    const abandoning = journal({ phase: 'abandoning' })
    expect(nextAction(abandoning, facts({ target: dir({ exists: true, state: 'other' }) }), false).kind).toBe('finish')
    expect(nextAction(abandoning, facts({ source: ours, target: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('remove-target')
    expect(nextAction(abandoning, facts({ target: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('blocked')
  })
})
