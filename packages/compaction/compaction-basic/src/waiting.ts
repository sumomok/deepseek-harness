/**
 * Manual compaction requests that wait for a running turn: at most one per
 * Session, each settled exactly once by whichever of its step boundary, the
 * turn's end, its own cancellation, or engine disposal comes first.
 *
 * @module @deepseek-ai/dsh-compaction-basic/waiting
 */

import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'

/** One waiting request, removed from its registry before it is served or settled. */
export interface WaitingCompaction {
  readonly agent: Agent
  readonly whileBusy: ManualCompactionWhileBusy
  /** The request's own cancellation, covering the wait and the compaction. */
  readonly signal: AbortSignal
  readonly sourceCommandId: CommandId | undefined
  /** Set once a `turn/end` that did not abort has been appended after the request. */
  turnEnded: boolean
}

interface Entry {
  readonly request: WaitingCompaction
  readonly settle: PromiseWithResolvers<CompactionResult | null>
  readonly detach: () => void
}

/** Session-keyed registry of waiting manual compaction requests. */
export class WaitingCompactions {
  private readonly entries = new Map<Session, Entry>()

  /**
   * Register one waiting request for a running agent.
   * @param agent - the running agent the request addresses.
   * @param whileBusy - the requested timing.
   * @param signal - the request's cancellation; aborting it while waiting rejects with its reason.
   * @param sourceCommandId - initiating command identity.
   * @returns the request's eventual outcome.
   * @throws {@link ManualCompactionError} `busy` when the Session already has a waiting request.
   */
  add(
    agent: Agent,
    whileBusy: ManualCompactionWhileBusy,
    signal: AbortSignal,
    sourceCommandId: CommandId | undefined,
  ): Promise<CompactionResult | null> {
    if (this.entries.has(agent.session)) {
      throw new ManualCompactionError('busy', 'manual compaction: another request is already waiting for this turn')
    }
    const request: WaitingCompaction = { agent, whileBusy, signal, sourceCommandId, turnEnded: false }
    const settle = Promise.withResolvers<CompactionResult | null>()
    const onAbort = (): void => {
      this.take(agent.session)
      settle.reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    this.entries.set(agent.session, {
      request,
      settle,
      detach: () => { signal.removeEventListener('abort', onAbort) },
    })
    return settle.promise
  }

  /**
   * Read the waiting request of one agent without removing it.
   * @param agent - the agent whose request is read.
   * @returns the request, or undefined when that agent has none.
   */
  peek(agent: Agent): WaitingCompaction | undefined {
    const entry = this.entries.get(agent.session)
    return entry?.request.agent === agent ? entry.request : undefined
  }

  /**
   * Record one appended `turn/end`: an aborted turn cancels its waiting
   * request, any other ending marks it due at the next boundary.
   * @param session - the Session the event was appended to.
   * @param aborted - whether the turn ended aborted.
   */
  turnEnded(session: Session, aborted: boolean): void {
    const entry = this.entries.get(session)
    if (entry === undefined) return
    if (!aborted) {
      entry.request.turnEnded = true
      return
    }
    this.take(session)
    entry.settle.reject(new ManualCompactionError('cancelled', 'manual compaction was cancelled with its turn'))
  }

  /**
   * Remove one agent's request and settle it from the outcome of `serve`.
   * `serve` runs synchronously, so a request served from inside a status
   * transition starts its work before that transition returns.
   * @param agent - the agent whose request is served.
   * @param serve - the compaction to run for the request.
   * @returns a promise that fulfills once the request is settled and never rejects.
   */
  serve(agent: Agent, serve: (request: WaitingCompaction) => Promise<CompactionResult | null>): Promise<void> {
    const request = this.peek(agent)
    if (request === undefined) return Promise.resolve()
    const entry = this.take(agent.session)
    let operation: Promise<CompactionResult | null>
    try {
      operation = serve(request)
    } catch (error: unknown) {
      entry.settle.reject(error)
      return Promise.resolve()
    }
    return operation.then(entry.settle.resolve, entry.settle.reject)
  }

  /**
   * Reject every waiting request; the engine calls this when it is disposed.
   */
  cancelAll(): void {
    for (const session of [...this.entries.keys()]) {
      this.take(session).settle.reject(
        new ManualCompactionError('cancelled', 'manual compaction was cancelled because the compaction service stopped'),
      )
    }
  }

  /** Remove one Session's entry and its abort listener. */
  private take(session: Session): Entry {
    // oxlint-disable-next-line typescript/no-non-null-assertion -- every caller observed the entry first.
    const entry = this.entries.get(session)!
    this.entries.delete(session)
    entry.detach()
    return entry
  }
}
