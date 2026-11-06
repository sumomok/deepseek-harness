/**
 * Carrying out a data move one step at a time from its journal.
 *
 * {@link advanceMove} reads the journal, looks at the disk, asks
 * [[@deepseek-ai/dsh-desktop-shell/move/journal]]'s `nextAction` what to do,
 * does that one step, records the new phase durably, and repeats until the move
 * needs the application: `switched` (relaunch or continue onto the new
 * location, start the server, then call {@link recordHealth}), `ended` (the
 * move is over; the result says how), `cleanup-incomplete` (the old copy is
 * not fully deleted yet; try again later), or `blocked` (something that is not
 * this data sits at the data directory's old path, the original or the copy
 * cannot be found, or a rollback waits for the person; the journal is kept
 * and nothing is deleted). A blocked rollback goes on only
 * after the person's choice, which {@link resolveBlocked} records: keep the
 * new location, or go back to the old one. While a journal is on disk the
 * application starts the server only when the journal's `mayStartServer`
 * allows it. An interruption anywhere is
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
 * roll it back. Once the pointer is about to name the target, a rollback
 * never deletes it: it is retired into a visible folder the result names
 * (`perform` refuses `remove-target` from then on, whatever the journal step
 * says). Failures while giving up or rolling back are thrown and the
 * next call continues. Cancelling is honored only while the copy is still a
 * partial folder.
 * @module @deepseek-ai/dsh-desktop-shell/move/run
 */

import {
  lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { samePathText } from '../path-text.ts'
import { fsyncDirectory, writeDurably } from '../durable-file.ts'
import {
  DATA_ID_FILENAME, GENERATION_FILENAME, parseGeneration, parsePointerText, POINTER_BACKUP_FILENAME, POINTER_FILENAME, pointerText,
  POINTER_VERSION, withGeneration, writePointer, type DataLocationPointer,
} from '../data-location.ts'
import { NODE_LINK_FS, type LinkFs } from '../home-link.ts'
import type { ExplicitRead, TerminalSnapshot } from '../terminal-env.ts'
import { LOCK_FILENAME } from './lock.ts'
import { copyTree, CopyMismatchError, forgetDone, planLinkResolved, removeExtra, type ByteProgress, type CopyRequest } from './copier.ts'
import {
  ABANDONED_FILENAME, abandonedCopiesText, CANCELLABLE_PHASES, DONE_LOG_FILENAME, healthFailure, JOURNAL_FILENAME, JournalError,
  MAX_REPAIR_ROUNDS, MOVED_ID_FILENAME, newJournal, nextAction, readAbandonedCopies, readJournal, RESULT_FILENAME, RETIRED_FILENAME,
  writeJournal, type BlockedChoice, type BlockedReason, type DirFacts, type HealthFailures, type HomeLinkBefore, type MoveAction,
  type MoveFacts, type MoveFailureKind, type MoveJournal, type MovePhase, type MoveResult, type MoveStart, type PointerBefore,
  type ResultFailure, type TargetPrint,
} from './journal.ts'
import { rewriteInPlace, type InPlaceRewrite, type LinkMove, type RewriteOutcome } from './links.ts'
import { NODE_REMOVE_FS, REMOVE_ATTEMPTS, REMOVE_FIRST_DELAY_MS, removeTree, type RemoveFs, type RemoveReport } from './remove.ts'
import { keptFolderName, type KeptFolderKind, type NameLocale } from './names.ts'
import { fingerprintTree, isIgnorableName, meaningfulNames, MOVE_STATE_FILENAME, REBUILDABLE_ENTRIES, scanTree } from './tree.ts'
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
  /** A hash over every entry of the tree at a directory, links not followed, the excluded relative paths left out. */
  fingerprint: (dir: string, exclude: readonly string[]) => TargetPrint
}

/**
 * The real directory operations. A rename is followed by a flush of the
 * directories on both sides, and an unlink by a flush of its directory, so
 * the change is on disk before the journal records the step that follows it.
 * @param flushDir - flushes one directory's entries; {@link fsyncDirectory} in the app.
 * @param activity - reported while a print walks a tree (the executor's heartbeat).
 * @returns the operations.
 */
export function nodeMoveFs(flushDir: (dir: string) => void = fsyncDirectory, activity?: () => void): MoveFs {
  return {
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
    rename: (from, to) => {
      renameSync(from, to)
      flushDir(dirname(to))
      if (dirname(from) !== dirname(to)) flushDir(dirname(from))
    },
    unlink: (path) => {
      unlinkSync(path)
      flushDir(dirname(path))
    },
    mkdir: (path) => { mkdirSync(path, { mode: 0o700 }) },
    rmdir: (path) => { rmdirSync(path) },
    fingerprint: (dir, exclude) => fingerprintTree(dir, exclude, process.platform, activity === undefined ? {} : { onActivity: activity }),
  }
}

/** The markers a move writes in a data directory; neither copied nor printed. */
export const MOVE_MARKERS: readonly string[] = [
  DATA_ID_FILENAME, MOVE_STATE_FILENAME, MOVED_ID_FILENAME, RETIRED_FILENAME, GENERATION_FILENAME, LOCK_FILENAME,
]

/**
 * The markers, the lock's temporary files (`<lock>.<pid>.<hex>.tmp`, `<lock>.claim-…`),
 * and their AppleDouble companions (`._<name>`), which macOS writes beside a
 * file on a file system without extended attributes (exFAT, FAT, SMB): what a
 * move neither copies, prints, nor checks. Entries ending in `*` match by
 * prefix (`exclusionOf`).
 */
export const MOVE_MARKER_ENTRIES: readonly string[] = [...MOVE_MARKERS, `${LOCK_FILENAME}.*`].flatMap(name => [name, `._${name}`])

/** What a print of the target leaves out: what the server rebuilds, and the markers. */
export const PRINT_EXCLUDE: readonly string[] = [...REBUILDABLE_ENTRIES, ...MOVE_MARKER_ENTRIES]

