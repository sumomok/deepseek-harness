/**
 * `ctx.contentChannel`: the one call channel between this host and whichever
 * browser tab is showing a session's content column.
 *
 * A host cannot address a browser, so every tool that reaches into what the
 * user is looking at goes the same way: the call announces itself in the
 * session's own projection stream, a tab claims it over
 * {@link CONTENT_CLAIM_ROUTE}, and the tab posts back what happened over
 * {@link CONTENT_REPORT_ROUTE}. That apparatus is about reaching the tab rather
 * than about what is being reached, so it lives here once, and a domain that
 * delivers calls through it registers a {@link ChannelMember} instead of
 * claiming a route of its own.
 *
 * Two things stay with a domain. What a call *is* — the tool names it may
 * carry, the arguments it takes, the pending list published to the tab — is the
 * domain's own vocabulary, so each one publishes its list under its own
 * projection key and folds it with {@link foldPending}. And what a report
 * *means* is read by the member that opened the call, so a body posted for one
 * domain is never parsed against another's bounds.
 *
 * The routes exist while a member does: a composition that delivers no calls
 * serves none of them, and a row that serves one does not have to be the row
 * that registered a member.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/channel
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ZodType } from 'zod'
// Type-only: resolves ctx.webServer, which owns the two routes claimed here.
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { admitCaller, type PlaceCaller } from './members.ts'
import { answerJson, readJsonBody, rejectMethod, rejectUntrustedPost, takeJsonBody } from './http.ts'
import { PendingCalls, REPORT_REFUSED, UNKNOWN_CLAIM, type CallTable, type ReportSink } from './pending.ts'
import {
  CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, parseClaimRequest, type ChannelReportRequest, type ClaimAck,
} from './wire.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    contentChannel: ContentChannel
  }
}

/**
 * Bytes a claim can possibly need: one call id, one tab id, and the JSON around
 * them. A protocol bound, not a deployment choice.
 */
const MAX_CLAIM_BYTES = 1024

/** What the claim route calls itself in its own refusals. */
const CLAIM_ROUTE_NAME = 'the read claim route'

/** What the report route calls itself in its own refusals. */
const REPORT_ROUTE_NAME = 'the read report route'

/** The claim route's two sentences for a body it cannot use. */
const CLAIM_REFUSALS = {
  oversize: `content-frame: ${CLAIM_ROUTE_NAME} refuses a body past ${MAX_CLAIM_BYTES} bytes`,
  shape: 'content-frame: expected a JSON body with callId and tabId',
} as const

/**
 * One domain's part of the channel: how it names itself, how wide its reports
 * are, and how one of them is read.
 *
 * A member is registered by the row that owns the domain's tools and lives as
 * long as that row does. Nothing of the domain's own vocabulary belongs here —
 * a member is the channel's whole view of it.
 */
export interface ChannelMember {
  /** How this domain names itself in diagnostics. */
  readonly name: string
  /**
   * The largest report body this domain posts, in UTF-8 bytes. The report route
   * holds every domain's bodies, so its bound is the widest one; each member
   * still checks its own document's shape and lengths in
   * {@link ChannelMember.parseReport}.
   */
  readonly reportBytes: number
  /**
   * Read one posted report of this domain.
   * @param value - the decoded request body, however malformed.
   * @returns the report, or `undefined` when the body is not one of this domain's.
   */
  parseReport(value: unknown): ChannelReportRequest | undefined
}

/**
 * Fold one open-call list over one committed event: the call an event opened is
 * appended, and the one it settled is dropped.
 *
 * The two log shapes a call arrives in are the domain's to read — a top-level
 * `tool/call` carries raw JSON arguments and a PTC dispatch carries them
 * decoded — so both readers are injected, and this fold is only the list
 * arithmetic every pending list shares.
 * @param state - the open calls, oldest first.
 * @param event - the committed session event.
 * @param opened - the call one event opened, or `undefined` when it opened none.
 * @param settled - the call id one event settled, or `undefined` when it settled none.
 * @returns the next state, the same array when nothing moved.
 */
