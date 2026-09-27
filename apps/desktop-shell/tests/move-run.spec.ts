/**
 * The data move from start to end on a fixture home, in process: a move to
 * another volume and a rename on one, cancel, a failed check, a failed health
 * check rolled back from both starting points, a pre-existing empty target,
 * cleanup that has to be retried, and the journal's validation and step table.
 * @module
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calibrateHomeLink } from '../src/home-link.ts'
import {
  JOURNAL_FILENAME, JournalError, MAX_REPAIR_ROUNDS, mayStartServer, MOVE_PHASES, nextAction, readJournal, readMoveResult,
  validateJournal,
  type DirFacts, type MoveFacts, type MoveJournal,
} from '../src/move/journal.ts'
import {
  advanceMove, MoveStuckError, nodeMoveFs, recordHealth, resolveBlocked, startMove, type MoveEffects, type MoveOutcome,
} from '../src/move/run.ts'
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
 * The data files of a listing: every file line except the identity, the move markers, and the rebuildable entries.
 * @param listing - a {@link listTree} listing.
 * @returns the file lines.
 */
function dataFiles(listing: readonly string[]): string[] {
  return listing.filter(line => line.startsWith('file ')
    && !line.startsWith('file .dsh-data-id ')
    && !line.startsWith('file .dsh-data-id.moved ')
    && !line.startsWith(`file ${MOVE_STATE_FILENAME} `)
    && !REBUILDABLE_ENTRIES.some(entry => line.startsWith(`file ${entry}/`) || line.startsWith(`file ${entry} `)))
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
  recordHealth(s.setup.dir, healthy, 'sessions missing')
  return advanceMove(s.setup.dir, effects, { pid: PID })
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
    recordHealth(s.setup.dir, true)
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

  posixOnly('rolls back a failed health check to exactly where it started from a pointer', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const outcome = await runToEnd(s, false)
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed', detail: 'sessions missing' } })
    expect(listTree(s.f.home)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    expect(pointerText(s, 'data-location.json')).toBe(s.pointerBefore.main)
    expect(pointerText(s, 'data-location.json.bak')).toBe(s.pointerBefore.backup)
    expect(readlinkSync(s.setup.defaultHome)).toBe(s.f.home)
    expect(terminalValue(s.setup)).toBe(s.f.home)
    expect(readdirSync(s.f.targetParent)).toEqual([])
  })

  posixOnly('rolls back a move of ~/.dsh itself: the link to the target goes and the real directory comes back', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    bootOnTarget(s)
    expect(lstatSync(s.setup.defaultHome).isSymbolicLink()).toBe(true)
    recordHealth(s.setup.dir, false)
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(lstatSync(s.setup.defaultHome).isDirectory()).toBe(true)
    expect(listTree(s.f.home)).toEqual(s.before)
    expect(pointerText(s, 'data-location.json')).toBeUndefined()
    expect(pointerText(s, 'data-location.json.bak')).toBeUndefined()
    expect(terminalValue(s.setup)).toBe('')
  })

  posixOnly('replaces an empty folder the person picked, and puts it back on rollback', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    const outcome = await runToEnd(s, false)
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(readdirSync(s.target)).toEqual([])
    const again = await scenario({ sameVolume: false, start: 'pointer', targetPreexisting: true })
    expect(await runToEnd(again, true)).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(dataFiles(listTree(again.target))).toEqual(dataFiles(again.before))
  })

  it('cancels while copying: the partial copy goes and nothing else changed', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const controller = new AbortController()
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), {
      pid: PID, cancel: controller.signal, onProgress: (progress) => { if (progress.stage === 'copying') controller.abort() },
    })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'cancelled' } })
    expect(listTree(s.f.home)).toEqual(s.before)
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
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(outcome.kind === 'ended' ? outcome.result.detail : undefined).toContain('big.bin')
    expect(checks).toBe(MAX_REPAIR_ROUNDS + 1)
    expect(listTree(s.f.home)).toEqual(s.before)
    expect(readdirSync(s.f.targetParent)).toEqual([])
  })

  it('gives up before copying when the source lost its identity', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    writeFileSync(join(s.f.home, '.dsh-data-id'), '99999999-8888-4777-8666-555555555555\n')
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(readdirSync(s.f.targetParent)).toEqual([])
  })

  posixOnly('keeps retrying the cleanup until the old copy is gone', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    const real = harnessEffects(s.setup)
    const stubborn: MoveEffects = { ...real, remove: async () => ({ removed: 0, leftovers: [{ path: 'x', code: 'EBUSY', bytes: 35 }], leftoverBytes: 35 }) }
    await advanceMove(s.setup.dir, stubborn, { pid: PID })
    recordHealth(s.setup.dir, true)
    expect(await advanceMove(s.setup.dir, stubborn, { pid: PID })).toEqual({ kind: 'cleanup-incomplete', attempts: 1, leftoverBytes: 35 })
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
    recordHealth(s.setup.dir, false)
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: [hidden, s.target], choices: ['keep-target'] })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    expect(readJournal(s.setup.dir)?.phase).toBe('rolling-back')
    expect(dataFiles(listTree(hidden))).toEqual(dataFiles(s.before))
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
    expect(readFileSync(join(s.f.home, '.dsh-data-id'), 'utf8').trim()).toBe(INTRUDER_ID)
    expect(existsSync(join(s.f.home, MOVE_STATE_FILENAME))).toBe(false)
    expect(resolveBlocked(s.setup.dir, 'rollback', 'source-occupied')).toBe('refused')
    await rm(s.f.home, { recursive: true })
    // The obstruction is gone, but a blocked rollback waits for the person.
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID }))
      .toEqual({ kind: 'blocked', reason: 'choice-needed', dataAt: [hidden, s.target], choices: ['keep-target', 'rollback'] })
    expect(resolveBlocked(s.setup.dir, 'rollback', 'choice-needed')).toBe('applied')
    expect(resolveBlocked(s.setup.dir, 'rollback', 'choice-needed')).toBe('not-blocked')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(listTree(s.f.home)).toEqual(s.before)
  })

  posixOnly('keeps the new location when the person chooses it, and deletes the original once it is healthy', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, false)
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'source-occupied')).toBe('applied')
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'source-occupied')).toBe('not-blocked')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(true)
    recordHealth(s.setup.dir, true)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(existsSync(hidden)).toBe(false)
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
    expect(readFileSync(join(s.f.home, '.dsh-data-id'), 'utf8').trim()).toBe(INTRUDER_ID)
  })

  posixOnly('keeps the original too when the kept location fails its health check again', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, false)
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    resolveBlocked(s.setup.dir, 'keep-target', 'source-occupied')
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, false)
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'ended', result: { outcome: 'moved', leftovers: [{ path: hidden, bytes: 0 }] } })
    expect(dataFiles(listTree(hidden))).toEqual(dataFiles(s.before))
  })

  posixOnly('never deletes work written at the new location after the health check failed', async () => {
    const s = await scenario({ sameVolume: false, start: 'default-home' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    plantIntruder(s.f.home)
    recordHealth(s.setup.dir, false)
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    mkdirSync(join(s.target, 'sessions', 'new'), { recursive: true })
    writeFileSync(join(s.target, 'sessions', 'new', 'log'), 'NEW WORK\n')
    await rm(s.f.home, { recursive: true })
    // With the old path free again, the page says what going back would delete.
    const outcome = await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    expect(outcome).toMatchObject({ kind: 'blocked', reason: 'target-changed', choices: ['keep-target', 'rollback'] })
    expect(resolveBlocked(s.setup.dir, 'rollback', 'choice-needed')).toBe('refused')
    expect(readFileSync(join(s.target, 'sessions', 'new', 'log'), 'utf8')).toBe('NEW WORK\n')
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    // Keeping the new location takes the work with it; the original is hidden again first.
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'target-changed')).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(existsSync(s.f.home)).toBe(false)
    recordHealth(s.setup.dir, true)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(readFileSync(join(s.target, 'sessions', 'new', 'log'), 'utf8')).toBe('NEW WORK\n')
    expect(readFileSync(join(s.target, '.dsh-data-id'), 'utf8').trim()).toBe(HARNESS_ID)
  })

  posixOnly('deletes changed work at the new location only when the person chooses to go back anyway', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, false)
    writeFileSync(join(s.target, 'sessions', 'late.txt'), 'late')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'blocked', reason: 'target-changed' })
    expect(resolveBlocked(s.setup.dir, 'rollback', 'target-changed')).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(listTree(s.f.home)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
  })

  posixOnly('lets the person roll back without a copy whose disk is away', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, false)
    const away = join(s.f.root, 'unplugged')
    renameSync(s.target, away)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID }))
      .toMatchObject({ kind: 'blocked', reason: 'target-missing', choices: ['rollback'] })
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'target-missing')).toBe('refused')
    expect(resolveBlocked(s.setup.dir, 'rollback', 'target-missing')).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(listTree(s.f.home)).toEqual(s.before)
  })

  posixOnly('offers to keep the new location when the original is gone', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })
    recordHealth(s.setup.dir, false)
    const hidden = readJournal(s.setup.dir)?.hidden ?? ''
    renameSync(hidden, join(s.f.root, 'lost'))
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID }))
      .toEqual({ kind: 'blocked', reason: 'original-missing', dataAt: [s.target], choices: ['keep-target'] })
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'original-missing')).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, true)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toMatchObject({ kind: 'ended', result: { outcome: 'moved' } })
    expect(dataFiles(listTree(s.target))).toEqual(dataFiles(s.before))
  })

  posixOnly('blocks the rollback of a rename, leaving the data at the target the pointer names', async () => {
    const s = await scenario({ sameVolume: true, start: 'default-home' })
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    expect(plantIntruder(s.f.home)).toBe(true)
    recordHealth(s.setup.dir, false)
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID }))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: [s.target], choices: ['keep-target'] })
    expect(JSON.parse(pointerText(s, 'data-location.json') ?? '{}')).toMatchObject({ path: s.target })
    expect(mayStartServer(readJournal(s.setup.dir))).toBe(false)
    expect(resolveBlocked(s.setup.dir, 'keep-target', 'source-occupied')).toBe('applied')
    expect(await advanceMove(s.setup.dir, harnessEffects(s.setup), { pid: PID })).toEqual({ kind: 'switched' })
    recordHealth(s.setup.dir, true)
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
    expect(await runToEnd(s, false)).toMatchObject({ kind: 'ended', result: { outcome: 'failed' } })
    expect(listTree(s.f.home)).toEqual(s.before)
    expect(existsSync(s.target)).toBe(false)
    expect(pointerText(s, 'data-location.json')).toBe(s.pointerBefore.main)
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
    bad({ linkRewrites: [{ rel: 'a' }] })
    bad({ pointerWritten: 'yes' })
    bad({ failure: { phase: 'nope', detail: 'x' } })
    writeFileSync(join(s.setup.dir, JOURNAL_FILENAME), '{ torn')
    expect(() => readJournal(s.setup.dir)).toThrow(JournalError)
  })

  it('names no health check to record outside the switched phase', async () => {
    const s = await scenario({ sameVolume: false, start: 'pointer' })
    expect(() => { recordHealth(s.setup.dir, true) }).toThrow(JournalError)
  })
})