/**
 * The target's print now.
 * @param fs - the directory operations.
 * @param journal - the journal naming the target.
 * @returns the print, or `undefined` when the target is not a directory.
 */
function targetPrintNow(fs: MoveFs, journal: MoveJournal): TargetPrint | undefined {
  return fs.kind(journal.target) === 'dir' ? fs.fingerprint(journal.target, PRINT_EXCLUDE) : undefined
}

/**
 * The journal entering `rolling-back`: the target's print is taken now, or
 * dropped when the target is not there (a missing print counts as changed).
 * @param journal - the journal before.
 * @param changes - the other fields that change.
 * @param print - the target's print now.
 * @returns the journal after.
 */
function enterRollback(journal: MoveJournal, changes: Partial<MoveJournal>, print: TargetPrint | undefined): MoveJournal {
  const next: MoveJournal = { ...journal, ...changes, phase: 'rolling-back' }
  if (print === undefined) delete next.targetFingerprint
  else next.targetFingerprint = print
  return next
}

/** The real directory operations. */
export const NODE_MOVE_FS: MoveFs = nodeMoveFs()

/** Everything a move does to the disk and to the rest of the application. */
export interface MoveEffects {
  platform: NodeJS.Platform
  fs: MoveFs
  /** Copy the source into the partial folder; the app runs it on a worker thread. */
  copy: (request: CopyRequest, signal: AbortSignal, onProgress: (progress: ByteProgress) => void) => Promise<void>
  /** Check the partial folder against the source. */
  verify: (request: VerifyRequest, signal: AbortSignal, onProgress: (progress: ByteProgress) => void) => Promise<VerifyProblem[]>
  /**
   * Prepare a copy for another round after a failed check: delete what the
   * copy has and the source does not, and forget the done-log records of what
   * differs, so those files are copied again.
   */
  repair: (request: CopyRequest, extras: readonly string[], forget: ReadonlySet<string>) => Promise<void>
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
  /**
   * Put the terminal's `DSH_HOME` setting back from the snapshot taken before
   * the move; a rejection is recorded, and the rollback finishes without it.
   */
  restoreTerminal: (snapshot: TerminalSnapshot) => Promise<void>
  /**
   * Read the terminal's `DSH_HOME` after a rollback could not put it back,
   * as a launch would take it.
   * @param before - what a terminal read before the move.
   * @returns the `lastSeenEnv` the pointer records; `undefined` when a terminal reads no value or the value it read
   * before the move, which leaves the pointer's files as the rollback puts them back ({@link rolledBackPointer}).
   * @throws when the setting cannot be read.
   */
  terminalSeen: (before: ExplicitRead) => Promise<string | undefined>
  /** Put `~/.dsh` back: remove the link to the target, recreate a link that was there. */
  restoreHomeLink: (before: HomeLinkBefore) => void
  /** The name of a visible folder the move leaves for the person ({@link keptFolderName} in the system's language). */
  keptFolderName: (kind: KeptFolderKind, date: Date, attempt: number) => string
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
  /**
   * The move can neither go on nor be undone until the person acts: the
   * journal is kept, and every later call tries again. `dataAt` lists where
   * the data is, the original first; nothing in it has been deleted.
   * `targetPrint` is the target's print as the page shows it (`null` when the
   * target is not there); the person's choice carries it back in
   * {@link BlockedView}, and a choice whose print no longer matches is refused.
   */
  | { kind: 'blocked'; reason: BlockedReason; dataAt: string[]; choices: BlockedChoice[]; targetPrint: TargetPrint | null }
  | { kind: 'ended'; result: MoveResult }
  | { kind: 'cleanup-incomplete'; attempts: number; leftoverBytes: number }

/** Options of {@link advanceMove}. */
export interface AdvanceOptions {
  /** The person asked to cancel; honored only while the copy is partial. */
  cancel?: AbortSignal
  onProgress?: (progress: MoveProgress) => void
  /** The running process, recorded in the journal. */
  pid: number
  /**
   * Checked before each step past `requested`, outside the step, so what it
   * throws stops the move with nothing more done (the executor checks that
   * the move still holds its lock, {@link lockExpectedAt}).
   */
  guard?: (journal: MoveJournal, facts: MoveFacts) => void | Promise<void>
}

/** Phases whose steps need the move's lock where the data is ({@link lockExpectedAt}). */
export const GUARDED_PHASES: ReadonlySet<MovePhase> = new Set([
  'copying', 'verifying', 'catching-up', 'finalizing', 'hiding-source', 'switching', 'switched',
])

/** Guarded phases a move that lost its lock may be abandoned from: nothing outside the partial copy was changed yet. */
export const ABANDONABLE_PHASES: ReadonlySet<MovePhase> = new Set(['copying', 'verifying', 'catching-up', 'finalizing'])

/**
 * Give up a move that lost its lock before it changed anything but its own
 * copy: the journal goes to `abandoning`, which removes only the marked
 * partial copy or copy at the new location, or puts back the empty folder
 * that was there, and ends with the data where it was.
 * @param dir - the move directory.
 * @param detail - why, recorded as the failure, of kind `lock-lost`.
 * @throws when there is no journal in one of {@link ABANDONABLE_PHASES}.
 */
export function abandonMove(dir: string, detail: string): void {
  const journal = readJournal(dir)
  if (journal === undefined || !ABANDONABLE_PHASES.has(journal.phase)) {
    throw new JournalError(`journal: the move cannot be abandoned now (phase ${String(journal?.phase)})`)
  }
  writeJournal(dir, { ...journal, phase: 'abandoning', failure: { phase: journal.phase, detail, kind: 'lock-lost' } })
}

/** Guarded phases a move that lost its lock may be taken back from: once hiding began, until the health check. */
export const WITHDRAWABLE_PHASES: ReadonlySet<MovePhase> = new Set(['hiding-source', 'switching', 'switched'])

/**
 * Take back a move that lost its lock after hiding began: the journal enters
 * the rollback, as a step that finds the copy gone does, which restores the
 * original's identity, removes a copy nothing could have used (and retires
 * one that could have been), and puts the pointer and the terminal back.
 * It prints the new location, so it runs on the move's worker.
 * @param dir - the move directory.
 * @param detail - why, recorded as the failure, of kind `lock-lost`.
 * @param fs - prints the new location.
 * @throws when there is no journal in one of {@link WITHDRAWABLE_PHASES}.
 */
export function rollBackMove(dir: string, detail: string, fs: MoveFs = NODE_MOVE_FS): void {
  const journal = readJournal(dir)
  if (journal === undefined || !WITHDRAWABLE_PHASES.has(journal.phase)) {
    throw new JournalError(`journal: the move cannot be taken back now (phase ${String(journal?.phase)})`)
  }
  writeJournal(dir, enterRollback(journal, { failure: { phase: journal.phase, detail, kind: 'lock-lost' } }, targetPrintNow(fs, journal)))
}

/**
 * Where a move's lock must be now: in the original data wherever it is — at
 * the old path, hidden beside it, or, on one volume, renamed to the new
 * location. A place whose data is not this move's (its drive away, or
 * something else there) is not checked.
 *
 * None in these phases:
 * - `requested`: nothing has been done yet, and a launch withdraws such a move.
 * - `cleanup`: it deletes only the hidden original, which no installation uses
 *   as its data directory; on one volume it deletes nothing where the lock is.
 *   The new location's lock is released when the health check passes.
 * - `cancelling`, `abandoning`: they remove only this move's marked partial
 *   copy or copy at the new location, or put back the empty folder that was
 *   there; they never touch the original.
 * - `rolling-back`: it only puts the original back where it was, and stops
 *   with a page when something else is at that path.
 * @param journal - the journal.
 * @param facts - what is on disk now at the old path, the hidden original, and the new location.
 * @returns the directories.
 */
export function lockExpectedAt(journal: MoveJournal, facts: Pick<MoveFacts, 'source' | 'hidden' | 'target'>): string[] {
  if (!GUARDED_PHASES.has(journal.phase)) return []
  const places: string[] = []
  // `.dsh-data-id.moved` marks the original between giving up its identity and being hidden.
  if (facts.source.exists && (facts.source.dataId === 'ours' || facts.source.movedId)) places.push(journal.source)
  if (!journal.sameVolume && facts.hidden.exists) places.push(journal.hidden)
  if (journal.sameVolume && facts.target.exists && facts.target.dataId === 'ours') places.push(journal.target)
  return places
}

/** Thrown when a step changes nothing, so repeating it would never end. */
export class MoveStuckError extends Error {
  /** @param detail - the step and the facts it saw. */
  constructor(detail: string) {
    super(`data move made no progress: ${detail}`)
    this.name = 'MoveStuckError'
  }
}

/** A step's error with the failure kind the step found for it from what is on disk; the message is the error's. */
export class StepFailure extends Error {
  /** Why the step failed. */
  readonly kind: MoveFailureKind

