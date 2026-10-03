/**
 * What a launch does about a data move before it settles the data location,
 * and the health check it runs on the new location. The decisions are plain
 * functions of the journal and the disk; the application window and the
 * server are the caller's (`main.ts`).
 *
 * - No journal: an ordinary launch.
 * - A journal that cannot be read: the server does not start; the boot page
 *   names the file.
 * - `switched`: the server starts on the new location, and the health check
 *   runs before the interface is shown ({@link launchOnSwitchedMove}); a
 *   start that fails rolls the move back like a failed check.
 * - `cleanup`: an ordinary launch; the old copy is deleted in the background
 *   once the interface is shown.
 * - Any other phase: the server does not start ({@link mayStartServer}); the
 *   progress window carries the move on (or the blocked page asks), and the
 *   application relaunches when it ends.
 * @module @deepseek-ai/dsh-desktop-shell/move-boot
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME, profileDirectory, readMigrationMarker } from './profile-seed.ts'
import {
  JOURNAL_FILENAME, JournalError, mayStartServer, readJournal, type MoveBaseline, type MoveJournal, type MoveResult,
} from './move/journal.ts'
import { releaseMoveLock, type LockSelf } from './move/lock.ts'
import type { HealthFailure, HealthFailures } from './move/executor.ts'
import { recordHealth, type MoveOutcome } from './move/run.ts'
import type { TreeCheck } from './process-tree.ts'

/** What a launch does about the move on disk. */
export type BootMove =
  | { kind: 'none' }
  | { kind: 'unreadable'; path: string; detail: string }
  | { kind: 'health-check'; journal: MoveJournal }
  | { kind: 'cleanup'; journal: MoveJournal }
  | { kind: 'resume'; journal: MoveJournal }
  /**
   * A move asked for that had not started copying. A crash can leave it with
   * processes the server started still running, which the move never
   * checked, so the launch withdraws it instead of resuming it.
   */
  | { kind: 'requested'; journal: MoveJournal }
  /** A move that never started copying could not be withdrawn; the launch stops without starting the server. */
  | { kind: 'withdraw-failed'; path: string; detail: string }

/**
 * Decide what this launch does about the move recorded in `dir`.
 * @param dir - the move directory.
 * @returns the decision.
 * @throws what reading the journal throws other than a {@link JournalError}.
 */
export function bootMove(dir: string): BootMove {
  let journal: MoveJournal | undefined
  try {
    journal = readJournal(dir)
  } catch (error) {
    if (!(error instanceof JournalError)) throw error
    return { kind: 'unreadable', path: join(dir, JOURNAL_FILENAME), detail: error.message }
  }
  if (journal === undefined) return { kind: 'none' }
  if (journal.phase === 'requested') return { kind: 'requested', journal }
  if (!mayStartServer(journal)) return { kind: 'resume', journal }
  return journal.phase === 'switched' ? { kind: 'health-check', journal } : { kind: 'cleanup', journal }
}

/**
 * Removals of the old copy that must each have left something behind before
 * Settings says so and offers to try again: until then every launch retries
 * in the background, and a file a program held open is usually free by then.
 */
export const CLEANUP_PROMPT_AFTER = 3

/**
 * What Settings says about a finished move's cleanup: the bytes the last
 * removal left, once {@link CLEANUP_PROMPT_AFTER} removals in a row left
 * something.
 * @param dir - the move directory.
 * @returns the bytes left, or undefined when there is nothing to say (no journal, another phase, too few attempts,
 * or a journal that cannot be read).
 */
export function cleanupPrompt(dir: string): { leftoverBytes: number } | undefined {
  const boot = bootMove(dir)
  if (boot.kind !== 'cleanup') return undefined
  const { cleanupAttempts, cleanupLeftoverBytes } = boot.journal
  return cleanupAttempts >= CLEANUP_PROMPT_AFTER && cleanupLeftoverBytes > 0 ? { leftoverBytes: cleanupLeftoverBytes } : undefined
}

/**
 * The move facts `/state` carries.
 * @param dir - the move directory.
 * @param cleanupRunning - whether this launch is removing a finished move's old copy right now.
 * @returns whether a move is recorded; whether the journal is in the cleanup phase ({@link bootMove} answers
 * `cleanup`) with the old copy's removal running now (`cleanupRunning`) or waiting for the next launch or a retry
 * (`cleanupWaiting`), both false in every other phase; and the cleanup prompt, when {@link cleanupPrompt} has one.
 */
