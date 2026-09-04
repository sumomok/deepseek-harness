/**
 * The table of page-channel calls waiting for a browser: a `content_read`
 * reading the page, or a `content_act` running steps on it.
 *
 * Two phases, because the host cannot address a browser and must tell "no
 * console is open" apart from "the console that answered went quiet": a call
 * first waits to be claimed, and only a claimed call waits for a report. One
 * entry per call id, and the id is the tool execution's own `callId`, which is
 * also what the session log hands the seat through the pending projection.
 *
 * Both tools share one table because they share one claim. Which tool a call
 * belongs to is not this table's business — it hands the waiter whatever was
 * posted for it, and the tool that opened the wait is what decides whether that
 * document answers the call it asked.
 *
 * Settlement is single-shot: the entry leaves the table before its waiter is
 * resolved, so a second report, a report for a call that already timed out, and
 * a report for a call this host never ran are the same answer — nothing is
 * waiting.
 *
 * One session's calls stick to one tab. The tab that last claimed a call for a
 * session is preferred for `pinMs` afterwards, and a claim from any other tab
 * is held briefly so the preferred one can take it first. Without that, two
 * consoles open on the same session would answer alternate calls, and the refs
 * one console minted would name nothing in the other — and a step meant for the
 * page in front of the user would run in a window nobody is looking at.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/pending
 */

import {
  PREFERRED_TAB_WINDOW_MS, type ChannelOutcome, type ChannelReportRequest, type ClaimAck, type ClaimRequest,
  type ReadPage, type ReportAck,
} from './wire.ts'

/** How long each phase of one call waits, as the deployment configured it. */
export interface CallTimeouts {
  /** How long a call waits to be claimed before it decides no console is open. */
  claimTimeoutMs: number
  /** How long a claimed call waits for its report; each tool's own deadline. */
  answerTimeoutMs: number
  /** How long the tab that answered stays this session's preferred reader. */
  pinMs: number
}

/** How one waiting call ended. */
export type CallSettlement =
  /** A claiming tab answered. */
  | { kind: 'reported'; outcome: ChannelOutcome }
  /** The claim window passed with no browser in it. */
  | { kind: 'unclaimed' }
  /** A tab claimed the call and never reported. */
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

/**
 * How many sessions the table keeps a preferred tab for. A session that was
 * read once and never again would otherwise hold its row for the life of the
 * process. Past the bound the oldest pin is dropped and that session's next
 * read goes to whichever tab bids first, which costs one console switch and
 * never a wrong answer.
 */
const PREFERRED_MEMORY = 64

/** The part of `Map` and `Set` a bounded memory is kept through. */
interface BoundedMemory {
  /** How many keys it holds now. */
  readonly size: number
  /** Its keys, oldest insertion first. */
  keys(): Iterable<string>
  /** Drops one key. */
  delete(key: string): boolean
}

/**
 * Drop the oldest key of a memory that has grown past its bound.
 * @param memory - the insertion-ordered memory being bounded.
 * @param limit - how many keys it keeps.
 */
function bound(memory: BoundedMemory, limit: number): void {
  if (memory.size <= limit) return
  for (const oldest of memory.keys()) {
    memory.delete(oldest)
    break
  }
}

/** One call waiting for a browser, in whichever phase it is in. */
interface PendingCall {
  /** The tool execution's call id. */
  readonly callId: string
  /** The session whose column the call is against; the unit the preferred tab is pinned per. */
  readonly sessionId: string
  /** This call's configured deadlines. */
  readonly timeouts: CallTimeouts
  /** The entry the column had in front when the wait opened, for a call that will act. */
  readonly page: ReadPage | undefined
  /** The tab that claimed it, once one has. */
  tabId: string | undefined
  /** Whether one post has taken this call's settlement; see {@link PendingCalls.reserveReport}. */
  reserved: boolean
  /** The current phase's deadline. */
  timer: ReturnType<typeof setTimeout>
  /** A non-preferred tab's claim, waiting out the preferred tab's window. */
  hold: { readonly resolve: (ack: ClaimAck) => void; readonly timer: ReturnType<typeof setTimeout>; readonly tabId: string } | undefined
  /** Ends the wait. */
  readonly resolve: (settlement: CallSettlement) => void
  /** Drops the execution's abort listener. */
  readonly release: () => void
}

/** Calls whose tool body is blocked on a browser. */
export class PendingCalls {
  /** Calls still waiting, by call id. */
  private readonly waiting = new Map<string, PendingCall>()

  /** Call ids that have settled, newest last, bounded by {@link SETTLED_MEMORY}. */
  private readonly settled = new Set<string>()

  /**
   * The tab each session's last successful claim came from, while its pin
   * lasts, newest last and bounded by {@link PREFERRED_MEMORY}.
   */
  private readonly preferred = new Map<string, { tabId: string; until: number }>()

