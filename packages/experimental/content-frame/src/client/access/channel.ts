/**
 * The browser half of the shared call channel: how one seat wins a call and
 * answers it over the two routes every domain posts through.
 *
 * A host cannot address a browser, so the call comes the other way: the session
 * publishes its open calls in a projection, a seat showing that session claims
 * one over {@link CONTENT_CLAIM_ROUTE}, and posts the answer back over the
 * route its domain settles on. None of that depends on what the call is about,
 * so it lives here once and each domain joins with a {@link ChannelDomain} of
 * its own: a page read, a set of steps run on a page, and a call that acts
 * inside a component entry all bid the same way.
 *
 * Visibility orders the bidding rather than gating it. A tab the user is not
 * looking at holds the same mounted seats and the same live documents, so it
 * bids too, after {@link HIDDEN_CLAIM_GRACE_MS} — long enough for a tab that is
 * in front to have bid first, short enough that a console nobody is looking at
 * still answers rather than leaving the call to the host's claim timeout.
 *
 * One call is answered at most once from one seat: a call the seat has taken up
 * is remembered until it leaves the pending list, so no amount of re-rendering
 * turns one call into two claims. A claim the host does not know yet is not a
 * failure — it is bid again, at a widening interval, for as long as the call is
 * on the list — and neither is a report that never lands, which is posted once
 * more.
 *
 * A second domain in another package joins through the `contentTabChannel`
 * service this module's own row provides, and imports nothing from here but
 * types: a client bundle may not carry another plugin's values, and the tab
 * identity, the bid loop and the report route are exactly what a domain should
 * not have to own.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/channel
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CLAIM_RETRY_MS, CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, HIDDEN_CLAIM_GRACE_MS, MAX_BID_MS, MAX_CLAIM_BACKOFF,
  ROUTE_REFUSAL_STATUSES, type ChannelOutcome, type ClaimAck, type ReportAck,
} from '../../access/wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * The tab-side call channel. It is a service of the browser half alone, and
     * its name is this half's rather than the host's: the two faces are one
     * program when this package is typechecked, and one context key cannot be
     * two different services.
     */
    contentTabChannel: ContentChannel
  }
}

/** One call a domain's seat can answer now. */
export interface ChannelCall {
  /** The call to claim and report against. */
  readonly callId: string
  /** The session whose column the call is against. */
  readonly sessionId: string
}

/** What one domain asks the channel to answer, as its own seat sees it now. */
export interface ChannelDemand<Call extends ChannelCall> {
  /** The calls this domain can answer now, in list order. */
  readonly calls: readonly Call[]
  /**
   * Every call id open on any session the tab holds, served or not. It is what
   * the memory of the calls this seat has taken up is pruned against, so a call
   * whose session left the seat while it was being answered is not forgotten
   * and taken up a second time.
   */
  readonly openCalls: readonly string[]
}

/**
 * One domain's answer to one claimed call.
 *
 * Two forms, because what a domain knows differs. A read that weighs its own
 * document answers with the serialized body it decided to post — the bound it
 * had to meet is its deployment's, and the sentence about a document past it is
 * the read's own. A domain with nothing to weigh answers with the outcome
 * alone, and the channel composes the document around it, which is the one
 * place that knows the call id and the tab posting.
 */
export type ChannelAnswer<Outcome> =
  | {
    /** Discriminant: the domain serialized its own document. */
    readonly kind: 'body'
    /** The route the body settles on; the channel's report route when absent. */
    readonly route?: string
    /** The serialized document to post. */
    readonly body: string
  }
  | {
    /** Discriminant: the channel composes the document. */
    readonly kind: 'outcome'
    /** The route the outcome settles on; the channel's report route when absent. */
    readonly route?: string
    /** What the call ended as, in the shared channel's own vocabulary. */
    readonly outcome: Outcome
  }

/**
 * One domain of the channel: a set of tools, and how their calls are answered.
 *
 * The outcome type is the domain's own declaration of what it posts, and the
 * channel's own union is what every domain in this deployment actually posts.
 */