  /**
   * @param kind - why the step failed.
   * @param cause - what the step threw.
   */
  constructor(kind: MoveFailureKind, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'StepFailure'
    this.kind = kind
  }
}

/**
 * Start a move: write its journal in phase `requested`, and a fresh done log;
 * a record of an abandoned copy at the new location is dropped.
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
  // The new location passed the preflight, so no abandoned copy is there any more; its record would refuse the data.
  const copies = readAbandonedCopies(dir)
  const target = canonicalPath(journal.target)
  const kept = copies.filter(copy => !samePathText(copy.path, target, process.platform))
  if (kept.length !== copies.length) writeDurably(join(dir, ABANDONED_FILENAME), Buffer.from(abandonedCopiesText(kept)), 0o600)
  writeJournal(dir, journal)
  return journal
}

/** Why the first launch on the new location failed: `detail` for the log, `failures` for Settings. */
export interface HealthFailed {
  detail: string
  failures: HealthFailures
}

/**
 * Record the health check of the first launch on the new location. The
 * application stops the server it started for the check before calling this,
 * so nothing writes to the target after its print is taken.
 *
 * A failure rolls the move back, taking the target's print; the rollback
 * retires the target into a visible folder rather than deleting it. After
 * the person chose to keep the target, a failure does not roll back: the move
 * finishes on the target and the original is kept in a visible folder the
 * result names (`keptOriginal`), never deleted. Either way the failure, with
 * its kinds, is recorded and reaches the result.
 * @param dir - the move directory.
 * @param failed - why it failed; `undefined` when it passed.
 * @param fs - prints the target; the real file system when absent.
 * @throws when there is no journal in phase `switched`.
 */
export function recordHealth(dir: string, failed: HealthFailed | undefined, fs: MoveFs = NODE_MOVE_FS): void {
  const journal = readJournal(dir)
  if (journal?.phase !== 'switched') throw new JournalError(`journal: no move awaits a health check (phase ${String(journal?.phase)})`)
  if (failed === undefined) {
    writeJournal(dir, { ...journal, phase: 'cleanup' })
    return
  }
  const failure = healthFailure(failed.detail, failed.failures)
  if (journal.keepTarget) writeJournal(dir, { ...journal, phase: 'cleanup', keepOriginal: true, failure })
  else writeJournal(dir, enterRollback(journal, { failure }, targetPrintNow(fs, journal)))
}

/** What the page the person chose on showed: the reason and the target's print. */
export interface BlockedView {
  reason: BlockedReason
  targetPrint: TargetPrint | null
}

/** What {@link resolveBlocked} did. */
export type ResolveOutcome = 'applied' | 'not-blocked' | 'refused'

/**
 * Carry out the person's choice on a blocked move. Only a choice the blocked
 * move offers now, on a page that shows what is on disk now (the same reason
 * and the same target print), is applied: a choice made on a page that is out
 * of date is refused. One made again after it was applied, or on a move that
 * is no longer blocked, changes nothing, so calling it twice (after a crash,
 * say) is safe. Either way the journal is written once.
 *
 * - `keep-target`: the move goes forward on the new location from hiding the
 *   source; the original is then deleted only if the next health check passes.
 * - `rollback`: the rollback goes on; a copy whose disk is away is left where
 *   it is (and recorded when the move ends), and a copy that was exposed is
 *   retired into a visible folder, never deleted. A move blocked before
 *   anything failed records what blocked it as the failure.
 * @param dir - the move directory.
 * @param choice - the person's choice.
 * @param seen - what the page the person chose on showed.
 * @param fs - the directory operations; the real ones when absent.
 * @returns whether it was applied, the move was not blocked, or the choice is not offered for what the page showed.
 * @throws when the journal cannot be read or written.
 */
export function resolveBlocked(dir: string, choice: BlockedChoice, seen: BlockedView, fs: MoveFs = NODE_MOVE_FS): ResolveOutcome {
  const journal = readJournal(dir)
  if (journal === undefined) return 'not-blocked'
  const facts = observeMove(fs, journal)
  const action = nextAction(journal, facts, false)
  if (action.kind !== 'blocked') return 'not-blocked'
  const print = blockedPrint(fs, journal, facts)
  if (action.reason !== seen.reason || print !== seen.targetPrint || !action.choices.includes(choice)) return 'refused'
  const save = (next: MoveJournal): void => { fs.writeFile(join(dir, JOURNAL_FILENAME), `${JSON.stringify(next, null, 2)}\n`) }
  switch (choice) {
    case 'keep-target': {
      const next: MoveJournal = {
        ...journal, phase: 'hiding-source', keepTarget: true, awaitingChoice: false, homeLinkRestored: false,
        originalAbandoned: journal.originalAbandoned || (action.reason === 'original-missing' && !journal.sameVolume),
      }
      delete next.unusedCopy
      save(next)
      return 'applied'
    }
    case 'rollback': {
      // A move blocked before anything failed goes back for what blocked it.
      const failure = journal.failure ?? {
        phase: journal.phase, detail: `the person chose to go back (${action.reason})`, kind: blockedFailureKind(action.reason),
      }
      save(enterRollback(journal, {
        awaitingChoice: false, failure, ...action.reason === 'target-missing' ? { targetAbandoned: true } : {},
      }, print ?? undefined))
      return 'applied'
    }
    default:
      return choice satisfies never
  }
}

/**
 * The failure kind of a rollback the person chose on a blocked move.
 * @param reason - what blocked the move.
 * @returns the kind.
 */
function blockedFailureKind(reason: BlockedReason): MoveFailureKind {
  switch (reason) {
    case 'target-occupied':
      return 'target-occupied'
    case 'target-missing':
      return 'copy-gone'
    case 'source-occupied':
    case 'original-missing':
      return 'source-changed'
    case 'target-changed':
    case 'choice-needed':
      return 'other'
    default:
      return reason satisfies never
  }
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
  if (kind !== 'dir') return { exists: kind !== 'absent', dataId: 'none', movedId: false, retired: false, generation: 0, state: 'none', empty: false }
  const id = fs.readText(join(path, DATA_ID_FILENAME))?.trim()
  const state = fs.readText(join(path, MOVE_STATE_FILENAME))?.trim()
  return {
    exists: true,
    dataId: id === undefined ? 'none' : id === journal.dataId ? 'ours' : 'other',
    movedId: fs.readText(join(path, MOVED_ID_FILENAME)) !== undefined,
    retired: fs.readText(join(path, RETIRED_FILENAME)) !== undefined,
    generation: parseGeneration(fs.readText(join(path, GENERATION_FILENAME))),
    state: state === undefined ? 'none' : state === journal.moveId ? 'ours' : 'other',
    empty: meaningfulNames(fs.readdir(path)).length === 0,
  }
}

/**
 * {@link lockExpectedAt} from what is on disk now, looking only at the three
 * places the lock may be (never printing the target).
 * @param fs - the directory operations.
 * @param journal - the journal.
 * @returns the directories.
 */
export function lockExpectedNow(fs: MoveFs, journal: MoveJournal): string[] {
  return lockExpectedAt(journal, {
    source: dirFacts(fs, journal.source, journal),
    hidden: dirFacts(fs, journal.hidden, journal),
    target: dirFacts(fs, journal.target, journal),
  })
}

/**
 * Look at the four directories, and at the folders chosen for an unused copy
 * or a kept original. The target is printed only while a rollback waits for
 * the person's choice.
 * @param fs - the directory operations.
 * @param journal - the journal naming them.
 * @returns the facts.
 */
export function observeMove(fs: MoveFs, journal: MoveJournal): MoveFacts {
  const facts: MoveFacts = {
    source: dirFacts(fs, journal.source, journal),
    partial: dirFacts(fs, journal.partial, journal),
    target: dirFacts(fs, journal.target, journal),
    hidden: dirFacts(fs, journal.hidden, journal),
  }
  if (journal.unusedCopy !== undefined) facts.unusedCopy = dirFacts(fs, journal.unusedCopy, journal)
  if (journal.keptOriginal !== undefined) facts.keptOriginal = dirFacts(fs, journal.keptOriginal, journal)
  if (journal.phase === 'rolling-back' && journal.awaitingChoice && facts.target.exists) {
    const print = targetPrintNow(fs, journal)
    if (print !== undefined) facts.targetPrint = print
  }
  return facts
}

/**
 * The target's print for a blocked page: the one the facts already hold, or
 * one taken now.
 * @param fs - the directory operations.
 * @param journal - the journal.
 * @param facts - what is on disk now.
 * @returns the print, or `null` when the target is not there.
 */
function blockedPrint(fs: MoveFs, journal: MoveJournal, facts: MoveFacts): TargetPrint | null {
  return facts.targetPrint ?? targetPrintNow(fs, journal) ?? null
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
    fs.writeFile(join(dir, JOURNAL_FILENAME), `${JSON.stringify(next, null, 2)}\n`)
    journal = next
  }
  if (journal.pid !== options.pid) save({ ...journal, pid: options.pid })
  const cancel = options.cancel ?? new AbortController().signal
  let previous = ''
  for (;;) {
    const current: MoveJournal = journal
    const facts = observeMove(fs, current)
    await options.guard?.(current, facts)
    const action = nextAction(current, facts, cancel.aborted)
    const key = JSON.stringify({ current, facts, action })
    if (key === previous) throw new MoveStuckError(`${current.phase}: ${action.kind}`)
    previous = key
    let outcome: MoveOutcome | undefined
    try {
      outcome = await perform(action, current, { facts, dir, effects, cancel, save, options })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // What the step recorded before it failed (the terminal written, the target exposed) stays recorded.
      const latest: MoveJournal = journal
      if (CANCELLABLE_PHASES.has(current.phase) && cancel.aborted) {
        save({ ...latest, phase: 'cancelling' })
      } else if (ABANDON_ON_FAILURE.has(current.phase)) {
        save({ ...latest, phase: 'abandoning', failure: { phase: current.phase, detail, kind: failureKindOf(error) } })
      } else if (ROLL_BACK_ON_FAILURE.has(current.phase)) {
        save(enterRollback(latest, { failure: { phase: current.phase, detail, kind: failureKindOf(error) } }, targetPrintNow(fs, latest)))
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
  /** What was on disk when the step was chosen. */
  facts: MoveFacts
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
    exclude: [...REBUILDABLE_ENTRIES, ...MOVE_MARKER_ENTRIES],
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
 * The failure kind of an error a step threw: the kind a {@link StepFailure}
 * names, a file that read back different from what was written, a full drive,
 * or a write refused for lack of permission; `other` for anything else.
 * @param error - what the step threw.
 * @returns the kind.
 */
export function failureKindOf(error: unknown): MoveFailureKind {
  if (error instanceof StepFailure) return error.kind
  if (error instanceof CopyMismatchError) return 'copy-mismatch'
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined
  switch (code) {
    case 'ENOSPC':
    case 'EDQUOT':
      return 'no-space'
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'no-permission'
    default:
      return 'other'
  }
}

/**
 * Why putting the copy in place at the new location failed. The step was
 * chosen with the new location empty and the copy present; when that changed
 * before the rename, what is there now names the cause rather than the
 * error's code.
 * @param fs - looks at both paths.
 * @param journal - the journal.
 * @param error - what the rename threw.
 * @returns `target-occupied` when something is at the new location now, `copy-gone` when the copy is gone, otherwise
 * the error's kind.
 */
function renameToTargetFailure(fs: MoveFs, journal: MoveJournal, error: unknown): MoveFailureKind {
  const look = (path: string): EntryKind | undefined => {
    try {
      return fs.kind(path)
    } catch {
      // EACCES or EIO: a path that cannot be looked at names no cause, so the rename's error does.
      return undefined
    }
  }
  const target = look(journal.target)
  if (target !== undefined && target !== 'absent') return 'target-occupied'
  if (look(journal.partial) === 'absent') return 'copy-gone'
  return failureKindOf(error)
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
      phase('abandoning', { failure: { phase: journal.phase, detail: action.detail, kind: action.failure } })
      return undefined
    case 'roll-back':
      save(enterRollback(
        journal, { failure: { phase: journal.phase, detail: action.detail, kind: action.failure } }, targetPrintNow(fs, journal),
      ))
      return undefined
    case 'blocked': {
      // A blocked rollback waits for the person's choice even after the obstruction is gone.
      if (journal.phase === 'rolling-back' && !journal.awaitingChoice) save({ ...journal, awaitingChoice: true })
      const targetPrint = blockedPrint(fs, journal, context.facts)
      return { kind: 'blocked', reason: action.reason, dataAt: action.dataAt, choices: action.choices, targetPrint }
    }
    case 'original-found':
      save({ ...journal, originalAbandoned: false })
      return undefined
    case 'keep-unmarked':
      save({ ...journal, leftovers: [...journal.leftovers, { path: action.path, bytes: 0 }] })
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
        phase('abandoning', { failure: { phase: journal.phase, detail: `the copy does not match: ${describeProblems(problems)}`, kind: 'copy-mismatch' } })
        return undefined
      }
      const extras = problems.filter(problem => problem.kind === 'extra').map(problem => problem.rel)
      await effects.repair(request, extras, new Set(problems.filter(problem => problem.kind !== 'extra').map(problem => problem.rel)))
      phase('copying', { repairRounds: journal.repairRounds + 1 })
      return undefined
    }
    case 'remove-empty-target':
      for (const name of fs.readdir(journal.target)) {
        if (isIgnorableName(name, effects.platform)) fs.unlink(join(journal.target, name))
      }
      fs.rmdir(journal.target)
      return undefined
    case 'rename-partial-to-target':
      progress('finishing')
      try {
        await renameWithRetry(effects, journal.partial, journal.target)
      } catch (error) {
        throw new StepFailure(renameToTargetFailure(fs, journal, error), error)
      }
      return undefined
    case 'retire-source-id':
      await renameWithRetry(effects, join(journal.source, DATA_ID_FILENAME), join(journal.source, MOVED_ID_FILENAME))
      return undefined
    case 'mark-source':
      fs.writeFile(join(journal.source, MOVE_STATE_FILENAME), journal.moveId)
      return undefined
    case 'rename-source-to-hidden':
      await renameWithRetry(effects, journal.source, journal.hidden)
      return undefined
    case 'write-target-generation': {
      const generation = Math.max(journal.targetGeneration ?? 0, journal.originalGeneration + 1)
      if (generation !== journal.targetGeneration) save({ ...journal, targetGeneration: generation })
      fs.writeFile(join(journal.target, GENERATION_FILENAME), `${String(generation)}\n`)
      return undefined
    }
    case 'write-original-generation': {
      const generation = Math.max(journal.originalGeneration, (journal.targetGeneration ?? 0) + 1, context.facts.source.generation)
      if (generation !== journal.originalGeneration) save({ ...journal, originalGeneration: generation })
      fs.writeFile(join(journal.source, GENERATION_FILENAME), `${String(generation)}\n`)
      return undefined
    }
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
      phase('switching', { pointerWritten: true, targetExposed: true })
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
      if (journal.keepOriginal) throw new Error('refusing to delete the original the person kept')
      progress('finishing')
      const report = await effects.remove(journal.hidden)
      if (report.leftovers.length === 0) return undefined
      const attempts = journal.cleanupAttempts + 1
      save({ ...journal, cleanupAttempts: attempts, cleanupLeftoverBytes: report.leftoverBytes })
      return { kind: 'cleanup-incomplete', attempts, leftoverBytes: report.leftoverBytes }
    }
    case 'remove-partial':
    case 'remove-target': {
      if (action.kind === 'remove-target' && journal.targetExposed) throw new Error('refusing to delete a new location that may have been used')
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
    case 'mark-target-retired':
      fs.writeFile(join(journal.target, RETIRED_FILENAME), retiredMarker(journal, effects.now()))
      return undefined
    case 'clear-target-retired':
      fs.unlink(join(journal.target, RETIRED_FILENAME))
      return undefined
    case 'name-unused-copy':
      save({ ...journal, unusedCopy: freeSibling(effects, journal.target, 'unused') })
      return undefined
    case 'rename-target-to-unused':
      try {
        await renameWithRetry(effects, journal.target, journal.unusedCopy ?? journal.target)
      } catch (error) {
        // Retired and without its identity, it is safe where it is; the rollback must not stop on it.
        const failure = journal.failure ?? { phase: journal.phase, detail: String(error), kind: failureKindOf(error) }
        save({ ...journal, retiredInPlace: true, failure })
      }
      return undefined
    case 'mark-hidden-retired':
      fs.writeFile(join(journal.hidden, RETIRED_FILENAME), retiredMarker(journal, effects.now()))
      return undefined
    case 'name-kept-original':
      save({ ...journal, keptOriginal: freeSibling(effects, journal.source, 'original') })
      return undefined
    case 'rename-hidden-to-kept':
      await renameWithRetry(effects, journal.hidden, journal.keptOriginal ?? journal.hidden)
      return undefined
    case 'rename-hidden-to-source':
      await renameWithRetry(effects, journal.hidden, journal.source)
      return undefined
    case 'restore-source-id':
      await renameWithRetry(effects, join(journal.source, MOVED_ID_FILENAME), join(journal.source, DATA_ID_FILENAME))
      return undefined
    case 'clear-source-state':
      fs.unlink(join(journal.source, MOVE_STATE_FILENAME))
      return undefined
    case 'return-target-to-source':
      for (const { rel, from, to } of journal.linkRewrites) effects.rewriteLink(journal.target, { rel, from: to, to: from })
      await renameWithRetry(effects, journal.target, journal.source)
      return undefined
    case 'restore-pointer':
      effects.restorePointer(rolledBackPointer(journal.pointerBefore, journal.originalGeneration))
      save({ ...journal, pointerWritten: false })
      return undefined
    case 'restore-terminal': {
      // The data is back where it was: a rollback that waited for the terminal setting would keep DSH from starting.
      let failed: string | undefined
      try {
        await effects.restoreTerminal(journal.terminalSnapshot)
      } catch (error) {
        failed = error instanceof Error ? error.message : String(error)
      }
      save({ ...journal, terminalWritten: false, ...failed === undefined ? {} : { terminalRestoreFailed: failed } })
      return undefined
    }
    case 'record-terminal-as-seen': {
      // Read in this step, so a rollback resumed before its flag is saved reads the terminal again.
      let seen: string | undefined
      try {
        seen = await effects.terminalSeen(journal.terminalBefore)
      } catch {
        // The main process logged why the setting could not be read; it is taken to name the new location, as the switch wrote it.
        seen = journal.target
      }
      // A step resumed after its pointer write starts again from the rolled-back files, so both files follow this read only.
      effects.restorePointer(rolledBackPointer(journal.pointerBefore, journal.originalGeneration))
      const pointer = seen === undefined ? undefined : pointerSeeingTerminal(journal, seen)
      if (pointer !== undefined) effects.writePointer(pointer)
      save({ ...journal, terminalRecordedAsSeen: true })
      return undefined
    }
    case 'finish':
      return { kind: 'ended', result: finish(dir, journal, action.outcome, context.facts, effects) }
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
  // On one volume the original itself is renamed, and keeps its number.
  const generation = journal.sameVolume ? journal.originalGeneration : journal.targetGeneration ?? journal.originalGeneration
  return withGeneration({
    version: POINTER_VERSION,
    path: journal.target,
    dataId: journal.dataId,
    ...lastSeenEnv === undefined ? {} : { lastSeenEnv },
    movedAt: now.toISOString(),
  }, generation)
}


/**
 * The retired marker's content.
 * @param journal - the move.
 * @param now - when.
 * @returns the text naming the data and the move.
 */
function retiredMarker(journal: MoveJournal, now: Date): string {
  return `${JSON.stringify({ dataId: journal.dataId, moveId: journal.moveId, retiredAt: now.toISOString() })}\n`
}

/** Attempts at a free name before a move gives up naming a kept folder. */
const NAME_ATTEMPTS = 1000

/**
 * A free path beside `path` for a folder the person is left to check.
 * @param effects - the directory operations, the clock, and the names.
 * @param path - the folder it sits beside.
 * @param kind - which folder.
 * @returns the first free path.
 * @throws when every attempt is taken.
 */
function freeSibling(effects: MoveEffects, path: string, kind: KeptFolderKind): string {
  const now = effects.now()
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    const candidate = join(dirname(path), effects.keptFolderName(kind, now, attempt))
    if (effects.fs.kind(candidate) === 'absent') return candidate
  }
  throw new Error(`no free name beside ${path}`)
}

/**
 * End the move: record a copy the person rolled back without, write the
 * result, then remove the done log, the journal, and any temporary file an
 * interrupted durable write left in the directory. The result names the
 * failure's kinds when the move failed (`other` when the journal records
 * none), and when it finished on a new location that failed its check after
 * the person chose to keep it; a move that went on after an earlier failure
 * because the person chose so, and then passed its check, keeps only the
 * `detail`. A rollback that could not put the terminal setting back names the
 * new location in `terminalNotRestored`; the pointer keeps the application on
 * the original ({@link pointerSeeingTerminal}).
 * @param dir - the move directory.
 * @param journal - the journal.
 * @param outcome - how it ended.
 * @param facts - what is on disk now.
 * @param effects - the directory operations and the clock.
 * @returns the result.
 */
function finish(dir: string, journal: MoveJournal, outcome: MoveResult['outcome'], facts: MoveFacts, effects: MoveEffects): MoveResult {
  const { fs } = effects
  const now = effects.now()
  const renamed = journal.unusedCopy !== undefined && facts.unusedCopy?.exists === true ? journal.unusedCopy : undefined
  const unused = outcome === 'failed' ? journal.retiredInPlace ? journal.target : renamed : undefined
  const abandoned = outcome === 'failed' && journal.targetAbandoned && unused === undefined ? journal.target : undefined
  let kept: string | undefined
  if (outcome === 'moved' && journal.keepOriginal && !journal.sameVolume) {
    // An original that was never found again is reported as abandoned, not kept.
    if (journal.keptOriginal !== undefined && facts.keptOriginal?.exists === true) kept = journal.keptOriginal
    else if (facts.hidden.exists) kept = journal.hidden
  }
  const original = outcome === 'moved' && journal.originalAbandoned ? journal.source : undefined
  const failed = outcome === 'failed' || (outcome === 'moved' && journal.keepOriginal) ? journal.failure : undefined
  let failure: ResultFailure | undefined
  if (failed !== undefined) failure = { kind: failed.kind, ...failed.also === undefined ? {} : { also: failed.also } }
  else if (outcome === 'failed') failure = { kind: 'other' }
  // The original was at its old path or already hidden beside it when its drive went away.
  const paths = [...abandoned === undefined ? [] : [abandoned], ...original === undefined ? [] : [journal.source, journal.hidden]]
  if (paths.length > 0) {
    const copies = readAbandonedCopies(dir)
    const added = paths.map(canonicalPath)
      .filter(path => !copies.some(copy => copy.moveId === journal.moveId && samePathText(copy.path, path, effects.platform)))
      .map(path => ({ path, dataId: journal.dataId, moveId: journal.moveId, abandonedAt: now.toISOString() }))
    if (added.length > 0) fs.writeFile(join(dir, ABANDONED_FILENAME), abandonedCopiesText([...copies, ...added]))
  }
  const result: MoveResult = {
    version: journal.version,
    moveId: journal.moveId,
    outcome,
    source: journal.source,
    target: journal.target,
    ...journal.failure === undefined ? {} : { detail: journal.failure.detail },
    ...failure === undefined ? {} : { failure },
    leftovers: journal.leftovers,
    ...unused === undefined ? {} : { unusedCopy: { path: unused } },
    ...abandoned === undefined ? {} : { abandonedCopy: { path: abandoned } },
    ...original === undefined ? {} : { abandonedOriginal: { path: original } },
    ...kept === undefined ? {} : { keptOriginal: { path: kept } },
    ...journal.terminalRestoreFailed === undefined ? {} : { terminalNotRestored: { path: journal.target } },
    finishedAt: now.toISOString(),
  }
  fs.writeFile(join(dir, RESULT_FILENAME), `${JSON.stringify(result, null, 2)}\n`)
  for (const name of [DONE_LOG_FILENAME, JOURNAL_FILENAME, ...fs.readdir(dir).filter(entry => entry.endsWith('.tmp'))]) {
    if (fs.kind(join(dir, name)) !== 'absent') fs.unlink(join(dir, name))
  }
  return result
}

/**
 * Retire the recorded abandoned copies (see `readAbandonedCopies`) once their
 * drive is attached again: each takes the retired marker, loses its identity,
 * and is renamed to a visible "unused copy" folder beside it; its record is
 * then dropped. A folder counts as the recorded copy when it is a real
 * directory (never a link) holding this data's identity, its retired
 * identity, or a retired marker from the recorded move. A recorded folder
 * that is none of those is dropped without being touched; one whose drive is
 * still away stays recorded. Every step is repeatable.
 * @param dir - the move directory.
 * @param current - the data directory in use now; a record naming it is kept and left alone.
 * @param effects - the directory operations, the clock, and the names.
 * @param samePath - whether two paths name the same folder.
 * @returns the folders the copies were renamed to.
 * @throws when the record cannot be read or written, or a step fails.
 */
export async function retireAbandonedCopies(
  dir: string, current: string, effects: MoveEffects, samePath: (a: string, b: string) => boolean,
): Promise<string[]> {
  const { fs } = effects
  const retired: string[] = []
  let copies = readAbandonedCopies(dir)
  for (const copy of [...copies]) {
    if (samePath(copy.path, current)) continue
    const kind = fs.kind(copy.path)
    if (kind === 'absent') continue
    const read = (name: string): string | undefined => kind === 'dir' ? fs.readText(join(copy.path, name)) : undefined
    const id = read(DATA_ID_FILENAME)?.trim()
    const movedId = read(MOVED_ID_FILENAME)?.trim()
    const marker = read(RETIRED_FILENAME)
    const ours = id === copy.dataId || movedId === copy.dataId || (marker?.includes(copy.moveId) ?? false)
    if (ours) {
      if (marker === undefined) {
        fs.writeFile(join(copy.path, RETIRED_FILENAME), `${JSON.stringify({ dataId: copy.dataId, moveId: copy.moveId, retiredAt: effects.now().toISOString() })}\n`)
      }
      if (id === copy.dataId) fs.unlink(join(copy.path, DATA_ID_FILENAME))
      const to = freeSibling(effects, copy.path, 'unused')
      await renameWithRetry(effects, copy.path, to)
      retired.push(to)
    }
    copies = copies.filter(other => other !== copy)
    fs.writeFile(join(dir, ABANDONED_FILENAME), abandonedCopiesText(copies))
  }
  return retired
}

/**
 * A path as the abandoned-copies record keeps it: the real path when it
 * exists; when it does not (its drive is away), the real path of the nearest
 * folder above it that exists, joined with the rest; otherwise the path
 * resolved. Records compare as the platform compares names
 * ({@link samePathText}).
 * @param path - an absolute path.
 * @returns its canonical text.
 */
export function canonicalPath(path: string): string {
  const rest: string[] = []
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync.native(at), ...rest.reverse())
    } catch {
      // ENOENT (or unreachable): try the folder above, keeping this name.
    }
    if (dirname(at) === at) return resolve(path)
    rest.push(basename(at))
  }
}

