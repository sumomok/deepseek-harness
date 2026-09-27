/**
 * A data move killed with SIGKILL after any one of its disk operations, then
 * resumed. Each scenario first runs once without a kill to number its events;
 * every event that is not a copy or check progress report is then a kill
 * point, together with a seeded sample of progress reports.
 *
 * After each kill: at most one of the four directories is this data (its
 * identity marker and no move marker), and the partial copy carries no
 * identity marker at all; a pointer that names a directory names
 * one that is this data, except while a rollback is undoing it; the source is
 * untouched until it is hidden; the sentinel behind a link is untouched. After
 * the resumed run: the move either finished on the target with every data
 * file intact, or, for a failed health check, everything is as it was before.
 *
 * The child runs from source under plain Node (these modules use only
 * erasable TypeScript), so no build is needed. The resumed run happens in
 * this process: resuming is not what is under test, the state it starts from
 * is. Kill points run side by side, each in its own temporary fixture.
 * @module
 */

import { spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  MOVED_ID_FILENAME, readJournal, RETIRED_FILENAME, type BlockedChoice, type MoveJournal, type MoveResult,
} from '../src/move/journal.ts'
import { readGeneration } from '../src/data-location.ts'
import { advanceMove, recordHealth, rolledBackPointer, startMove } from '../src/move/run.ts'
import { IGNORABLE_NAMES, MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES } from '../src/move/tree.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'
import {
  driveMove, HARNESS_ID, harnessEffects, INTRUDER_ID, plantIntruder, prepareMove, terminalValue, type Faults, type MoveSetup, type Start,
} from './move-harness.ts'
import type { ChildInput } from './move-crash-child.ts'

const CHILD = fileURLToPath(new URL('./move-crash-child.ts', import.meta.url))
/** Progress reports sampled per scenario, beyond every other event. */
const PROGRESS_SAMPLES = 4
/** A child that has not exited by then is stopped and reported. */
const CHILD_TIMEOUT_MS = 60_000
/** Kill points run side by side, each in its own fixture. */
const CONCURRENCY = 6
/** Each child is a short Node process; the budget covers dozens of them per scenario. */
const SCENARIO_TIMEOUT_MS = 240_000

/** One scenario. */
interface Case {
  name: string
  sameVolume: boolean
  start: Start
  /** The health check's verdict. */
  healthy: boolean
  faults?: Faults
  /** After the kill, a terminal `dsh` recreates the data's old path when it is empty. */
  intruder?: boolean
  /** The person picked an empty folder, which becomes the target. */
  targetPreexisting?: boolean
  /** The first full check finds a damaged file and a stray one, and the copy is repaired. */
  damage?: boolean
  /** Finder drops `.DS_Store` into the picked folder and the copy while copying. */
  finderFiles?: boolean
  /** Size of the large attachment; more than one read chunk makes kills land inside it. */
  bigBytes?: number
  /** Kill after every progress report too, not a sample. */
  allProgress?: boolean
  /** The person's choice on the blocked move the scenario starts from. */
  choose?: BlockedChoice
}

