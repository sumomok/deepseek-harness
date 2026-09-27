/**
 * Worker-thread entry that carries a data move forward with
 * {@link advanceMove} and posts what happens to the main process (see
 * [[@deepseek-ai/dsh-desktop-shell/move/executor]]): a report before each
 * unit of work, the progress, the terminal effects it needs run there, and
 * the outcome. `cancel` from the main process asks the move to cancel.
 * @module @deepseek-ai/dsh-desktop-shell/move/executor-worker
 */

import { parentPort, workerData } from 'node:worker_threads'
import type { ExecutorCommand, ExecutorMessage, ExecutorRequest, MainCall } from './executor.ts'
import { readJournal } from './journal.ts'
import { advanceMove, nodeMoveEffects, recordHealth, resolveBlocked, type MoveEffects, type ResolveOutcome } from './run.ts'
import { PROGRESS_INTERVAL_MS } from './worker.ts'

const port = parentPort
if (port === null) throw new Error('executor-worker runs only as a worker thread')
const request = workerData as ExecutorRequest
const cancel = new AbortController()
const replies = new Map<number, { resolve: (value: string | null) => void; reject: (error: Error) => void }>()
let nextId = 1

const post = (message: ExecutorMessage): void => { port.postMessage(message) }

port.on('message', (command: ExecutorCommand) => {
  if (command.type === 'cancel') {
    cancel.abort()
    return
  }
  const waiting = replies.get(command.id)
  replies.delete(command.id)
  if (command.ok) waiting?.resolve(command.value)
  else waiting?.reject(new Error(command.message))
})

let lastAlive = 0
const alive = (): void => {
  const now = Date.now()
  if (now - lastAlive < PROGRESS_INTERVAL_MS) return
  lastAlive = now
  post({ type: 'alive' })
}

/**
 * Ask the main process to run a terminal effect.
 * @param call - the effect.
 * @returns its answer.
 */
function callMain(call: MainCall): Promise<string | null> {
  const id = nextId
  nextId += 1
  return new Promise((resolve, reject) => {
    replies.set(id, { resolve, reject })
    post({ type: 'call', id, call })
  })
}

let lastProgress = 0
let lastStage = ''
let lastPhase = ''

const effects = nodeMoveEffects({
  userData: request.userData,
  defaultHome: request.defaultHome,
  platform: request.platform,
  locale: request.locale,
  syncTerminal: async target => (await callMain({ effect: 'syncTerminal', target })) ?? undefined,
  restoreTerminal: async (snapshot) => { await callMain({ effect: 'restoreTerminal', snapshot }) },
  activity: alive,
})

/**
 * Take the step asked for before the move, if any.
 * @param moveEffects - the effects, whose directory operations report activity.
 * @returns what it came to, or `undefined` without a step.
 */
function prepare(moveEffects: MoveEffects): ResolveOutcome | 'recorded' | undefined {
  const before = request.before
  if (before === undefined) return undefined
  switch (before.kind) {
    case 'resolve':
      return resolveBlocked(request.dir, before.choice, before.seen, moveEffects.fs)
    case 'health-failed':
      recordHealth(request.dir, false, before.detail, moveEffects.fs)
      return 'recorded'
    default:
      return before satisfies never
  }
}

Promise.resolve().then(() => {
  const prepared = prepare(effects)
  if (prepared !== undefined) post({ type: 'prepared', prepared: { result: prepared, journal: readJournal(request.dir) } })
  return advanceMove(request.dir, effects, {
    pid: request.pid,
    cancel: cancel.signal,
    onProgress: (progress) => {
      const now = Date.now()
      const changed = progress.stage !== lastStage || progress.phase !== lastPhase || progress.done === progress.total
      if (!changed && now - lastProgress < PROGRESS_INTERVAL_MS) return
      lastProgress = now
      lastStage = progress.stage
      lastPhase = progress.phase
      post({ type: 'progress', progress })
    },
  })
}).then(
  (outcome) => {
    post({ type: 'done', outcome })
    port.close()
  },
  (error: unknown) => {
    const failure = error instanceof Error ? error : new Error(String(error))
    post({ type: 'failed', name: failure.name, message: failure.message })
    port.close()
  },
)
