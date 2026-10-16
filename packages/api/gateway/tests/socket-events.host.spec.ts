/** Peer admission through the assembled Host: socket lifecycle events, the admitter on every credential, and fail-closed admission. */
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { Context, type Fiber } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { apply as applyConnection, inject as connectionInject, type ConnectionConfig } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { Remote, TypertRemoteService, type PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import TypertGatewayService, { type RemoteSocketId } from '../src/index.ts'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface PrincipalMap {
    /** Test-only non-owner caller of the Gateway Peer-admission specs. */
    'gateway-socket-member': { readonly kind: 'gateway-socket-member'; readonly member: string }
  }
}

interface SocketEvent {
  readonly kind: 'opened' | 'closed'
  readonly peer: PeerScope
  readonly socketId: RemoteSocketId
}

interface Mounted {
  readonly ctx: Context
  /** The Gateway plugin's fiber, disposed to unload the Gateway alone. */
  readonly gateway: Fiber
  readonly events: SocketEvent[]
  /** `error`-level log lines written while the root is mounted. */
  readonly errors: string[]
  /** Resolve once `events` holds at least `count` entries. */
  readonly eventCount: (count: number) => Promise<void>
}

/** Answers with the principal kind of the Peer the call speaks for. */
class PeerProbe extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'peerProbe')
  }

  @Remote
  whoami(): string {
    return this.ctx.invocation?.peer.principal.kind ?? 'none'
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(config?: ConnectionConfig): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  const errors: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'error') errors.push(String(message.args[0])) },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  const gateway = ctx.plugin(TypertGatewayService, {})
  await gateway
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection }, config)
  await ctx.plugin(PeerProbe)
  ctx.remoteAccess.registerPolicy('gateway-socket-member', {
    bindings: () => [{ role: { name: 'probe', resource: 'global', actions: ['peerProbe/whoami'] }, resource: { kind: 'global' } }],
  })
  const events: SocketEvent[] = []
  const waiters: Array<{ readonly count: number; readonly resolve: () => void }> = []
  const record = (event: SocketEvent): void => {
    events.push(event)
    for (const waiter of waiters.filter(candidate => candidate.count <= events.length)) {
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve()
    }
  }
  ctx.on('remote-stream/socket-opened', (peer, socketId) => { record({ kind: 'opened', peer, socketId }) })
  ctx.on('remote-stream/socket-closed', (peer, socketId) => { record({ kind: 'closed', peer, socketId }) })
  const eventCount = (count: number): Promise<void> => {
    if (events.length >= count) return Promise.resolve()
    return new Promise((resolve) => { waiters.push({ count, resolve }) })
  }
  return { ctx, gateway, events, errors, eventCount }
}

function connect(ctx: Context, cookie = browserCookie(ctx)): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, { headers: { cookie } })
}

/** Open a socket the Host refuses at upgrade; returns the HTTP status. */
async function refusedUpgrade(ctx: Context, cookie?: string): Promise<number> {
  const client = connect(ctx, cookie)
  const responseEvent: unknown[] = await once(client, 'unexpected-response')
  const rejected = responseEvent[1] as { statusCode?: number; resume(): void }
  rejected.resume()
  ;(responseEvent[0] as { abort(): void }).abort()
  return rejected.statusCode ?? 0
}

function send(
  ctx: Context,
  path: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ readonly status: number; readonly text: string; readonly setCookie: readonly string[] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port: ctx.webServer.port, path, method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => {
        resolve({
          status: response.statusCode ?? 0,
          text: Buffer.concat(chunks).toString('utf8'),
          setCookie: response.headers['set-cookie'] ?? [],
        })
      })
    })
    request.on('error', reject)
    request.end(body)
  })
}

/** Call `peerProbe/whoami` over the `/api` carrier; returns the HTTP status and the principal kind on success. */
async function whoami(ctx: Context, cookie: string): Promise<{ readonly status: number; readonly kind?: string }> {
  const response = await send(ctx, '/api/peerProbe/whoami', 'POST', { cookie, 'content-type': 'application/json' }, JSON.stringify({
    type: 'client-request', rpcId: 'whoami', method: 'peerProbe/whoami', payload: { args: {} },
  }))
  if (response.status !== 200) return { status: response.status }
  const body = JSON.parse(response.text) as { result: { ok: boolean; value?: string } }
  return body.result.ok ? { status: 200, kind: body.result.value as string } : { status: 200 }
}

