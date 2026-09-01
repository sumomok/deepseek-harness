/**
 * REAL-composition coverage for the read channel: a test-only cordis.yml booted
 * through the vendored Loader mounts the webserver, the tool runtime, the
 * projection registry, and this row, and every assertion observes the served
 * HTTP surface — the settings document a seat boots from, the claim and report
 * round trip that settles a waiting call, the refusals a cross-site, non-JSON,
 * malformed, or oversized body gets, method gating, and route release on fiber
 * disposal (HMR safety).
 *
 * The second composition is the whole point of the switch: with no `pageAccess`
 * block, the same row serves the same pages and offers none of it.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test — the node half of a dual-face client package is
 * spelled this way (dsh-client-modules, dsh-client-hmr).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ContentFrame from '../src/index.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ClaimAck, type ReadOutcome } from '../src/access/wire.ts'
import { CONTENT_SETTINGS_ROUTE } from '../src/route.ts'

/** The hosted directory this composition serves; any real directory will do. */
const APP_ROOT = fileURLToPath(new URL('./fixtures/app', import.meta.url))

/** The listing budget this composition configures, small enough to post past. */
const OUTLINE_CHARS = 100

/** The tab every case here answers from. */
const TAB = 'tab_1'

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

/**
 * Write a cordis.yml with, without, or with a hand-written page-access block,
 * and boot it through the real Loader.
 */
async function loadComposition(pageAccess: boolean, accessRows: readonly string[] = []): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-content-read-'))
  const configPath = join(world, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // Every optional seam, so this composition activates the read tool and the
    // pending projection rather than only the routes.
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    '- id: content-frame',
    "  name: '@deepseek-ai/dsh-experimental-content-frame'",
    '  config:',
    `    root: ${JSON.stringify(APP_ROOT)}`,
    '    pages:',
    '      - id: home',
    '        title: Home',
    "        description: The hosted application's entry page.",
    '        url: /content-app/',
  ]
  if (pageAccess) {
    rows.push(
      '    pageAccess:',
      '      claimTimeoutMs: 5000',
      '      readTimeoutMs: 5000',
      '      pinMs: 60000',
      `      outlineChars: ${OUTLINE_CHARS}`,
    )
  }
  rows.push(...accessRows)
  await writeFile(configPath, `${rows.join('\n')}\n`)

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
    ['@deepseek-ai/dsh-experimental-content-frame', ContentFrame],
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

/** POST one JSON document to a read route, the way the browser half does. */
function postJson(ctx: Context, path: string, body: unknown): Promise<Answer> {
  return call(ctx, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/**
 * POST one body that declares no length, the way a chunked sender arrives.
 * `fetch` always declares one for a string body, so this is the only way to
 * reach the bound the body reader keeps while the body is still arriving.
 */
function postChunked(ctx: Context, path: string, body: string): Promise<Answer> {
  return new Promise<Answer>((resolve, reject) => {
    const req = httpRequest(
      `${origin(ctx)}${path}`,
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            allow: res.headers.allow ?? null,
            cacheControl: res.headers['cache-control'] ?? null,
            body: text,
          })
        })
      },
    )
    req.on('error', reject)
    // Written before it is ended: node declares a length for a body handed to
    // `end()` in one piece, and only a body it has already begun sending goes
    // out with no length at all.
    req.write(body)
    req.end()
  })
}

