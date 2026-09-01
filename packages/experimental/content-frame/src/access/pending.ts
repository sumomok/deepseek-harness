/**
 * The table of `content_read` calls waiting for a browser to read the page.
 *
 * Two phases, because the host cannot address a browser and must tell "no
 * console is open" apart from "the console that answered went quiet": a call
 * first waits to be claimed, and only a claimed call waits for a report. One
 * entry per call id, and the id is the tool execution's own `callId`, which is
 * also what the session log hands the seat through the pending projection.
 *
 * Settlement is single-shot: the entry leaves the table before its waiter is
 * resolved, so a second report, a report for a call that already timed out, and
 * a report for a call this host never ran are the same answer — nothing is
 * waiting.
 *
 * One session's reads stick to one tab. The tab that last claimed a read for a
 * session is preferred for `pinMs` afterwards, and a claim from any other tab
 * is held briefly so the preferred one can take it first. Without that, two
 * consoles open on the same session would answer alternate reads, and the refs
 * one console minted would name nothing in the other.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/pending
 */

import { PREFERRED_TAB_WINDOW_MS, type ClaimAck, type ClaimRequest, type ReadOutcome, type ReportAck, type ReportRequest } from './wire.ts'

/** How long each phase of one read waits, as the deployment configured it. */
export interface ReadTimeouts {
  /** How long a call waits to be claimed before it decides no console is open. */
  claimTimeoutMs: number
  /** How long a claimed call waits for its report. */
  readTimeoutMs: number
  /** How long the tab that answered stays this session's preferred reader. */
  pinMs: number
}

/** How one waiting call ended. */
export type ReadSettlement =
  /** A claiming tab answered. */
  | { kind: 'reported'; outcome: ReadOutcome }
  /** The claim window passed with no browser in it. */
  | { kind: 'unclaimed' }
  /** A tab claimed the read and never reported. */
  | { kind: 'unanswered' }
  /** The execution was cancelled while it waited. */
  | { kind: 'aborted' }

/**
 * How many recently settled call ids the table remembers so a claim arriving
 * after the answer is told `settled` rather than `unknown`. Past it a late
 * claim reads as `unknown` and the seat's own retry deadline ends it, so the
 * bound costs a few wasted claims and never a wrong answer.
 */
const SETTLED_MEMORY = 64

/** One call waiting for a browser, in whichever phase it is in. */
interface PendingRead {
  /** The tool execution's call id. */
  readonly callId: string
  /** The session whose column is to be read; the unit the preferred tab is pinned per. */
  readonly sessionId: string
  /** This call's configured deadlines. */
  readonly timeouts: ReadTimeouts
  /** The tab that claimed it, once one has. */
  tabId: string | undefined
  /** The current phase's deadline. */
  timer: ReturnType<typeof setTimeout>
  /** A non-preferred tab's claim, waiting out the preferred tab's window. */
  hold: { readonly resolve: (ack: ClaimAck) => void; readonly timer: ReturnType<typeof setTimeout>; readonly tabId: string } | undefined
  /** Ends the wait. */
  readonly resolve: (settlement: ReadSettlement) => void
  /** Drops the execution's abort listener. */
  readonly release: () => void
}

/** Calls whose tool body is blocked on a browser reading the page. */
export class PendingReads {
  /** Calls still waiting, by call id. */
  private readonly waiting = new Map<string, PendingRead>()

  /** Call ids that have settled, newest last, bounded by {@link SETTLED_MEMORY}. */
  private readonly settled = new Set<string>()

  /** The tab each session's last successful claim came from, while its pin lasts. */
  private readonly preferred = new Map<string, { tabId: string; until: number }>()

  /**
   * Register one call and wait for a browser to read the page for it.
   * @param callId - the tool execution's call id, which is also what the seat claims by.
   * @param sessionId - the session whose column is to be read.
   * @param signal - the execution's cancellation.
   * @param timeouts - the deployment's deadlines for both phases.
   * @returns how the wait ended.
   */
  async open(
    callId: string,
    sessionId: string,
    signal: AbortSignal,
    timeouts: ReadTimeouts,
  ): Promise<ReadSettlement> {
    if (signal.aborted) return { kind: 'aborted' }
    return await new Promise<ReadSettlement>((resolve) => {
      const entry: PendingRead = {
        callId,
        sessionId,
        timeouts,
        tabId: undefined,
        timer: setTimeout(() => { this.finish(entry, { kind: 'unclaimed' }) }, timeouts.claimTimeoutMs),
        hold: undefined,
        resolve,
        release: () => { signal.removeEventListener('abort', onAbort) },
      }
      const onAbort = (): void => { this.finish(entry, { kind: 'aborted' }) }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiting.set(callId, entry)
    })
  }