export interface ChannelDomain<Call extends ChannelCall, Outcome = ChannelOutcome> {
  /** How this domain names itself in diagnostics. */
  readonly name: string
  /** Whether this page can answer this domain's calls at all right now. */
  ready(): boolean
  /**
   * Run one claimed call and compose the answer to it.
   * @param call - the call this seat won.
   * @param claimed - the host's acknowledgement, after the claim round trip.
   * @returns either a serialized body or an outcome, and where it settles.
   */
  answer(call: Call, claimed: ClaimAck): Promise<ChannelAnswer<Outcome>>
}

/** One domain's place in the channel: what its seat offers, and when it leaves. */
export interface ChannelSeat<Call extends ChannelCall> {
  /**
   * Tell the channel what this domain can answer now. Called on every render of
   * the seat that owns the calls; the demand replaces the one before it.
   * @param demand - the calls the domain can answer, and every call id still open.
   */
  offer(demand: ChannelDemand<Call>): void
  /** Stop answering: the seat that offered the calls is gone. */
  park(): void
}

/** What one post to a route ended as, for a caller deciding whether to try again. */
type Posted<T> =
  | {
    /** Discriminant: the route answered. */
    kind: 'answered'
    /** The answer, as the route composed it. */
    value: T
  }
  | {
    /** Discriminant: the route refused this document, and would refuse it again. */
    kind: 'refused'
  }
  | {
    /** Discriminant: the post reached no route that could answer it. */
    kind: 'undelivered'
  }

/**
 * Post one document to a channel route.
 *
 * A refusal and a post that never landed are different endings, and only the
 * statuses in {@link ROUTE_REFUSAL_STATUSES} are the first: the route answers
 * this exact document with one of those however many times it is sent, so there
 * is nothing to gain by sending it again. Every other ending, the rest of the
 * 4xx range included, says nothing about the document and is worth one more
 * try, and treating one as final would end a call the next post would have
 * completed. That list's documentation names what answers the rest.
 *
 * The address is resolved here rather than written into the route constants,
 * because the two halves need different ones: the node half registers these
 * routes at the server root, and a deployment publishing the console under a
 * path prefix has a reverse proxy strip that prefix before the request arrives.
 * The browser is therefore the half that has to put it back, which it does by
 * posting the document-relative form of the route: the served index's
 * `<base href="./">` resolves it under whatever prefix the page was loaded
 * from.
 * @param route - the route to post to, as the node half registers it.
 * @param body - the document, already serialized.
 * @returns what the post ended as.
 */