/**
 * The pointer files a rollback writes back: the backup as it was, and the main
 * file as it was but numbered at least `generation`, the original's number
 * after the rollback raised it above the copy's. The pointer then keeps the
 * reference even if the original's `.dsh-data-generation` is lost later. A
 * main file that did not exist stays absent; one that was not a valid pointer
 * goes back byte for byte.
 * @param before - the files' text before the move.
 * @param generation - the original's number now.
 * @returns the files to write.
 */
export function rolledBackPointer(before: PointerBefore, generation: number): PointerBefore {
  const pointer = before.main === undefined ? undefined : parsePointerText(before.main)
  if (pointer === undefined) return before
  const main = pointerText(withGeneration(pointer, Math.max(pointer.generation ?? 0, generation)))
  return { ...before, main }
}

/**
 * The pointer a rollback leaves when it could not put the terminal setting
 * back and a terminal reads a value other than the one it read before the
 * move: the original, as the rolled-back pointer names it or, when there was
 * no pointer before the move, by the original's path, identity and number,
 * with that value as `lastSeenEnv`. A later launch that reads the value, from
 * a terminal profile or as the Windows user variable an application started
 * from the Start menu inherits, then stays on the original instead of
 * following it to a folder the rollback retired or renamed.
 * @param journal - the move.
 * @param seen - the `DSH_HOME` a terminal reads now ({@link MoveEffects.terminalSeen}).
 * @returns the pointer to write; `undefined` when the main file before the move was not a valid pointer, which then
 * stays byte for byte as it was.
 */
