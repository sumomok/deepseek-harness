/**
 * @deepseek-ai/dsh-experimental-content-frame — the shell's content column as
 * a surface the agent AND the user drive. The node half serves a configured
 * directory under a named webserver route, offers the deployment's pages to
 * the model as `content_show`, offers the same catalog to the user's sidebar
 * page-navigation menu through the `show-content-page` command, and projects
 * what each session's column shows; the browser half claims the column and
 * keeps one live frame per session.
 *
 * What the model knows about the column comes from the perception layer in
 * `perception/` and nowhere else: a notice when the user opens a page, a
 * `content:column` context on every request saying what the column holds and
 * where each page's frame has gone, and the `content/navigated` events the
 * browser records as the application inside a frame routes itself.
 *
 * Trust: the route answers on the dsh origin and the iframe carries no
 * `sandbox` attribute, so the document inside it is same-origin with the shell
 * and reaches the dsh HTTP API with the shell's own authority. `root` must
 * name a directory whose contents are trusted exactly as much as the harness
 * itself — see the package README's trust section.
 * @module @deepseek-ai/dsh-experimental-content-frame
 */

import { isAbsolute } from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves ctx.contentSurface for the optional extractor child.
import type {} from '@deepseek-ai/dsh-experimental-content-surface'
// Type-only: resolves ctx.commands for the two optional browser-driven command children.
import type {} from '@deepseek-ai/dsh-commands'
// Type-only: resolves ctx.systemPrompt for the optional content-column context child.
import type {} from '@deepseek-ai/dsh-system-prompt'
// Type-only: resolves ctx.attachments for the optional picture-read child.
import type {} from '@deepseek-ai/dsh-attachment'
// Type-only: resolves ctx.llm, which the picture read asks for the session's route.
import type {} from '@deepseek-ai/dsh-llm'
import type { ContentPage } from './types.ts'
import { indexPages } from './pages.ts'
import { contentProjection } from './projection.ts'
import { frontEntry, pageExtractor } from './surface.ts'
import { contentShowTool } from './tool.ts'
import { contentNavigatedCommand, showContentPageCommand } from './command.ts'
import { CONTENT_APP_ROUTE, CONTENT_SETTINGS_ROUTE, type ContentFrameSettings } from './route.ts'
import { serveContentApp } from './serve.ts'
import {
  answerJson, readJsonBody, rejectMethod, rejectUntrustedPost, takeJsonBody, type BodyRefusals,
} from './access/http.ts'
import { PendingCalls, type CallTimeouts } from './access/pending.ts'
import { contentAccessProjection } from './access/requests-projection.ts'
import { contentReadTool } from './access/read-tool.ts'
import { contentReadAttrsTool, contentReadDomContentTool, contentReadDomTool } from './access/markup-tool.ts'
import { contentReadImageTool } from './access/image-tool.ts'
import { settleImageReport } from './access/image-report.ts'
import { contentActTool } from './access/act-tool.ts'
import { DialogApprovals } from './access/dialog-approvals.ts'
import { registerActApproval } from './access/act-approval.ts'
import type { FrontEntry } from './access/text.ts'
import {
  ACT_RUN_SHARE, CONTENT_CLAIM_ROUTE, CONTENT_IMAGE_ROUTE, CONTENT_REPORT_ROUTE, EXPORT_WAIT_SHARE,
  IMAGE_REPORT_BYTES, MAX_ACT_STEPS, MAX_TEXT_BUDGET_MULTIPLE, MAX_TEXT_BYTES_PER_CHAR, MIN_OUTLINE_CHARS,
  parseChannelReport, parseClaimRequest, parseImageReport, REPORT_ENVELOPE_BYTES, SETTLE_WAIT_SHARE,
} from './access/wire.ts'
import { contentPagesProjection } from './perception/pages-projection.ts'
import { registerColumnContext } from './perception/context.ts'
import type { ColumnContextBounds } from './perception/text.ts'

