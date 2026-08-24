/**
 * @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc — charts the agent draws
 * inside the conversation, with the browser's answer wired back into the tool
 * result.
 *
 * The node half offers `show_chart` to the model, serves the browser half its
 * settings, takes each call's render verdict on a second route, and projects
 * the session's chart calls under `showCharts`; the browser half owns the
 * `show_chart` key of the transcript's tool-view slot, paints the option
 * through the Vue 2.7 component row, and reads that projection to tell a
 * current chart from one a later call replaced.
 *
 * Trust: `option` is model output rendered by a real engine inside the shell's
 * own origin, and the report route accepts a same-site JSON verdict from
 * anything that can reach that origin. Both are bounded rather than trusted —
 * the browser half sanitizes the option before painting it (see its
 * `sanitize.ts` and the package README's trust section), a report changes
 * nothing but the outcome of a call already waiting for one, and the
 * deployment's byte and point ceilings apply before any of it.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc
 */

import { Buffer } from 'node:buffer'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: resolves ctx.sessionProjections for the optional unit child.
import type {} from '@deepseek-ai/dsh-session-projection'
import { PendingCharts } from './pending.ts'
import { showChartsProjection } from './projection.ts'
import {
  parseShowChartReport,
  SHOW_CHART_REPORT_ROUTE,
  SHOW_CHART_SETTINGS_ROUTE,
  type ShowChartReportAck,
  type ShowChartSettings,
} from './route.ts'
import { showChartTool, type ShowChartPolicy } from './tool.ts'

export type {
  ShowChartReport,
  ShowChartReportAck,
  ShowChartSettings,
} from './route.ts'
export { SHOW_CHART_REPORT_ROUTE, SHOW_CHART_SETTINGS_ROUTE } from './route.ts'

// The `showCharts` declarations live in src/types.ts (their one home); this
// re-export projects the type face onto the package root and keeps the module
// edge in the emitted index.d.ts.
export type * from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'show-chart'

/** Service required before the two routes can be claimed. */
export const inject = ['webServer']

/** Plugin config: the bounds one deployment puts on a model-supplied chart. */
export interface Config {
  /**
   * Largest `option` a call may carry, as UTF-8 bytes of its JSON form. The
   * ceiling exists because the document is model output that reaches a real
   * rendering engine in the user's browser; raise it for a deployment charting
   * long category labels, lower it to keep a runaway call cheap.
   */
  maxOptionBytes?: number
  /**
   * Largest total of `series[i].data` entries a call may carry. Bounds what the
   * browser has to paint and what a screenshot has to encode; the ceiling a
   * deployment sets is also stated in the tool description, so a first call can
   * respect it.
   */
  maxPoints?: number
  /**
   * How long the tool waits for a browser to report what it painted. Past it
   * the call answers unverified rather than failing: the chart is in the
   * transcript either way, and no browser may be open at all.
   */
  verdictTimeoutMs?: number
  /**
   * Whether a painted chart is captured as a PNG and returned to the model as
   * an image block. Off by default: it needs an image-capable model and costs
   * image tokens on every call.
   */
  screenshot?: boolean
}

/** Largest `option` accepted when a deployment configures none. */
const DEFAULT_MAX_OPTION_BYTES = 65536
/** Largest point total accepted when a deployment configures none. */
const DEFAULT_MAX_POINTS = 2000
/** Verdict deadline used when a deployment configures none. */
const DEFAULT_VERDICT_TIMEOUT_MS = 8000

export const Config: z<Config> = z.object({
  maxOptionBytes: z.natural().default(DEFAULT_MAX_OPTION_BYTES),
  maxPoints: z.natural().default(DEFAULT_MAX_POINTS),
  verdictTimeoutMs: z.natural().default(DEFAULT_VERDICT_TIMEOUT_MS),
  screenshot: z.boolean().default(false),
})

/**
 * Bytes a verdict-only report can possibly need: one call id, two integers or
 * one engine message, and the JSON around them. A protocol bound, not a
 * deployment choice — nothing a browser may legitimately post is larger.
 */
const MAX_VERDICT_BYTES = 8 * 1024

/** Answer a request whose method the route does not serve. */
function rejectMethod(res: ServerResponse, allow: string): void {
  // `allow` because these routes own their exact paths: nothing else can answer
  // the method the caller asked for, so the response states the complete set.
  res.writeHead(405, { allow })
  res.end()
}