const CASES: Case[] = [
  { name: 'another volume, health check passes', sameVolume: false, start: 'pointer', healthy: true },
  { name: 'another volume, health check fails, ~/.dsh was the home', sameVolume: false, start: 'default-home', healthy: false },
  { name: 'one volume, health check passes', sameVolume: true, start: 'pointer', healthy: true },
  { name: 'another volume from ~/.dsh, health check passes', sameVolume: false, start: 'default-home', healthy: true },
  { name: 'one volume from ~/.dsh, health check passes', sameVolume: true, start: 'default-home', healthy: true },
  { name: 'one volume, health check fails', sameVolume: true, start: 'pointer', healthy: false },
  { name: 'another volume, naming the target fails', sameVolume: false, start: 'pointer', healthy: true, faults: { targetId: true } },
  { name: 'another volume from ~/.dsh, the terminal write fails', sameVolume: false, start: 'default-home', healthy: true, faults: { terminal: true } },
  { name: 'one volume, rewriting a link fails', sameVolume: true, start: 'pointer', healthy: true, faults: { rewrite: true } },
  { name: 'one volume, the terminal write fails', sameVolume: true, start: 'pointer', healthy: true, faults: { terminal: true } },
  { name: 'another volume from ~/.dsh, recreated by a terminal, passes', sameVolume: false, start: 'default-home', healthy: true, intruder: true },
  { name: 'another volume from ~/.dsh, recreated by a terminal, fails', sameVolume: false, start: 'default-home', healthy: false, intruder: true },
  { name: 'one volume from ~/.dsh, recreated by a terminal, passes', sameVolume: true, start: 'default-home', healthy: true, intruder: true },
  { name: 'one volume from ~/.dsh, recreated by a terminal, fails', sameVolume: true, start: 'default-home', healthy: false, intruder: true },
  { name: 'another volume into a picked empty folder Finder writes into', sameVolume: false, start: 'pointer', healthy: true, targetPreexisting: true, finderFiles: true },
  { name: 'another volume into a picked empty folder, health check fails', sameVolume: false, start: 'pointer', healthy: false, targetPreexisting: true },
  { name: 'one volume into a picked empty folder', sameVolume: true, start: 'pointer', healthy: true, targetPreexisting: true },
  { name: 'another volume, the first check finds damage', sameVolume: false, start: 'pointer', healthy: true, damage: true },
  { name: 'another volume, a file larger than one read chunk', sameVolume: false, start: 'pointer', healthy: true, bigBytes: 2_500_000, allProgress: true },
]

/**
 * Whether a scenario ends with the data moved.
 * @param c - the scenario.
 * @returns true when nothing fails.
 */
function expectMoved(c: Case): boolean {
  return (c.healthy || keptTwice(c)) && c.faults === undefined && c.choose !== 'rollback'
}

/**
 * Whether the person keeps the new location and it fails its check again, so
 * the move ends on it with the original kept.
 * @param c - the scenario.
 * @returns true for that scenario.
 */
function keptTwice(c: Case): boolean {
  return c.choose === 'keep-target' && !c.healthy
}

/**
 * Whether a failed scenario leaves the copy at the new location as an unused
 * copy: on another volume, once the pointer was about to name it (every failure
 * here except naming the target, which fails before that).
 * @param c - the scenario.
 * @returns true when the result must name an unused copy.
 */
function expectUnusedCopy(c: Case): boolean {
  return !expectMoved(c) && !c.sameVolume && c.faults?.targetId !== true
}

/** A prepared move. */
interface Prepared {
  f: Fixture
  setup: MoveSetup
  target: string
  before: string[]
  hidden: string
  partial: string
}

/**
 * A fresh fixture with the move started.
 * @param c - the scenario.
 * @returns the move.
 */
async function prepare(c: Case): Promise<Prepared> {
  const f = await buildFixture({ bigBytes: c.bigBytes ?? 200_000 })
  const target = join(f.targetParent, 'DSH-Data')
  const setup = prepareMove({
    root: f.root, home: f.home, target, sameVolume: c.sameVolume, start: c.start, targetPreexisting: c.targetPreexisting === true,
  })
  const journal = startMove(setup.dir, setup.start, { pid: process.pid, now: new Date() })
  return { f, setup, target, before: listTree(f.home), hidden: journal.hidden, partial: journal.partial }
}

/**
 * Remove a fixture, read-only directories included.
 * @param f - the fixture.
 */
async function dispose(f: Fixture): Promise<void> {
  for (const line of listTree(f.root)) {
    if (line.startsWith('dir ')) chmodSync(join(f.root, line.slice(4)), 0o700)
  }
  await rm(f.root, { recursive: true, force: true })
}

/** How one child run ended. */
interface ChildRun {
  signal: NodeJS.Signals | null
  status: number | null
  events: string[]
  ended: string | undefined
  stderr: string
}

/**
 * Run the child to its end or its kill point.
 * @param p - the move.
 * @param c - the scenario.
 * @param killAt - the event to die after; 0 for none.
 * @returns how it ended, once the process has exited.
 */