export function foldPending<Call extends { callId: string }>(
  state: Call[],
  event: SessionEvent,
  opened: (event: SessionEvent) => Call | undefined,
  settled: (event: SessionEvent) => string | undefined,
): Call[] {
  const call = opened(event)
  if (call !== undefined) return [...state, call]
  const settledId = settled(event)
  if (settledId === undefined) return state
  const at = state.findIndex(candidate => candidate.callId === settledId)
  return at === -1 ? state : [...state.slice(0, at), ...state.slice(at + 1)]
}

/**
 * Where a projection unit records a value it folded and then refused.
 *
 * The registry parses every view before it leaves, and a failure there reaches
 * the model as the validator's raw issue list — an argument to change, about a
 * call whose arguments are fine. A unit checks its own view first so the same
 * defect becomes one sentence the model can act on and one log line carrying
 * the issues, on either domain's list.
 */
export interface ProjectionLogger {
  /**
   * Record one line.
   * @param message - the line.
   */
  readonly warn: (message: string) => void
}

/**
 * Check one view against the schema that guards it, answering with it.
 * @param value - the view a unit is about to publish.
 * @param schema - the wire schema of that view.
 * @param logger - where a refused value's issues are recorded.
 * @param subject - how the unit names itself in the log line.
 * @param refusal - the sentence the model is given instead.
 * @returns the value.
 * @throws {Error} when the value is not one this schema takes.
 */
export function checkedPending<View>(
  value: View,
  schema: ZodType<View>,
  logger: ProjectionLogger,
  subject: string,
  refusal: string,
): View {
  const read = schema.safeParse(value)
  if (read.success) return value
  logger.warn(`${subject} refused its own view: ${JSON.stringify(read.error.issues)}`)
  throw new Error(refusal)
}

/** How this service is installed: where its routes place the requests they answer. */
export interface ChannelConfig {
  /** The admission every posted claim and report goes through before its body is read. */
  readonly place: PlaceCaller
}

/**
 * The shared channel: one waiting table and one pair of routes, for every
 * domain that delivers calls to a browser tab.
 */
export class ContentChannel extends Service implements ReportSink {
  /** The admission every posted claim and report goes through. */
  private readonly place: PlaceCaller

  /** Calls whose tool body is blocked on a browser, whichever domain opened them. */
  private readonly calls = new PendingCalls()

  /** Every registered member by name, in registration order. */
  private readonly members = new Map<string, ChannelMember>()

  /** Whether the two routes are claimed already, which the first member decides. */
  private started = false

  /**
   * Install the channel as `ctx.contentChannel`.
   * @param ctx - the context that owns the service.
   * @param config - where its routes place the requests they answer.
   */
  constructor(ctx: Context, config: ChannelConfig) {
    super(ctx, 'contentChannel')
    this.place = config.place
  }

  /**
   * Join one domain to the channel.
   *
   * The domain's tools open their calls through the returned table, which is
   * what tags each waiting call with the member that reads its report. A member
   * stays registered for the life of this service: the rows that register one
   * are the rows that own the domain's tools, and both leave with the same
   * fiber.
   * @param member - the domain's part: its name, its width, and how its reports are read.
   * @returns the table its tools open their calls in.
   */
  register(member: ChannelMember): CallTable {
    this.members.set(member.name, member)
    this.claimRoutes()
    return {
      open: (callId, sessionId, signal, timeouts, page) => this.calls.open(
        callId, sessionId, signal, timeouts, page, member.name,
      ),
      sessionOf: callId => this.calls.sessionOf(callId),
    }
  }

  /**
   * The session one call id was opened against.
   * @param callId - the call a claim or a report names.
   * @returns that session, or `undefined` for an id this channel does not know.
   */
  sessionOf(callId: string): SessionId | undefined {
    return this.calls.sessionOf(callId)
  }

  /**
   * Take the one settlement a waiting call has, for a route that writes before
   * it reports.
   * @param callId - the call the report names.
   * @param tabId - the tab posting it.
   * @returns whether this post now owns that call's settlement.
   */
  reserveReport(callId: string, tabId: string): boolean {
    return this.calls.reserveReport(callId, tabId)
  }

  /**
   * Deliver one browser seat's answer to the call waiting for it.
   * @param request - the posted report.
   * @returns whether a waiting call took it.
   */
  report(request: ChannelReportRequest): { accepted: boolean } {
    return this.calls.report(request)
  }

