/**
 * REAL-composition coverage for this package's node half: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver and the
 * auth-gate row, a fixture HTTP server stands in for the MCP upstream, and
 * every assertion observes the served HTTP surface — the settings document, the
 * token route's refusals and the one body it takes, the header the forwarding
 * route injects and the ones it drops, the answer while no token is held, an
 * event stream arriving incrementally, and route release on fiber disposal.
 *
 * The configuration cases call `apply` and the pure resolvers directly: a
 * rejected configuration never reaches a served surface, so there is nothing
 * for HTTP to observe.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as AuthGate from '../src/index.ts'
import { requesterFor, resolveUpstreams, upstreamUrlFor } from '../src/proxy.ts'
import { AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, isJwtShaped, parseTokenPost } from '../src/route.ts'

/** A JWT-shaped token; nothing in the node half reads its claims. */
const TOKEN = 'aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'
const OTHER_TOKEN = 'aGVhZGVy.eyJzdWIiOiJ1LTIifQ.c2ln'
const MCP_ROUTE = '/auth-gate/mcp/fixture'

let world: string | undefined
let context: Context | undefined
let upstream: FixtureUpstream | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await upstream?.close()
  upstream = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** One request the fixture upstream received. */
interface SeenRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
}

/** The MCP server this package forwards to, standing in for a real one. */
interface FixtureUpstream {
  /** Origin the proxy is configured against. */
  origin: string
  /** Every request that reached it, in arrival order. */
  seen: SeenRequest[]
  /** Release the first event-stream chunk's successor. */
  releaseStream(): void
  close(): Promise<void>
}

/**
 * Start the fixture upstream.
 *
 * `/mcp` answers JSON. `/stream` answers an event stream whose second chunk
 * waits for the spec to release it, which is how "the answer arrives
 * incrementally" is observable at all. `/truncate` answers a head and one chunk
 * and then drops the socket.
 * @returns the running fixture.
 */
async function startUpstream(): Promise<FixtureUpstream> {
  const seen: SeenRequest[] = []
  let release = (): void => {}
  const pending = new Promise<void>((resolve) => { release = resolve })
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers })
    if (req.url?.startsWith('/stream') === true) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      res.write('data: first\n\n')
      void pending.then(() => {
        res.write('data: second\n\n')
        res.end()
      })
      return
    }
    if (req.url?.startsWith('/truncate') === true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      // The drop has to follow the head across the wire, or the proxy would
      // still be free to answer with a status of its own.
      res.write('{"partial"', () => { setTimeout(() => res.socket?.destroy(), 20) })
      return
    }
    // Everything else reads the body, so a forwarded POST body is observable.
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ saw: Buffer.concat(chunks).toString('utf8') }))
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    releaseStream: () => { release() },
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/** Write a two-row cordis.yml and boot it through the real Loader. */
async function loadComposition(upstreams: Record<string, string> = {}): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-auth-gate-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: auth-gate',
    "  name: '@deepseek-ai/dsh-experimental-auth-gate'",
    '  config:',
    "    loginUrl: '/toy-proxy/toy-login/#/'",
    '    cookieName: accessToken',
    '    refreshMarginSeconds: 300',
    '    mcpUpstreams:',
    ...Object.entries(upstreams).map(([name, url]) => `      ${name}: '${url}'`),
    ...Object.keys(upstreams).length === 0 ? ['      {}'] : [],
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-experimental-auth-gate', AuthGate],
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

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  allow: string | null
  cacheControl: string | null
  body: string
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

/** POST one token document. */
function postToken(ctx: Context, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return call(ctx, AUTH_GATE_TOKEN_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

describe('auth-gate settings route', () => {
  it('serves the browser half the three values its gate must obey', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, AUTH_GATE_SETTINGS_ROUTE)
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({
      loginUrl: '/toy-proxy/toy-login/#/',
      cookieName: 'accessToken',
      refreshMarginSeconds: 300,
    })
    // Read once per boot from the row that booted; a cached copy would outlive
    // its own truth.
    expect(answer.cacheControl).toBe('no-store')
  })

  it('serves a HEAD of the settings document and refuses other methods', async () => {
    const ctx = await loadComposition()
    expect((await call(ctx, AUTH_GATE_SETTINGS_ROUTE, { method: 'HEAD' })).status).toBe(200)
    const refused = await call(ctx, AUTH_GATE_SETTINGS_ROUTE, { method: 'POST' })
    expect({ status: refused.status, allow: refused.allow }).toEqual({ status: 405, allow: 'GET, HEAD' })
  })
})