function runChild(p: Prepared, c: Case, killAt: number): Promise<ChildRun> {
  const input: ChildInput = {
    setup: p.setup, target: p.target, healthy: c.healthy, killAt, faults: c.faults ?? {},
    damageFirstCheck: c.damage === true, finderFiles: c.finderFiles === true, ...c.choose === undefined ? {} : { choose: c.choose },
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CHILD, JSON.stringify(input)], { stdio: ['ignore', 'pipe', 'pipe'], timeout: CHILD_TIMEOUT_MS })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (status, signal) => {
      const line = stdout.trim().split('\n').at(-1) ?? ''
      const parsed = line.startsWith('{') ? JSON.parse(line) as { events: string[]; ended: string } : undefined
      resolve({ signal, status, events: parsed?.events ?? [], ended: parsed?.ended, stderr })
    })
  })
}

/**
 * Run `task` over `items` with at most `limit` running at once.
 * @param items - the inputs.
 * @param limit - the concurrency.
 * @param task - the work per item.
 */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next]
      next += 1
      if (item !== undefined) await task(item)
    }
  }
  await Promise.all(Array.from({ length: limit }, lane))
}

/**
 * Whether a directory is this data: it carries the identity and neither a move nor a retired marker.
 * @param dir - the directory.
 * @returns true when it does.
 */
function isOurData(dir: string): boolean {
  const idFile = join(dir, '.dsh-data-id')
  if (!existsSync(idFile) || existsSync(join(dir, MOVE_STATE_FILENAME)) || existsSync(join(dir, RETIRED_FILENAME))) return false
  return readFileSync(idFile, 'utf8').trim() === HARNESS_ID
}

/**
 * The data files of a listing: every file except the identity and the rebuildable entries.
 * @param listing - a listing.
 * @returns the file lines.
 */
function dataFiles(listing: readonly string[]): string[] {
  return listing.filter(line => line.startsWith('file ')
    && !line.startsWith('file .dsh-data-id ')
    && !line.startsWith('file .dsh-data-id.moved ')
    && !line.startsWith(`file ${MOVE_STATE_FILENAME} `)
    && !line.startsWith(`file ${RETIRED_FILENAME} `)
    && !line.startsWith('file .dsh-data-generation ')
    // A file browser's own files (the Finder scenario) are not data.
    && !IGNORABLE_NAMES.some(name => line.startsWith(`file ${name} `) || line.includes(`/${name} `))
    && !REBUILDABLE_ENTRIES.some(entry => line.startsWith(`file ${entry}/`) || line.startsWith(`file ${entry} `)))
}

/**
 * Phases in which the pointer names this data. While the source is hidden and
 * the pointer not yet switched, or while a rollback undoes the switch, the
 * pointer names a directory that is not (yet, or any more) the data; the next
 * launch reads the journal before the pointer.
 */
const POINTER_CONSISTENT = new Set(['requested', 'copying', 'verifying', 'catching-up', 'finalizing', 'switched', 'cleanup'])

/** Phases in which the source must still be exactly as it was. */
const SOURCE_UNTOUCHED = new Set(['requested', 'copying', 'verifying', 'catching-up', 'finalizing'])

/**
 * When no directory is this data, the kill fell between the source retiring
 * its identity and the target receiving it, or, in a rollback, between the
 * target giving it up and the source dropping its move marker: the journal
 * must be readable in that phase and the original complete under a path it
 * names, with its (retired) identity.
 * @param p - the move.
 * @returns every violation, as sentences.
 */