/** A session on the host store, reached through `ctx.get` for the compile-face reason below. */
function hostSession(ctx: Context): Session {
  // The store is reached through `ctx.get` and cast: this package compiles in
  // the Client aggregate, where the cordis `Context.sessions` merge names the
  // browser service rather than the host store.
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** Start one `content_read` for a session, the way an agent loop would. */
function startRead(ctx: Context, session: Session, callId: string): Promise<ToolExecutionResult> {
  return ctx.tools.execute({
    callId: callId as ToolExecutionInput['callId'],
    name: 'content_read',
    arguments: {},
    agent: { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>,
    signal: new AbortController().signal,
  })
}

/** One listing, as a browser seat posts it. */
const LISTING: ReadOutcome = {
  status: 'ok',
  page: { id: 'home', title: 'Home' },
  snapshot: {
    kind: 'outline',
    url: 'http://127.0.0.1/content-app/',
    title: 'Hosted content app',
    signIn: false,
    text: '1 heading "Hosted content app"',
    truncated: false,
    shown: 1,
    total: 1,
  },
}

describe('the read channel over real HTTP', () => {
  it('serves a seat the budget and both deadlines it must obey', async () => {
    const ctx = await loadComposition(true)
    const answer = await call(ctx, CONTENT_SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({
      pageAccess: { outlineChars: OUTLINE_CHARS, claimTimeoutMs: 5000, readTimeoutMs: 5000 },
    })
    expect(answer.cacheControl).toBe('no-store')
  })

  it('settles a waiting call with the listing the claiming tab posted', async () => {
    const ctx = await loadComposition(true)
    const session = hostSession(ctx)
    const settled = startRead(ctx, session, 'call_live')
    // The wait is registered inside the tool body; the claim only wins once the
    // dispatch has reached it, which is exactly what `unknown` means here.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const claim = await postJson(ctx, CONTENT_CLAIM_ROUTE, { callId: 'call_live', tabId: TAB })
      if ((JSON.parse(claim.body) as ClaimAck).claimed) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
    }
    const report = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'call_live', tabId: TAB, outcome: LISTING })
    expect(JSON.parse(report.body)).toEqual({ accepted: true })
    const result = await settled
    expect(result.content).toEqual([{
      type: 'text',
      text: 'Page: Home — the app is at /content-app/, title "Hosted content app"\n1 heading "Hosted content app"',
    }])
  })

  it('tells a seat the host does not know a call yet, and answers a settled one', async () => {
    const ctx = await loadComposition(true)
    const claim = await postJson(ctx, CONTENT_CLAIM_ROUTE, { callId: 'call_from_a_replayed_log', tabId: TAB })
    expect(claim.status).toBe(200)
    expect(JSON.parse(claim.body)).toEqual({ claimed: false, reason: 'unknown' })
    const report = await postJson(ctx, CONTENT_REPORT_ROUTE, {
      callId: 'call_from_a_replayed_log', tabId: TAB, outcome: LISTING,
    })
    expect(JSON.parse(report.body)).toEqual({ accepted: false })
  })

  it('refuses a post a browser labelled cross-site, and takes one labelled same-origin', async () => {
    const ctx = await loadComposition(true)
    for (const [route, refusal] of [
      [CONTENT_CLAIM_ROUTE, 'content-frame: the read claim route serves same-site requests only'],
      [CONTENT_REPORT_ROUTE, 'content-frame: the read report route serves same-site requests only'],
    ] as const) {
      const refused = await call(ctx, route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: JSON.stringify({ callId: 'c', tabId: TAB, outcome: LISTING }),
      })
      expect({ route, status: refused.status, body: JSON.parse(refused.body) as unknown })
        .toEqual({ route, status: 403, body: { error: refusal } })
      const taken = await call(ctx, route, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
        body: JSON.stringify({ callId: 'c', tabId: TAB, outcome: LISTING }),
      })
      expect({ route, status: taken.status }).toEqual({ route, status: 200 })
    }
  })

  it('refuses a post that is not sent as JSON', async () => {
    const ctx = await loadComposition(true)
    // `text/plain` is the CORS-simple content type a cross-origin page can post
    // without a preflight; a request carrying none at all is refused the same way.
    for (const route of [CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE]) {
      for (const headers of [{ 'content-type': 'text/plain;charset=UTF-8' }, {}]) {
        const answer = await call(ctx, route, { method: 'POST', headers, body: '{}' })
        expect({ route, status: answer.status }).toEqual({ route, status: 415 })
      }
    }
  })

  it('refuses a body that is not the document the route takes', async () => {
    const ctx = await loadComposition(true)
    for (const body of ['not json at all', JSON.stringify('a string'), JSON.stringify({ tabId: TAB })]) {
      expect((await postJson(ctx, CONTENT_CLAIM_ROUTE, body)).status).toBe(400)
      expect((await postJson(ctx, CONTENT_REPORT_ROUTE, body)).status).toBe(400)
    }
    expect(JSON.parse((await postJson(ctx, CONTENT_CLAIM_ROUTE, '{}')).body))
      .toEqual({ error: 'content-frame: expected a JSON body with callId and tabId' })
    expect(JSON.parse((await postJson(ctx, CONTENT_REPORT_ROUTE, '{}')).body))
      .toEqual({ error: 'content-frame: expected a JSON body with callId, tabId, and outcome' })
  })

  it('refuses a listing past the deployment\'s own budget instead of buffering it', async () => {
    const ctx = await loadComposition(true)
    const outcome = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(OUTLINE_CHARS * 4 + 1) } }
    expect((await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome })).status).toBe(400)
    // Past the whole body bound the request is refused before it is buffered.
    const huge = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(64 * 1024) } }
    expect((await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome: huge })).status).toBe(400)
    // A claim is bounded on its own, well below a listing.
    expect((await postJson(ctx, CONTENT_CLAIM_ROUTE, { callId: 'x'.repeat(2048), tabId: TAB })).status).toBe(400)
  })

  it('bounds a body that never declares how long it is', async () => {
    const ctx = await loadComposition(true)
    const huge = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(64 * 1024) } }
    const refused = await postChunked(
      ctx, CONTENT_REPORT_ROUTE, JSON.stringify({ callId: 'c', tabId: TAB, outcome: huge }),
    )
    expect(refused.status).toBe(400)
    // The same sender inside the bound is taken, so what refused the one above
    // is its size and not its missing header.
    const taken = await postChunked(ctx, CONTENT_CLAIM_ROUTE, JSON.stringify({ callId: 'c', tabId: TAB }))
    expect({ status: taken.status, body: JSON.parse(taken.body) as unknown })
      .toEqual({ status: 200, body: { claimed: false, reason: 'unknown' } })
  })

  it('states the complete method set each route serves', async () => {
    const ctx = await loadComposition(true)
    for (const route of [CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE]) {
      const answer = await call(ctx, route)
      expect({ route, status: answer.status, allow: answer.allow }).toEqual({ route, status: 405, allow: 'POST' })
    }
  })

  it('publishes the session\'s open reads for a browser to claim', async () => {
    const ctx = await loadComposition(true)
    const session = hostSession(ctx)
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call_1' as ToolExecutionInput['callId'],
      name: 'content_read',
      arguments: JSON.stringify({ mode: 'map' }),
    })
    expect(ctx.sessionProjections.snapshot(session).values.contentAccess).toEqual({
      pending: [{ callId: 'call_1', tool: 'content_read', args: { mode: 'map' } }],
    })
  })

  it('offers the tool only while a tool runtime is composed', async () => {
    const ctx = await loadComposition(true)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('content_read')
  })

  it('releases both routes when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition(true)
    const base = origin(ctx)
    expect((await postJson(ctx, CONTENT_CLAIM_ROUTE, { callId: 'c', tabId: TAB })).status).toBe(200)

    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'content-frame')
    await row?.fiber?.dispose()
    // The webserver's own fallback answers a path nobody claims.
    for (const route of [CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE]) {
      const answer = await fetch(`${base}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      expect({ route, status: answer.status }).toEqual({ route, status: 404 })
      await answer.arrayBuffer()
    }
  })
})

describe('a deployment that configures no page access', () => {
  it('has none of the channel at all', async () => {
    const ctx = await loadComposition(false)
    // No tool: the model is never offered a read it could not get an answer to.
    expect(ctx.tools.schemas().map(schema => schema.name)).not.toContain('content_read')
    // No routes.
    for (const route of [CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE]) {
      expect({ route, status: (await postJson(ctx, route, { callId: 'c', tabId: TAB })).status })
        .toEqual({ route, status: 404 })
    }
    // No projection, so no browser is ever asked to read anything.
    const session = hostSession(ctx)
    session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: 'call_1' as ToolExecutionInput['callId'],
      name: 'content_read',
      arguments: '{}',
    })
    expect(ctx.sessionProjections.snapshot(session).values.contentAccess).toBeUndefined()
    // And no settings field, which is how the browser half knows not to install
    // the reader or the transcript row.
    const settings = JSON.parse((await call(ctx, CONTENT_SETTINGS_ROUTE)).body) as Record<string, unknown>
    expect(Object.hasOwn(settings, 'pageAccess')).toBe(false)
    // The pages themselves are untouched: this switch adds a capability, it does
    // not gate the column.
    expect(settings.pages).toEqual([
      { id: 'home', title: 'Home', description: 'The hosted application\'s entry page.', url: '/content-app/' },
    ])
  })
})

describe('page-access configuration', () => {
  it('names a row that wrote a bare pageAccess key, which YAML reads as null', async () => {
    // The object schema passes null through, so without this diagnostic the
    // row fails on a TypeError naming a field the deployment never wrote.
    await expect(loadComposition(false, ['    pageAccess: ~'])).rejects.toThrow(
      'content-frame: pageAccess must be an object — write `pageAccess: {}` for the defaults',
    )
  })

  it('rejects a bound that would make every read unusable', async () => {
    for (const field of ['claimTimeoutMs', 'readTimeoutMs', 'pinMs', 'outlineChars'] as const) {
      const config = {
        root: APP_ROOT,
        pages: [{ id: 'home', title: 'Home', description: 'Entry.', url: '/content-app/' }],
        pageAccess: { claimTimeoutMs: 1, readTimeoutMs: 1, pinMs: 1, outlineChars: 1, [field]: 0 },
      }
      const ctx = new Context()
      ctx.provide('webServer', { register: () => () => {} } as never)
      await expect(ContentFrame.apply(ctx, config))
        .rejects.toThrow(`content-frame: pageAccess.${field} must be at least 1, received 0`)
      await ctx.fiber.dispose()
    }
  })
})