/** Answer one JSON document with no caching; both routes serve request-local truth. */
function answerJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/**
 * Refuse a report a browser labelled cross-site, or one that is not sent as
 * JSON. Applied before the body is read: a verdict reaches the model as tool
 * result text, so the route stays a same-site JSON channel rather than a
 * document any page can post to. `cross-site` is the same marker the shell's
 * own /api fence refuses (`dsh-client-connection`'s `api-request-trust.ts`);
 * requiring the content type withdraws the route from the CORS-simple set a
 * cross-origin page can post without a preflight.
 * @param req - the incoming request.
 * @param res - the response, answered here when the request is refused.
 * @returns true when the request was refused and the handler must stop.
 */
function rejectUntrustedReport(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    answerJson(res, 403, { error: 'show-chart: the report route serves same-site requests only' })
    return true
  }
  const contentType = req.headers['content-type']
  if (contentType === undefined || !contentType.toLowerCase().trimStart().startsWith('application/json')) {
    answerJson(res, 415, { error: 'show-chart: the report route accepts application/json only' })
    return true
  }
  return false
}

/**
 * Read one request body, refusing anything past the bound before buffering it.
 * @param req - the incoming request.
 * @param limit - largest accepted body in bytes.
 * @returns the decoded JSON, or `undefined` when the body is oversized or not JSON.
 */
async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const bytes = chunk as Buffer
    size += bytes.byteLength
    if (size > limit) return undefined
    chunks.push(bytes)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch (_bodyIsNotJson) {
    // The only thing a malformed body can mean here is a caller that is not
    // this package's browser half; the 400 below says so.
    return undefined
  }
}

/** Reject a configured bound that would make the tool unusable, at load. */
function requirePositive(field: keyof Config, value: number): number {
  if (value < 1) throw new Error(`show-chart: ${field} must be at least 1, received ${value}`)
  return value
}

/**
 * Validate the configuration, then claim the two routes and the tool.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load: a zero ceiling would refuse every call the model can make,
  // with no diagnostic pointing at the row that set it.
  const policy: ShowChartPolicy = {
    maxOptionBytes: requirePositive('maxOptionBytes', config.maxOptionBytes ?? DEFAULT_MAX_OPTION_BYTES),
    maxPoints: requirePositive('maxPoints', config.maxPoints ?? DEFAULT_MAX_POINTS),
    verdictTimeoutMs: requirePositive('verdictTimeoutMs', config.verdictTimeoutMs ?? DEFAULT_VERDICT_TIMEOUT_MS),
    screenshot: config.screenshot ?? false,
  }
  const pending = new PendingCharts()
  const settings: ShowChartSettings = { screenshot: policy.screenshot }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SHOW_CHART_SETTINGS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rejectMethod(res, 'GET, HEAD')
        return
      }
      // The browser half reads this once per boot and the value comes from the
      // row it booted with, so a cached copy would outlive its own truth.
      answerJson(res, 200, settings)
    },
  }), 'show-chart: browser settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SHOW_CHART_REPORT_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(res, 'POST')
        return
      }
      if (rejectUntrustedReport(req, res)) return
      // A capture is a whole PNG in base64, so the bound follows the store's own
      // per-image ceiling; with screenshots off nothing legitimate carries one.
      const imageBytes = policy.screenshot ? ctx.get('attachments')?.imageLimits.maxImageBytes ?? 0 : 0
      const report = parseShowChartReport(await readJsonBody(req, MAX_VERDICT_BYTES + Math.ceil(imageBytes / 3) * 4))
      if (report === undefined) {
        answerJson(res, 400, { error: 'show-chart: expected a JSON body with callId and verdict' })
        return
      }
      const ack: ShowChartReportAck = { accepted: pending.report(report) }
      answerJson(res, 200, ack)
    },
  }), 'show-chart: render report route')

  // Both children activate only when their seam is composed: a deployment
  // without a tool runtime keeps the routes and offers the model nothing, and
  // one without a projection registry paints every row as the call that drew
  // it — no supersede, and nothing else changes.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.tools.register(showChartTool(toolCtx, policy, pending))
  })
  ctx.inject(['sessionProjections'], (projectionCtx) => {
    projectionCtx.sessionProjections.register(showChartsProjection())
  })
}