function checkRetiredWindow(p: Prepared): string[] {
  let journal: MoveJournal | undefined
  try {
    journal = readJournal(p.setup.dir)
  } catch (error) {
    return [`no directory is this data and the journal is unreadable: ${String(error)}`]
  }
  if (journal === undefined || (journal.phase !== 'hiding-source' && journal.phase !== 'rolling-back')) {
    return [`no directory is this data in phase ${String(journal?.phase)}`]
  }
  // The original holds the retired identity, or (a rollback that restored it
  // but has not yet removed the move marker) the identity and the marker.
  const idOf = (dir: string): string | undefined => {
    for (const name of [MOVED_ID_FILENAME, '.dsh-data-id']) {
      if (existsSync(join(dir, name))) return readFileSync(join(dir, name), 'utf8').trim()
    }
    return undefined
  }
  const original = [journal.source, journal.hidden].find(dir => idOf(dir) !== undefined)
  if (original === undefined) return ['no directory is this data and no directory named by the journal holds its identity']
  const violations: string[] = []
  if (idOf(original) !== HARNESS_ID) violations.push('the original named by the journal is not this data')
  if (JSON.stringify(dataFiles(listTree(original))) !== JSON.stringify(dataFiles(p.before))) violations.push('the retired original is not complete')
  return violations
}

/**
 * Check what must hold at the moment of the kill.
 * @param p - the move.
 * @param sentinel - the sentinel's listing before the move.
 * @returns every violation, as sentences.
 */
function checkAtKill(p: Prepared, sentinel: readonly string[]): string[] {
  const violations: string[] = []
  const dirs = [p.f.home, p.partial, p.target, p.hidden]
  // `~/.dsh` may be a link to the target once the launch has calibrated it; one directory, two names.
  const ours = [...new Set(dirs.filter(isOurData).map(dir => realpathSync(dir)))]
  if (ours.length > 1) violations.push(`more than one directory is this data: ${ours.join(', ')}`)
  if (ours.length === 0) violations.push(...checkRetiredWindow(p))
  if (existsSync(join(p.partial, '.dsh-data-id'))) violations.push('the partial copy carries an identity marker')
  let journal: MoveJournal | undefined
  try {
    journal = readJournal(p.setup.dir)
  } catch (error) {
    violations.push(`journal unreadable: ${String(error)}`)
  }
  const pointerFile = join(p.setup.userData, 'data-location.json')
  if (existsSync(pointerFile) && (journal === undefined || POINTER_CONSISTENT.has(journal.phase))) {
    const pointer = JSON.parse(readFileSync(pointerFile, 'utf8')) as { path: string }
    if (!isOurData(pointer.path)) violations.push(`the pointer names ${pointer.path}, which is not this data`)
  }
  if (journal !== undefined && SOURCE_UNTOUCHED.has(journal.phase)) {
    const now = existsSync(p.f.home) ? listTree(p.f.home) : []
    if (JSON.stringify(now) !== JSON.stringify(p.before)) violations.push(`the source changed in phase ${journal.phase}`)
  }
  if (JSON.stringify(listTree(p.f.sentinel)) !== JSON.stringify(sentinel)) violations.push('the sentinel changed')
  return violations
}

/**
 * Check the end state after the resumed run.
 * @param p - the move.
 * @param c - the scenario.
 * @param ended - how the resumed run said the move ended.
 * @param planted - whether a terminal `dsh` recreated the old path.
 * @returns every violation, as sentences.
 */