describe('auth-gate token route', () => {
  it('takes a JWT-shaped token and answers with no body of its own', async () => {
    const ctx = await loadComposition()
    const answer = await postToken(ctx, { token: TOKEN })
    expect({ status: answer.status, body: answer.body }).toEqual({ status: 204, body: '' })
  })

  it('refuses a body that does not carry a JWT', async () => {
    const ctx = await loadComposition()
    for (const body of [
      'not json at all',
      JSON.stringify('a string'),
      JSON.stringify({}),
      JSON.stringify({ token: '' }),
      JSON.stringify({ token: 'two.segments' }),
      JSON.stringify({ token: 'has spaces.in.it' }),
      JSON.stringify({ token: 7 }),
    ]) {
      const answer = await postToken(ctx, body)
      expect({ body, status: answer.status }).toEqual({ body, status: 400 })
      expect(JSON.parse(answer.body))
        .toEqual({ error: 'auth-gate: expected a JSON body whose "token" field is a JWT' })
    }
  })

  it('names nothing that was posted in its refusal', async () => {
    const ctx = await loadComposition()
    // A refusal quoting the body would put a near-miss credential wherever the
    // response is logged.
    const answer = await postToken(ctx, { token: `${TOKEN} ` })
    expect(answer.body).not.toContain('eyJzdWIi')
  })

  it('refuses a token a browser labelled cross-site', async () => {
    const ctx = await loadComposition()
    const answer = await postToken(ctx, { token: TOKEN }, { 'sec-fetch-site': 'cross-site' })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'auth-gate: the token route serves same-site requests only' })
  })

  it('takes a token a browser labelled same-origin', async () => {
    const ctx = await loadComposition()
    expect((await postToken(ctx, { token: TOKEN }, { 'sec-fetch-site': 'same-origin' })).status).toBe(204)
  })

  it('refuses a token that is not sent as JSON', async () => {
    const ctx = await loadComposition()
    // `text/plain` is the CORS-simple content type a cross-origin page can post
    // without a preflight; a request carrying none at all is refused the same way.
    for (const headers of [{ 'content-type': 'text/plain;charset=UTF-8' }, {}]) {
      const answer = await call(ctx, AUTH_GATE_TOKEN_ROUTE, {
        method: 'POST', headers, body: JSON.stringify({ token: TOKEN }),
      })
      expect(answer.status).toBe(415)
      expect(JSON.parse(answer.body)).toEqual({ error: 'auth-gate: the token route accepts application/json only' })
    }
  })

  it('refuses a body past the bound instead of buffering it', async () => {
    const ctx = await loadComposition()
    const answer = await postToken(ctx, { token: `${TOKEN}${'A'.repeat(16 * 1024)}` })
    expect(answer.status).toBe(400)
  })

  it('states the complete method set it serves', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, AUTH_GATE_TOKEN_ROUTE)
    expect({ status: answer.status, allow: answer.allow }).toEqual({ status: 405, allow: 'POST' })
  })
})