// The `content/shown` and `content` declarations live in src/types.ts (their
// one home); this re-export projects the type face onto the package root and
// keeps the module edge in the emitted index.d.ts.
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'content-frame'

/** Service required before the route can be claimed. */
export const inject = ['webServer']

/** Plugin config: the hosted application, and the pages the agent may show from it. */
export interface Config {
  /**
   * Absolute path of the directory the content column's pages are served
   * from. Required with no default: which application a deployment hosts is
   * the whole decision this plugin exists to carry, and the trust it grants
   * that directory makes an inferred location the wrong kind of convenience.
   */
  root: string
  /**
   * The pages the agent may put in the column, in the order the tool
   * description offers them. At least one is required — `content_show` exists
   * to choose among these, and an empty list leaves the model a tool it can
   * never call successfully. Each `url` must be a same-origin path.
   */
  pages: ContentPage[]
  /**
   * Page the `content` projection reports while a session has shown nothing
   * yet, and after the agent clears the column. Must name a configured page.
   * Omit to leave that value empty until the agent fills it. The content
   * column itself does not show it: the column is a stream of what a session
   * produced, and a default page is not something any session produced.
   */
  defaultPage?: string
  /**
   * Page the sidebar's page-navigation menu shows automatically the first
   * time a session lands on a blank draft, so a new conversation opens onto
   * a populated column instead of an empty one. Must name a configured page.
   * Omit to leave a blank draft's column empty until the user or agent
   * chooses. Unlike `defaultPage`, this drives an actual `show-content-page`
   * command invocation (read by `@deepseek-ai/dsh-experimental-server-sidebar`,
   * not by this row) rather than a projection default, so it leaves the same
   * durable log record a real click would.
   */
  homePage?: string
  /**
   * How many frames the browser keeps alive at once, counted over (session,
   * page) pairs. A cached frame keeps its live document — scroll position,
   * form state, whatever the page holds — across a switch to another page,
   * another content kind, or another session; the least recently shown one is
   * dropped past this bound, and reloads when it comes back. Raise it for a
   * deployment whose users move between many pages and sessions and whose
   * pages are expensive to reload; lower it to bound the browser's memory.
   */
  cacheSize?: number
  /**
   * How often the browser asks the page in front where it is, in
   * milliseconds. A configured page is a shell around an application that
   * routes itself, and a router changing route through `history.pushState`
   * fires no event a parent document can listen for — polling the frame's own
   * address is what makes that move reach the log at all. Lower it for a
   * deployment whose users move through an application quickly and whose agent
   * must keep up; raise it to spend less on a deployment whose pages are
   * static.
   */
  navigationPollMs?: number
  /**
   * How many of the column's entries the `content:column` prompt context
   * lists, newest first. The context is rebuilt for every request, so this is
   * the standing cost of the agent knowing what is on screen; past it the
   * context says how many older entries it did not list. Raise it for a
   * deployment whose users keep many things open at once and whose agent is
   * asked about the older ones; lower it to spend less per request.
   */
  contextEntries?: number
  /**
   * How many characters of a title, address, or document title one
   * `content:column` line carries before it is cut. Raise it for a deployment
   * whose page titles are long and only distinguishable near the end; lower it
   * to spend less per request.
   */
  contextFieldChars?: number
  /**
   * Lets the agent read the page in the column — through `content_read`,
   * through the three markup reads `content_read_dom`, `content_read_attrs` and
   * `content_read_dom_content`, and, where an attachment store is mounted,
   * through `content_read_image`, which answers with one element's own rendered
   * pixels — and act on it through `content_act`. Absent turns the whole
   * channel off: no tools, no routes, no pending projection, and no reader in
   * the browser — a deployment that only shows pages does not pay for a
   * capability it did not ask for. Present with an empty object takes every
   * default below.
   */
  pageAccess?: PageAccessConfig
}

