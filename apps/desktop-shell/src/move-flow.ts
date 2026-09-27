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
import { blockedPage, progressView, stopPage, type MoveLink, type MovePage, type ProgressClock, type ProgressView } from './move-page.ts'
import type { MoveText } from './move-text.ts'
import { ExecutorError, type ExecutorOptions, type ExecutorRequest, type MainEffects, runMoveExecutor } from './move/executor.ts'
import { readJournal } from './move/journal.ts'
import { HEARTBEAT_INTERVAL_MS, refreshMoveLock, releaseMoveLock, type LockSelf } from './move/lock.ts'
import { keptFolderName, type NameLocale } from './move/names.ts'
import { resolveBlocked, type MoveOutcome } from './move/run.ts'

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
  for (;;) {
    const journal = readJournal(request.dir)
    if (journal === undefined) return { kind: 'quit' }
    let outcome: MoveOutcome
    try {
      outcome = await runMoveExecutor(request, deps.main, {
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
        const applied = resolveBlocked(request.dir, link.choice, { reason: outcome.reason, targetPrint: outcome.targetPrint })
        log(`[desktop] data move: the person chose ${link.choice}: ${applied}\n`)
        refreshed = applied === 'refused'
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
