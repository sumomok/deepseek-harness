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
  | { type: 'done'; result: MoveJobResult }
  | { type: 'failed'; name: string; message: string; rel?: string; aborted: boolean }

/** Minimum interval between two progress messages. */
export const PROGRESS_INTERVAL_MS = 100

/** Thrown in the main thread when a job failed in the worker. */
export class MoveJobError extends Error {
  /** The failing file, for a copy mismatch. */
  readonly rel: string | undefined
  /** Whether the job stopped because it was aborted. */
  readonly aborted: boolean

  /**
   * @param message - the worker's error message.
   * @param name - the worker's error name.
   * @param rel - the failing file, when known.
   * @param aborted - whether it was an abort.
   */
  constructor(message: string, name: string, rel: string | undefined, aborted: boolean) {
    super(message)
    this.name = name
    this.rel = rel
    this.aborted = aborted
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
 * Run one job on a new worker thread.
 * @param job - the copy or check.
 * @param options - an abort signal, and a progress callback.
 * @returns the job's result.
 * @throws a {@link MoveJobError} when the job failed or was aborted, or the worker exited without an answer.
 */
export function runMoveJob(
  job: MoveJob,
  options: { signal?: AbortSignal; onProgress?: (progress: ByteProgress) => void } = {},
): Promise<MoveJobResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerEntryUrl(import.meta.url), { workerData: job })
    let settled = false
    const onAbort = (): void => { worker.postMessage('abort') }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted === true) onAbort()
    const finish = (outcome: () => void): void => {
      if (settled) return
      settled = true
      options.signal?.removeEventListener('abort', onAbort)
      outcome()
    }
    worker.on('message', (message: WorkerMessage) => {
      switch (message.type) {
        case 'progress':
          options.onProgress?.(message.progress)
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
