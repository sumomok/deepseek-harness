/**
 * Worker-thread entry that runs one copy or check and posts its progress and
 * result to the thread that started it (see
 * [[@deepseek-ai/dsh-desktop-shell/move/worker]]). The string `abort` from the
 * parent aborts the job between chunks.
 * @module @deepseek-ai/dsh-desktop-shell/move/move-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import { copyTree, CopyMismatchError, type ByteProgress } from './copier.ts'
import { verifyTree } from './verify.ts'
import { PROGRESS_INTERVAL_MS, type MoveJob, type MoveJobResult, type WorkerMessage } from './worker.ts'

const port = parentPort
if (port === null) throw new Error('move-worker runs only as a worker thread')
const job = workerData as MoveJob
const controller = new AbortController()
port.on('message', (message: unknown) => {
  if (message === 'abort') controller.abort()
})

let lastAlive = 0
const alive = (): void => {
  const now = Date.now()
  if (now - lastAlive < PROGRESS_INTERVAL_MS) return
  lastAlive = now
  const message: WorkerMessage = { type: 'alive' }
  port.postMessage(message)
}

let last = 0
const progress = (value: ByteProgress): void => {
  const now = Date.now()
  if (now - last < PROGRESS_INTERVAL_MS && value.done < value.total) return
  last = now
  const message: WorkerMessage = { type: 'progress', progress: { done: value.done, total: value.total } }
  port.postMessage(message)
}

/**
 * Run the job.
 * @returns its result.
 */
async function run(): Promise<MoveJobResult> {
  switch (job.kind) {
    case 'copy': {
      const report = await copyTree(job.request, controller.signal, progress, alive)
      return {
        kind: 'copy',
        summary: { copied: report.copied, skipped: report.skipped, bytesCopied: report.bytesCopied, bytes: report.scan.bytes },
      }
    }
    case 'verify': {
      const report = await verifyTree(job.request, controller.signal, progress, alive)
      return { kind: 'verify', problems: report.problems, files: report.files, hashedBytes: report.hashedBytes }
    }
    default:
      return job satisfies never
  }
}

run().then(
  (result) => {
    const message: WorkerMessage = { type: 'done', result }
    port.postMessage(message)
    port.close()
  },
  (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    const message: WorkerMessage = {
      type: 'failed',
      name: failure.name,
      message: failure.message,
      aborted: controller.signal.aborted,
      ...error instanceof CopyMismatchError ? { rel: error.rel } : {},
    }
    port.postMessage(message)
    port.close()
  },
)