function checkAtEnd(p: Prepared, c: Case, ended: string | undefined, planted: boolean): string[] {
  const violations: string[] = []
  if (existsSync(join(p.setup.dir, 'journal.json'))) violations.push('the journal is still there')
  const result = JSON.parse(readFileSync(join(p.setup.dir, 'last-result.json'), 'utf8')) as MoveResult
  if (ended !== 'none' && ended !== result.outcome) violations.push(`the run said ${String(ended)}, the result file ${result.outcome}`)
  for (const gone of [p.partial, p.hidden]) {
    if (existsSync(gone)) violations.push(`${gone} is still there`)
  }
  if (expectMoved(c)) {
    if (result.outcome !== 'moved') violations.push(`the move ended ${result.outcome}`)
    // Moving ~/.dsh itself leaves a link to the target at the old name, or the directory a terminal made there.
    const atSource = existsSync(p.f.home) ? lstatSync(p.f.home) : undefined
    const expectedThere = atSource === undefined
      || (atSource.isSymbolicLink() && readlinkSync(p.f.home) === p.target)
      || (planted && readFileSync(join(p.f.home, '.dsh-data-id'), 'utf8').trim() === INTRUDER_ID)
    if (!expectedThere) violations.push('the source is still there')
    if (!isOurData(p.target)) violations.push('the target is not this data')
    else if (JSON.stringify(dataFiles(listTree(p.target))) !== JSON.stringify(dataFiles(p.before))) violations.push('the target data differs')
    const pointer = JSON.parse(readFileSync(join(p.setup.userData, 'data-location.json'), 'utf8')) as { path: string; generation?: number }
    if (pointer.path !== p.target) violations.push(`the pointer names ${pointer.path}`)
    if ((pointer.generation ?? 0) !== readGeneration(p.target)) violations.push('the pointer and the target disagree on the generation')
    if (!c.sameVolume && readGeneration(p.target) <= 0) violations.push('the target is not numbered above the original')
    if (result.keptOriginal !== undefined && readGeneration(result.keptOriginal.path) >= readGeneration(p.target)) {
      violations.push('the kept original is not older than the target')
    }
    if (terminalValue(p.setup) !== p.target) violations.push('the terminal does not name the target')
    // On one volume the original is what was renamed to the target: there is nothing else to keep.
    if (keptTwice(c) && !c.sameVolume) violations.push(...checkKept(p, result.keptOriginal?.path, 'kept original'))
    else if (result.keptOriginal !== undefined) violations.push('the result names a kept original')
    if (result.leftovers.length > 0) violations.push('the result lists leftovers')
  } else {
    if (result.outcome !== 'failed') violations.push(`the move ended ${result.outcome}`)
    const original = listTree(p.f.home).filter(line => !line.startsWith('file .dsh-data-generation '))
    if (JSON.stringify(original) !== JSON.stringify(p.before)) violations.push('the source is not as it was')
    if (c.targetPreexisting === true) {
      if (!existsSync(p.target) || readdirSync(p.target).length !== 0) violations.push('the picked folder is not back, empty')
    } else if (existsSync(p.target)) violations.push('the target is still there')
    const main = join(p.setup.userData, 'data-location.json')
    const now = existsSync(main) ? readFileSync(main, 'utf8') : undefined
    // A pointer that named the copy goes back numbered as the original is now; one never written stays as it was.
    const before = p.setup.start.pointerBefore
    const expected = result.unusedCopy === undefined ? before.main : rolledBackPointer(before, readGeneration(p.f.home)).main
    if (now !== expected) violations.push('the pointer is not as it was (numbered as the original is now when it named the copy)')
    const terminal = p.setup.start.terminalBefore
    if (terminalValue(p.setup) !== (terminal.kind === 'set' ? terminal.value : '')) violations.push('the terminal is not as it was')
    if (c.start === 'pointer' && readlinkSync(p.setup.defaultHome) !== p.f.home) violations.push('~/.dsh does not link to the source')
    const beside = readdirSync(p.f.targetParent).filter(name => name !== 'DSH-Data')
    if (expectUnusedCopy(c)) {
      violations.push(...checkKept(p, result.unusedCopy?.path, 'unused copy'))
      if (result.unusedCopy !== undefined && readGeneration(result.unusedCopy.path) >= readGeneration(p.f.home)) {
        violations.push('the unused copy is not older than the original')
      }
      if (result.unusedCopy !== undefined && JSON.stringify(beside) !== JSON.stringify([basename(result.unusedCopy.path)])) {
        violations.push(`beside the target: ${beside.join(', ')}`)
      }
    } else {
      if (result.unusedCopy !== undefined) violations.push('the result names an unused copy')
      if (beside.length > 0) violations.push(`beside the target: ${beside.join(', ')}`)
    }
  }
  return violations
}

/**
 * Check a folder the move left for the person: it exists, holds the complete
 * data, carries the retired marker, and is not usable as this data.
 * @param p - the move.
 * @param path - the folder the result names.
 * @param what - what it is, for the sentences.
 * @returns every violation, as sentences.
 */
