/** Exact Fetch routes and non-owner Peers: only a route's own access rule lets one through. */
import { request as httpRequest } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_PATH, apply, inject, type PeerScope } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the exact-route access specs. */
    'connection-route-member': { readonly kind: 'connection-route-member'; readonly member: string }
  }
}

const OPEN_ROUTE = `${API_PATH}/route.open`
const RULED_ROUTE = `${API_PATH}/route.ruled`

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

interface Mounted {
  readonly ctx: Context
  readonly owned: ReturnType<typeof vi.fn<(request: Request) => Promise<Response>>>
  readonly ruled: ReturnType<typeof vi.fn<(request: Request, peer: PeerScope) => Promise<Response>>>
}

async function mount(): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...inject], apply })
  const owned = vi.fn((request: Request) => Promise.resolve(new Response(`owner ${new URL(request.url).pathname}`)))
  // A rule that admits only alice, as a route would after asking remote access.
  const ruled = vi.fn((_request: Request, peer: PeerScope) => Promise.resolve(
    Reflect.get(peer.principal, 'member') === 'alice' ? new Response('member') : new Response('forbidden', { status: 403 }),
  ))
  ctx.connection.fetch.register({ path: OPEN_ROUTE, methods: ['GET'], requestBody: 'buffered', fetch: owned })
  ctx.connection.fetch.register({ path: RULED_ROUTE, methods: ['GET', 'POST'], requestBody: 'streaming', fetch: owned, serveNonOwner: ruled })
  return { ctx, owned, ruled }
}

function member(ctx: Context, name: string): PeerScope {
  return ctx.connection.createPeer({ principal: { kind: 'connection-route-member', member: name } })
}

async function fetchAs(ctx: Context, path: string, peer: PeerScope): Promise<{ readonly status: number; readonly text: string }> {
  const response = await ctx.connection.createSharedFetchHandler(API_PATH).fetch(new Request(`http://host${path}`), peer)
  return { status: response.status, text: await response.text() }
}

describe('exact Fetch routes for non-owner Peers', () => {
  it('answers 403 to a non-owner Peer on a route that declares no rule, and serves the owner as before', async () => {
    const { ctx, owned, ruled } = await mount()
    expect(await fetchAs(ctx, OPEN_ROUTE, member(ctx, 'alice'))).toEqual({ status: 403, text: 'forbidden' })
    expect(owned).not.toHaveBeenCalled()
    expect(await fetchAs(ctx, OPEN_ROUTE, ctx.connection.browserPeer)).toEqual({ status: 200, text: `owner ${OPEN_ROUTE}` })
    expect(await fetchAs(ctx, RULED_ROUTE, ctx.connection.browserPeer)).toEqual({ status: 200, text: `owner ${RULED_ROUTE}` })
    expect(ruled).not.toHaveBeenCalled()
  })

  it('hands a live non-owner Peer to the route\'s own rule, whose answer the caller receives', async () => {
    const { ctx, owned, ruled } = await mount()
    const alice = member(ctx, 'alice')
    expect(await fetchAs(ctx, RULED_ROUTE, alice)).toEqual({ status: 200, text: 'member' })
    expect(ruled).toHaveBeenCalledOnce()
    expect(ruled.mock.calls[0]![1]).toBe(alice)
    expect(await fetchAs(ctx, RULED_ROUTE, member(ctx, 'bob'))).toEqual({ status: 403, text: 'forbidden' })
    expect(owned).not.toHaveBeenCalled()
  })

  it('answers 401 to a disposed non-owner Peer without running the rule', async () => {
    const { ctx, ruled } = await mount()
    const alice = member(ctx, 'alice')
    await alice.dispose()
    expect(await fetchAs(ctx, RULED_ROUTE, alice)).toEqual({ status: 401, text: 'unauthorized' })
    expect(await fetchAs(ctx, OPEN_ROUTE, alice)).toEqual({ status: 403, text: 'forbidden' })
    expect(ruled).not.toHaveBeenCalled()
  })

  it('hands the Peer an admitter returned to the rule over HTTP', async () => {
    const { ctx, owned, ruled } = await mount()
    const alice = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => alice)
    const target = new URL(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`))
    let setCookie: string | undefined
    ctx.connection.authorizeIndex(
      { method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } },
      { writeHead(_status, headers) { setCookie = headers?.['set-cookie'] }, end() {} },
    )
    const cookie = setCookie!.split(';', 1)[0]!
    const status = (path: string, method: string): Promise<number> => new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: ctx.webServer.port, path, method, headers: { cookie } }, (response) => {
        response.resume()
        response.on('end', () => { resolve(response.statusCode ?? 0) })
      })
      request.on('error', reject)
      request.end(method === 'POST' ? 'streamed body' : undefined)
    })
    expect(await status(RULED_ROUTE, 'POST')).toBe(200)
    expect(await status(OPEN_ROUTE, 'GET')).toBe(403)
    expect(ruled).toHaveBeenCalledOnce()
    expect(ruled.mock.calls[0]![1]).toBe(alice)
    expect(owned).not.toHaveBeenCalled()
  })
})
