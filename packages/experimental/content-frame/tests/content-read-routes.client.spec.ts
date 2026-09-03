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
import { request as httpRequest, type IncomingMessage } from 'node:http'
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
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as ContentFrame from '../src/index.ts'
import {
  CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, MAX_BUSY_NAMES, MAX_CURSOR_CHARS, MAX_HEADER_CHARS,
  MAX_ACT_STEPS, MAX_NAME_CHARS, MAX_TEXT_BUDGET_MULTIPLE, MAX_URL_CHARS, MIN_OUTLINE_CHARS, parseChannelReport,
  type ClaimAck, type ReadOutcome,
} from '../src/access/wire.ts'
import { CONTENT_SETTINGS_ROUTE } from '../src/route.ts'

/** The hosted directory this composition serves; any real directory will do. */
const APP_ROOT = fileURLToPath(new URL('./fixtures/app', import.meta.url))

/** The listing budget this composition configures: the smallest a deployment may. */
const OUTLINE_CHARS = MIN_OUTLINE_CHARS

/** The claim route's own byte bound, which no deployment configures. */
const CLAIM_BYTES = 1024

/**
 * The JSON a report carries around its listing, which no deployment configures:
 * four bytes for each character of a `url` (2048), two header fields (200
 * each), a failure message (2000), four names (256 each) and a cursor (32),
 * plus 512 for the punctuation and key names. Written out rather than imported,
 * so a bound moving under it is a failure here and not a silent agreement.
 */
const ENVELOPE_BYTES = 22528

/**
 * The report route's byte bound for this composition: the seat's render budget
 * at four UTF-8 bytes per character, plus the envelope.
 */
const REPORT_BYTES = OUTLINE_CHARS * 4 + ENVELOPE_BYTES

/** The punctuation and key names {@link ENVELOPE_BYTES} leaves room for, written out for the same reason. */
const SYNTAX_BYTES = 512

/** The listing budget a deployment gets when it writes `pageAccess: {}`. */
const DEFAULT_OUTLINE_CHARS = 12000

/** One C0 control: six JSON bytes per unit where the byte bound allows four per character. */
const CONTROL = String.fromCharCode(1)

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
async function loadComposition(
  pageAccess: boolean,
  accessRows: readonly string[] = [],
  outlineChars: number = OUTLINE_CHARS,
  extraRows: readonly string[] = [],
  claimTimeoutMs = 5000,
): Promise<Context> {
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
      `      claimTimeoutMs: ${String(claimTimeoutMs)}`,
      '      readTimeoutMs: 5000',
      '      pinMs: 60000',
      `      outlineChars: ${outlineChars}`,
    )
  }
  rows.push(...accessRows, ...extraRows)
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
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
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

/** How one raw request is sent. */
interface RawRequest {
  /** Method; POST unless the case is about method gating. */
  method?: string
  /** Request headers; `application/json` unless the case is about the fence. */
  headers?: Record<string, string>
  /** The body, absent for a request that carries none. */
  body?: string
  /**
   * Send the body with no declared length. `fetch` and a one-piece `end()` both
   * declare one, so writing before ending is the only way to reach the bound
   * the reader keeps while the body is still arriving.
   */
  chunked?: boolean
}

/** One raw response, including the header `fetch` does not surface. */
interface RawAnswer {
  status: number
  connection: string | undefined
  body: string
}

/**
 * Issue one request through `node:http` rather than `fetch`.
 *
 * Two reasons: `connection` is a hop-by-hop header `fetch` does not surface,
 * and a refusal written before the body was read closes the socket under a
 * client that is still writing — which reaches this side as a reset once the
 * answer has already arrived.
 */
function raw(ctx: Context, path: string, init: RawRequest = {}): Promise<RawAnswer> {
  return new Promise<RawAnswer>((resolve, reject) => {
    let answered: IncomingMessage | undefined
    let text = ''
    const settle = (): void => {
      if (answered === undefined) return
      resolve({ status: answered.statusCode ?? 0, connection: answered.headers.connection, body: text })
    }
    const req = httpRequest(
      `${origin(ctx)}${path}`,
      {
        method: init.method ?? 'POST',
        headers: init.headers ?? { 'content-type': 'application/json' },
      },
      (res) => {
        answered = res
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => { text += chunk })
        res.on('end', settle)
        res.on('error', settle)
      },
    )
    req.on('error', (error) => { if (answered === undefined) reject(error); else settle() })
    if (init.chunked === true && init.body !== undefined) {
      req.write(init.body)
      req.end()
      return
    }
    req.end(init.body)
  })
}

