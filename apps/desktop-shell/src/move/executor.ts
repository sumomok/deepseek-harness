/**
 * Running a data move on a worker thread. The whole executor —
 * {@link advanceMove} with its renames, markers, removals, copy and check —
 * runs there, because its synchronous calls block the thread they run on for
 * as long as a disk that stopped answering holds them; on the main thread
 * that would freeze the progress window and the watchdog with it. Only the
 * two terminal effects come back to the main process, as request and reply
 * messages: they run PowerShell or read a login shell, which the application
 * owns.
 *
 * The worker reports each unit of work before starting it. The main side
 * gives the move up as hung when {@link MOVE_STALL_TIMEOUT_MS} pass without a
 * report while no terminal effect is running in the main process; it asks the
 * worker to terminate, but does not wait for it, since a thread blocked in a
 * file system call may not stop until that call returns. The journal stays on
 * disk, so the next launch resumes the move.
 *
 * The worker entry is `executor-worker` beside this module, with this
 * module's own extension (see [[@deepseek-ai/dsh-desktop-shell/move/worker]]).
 * @module @deepseek-ai/dsh-desktop-shell/move/executor
 */

import { Worker } from 'node:worker_threads'
import type { TerminalSnapshot } from '../terminal-env.ts'
import type { LockSelf } from './lock.ts'
import type { NameLocale } from './names.ts'
import type { BlockedChoice, HealthFailures, MoveJournal } from './journal.ts'
import type { BlockedView, MoveOutcome, MoveProgress, ResolveOutcome } from './run.ts'
import { MOVE_STALL_TIMEOUT_MS } from './worker.ts'

/** What the worker needs to run a move. */
export interface ExecutorRequest {
  /** The move directory, holding the journal. */
  dir: string
  userData: string
  defaultHome: string
  platform: NodeJS.Platform
  locale: NameLocale
  /** The application's process id, recorded in the journal. */
  pid: number
  /** This installation and process, as the move lock names them; the worker stops the move when the lock is no longer this. */
  lockSelf: LockSelf
  /**
   * A step the worker takes before carrying the move on, because it prints
   * the new location, which can take long on a large tree: the person's
   * choice on a stopped move ({@link resolveBlocked}), or a failed health
   * check ({@link recordHealth}).
   */
  before?: ExecutorBefore
}

/** A step before the move is carried on; see {@link ExecutorRequest.before}. */
export type ExecutorBefore =
  | { kind: 'resolve'; choice: BlockedChoice; seen: BlockedView }
  /**
   * `detail` is what the log records; `failures` is what Settings and the
   * page after a kept new location name. The journal records both
   * ({@link recordHealth}).
   */
  | { kind: 'health-failed'; detail: string; failures: HealthFailures }
  /** Take the move back after it lost its lock ({@link rollBackMove}). */
  | { kind: 'roll-back'; detail: string }

/** What the step before the move came to. */
export interface ExecutorPrepared {
  /** {@link resolveBlocked}'s answer, or `recorded` for a failed health check. */
  result: ResolveOutcome | 'recorded'
  /** The journal right after the step, which the move then starts from. */
  journal: MoveJournal | undefined
}

/** A terminal effect the worker asks the main process to run. */
export type MainCall =
  | { effect: 'syncTerminal'; target: string }
  | { effect: 'restoreTerminal'; snapshot: TerminalSnapshot }

/** Messages the worker posts. */
export type ExecutorMessage =
  | { type: 'alive' }
  | { type: 'progress'; progress: MoveProgress }
  | { type: 'call'; id: number; call: MainCall }
  /** What the step before the move came to. */
  | { type: 'prepared'; prepared: ExecutorPrepared }
  | { type: 'done'; outcome: MoveOutcome }
  | { type: 'failed'; name: string; message: string }

/** Messages the main process posts. */
export type ExecutorCommand =
  | { type: 'cancel' }
  /** A terminal effect's answer: `syncTerminal`'s `lastSeenEnv` (`null` for none), or why it failed. */
  | { type: 'reply'; id: number; ok: true; value: string | null }
  | { type: 'reply'; id: number; ok: false; message: string }

/** The terminal effects, run in the main process. */
export interface MainEffects {
  /**
   * Write the target as the terminal's `DSH_HOME` and read it back.
   * @returns the `lastSeenEnv` to record; `undefined` for none.
   */
  syncTerminal: (target: string) => Promise<string | undefined>
  /** Put the terminal setting back from its snapshot. */
  restoreTerminal: (snapshot: TerminalSnapshot) => Promise<void>
}

/** The parts of a worker the executor uses; a real `Worker` in the app. */
export interface ExecutorThread {
  on(event: 'message', listener: (message: ExecutorMessage) => void): void
  on(event: 'error', listener: (error: Error) => void): void
  on(event: 'exit', listener: (code: number) => void): void
  postMessage: (command: ExecutorCommand) => void
  terminate: () => Promise<number>
}