export function moveFacts(dir: string, cleanupRunning: boolean): {
  moving: boolean
  cleanupRunning: boolean
  cleanupWaiting: boolean
  cleanup?: { leftoverBytes: number }
} {
  const moving = existsSync(join(dir, JOURNAL_FILENAME))
  const inCleanup = bootMove(dir).kind === 'cleanup'
  const cleanup = cleanupPrompt(dir)
  return {
    moving,
    cleanupRunning: inCleanup && cleanupRunning,
    cleanupWaiting: inCleanup && !cleanupRunning,
    ...cleanup === undefined ? {} : { cleanup },
  }
}

/**
 * Record a passed health check and give back the lock at the new location:
 * on one volume the data was renamed there with its lock, and the cleanup
 * that follows neither needs it nor refreshes it, so it would otherwise age
 * into a lock another installation reads as an unfinished move. The hidden
 * original's lock goes with the original when the cleanup deletes it.
 * The server already runs by then, so a lock that cannot be removed is only
 * logged: it ages, and the cleanup's end removes it with the others.
 * @param dir - the move directory.
 * @param self - this installation.
 * @param log - the desktop log sink.
 * @throws when there is no journal in phase `switched`.
 */
export function passHealthCheck(dir: string, self: Pick<LockSelf, 'userData'>, log: (line: string) => void): void {
  const journal = readJournal(dir)
  recordHealth(dir, true)
  if (journal === undefined) return
  try {
    releaseMoveLock([journal.target], self)
  } catch (error) {
    log(`[desktop] data move: could not give back the lock at ${journal.target}: ${String(error)}\n`)
  }
}

/**
 * The session directories in a Harness home: `sessions/<project>/<session>`.
 * @param home - the Harness home.
 * @returns how many there are; zero when there is no `sessions` folder.
 * @throws when a folder exists but cannot be read.
 */
export function countSessions(home: string): number {
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
  const sessions = join(home, 'sessions')
  return list(sessions).reduce((total, project) => total + list(join(sessions, project)).length, 0)
}

/**
 * The plugins the desktop profile has quarantined after they failed to load.
 * @param home - the Harness home.
 * @returns their names, sorted.
 */
export function quarantinedPlugins(home: string): string[] {
  const marker = readMigrationMarker(join(profileDirectory(home, DESKTOP_PROFILE), MIGRATION_MARKER_FILENAME))
  return (marker?.defective ?? []).filter(entry => entry.kind === 'load-failed').map(entry => entry.name).sort()
}

/** What the health check measured on the new location. */
export interface HealthReading {
  sessions: number
  quarantined: readonly string[]
  /** Workspace records the server reported; absent when none reported. */
  workspaces?: number
}

/**
 * The health check's verdict. `detail` says what was checked, or why the
 * check failed, for the log and the journal; `failures` names each problem.
 */
export type HealthVerdict =
  | { healthy: true; detail: string }
  | { healthy: false; detail: string; failures: HealthFailures }

/**
 * Compare the new location with the baseline recorded before the move: no
 * fewer sessions, no plugin newly quarantined, and the same number of
 * workspace records when both counts are known.
 * @param baseline - the counts before the move.
 * @param reading - the counts now.
 * @returns the verdict.
 */
export function checkHealth(baseline: MoveBaseline, reading: HealthReading): HealthVerdict {
  const problems: { failure: HealthFailure; detail: string }[] = []
  if (reading.sessions < baseline.sessions) {
    problems.push({ failure: 'fewer-sessions', detail: `sessions ${String(reading.sessions)} < ${String(baseline.sessions)}` })
  }
  const added = reading.quarantined.filter(name => !baseline.quarantined.includes(name))
  if (added.length > 0) problems.push({ failure: 'plugin-quarantined', detail: `newly quarantined: ${added.join(', ')}` })
  const compared = baseline.workspaces !== undefined && reading.workspaces !== undefined
  if (compared && reading.workspaces !== baseline.workspaces) {
    problems.push({ failure: 'workspaces-differ', detail: `workspaces ${String(reading.workspaces)} != ${String(baseline.workspaces)}` })
  }
  const [first, ...rest] = problems
  if (first !== undefined) {
    return {
      healthy: false,
      detail: problems.map(problem => problem.detail).join('; '),
      failures: [first.failure, ...rest.map(problem => problem.failure)],
    }
  }
  return {
    healthy: true,
    detail: `sessions ${String(reading.sessions)} >= ${String(baseline.sessions)}; no plugin newly quarantined; `
      + (compared ? 'workspaces equal' : 'workspaces not compared (no count)'),
  }
}

