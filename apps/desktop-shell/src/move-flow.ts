/**
 * Carrying a data move to the point where the application relaunches or
 * quits, with the person in the loop: the executor runs on its worker, the
 * progress window follows it, a move stopped partway shows its page and takes
 * the person's choice, and an unreadable record of abandoned copies is asked
 * about the same way the launch asks. The windows are behind {@link MoveUi};
 * `move-window.ts` is the Electron half.
 * @module @deepseek-ai/dsh-desktop-shell/move-flow
 */

import type { AbandonedRecordHost } from './data-location-boot.ts'
import { readAbandonedOrAsk } from './data-location-boot.ts'
import { lockPlaces, relaunchHome } from './move-boot.ts'
import {
  blockedPage, discardLockPage, lockLostPage, lockPage, progressView, stopPage, type ForeignLock, type MoveLink, type MovePage,
  type LostLockWay, type ProgressClock, type ProgressView,
} from './move-page.ts'
import type { MoveText, RollBackCopy } from './move-text.ts'
import {
  ExecutorError, type ExecutorBefore, type ExecutorOptions, type ExecutorPrepared, type ExecutorRequest, type MainEffects, runMoveExecutor,
} from './move/executor.ts'
import { leftBehind, readJournal, type MoveJournal } from './move/journal.ts'
import { checkOwnLock, claimLock, HEARTBEAT_INTERVAL_MS, refreshMoveLock, releaseMoveLock, type LockProbes, type LockState } from './move/lock.ts'
import { keptFolderName, type NameLocale } from './move/names.ts'
import { ABANDONABLE_PHASES, abandonMove, lockExpectedNow, NODE_MOVE_FS, WITHDRAWABLE_PHASES, type MoveFs, type MoveOutcome } from './move/run.ts'

/** The windows a move shows. */
export interface MoveUi {
  /** Show or update the progress window. */
  showProgress: (view: ProgressView) => void
  /**
   * Show a page and wait for a button other than a reveal (the window shows
   * `page.reveal[index]` itself).
   * @returns the link of the button pressed.
   */
  showPage: (page: MovePage) => Promise<Exclude<MoveLink, { kind: 'reveal' }>>
  /** Fired when the person asks to cancel from the progress window. */
  cancel: AbortSignal
}

/** What a move flow needs. */
export interface MoveFlowDeps {
  /** The move; its `before` step (a failed health check) is taken once, on the first run. */
  request: ExecutorRequest
  main: MainEffects
  ui: MoveUi
  text: MoveText
  locale: NameLocale
  /** The launch prompts' host, for an unreadable record of abandoned copies. */
  abandoned: AbandonedRecordHost
  log: (line: string) => void
  now: () => Date
  /** Process start times, for telling this installation's own earlier runs from one that still runs. */
  lockProbes: Pick<LockProbes, 'startTimeOf'>
  /** Milliseconds between two heartbeats; {@link HEARTBEAT_INTERVAL_MS} when absent. */
  heartbeatMs?: number
  /** Starts the executor's worker; the real one when absent. */
  start?: ExecutorOptions['start']
  stallMs?: number
}

/** Where a flow leaves the application. */
export type MoveFlowEnd =
  /** Relaunch with `home` exported as the data directory. */
  | { kind: 'relaunch'; home: string }
  /** Quit; the journal stays, and the next launch resumes the move. */
  | { kind: 'quit' }
  /** The move finished its cleanup in the background, perhaps with leftovers. */
  | { kind: 'done'; outcome: MoveOutcome }

/**
 * Carry the move recorded under `deps.request.dir` forward until it ends,
 * switches, or the person quits.
 * @param deps - the move, the terminal effects, the windows, and the sentences.
 * @returns what the application does next.
 * @throws when the journal cannot be read, or a choice cannot be recorded.
 */
export async function carryMove(deps: MoveFlowDeps): Promise<MoveFlowEnd> {
  const { request } = deps
  // A lock that is not this move's is only logged here: the worker checks it before each step and stops there.
  const beat = async (): Promise<void> => {
    try {
      const journal = readJournal(request.dir)
      if (journal === undefined) return
      const check = await refreshMoveLock(lockExpectedNow(NODE_MOVE_FS, journal), request.lockSelf, deps.now(), deps.lockProbes)
      if (check.kind === 'lost') deps.log(`[desktop] data move: the move lock is not this move's; not refreshed: ${check.detail}\n`)
    } catch (error) {
      deps.log(`[desktop] data move: could not refresh the move lock: ${String(error)}\n`)
    }
  }
  await beat()
  const heartbeat = setInterval(() => { void beat() }, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS)
  try {
    return await carry(deps)
  } finally {
    clearInterval(heartbeat)
  }
}

