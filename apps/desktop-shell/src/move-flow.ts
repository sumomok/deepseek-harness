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
  blockedPage, discardLockPage, lockPage, progressView, stopPage, type ForeignLock, type MoveLink, type MovePage, type ProgressClock,
  type ProgressView,
} from './move-page.ts'
import type { MoveText } from './move-text.ts'
import {
  ExecutorError, type ExecutorBefore, type ExecutorOptions, type ExecutorPrepared, type ExecutorRequest, type MainEffects, runMoveExecutor,
} from './move/executor.ts'
import { readJournal } from './move/journal.ts'
import { claimLock, HEARTBEAT_INTERVAL_MS, refreshMoveLock, releaseMoveLock, type LockSelf, type LockState } from './move/lock.ts'
import { keptFolderName, type NameLocale } from './move/names.ts'
import type { MoveOutcome } from './move/run.ts'

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
  /** This installation and process, for the move lock's heartbeat. */
  lockSelf: LockSelf
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
  const beat = (): void => {
    const journal = readJournal(deps.request.dir)
    if (journal === undefined) return
    try {
      refreshMoveLock(lockPlaces(journal), deps.lockSelf, deps.now())
    } catch (error) {
      deps.log(`[desktop] data move: could not refresh the move lock: ${String(error)}\n`)
    }
  }
  beat()
  const heartbeat = setInterval(beat, deps.heartbeatMs ?? HEARTBEAT_INTERVAL_MS)
  try {
    return await carry(deps)
  } finally {
    clearInterval(heartbeat)
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
        releaseMoveLock(lockPlaces(journal, outcome.result), deps.lockSelf)
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
