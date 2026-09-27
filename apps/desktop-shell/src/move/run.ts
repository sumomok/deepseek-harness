/**
 * Carrying out a data move one step at a time from its journal.
 *
 * {@link advanceMove} reads the journal, looks at the disk, asks
 * [[@deepseek-ai/dsh-desktop-shell/move/journal]]'s `nextAction` what to do,
 * does that one step, records the new phase durably, and repeats until the move
 * needs the application: `switched` (relaunch or continue onto the new
 * location, start the server, then call {@link recordHealth}), `ended` (the
 * move is over; the result says how), or `cleanup-incomplete` (the old copy is
 * not fully deleted yet; try again later). An interruption anywhere is
 * resumed by calling it again: every step is repeatable.
 *
 * Everything that changes the disk goes through {@link MoveEffects}: the
 * directory operations on the source, the copy, the target, and the hidden
 * source ({@link MoveFs}), the copy and the check, removal, the pointer, the
 * terminal, and `~/.dsh`. The application passes the real ones; tests replace
 * them, and the crash tests stop the process after any one of them.
 *
 * Failures before the source is hidden give the move up (the copy is deleted,
 * the source was never touched); failures while hiding the source or switching
 * roll it back; failures while giving up or rolling back are thrown and the
 * next call continues. Cancelling is honored only while the copy is still a
 * partial folder.
 * @module @deepseek-ai/dsh-desktop-shell/move/run
 */

import {
  lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { writeDurably } from '../durable-file.ts'
import {
  DATA_ID_FILENAME, POINTER_BACKUP_FILENAME, POINTER_FILENAME, POINTER_VERSION, writePointer, type DataLocationPointer,
} from '../data-location.ts'
import { NODE_LINK_FS, type LinkFs } from '../home-link.ts'
import type { ExplicitRead } from '../terminal-env.ts'
import { copyTree, forgetDone, planLinkResolved, removeExtra, type ByteProgress, type CopyRequest } from './copier.ts'
import {
  CANCELLABLE_PHASES, DONE_LOG_FILENAME, JOURNAL_FILENAME, JournalError, MAX_REPAIR_ROUNDS, MOVED_ID_FILENAME, newJournal, nextAction,
  readJournal, RESULT_FILENAME, writeJournal,
  type DirFacts, type HomeLinkBefore, type MoveAction, type MoveFacts, type MoveJournal, type MovePhase, type MoveResult,
  type MoveStart, type PointerBefore,
} from './journal.ts'
import { rewriteInPlace, type InPlaceRewrite, type LinkMove, type RewriteOutcome } from './links.ts'
import { REMOVE_ATTEMPTS, REMOVE_FIRST_DELAY_MS, removeTree, type RemoveReport } from './remove.ts'
import { MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES, scanTree } from './tree.ts'
import { verifyTree, type VerifyProblem, type VerifyRequest } from './verify.ts'

/** What an entry is, without following a link. */
export type EntryKind = 'absent' | 'dir' | 'file' | 'link' | 'other'

/** The directory operations a move makes on its four directories. */
export interface MoveFs {
  kind: (path: string) => EntryKind
  /** A small file's text, or `undefined` when it does not exist. */
  readText: (path: string) => string | undefined
  readdir: (path: string) => string[]
  /** Replace a small file durably, owner-only. */
  writeFile: (path: string, content: string) => void
  rename: (from: string, to: string) => void
  unlink: (path: string) => void
  mkdir: (path: string) => void
  rmdir: (path: string) => void
}

/** The real directory operations. */
export const NODE_MOVE_FS: MoveFs = {
  kind: (path) => {
    let stats
    try {
      stats = lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'
      throw error
    }
    if (stats.isSymbolicLink()) return 'link'
    if (stats.isDirectory()) return 'dir'
    return stats.isFile() ? 'file' : 'other'
  },
  readText: (path) => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
      throw error
    }
  },
  readdir: path => readdirSync(path),
  writeFile: (path, content) => { writeDurably(path, Buffer.from(content), 0o600) },
  rename: (from, to) => { renameSync(from, to) },
  unlink: (path) => { unlinkSync(path) },
  mkdir: (path) => { mkdirSync(path, { mode: 0o700 }) },
  rmdir: (path) => { rmdirSync(path) },
}