/**
 * What taking a move back would do with the copy at the new location, for its page.
 * @param journal - the journal.
 * @param fs - looks at the new location.
 * @returns none on one volume; unreachable when its removal was given up, or when it cannot be found and was never
 * made the data location; unreachable-exposed when it cannot be found and was (the take-back then stops at the page
 * for a missing new location and asks again); otherwise kept (it was made the data location) or deleted.
 */
export function rollBackCopyOf(journal: MoveJournal, fs: Pick<MoveFs, 'kind'>): RollBackCopy {
  if (journal.sameVolume) return 'none'
  if (leftBehind(journal, journal.target)) return 'unreachable'
  if (fs.kind(journal.target) === 'absent') return journal.targetExposed ? 'unreachable-exposed' : 'unreachable'
  return journal.targetExposed ? 'kept' : 'deleted'
}

/**
 * Ask the person what to do with a move that stopped because its lock was not
 * this move's. The page says why, read again now; the move may be tried
 * again, abandoned while only its copy changed ({@link abandonMove}), or taken
 * back once hiding began (`rollBackMove`, on the worker, since it prints the
 * new location).
 * A lock that reads as this move's again is tried again without a page, once
 * in a row: when the worker loses it again at once, the page says it could
 * not be read.
 * @param deps - the move, the windows, the sentences, and the log.
 * @param detail - where the lock was lost.
 * @param mayRetryAlone - whether the move may be tried again without asking.
 * @returns `quit`, or `go` with the step the worker takes first; `retried` tells a retry without a page.
 * @throws when the journal cannot be read or written.
 */
async function askAfterLostLock(
  deps: MoveFlowDeps, detail: string, mayRetryAlone: boolean,
): Promise<{ kind: 'quit' } | { kind: 'go'; before?: ExecutorBefore; retried?: true }> {
  const { request, text, log } = deps
  log(`[desktop] data move: stopped: the move lock is not this move's: ${detail}\n`)
  const journal = readJournal(request.dir)
  if (journal === undefined) return { kind: 'quit' }
  const way: LostLockWay | undefined = ABANDONABLE_PHASES.has(journal.phase)
    ? { kind: 'abandon' }
    : WITHDRAWABLE_PHASES.has(journal.phase) ? { kind: 'roll-back', copy: rollBackCopyOf(journal, NODE_MOVE_FS) } : undefined
  if (way === undefined) return { kind: 'quit' }
  // Read again: the worker's message names only where, and a lock that reads as this move's now could not be read then.
  const now = await checkOwnLock(lockExpectedNow(NODE_MOVE_FS, journal), request.lockSelf, deps.lockProbes)
  if (now.kind === 'ours' && mayRetryAlone) {
    log('[desktop] data move: the move lock reads as this move\'s again; trying again\n')
    return { kind: 'go', retried: true }
  }
  const link = await deps.ui.showPage(lockLostPage(text, now.kind === 'lost' ? now.cause : 'unreadable', way))
  const reason = `the move lock was lost: ${detail}`
  switch (link.kind) {
    case 'retry':
      return { kind: 'go' }
    case 'abandon':
      if (way.kind !== 'abandon') return { kind: 'quit' }
      abandonMove(request.dir, reason)
      log('[desktop] data move: the person abandoned the move after its lock was lost\n')
      return { kind: 'go' }
    case 'roll-back':
      if (way.kind !== 'roll-back') return { kind: 'quit' }
      log('[desktop] data move: the person took the move back after its lock was lost\n')
      return { kind: 'go', before: { kind: 'roll-back', detail: reason } }
    default:
      return { kind: 'quit' }
  }
}

/**
 * {@link carryMove} without the lock's heartbeat.
 * @param deps - the move, the terminal effects, the windows, and the sentences.
 * @returns what the application does next.
 */