/**
 * Facts for one directory.
 * @param facts - the fields that differ from an absent directory.
 * @returns the facts.
 */
function dir(facts: Partial<DirFacts> = {}): DirFacts {
  return { exists: false, dataId: 'none', movedId: false, state: 'none', empty: false, ...facts }
}

describe('nextAction', () => {
  const journal = (changes: Partial<MoveJournal>): MoveJournal => ({
    version: 1, moveId: 'm' as MoveJournal['moveId'], phase: 'requested', pid: 1, source: '/s', sourceAliases: ['/s'], target: '/t',
    targetPreexisting: false, partial: '/p', hidden: '/h', sameVolume: false, dataId: HARNESS_ID, pointerBefore: {},
    terminalBefore: { kind: 'unset' }, homeLinkBefore: { kind: 'absent' }, baseline: { sessions: 0, workspaces: 0, quarantined: [] },
    linkRewrites: [], repairRounds: 0, pointerWritten: false, terminalWritten: false, homeLinkRestored: false, cleanupAttempts: 0,
    awaitingChoice: false, keepTarget: false, keepOriginal: false, targetAbandoned: false,
    leftovers: [], startedAt: '', ...changes,
  })
  const facts = (changes: Partial<MoveFacts>): MoveFacts => ({ source: dir(), partial: dir(), target: dir(), hidden: dir(), ...changes })
  const ours = dir({ exists: true, dataId: 'ours' })

  it('hides the source before it names the target, one step at a time', () => {
    const hiding = journal({ phase: 'hiding-source' })
    const target = dir({ exists: true, state: 'ours' })
    expect(nextAction(hiding, facts({ source: ours, target }), false).kind).toBe('retire-source-id')
    expect(nextAction(hiding, facts({ source: dir({ exists: true, movedId: true }), target }), false).kind).toBe('mark-source')
    expect(nextAction(hiding, facts({ source: dir({ exists: true, movedId: true, state: 'ours' }), target }), false).kind).toBe('rename-source-to-hidden')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target }), false).kind).toBe('write-target-id')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target: dir({ exists: true, dataId: 'ours', state: 'ours' }) }), false).kind)
      .toBe('clear-target-state')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true, state: 'ours' }), target: ours }), false)).toEqual({ kind: 'set-phase', phase: 'switching' })
  })

  it('invalidates the target before the source takes its identity back', () => {
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true })
    const hidden = dir({ exists: true, movedId: true, state: 'ours' })
    expect(nextAction(rolling, facts({ target: ours, hidden }), false).kind).toBe('mark-target')
    expect(nextAction(rolling, facts({ target: dir({ exists: true, dataId: 'ours', state: 'ours' }), hidden }), false).kind).toBe('unlink-target-id')
    expect(nextAction(rolling, facts({ target: dir({ exists: true, state: 'ours' }), hidden }), false).kind).toBe('rename-hidden-to-source')
    expect(nextAction(journal({ phase: 'rolling-back' }), facts({ target: ours, hidden }), false).kind).toBe('restore-home-link')
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
    const hiding = journal({ phase: 'hiding-source' })
    const other = dir({ exists: true, dataId: 'other' })
    const target = dir({ exists: true, state: 'ours' })
    expect(nextAction(hiding, facts({ source: other, hidden: dir({ exists: true, state: 'ours' }), target }), false).kind).toBe('write-target-id')
    expect(nextAction(hiding, facts({ source: other, target }), false))
      .toEqual({ kind: 'blocked', reason: 'source-occupied', dataAt: ['/t'], choices: ['keep-target'] })
    expect(nextAction(hiding, facts({ target }), false)).toEqual({ kind: 'blocked', reason: 'original-missing', dataAt: ['/t'], choices: ['keep-target'] })
    const kept = journal({ phase: 'hiding-source', keepTarget: true })
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

  it('deletes the copy only while its session data is what it was at the failed health check', () => {
    const print = { files: 3, bytes: 30, maxMtimeMs: 1000 }
    const rolling = journal({ phase: 'rolling-back', homeLinkRestored: true, targetFingerprint: print })
    const marked = dir({ exists: true, state: 'ours' })
    expect(nextAction(rolling, { ...facts({ source: ours, target: marked }), targetSessions: print }, false).kind).toBe('remove-target')
    expect(nextAction(rolling, { ...facts({ source: ours, target: marked }), targetSessions: { ...print, maxMtimeMs: 1001 } }, false))
      .toMatchObject({ kind: 'blocked', reason: 'target-changed', choices: ['keep-target', 'rollback'] })
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
