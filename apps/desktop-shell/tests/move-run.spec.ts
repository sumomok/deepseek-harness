/**
 * The data move from start to end on a fixture home, in process: a move to
 * another volume and a rename on one, cancel, a failed check, a failed health
 * check rolled back from both starting points, a pre-existing empty target,
 * cleanup that has to be retried, and the journal's validation and step table.
 * @module
 */

import {
  chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { calibrateHomeLink } from '../src/home-link.ts'
import {
  JOURNAL_FILENAME, JournalError, MAX_REPAIR_ROUNDS, nextAction, readJournal, readMoveResult, validateJournal,
  type DirFacts, type MoveFacts, type MoveJournal,
} from '../src/move/journal.ts'
import { advanceMove, MoveStuckError, recordHealth, startMove, type MoveEffects, type MoveOutcome } from '../src/move/run.ts'
import { MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES } from '../src/move/tree.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'
import { HARNESS_ID, harnessEffects, prepareMove, terminalValue, type MoveSetup, type Start } from './move-harness.ts'

let fixture: Fixture | undefined

afterEach(async () => {
  if (fixture !== undefined) {
    for (const line of listTree(fixture.root)) {
      if (line.startsWith('dir ')) chmodSync(join(fixture.root, line.slice(4)), 0o700)
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
  fixture = undefined
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
  fixture = f
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
 * The data files of a listing: every file line except the identity and the rebuildable entries.
 * @param listing - a {@link listTree} listing.
 * @returns the file lines.
 */
function dataFiles(listing: readonly string[]): string[] {
  return listing.filter(line => line.startsWith('file ')
    && !line.startsWith('file .dsh-data-id ')
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
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true }), target }), false).kind).toBe('write-target-id')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true }), target: dir({ exists: true, dataId: 'ours', state: 'ours' }) }), false).kind)
      .toBe('clear-target-state')
    expect(nextAction(hiding, facts({ hidden: dir({ exists: true }), target: ours }), false)).toEqual({ kind: 'set-phase', phase: 'switching' })
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
    expect(nextAction(journal({ phase: 'switching' }), facts({}), false).kind).toBe('write-pointer')
    expect(nextAction(journal({ phase: 'switching', pointerWritten: true }), facts({}), false).kind).toBe('sync-terminal')
  })

  it('honors a cancel only while the copy is partial', () => {
    for (const phase of ['requested', 'copying', 'verifying', 'catching-up'] as const) {
      expect(nextAction(journal({ phase }), facts({ source: ours }), true).kind).toBe('cancel')
    }
    const target = dir({ exists: true, state: 'ours' })
    expect(nextAction(journal({ phase: 'finalizing' }), facts({ source: ours, target }), true).kind).toBe('set-phase')
  })

  it('does not remove a target that is not marked as this move', () => {
    const abandoning = journal({ phase: 'abandoning' })
    expect(nextAction(abandoning, facts({ target: dir({ exists: true, state: 'other' }) }), false).kind).toBe('finish')
    expect(nextAction(abandoning, facts({ target: dir({ exists: true, state: 'ours' }) }), false).kind).toBe('remove-target')
  })
})