/** How long each phase of a read waits, and how much of a page one read may carry. */
export interface PageAccessConfig {
  /**
   * How long a read waits for a console to claim it before answering that none
   * is open. It bounds how long the agent stalls when the user has no browser
   * on this session, so it is short; raise it for a deployment whose consoles
   * reconnect slowly.
   */
  claimTimeoutMs: number
  /**
   * How long a claimed read waits for its listing. It bounds the whole walk of
   * a document, including waiting for a page that is still loading, so a heavy
   * application needs more of it than a static one. At least 8, refused at
   * load: a picture read gives the export an eighth of it, and below that floor
   * the share is a fraction of a millisecond — every picture would be refused
   * as one the console did not draw in time, and the refusal would name it.
   */
  readTimeoutMs: number
  /**
   * How long the tab that answered stays the session's preferred reader. Refs
   * are per document, so consecutive reads of one session should reach one tab;
   * lower it for a deployment whose users move between consoles constantly.
   */
  pinMs: number
  /**
   * How long a loaded page must go unchanged before a read walks it. A route
   * change inside an application leaves the document complete while its data
   * is still arriving, and this is how long stillness has to last to count as
   * drawn. Raise it for an application that paints in slow bursts; lower it for
   * one that answers immediately and for an agent that should not wait. It must
   * fit inside the share of `readTimeoutMs` the wait is given, which the row
   * checks at load.
   */
  settleQuietMs: number
  /**
   * The character budget one listing is rendered under. It is the ceiling on
   * what a single read can cost in context: past it the read answers with the
   * page's map, or with a cursor to continue from. Raise it for a deployment
   * whose pages are large and whose model has room for them. At least 1000,
   * because a listing's first row is rendered however long it is and the wire
   * holds a posted listing to four times the budget: below that floor an
   * ordinary table's row is already past the bound, and every read of a page
   * holding one would answer that the block is too wide.
   */
  outlineChars: number
  /**
   * How long a claimed set of steps waits for its report, and the bound on the
   * whole run. The steps themselves — each step's own wait and the page
   * settling after it — get three quarters of it, and a step that would start
   * past that point fails instead, with the rest reported as never run; the
   * quarter left over pays for the closing read of the page and the trip back
   * with it. It is the longest of the deadlines. Raise it for an application
   * whose forms take a while to answer.
   */
  actTimeoutMs: number
  /**
   * Most steps one call may run. It is what one approval request covers, so it
   * is also how much a user is asked to agree to at once; raise it for an
   * agent filling long forms, lower it to keep each request short. At most
   * 100, which is the protocol's own bound.
   */
  maxSteps: number
  /**
   * How long one step waits for the page to go quiet before the next step
   * runs. `settleQuietMs` says how long stillness has to last; this says how
   * long the wait for it may take. Raise it for an application that answers a
   * click slowly; lower it for an agent that should not wait. It must be at
   * least `settleQuietMs`, and `maxSteps` of it must come to less than three
   * quarters of `actTimeoutMs`, both checked at load.
   */
  settleMaxMs: number
}

/** Default frame cache size: the current session plus the two before it. */
const DEFAULT_CACHE_SIZE = 3

/**
 * Poll interval used when a deployment configures none: fast enough that a
 * route change is on the log before the user has finished reading the new
 * page, cheap enough to be one same-origin property read per second.
 */
const DEFAULT_NAVIGATION_POLL_MS = 1000

/**
 * Entries listed in the prompt context when a deployment configures none: a
 * session that has drawn thirty charts needs the recent ones and a true count,
 * not all of them on every request.
 */
const DEFAULT_CONTEXT_ENTRIES = 10

/**
 * Field width in the prompt context when a deployment configures none: long
 * enough for a page title and a route, short enough that ten of them do not
 * dominate the request.
 */
const DEFAULT_CONTEXT_FIELD_CHARS = 120

/**
 * The narrowest field a context line can still name something in: the cut
 * spends one character on the ellipsis, and a page called `Weekly` has to
 * survive it.
 */