/** Exchange the process launch token at `/connect` for an API Cookie header, as an API caller does. */
async function apiCookie(ctx: Context): Promise<string> {
  const target = new URL(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}/connect`))
  const connected = await send(ctx, `${target.pathname}${target.search}`, 'GET', {})
  expect(connected.status).toBe(302)
  const cookie = connected.setCookie[0]?.split(';', 1)[0]
  if (cookie === undefined) throw new Error('socket-events fixture did not receive an API cookie')
  return cookie
}

function member(ctx: Context, name: string): PeerScope {
  return ctx.connection.createPeer({ principal: { kind: 'gateway-socket-member', member: name } })
}

describe('Remote stream socket events', () => {
  it('announces a socket admitted as browserPeer and its close by the Client', async () => {
    const { ctx, events, eventCount } = await mount()
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    expect(events).toEqual([{ kind: 'opened', peer: ctx.connection.browserPeer, socketId: events[0]!.socketId }])

    client.close()
    await eventCount(2)
    expect(events[1]).toEqual({ kind: 'closed', peer: ctx.connection.browserPeer, socketId: events[0]!.socketId })
  })

  it('announces the admitted member Peer and a distinct id per socket', async () => {
    const { ctx, events, eventCount } = await mount()
    const alice = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => alice)
    const first = connect(ctx)
    await once(first, 'open')
    await eventCount(1)
    const second = connect(ctx)
    await once(second, 'open')
    await eventCount(2)
    expect(events.map(event => [event.kind, event.peer])).toEqual([['opened', alice], ['opened', alice]])
    expect(events[0]!.socketId).not.toBe(events[1]!.socketId)

    second.close()
    await eventCount(3)
    expect(events[2]).toEqual({ kind: 'closed', peer: alice, socketId: events[1]!.socketId })
    first.close()
    await eventCount(4)
    expect(events[3]).toEqual({ kind: 'closed', peer: alice, socketId: events[0]!.socketId })
  })

  it('closes the socket with 1001 and announces it when the member Peer is disposed', async () => {
    const { ctx, events, eventCount } = await mount()
    const alice = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => alice)
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)

    const closed = once(client, 'close')
    await alice.dispose()
    const closeEvent: unknown[] = await closed
    expect(closeEvent[0]).toBe(1001)
    await eventCount(2)
    expect(events).toEqual([
      { kind: 'opened', peer: alice, socketId: events[0]!.socketId },
      { kind: 'closed', peer: alice, socketId: events[0]!.socketId },
    ])
  })

  it('announces socket-closed only after the socket has released its binding to the Peer', async () => {
    const { ctx, eventCount } = await mount()
    const alice = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => alice)
    const holdsBinding = (peer: PeerScope): boolean =>
      peer.ctx.fiber.getEffects().some(effect => effect.label === 'api-gateway: Remote stream socket bound to its Peer')
    const bound: boolean[] = []
    ctx.on('remote-stream/socket-opened', (peer) => { bound.push(holdsBinding(peer)) })
    ctx.on('remote-stream/socket-closed', (peer) => { bound.push(holdsBinding(peer)) })
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    client.close()
    await eventCount(2)
    expect(bound).toEqual([true, false])
  })

  it('announces socket-closed for every open socket when the Gateway unloads', async () => {
    const { ctx, gateway, events, eventCount } = await mount()
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    const closed = once(client, 'close')
    await gateway.dispose()
    await closed
    await eventCount(2)
    expect(events).toEqual([
      { kind: 'opened', peer: ctx.connection.browserPeer, socketId: events[0]!.socketId },
      { kind: 'closed', peer: ctx.connection.browserPeer, socketId: events[0]!.socketId },
    ])
  })

  it('refuses the upgrade without announcing a socket when the admitter names no Peer', async () => {
    const { ctx, events } = await mount()
    ctx.connection.peers.admitWith(() => undefined)
    expect(await refusedUpgrade(ctx)).toBe(401)
    expect(events).toEqual([])
  })

  it('refuses the upgrade with 401 without announcing a socket when the admitter throws', async () => {
    const { ctx, events, errors } = await mount()
    const cookie = browserCookie(ctx)
    ctx.connection.peers.admitWith(() => { throw new Error(`admitter failed on ${cookie}`) })
    expect(await refusedUpgrade(ctx, cookie)).toBe(401)
    expect(events).toEqual([])
    expect(errors).toEqual(['client-connection: the Peer admitter threw Error; refusing the request with 401'])
  })

  it('logs a throwing socket listener and keeps serving the socket', async () => {
    const { ctx, events, errors, eventCount } = await mount()
    ctx.on('remote-stream/socket-opened', () => { throw new Error('fixture opened listener') })
    ctx.on('remote-stream/socket-closed', () => { throw new Error('fixture closed listener') })
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    expect(errors).toEqual(['api-gateway: a remote-stream/socket-opened listener threw'])

    client.ping()
    await once(client, 'pong')
    expect(client.readyState).toBe(WebSocket.OPEN)
    client.close()
    await eventCount(2)
    expect(events.map(event => event.kind)).toEqual(['opened', 'closed'])
    expect(errors).toEqual([
      'api-gateway: a remote-stream/socket-opened listener threw',
      'api-gateway: a remote-stream/socket-closed listener threw',
    ])
  })
})

describe('Peer admission through the assembled Host', () => {
  it('admits no owner through the API Cookie that /connect exchanged for a valid launch token once an admitter refuses', async () => {
    const { ctx, events } = await mount()
    const cookie = await apiCookie(ctx)
    expect(await whoami(ctx, cookie)).toEqual({ status: 200, kind: 'owner' })

    const remove = ctx.connection.peers.admitWith(() => 401)
    const fresh = await apiCookie(ctx)
    for (const credential of [cookie, fresh, browserCookie(ctx)]) {
      expect(await whoami(ctx, credential)).toEqual({ status: 401 })
      expect(await refusedUpgrade(ctx, credential)).toBe(401)
    }
    expect(events).toEqual([])

    await remove()
    const alice = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => alice)
    expect(await whoami(ctx, fresh)).toEqual({ status: 200, kind: 'gateway-socket-member' })
    const client = connect(ctx, fresh)
    await once(client, 'open')
    await expect.poll(() => events.length).toBe(1)
    expect(events[0]).toMatchObject({ kind: 'opened', peer: alice })
    expect(events[0]!.peer.principal).toEqual({ kind: 'gateway-socket-member', member: 'alice' })
    client.close()
  })

  it('ends the API Cookie a member socket presents when that socket closes or its member Peer is disposed', async () => {
    const { ctx, eventCount } = await mount({ requireAdmitter: true })
    let current = member(ctx, 'alice')
    ctx.connection.peers.admitWith(() => current)

    const closedByClient = await apiCookie(ctx)
    const first = connect(ctx, closedByClient)
    await once(first, 'open')
    await eventCount(1)
    expect(await refusedUpgrade(ctx, closedByClient)).toBe(409)
    expect(await whoami(ctx, closedByClient)).toEqual({ status: 200, kind: 'gateway-socket-member' })
    first.close()
    await eventCount(2)
    await expect.poll(async () => (await whoami(ctx, closedByClient)).status).toBe(401)

    const closedByDisposal = await apiCookie(ctx)
    const second = connect(ctx, closedByDisposal)
    await once(second, 'open')
    await eventCount(3)
    const alice = current
    current = member(ctx, 'bob')
    const closed = once(second, 'close')
    await alice.dispose()
    expect((await closed)[0]).toBe(1001)
    await eventCount(4)
    // bob would answer for any credential Connection still held.
    await expect.poll(async () => (await whoami(ctx, closedByDisposal)).status).toBe(401)
  })

  it('refuses every authenticated call and upgrade while requireAdmitter is set and no admitter is installed', async () => {
    const { ctx, events, eventCount } = await mount({ requireAdmitter: true })
    const cookie = await apiCookie(ctx)
    for (const credential of [browserCookie(ctx), cookie]) {
      expect(await whoami(ctx, credential)).toEqual({ status: 401 })
      expect(await refusedUpgrade(ctx, credential)).toBe(401)
    }
    expect(events).toEqual([])

    const operator = ctx.connection.createPeer({ principal: { kind: 'owner' } })
    const remove = ctx.connection.peers.admitWith(() => operator)
    expect(await whoami(ctx, browserCookie(ctx))).toEqual({ status: 200, kind: 'owner' })
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    expect(events[0]!.peer).toBe(operator)
    client.close()
    await eventCount(2)

    await remove()
    expect(await whoami(ctx, browserCookie(ctx))).toEqual({ status: 401 })
    expect(await refusedUpgrade(ctx)).toBe(401)
  })
})