/** Thrown when the move failed in the worker, or the worker went away or stopped reporting. */
export class ExecutorError extends Error {
  /** Whether the move was given up because it stopped reporting. */
  readonly stalled: boolean

  /**
   * @param message - what happened.
   * @param name - the name of the error the worker caught (`JournalError` for an unreadable record).
   * @param stalled - whether it stopped reporting.
   */
  constructor(message: string, name: string, stalled = false) {
    super(message)
    this.name = name
    this.stalled = stalled
  }
}

/** Options of {@link runMoveExecutor}. */
export interface ExecutorOptions {
  /** Asks the move to cancel; honored only while the copy is partial. */
  cancel?: AbortSignal
  onProgress?: (progress: MoveProgress) => void
  /** Receives what the step before the move came to. */
  onPrepared?: (prepared: ExecutorPrepared) => void
  /** Milliseconds without a report before the move counts as hung; {@link MOVE_STALL_TIMEOUT_MS} when absent. */
  stallMs?: number
  /** Starts the worker; the real `executor-worker` when absent. */
  start?: (request: ExecutorRequest) => ExecutorThread
}

/**
 * The worker entry beside this module, with this module's own extension.
 * @param moduleUrl - `import.meta.url` of this module.
 * @returns the entry's URL.
 */
export function executorEntryUrl(moduleUrl: string): URL {
  return new URL(moduleUrl.endsWith('.ts') ? './executor-worker.ts' : './executor-worker.js', moduleUrl)
}

/**
 * Start the real executor worker.
 * @param request - the move.
 * @returns the worker.
 */
function startWorker(request: ExecutorRequest): ExecutorThread {
  return new Worker(executorEntryUrl(import.meta.url), { workerData: request })
}

/**
 * Carry a move forward on a worker thread until it needs the application
 * ({@link advanceMove}'s outcome).
 * @param request - the move.
 * @param main - the terminal effects.
 * @param options - cancel, progress, the stall limit, and the worker.
 * @returns the move's outcome.
 * @throws an {@link ExecutorError} when the move failed, the worker went away, or it stopped reporting.
 */
export function runMoveExecutor(request: ExecutorRequest, main: MainEffects, options: ExecutorOptions = {}): Promise<MoveOutcome> {
  const stallMs = options.stallMs ?? MOVE_STALL_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const thread = (options.start ?? startWorker)(request)
    let settled = false
    let pending = 0
    let stall: NodeJS.Timeout | undefined
    const watch = (): void => {
      clearTimeout(stall)
      // A terminal effect in this process is not the worker's to report on.
      if (pending > 0) return
      stall = setTimeout(() => {
        finish(() => { reject(new ExecutorError(`data move made no progress for ${String(stallMs)}ms`, 'ExecutorError', true)) })
        void thread.terminate()
      }, stallMs)
    }
    const onCancel = (): void => { thread.postMessage({ type: 'cancel' }) }
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(stall)
      options.cancel?.removeEventListener('abort', onCancel)
      outcome()
    }
    options.cancel?.addEventListener('abort', onCancel, { once: true })
    if (options.cancel?.aborted === true) onCancel()
    const answer = async (id: number, call: MainCall): Promise<void> => {
      pending += 1
      clearTimeout(stall)
      try {
        let value: string | undefined
        if (call.effect === 'syncTerminal') value = await main.syncTerminal(call.target)
        else await main.restoreTerminal(call.snapshot)
        if (!settled) thread.postMessage({ type: 'reply', id, ok: true, value: value ?? null })
      } catch (error) {
        if (!settled) thread.postMessage({ type: 'reply', id, ok: false, message: error instanceof Error ? error.message : String(error) })
      } finally {
        pending -= 1
        if (!settled) watch()
      }
    }
    watch()
    thread.on('message', (message) => {
      if (settled) return
      watch()
      switch (message.type) {
        case 'alive':
          break
        case 'progress':
          options.onProgress?.(message.progress)
          break
        case 'call':
          void answer(message.id, message.call)
          break
        case 'prepared':
          options.onPrepared?.(message.prepared)
          break
        case 'done':
          finish(() => { resolve(message.outcome) })
          break
        case 'failed':
          finish(() => { reject(new ExecutorError(message.message, message.name)) })
          break
        default:
          message satisfies never
      }
    })
    thread.on('error', (error) => {
      finish(() => { reject(new ExecutorError(error.message, error.name)) })
    })
    thread.on('exit', (code) => {
      finish(() => { reject(new ExecutorError(`data move worker exited with code ${String(code)} before answering`, 'ExecutorError')) })
    })
  })
}