/** What a launch on a move in phase `switched` needs from the application. */
export interface SwitchedLaunch<Started> {
  /**
   * Prepare the new location and start the server on it, from the profile
   * seeding to the server's URL line; rejects when the start fails up to the
   * URL line. The seeding and the settings migration do not reject: they log
   * their own failures and go on.
   */
  start: () => Promise<Started>
  /** What the health check measures on the new location; throws when it cannot be read. */
  read: () => HealthReading
  /**
   * Stop the server and the processes it started that can still be found.
   * After a start that failed, that is a server still running and its tree,
   * but not a server that already exited nor what it started.
   */
  stopServerTree: () => Promise<TreeCheck>
  /**
   * Record the failure and carry the rollback in the move's window; resolves
   * once the application is on its way out. `detail` is what the journal and
   * the log record, `failures` what the page after a kept new location names.
   */
  rollBack: (detail: string, failures: HealthFailures) => Promise<void>
  /** Record the passed check ({@link passHealthCheck}). */
  pass: () => void
  log: (line: string) => void
}

/** Outcome of {@link launchOnSwitchedMove}. */
export type SwitchedLaunchOutcome<Started> =
  | { kind: 'healthy'; started: Started }
  /** The move was rolled back, and the application is on its way out. */
  | { kind: 'rolled-back' }

/**
 * Start the server on the location a move switched to and check it there
 * ({@link checkHealth}) before the interface is shown. A start that fails, a
 * location that cannot be read, and a check that fails end the same way: the
 * server and the processes it started that can still be found are stopped
 * ({@link SwitchedLaunch.stopServerTree}), then the failure is recorded and
 * the move rolled back. The stop comes first because recording the failure
 * prints the new location, which nothing should still write to; a stop that
 * throws is logged and the rollback goes on, since the print only chooses
 * what the person is told.
 * @param baseline - the counts recorded before the move.
 * @param deps - the start, the reading, the stop, the rollback, the record of a pass, and the log.
 * @returns the started server once the check passed, or `rolled-back`.
 * @throws what the rollback or the record of a pass throws.
 */
export async function launchOnSwitchedMove<Started>(
  baseline: MoveBaseline, deps: SwitchedLaunch<Started>,
): Promise<SwitchedLaunchOutcome<Started>> {
  const fail = async (detail: string, failures: HealthFailures): Promise<SwitchedLaunchOutcome<Started>> => {
    deps.log(`[desktop] data move: health check failed: ${detail}\n`)
    try {
      await deps.stopServerTree()
    } catch (error) {
      deps.log(`[desktop] data move: could not stop the server before the rollback: ${String(error)}\n`)
    }
    await deps.rollBack(detail, failures)
    return { kind: 'rolled-back' }
  }
  let started: Started
  try {
    started = await deps.start()
  } catch (error) {
    return await fail(`the server did not start on the new location: ${firstLine(error)}`, ['not-started'])
  }
  let verdict: HealthVerdict
  try {
    verdict = checkHealth(baseline, deps.read())
  } catch (error) {
    return await fail(`the new location could not be read: ${firstLine(error)}`, ['unreadable'])
  }
  if (!verdict.healthy) return await fail(verdict.detail, verdict.failures)
  deps.log(`[desktop] data move: health check passed: ${verdict.detail}\n`)
  deps.pass()
  return { kind: 'healthy', started }
}

/**
 * The first line of what was thrown, for a failure the journal records.
 * @param error - what was thrown.
 * @returns its message's first line.
 */
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}

/**
 * The data directory the application relaunches onto after the executor
 * returned: the new location once the move switched or finished there, the
 * original after it was cancelled or undone. A blocked move and a cleanup
 * that left something behind do not relaunch.
 * @param journal - the journal as the executor started from it.
 * @param outcome - what the executor returned.
 * @returns the directory, or `undefined` when there is no relaunch.
 */
export function relaunchHome(journal: MoveJournal, outcome: MoveOutcome): string | undefined {
  switch (outcome.kind) {
    case 'switched':
      return journal.target
    case 'ended':
      return outcome.result.outcome === 'moved' ? outcome.result.target : outcome.result.source
    case 'blocked':
    case 'cleanup-incomplete':
      return undefined
    default:
      return outcome satisfies never
  }
}

/**
 * Every place the move lock may be once a move has ended: it was taken in the
 * original and travels with it (renamed to the new location on one volume,
 * hidden beside the old path, or kept or retired into a visible folder).
 * @param journal - the journal as the executor started from it.
 * @param result - how the move ended, when it ended.
 * @returns the directories to release the lock in.
 */
export function lockPlaces(journal: MoveJournal, result?: MoveResult): string[] {
  const places = [journal.source, journal.target, journal.hidden]
  if (result?.unusedCopy !== undefined) places.push(result.unusedCopy.path)
  if (result?.keptOriginal !== undefined) places.push(result.keptOriginal.path)
  return places
}
