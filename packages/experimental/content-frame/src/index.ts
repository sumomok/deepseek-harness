/**
 * @deepseek-ai/dsh-experimental-content-frame — the shell's content column as
 * a surface the agent AND the user drive. The node half serves a configured
 * directory under a named webserver route, offers the deployment's pages to
 * the model as `content_show`, offers the same catalog to the user's sidebar
 * page-navigation menu through the `show-content-page` command, and projects
 * what each session's column shows; the browser half claims the column and
 * keeps one live frame per session.
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
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
// Type-only: resolves ctx.contentSurface for the optional extractor child.
import type {} from '@deepseek-ai/dsh-experimental-content-surface'
// Type-only: resolves ctx.commands for the optional show-content-page command child.
import type {} from '@deepseek-ai/dsh-commands'
import type { ContentPage } from './types.ts'
import { indexPages } from './pages.ts'
import { contentProjection } from './projection.ts'
import { pageExtractor } from './surface.ts'
import { contentShowTool } from './tool.ts'
import { showContentPageCommand } from './command.ts'
import { CONTENT_APP_ROUTE, CONTENT_SETTINGS_ROUTE, type ContentFrameSettings } from './route.ts'
import { serveContentApp } from './serve.ts'
import {
  answerJson, readJsonBody, rejectMethod, rejectUntrustedPost, takeJsonBody, type BodyRefusals,
} from './access/http.ts'
import { PendingReads, type ReadTimeouts } from './access/pending.ts'
import { contentAccessProjection } from './access/requests-projection.ts'
import { contentReadTool } from './access/read-tool.ts'
import {
  CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, MAX_CURSOR_CHARS, MAX_HEADER_CHARS, MAX_NAME_CHARS,
  MAX_OUTCOME_MESSAGE_CHARS, MAX_TEXT_BUDGET_MULTIPLE, MAX_URL_CHARS, MIN_OUTLINE_CHARS,
  parseClaimRequest, parseReportRequest,
} from './access/wire.ts'

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
   * Lets the agent read the page in the column through `content_read`. Absent
   * turns the whole channel off: no tool, no claim or report route, no pending
   * projection, and no reader in the browser — a deployment that only shows
   * pages does not pay for a capability it did not ask for. Present with an
   * empty object takes every default below.
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
   * application needs more of it than a static one.
   */
  readTimeoutMs: number
  /**
   * How long the tab that answered stays the session's preferred reader. Refs
   * are per document, so consecutive reads of one session should reach one tab;
   * lower it for a deployment whose users move between consoles constantly.
   */
  pinMs: number
  /**
   * The character budget one listing is rendered under. It is the ceiling on
   * what a single read can cost in context: past it the read answers with the
   * page's map, or with a cursor to continue from. Raise it for a deployment
   * whose pages are large and whose model has room for them. At least 1000,
   * because a listing's first row is rendered however long it is and the wire
   * holds a posted listing to four times the budget: below that floor an
   * ordinary table's row is already past the bound, and every read of a page
   * holding one would be refused.
   */
  outlineChars: number
}

/** Default frame cache size: the current session plus the two before it. */
const DEFAULT_CACHE_SIZE = 3