function checkKept(p: Prepared, path: string | undefined, what: string): string[] {
  if (path === undefined) return [`the result names no ${what}`]
  if (!existsSync(path)) return [`the ${what} ${path} is not there`]
  const violations: string[] = []
  if (JSON.stringify(dataFiles(listTree(path))) !== JSON.stringify(dataFiles(p.before))) violations.push(`the ${what} is not complete`)
  if (!existsSync(join(path, RETIRED_FILENAME))) violations.push(`the ${what} has no retired marker`)
  if (existsSync(join(path, '.dsh-data-id'))) violations.push(`the ${what} still carries the identity`)
  return violations
}

/**
 * Check a move blocked by a directory a terminal made at the old path: the
 * journal is kept, the original is complete where the journal says, and the
 * other directory is untouched.
 * @param p - the move.
 * @param c - the scenario.
 * @returns every violation, as sentences.
 */
function checkBlocked(p: Prepared, c: Case): string[] {
  const violations: string[] = []
  if (!existsSync(join(p.setup.dir, 'journal.json'))) violations.push('the journal is gone')
  const holder = c.sameVolume ? p.target : p.hidden
  if (!existsSync(holder) || JSON.stringify(dataFiles(listTree(holder))) !== JSON.stringify(dataFiles(p.before))) {
    violations.push(`the data is not complete in ${holder}`)
  }
  if (readFileSync(join(p.f.home, '.dsh-data-id'), 'utf8').trim() !== INTRUDER_ID) violations.push('the other directory was changed')
  if (!existsSync(join(p.f.home, 'sessions', 'theirs.txt'))) violations.push('the other directory lost its file')
  return violations
}

/**
 * The kill points of a scenario: every event other than a progress report,
 * and a seeded sample of progress reports.
 * @param events - the events of an uninterrupted run.
 * @param seed - the sample's seed.
 * @param allProgress - whether every progress report is a kill point.
 * @returns event numbers, 1-based.
 */
function killPoints(events: readonly string[], seed: number, allProgress: boolean): number[] {
  const points: number[] = []
  const progress: number[] = []
  events.forEach((label, index) => {
    if (label.endsWith(' progress') && !allProgress) progress.push(index + 1)
    else points.push(index + 1)
  })
  let state = seed
  for (let i = 0; i < PROGRESS_SAMPLES && progress.length > 0; i += 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648
    points.push(progress[state % progress.length] ?? 1)
  }
  return [...new Set(points)].sort((a, b) => a - b)
}

const posixOnly = process.platform === 'win32' ? describe.skip : describe

posixOnly('a data move killed at any step', () => {
  CASES.forEach((c, index) => {
    it(`resumes to a consistent end: ${c.name}`, async () => {
      const counting = await prepare(c)
      let events: string[]
      try {
        const run = await runChild(counting, c, 0)
        expect(run.stderr).toBe('')
        expect(run.signal).toBeNull()
        expect(run.status).toBe(0)
        expect(checkAtEnd(counting, c, run.ended, false)).toEqual([])
        events = run.events
      } finally {
        await dispose(counting.f)
      }
      const failures: string[] = []
      const points = killPoints(events, 20_260_927 + index, c.allProgress === true)
      await pool(points, CONCURRENCY, async (killAt) => {
        const label = `kill ${String(killAt)} (${events[killAt - 1] ?? '?'})`
        const p = await prepare(c)
        try {
          const sentinel = listTree(p.f.sentinel)
          const killed = await runChild(p, c, killAt)
          if (killed.signal !== 'SIGKILL') {
            failures.push(`${label}: child was not killed (${String(killed.signal ?? killed.status)}): ${killed.stderr}`)
            return
          }
          for (const violation of checkAtKill(p, sentinel)) failures.push(`${label}: ${violation}`)
          const planted = c.intruder === true && plantIntruder(p.f.home)
          const effects = harnessEffects(p.setup, c.faults)
          let ended = await driveMove(p.setup, p.target, c.healthy, effects)
          if (ended === 'blocked') {
            if (!planted || expectMoved(c)) failures.push(`${label}: blocked without a directory in the way`)
            for (const violation of checkBlocked(p, c)) failures.push(`${label}: blocked: ${violation}`)
            // The person moves the other directory away and chooses to go back.
            await rm(p.f.home, { recursive: true, force: true })
            ended = await driveMove(p.setup, p.target, c.healthy, effects, () => {}, () => 'rollback')
          }
          for (const violation of checkAtEnd(p, c, ended, planted)) failures.push(`${label}: ${violation}`)
          if (JSON.stringify(listTree(p.f.sentinel)) !== JSON.stringify(sentinel)) failures.push(`${label}: the sentinel changed`)
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        } finally {
          await dispose(p.f)
        }
      })
      expect(failures).toEqual([])
    }, SCENARIO_TIMEOUT_MS)
  })
})

