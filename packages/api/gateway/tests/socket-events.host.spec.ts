/** Remote stream socket lifecycle events carry the Peer Connection admitted at upgrade. */
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import TypertGatewayService, { type RemoteSocketId } from '../src/index.ts'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'

interface SocketEvent {
  readonly kind: 'opened' | 'closed'
  readonly peer: PeerScope
  readonly socketId: RemoteSocketId
}

interface Mounted {
  readonly ctx: Context
  readonly events: SocketEvent[]
  /** `error`-level log lines written while the root is mounted. */
  readonly errors: string[]
  /** Resolve once `events` holds at least `count` entries. */
  readonly eventCount: (count: number) => Promise<void>
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function mount(): Promise<Mounted> {
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
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
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
  return { ctx, events, errors, eventCount }
}

function connect(ctx: Context): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: { cookie: browserCookie(ctx) },
  })
}

describe('Remote stream socket events', () => {
  it('announces a socket admitted as the operator and its close by the Client', async () => {
    const { ctx, events, eventCount } = await mount()
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)
    expect(events).toEqual([{ kind: 'opened', peer: ctx.connection.operator, socketId: events[0]!.socketId }])

    client.close()
    await eventCount(2)
    expect(events[1]).toEqual({ kind: 'closed', peer: ctx.connection.operator, socketId: events[0]!.socketId })
  })

  it('announces the admitted member Peer and a distinct id per socket', async () => {
    const { ctx, events, eventCount } = await mount()
    const member = ctx.connection.peers.open()
    ctx.connection.peers.admitWith(() => member)
    const first = connect(ctx)
    await once(first, 'open')
    await eventCount(1)
    const second = connect(ctx)
    await once(second, 'open')
    await eventCount(2)
    expect(events.map(event => [event.kind, event.peer])).toEqual([['opened', member], ['opened', member]])
    expect(events[0]!.socketId).not.toBe(events[1]!.socketId)

    second.close()
    await eventCount(3)
    expect(events[2]).toEqual({ kind: 'closed', peer: member, socketId: events[1]!.socketId })
    first.close()
    await eventCount(4)
    expect(events[3]).toEqual({ kind: 'closed', peer: member, socketId: events[0]!.socketId })
  })

  it('closes the socket with 1001 and announces it when the member Peer is disposed', async () => {
    const { ctx, events, eventCount } = await mount()
    const member = ctx.connection.peers.open()
    ctx.connection.peers.admitWith(() => member)
    const client = connect(ctx)
    await once(client, 'open')
    await eventCount(1)

    const closed = once(client, 'close')
    await member.dispose()
    const closeEvent: unknown[] = await closed
    expect(closeEvent[0]).toBe(1001)
    await eventCount(2)
    expect(events).toEqual([
      { kind: 'opened', peer: member, socketId: events[0]!.socketId },
      { kind: 'closed', peer: member, socketId: events[0]!.socketId },
    ])
  })

  it('refuses the upgrade without announcing a socket when the admitter names no member', async () => {
    const { ctx, events } = await mount()
    ctx.connection.peers.admitWith(() => undefined)
    const client = connect(ctx)
    const responseEvent: unknown[] = await once(client, 'unexpected-response')
    const rejected = responseEvent[1] as { statusCode?: number; resume(): void }
    expect(rejected.statusCode).toBe(401)
    rejected.resume()
    ;(responseEvent[0] as { abort(): void }).abort()
    expect(events).toEqual([])
  })

  it('closes an upgrade whose admitted Peer is already released without announcing a socket', async () => {
    const { ctx, events } = await mount()
    await ctx.connection.operator.dispose()
    const client = connect(ctx)
    const closeEvent: unknown[] = await once(client, 'close')
    expect(closeEvent[0]).toBe(1001)
    expect(String(closeEvent[1])).toBe('peer left')
    expect(events).toEqual([])
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