async function carry(deps: MoveFlowDeps): Promise<MoveFlowEnd> {
  const { request, ui, text, log } = deps
  const clock: ProgressClock = { startedAt: Date.now(), stage: undefined }
  let refreshed = false
  // The person's choice, or a failed health check, taken on the worker before it carries the move on: both print the new location.
  let before: ExecutorBefore | undefined = request.before
  // Whether the last lost lock was tried again without a page; the next one in a row is asked about.
  let retriedAlone = false
  for (;;) {
    let journal = readJournal(request.dir)
    if (journal === undefined) return { kind: 'quit' }
    let outcome: MoveOutcome
    try {
      const { before: _earlier, ...plain } = request
      outcome = await runMoveExecutor(before === undefined ? plain : { ...plain, before }, deps.main, {
        onPrepared: (step: ExecutorPrepared) => {
          before = undefined
          if (step.journal !== undefined) journal = step.journal
          if (step.result !== 'recorded') {
            log(`[desktop] data move: the person's choice: ${step.result}\n`)
            refreshed = step.result === 'refused'
          }
        },
        cancel: ui.cancel,
        onProgress: (progress) => { ui.showProgress(progressView(progress, text, clock, Date.now())) },
        ...deps.start === undefined ? {} : { start: deps.start },
        ...deps.stallMs === undefined ? {} : { stallMs: deps.stallMs },
      })
    } catch (error) {
      if (!(error instanceof ExecutorError)) throw error
      if (error.name === 'MoveLockLostError') {
        const next = await askAfterLostLock(deps, error.message, !retriedAlone)
        if (next.kind === 'quit') return { kind: 'quit' }
        retriedAlone = next.retried === true
        if (next.before !== undefined) before = next.before
        continue
      }
      log(`[desktop] data move: ${error.stalled ? 'stalled' : 'failed'}: ${error.name}: ${error.message}\n`)
      if (error.name === 'JournalError' && error.message.startsWith('abandoned copies')) {
        // The record the move reads and writes cannot be read: the same page as at launch, then the move goes on.
        if (await readAbandonedOrAsk(deps.abandoned) === undefined) return { kind: 'quit' }
        continue
      }
      const sentence = error.stalled ? text.stalled : text.failed(error.message)
      await ui.showPage(stopPage(text.stoppedTitle, sentence, text, { platform: request.platform }))
      return { kind: 'quit' }
    }
    retriedAlone = false
    log(`[desktop] data move: ${outcome.kind}${outcome.kind === 'blocked' ? ` (${outcome.reason})` : ''}\n`)
    switch (outcome.kind) {
      case 'blocked': {
        const page = blockedPage(journal, outcome, text, {
          platform: request.platform, unusedName: keptFolderName(deps.locale, 'unused', deps.now(), 1), refreshed,
        })
        const link = await ui.showPage(page)
        if (link.kind !== 'choose') return { kind: 'quit' }
        log(`[desktop] data move: the person chose ${link.choice}\n`)
        before = { kind: 'resolve', choice: link.choice, seen: { reason: outcome.reason, targetPrint: outcome.targetPrint } }
        refreshed = false
        continue
      }
      case 'ended':
        releaseMoveLock(lockPlaces(journal, outcome.result), request.lockSelf)
        if (journal.phase === 'cleanup') return { kind: 'done', outcome }
        return { kind: 'relaunch', home: relaunchHome(journal, outcome) ?? journal.source }
      case 'switched':
        return { kind: 'relaunch', home: journal.target }
      case 'cleanup-incomplete':
        return { kind: 'done', outcome }
      default:
        return outcome satisfies never
    }
  }
}

/** What {@link settleForeignLock} works with. */
export interface ForeignLockDeps {
  ui: Pick<MoveUi, 'showPage'>
  text: MoveText
  lock: ForeignLock
  /** Reads the lock again, after a discard found it changed. */
  inspect: () => Promise<LockState>
  /** The data directory. */
  home: string
  platform: NodeJS.Platform
  log: (line: string) => void
}

/**
 * Show the page for another installation's lock on the data. On an
 * unfinished move's page the person may discard that move: after a
 * confirmation only the lock file is removed, and only while it is still the
 * lock the page showed ({@link claimLock}). A lock that changed meanwhile
 * (its holder refreshed it) is put back, read again, and its page shown anew
 * with a notice that the page was updated. The data is not touched.
 * @param deps - the window, the sentences, the lock, and the log.
 * @returns `discarded` once the lock the person confirmed was removed or is no longer another installation's (the
 * launch starts again and looks at the lock anew), otherwise `quit`.
 * @throws when the lock cannot be renamed or read.
 */
export async function settleForeignLock(deps: ForeignLockDeps): Promise<'quit' | 'discarded'> {
  const { ui, text } = deps
  let lock = deps.lock
  let notice: string | undefined
  for (;;) {
    const link = await ui.showPage(lockPage(text, lock, deps.home, deps.platform, notice))
    notice = undefined
    if (link.kind !== 'discard-lock' || lock.kind !== 'unfinished') return 'quit'
    const answer = await ui.showPage(discardLockPage(text, lock))
    if (answer.kind === 'back') continue
    if (answer.kind !== 'confirm') return 'quit'
    const result = claimLock(lock.path, lock.owner)
    deps.log(`[desktop] data move: the person discarded ${lock.owner.userData}'s unfinished move; its lock ${lock.path}: ${result}\n`)
    if (result !== 'changed') return 'discarded'
    const now = await deps.inspect()
    if (now.kind === 'none' || now.kind === 'ours') return 'discarded'
    lock = now
    notice = text.refreshed
  }
}
