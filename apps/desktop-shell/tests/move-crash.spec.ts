/**
 * A data move killed with SIGKILL after any one of its disk operations, then
 * resumed. Each scenario first runs once without a kill to number its events;
 * every event that is not a copy or check progress report is then a kill
 * point, together with a seeded sample of progress reports.
 *
 * After each kill: at most one of the four directories is this data (its
 * identity marker and no move marker); a pointer that names a directory names
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
import { chmodSync, existsSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { readJournal, type MoveJournal } from '../src/move/journal.ts'
import { startMove } from '../src/move/run.ts'
import { MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES } from '../src/move/tree.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'
import { driveMove, HARNESS_ID, harnessEffects, prepareMove, terminalValue, type MoveSetup, type Start } from './move-harness.ts'
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
  healthy: boolean
}

const CASES: Case[] = [
  { name: 'another volume, health check passes', sameVolume: false, start: 'pointer', healthy: true },
  { name: 'another volume, health check fails, ~/.dsh was the home', sameVolume: false, start: 'default-home', healthy: false },
  { name: 'one volume, health check passes', sameVolume: true, start: 'pointer', healthy: true },
  { name: 'one volume, health check fails', sameVolume: true, start: 'pointer', healthy: false },
]

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
  const f = await buildFixture({ bigBytes: 200_000 })
  const target = join(f.targetParent, 'DSH-Data')
  const setup = prepareMove({ root: f.root, home: f.home, target, sameVolume: c.sameVolume, start: c.start })
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
  const input: ChildInput = { setup: p.setup, target: p.target, healthy: c.healthy, killAt }
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
 * Whether a directory is this data: it carries the identity and no move marker.
 * @param dir - the directory.
 * @returns true when it does.
 */
function isOurData(dir: string): boolean {
  const idFile = join(dir, '.dsh-data-id')
  if (!existsSync(idFile) || existsSync(join(dir, MOVE_STATE_FILENAME))) return false
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
 * @returns every violation, as sentences.
 */
function checkAtEnd(p: Prepared, c: Case, ended: string | undefined): string[] {
  const violations: string[] = []
  if (existsSync(join(p.setup.dir, 'journal.json'))) violations.push('the journal is still there')
  const result = JSON.parse(readFileSync(join(p.setup.dir, 'last-result.json'), 'utf8')) as { outcome: string }
  if (ended !== 'none' && ended !== result.outcome) violations.push(`the run said ${String(ended)}, the result file ${result.outcome}`)
  for (const gone of [p.partial, p.hidden]) {
    if (existsSync(gone)) violations.push(`${gone} is still there`)
  }
  if (c.healthy) {
    if (result.outcome !== 'moved') violations.push(`the move ended ${result.outcome}`)
    if (existsSync(p.f.home)) violations.push('the source is still there')
    if (!isOurData(p.target)) violations.push('the target is not this data')
    else if (JSON.stringify(dataFiles(listTree(p.target))) !== JSON.stringify(dataFiles(p.before))) violations.push('the target data differs')
    const pointer = JSON.parse(readFileSync(join(p.setup.userData, 'data-location.json'), 'utf8')) as { path: string }
    if (pointer.path !== p.target) violations.push(`the pointer names ${pointer.path}`)
    if (terminalValue(p.setup) !== p.target) violations.push('the terminal does not name the target')
  } else {
    if (result.outcome !== 'failed') violations.push(`the move ended ${result.outcome}`)
    if (JSON.stringify(listTree(p.f.home)) !== JSON.stringify(p.before)) violations.push('the source is not as it was')
    if (existsSync(p.target)) violations.push('the target is still there')
    const main = join(p.setup.userData, 'data-location.json')
    const now = existsSync(main) ? readFileSync(main, 'utf8') : undefined
    if (now !== p.setup.start.pointerBefore.main) violations.push('the pointer is not as it was')
    const terminal = p.setup.start.terminalBefore
    if (terminalValue(p.setup) !== (terminal.kind === 'set' ? terminal.value : '')) violations.push('the terminal is not as it was')
    if (c.start === 'pointer' && readlinkSync(p.setup.defaultHome) !== p.f.home) violations.push('~/.dsh does not link to the source')
  }
  return violations
}

/**
 * The kill points of a scenario: every event other than a progress report,
 * and a seeded sample of progress reports.
 * @param events - the events of an uninterrupted run.
 * @param seed - the sample's seed.
 * @returns event numbers, 1-based.
 */
function killPoints(events: readonly string[], seed: number): number[] {
  const points: number[] = []
  const progress: number[] = []
  events.forEach((label, index) => {
    if (label.endsWith(' progress')) progress.push(index + 1)
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
        expect(checkAtEnd(counting, c, run.ended)).toEqual([])
        events = run.events
      } finally {
        await dispose(counting.f)
      }
      const failures: string[] = []
      const points = killPoints(events, 20_260_927 + index)
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
          const ended = await driveMove(p.setup, p.target, c.healthy, harnessEffects(p.setup))
          for (const violation of checkAtEnd(p, c, ended)) failures.push(`${label}: ${violation}`)
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