const MIN_CONTEXT_FIELD_CHARS = 8

/**
 * The shortest report deadline that leaves a picture's export a whole
 * millisecond, derived from {@link EXPORT_WAIT_SHARE} rather than written down
 * beside it: the export runs under that share of the read's deadline, and
 * under this floor the share is a fraction of a millisecond — no drawing a
 * browser really does meets it, and the refusal names it as the time the
 * console had.
 */
const MIN_READ_TIMEOUT_MS = Math.ceil(1 / EXPORT_WAIT_SHARE)

/** Claim window used when a deployment enables page access and configures none. */
const DEFAULT_CLAIM_TIMEOUT_MS = 3000
/** Report deadline used when a deployment enables page access and configures none. */
const DEFAULT_READ_TIMEOUT_MS = 15000
/** Preferred-tab pin used when a deployment enables page access and configures none. */
const DEFAULT_PIN_MS = 300000
/** Listing budget used when a deployment enables page access and configures none. */
const DEFAULT_OUTLINE_CHARS = 12000

/** Report deadline for a set of steps used when a deployment configures none. */
const DEFAULT_ACT_TIMEOUT_MS = 60000

/**
 * Steps per call used when a deployment configures none: enough for a form and
 * the button that submits it, short enough that the approval request naming
 * every step is still one a user reads.
 */
const DEFAULT_MAX_STEPS = 20

/**
 * Per-step settle ceiling used when a deployment configures none: eight quiet
 * windows, which is long enough for an application to answer a click over a
 * network, and short enough that the shipped {@link DEFAULT_MAX_STEPS} steps
 * of them fit inside the steps' share of {@link DEFAULT_ACT_TIMEOUT_MS} — a
 * page that has not stopped changing for two seconds is one to `wait` on
 * rather than one every step pays for.
 */
const DEFAULT_SETTLE_MAX_MS = 2000

/**
 * Quiet window used when a deployment enables page access and configures none:
 * long enough to sit through the gap between an application's own two paints,
 * short enough that reading a static page costs a quarter second.
 */
const DEFAULT_SETTLE_QUIET_MS = 250

export const Config: z<Config> = z.object({
  root: z.string().required(),
  pages: z.array(z.object({
    id: z.string().required(),
    title: z.string().required(),
    description: z.string().required(),
    url: z.string().required(),
  })).required(),
  defaultPage: z.string(),
  homePage: z.string(),
  cacheSize: z.natural().default(DEFAULT_CACHE_SIZE),
  navigationPollMs: z.natural().default(DEFAULT_NAVIGATION_POLL_MS),
  contextEntries: z.natural().default(DEFAULT_CONTEXT_ENTRIES),
  contextFieldChars: z.natural().default(DEFAULT_CONTEXT_FIELD_CHARS),
  // Cleared default, because schemastery gives every object schema `{}`: left
  // alone it would materialize this block for a deployment that configured
  // none and switch the read channel on by accident. `undefined` is not a
  // value of the block's own type, which is what the cast says.
  pageAccess: z.object({
    claimTimeoutMs: z.natural().default(DEFAULT_CLAIM_TIMEOUT_MS),
    readTimeoutMs: z.natural().default(DEFAULT_READ_TIMEOUT_MS),
    pinMs: z.natural().default(DEFAULT_PIN_MS),
    settleQuietMs: z.natural().default(DEFAULT_SETTLE_QUIET_MS),
    outlineChars: z.natural().default(DEFAULT_OUTLINE_CHARS),
    actTimeoutMs: z.natural().default(DEFAULT_ACT_TIMEOUT_MS),
    maxSteps: z.natural().default(DEFAULT_MAX_STEPS),
    settleMaxMs: z.natural().default(DEFAULT_SETTLE_MAX_MS),
  }).default(undefined as never),
})

