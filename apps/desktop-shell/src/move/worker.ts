/**
 * Running a copy or a check on a worker thread, so hashing gigabytes never
 * holds the main process's event loop and the progress window keeps moving.
 *
 * The worker entry is `move-worker` beside this module, loaded with the
 * extension this module was loaded with: `.js` from the built `lib/`, `.ts`
 * when Node runs the source (tests), which it can because the move modules use
 * only erasable TypeScript and import nothing but `node:` modules and sibling
 * files.
 * @module @deepseek-ai/dsh-desktop-shell/move/worker
 */

import { Worker } from 'node:worker_threads'
import type { ByteProgress, CopyRequest } from './copier.ts'
import type { VerifyProblem, VerifyRequest } from './verify.ts'

/** A job for the worker. */
export type MoveJob =
  | { kind: 'copy'; request: CopyRequest }
  | { kind: 'verify'; request: VerifyRequest }

/** A copy's report without its scan, which stays in the worker. */
export interface CopySummary {
  copied: string[]
  skipped: number
  bytesCopied: number
  /** Bytes in the tree copied. */
  bytes: number
}

/** What a job returns. */
export type MoveJobResult =
  | { kind: 'copy'; summary: CopySummary }
  | { kind: 'verify'; problems: VerifyProblem[]; files: number; hashedBytes: number }

/** Messages the worker posts. */
export type WorkerMessage =
  | { type: 'progress'; progress: ByteProgress }
  | { type: 'alive' }
  | { type: 'done'; result: MoveJobResult }
  | { type: 'failed'; name: string; message: string; rel?: string; aborted: boolean }

/** Minimum interval between two progress messages, and between two `alive` messages. */
export const PROGRESS_INTERVAL_MS = 100
/**
 * How long a job may go without reading or writing a single entry or chunk
 * before it counts as hung: a write to a disk that was unplugged, or a network
 * volume that stopped answering, can block forever without failing.
 */
export const MOVE_STALL_TIMEOUT_MS = 120_000

/** Thrown in the main thread when a job failed in the worker. */
export class MoveJobError extends Error {
  /** The failing file, for a copy mismatch. */
  readonly rel: string | undefined
  /** Whether the job stopped because it was aborted. */
  readonly aborted: boolean
  /** Whether the job was given up because it stopped making progress. */
  readonly stalled: boolean

  /**
   * @param message - the worker's error message.
   * @param name - the worker's error name.
   * @param rel - the failing file, when known.
   * @param aborted - whether it was an abort.
   * @param stalled - whether it was given up as hung.
   */
  constructor(message: string, name: string, rel: string | undefined, aborted: boolean, stalled = false) {
    super(message)
    this.name = name
    this.rel = rel
    this.aborted = aborted
    this.stalled = stalled
  }
}

/**
 * The worker entry beside this module, with this module's own extension.
 * @param moduleUrl - `import.meta.url` of this module.
 * @returns the entry's URL.
 */
export function workerEntryUrl(moduleUrl: string): URL {
  return new URL(moduleUrl.endsWith('.ts') ? './move-worker.ts' : './move-worker.js', moduleUrl)
}

/**
 * Run one job on a new worker thread. The job is given up when the worker
 * sends nothing for `stallMs`: the worker is asked to terminate, but the
 * returned promise does not wait for it, because a thread blocked in a file
 * system call may not stop until that call returns.
 * @param job - the copy or check.
 * @param options - an abort signal, a progress callback, and the stall limit ({@link MOVE_STALL_TIMEOUT_MS} when absent).
 * @returns the job's result.
 * @throws a {@link MoveJobError} when the job failed, was aborted, stalled, or the worker exited without an answer.
 */
export function runMoveJob(
  job: MoveJob,
  options: { signal?: AbortSignal; onProgress?: (progress: ByteProgress) => void; stallMs?: number } = {},
): Promise<MoveJobResult> {
  const stallMs = options.stallMs ?? MOVE_STALL_TIMEOUT_MS
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntryUrl(import.meta.url), { workerData: job })
    let settled = false
    let stall: NodeJS.Timeout | undefined
    const watch = (): void => {
      clearTimeout(stall)
      stall = setTimeout(() => {
        finish(() => { reject(new MoveJobError(`move worker made no progress for ${String(stallMs)}ms`, 'Error', undefined, false, true)) })
        void worker.terminate()
      }, stallMs)
    }
    const onAbort = (): void => { worker.postMessage('abort') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(stall)
      options.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    watch()
    worker.on('message', (message: WorkerMessage) => {
      watch()
      switch (message.type) {
        case 'progress':
          options.onProgress?.(message.progress)
          break
        case 'alive':
          break
        case 'done':
          finish(() => { resolve(message.result) })
          break
        case 'failed':
          finish(() => { reject(new MoveJobError(message.message, message.name, message.rel, message.aborted)) })
          break
        default:
          message satisfies never
      }
    })
    worker.on('error', (error) => {
      finish(() => { reject(new MoveJobError(error.message, error.name, undefined, false)) })
    })
    worker.on('exit', (code) => {
      finish(() => { reject(new MoveJobError(`move worker exited with code ${String(code)} before answering`, 'Error', undefined, false)) })
    })
  })
}