  /**
   * Register one call and wait for a browser to answer it.
   * @param callId - the tool execution's call id, which is also what the seat claims by.
   * @param sessionId - the session whose column the call is against.
   * @param signal - the execution's cancellation.
   * @param timeouts - the deployment's deadlines for both phases.
   * @param page - the entry the column has in front now, handed to the claiming
   * seat so a call that will act can tell whether the column moved under it.
   * The wait opens once the call has been approved, so this is the entry the
   * user was looking at when they answered.
   * @returns how the wait ended.
   * @throws {Error} when a call of that id is already waiting.
   */
  async open(
    callId: string,
    sessionId: string,
    signal: AbortSignal,
    timeouts: CallTimeouts,
    page?: ReadPage,
  ): Promise<CallSettlement> {
    // One call id, one open wait: a second registration would replace the first
    // entry and leave its execution blocked forever, since every path that
    // could wake it settles against the entry the table now holds.
    if (this.waiting.has(callId)) throw new Error(`content-frame: call ${callId} is already waiting`)
    if (signal.aborted) return { kind: 'aborted' }
    return await new Promise<CallSettlement>((resolve) => {
      const entry: PendingCall = {
        callId,
        sessionId,
        timeouts,
        page,
        tabId: undefined,
        reserved: false,
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
   * Take one browser seat's bid to answer a pending call.
   * @param request - the posted claim.
   * @returns whether this tab now owns the call, and why not when it does not.
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
   * Deliver one browser seat's answer to the call waiting for it.
   * @param request - the posted report.
   * @returns whether a waiting call took it.
   */
  report(request: ChannelReportRequest): ReportAck {
    const entry = this.claimant(request.callId, request.tabId)
    if (entry === undefined) return { accepted: false }
    this.finish(entry, { kind: 'reported', outcome: request.outcome })
    return { accepted: true }
  }

  /**
   * Take the one settlement a waiting call has, for a report that must do
   * durable work before it can be delivered.
   *
   * It exists for the one route that writes before it reports: a picture is
   * committed to an attachment store that collects nothing, so a post naming a
   * call nobody is waiting on has to be recognised before the bytes are
   * committed rather than after — and so does a second post for a call another
   * one is already storing for, since only one of them can settle it and the
   * store takes none of them back. The reservation is read through the same
   * lookup {@link report} accepts by, so the two cannot disagree, and it lives
   * on the entry: {@link finish} dropping the entry is what releases it, so a
   * call that ended reported, unanswered, unclaimed or aborted holds none.
   *
   * A reservation whose holder never reaches {@link report} costs its call the
   * rest of its own report deadline and nothing else — the entry's timer still
   * ends it — while every later post for that call is refused.
   * @param callId - the call the report names.
   * @param tabId - the tab posting it.
   * @returns whether this post now owns that call's settlement, which is true
   * for at most one post per waiting call.
   */
  reserveReport(callId: string, tabId: string): boolean {
    const entry = this.claimant(callId, tabId)
    if (entry === undefined || entry.reserved) return false
    entry.reserved = true
    return true
  }

  /**
   * The waiting call one tab may answer, which is the single acceptance
   * {@link report} and {@link reserveReport} both read.
   * @param callId - the call the report names.
   * @param tabId - the tab posting it.
   * @returns that entry, or `undefined` when no call of that id is waiting on that tab.
   */
  private claimant(callId: string, tabId: string): PendingCall | undefined {
    const entry = this.waiting.get(callId)
    return entry === undefined || entry.tabId !== tabId ? undefined : entry
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
   * Hand one tab the call and start the report deadline.
   * @param entry - the waiting call.
   * @param tabId - the tab that won it.
   * @returns the winning acknowledgement.
   */
  private grant(entry: PendingCall, tabId: string): ClaimAck {
    entry.tabId = tabId
    // Removed before it is written so the session moves to the newest position
    // of the insertion order, which is what the bound below evicts against.
    this.preferred.delete(entry.sessionId)
    this.preferred.set(entry.sessionId, { tabId, until: Date.now() + entry.timeouts.pinMs })
    bound(this.preferred, PREFERRED_MEMORY)
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => { this.finish(entry, { kind: 'unanswered' }) }, entry.timeouts.answerTimeoutMs)
    return { claimed: true, ...entry.page === undefined ? {} : { page: entry.page } }
  }

  /**
   * Answer a held claim and drop it.
   * @param entry - the waiting call.
   * @param ack - what the held claim is told.
   */
  private releaseHold(entry: PendingCall, ack: ClaimAck): void {
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
  private finish(entry: PendingCall, settlement: CallSettlement): void {
    /* v8 ignore next -- a second settlement of one entry: each path that reaches here drops the others first. */
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
    bound(this.settled, SETTLED_MEMORY)
  }
}