/**
 * Resolve and validate the configured root.
 * @param configured - the `root` config value.
 * @returns the directory's real path, symlinks resolved once for every later
 * containment check.
 * @throws {Error} when the path is relative, missing, or not a directory.
 */
async function resolveRoot(configured: string): Promise<string> {
  if (!isAbsolute(configured)) {
    throw new Error(`content-frame: root must be an absolute path, received "${configured}"`)
  }
  const info = await stat(configured).catch(() => undefined)
  if (info === undefined || !info.isDirectory()) {
    throw new Error(`content-frame: root "${configured}" is not an existing directory`)
  }
  return await realpath(configured)
}

/**
 * Reject a page-access bound that would make the read unusable, at load.
 * @param field - the field being checked, named in the diagnostic.
 * @param value - the configured value.
 * @param least - the smallest value that field may hold.
 * @returns the value.
 * @throws {Error} when the value is below `least`.
 */
function requireAtLeast(field: keyof PageAccessConfig, value: number, least: number): number {
  if (value < least) {
    throw new Error(`content-frame: pageAccess.${field} must be at least ${least}, received ${value}`)
  }
  return value
}

/**
 * Reject a page-access bound the protocol will not carry, at load.
 * @param field - the field being checked, named in the diagnostic.
 * @param value - the configured value.
 * @param most - the largest value that field may hold.
 * @returns the value.
 * @throws {Error} when the value is above `most`.
 */