  /**
   * The largest report body any registered domain posts, which is the bound the
   * report route holds every body to.
   * @returns the byte bound.
   */
  private widestReport(): number {
    let widest = 0
    for (const member of this.members.values()) widest = Math.max(widest, member.reportBytes)
    return widest
  }

  /**
   * Read one posted report with the member that opened the call.
   *
   * The call id is read first, because which domain wrote a body is a fact
   * about the call rather than about the document. A report for a call that has
   * already settled names no member any more, so every registered member is
   * offered the body in turn — which is exactly how a single-domain channel
   * read such a body before the channel was shared.
   * @param value - the decoded request body, however malformed.
   * @returns the report, or `undefined` when no member reads the body.
   */
  private readReport(value: unknown): ChannelReportRequest | undefined {
    const named = parseClaimRequest(value)
    const tag = named === undefined ? undefined : this.calls.memberOf(named.callId)
    const owner = tag === undefined ? undefined : this.members.get(tag)
    if (owner !== undefined) return owner.parseReport(value)
    for (const member of this.members.values()) {
      const report = member.parseReport(value)
      if (report !== undefined) return report
    }
    return undefined
  }

  /**
   * Claim the two routes, once, on the first member's behalf.
   *
   * Both are effects on this service's own context, so they go with the row
   * that provides the channel rather than with whichever domain registered
   * first: the paths stay claimed while any member is, which is what lets a
   * domain other than the first one still be answered.
   */
  private claimRoutes(): void {
    if (this.started) return
    this.started = true
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: CONTENT_CLAIM_ROUTE,
      handler: async (req, res) => { await this.answerClaim(req, res) },
    }), 'content-channel: the call claim route')
    this.ctx.effect(() => this.ctx.webServer.register({
      kind: 'exact',
      path: CONTENT_REPORT_ROUTE,
      handler: async (req, res) => { await this.answerReport(req, res) },
    }), 'content-channel: the call report route')
  }

  /**
   * Answer one claim: which tab, if any, now owns the call.
   * @param req - the request.
   * @param res - the response.
   */
  private async answerClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      rejectMethod(req, res, 'POST', MAX_CLAIM_BYTES)
      return
    }
    if (rejectUntrustedPost(req, res, CLAIM_ROUTE_NAME, MAX_CLAIM_BYTES)) return
    const caller = admitCaller(this.place, req, res, CLAIM_ROUTE_NAME, MAX_CLAIM_BYTES)
    if (caller === undefined) return
    const body = takeJsonBody(res, await readJsonBody(req, MAX_CLAIM_BYTES), CLAIM_REFUSALS)
    if (body === undefined) return
    const claim = parseClaimRequest(body.value)
    if (claim === undefined) {
      answerJson(res, 400, { error: CLAIM_REFUSALS.shape })
      return
    }
    const ack: ClaimAck = caller.owns(this.calls.sessionOf(claim.callId)) ? await this.calls.claim(claim) : UNKNOWN_CLAIM
    answerJson(res, 200, ack)
  }

  /**
   * Answer one report: whether a waiting call took it.
   * @param req - the request.
   * @param res - the response.
   */
  private async answerReport(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const bound = this.widestReport()
    if (req.method !== 'POST') {
      rejectMethod(req, res, 'POST', bound)
      return
    }
    if (rejectUntrustedPost(req, res, REPORT_ROUTE_NAME, bound)) return
    const caller = admitCaller(this.place, req, res, REPORT_ROUTE_NAME, bound)
    if (caller === undefined) return
    const body = takeJsonBody(res, await readJsonBody(req, bound), {
      oversize: `content-frame: ${REPORT_ROUTE_NAME} refuses a body past ${bound} bytes`,
      shape: 'content-frame: expected a JSON body with callId, tabId, and outcome',
    })
    if (body === undefined) return
    const report = this.readReport(body.value)
    if (report === undefined) {
      answerJson(res, 400, { error: 'content-frame: expected a JSON body with callId, tabId, and outcome' })
      return
    }
    answerJson(res, 200, caller.owns(this.calls.sessionOf(report.callId)) ? this.calls.report(report) : REPORT_REFUSED)
  }
}