export function pointerSeeingTerminal(
  journal: Pick<MoveJournal, 'pointerBefore' | 'originalGeneration' | 'source' | 'dataId'>, seen: string,
): DataLocationPointer | undefined {
  const { main } = rolledBackPointer(journal.pointerBefore, journal.originalGeneration)
  const before = main === undefined ? undefined : parsePointerText(main)
  if (main !== undefined && before === undefined) return undefined
  const original = before
    ?? withGeneration({ version: POINTER_VERSION, path: journal.source, dataId: journal.dataId }, journal.originalGeneration)
  return { ...original, lastSeenEnv: seen }
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
 * Directory operations that report each call before making it, so a watcher
 * can tell a slow move from one blocked in a call that never returns.
 * @param fs - the operations.
 * @param activity - called before each operation.
 * @returns the reporting operations.
 */
export function reportingMoveFs(fs: MoveFs, activity: () => void): MoveFs {
  const wrap = <A extends unknown[], R>(call: (...args: A) => R) => (...args: A): R => {
    activity()
    return call(...args)
  }
  return {
    kind: wrap(fs.kind), readText: wrap(fs.readText), readdir: wrap(fs.readdir), writeFile: wrap(fs.writeFile), rename: wrap(fs.rename),
    unlink: wrap(fs.unlink), mkdir: wrap(fs.mkdir), rmdir: wrap(fs.rmdir), fingerprint: wrap(fs.fingerprint),
  }
}

/**
 * The real effects of a move, except the ones only the application knows
 * (the terminal). With `activity`, every directory operation, copied or
 * checked entry, and removed entry reports itself first (the executor's
 * heartbeat on its worker thread).
 * @param input - user data, `~/.dsh`, the platform, the terminal calls, and the heartbeat.
 * @returns the effects.
 */
export function nodeMoveEffects(input: {
  userData: string
  defaultHome: string
  platform: NodeJS.Platform
  /** The language of the folders the move leaves for the person. */
  locale: NameLocale
  syncTerminal: MoveEffects['syncTerminal']
  restoreTerminal: MoveEffects['restoreTerminal']
  terminalSeen: MoveEffects['terminalSeen']
  /** Called before each unit of work; absent in process. */
  activity?: () => void
}): MoveEffects {
  const activity = input.activity
  const removeFs: RemoveFs | undefined = activity === undefined ? undefined : {
    lstat: async (path) => { activity(); return await NODE_REMOVE_FS.lstat(path) },
    readdir: async (path) => { activity(); return await NODE_REMOVE_FS.readdir(path) },
    unlink: async (path) => { activity(); await NODE_REMOVE_FS.unlink(path) },
    rmdir: async (path) => { activity(); await NODE_REMOVE_FS.rmdir(path) },
    chmod: async (path, mode) => { activity(); await NODE_REMOVE_FS.chmod(path, mode) },
  }
  return {
    platform: input.platform,
    fs: activity === undefined ? NODE_MOVE_FS : reportingMoveFs(nodeMoveFs(fsyncDirectory, activity), activity),
    copy: async (request, signal, onProgress) => { await copyTree(request, signal, onProgress, activity) },
    verify: async (request, signal, onProgress) => (await verifyTree(request, signal, onProgress, activity)).problems,
    repair: async (request, extras, forget) => {
      for (const rel of extras) await removeExtra(request.dest, rel, input.platform)
      forgetDone(request.doneLog, forget)
    },
    remove: path => removeTree(path, { platform: input.platform, ...removeFs === undefined ? {} : { fs: removeFs } }),
    scanLinks: async (source) => {
      const scan = await scanTree(source, { exclude: [], onActivity: activity })
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
    terminalSeen: input.terminalSeen,
    restoreHomeLink: (before) => { restoreHomeLink(input.defaultHome, before, input.platform) },
    keptFolderName: (kind, date, attempt) => keptFolderName(input.locale, kind, date, attempt),
    sleep: (ms) => {
      activity?.()
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    },
    now: () => new Date(),
  }
}