/** Everything a move does to the disk and to the rest of the application. */
export interface MoveEffects {
  platform: NodeJS.Platform
  fs: MoveFs
  /** Copy the source into the partial folder; the app runs it on a worker thread. */
  copy: (request: CopyRequest, signal: AbortSignal, onProgress: (progress: ByteProgress) => void) => Promise<void>
  /** Check the partial folder against the source. */
  verify: (request: VerifyRequest, signal: AbortSignal, onProgress: (progress: ByteProgress) => void) => Promise<VerifyProblem[]>
  /** Delete a tree without following links. */
  remove: (path: string) => Promise<RemoveReport>
  /** The links in the source, for a rename on one volume. */
  scanLinks: (source: string) => Promise<Array<{ rel: string; target: string }>>
  /** Point one link at its new place, or back. */
  rewriteLink: (root: string, rewrite: InPlaceRewrite) => RewriteOutcome
  writePointer: (pointer: DataLocationPointer) => void
  /** Put the pointer's two files back as they were, deleting any that did not exist. */
  restorePointer: (before: PointerBefore) => void
  /**
   * Write the target as the terminal's `DSH_HOME` and read it back (phase 1's
   * terminal sync).
   * @returns the `lastSeenEnv` the pointer records afterwards; `undefined` for none.
   */
  syncTerminal: (target: string) => Promise<string | undefined>
  /** Put the terminal's `DSH_HOME` back as it was read before the move. */
  restoreTerminal: (before: ExplicitRead) => Promise<void>
  /** Put `~/.dsh` back: remove the link to the target, recreate a link that was there. */
  restoreHomeLink: (before: HomeLinkBefore) => void
  sleep: (ms: number) => Promise<void>
  now: () => Date
}

/** Where a move stands, for the progress window. */
export interface MoveProgress {
  stage: 'copying' | 'checking' | 'finishing'
  phase: MovePhase
  /** Bytes handled, while copying or checking. */
  done?: number
  total?: number
}

/** Why {@link advanceMove} returned. */
export type MoveOutcome =
  | { kind: 'switched' }
  | { kind: 'ended'; result: MoveResult }
  | { kind: 'cleanup-incomplete'; attempts: number; leftoverBytes: number }

/** Options of {@link advanceMove}. */
export interface AdvanceOptions {
  /** The person asked to cancel; honored only while the copy is partial. */
  cancel?: AbortSignal
  onProgress?: (progress: MoveProgress) => void
  /** The running process, recorded in the journal. */
  pid: number
}

/** Thrown when a step changes nothing, so repeating it would never end. */
export class MoveStuckError extends Error {
  /** @param detail - the step and the facts it saw. */
  constructor(detail: string) {
    super(`data move made no progress: ${detail}`)
    this.name = 'MoveStuckError'
  }
}

/**
 * Start a move: write its journal in phase `requested`, and a fresh done log.
 * @param dir - the move directory; created when missing.
 * @param start - the paths and what to restore.
 * @param options - the process id and the clock.
 * @returns the journal.
 * @throws when a move is already recorded, or the journal cannot be written.
 */
export function startMove(dir: string, start: MoveStart, options: { pid: number; now: Date }): MoveJournal {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (readJournal(dir) !== undefined) throw new JournalError('journal: a move is already in progress')
  const journal = newJournal(start, options)
  unlinkIfPresent(join(dir, DONE_LOG_FILENAME))
  writeJournal(dir, journal)
  return journal
}

/**
 * Record the health check of the first launch on the new location.
 * @param dir - the move directory.
 * @param healthy - whether it passed.
 * @param detail - why it failed.
 * @throws when there is no journal in phase `switched`.
 */