/** Scenarios that start from a rollback blocked by a directory a terminal made at the old path. */
const CHOICE_CASES: Case[] = [
  { name: 'another volume, keep the new location', sameVolume: false, start: 'default-home', healthy: true, choose: 'keep-target' },
  { name: 'another volume, go back once the old path is free', sameVolume: false, start: 'default-home', healthy: true, choose: 'rollback' },
  { name: 'one volume, keep the new location', sameVolume: true, start: 'default-home', healthy: true, choose: 'keep-target' },
  { name: 'one volume, go back once the old path is free', sameVolume: true, start: 'default-home', healthy: true, choose: 'rollback' },
  { name: 'another volume, keep the new location, which fails again', sameVolume: false, start: 'default-home', healthy: false, choose: 'keep-target' },
  { name: 'one volume, keep the new location, which fails again', sameVolume: true, start: 'default-home', healthy: false, choose: 'keep-target' },
]

/**
 * A move blocked while rolling back: switched, a terminal made the old path,
 * the health check failed. For a rollback choice the other directory is then
 * moved away, so the move waits only for the choice.
 * @param c - the scenario.
 * @returns the move.
 */
async function prepareBlocked(c: Case): Promise<Prepared> {
  const p = await prepare(c)
  const effects = harnessEffects(p.setup)
  expect(await advanceMove(p.setup.dir, effects, { pid: process.pid })).toEqual({ kind: 'switched' })
  expect(plantIntruder(p.f.home)).toBe(true)
  recordHealth(p.setup.dir, false)
  expect(await advanceMove(p.setup.dir, effects, { pid: process.pid })).toMatchObject({ kind: 'blocked', reason: 'source-occupied' })
  if (c.choose === 'rollback') await rm(p.f.home, { recursive: true, force: true })
  return p
}

posixOnly('a choice made on a blocked move, killed at any step', () => {
  CHOICE_CASES.forEach((c) => {
    it(`resumes to a consistent end: ${c.name}`, async () => {
      const counting = await prepareBlocked(c)
      let events: string[]
      try {
        const run = await runChild(counting, c, 0)
        expect(run.stderr).toBe('')
        expect(run.status).toBe(0)
        expect(checkAtEnd(counting, c, run.ended, c.choose === 'keep-target')).toEqual([])
        events = run.events
      } finally {
        await dispose(counting.f)
      }
      const failures: string[] = []
      await pool(events.map((_, index) => index + 1), CONCURRENCY, async (killAt) => {
        const label = `kill ${String(killAt)} (${events[killAt - 1] ?? '?'})`
        const p = await prepareBlocked(c)
        try {
          const sentinel = listTree(p.f.sentinel)
          const killed = await runChild(p, c, killAt)
          if (killed.signal !== 'SIGKILL') {
            failures.push(`${label}: child was not killed (${String(killed.signal ?? killed.status)}): ${killed.stderr}`)
            return
          }
          for (const violation of checkAtKill(p, sentinel)) failures.push(`${label}: ${violation}`)
          const ended = await driveMove(p.setup, p.target, c.healthy, harnessEffects(p.setup), () => {}, () => c.choose)
          for (const violation of checkAtEnd(p, c, ended, c.choose === 'keep-target')) failures.push(`${label}: ${violation}`)
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
        } finally {
          await dispose(p.f)
        }
      })
      expect(failures).toEqual([])
    }, SCENARIO_TIMEOUT_MS)
  })
})