function requireAtMost(field: keyof PageAccessConfig, value: number, most: number): number {
  if (value > most) {
    throw new Error(`content-frame: pageAccess.${field} must be at most ${most}, received ${value}`)
  }
  return value
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

/** What the picture route calls itself in its own refusals. */
const IMAGE_ROUTE_NAME = 'the picture report route'

/**
 * Claim the three read routes, the five reading tools, the acting tool, and the
 * pending projection.
 *
 * Every registration lives inside this one call, so a deployment that
 * configures no `pageAccess` has none of them: the routes 404, the model is
 * offered no tool, no session publishes a pending list, and the browser half
 * reads the absent settings field and installs no reader. The picture read and
 * the route its pixels arrive on are claimed one level further in, where an
 * attachment store is mounted: pixels reach the model as a stored attachment,
 * so a deployment with nowhere to keep them is offered neither.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - the deployment's page-access block.
 * @returns the settings the browser half needs to run a read.
 */
function claimPageAccess(ctx: Context, config: PageAccessConfig): ContentFrameSettings['pageAccess'] {
  // Loud at load: a zero deadline would refuse every read the model can make,
  // with no diagnostic pointing at the row that set it.
  const claimTimeoutMs = requireAtLeast('claimTimeoutMs', config.claimTimeoutMs, 1)
  const pinMs = requireAtLeast('pinMs', config.pinMs, 1)
  const timeouts: CallTimeouts = {
    claimTimeoutMs,
    answerTimeoutMs: requireAtLeast('readTimeoutMs', config.readTimeoutMs, 1),
    pinMs,
  }
  const actTimeouts: CallTimeouts = {
    claimTimeoutMs,
    answerTimeoutMs: requireAtLeast('actTimeoutMs', config.actTimeoutMs, 1),
    pinMs,
  }
  const maxSteps = requireAtMost('maxSteps', requireAtLeast('maxSteps', config.maxSteps, 1), MAX_ACT_STEPS)
  const outlineChars = requireAtLeast('outlineChars', config.outlineChars, MIN_OUTLINE_CHARS)
  // Loud at load and self-contained: a quiet window the settle budget cannot
  // hold would spend the whole budget and report every page as still changing,
  // and both numbers are in this one block.
  const settleQuietMs = requireAtLeast('settleQuietMs', config.settleQuietMs, 1)
  // Loud at load and self-contained for the same reason: a per-step ceiling
  // below the quiet window would end every step's wait before the window could
  // pass.
  const settleMaxMs = requireAtLeast('settleMaxMs', config.settleMaxMs, settleQuietMs)
  // And loud at load for the three of them together: the steps of one call get
  // a share of its deadline, so a deployment whose steps could all settle to
  // the ceiling inside that share is one where a call can spend its whole
  // deadline settling and never reach its last step.
  const runBudgetMs = actTimeouts.answerTimeoutMs * ACT_RUN_SHARE
  if (maxSteps * settleMaxMs >= runBudgetMs) {
    throw new Error(
      `content-frame: pageAccess.maxSteps ${String(maxSteps)} × settleMaxMs ${String(settleMaxMs)}ms `
      + `= ${String(maxSteps * settleMaxMs)}ms must be under ${String(runBudgetMs)}ms, which is `
      + `${String(ACT_RUN_SHARE)} of pageAccess.actTimeoutMs ${String(actTimeouts.answerTimeoutMs)}ms`,
    )
  }
  const settleBudgetMs = timeouts.answerTimeoutMs * SETTLE_WAIT_SHARE
  if (settleQuietMs > settleBudgetMs) {
    throw new Error(
      `content-frame: pageAccess.settleQuietMs must fit in ${String(settleBudgetMs)}ms `
      + `(${String(SETTLE_WAIT_SHARE)} of readTimeoutMs), received ${String(settleQuietMs)}`,
    )
  }
  // Loud at load and self-contained as well: a picture read gives the export a
  // share of this same deadline, and a deadline whose share is a fraction of a
  // millisecond answers every picture with a refusal naming that fraction.
  // Checked here rather than where the picture read is claimed, so a deployment
  // learns it at load rather than the day it mounts an attachment store.
  if (timeouts.answerTimeoutMs * EXPORT_WAIT_SHARE < 1) {
    throw new Error(
      `content-frame: pageAccess.readTimeoutMs must be at least ${String(MIN_READ_TIMEOUT_MS)} for the export's `
      + `${String(EXPORT_WAIT_SHARE)} share to be a whole millisecond, received ${String(timeouts.answerTimeoutMs)}`,
    )
  }
  // The character bound the parser holds a posted listing to: it covers the one
  // block the renderer prints past the budget, and a forged listing cannot
  // carry an arbitrary page through it. A listing past it is one the seat
  // reports on instead of posting.
  const maxTextChars = outlineChars * MAX_TEXT_BUDGET_MULTIPLE
  // The byte bound on the whole body: the seat's own render budget at four
  // UTF-8 bytes per character, plus an envelope allowing the same four bytes
  // for every other field of a report, each at the bound the wire holds it to.
  // In a body the seat sanitized, no UTF-16 unit costs more than four bytes of
  // JSON — two for a short escape, three for the widest character, two per unit
  // for a supplementary one — so a listing rendered inside the budget arrives
  // whole whatever the page is written in; a listing that was not sanitized is
  // refused as a shape by the parser rather than reaching this bound. The seat
  // measures the report it is about to post against this same sum, byte for
  // byte, so this is the check on a body no seat of this package wrote rather
  // than the one a real read is expected to meet. Not the character bound above
  // converted, which would be sixteen bytes per rendered character: past a
  // budget the envelope no longer covers, this bound refuses a listing of
  // multibyte text that the parser's character bound alone would have taken.
  const reportBytes = outlineChars * MAX_TEXT_BYTES_PER_CHAR + REPORT_ENVELOPE_BYTES
  const claimRefusals: BodyRefusals = {
    oversize: `content-frame: ${CLAIM_ROUTE_NAME} refuses a body past ${MAX_CLAIM_BYTES} bytes`,
    shape: 'content-frame: expected a JSON body with callId and tabId',
  }
  const reportRefusals: BodyRefusals = {
    oversize: `content-frame: ${REPORT_ROUTE_NAME} refuses a body past ${reportBytes} bytes`,
    shape: 'content-frame: expected a JSON body with callId, tabId, and outcome',
  }
  // A bound of its own, computed from the protocol's own picture constants
  // rather than from the deployment's character budget: carrying pixels through
  // the report route would have raised the bound on every text read with them.
  const imageRefusals: BodyRefusals = {
    oversize: `content-frame: ${IMAGE_ROUTE_NAME} refuses a body past ${IMAGE_REPORT_BYTES} bytes`,
    shape: 'content-frame: expected a JSON body with callId, tabId, and capture',
  }
  const pending = new PendingCalls()
  const approvals = new DialogApprovals()

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTENT_CLAIM_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(req, res, 'POST', MAX_CLAIM_BYTES)
        return
      }
      if (rejectUntrustedPost(req, res, CLAIM_ROUTE_NAME, MAX_CLAIM_BYTES)) return
      const body = takeJsonBody(res, await readJsonBody(req, MAX_CLAIM_BYTES), claimRefusals)
      if (body === undefined) return
      const claim = parseClaimRequest(body.value)
      if (claim === undefined) {
        answerJson(res, 400, { error: claimRefusals.shape })
        return
      }
      answerJson(res, 200, await pending.claim(claim))
    },
  }), 'content-frame: page read claim route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTENT_REPORT_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(req, res, 'POST', reportBytes)
        return
      }
      if (rejectUntrustedPost(req, res, REPORT_ROUTE_NAME, reportBytes)) return
      const body = takeJsonBody(res, await readJsonBody(req, reportBytes), reportRefusals)
      if (body === undefined) return
      const report = parseChannelReport(body.value, maxTextChars, maxSteps)
      if (report === undefined) {
        answerJson(res, 400, { error: reportRefusals.shape })
        return
      }
      answerJson(res, 200, pending.report(report))
    },
  }), 'content-frame: page read report route')

  // The projection registry is an optional seam, and this is the one thing a
  // composition without it goes without: the unclaimed refusal falls back to
  // the advice an empty column earns, which is what an unreadable column is
  // from here.
  const front = (session: Session): FrontEntry | undefined => frontEntry(
    ctx.get('sessionProjections')?.snapshot(session).values.contentSurface,
  )
  const wait = { pending, timeouts, front }
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(contentReadTool(pending, timeouts, front))
    toolCtx.tools.register(contentReadDomTool(wait))
    toolCtx.tools.register(contentReadAttrsTool(wait))
    toolCtx.tools.register(contentReadDomContentTool(wait))
    toolCtx.tools.register(contentActTool(pending, actTimeouts, maxSteps, front, approvals))
    registerActApproval(toolCtx, approvals, maxSteps)
  })
  // One level in from the tools above: the picture read answers with a stored
  // attachment, so it exists only where there is a store to keep one in, and
  // the route its pixels arrive on exists with it.
  ctx.inject(['tools', 'attachments'], (imageCtx) => {
    const attachments = imageCtx.attachments
    imageCtx.tools.register(contentReadImageTool(wait, imageCtx))
    imageCtx.effect(() => imageCtx.webServer.register({
      kind: 'exact',
      path: CONTENT_IMAGE_ROUTE,
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          rejectMethod(req, res, 'POST', IMAGE_REPORT_BYTES)
          return
        }
        if (rejectUntrustedPost(req, res, IMAGE_ROUTE_NAME, IMAGE_REPORT_BYTES)) return
        const body = takeJsonBody(res, await readJsonBody(req, IMAGE_REPORT_BYTES), imageRefusals)
        if (body === undefined) return
        const report = parseImageReport(body.value)
        if (report === undefined) {
          answerJson(res, 400, { error: imageRefusals.shape })
          return
        }
        answerJson(res, 200, await settleImageReport(attachments, pending, report))
      },
    }), 'content-frame: page picture report route')
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(contentAccessProjection(projectionCtx.logger))
  })
  return {
    outlineChars,
    claimTimeoutMs,
    readTimeoutMs: timeouts.answerTimeoutMs,
    settleQuietMs,
    actTimeoutMs: actTimeouts.answerTimeoutMs,
    maxSteps,
    settleMaxMs,
  }
}