export function recordHealth(dir: string, healthy: boolean, detail = 'the health check failed'): void {
  const journal = readJournal(dir)
  if (journal?.phase !== 'switched') throw new JournalError(`journal: no move awaits a health check (phase ${String(journal?.phase)})`)
  writeJournal(dir, healthy
    ? { ...journal, phase: 'cleanup' }
    : { ...journal, phase: 'rolling-back', failure: { phase: 'switched', detail } })
}

/**
 * Remove a file when it is there.
 * @param path - the file.
 * @throws when it exists and cannot be removed.
 */
function unlinkIfPresent(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * What is at one directory of the move.
 * @param fs - the directory operations.
 * @param path - the directory.
 * @param journal - for the identity and the move id.
 * @returns its facts.
 */
function dirFacts(fs: MoveFs, path: string, journal: MoveJournal): DirFacts {
  const kind = fs.kind(path)
  if (kind !== 'dir') return { exists: kind !== 'absent', dataId: 'none', movedId: false, state: 'none', empty: false }
  const id = fs.readText(join(path, DATA_ID_FILENAME))?.trim()
  const state = fs.readText(join(path, MOVE_STATE_FILENAME))?.trim()
  return {
    exists: true,
    dataId: id === undefined ? 'none' : id === journal.dataId ? 'ours' : 'other',
    movedId: fs.readText(join(path, MOVED_ID_FILENAME)) !== undefined,
    state: state === undefined ? 'none' : state === journal.moveId ? 'ours' : 'other',
    empty: fs.readdir(path).length === 0,
  }
}

/**
 * Look at the four directories.
 * @param fs - the directory operations.
 * @param journal - the journal naming them.
 * @returns the facts.
 */
export function observeMove(fs: MoveFs, journal: MoveJournal): MoveFacts {
  return {
    source: dirFacts(fs, journal.source, journal),
    partial: dirFacts(fs, journal.partial, journal),
    target: dirFacts(fs, journal.target, journal),
    hidden: dirFacts(fs, journal.hidden, journal),
  }
}

/** Phases whose failure gives the move up, the source untouched. */
const ABANDON_ON_FAILURE: ReadonlySet<MovePhase> = new Set(['requested', 'copying', 'verifying', 'catching-up', 'finalizing'])
/** Phases whose failure rolls the move back. */
const ROLL_BACK_ON_FAILURE: ReadonlySet<MovePhase> = new Set(['hiding-source', 'switching'])

/**
 * Carry the move forward until it needs the application.
 * @param dir - the move directory.
 * @param effects - everything the move does.
 * @param options - the cancel signal, the progress callback, and the process id.
 * @returns why it stopped.
 * @throws when there is no journal, it is invalid, a step while giving up or rolling back fails, or a step makes no progress.
 */
export async function advanceMove(dir: string, effects: MoveEffects, options: AdvanceOptions): Promise<MoveOutcome> {
  let journal = readJournal(dir)
  if (journal === undefined) throw new JournalError('journal: no move in progress')
  const fs = effects.fs
  const save = (next: MoveJournal): void => {
    writeJournal(dir, next)
    journal = next
  }
  if (journal.pid !== options.pid) save({ ...journal, pid: options.pid })
  const cancel = options.cancel ?? new AbortController().signal
  let previous = ''
  for (;;) {
    const current: MoveJournal = journal
    const facts = observeMove(fs, current)
    const action = nextAction(current, facts, cancel.aborted)
    const key = JSON.stringify({ current, facts, action })
    if (key === previous) throw new MoveStuckError(`${current.phase}: ${action.kind}`)
    previous = key
    let outcome: MoveOutcome | undefined
    try {
      outcome = await perform(action, current, { dir, effects, cancel, save, options })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (CANCELLABLE_PHASES.has(current.phase) && cancel.aborted) {
        save({ ...current, phase: 'cancelling' })
      } else if (ABANDON_ON_FAILURE.has(current.phase)) {
        save({ ...current, phase: 'abandoning', failure: { phase: current.phase, detail } })
      } else if (ROLL_BACK_ON_FAILURE.has(current.phase)) {
        save({ ...current, phase: 'rolling-back', failure: { phase: current.phase, detail } })
      } else {
        throw error
      }
      continue
    }
    if (outcome !== undefined) return outcome
  }
}

/** What {@link perform} works with. */
interface StepContext {
  dir: string
  effects: MoveEffects
  cancel: AbortSignal
  save: (journal: MoveJournal) => void
  options: AdvanceOptions
}

/**
 * The copy request of a move.
 * @param journal - the journal.
 * @param dir - the move directory.
 * @param platform - the platform.
 * @returns the request.
 */
export function copyRequestOf(journal: MoveJournal, dir: string, platform: NodeJS.Platform): CopyRequest {
  return {
    source: journal.source,
    dest: journal.partial,
    exclude: [...REBUILDABLE_ENTRIES, DATA_ID_FILENAME, MOVE_STATE_FILENAME, MOVED_ID_FILENAME],
    links: linkMoveOf(journal, platform),
    doneLog: join(dir, DONE_LOG_FILENAME),
  }
}

/**
 * How links move in this move.
 * @param journal - the journal.
 * @param platform - the platform.
 * @returns the link move.
 */
function linkMoveOf(journal: MoveJournal, platform: NodeJS.Platform): LinkMove {
  return { sourceRoots: journal.sourceAliases, destRoot: journal.target, platform }
}

/**
 * Rename, retrying on Windows while another program holds the entry open.
 * @param effects - the directory operations and the wait.
 * @param from - the old path.
 * @param to - the new path.
 * @throws the last error when every attempt failed.
 */
async function renameWithRetry(effects: MoveEffects, from: string, to: string): Promise<void> {
  let wait = REMOVE_FIRST_DELAY_MS
  for (let tries = 1; ; tries += 1) {
    try {
      effects.fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      const busy = effects.platform === 'win32' && (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES')
      if (!busy || tries >= REMOVE_ATTEMPTS) throw error
    }
    await effects.sleep(wait)
    wait *= 2
  }
}

/**
 * The problems a failed check reports, in a sentence.
 * @param problems - the problems.
 * @returns the first few, named.
 */
function describeProblems(problems: readonly VerifyProblem[]): string {
  const shown = problems.slice(0, 5).map(problem => `${problem.kind} ${problem.rel}`).join(', ')
  return problems.length > 5 ? `${shown}, and ${String(problems.length - 5)} more` : shown
}

/**
 * Do one step.
 * @param action - the step.
 * @param journal - the journal before it.
 * @param context - the move directory, the effects, and the journal writer.
 * @returns an outcome when the move now needs the application.
 */
async function perform(action: MoveAction, journal: MoveJournal, context: StepContext): Promise<MoveOutcome | undefined> {
  const { dir, effects, cancel, save } = context
  const fs = effects.fs
  const progress = (stage: MoveProgress['stage'], bytes?: ByteProgress): void => {
    context.options.onProgress?.({ stage, phase: journal.phase, ...bytes === undefined ? {} : { done: bytes.done, total: bytes.total } })
  }
  const phase = (next: MovePhase, changes: Partial<MoveJournal> = {}): void => { save({ ...journal, ...changes, phase: next }) }
  switch (action.kind) {
    case 'abandon':
      phase('abandoning', { failure: { phase: journal.phase, detail: action.detail } })
      return undefined
    case 'cancel':
      phase('cancelling')
      return undefined
    case 'plan-links': {
      const move = linkMoveOf(journal, effects.platform)
      const rewrites: InPlaceRewrite[] = []
      for (const link of await effects.scanLinks(journal.source)) {
        const plan = planLinkResolved(link.target, link.rel, move)
        if (plan.kind === 'rewrite') rewrites.push({ rel: link.rel, from: link.target, to: plan.target })
      }
      phase('hiding-source', { linkRewrites: rewrites })
      return undefined
    }
    case 'set-phase':
      phase(action.phase)
      return undefined
    case 'create-partial':
      if (fs.kind(journal.partial) === 'absent') fs.mkdir(journal.partial)
      fs.writeFile(join(journal.partial, MOVE_STATE_FILENAME), journal.moveId)
      return undefined
    case 'copy':
      progress('copying')
      await effects.copy(copyRequestOf(journal, dir, effects.platform), cancel, (bytes) => { progress('copying', bytes) })
      phase('verifying')
      return undefined
    case 'verify': {
      progress('checking')
      const request: VerifyRequest = { ...copyRequestOf(journal, dir, effects.platform), hash: action.hash }
      const problems = await effects.verify(request, cancel, (bytes) => { progress('checking', bytes) })
      if (problems.length === 0) {
        phase(action.then)
        return undefined
      }
      if (journal.repairRounds >= MAX_REPAIR_ROUNDS) {
        phase('abandoning', { failure: { phase: journal.phase, detail: `the copy does not match: ${describeProblems(problems)}` } })
        return undefined
      }
      for (const problem of problems) {
        if (problem.kind === 'extra') await removeExtra(journal.partial, problem.rel, effects.platform)
      }
      forgetDone(request.doneLog, new Set(problems.filter(problem => problem.kind !== 'extra').map(problem => problem.rel)))
      phase('copying', { repairRounds: journal.repairRounds + 1 })
      return undefined
    }
    case 'remove-empty-target':
      fs.rmdir(journal.target)
      return undefined
    case 'rename-partial-to-target':
      progress('finishing')
      await renameWithRetry(effects, journal.partial, journal.target)
      return undefined
    case 'retire-source-id':
      fs.rename(join(journal.source, DATA_ID_FILENAME), join(journal.source, MOVED_ID_FILENAME))
      return undefined
    case 'mark-source':
      fs.writeFile(join(journal.source, MOVE_STATE_FILENAME), journal.moveId)
      return undefined
    case 'rename-source-to-hidden':
      await renameWithRetry(effects, journal.source, journal.hidden)
      return undefined
    case 'write-target-id':
      fs.writeFile(join(journal.target, DATA_ID_FILENAME), `${journal.dataId}\n`)
      return undefined
    case 'clear-target-state':
      fs.unlink(join(journal.target, MOVE_STATE_FILENAME))
      return undefined
    case 'rename-source-to-target':
      progress('finishing')
      await renameWithRetry(effects, journal.source, journal.target)
      return undefined
    case 'rewrite-links':
      for (const rewrite of journal.linkRewrites) effects.rewriteLink(journal.target, rewrite)
      phase('switching')
      return undefined
    case 'write-pointer': {
      phase('switching', { pointerWritten: true })
      effects.writePointer(pointerFor(journal, journal.lastSeenEnvBefore, effects.now()))
      return undefined
    }
    case 'sync-terminal': {
      save({ ...journal, terminalWritten: true })
      // Again, so the pointer precedes the terminal even when the first write
      // was interrupted after its flag was saved.
      effects.writePointer(pointerFor(journal, journal.lastSeenEnvBefore, effects.now()))
      const lastSeenEnv = await effects.syncTerminal(journal.target)
      effects.writePointer(pointerFor(journal, lastSeenEnv, effects.now()))
      phase('switched', { terminalWritten: true })
      return undefined
    }
    case 'await-health':
      return { kind: 'switched' }
    case 'remove-hidden': {
      progress('finishing')
      const report = await effects.remove(journal.hidden)
      if (report.leftovers.length === 0) return undefined
      const attempts = journal.cleanupAttempts + 1
      save({ ...journal, cleanupAttempts: attempts })
      return { kind: 'cleanup-incomplete', attempts, leftoverBytes: report.leftoverBytes }
    }
    case 'remove-partial':
    case 'remove-target': {
      const path = action.kind === 'remove-partial' ? journal.partial : journal.target
      const report = await effects.remove(path)
      if (report.leftovers.length > 0) save({ ...journal, leftovers: [...journal.leftovers, { path, bytes: report.leftoverBytes }] })
      return undefined
    }
    case 'recreate-empty-target':
      fs.mkdir(journal.target)
      return undefined
    case 'restore-home-link':
      effects.restoreHomeLink(journal.homeLinkBefore)
      save({ ...journal, homeLinkRestored: true })
      return undefined
    case 'mark-target':
      fs.writeFile(join(journal.target, MOVE_STATE_FILENAME), journal.moveId)
      return undefined
    case 'unlink-target-id':
      fs.unlink(join(journal.target, DATA_ID_FILENAME))
      return undefined
    case 'rename-hidden-to-source':
      await renameWithRetry(effects, journal.hidden, journal.source)
      return undefined
    case 'restore-source-id':
      fs.rename(join(journal.source, MOVED_ID_FILENAME), join(journal.source, DATA_ID_FILENAME))
      return undefined
    case 'clear-source-state':
      fs.unlink(join(journal.source, MOVE_STATE_FILENAME))
      return undefined
    case 'return-target-to-source':
      for (const { rel, from, to } of journal.linkRewrites) effects.rewriteLink(journal.target, { rel, from: to, to: from })
      await renameWithRetry(effects, journal.target, journal.source)
      return undefined
    case 'restore-pointer':
      effects.restorePointer(journal.pointerBefore)
      save({ ...journal, pointerWritten: false })
      return undefined
    case 'restore-terminal':
      await effects.restoreTerminal(journal.terminalBefore)
      save({ ...journal, terminalWritten: false })
      return undefined
    case 'finish':
      return { kind: 'ended', result: finish(dir, journal, action.outcome, effects.now()) }
    default:
      return action satisfies never
  }
}

/**
 * The pointer naming the target.
 * @param journal - the journal.
 * @param lastSeenEnv - the `DSH_HOME` value to record as seen.
 * @param now - the clock.
 * @returns the pointer.
 */
function pointerFor(journal: MoveJournal, lastSeenEnv: string | undefined, now: Date): DataLocationPointer {
  return {
    version: POINTER_VERSION,
    path: journal.target,
    dataId: journal.dataId,
    ...lastSeenEnv === undefined ? {} : { lastSeenEnv },
    movedAt: now.toISOString(),
  }
}

/**
 * End the move: write its result, then remove the done log, the journal, and
 * any temporary file an interrupted durable write left in the directory.
 * @param dir - the move directory.
 * @param journal - the journal.
 * @param outcome - how it ended.
 * @param now - the clock.
 * @returns the result.
 */
function finish(dir: string, journal: MoveJournal, outcome: MoveResult['outcome'], now: Date): MoveResult {
  const result: MoveResult = {
    version: journal.version,
    moveId: journal.moveId,
    outcome,
    source: journal.source,
    target: journal.target,
    ...journal.failure === undefined ? {} : { detail: journal.failure.detail },
    leftovers: journal.leftovers,
    finishedAt: now.toISOString(),
  }
  writeDurably(join(dir, RESULT_FILENAME), Buffer.from(`${JSON.stringify(result, null, 2)}\n`))
  unlinkIfPresent(join(dir, DONE_LOG_FILENAME))
  unlinkIfPresent(join(dir, JOURNAL_FILENAME))
  for (const name of readdirSync(dir)) {
    if (name.endsWith('.tmp')) unlinkIfPresent(join(dir, name))
  }
  return result
}

/**
 * Put the pointer's files back byte for byte, deleting any that did not exist.
 * @param userData - Electron's user-data directory.
 * @param before - the files' text before the move.
 * @throws when a file cannot be written or removed.
 */
export function restorePointerFiles(userData: string, before: PointerBefore): void {
  for (const [name, text] of [[POINTER_FILENAME, before.main], [POINTER_BACKUP_FILENAME, before.backup]] as const) {
    const path = join(userData, name)
    if (text === undefined) unlinkIfPresent(path)
    else writeDurably(path, Buffer.from(text))
  }
}

/**
 * Read the pointer's files as they are now, to record before a move.
 * @param userData - Electron's user-data directory.
 * @returns their text; an absent file is left out.
 * @throws when a file exists but cannot be read.
 */
export function readPointerFiles(userData: string): PointerBefore {
  const read = (name: string): string | undefined => NODE_MOVE_FS.readText(join(userData, name))
  const main = read(POINTER_FILENAME)
  const backup = read(POINTER_BACKUP_FILENAME)
  return { ...main === undefined ? {} : { main }, ...backup === undefined ? {} : { backup } }
}

/**
 * What `~/.dsh` is now, to record before a move.
 * @param defaultHome - `~/.dsh`.
 * @param fs - the link calls.
 * @returns absent, a link and its text, or something else.
 */
export function readHomeLinkBefore(defaultHome: string, fs: LinkFs = NODE_LINK_FS): HomeLinkBefore {
  let stats
  try {
    stats = fs.lstat(defaultHome)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' }
    throw error
  }
  return stats.isSymbolicLink() ? { kind: 'link', target: fs.readlink(defaultHome) } : { kind: 'other' }
}

/**
 * Put `~/.dsh` back as it was before the move: a link there now is removed
 * (with `unlink`, never following it), and a link that was there before is
 * made again. A real directory there now is left alone.
 * @param defaultHome - `~/.dsh`.
 * @param before - what it was.
 * @param platform - the platform (a junction on Windows).
 * @param fs - the link calls.
 * @throws when the link cannot be removed or made.
 */
export function restoreHomeLink(defaultHome: string, before: HomeLinkBefore, platform: NodeJS.Platform, fs: LinkFs = NODE_LINK_FS): void {
  if (readHomeLinkBefore(defaultHome, fs).kind === 'link') fs.unlink(defaultHome)
  if (before.kind === 'link') fs.symlink(before.target, defaultHome, platform === 'win32' ? 'junction' : undefined)
}

/**
 * The real effects of a move, except the ones only the application knows
 * (the terminal) and the ones it may run elsewhere (the copy and the check on
 * a worker thread; in process by default).
 * @param input - user data, `~/.dsh`, the platform, and the terminal calls.
 * @returns the effects.
 */
export function nodeMoveEffects(input: {
  userData: string
  defaultHome: string
  platform: NodeJS.Platform
  syncTerminal: MoveEffects['syncTerminal']
  restoreTerminal: MoveEffects['restoreTerminal']
}): MoveEffects {
  return {
    platform: input.platform,
    fs: NODE_MOVE_FS,
    copy: async (request, signal, onProgress) => { await copyTree(request, signal, onProgress) },
    verify: async (request, signal, onProgress) => (await verifyTree(request, signal, onProgress)).problems,
    remove: path => removeTree(path, { platform: input.platform }),
    scanLinks: async (source) => {
      const scan = await scanTree(source, { exclude: [] })
      return scan.entries.flatMap(entry => entry.kind === 'link' ? [{ rel: entry.rel, target: entry.target }] : [])
    },
    rewriteLink: (root, rewrite) => rewriteInPlace(root, rewrite, input.platform),
    writePointer: (pointer) => {
      mkdirSync(input.userData, { recursive: true })
      writePointer(input.userData, pointer)
    },
    restorePointer: (before) => { restorePointerFiles(input.userData, before) },
    syncTerminal: input.syncTerminal,
    restoreTerminal: input.restoreTerminal,
    restoreHomeLink: (before) => { restoreHomeLink(input.defaultHome, before, input.platform) },
    sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
    now: () => new Date(),
  }
}
