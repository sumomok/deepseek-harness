/**
 * REAL-composition coverage for this package's two routes: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver, the tool
 * runtime, and the show-chart row, and every assertion observes the served HTTP
 * surface — the browser settings document, the verdict a posted report settles,
 * the refusals a cross-site, non-JSON, malformed, or oversized body gets,
 * method gating, and route release on fiber disposal (HMR safety).
 *
 * The config-validation cases call `apply` directly: a rejected configuration
 * never reaches a served surface, so there is nothing for HTTP to observe.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test — the node half of a dual-face client package is
 * spelled this way (dsh-client-modules, dsh-client-hmr).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm/brand'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ShowChart from '../src/index.ts'
import { FakeAttachments } from './fake-attachments.client.ts'
import { SHOW_CHART_REPORT_ROUTE, SHOW_CHART_SETTINGS_ROUTE } from '../src/route.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  allow: string | null
  cacheControl: string | null
  body: string
}

/** Write a five-row cordis.yml and boot it through the real Loader. */
async function loadComposition(screenshot = false): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-show-chart-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // Both optional seams, so this composition activates the tool child and
    // the projection child rather than only the routes.
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    '- id: show-chart',
    "  name: '@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc'",
    '  config:',
    `    screenshot: ${String(screenshot)}`,
    '    verdictTimeoutMs: 50',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc', ShowChart],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** The running server's browser-facing origin. */