/**
 * Validate the configuration, then claim the route, the tool, and the
 * projection unit.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Loud at load, all of it: a root that is not a directory would answer every
  // request with 404, and a broken page list would surface as a tool call the
  // agent cannot get right — both with no diagnostic pointing at the row.
  const pages = indexPages(config.pages, config.defaultPage)
  if (config.homePage !== undefined && !pages.has(config.homePage)) {
    throw new Error(`content-frame: homePage "${config.homePage}" names no configured page`)
  }
  const cacheSize = config.cacheSize ?? DEFAULT_CACHE_SIZE
  if (cacheSize < 1) throw new Error(`content-frame: cacheSize must be at least 1, received ${cacheSize}`)
  const navigationPollMs = config.navigationPollMs ?? DEFAULT_NAVIGATION_POLL_MS
  if (navigationPollMs < 1) {
    throw new Error(`content-frame: navigationPollMs must be at least 1, received ${navigationPollMs}`)
  }
  const context: ColumnContextBounds = {
    entries: config.contextEntries ?? DEFAULT_CONTEXT_ENTRIES,
    fieldChars: config.contextFieldChars ?? DEFAULT_CONTEXT_FIELD_CHARS,
  }
  if (context.entries < 1) {
    throw new Error(`content-frame: contextEntries must be at least 1, received ${context.entries}`)
  }
  if (context.fieldChars < MIN_CONTEXT_FIELD_CHARS) {
    throw new Error(
      `content-frame: contextFieldChars must be at least ${String(MIN_CONTEXT_FIELD_CHARS)}, `
      + `received ${String(context.fieldChars)}`,
    )
  }
  // The type offers this block or nothing, and a row can write a third thing: a
  // bare `pageAccess:` key is YAML for null, which the object schema passes
  // through untouched while it refuses every other non-object on its own. Read
  // as the loader delivered it, because the declared type excludes the value
  // being tested for.
  const configured: unknown = config.pageAccess
  if (configured === null) {
    throw new Error('content-frame: pageAccess must be an object — write `pageAccess: {}` for the defaults')
  }
  const root = await resolveRoot(config.root)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: CONTENT_APP_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        // `allow` because this route owns its whole prefix: nothing else can
        // answer the method the caller asked for, so the response states the
        // complete set, as 405 requires.
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      /* v8 ignore next -- node:http always sets url on server requests */
      const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
      await serveContentApp(pathname.slice(CONTENT_APP_ROUTE.length), res, root)
    },
  }), 'content-frame: hosted application route')
  const pageAccess = config.pageAccess === undefined ? undefined : claimPageAccess(ctx, config.pageAccess)
  const settings: ContentFrameSettings = {
    cacheSize,
    navigationPollMs,
    pages: [...pages.values()],
    ...config.homePage === undefined ? {} : { homePage: config.homePage },
    ...pageAccess === undefined ? {} : { pageAccess },
  }
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: CONTENT_SETTINGS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      // The browser half reads this once per boot and the values come from the
      // row it booted with, so a cached copy would outlive its own truth.
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(settings))
    },
  }), 'content-frame: browser settings route')
  // Every child activates only when its seam is composed: a deployment without
  // a tool runtime, without a projection registry, or without the content
  // column's router keeps the route, and the browser shows nothing.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(contentShowTool(pages))
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(contentProjection(pages, config.defaultPage))
    projectionCtx.sessionProjections.register(contentPagesProjection())
  })
  registerColumnContext(ctx, pages, config.pageAccess !== undefined, context)
  ctx.inject(['contentSurface'], (surfaceCtx) => {
    surfaceCtx.contentSurface.register(pageExtractor(pages))
  })
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register(showContentPageCommand(pages))
    commandsCtx.commands.register(contentNavigatedCommand(pages))
  })
}