  /**
   * Take one browser seat's bid to answer a pending read.
   * @param request - the posted claim.
   * @returns whether this tab now owns the read, and why not when it does not.
   */
  async claim(request: ClaimRequest): Promise<ClaimAck> {
    const entry = this.waiting.get(request.callId)
    if (entry === undefined) {
      return { claimed: false, reason: this.settled.has(request.callId) ? 'settled' : 'unknown' }
    }
    if (entry.tabId !== undefined) return { claimed: false, reason: 'taken' }
    const preferred = this.preferredTab(entry.sessionId)
    if (preferred === undefined || preferred === request.tabId) {
      // The preferred tab wins over a hold already in flight: the hold exists
      // precisely to give it this chance.
      this.releaseHold(entry, { claimed: false, reason: 'taken' })
      return this.grant(entry, request.tabId)
    }
    if (entry.hold !== undefined) return { claimed: false, reason: 'taken' }
    return await new Promise<ClaimAck>((resolve) => {
      entry.hold = {
        resolve,
        tabId: request.tabId,
        timer: setTimeout(() => {
          entry.hold = undefined
          resolve(this.grant(entry, request.tabId))
        }, PREFERRED_TAB_WINDOW_MS),
      }
    })
  }

  /**
   * Deliver one browser seat's read to the call waiting for it.
   * @param request - the posted report.
   * @returns whether a waiting call took it.
   */
  report(request: ReportRequest): ReportAck {
    const entry = this.waiting.get(request.callId)
    if (entry === undefined || entry.tabId !== request.tabId) return { accepted: false }
    this.finish(entry, { kind: 'reported', outcome: request.outcome })
    return { accepted: true }
  }

  /**
   * The tab a session's reads currently prefer.
   * @param sessionId - the session being read.
   * @returns the pinned tab, or undefined when none is pinned or its pin has run out.
   */
  private preferredTab(sessionId: string): string | undefined {
    const pinned = this.preferred.get(sessionId)
    if (pinned === undefined) return undefined
    if (pinned.until > Date.now()) return pinned.tabId
    this.preferred.delete(sessionId)
    return undefined
  }

  /**
   * Hand one tab the read and start the report deadline.
   * @param entry - the waiting call.
   * @param tabId - the tab that won it.
   * @returns the winning acknowledgement.
   */
  private grant(entry: PendingRead, tabId: string): ClaimAck {
    entry.tabId = tabId
    this.preferred.set(entry.sessionId, { tabId, until: Date.now() + entry.timeouts.pinMs })
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { this.finish(entry, { kind: 'unanswered' }) }, entry.timeouts.readTimeoutMs)
    return { claimed: true }
  }

  /**
   * Answer a held claim and drop it.
   * @param entry - the waiting call.
   * @param ack - what the held claim is told.
   */
  private releaseHold(entry: PendingRead, ack: ClaimAck): void {
    const hold = entry.hold
    if (hold === undefined) return
    entry.hold = undefined
    clearTimeout(hold.timer)
    hold.resolve(ack)
  }

  /**
   * The single settlement point: remove the entry, then end everything waiting on it.
   * @param entry - the call being settled.
   * @param settlement - how it ended.
   */
  private finish(entry: PendingRead, settlement: ReadSettlement): void {
    /* v8 ignore next -- one call id has one open wait; no agent loop reuses a live one. */
    if (this.waiting.get(entry.callId) !== entry) return
    this.waiting.delete(entry.callId)
    this.remember(entry.callId)
    clearTimeout(entry.timer)
    entry.release()
    this.releaseHold(entry, { claimed: false, reason: 'settled' })
    entry.resolve(settlement)
  }

  /**
   * Record one settled call id, dropping the oldest past the bound.
   * @param callId - the id that just settled.
   */
  private remember(callId: string): void {
    this.settled.add(callId)
    if (this.settled.size <= SETTLED_MEMORY) return
    for (const oldest of this.settled) {
      this.settled.delete(oldest)
      break
    }
  }
}