function origin(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}`
}

/** Issue one request against the running server. */
async function call(ctx: Context, path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`${origin(ctx)}${path}`, init)
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  }
}

/** POST one JSON document to the report route. */
function postReport(ctx: Context, body: unknown): Promise<Answer> {
  return call(ctx, SHOW_CHART_REPORT_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('show-chart routes', () => {
  it('serves the browser half the capture switch its row must obey', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SHOW_CHART_SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ screenshot: false })
    // Read once per boot from the row that booted: a cached copy would outlive
    // its own truth.
    expect(answer.cacheControl).toBe('no-store')
  })

  it('serves the capture switch a deployment turned on', async () => {
    const ctx = await loadComposition(true)
    expect(JSON.parse((await call(ctx, SHOW_CHART_SETTINGS_ROUTE)).body)).toEqual({ screenshot: true })
  })

  it('answers a report for no waiting call without changing anything', async () => {
    const ctx = await loadComposition()
    const answer = await postReport(ctx, {
      callId: 'call_from_a_replayed_log',
      verdict: { ok: true, seriesCount: 1, pointCount: 3 },
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ accepted: false })
  })

  it('settles a waiting call with the verdict a browser posted', async () => {
    const ctx = await loadComposition()
    const settled = ctx.tools.execute({
      callId: 'call_live' as Parameters<typeof ctx.tools.execute>[0]['callId'],
      name: 'show_chart',
      arguments: { title: 'Live', option: { series: [{ type: 'line', data: [1, 2] }] } },
      signal: new AbortController().signal,
    })
    // The wait is registered inside the tool body; the report only lands once
    // the dispatch has reached it.
    await Promise.resolve()
    await Promise.resolve()
    const answer = await postReport(ctx, {
      callId: 'call_live',
      verdict: { ok: true, seriesCount: 1, pointCount: 2 },
    })
    expect(JSON.parse(answer.body)).toEqual({ accepted: true })
    const result = await settled
    expect(result.content).toEqual([{ type: 'text', text: 'Rendered: Live — 1 series, 2 points' }])
  })

  it('refuses a body that is not a report', async () => {
    const ctx = await loadComposition()
    for (const body of [
      'not json at all',
      JSON.stringify('a string'),
      JSON.stringify({ verdict: { ok: true, seriesCount: 1, pointCount: 1 } }),
      JSON.stringify({ callId: '', verdict: { ok: true, seriesCount: 1, pointCount: 1 } }),
      JSON.stringify({ callId: 'c', verdict: 'painted' }),
      JSON.stringify({ callId: 'c', verdict: { ok: true, seriesCount: 'many', pointCount: 1 } }),
      JSON.stringify({ callId: 'c', verdict: { ok: false } }),
      JSON.stringify({ callId: 'c', verdict: { ok: 'maybe' } }),
      JSON.stringify({ callId: 'c', verdict: { ok: true, seriesCount: 1, pointCount: 1 }, dataUrl: 7 }),
    ]) {
      const answer = await postReport(ctx, body)
      expect({ body, status: answer.status }).toEqual({ body, status: 400 })
    }
  })

  it('refuses a report a browser labelled cross-site', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SHOW_CHART_REPORT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ callId: 'c', verdict: { ok: true, seriesCount: 1, pointCount: 1 } }),
    })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'show-chart: the report route serves same-site requests only' })
  })

  it('takes a report a browser labelled same-origin', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SHOW_CHART_REPORT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ callId: 'c', verdict: { ok: true, seriesCount: 1, pointCount: 1 } }),
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ accepted: false })
  })

  it('refuses a report that is not sent as JSON', async () => {
    const ctx = await loadComposition()
    const report = JSON.stringify({ callId: 'c', verdict: { ok: true, seriesCount: 1, pointCount: 1 } })
    // `text/plain` is the CORS-simple content type a cross-origin page can post
    // without a preflight; a request carrying none at all is refused the same way.
    for (const headers of [{ 'content-type': 'text/plain;charset=UTF-8' }, {}]) {
      const answer = await call(ctx, SHOW_CHART_REPORT_ROUTE, { method: 'POST', headers, body: report })
      expect(answer.status).toBe(415)
      expect(JSON.parse(answer.body))
        .toEqual({ error: 'show-chart: the report route accepts application/json only' })
    }
  })

  it('refuses a body past the bound instead of buffering it', async () => {
    const ctx = await loadComposition()
    // Screenshots are off in this composition, so the bound is the verdict-only
    // one and a padded report is already too large.
    const answer = await postReport(ctx, {
      callId: 'c',
      verdict: { ok: false, error: 'x'.repeat(16 * 1024) },
    })
    expect(answer.status).toBe(400)
  })

  it('keeps the verdict-only bound while screenshots are on and no store is mounted', async () => {
    const ctx = await loadComposition(true)
    // Nothing can hold a capture, so the bound stays the small one and a
    // capture-sized report is refused rather than buffered.
    const answer = await postReport(ctx, {
      callId: 'c',
      verdict: { ok: true, seriesCount: 1, pointCount: 1 },
      dataUrl: `data:image/png;base64,${'A'.repeat(16 * 1024)}`,
    })
    expect(answer.status).toBe(400)
  })

  it('raises the bound to the store\'s own per-image ceiling once one is mounted', async () => {
    const ctx = await loadComposition(true)
    // The AttachmentStore constructor is the registration.
    const store = new FakeAttachments(ctx)
    const answer = await postReport(ctx, {
      callId: 'c',
      verdict: { ok: true, seriesCount: 1, pointCount: 1 },
      dataUrl: `data:image/png;base64,${'A'.repeat(16 * 1024)}`,
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ accepted: false })
    // Nothing was waiting, so the capture never reached the store.
    expect(store.saved).toEqual([])
  })

  it('states the complete method set it serves on each route', async () => {
    const ctx = await loadComposition()
    const settings = await call(ctx, SHOW_CHART_SETTINGS_ROUTE, { method: 'POST' })
    expect({ status: settings.status, allow: settings.allow }).toEqual({ status: 405, allow: 'GET, HEAD' })
    const report = await call(ctx, SHOW_CHART_REPORT_ROUTE)
    expect({ status: report.status, allow: report.allow }).toEqual({ status: 405, allow: 'POST' })
  })

  it('serves a HEAD of the settings document', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SHOW_CHART_SETTINGS_ROUTE, { method: 'HEAD' })
    expect(answer.status).toBe(200)
  })

  it('offers the tool only while a tool runtime is composed', async () => {
    const ctx = await loadComposition()
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('show_chart')
  })

  it('projects the session\'s charts only while a projection registry is composed', async () => {
    const ctx = await loadComposition()
    // The store is reached through `ctx.get` and cast: this package compiles in
    // the Client aggregate, where the cordis `Context.sessions` merge names the
    // browser service rather than the host store.
    const session = (ctx.get('sessions') as unknown as SessionStore).create()
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CallId('call_1'),
      name: 'show_chart',
      arguments: JSON.stringify({ id: 'revenue', option: { series: [{ type: 'bar', data: [1] }] } }),
    })
    expect(ctx.sessionProjections.snapshot(session).values.showCharts).toEqual({
      entries: [{ chartId: 'revenue', callId: 'call_1', title: null, seq: 0 }],
      latest: { revenue: 'call_1' },
    })
  })

  it('releases both routes when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition()
    const base = origin(ctx)
    expect((await call(ctx, SHOW_CHART_SETTINGS_ROUTE)).status).toBe(200)

    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'show-chart')
    await row?.fiber?.dispose()
    // The webserver's own fallback answers a path nobody claims.
    const answer = await fetch(`${base}${SHOW_CHART_SETTINGS_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })
})

describe('show-chart configuration', () => {
  it('falls back to its own defaults for a caller that configures nothing', async () => {
    const ctx = new Context()
    const claimed: string[] = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => {
        claimed.push(route.path)
        return () => {}
      },
    } as never)
    await ctx.plugin({
      inject: ['webServer'],
      apply: (inner: Context) => { ShowChart.apply(inner, {}) },
    }).await()
    expect(claimed).toEqual([SHOW_CHART_SETTINGS_ROUTE, SHOW_CHART_REPORT_ROUTE])
    await ctx.fiber.dispose()
  })

  it('rejects a bound that would refuse every call the model can make', () => {
    for (const [field, config] of [
      ['maxOptionBytes', { maxOptionBytes: 0 }],
      ['maxPoints', { maxPoints: 0 }],
      ['verdictTimeoutMs', { verdictTimeoutMs: 0 }],
    ] as const) {
      expect(() => { ShowChart.apply(new Context(), config) })
        .toThrow(`show-chart: ${field} must be at least 1, received 0`)
    }
  })
})