describe('auth-gate MCP forwarding', () => {
  /** Boot a composition whose one upstream is the fixture, optionally holding a token. */
  async function forwarding(token?: string): Promise<Context> {
    upstream = await startUpstream()
    const ctx = await loadComposition({ fixture: `${upstream.origin}/mcp` })
    if (token !== undefined) await postToken(ctx, { token })
    return ctx
  }

  it('answers 503 while no browser has handed over a token', async () => {
    const ctx = await forwarding()
    const answer = await call(ctx, MCP_ROUTE, { method: 'POST', body: '{}' })
    expect(answer.status).toBe(503)
    expect(JSON.parse(answer.body)).toEqual({
      error: 'auth-gate: no access token is held yet, so the "fixture" upstream cannot be reached',
    })
    expect(upstream?.seen).toEqual([])
  })

  it('forwards the request with the held token as a bearer credential', async () => {
    const ctx = await forwarding(TOKEN)
    const answer = await call(ctx, MCP_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: '{"jsonrpc":"2.0"}',
    })
    expect(answer.status).toBe(200)
    expect(JSON.parse(answer.body)).toEqual({ saw: '{"jsonrpc":"2.0"}' })
    const seen = upstream?.seen[0]
    expect(seen?.method).toBe('POST')
    expect(seen?.url).toBe('/mcp')
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    // The transport's own headers survive the hop.
    expect(seen?.headers.accept).toBe('application/json, text/event-stream')
  })

  it('spends the newest token a browser handed over', async () => {
    const ctx = await forwarding(TOKEN)
    await postToken(ctx, { token: OTHER_TOKEN })
    await call(ctx, MCP_ROUTE, { method: 'POST', body: '{}' })
    expect(upstream?.seen[0]?.headers.authorization).toBe(`Bearer ${OTHER_TOKEN}`)
  })

  it('replaces a caller\'s own credential rather than passing it through, and drops the cookie jar', async () => {
    const ctx = await forwarding(TOKEN)
    await call(ctx, MCP_ROUTE, {
      method: 'POST',
      headers: { authorization: 'Bearer smuggled', cookie: `accessToken=${TOKEN}` },
      body: '{}',
    })
    const seen = upstream?.seen[0]
    expect(seen?.headers.authorization).toBe(`Bearer ${TOKEN}`)
    // The mirror cookie carries the very same credential; an upstream has no
    // business receiving the browser's jar.
    expect(seen?.headers.cookie).toBeUndefined()
  })

  it('carries the path past the route and the query string upstream', async () => {
    const ctx = await forwarding(TOKEN)
    await call(ctx, `${MCP_ROUTE}/messages?sessionId=abc`, { method: 'POST', body: '{}' })
    expect(upstream?.seen[0]?.url).toBe('/mcp/messages?sessionId=abc')
  })

  it('refuses a forward a browser labelled cross-site before spending the token', async () => {
    const ctx = await forwarding(TOKEN)
    const answer = await call(ctx, MCP_ROUTE, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' }, body: '{}' })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body))
      .toEqual({ error: 'auth-gate: the "fixture" forwarding route serves same-site requests only' })
    expect(upstream?.seen).toEqual([])
  })

  it('relays an event stream incrementally rather than after it ends', async () => {
    upstream = await startUpstream()
    const ctx = await loadComposition({ fixture: `${upstream.origin}/stream` })
    await postToken(ctx, { token: TOKEN })
    const response = await fetch(`${origin(ctx)}${MCP_ROUTE}`, { headers: { accept: 'text/event-stream' } })
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    // The upstream is holding the second chunk, so a first chunk arriving here
    // is the whole proof: a buffering relay could not produce one.
    expect(decoder.decode((await reader.read()).value)).toBe('data: first\n\n')
    upstream.releaseStream()
    expect(decoder.decode((await reader.read()).value)).toBe('data: second\n\n')
    expect((await reader.read()).done).toBe(true)
  })

  it('answers 502 when the upstream cannot be reached', async () => {
    upstream = await startUpstream()
    const unreachable = upstream.origin
    await upstream.close()
    upstream = undefined
    const ctx = await loadComposition({ fixture: `${unreachable}/mcp` })
    await postToken(ctx, { token: TOKEN })
    const answer = await call(ctx, MCP_ROUTE, { method: 'POST', body: '{}' })
    expect(answer.status).toBe(502)
    expect(JSON.parse(answer.body)).toEqual({ error: 'auth-gate: forwarding to the "fixture" upstream failed' })
  })

  it('truncates the answer when the upstream drops mid-body', async () => {
    upstream = await startUpstream()
    const ctx = await loadComposition({ fixture: `${upstream.origin}/truncate` })
    await postToken(ctx, { token: TOKEN })
    // The status was already sent, so there is no 502 left to give: the only
    // honest report is a body that ends early.
    await expect(call(ctx, MCP_ROUTE, { method: 'POST', body: '{}' })).rejects.toThrow()
  })

  it('stops the upstream request when the caller walks away', async () => {
    upstream = await startUpstream()
    const ctx = await loadComposition({ fixture: `${upstream.origin}/stream` })
    await postToken(ctx, { token: TOKEN })
    const aborter = new AbortController()
    const response = await fetch(`${origin(ctx)}${MCP_ROUTE}`, { signal: aborter.signal })
    await response.body!.getReader().read()
    aborter.abort()
    // Releasing the held chunk now writes into a socket nobody is reading; the
    // fixture must be able to shut down without waiting on it.
    upstream.releaseStream()
  })

  it('releases every route when the fiber disposes (HMR safety)', async () => {
    const ctx = await forwarding(TOKEN)
    const base = origin(ctx)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'auth-gate')
    await row?.fiber?.dispose()
    for (const path of [AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, MCP_ROUTE]) {
      // The webserver's own fallback answers a path nobody claims.
      const answer = await fetch(`${base}${path}`)
      expect({ path, status: answer.status }).toEqual({ path, status: 404 })
      await answer.arrayBuffer()
    }
  })
})