/** A session on the host store, reached through `ctx.get` for the compile-face reason below. */
function hostSession(ctx: Context): Session {
  // The store is reached through `ctx.get` and cast: this package compiles in
  // the Client aggregate, where the cordis `Context.sessions` merge names the
  // browser service rather than the host store.
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** The text blocks one tool result carries, joined. */
function textOf(result: ToolExecutionResult): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
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
    settled: true,
  },
}

describe('the read channel over real HTTP', () => {
  it('serves a seat the budget and both deadlines it must obey', async () => {
    const ctx = await loadComposition(true)
    const answer = await call(ctx, CONTENT_SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toMatchObject({
      pageAccess: {
        outlineChars: OUTLINE_CHARS, claimTimeoutMs: 5000, readTimeoutMs: 5000,
        actTimeoutMs: 60000, maxSteps: 20, settleMaxMs: 2000,
      },
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

  it('admits exactly the types that begin with application/json, JSON family or not', async () => {
    const ctx = await loadComposition(true)
    const body = JSON.stringify({ callId: 'c', tabId: TAB })
    for (const [contentType, status] of [
      ['application/json', 200],
      ['application/json; charset=utf-8', 200],
      ['APPLICATION/JSON', 200],
      // Admitted and no kind of JSON, which is what makes the admitted set
      // neither a superset nor a subset of the JSON media types...
      ['application/jsonfoobar', 200],
      ['application/json-patch+json', 200],
      // ...and refused while being real JSON. Neither costs the fence anything:
      // no CORS-simple type begins with `application/json`.
      ['application/ld+json', 415],
      ['application/merge-patch+json', 415],
    ] as const) {
      const answer = await call(ctx, CONTENT_CLAIM_ROUTE, { method: 'POST', headers: { 'content-type': contentType }, body })
      expect({ contentType, status: answer.status }).toEqual({ contentType, status })
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

  it('refuses a listing whose settle report the seat did not write, or wrote as something else', async () => {
    // The two fields the settling wait added travel this route like every
    // other, so a report that omits `settled` or dresses `busy` up as
    // something the model would then read is refused here rather than folded
    // into a session.
    const ctx = await loadComposition(true)
    const { settled: _dropped, ...withoutSettled } = LISTING.snapshot
    const bad: readonly Record<string, unknown>[] = [
      withoutSettled,
      { ...LISTING.snapshot, settled: 'yes' },
      { ...LISTING.snapshot, busy: 'Fleet status' },
      { ...LISTING.snapshot, busy: [1] },
      { ...LISTING.snapshot, busy: ['a', 'b', 'c', 'd'] },
      { ...LISTING.snapshot, busy: ['b'.repeat(MAX_NAME_CHARS + 1)] },
    ]
    for (const snapshot of bad) {
      const answer = await postJson(ctx, CONTENT_REPORT_ROUTE, {
        callId: 'c', tabId: TAB, outcome: { ...LISTING, snapshot },
      })
      expect({ snapshot, status: answer.status }).toEqual({ snapshot, status: 400 })
      expect(JSON.parse(answer.body))
        .toEqual({ error: 'content-frame: expected a JSON body with callId, tabId, and outcome' })
    }
    // The same document with both fields as the seat writes them is taken.
    expect((await postJson(ctx, CONTENT_REPORT_ROUTE, {
      callId: 'c', tabId: TAB, outcome: { ...LISTING, snapshot: { ...LISTING.snapshot, busy: ['Fleet status'] } },
    })).status).toBe(200)
  })

  it('refuses a listing past the deployment\'s own budget, and one past the whole body bound', async () => {
    const ctx = await loadComposition(true)
    // Inside the byte bound and past the character bound: the body arrives in
    // full and the parser is what refuses it.
    const outcome = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(OUTLINE_CHARS * 4 + 1) } }
    const overCharacters = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome })
    expect({ status: overCharacters.status, body: JSON.parse(overCharacters.body) as unknown }).toEqual({
      status: 400,
      body: { error: 'content-frame: expected a JSON body with callId, tabId, and outcome' },
    })
    // Past the byte bound the read stops there, and the answer says so rather
    // than describing a document nobody sent.
    const huge = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(64 * 1024) } }
    const overBytes = await raw(ctx, CONTENT_REPORT_ROUTE, {
      body: JSON.stringify({ callId: 'c', tabId: TAB, outcome: huge }),
    })
    expect({ status: overBytes.status, body: JSON.parse(overBytes.body) as unknown }).toEqual({
      status: 413,
      body: { error: `content-frame: the read report route refuses a body past ${REPORT_BYTES} bytes` },
    })
    // A claim is bounded on its own, well below a listing.
    const overClaim = await raw(ctx, CONTENT_CLAIM_ROUTE, {
      body: JSON.stringify({ callId: 'x'.repeat(2048), tabId: TAB }),
    })
    expect({ status: overClaim.status, body: JSON.parse(overClaim.body) as unknown }).toEqual({
      status: 413,
      body: { error: `content-frame: the read claim route refuses a body past ${CLAIM_BYTES} bytes` },
    })
  })

  it('bounds a body that never declares how long it is', async () => {
    const ctx = await loadComposition(true)
    const huge = { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(64 * 1024) } }
    const refused = await raw(ctx, CONTENT_REPORT_ROUTE, {
      body: JSON.stringify({ callId: 'c', tabId: TAB, outcome: huge }),
      chunked: true,
    })
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown }).toEqual({
      status: 413,
      body: { error: `content-frame: the read report route refuses a body past ${REPORT_BYTES} bytes` },
    })
    // The same sender inside the bound is taken, so what refused the one above
    // is its size and not its missing header.
    const taken = await raw(ctx, CONTENT_CLAIM_ROUTE, {
      body: JSON.stringify({ callId: 'c', tabId: TAB }),
      chunked: true,
    })
    expect({ status: taken.status, body: JSON.parse(taken.body) as unknown })
      .toEqual({ status: 200, body: { claimed: false, reason: 'unknown' } })
  })

  it('closes the connection on every refusal it writes before the body was read', async () => {
    const ctx = await loadComposition(true)
    const claim = JSON.stringify({ callId: 'c', tabId: TAB })
    const written = [
      ['method', await raw(ctx, CONTENT_CLAIM_ROUTE, { method: 'GET' })],
      ['cross-site', await raw(ctx, CONTENT_CLAIM_ROUTE, {
        headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
        body: claim,
      })],
      ['not JSON', await raw(ctx, CONTENT_CLAIM_ROUTE, { headers: { 'content-type': 'text/plain' }, body: claim })],
      ['claim past its bound', await raw(ctx, CONTENT_CLAIM_ROUTE, {
        body: JSON.stringify({ callId: 'x'.repeat(2048), tabId: TAB }),
      })],
      ['report past its bound', await raw(ctx, CONTENT_REPORT_ROUTE, {
        body: JSON.stringify({
          callId: 'c', tabId: TAB, outcome: { ...LISTING, snapshot: { ...LISTING.snapshot, text: 'x'.repeat(64 * 1024) } },
        }),
      })],
      // Both of these arrived in full, so the connection is left alive.
      ['taken', await raw(ctx, CONTENT_CLAIM_ROUTE, { body: claim })],
      ['malformed', await raw(ctx, CONTENT_CLAIM_ROUTE, { body: 'not json at all' })],
    ] as const
    expect(written.map(([name, answer]) => [name, answer.status, answer.connection])).toEqual([
      ['method', 405, 'close'],
      ['cross-site', 403, 'close'],
      ['not JSON', 415, 'close'],
      ['claim past its bound', 413, 'close'],
      ['report past its bound', 413, 'close'],
      ['taken', 200, 'keep-alive'],
      ['malformed', 400, 'keep-alive'],
    ])
  })

  it('holds a listing to the render budget in bytes, which is tighter than its character bound', async () => {
    // Large enough that four bytes per rendered character is the tighter of the
    // two bounds: below about three thousand the envelope alone covers a
    // listing of the parser's whole character bound in three-byte text.
    const outlineChars = 4000
    const ctx = await loadComposition(true, [], outlineChars)
    const report = (chars: number): Record<string, unknown> => ({
      callId: 'c',
      tabId: TAB,
      // Three UTF-8 bytes each, which is where the two bounds come apart.
      outcome: { ...LISTING, snapshot: { ...LISTING.snapshot, text: '甲'.repeat(chars) } },
    })
    const inside = await raw(ctx, CONTENT_REPORT_ROUTE, { body: JSON.stringify(report(outlineChars)) })
    expect({ status: inside.status, body: JSON.parse(inside.body) as unknown })
      .toEqual({ status: 200, body: { accepted: false } })
    // Exactly the parser's character bound and four times the byte bound: what
    // refuses this is the render budget in bytes, not the character count.
    const past = report(outlineChars * 4)
    expect(parseChannelReport(past, outlineChars * 4, MAX_ACT_STEPS)).toBeDefined()
    const refused = await raw(ctx, CONTENT_REPORT_ROUTE, { body: JSON.stringify(past) })
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown }).toEqual({
      status: 413,
      body: {
        error: `content-frame: the read report route refuses a body past ${outlineChars * 4 + ENVELOPE_BYTES} bytes`,
      },
    })
  })

  it('takes a whole budget of any text a sanitized listing can be made of', async () => {
    // The shipped default rather than this suite's floor, because that is the
    // budget a deployment gets by writing `pageAccess: {}` and the one the byte
    // bound's promise is read against. Every filler here is a UTF-16 unit the
    // seat posts as it stands: three JSON bytes is the widest a character gets,
    // and a supplementary one costs two per unit.
    const ctx = await loadComposition(true, [], DEFAULT_OUTLINE_CHARS)
    for (const [name, filler] of [
      ['three-byte', '\u7532'],
      ['supplementary', String.fromCodePoint(0x1f600)],
      ['escaped', '\\'],
    ] as const) {
      const text = filler.repeat(DEFAULT_OUTLINE_CHARS / filler.length)
      const outcome = { ...LISTING, snapshot: { ...LISTING.snapshot, text } }
      const answer = await raw(ctx, CONTENT_REPORT_ROUTE, { body: JSON.stringify({ callId: 'c', tabId: TAB, outcome }) })
      expect({ name, units: text.length, status: answer.status })
        .toEqual({ name, units: DEFAULT_OUTLINE_CHARS, status: 200 })
    }
  })

  it('refuses a whole real listing the character bound alone would have taken', async () => {
    const ctx = await loadComposition(true, [], DEFAULT_OUTLINE_CHARS)
    // A listing of three-byte text well inside the parser's character bound of
    // four times the budget, and half again past the byte bound on the whole
    // body. The seat measures both before it posts, so no seat of this package
    // sends this; the route is the backstop under that, and it holds to the
    // byte.
    const text = '甲'.repeat(32696)
    const outcome = { ...LISTING, snapshot: { ...LISTING.snapshot, text } }
    const body = JSON.stringify({ callId: 'c', tabId: TAB, outcome })
    expect({
      chars: text.length,
      charBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
      parsed: parseChannelReport(JSON.parse(body), DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE, MAX_ACT_STEPS) !== undefined,
      bytes: new TextEncoder().encode(body).length,
      byteBound: DEFAULT_OUTLINE_CHARS * 4 + ENVELOPE_BYTES,
    }).toEqual({ chars: 32696, charBound: 48000, parsed: true, bytes: 98355, byteBound: 70528 })
    const refused = await raw(ctx, CONTENT_REPORT_ROUTE, { body })
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown }).toEqual({
      status: 413,
      body: {
        error: 'content-frame: the read report route refuses a body past '
          + `${DEFAULT_OUTLINE_CHARS * 4 + ENVELOPE_BYTES} bytes`,
      },
    })
  })

  it('takes a body that lands on its byte bound, and refuses the next byte', async () => {
    const ctx = await loadComposition(true, [], DEFAULT_OUTLINE_CHARS)
    const bound = DEFAULT_OUTLINE_CHARS * 4 + ENVELOPE_BYTES
    const bodyOf = (text: string): string =>
      JSON.stringify({ callId: 'c', tabId: TAB, outcome: { ...LISTING, snapshot: { ...LISTING.snapshot, text } } })
    // Three-byte characters up to the bound, then the same document with one
    // ASCII character more. The parser takes both listings — 23,421 and 23,422
    // characters against its own bound of 48,000 — so what tells the two
    // answers apart is the byte the body crossed and nothing else.
    const at = bodyOf(`${'甲'.repeat(23420)}x`)
    const past = bodyOf(`${'甲'.repeat(23420)}xx`)
    expect([new TextEncoder().encode(at).length, new TextEncoder().encode(past).length, bound])
      .toEqual([70528, 70529, 70528])
    const taken = await raw(ctx, CONTENT_REPORT_ROUTE, { body: at })
    expect({ status: taken.status, body: JSON.parse(taken.body) as unknown })
      .toEqual({ status: 200, body: { accepted: false } })
    const refused = await raw(ctx, CONTENT_REPORT_ROUTE, { body: past })
    expect({ status: refused.status, body: JSON.parse(refused.body) as unknown }).toEqual({
      status: 413,
      body: { error: `content-frame: the read report route refuses a body past ${bound} bytes` },
    })
    // A report the size a seat posts from a wide table of Chinese at this
    // budget, whose listing alone is 58,637 bytes — past the budget in bytes,
    // and served, because what both halves measure is the whole body.
    const seatSized = bodyOf(`${'甲'.repeat(19545)}xx`)
    expect(new TextEncoder().encode(seatSized).length).toBe(58904)
    expect((await raw(ctx, CONTENT_REPORT_ROUTE, { body: seatSized })).status).toBe(200)
  })

  it('refuses a listing made of what the seat removes, at whichever bound it reaches', async () => {
    const ctx = await loadComposition(true, [], DEFAULT_OUTLINE_CHARS)
    // Inside the byte bound and carrying control characters: the body arrives
    // in full, and what refuses it is the parser rather than its size.
    const some = { ...LISTING, snapshot: { ...LISTING.snapshot, text: `1 main${CONTROL.repeat(210)}` } }
    const shape = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome: some })
    expect({ status: shape.status, body: JSON.parse(shape.body) as unknown }).toEqual({
      status: 400,
      body: { error: 'content-frame: expected a JSON body with callId, tabId, and outcome' },
    })
    // The same listing without them is taken, so what refuses the one above is
    // the code point and not the length.
    const clean = { ...LISTING, snapshot: { ...LISTING.snapshot, text: '1 main' } }
    expect((await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome: clean })).status).toBe(200)
    // A whole budget of them costs six JSON bytes per unit against the four the
    // byte bound allows, so the read stops at the bound before any of that
    // reaches the parser. Neither answer is one a seat collects: it removes
    // these before posting.
    const all = { ...LISTING, snapshot: { ...LISTING.snapshot, text: CONTROL.repeat(DEFAULT_OUTLINE_CHARS) } }
    const size = await raw(ctx, CONTENT_REPORT_ROUTE, { body: JSON.stringify({ callId: 'c', tabId: TAB, outcome: all }) })
    expect({ status: size.status, body: JSON.parse(size.body) as unknown }).toEqual({
      status: 413,
      body: {
        error: 'content-frame: the read report route refuses a body past '
          + `${DEFAULT_OUTLINE_CHARS * 4 + ENVELOPE_BYTES} bytes`,
      },
    })
  })

  it('leaves the envelope more punctuation and key names than either form of a report writes', () => {
    // What the envelope's own syntax allowance is stated against: a listing
    // report with every string empty, and the union of that form's keys with a
    // failure's, which is what a bound covering both forms has to hold.
    const empty = {
      callId: '',
      tabId: '',
      outcome: {
        status: 'ok',
        page: { id: '', title: '' },
        snapshot: {
          kind: '', url: '', title: '', modal: '',
          signIn: false, text: '', truncated: false, shown: 123456789, total: 123456789, cursor: '',
          settled: false, busy: ['', '', ''],
        },
      },
    }
    const union = { ...empty, outcome: { ...empty.outcome, code: '', message: '', kind: '', title: '' } }
    // The two discriminants written as a real report writes them. Their values
    // sit in no per-field allowance of the envelope — it enumerates the address,
    // the header fields, the message, the names and the cursor — so the syntax
    // allowance is what has to hold them.
    const named = {
      ...union,
      outcome: { ...union.outcome, snapshot: { ...union.outcome.snapshot, kind: 'outline' }, code: 'not-a-page' },
    }
    expect([JSON.stringify(empty).length, JSON.stringify(union).length, JSON.stringify(named).length])
      .toEqual([257, 301, 318])
    expect(JSON.stringify(named).length).toBeLessThan(SYNTAX_BYTES)
  })

  it('takes a report at the parser\'s own character bounds, with room left over', async () => {
    const ctx = await loadComposition(true)
    // Three UTF-8 bytes is as wide as one character gets once the seat has
    // removed what costs more, and every string here is as long as the parser
    // takes — the listing at four times the budget, which is the widest one a
    // seat posts rather than reporting on. The two counters are not: `isCount`
    // bounds neither of them, so this is a report at the bounds that exist and
    // not the largest one the parser would pass. The envelope is sized to hold
    // it: the address alone is half again the whole envelope this route once
    // carried.
    const wide = (chars: number): string => '甲'.repeat(chars)
    const outcome: ReadOutcome = {
      status: 'ok',
      page: { id: wide(MAX_NAME_CHARS), title: wide(MAX_NAME_CHARS) },
      snapshot: {
        kind: 'outline',
        url: wide(MAX_URL_CHARS),
        title: wide(MAX_HEADER_CHARS),
        modal: wide(MAX_HEADER_CHARS),
        signIn: false,
        text: wide(OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE),
        truncated: true,
        shown: 1,
        total: 2,
        cursor: wide(MAX_CURSOR_CHARS),
        settled: false,
        busy: Array.from({ length: MAX_BUSY_NAMES }, () => wide(MAX_NAME_CHARS)),
      },
    }
    const body = JSON.stringify({ callId: wide(MAX_NAME_CHARS), tabId: wide(MAX_NAME_CHARS), outcome })
    // Written out because the margin is the claim: the widest report a seat can
    // post is thousands of bytes inside the bound, not at it.
    expect(new TextEncoder().encode(body).length).toBe(25063)
    expect(REPORT_BYTES).toBe(26528)
    const answer = await raw(ctx, CONTENT_REPORT_ROUTE, { body })
    expect({ status: answer.status, body: JSON.parse(answer.body) as unknown })
      .toEqual({ status: 200, body: { accepted: false } })
  })

  it('refuses a field one character past its bound, as a shape and not as a size', async () => {
    const ctx = await loadComposition(true)
    const shape = { error: 'content-frame: expected a JSON body with callId, tabId, and outcome' }
    for (const [field, over] of [
      ['url', { url: 'u'.repeat(MAX_URL_CHARS + 1) }],
      ['title', { title: 't'.repeat(MAX_HEADER_CHARS + 1) }],
      ['modal', { modal: 'm'.repeat(MAX_HEADER_CHARS + 1) }],
      ['cursor', { cursor: 'c'.repeat(MAX_CURSOR_CHARS + 1) }],
    ] as const) {
      const outcome = { ...LISTING, snapshot: { ...LISTING.snapshot, ...over } }
      const answer = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome })
      expect({ field, status: answer.status, body: JSON.parse(answer.body) as unknown })
        .toEqual({ field, status: 400, body: shape })
    }
    // The same body one character shorter is taken, so what refuses these is
    // the length and not the field.
    const inside = { ...LISTING, snapshot: { ...LISTING.snapshot, title: 't'.repeat(MAX_HEADER_CHARS) } }
    expect((await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'c', tabId: TAB, outcome: inside })).status).toBe(200)
  })

  it('states the complete method set each route serves', async () => {
    const ctx = await loadComposition(true)
    for (const route of [CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE]) {
      const answer = await call(ctx, route)
      // `no-store` with it: 405 is one of the statuses a cache may keep on its
      // own, and these routes serve request-local truth on every answer.
      expect({ route, status: answer.status, allow: answer.allow, cacheControl: answer.cacheControl })
        .toEqual({ route, status: 405, allow: 'POST', cacheControl: 'no-store' })
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

  it('tells a read the column is not empty, so the model stops reaching for content_show', async () => {
    // The wiring, over the real Loader: the tool reads this session's own
    // `contentSurface` value to decide which advice the timeout earns. A
    // recorded run without it spent ten calls showing a page that was already
    // in front, because the refusal named `content_show` first.
    const ctx = await loadComposition(true, [], OUTLINE_CHARS, [
      "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    ], 30)
    const session = hostSession(ctx)
    session.append('content/shown', { page: 'home', by: 'user' })
    const result = await startRead(ctx, session, 'call_front')
    expect({ isError: result.isError, text: textOf(result) }).toEqual({
      isError: true,
      text: 'Error: No open console is showing this session\'s content column (waited 0.03s); '
        + 'the page "Home" is already in front. '
        + 'Ask the user whether they have the console open on this session, then retry. '
        + 'content_show cannot help here.',
    })
  })

  it('offers content_show to a read whose column has nothing in it', async () => {
    // The same composition with nothing shown: an empty column is the one case
    // `content_show` does fix.
    const ctx = await loadComposition(true, [], OUTLINE_CHARS, [
      "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    ], 30)
    const result = await startRead(ctx, hostSession(ctx), 'call_empty')
    expect(textOf(result)).toBe(
      'Error: No open console is showing this session\'s content column (waited 0.03s). '
      + 'Call content_show to put a page there, or ask the user to open the console, then retry.',
    )
  })

  it('offers both tools only while a tool runtime is composed', async () => {
    const ctx = await loadComposition(true)
    expect(ctx.tools.schemas().map(schema => schema.name)).toEqual(
      expect.arrayContaining(['content_read', 'content_act']),
    )
  })

  it('refuses a posted report of steps the seat could not have written', async () => {
    // The same wire boundary the listing crosses, over the arm a set of steps
    // answers through: the route holds the step list to the deployment's own
    // bound and to one message, and refuses everything else as a shape.
    const ctx = await loadComposition(true)
    const steps = { index: 1, status: 'ok' }
    const act = {
      status: 'done',
      page: { id: 'home', title: 'Home' },
      title: 'Hosted content app',
      steps: [steps],
      text: 'Done 1/1 on Home: click "Go" (settled after 0.1s).',
      truncated: false,
    }
    for (const outcome of [
      { ...act, steps: [] },
      { ...act, steps: [{ index: 2, status: 'ok' }] },
      { ...act, steps: [{ index: 1, status: 'failed', message: 'a' }, { index: 2, status: 'failed', message: 'b' }] },
      { ...act, title: undefined },
      { ...act, truncated: 'no' },
    ]) {
      const answer = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'call_act', tabId: TAB, outcome })
      expect({ outcome, status: answer.status, body: JSON.parse(answer.body) as unknown }).toEqual({
        outcome,
        status: 400,
        body: { error: 'content-frame: expected a JSON body with callId, tabId, and outcome' },
      })
    }
    // And a well-formed one is a shape the route takes; no call is waiting for
    // it, which is the other half of the same answer.
    const taken = await postJson(ctx, CONTENT_REPORT_ROUTE, { callId: 'call_act', tabId: TAB, outcome: act })
    expect({ status: taken.status, body: JSON.parse(taken.body) as unknown })
      .toEqual({ status: 200, body: { accepted: false } })
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
    // The listing budget has a floor of its own: a listing's first row is
    // rendered however long it is, so a budget below it refuses reads of pages
    // that hold an ordinary table.
    for (const [field, least] of [
      ['claimTimeoutMs', 1],
      ['readTimeoutMs', 1],
      ['pinMs', 1],
      ['settleQuietMs', 1],
      ['outlineChars', MIN_OUTLINE_CHARS],
      ['actTimeoutMs', 1],
      ['maxSteps', 1],
    ] as const) {
      const config = {
        root: APP_ROOT,
        pages: [{ id: 'home', title: 'Home', description: 'Entry.', url: '/content-app/' }],
        pageAccess: {
          claimTimeoutMs: 1,
          // Above the quiet window this case configures below, so the one
          // refusal each iteration proves is the field it names.
          readTimeoutMs: 1000,
          pinMs: 1,
          settleQuietMs: 1,
          outlineChars: MIN_OUTLINE_CHARS,
          actTimeoutMs: 1000,
          maxSteps: 20,
          settleMaxMs: 1,
          [field]: least - 1,
        },
      }
      const ctx = new Context()
      ctx.provide('webServer', { register: () => () => {} } as never)
      await expect(ContentFrame.apply(ctx, config)).rejects.toThrow(
        `content-frame: pageAccess.${field} must be at least ${String(least)}, received ${String(least - 1)}`,
      )
      await ctx.fiber.dispose()
    }
  })

  it('rejects a step bound past what the report envelope covers', async () => {
    const ctx = new Context()
    ctx.provide('webServer', { register: () => () => {} } as never)
    await expect(ContentFrame.apply(ctx, {
      root: APP_ROOT,
      pages: [{ id: 'home', title: 'Home', description: 'Entry.', url: '/content-app/' }],
      pageAccess: {
        claimTimeoutMs: 1, readTimeoutMs: 1000, pinMs: 1, settleQuietMs: 1, outlineChars: MIN_OUTLINE_CHARS,
        actTimeoutMs: 1000, maxSteps: MAX_ACT_STEPS + 1, settleMaxMs: 1,
      },
    })).rejects.toThrow(`content-frame: pageAccess.maxSteps must be at most ${String(MAX_ACT_STEPS)}, received 101`)
    await ctx.fiber.dispose()
  })

  it('rejects a per-step settle ceiling the quiet window or the steps of one call cannot live with', async () => {
    // Every number is in this one block either way, so the mismatch is caught
    // at load rather than as every step ending its wait before it began, or as
    // a call that spends its whole deadline settling and never reaches its
    // last step.
    for (const [pageAccess, refusal] of [
      [
        { settleQuietMs: 250, settleMaxMs: 249 },
        'content-frame: pageAccess.settleMaxMs must be at least 250, received 249',
      ],
      [
        { settleQuietMs: 250, settleMaxMs: 1001, actTimeoutMs: 1000 },
        'content-frame: pageAccess.maxSteps 20 × settleMaxMs 1001ms = 20020ms must be under 750ms, '
        + 'which is 0.75 of pageAccess.actTimeoutMs 1000ms',
      ],
      [
        // And the ceiling that lands exactly on the share is refused with it:
        // a run whose steps could spend all of it leaves the closing read and
        // the trip back nothing.
        { settleQuietMs: 250, settleMaxMs: 375, actTimeoutMs: 1000, maxSteps: 2 },
        'content-frame: pageAccess.maxSteps 2 × settleMaxMs 375ms = 750ms must be under 750ms, '
        + 'which is 0.75 of pageAccess.actTimeoutMs 1000ms',
      ],
    ] as const) {
      const ctx = new Context()
      ctx.provide('webServer', { register: () => () => {} } as never)
      await expect(ContentFrame.apply(ctx, {
        root: APP_ROOT,
        pages: [{ id: 'home', title: 'Home', description: 'Entry.', url: '/content-app/' }],
        pageAccess: {
          claimTimeoutMs: 1, readTimeoutMs: 1000, pinMs: 1, outlineChars: MIN_OUTLINE_CHARS,
          actTimeoutMs: 1000, maxSteps: 20, ...pageAccess,
        },
      })).rejects.toThrow(refusal)
      await ctx.fiber.dispose()
    }
  })

  it('rejects a quiet window the settle budget cannot hold, and takes the one that lands on it', async () => {
    // Both numbers are in this one block, so the mismatch is caught at load
    // rather than as every read reporting a page that never settled.
    const over = new Context()
    over.provide('webServer', { register: () => () => {} } as never)
    await expect(ContentFrame.apply(over, {
      root: APP_ROOT,
      pages: [{ id: 'home', title: 'Home', description: 'Entry.', url: '/content-app/' }],
      pageAccess: {
        claimTimeoutMs: 1, readTimeoutMs: 1000, pinMs: 1, settleQuietMs: 251, outlineChars: MIN_OUTLINE_CHARS,
        actTimeoutMs: 60000, maxSteps: 20, settleMaxMs: 251,
      },
    })).rejects.toThrow(
      'content-frame: pageAccess.settleQuietMs must fit in 250ms (0.25 of readTimeoutMs), received 251',
    )
    await over.fiber.dispose()

    // And the window that lands exactly on the share is a composition that
    // boots, checked where every other composition here is checked.
    await expect(loadComposition(true, ['      settleQuietMs: 1250'])).resolves.toBeInstanceOf(Context)
  })
})