/** Claim window used when a deployment enables page access and configures none. */
const DEFAULT_CLAIM_TIMEOUT_MS = 3000
/** Report deadline used when a deployment enables page access and configures none. */
const DEFAULT_READ_TIMEOUT_MS = 15000
/** Preferred-tab pin used when a deployment enables page access and configures none. */
const DEFAULT_PIN_MS = 300000
/** Listing budget used when a deployment enables page access and configures none. */
const DEFAULT_OUTLINE_CHARS = 12000

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
  // Cleared default, because schemastery gives every object schema `{}`: left
  // alone it would materialize this block for a deployment that configured
  // none and switch the read channel on by accident. `undefined` is not a
  // value of the block's own type, which is what the cast says.
  pageAccess: z.object({
    claimTimeoutMs: z.natural().default(DEFAULT_CLAIM_TIMEOUT_MS),
    readTimeoutMs: z.natural().default(DEFAULT_READ_TIMEOUT_MS),
    pinMs: z.natural().default(DEFAULT_PIN_MS),
    outlineChars: z.natural().default(DEFAULT_OUTLINE_CHARS),
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
 * Bytes a claim can possibly need: one call id, one tab id, and the JSON around
 * them. A protocol bound, not a deployment choice.
 */
const MAX_CLAIM_BYTES = 1024

/**
 * Bytes of JSON punctuation and key names one report is written with.
 *
 * A listing report with every string empty and nine-digit counters serializes
 * to 239 bytes; the union of that form's keys and a failure's is 283, which is
 * what the envelope has to leave room for, because a bound covering both forms
 * cannot be read off either one alone. Rounded up from there.
 */
const REPORT_SYNTAX_BYTES = 512

/**
 * Bytes of JSON the largest report carries around its listing, allowing four
 * UTF-8 bytes per character: the document's address, the three header fields,
 * the four names (two ids, the page's id and its title, or a failure's kind and
 * title), the cursor, and a failure message — each at the bound the wire holds
 * it to — plus {@link REPORT_SYNTAX_BYTES} for the punctuation and key names
 * around them.
 */
const REPORT_ENVELOPE_BYTES = 4 * (
  MAX_URL_CHARS + 3 * MAX_HEADER_CHARS + MAX_OUTCOME_MESSAGE_CHARS + 4 * MAX_NAME_CHARS + MAX_CURSOR_CHARS
) + REPORT_SYNTAX_BYTES

/** What the claim route calls itself in its own refusals. */
const CLAIM_ROUTE_NAME = 'the read claim route'

/** What the report route calls itself in its own refusals. */
const REPORT_ROUTE_NAME = 'the read report route'

/**
 * Claim the two read routes, the read tool, and the pending projection.
 *
 * Every registration lives inside this one call, so a deployment that
 * configures no `pageAccess` has none of them: the routes 404, the model is
 * offered no tool, no session publishes a pending list, and the browser half
 * reads the absent settings field and installs no reader.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - the deployment's page-access block.
 * @returns the settings the browser half needs to run a read.
 */
function claimPageAccess(ctx: Context, config: PageAccessConfig): ContentFrameSettings['pageAccess'] {
  // Loud at load: a zero deadline would refuse every read the model can make,
  // with no diagnostic pointing at the row that set it.
  const timeouts: ReadTimeouts = {
    claimTimeoutMs: requireAtLeast('claimTimeoutMs', config.claimTimeoutMs, 1),
    readTimeoutMs: requireAtLeast('readTimeoutMs', config.readTimeoutMs, 1),
    pinMs: requireAtLeast('pinMs', config.pinMs, 1),
  }
  const outlineChars = requireAtLeast('outlineChars', config.outlineChars, MIN_OUTLINE_CHARS)
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
  // refused as a shape by the parser rather than reaching this bound. Not the
  // character bound above converted, which would be sixteen bytes per rendered
  // character: past a budget the envelope no longer covers, this bound refuses
  // a listing of multibyte text that the parser's character bound alone would
  // have taken.
  const reportBytes = outlineChars * 4 + REPORT_ENVELOPE_BYTES
  const claimRefusals: BodyRefusals = {
    oversize: `content-frame: ${CLAIM_ROUTE_NAME} refuses a body past ${MAX_CLAIM_BYTES} bytes`,
    shape: 'content-frame: expected a JSON body with callId and tabId',
  }
  const reportRefusals: BodyRefusals = {
    oversize: `content-frame: ${REPORT_ROUTE_NAME} refuses a body past ${reportBytes} bytes`,
    shape: 'content-frame: expected a JSON body with callId, tabId, and outcome',
  }
  const pending = new PendingReads()

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
      const report = parseReportRequest(body.value, maxTextChars)
      if (report === undefined) {
        answerJson(res, 400, { error: reportRefusals.shape })
        return
      }
      answerJson(res, 200, pending.report(report))
    },
  }), 'content-frame: page read report route')

  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(contentReadTool(pending, timeouts))
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(contentAccessProjection())
  })
  return { outlineChars, claimTimeoutMs: timeouts.claimTimeoutMs, readTimeoutMs: timeouts.readTimeoutMs }
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
  })
  ctx.inject(['contentSurface'], (surfaceCtx) => {
    surfaceCtx.contentSurface.register(pageExtractor(pages))
  })
  ctx.inject(['commands'], (commandsCtx) => {
    commandsCtx.commands.register(showContentPageCommand(pages))
  })
}