describe('auth-gate configuration', () => {
  /** Apply the plugin against a webServer that only records what it claimed. */
  function claimedRoutes(config: AuthGate.Config): string[] {
    const claimed: string[] = []
    const ctx = new Context()
    ctx.provide('webServer', {
      register: (route: { path: string }) => {
        claimed.push(route.path)
        return () => {}
      },
    } as never)
    AuthGate.apply(ctx, config)
    return claimed
  }

  /**
   * One configuration, with the fields a case varies stated and the rest at the
   * values a working deployment has.
   * @param fields - the values this case is about.
   * @returns the complete configuration to apply.
   */
  function gateConfig(fields: {
    loginUrl?: string
    cookieName?: string
    mcpUpstreams?: Record<string, string>
  } = {}): AuthGate.Config {
    return {
      loginUrl: fields.loginUrl ?? '/toy-proxy/toy-login/#/',
      cookieName: fields.cookieName ?? 'accessToken',
      refreshMarginSeconds: 300,
      mcpUpstreams: fields.mcpUpstreams ?? {},
    }
  }

  it('claims one forwarding route per configured upstream, under its own name', () => {
    expect(claimedRoutes(gateConfig({ mcpUpstreams: { crm: 'https://mcp.internal/crm', docs: 'http://docs.internal' } })))
      .toEqual([AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, '/auth-gate/mcp/crm', '/auth-gate/mcp/docs'])
  })

  it('rejects a login destination the browser half cannot build a redirect from', () => {
    expect(() => claimedRoutes(gateConfig({ loginUrl: '' }))).toThrow('auth-gate: loginUrl must not be empty')
    expect(() => claimedRoutes(gateConfig({ loginUrl: '/login?next=1' })))
      .toThrow('auth-gate: loginUrl must carry no query string, received "/login?next=1"')
  })

  it('rejects a cookie name that cannot be written as one', () => {
    for (const cookieName of ['', 'has space', 'has=equals', 'has;semicolon']) {
      expect(() => claimedRoutes(gateConfig({ cookieName })))
        .toThrow(`auth-gate: cookieName must be a bare cookie name, received "${cookieName}"`)
    }
  })

  it('rejects an upstream table it could not route or reach', () => {
    for (const [table, message] of [
      [{ 'has/slash': 'http://x' }, 'auth-gate: mcpUpstreams name "has/slash" must be a plain route segment'],
      [{ crm: '/relative' }, 'auth-gate: mcpUpstreams["crm"] must be an absolute URL, received "/relative"'],
      [{ crm: 'ftp://x/y' }, 'auth-gate: mcpUpstreams["crm"] must be an http or https URL, received "ftp://x/y"'],
      [
        { crm: 'http://x/y?a=1' },
        'auth-gate: mcpUpstreams["crm"] must carry no query string or fragment, received "http://x/y?a=1"',
      ],
    ] as const) {
      expect(() => resolveUpstreams(table)).toThrow(message)
    }
  })

  it('picks the transport each upstream\'s scheme needs', () => {
    expect(requesterFor(new URL('https://mcp.internal/crm'))).toBe(httpsRequest)
    expect(requesterFor(new URL('http://mcp.internal/crm'))).toBe(httpRequest)
  })

  it('maps a request onto its upstream path', () => {
    const [only] = resolveUpstreams({ fixture: 'http://mcp.internal/mcp/' })
    expect(upstreamUrlFor(only!, MCP_ROUTE, `${MCP_ROUTE}/messages?a=1`).href)
      .toBe('http://mcp.internal/mcp/messages?a=1')
    expect(upstreamUrlFor(only!, MCP_ROUTE, MCP_ROUTE).href).toBe('http://mcp.internal/mcp')
  })
})

describe('auth-gate token document', () => {
  it('accepts exactly the three-segment base64url form', () => {
    expect(isJwtShaped(TOKEN)).toBe(true)
    for (const value of [undefined, null, 7, '', 'a.b', 'a.b.c.d', 'a..c', 'a.b.c=']) {
      expect({ value, shaped: isJwtShaped(value) }).toEqual({ value, shaped: false })
    }
  })

  it('reads the token out of a well-formed document only', () => {
    expect(parseTokenPost({ token: TOKEN })).toBe(TOKEN)
    for (const body of [null, undefined, 'a string', 7, {}, { token: 'nope' }]) {
      expect(parseTokenPost(body)).toBeUndefined()
    }
  })
})