async function post<T>(route: string, body: string): Promise<Posted<T>> {
  try {
    const response = await fetch(new URL(route.slice(1), document.baseURI), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
    if (response.ok) return { kind: 'answered', value: await response.json() as T }
    return ROUTE_REFUSAL_STATUSES.includes(response.status) ? { kind: 'refused' } : { kind: 'undelivered' }
  } catch (_hostUnreachable) {
    return { kind: 'undelivered' }
  }
}

/** Wait one interval before re-claiming. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Post one answer back, trying a second time when the first post never lands.
 *
 * A call that was claimed and then answered nowhere is the worst ending
 * available: it holds its whole report deadline and the model is told the
 * console went quiet. One retry covers a dropped request; past that the host's
 * own deadline is the right place for it to end. A report the route refused is
 * not that ending and is not sent again — the second post would carry the same
 * document to the same check.
 * @param route - the route this call settles on, as the node half registers it.
 * @param body - the answer, as the domain serialized it.
 */
async function reportRead(route: string, body: string): Promise<void> {
  if ((await post<ReportAck>(route, body)).kind !== 'undelivered') return
  await delay(CLAIM_RETRY_MS)
  await post<ReportAck>(route, body)
}

/**
 * The channel one page load's seats answer calls through.
 *
 * The tab id is minted here rather than per seat, because it is the tab the
 * host pins a session to: two seats of one domain in one page are the same
 * reader to the host, and a second id would make them bid against each other.
 * A row that provides one registers it as `ctx.contentTabChannel`, which is how
 * a domain in another package reaches it without importing this module's values.
 */
export class ContentChannel {
  /** This page load's identity, as the host's claim and report routes name it. */
  readonly tabId = randomUUID()

  /**
   * Join one domain's seat to the channel.
   * @param domain - the domain: which calls it answers, and how.
   * @returns the seat's offering point, and the parking call that ends it.
   */
  join<Call extends ChannelCall, Outcome = ChannelOutcome>(
    domain: ChannelDomain<Call, Outcome>,
  ): ChannelSeat<Call> {
    const started = new Set<string>()
    const tabId = this.tabId
    let held: ChannelDemand<Call> = { calls: [], openCalls: [] }

    /**
     * Whether the call is still one this seat holds.
     *
     * It is what ends a bid: the result reached the log while the seat waited —
     * every ending puts one there, the host's own claim timeout included — or
     * the column this call was read through left the seat, or the seat itself
     * parked. A clock cannot stand in for that: a call that asks the user
     * something registers its wait only after the person answers, and a seat
     * that gave up after the host's claim window would have stopped bidding
     * seconds before that, leaving the model told that no console is open with
     * the console in front of the user the whole time.
     * @param callId - the call being bid for.
     * @returns whether this seat still holds it.
     */
    const holds = (callId: string): boolean => held.calls.some(call => call.callId === callId)

    /**
     * Win one call, bidding again for as long as it is still waiting for somebody.
     *
     * Two answers are worth another try. `unknown` is expected on a first claim:
     * the log records the call before the tool body registers the wait. An
     * undelivered post is the other, and one dropped request would otherwise
     * cost the whole call. A refused claim ends the bidding, because the route
     * refused the bid itself and would refuse each one after it, and so does any
     * other answer — a call another tab took, or one that has already settled.
     * @param callId - the call to claim.
     * @returns the acknowledgement this tab owns the call with, or undefined when it does not.
     */
    const claim = async (callId: string): Promise<ClaimAck | undefined> => {
      let waitMs = CLAIM_RETRY_MS
      const until = Date.now() + MAX_BID_MS
      for (;;) {
        const posted = await post<ClaimAck>(CONTENT_CLAIM_ROUTE, JSON.stringify({ callId, tabId }))
        if (posted.kind === 'refused') return undefined
        if (posted.kind === 'answered') {
          if (posted.value.claimed) return posted.value
          if (posted.value.reason !== 'unknown') return undefined
        }
        await delay(waitMs)
        waitMs = Math.min(waitMs * 2, CLAIM_RETRY_MS * MAX_CLAIM_BACKOFF)
        if (!holds(callId)) return undefined
        if (Date.now() >= until) return undefined
      }
    }

    /**
     * Win one call and post what answering it produced.
     * @param call - the call this seat offered.
     */
    const answer = async (call: Call): Promise<void> => {
      // A tab the user is looking at bids first. Both tabs hold the same seats
      // and either can answer, so this orders them rather than silencing one: a
      // window another window covers, a locked screen and a tab in the
      // background all report `hidden`, and none of the three means the console
      // is not there.
      if (document.visibilityState !== 'visible') await delay(HIDDEN_CLAIM_GRACE_MS)
      const claimed = await claim(call.callId)
      if (claimed === undefined) {
        // Giving up is not answering. Every ending but the call leaving the list
        // leaves a call the host is still waiting for, so the seat forgets it
        // and can take it up again.
        started.delete(call.callId)
        return
      }
      const answer = await domain.answer(call, claimed)
      const route = answer.route ?? CONTENT_REPORT_ROUTE
      // Composed here for a domain with nothing to weigh: the call id and the
      // tab posting are this channel's, and a domain that repeated them would
      // be a second place they could drift.
      const body = answer.kind === 'body'
        ? answer.body
        : JSON.stringify({ callId: call.callId, tabId, outcome: answer.outcome })
      await reportRead(route, body)
    }

    return {
      offer: (demand: ChannelDemand<Call>): void => {
        held = demand
        // A call that has left the list has settled and cannot come back, so the
        // memory of having taken it up is dropped with it — a tab left open for
        // a long session would otherwise accumulate one id per call it ever saw.
        // This runs before the guard below: a seat that cannot answer still has
        // to forget, or a call it gave up on stays skipped on the frame that
        // carries it again. The list it is pruned against is every session's,
        // not the answerable ones': a call being answered when its session left
        // this seat is still that answer's, and forgetting it here would spawn a
        // second one.
        const open = new Set(demand.openCalls)
        for (const callId of started) {
          if (!open.has(callId)) started.delete(callId)
        }
        if (!domain.ready()) return
        for (const call of demand.calls) {
          if (started.has(call.callId)) continue
          started.add(call.callId)
          void answer(call)
        }
      },
      park: (): void => { held = { calls: [], openCalls: [] } },
    }
  }
}
