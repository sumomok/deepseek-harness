/** The Remote Event filter decides which `$events` Clients receive each event, and only a Client's own Peer answers it. */
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { Context } from '@deepseek-ai/cordis'
import {
  apply as applyConnection,
  inject as connectionInject,
  type ConnectionTrustRequest,
} from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService, {
  type RemoteEventDelivery,
  type RemoteEventFilter,
  type TypertRemoteEventDispatch,
  type TypertRemoteEventOutcome,
} from '@deepseek-ai/dsh-api-gateway'
import type { RemoteEventClientId, RemoteEventId } from '../src/stream-protocol.ts'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'

const REMOTE_HOST = { home: '/home/fixture' } as const
const MEMBER_HEADER = 'x-fixture-member'
/** Delivered to every Client by every fixture filter, so its arrival proves the frames queued before it. */
const SENTINEL = 'fixture/sentinel'

type Member = 'a' | 'b'

interface Mounted {
  readonly ctx: Context
  readonly peers: Readonly<Record<Member, PeerScope>>
  /** Remove the fixture admitter, which turns member admission off. */
  readonly removeAdmitter: () => Promise<void>
  readonly source: RemoteEventSourceProbe
  /** `warn`-level log lines written while the root is mounted. */
  readonly warnings: string[]
}

interface EventClient {
  readonly member: Member
  readonly socket: WebSocket
  readonly frames: Record<string, unknown>[]
  readonly streamId: string
  readonly clientId: RemoteEventClientId
}

interface WaterfallFrame {
  readonly type: 'waterfall'
  readonly event: string
  readonly eventId: RemoteEventId
  readonly agentId: string
  readonly request: Readonly<Record<string, unknown>>
}

interface PendingProbe {
  readonly dispatch: TypertRemoteEventDispatch
  readonly outcome: Promise<TypertRemoteEventOutcome>
  readonly settled: () => boolean
}

type ResultOutcome = { readonly kind: 'next' } | { readonly kind: 'result'; readonly value?: unknown }

interface RpcBody {
  readonly result?: {
    readonly ok?: boolean
    readonly error?: { readonly code?: string; readonly message?: string; readonly details?: unknown }
  }
}

class RemoteEventSourceProbe {
  readonly source = (signal: AbortSignal): AsyncIterable<TypertRemoteEventDispatch> => this.iterate(signal)
  private readonly dispatches: TypertRemoteEventDispatch[] = []
  private wake: (() => void) | undefined

  push(dispatch: TypertRemoteEventDispatch): void {
    this.dispatches.push(dispatch)
    this.wake?.()
    this.wake = undefined
  }

  private async *iterate(signal: AbortSignal): AsyncGenerator<TypertRemoteEventDispatch> {
    const aborted = (): void => {
      this.wake?.()
      this.wake = undefined
    }
    signal.addEventListener('abort', aborted, { once: true })
    try {
      while (!signal.aborted) {
        while (this.dispatches.length > 0) yield this.dispatches.shift()!
        if (signal.aborted) return
        await new Promise<void>((resolve) => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', aborted)
    }
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Mount the Gateway with Connection, two member Peers admitted by the fixture header, and a Remote event source. */
async function mount(): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  const peers = { a: ctx.connection.peers.open(), b: ctx.connection.peers.open() }
  const removeAdmitter = ctx.connection.peers.admitWith((request) => {
    const member = memberHeader(request)
    return member === 'a' || member === 'b' ? peers[member] : undefined
  })
  const source = new RemoteEventSourceProbe()
  ctx.typertGateway.registerRemoteEvents(source.source, REMOTE_HOST)
  return { ctx, peers, removeAdmitter, source, warnings }
}

function memberHeader(request: ConnectionTrustRequest): string | undefined {
  if (request.headers instanceof Headers) return request.headers.get(MEMBER_HEADER) ?? undefined
  const value = request.headers[MEMBER_HEADER]
  return typeof value === 'string' ? value : undefined
}

/** A filter that delivers the sentinel to everyone and every other event only to `member`'s Peer. */
function onlyTo(peer: PeerScope): RemoteEventFilter {
  return (delivery, candidate) => delivery.event === SENTINEL || candidate === peer
}

async function openEventClient(ctx: Context, member: Member, streamId: string): Promise<EventClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: { cookie: browserCookie(ctx), [MEMBER_HEADER]: member },
  })
  await once(socket, 'open')
  const frames: Record<string, unknown>[] = []
  socket.on('message', (data) => { frames.push(JSON.parse(rawText(data)) as Record<string, unknown>) })
  socket.send(JSON.stringify({ type: 'open', streamId, endpoint: '$events', payload: { args: {} } }))
  let clientId: RemoteEventClientId | undefined
  await vi.waitFor(() => {
    const ready = itemsOf({ frames, streamId }).find(value => value.type === 'ready')
    expect(typeof ready?.clientId).toBe('string')
    clientId = ready?.clientId as RemoteEventClientId
  })
  return { member, socket, frames, streamId, clientId: clientId! }
}

function itemsOf(client: Pick<EventClient, 'frames' | 'streamId'>): Record<string, unknown>[] {
  return client.frames
    .filter(frame => frame.type === 'item' && frame.streamId === client.streamId)
    .map(frame => frame.value as Record<string, unknown>)
}

/** Event names of the forwarded items the Client received, in order: notifications and waterfalls. */
function eventsOf(client: EventClient): string[] {
  return itemsOf(client)
    .filter(value => value.type === 'emit' || value.type === 'waterfall')
    .map(value => String(value.event))
}

function waterfallOf(client: EventClient): WaterfallFrame | undefined {
  return itemsOf(client).find(value => value.type === 'waterfall') as WaterfallFrame | undefined
}

/** Broadcast the sentinel and wait until each Client has it, so every frame queued earlier has arrived. */
async function settle(source: RemoteEventSourceProbe, ...clients: EventClient[]): Promise<void> {
  const counts = clients.map(client => eventsOf(client).filter(event => event === SENTINEL).length)
  source.push({ event: SENTINEL, args: [] })
  await vi.waitFor(() => {
    clients.forEach((client, index) => {
      expect(eventsOf(client).filter(event => event === SENTINEL)).toHaveLength(counts[index]! + 1)
    })
  })
}

/** Let the Gateway consume every event pushed so far; the source and the Gateway's fan-out settle in microtasks. */
async function drain(): Promise<void> {
  await new Promise((resolve) => { setImmediate(resolve) })
}

/** Count the waterfall frames the Client received. */
function waterfallsOf(client: EventClient): number {
  return itemsOf(client).filter(value => value.type === 'waterfall').length
}

async function closeClient(client: EventClient): Promise<void> {
  const closed = once(client.socket, 'close')
  client.socket.close()
  await closed
}

function pendingWaterfall(ctx: Context, agentId: string): PendingProbe {
  const agent = ctx.extend()
  const subject = { ctx: agent }
  const settled = Promise.withResolvers<TypertRemoteEventOutcome>()
  // A waterfall still pending at teardown rejects when the root releases its Agent Context.
  void settled.promise.catch((released: unknown) => released)
  let done = false
  return {
    dispatch: {
      event: 'fixture/approval',
      request: { prompt: 'ship', agent: subject },
      context: { value: agent, subject, agentId },
      resolve: (outcome) => {
        done = true
        settled.resolve(outcome)
      },
      reject: (reason) => {
        done = true
        settled.reject(reason)
      },
    },
    outcome: settled.promise,
    settled: () => done,
  }
}

/** Send one `$events/result` through the `/api` HTTP carrier as `member`, and return the RPC envelope. */
async function sendResult(
  ctx: Context,
  member: Member,
  clientId: RemoteEventClientId,
  eventId: RemoteEventId,
  outcome: ResultOutcome,
): Promise<RpcBody> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/api/$events/result`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browserCookie(ctx), [MEMBER_HEADER]: member },
    body: resultEnvelope(clientId, eventId, outcome),
  })
  expect(response.status).toBe(200)
  return await response.json() as RpcBody
}

function resultEnvelope(clientId: RemoteEventClientId, eventId: RemoteEventId, outcome: ResultOutcome): string {
  return JSON.stringify({
    type: 'client-request',
    rpcId: `result-${eventId}`,
    method: '$events/result',
    payload: { args: { clientId, eventId, outcome } },
  })
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  return Buffer.from(data).toString('utf8')
}

describe('Remote Event filter', () => {
  it('delivers a notification only to the Clients whose Peer the filter accepts', async () => {
    const { ctx, peers, source } = await mount()
    const seen: Array<readonly [RemoteEventDelivery, PeerScope]> = []
    const filter = onlyTo(peers.a)
    ctx.typertGateway.filterRemoteEvents((delivery, peer) => {
      seen.push([delivery, peer])
      return filter(delivery, peer)
    })
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')

    source.push({ event: 'fixture/notice', args: [{ session: 's-1' }] })
    await settle(source, a, b)

    expect(eventsOf(a)).toEqual(['fixture/notice', SENTINEL])
    expect(eventsOf(b)).toEqual([SENTINEL])
    expect(itemsOf(a).find(value => value.event === 'fixture/notice')).toEqual({
      type: 'emit', event: 'fixture/notice', args: [{ session: 's-1' }],
    })
    expect(seen.filter(([delivery]) => delivery.event === 'fixture/notice')).toEqual([
      [{ kind: 'emit', event: 'fixture/notice', args: [{ session: 's-1' }] }, peers.a],
      [{ kind: 'emit', event: 'fixture/notice', args: [{ session: 's-1' }] }, peers.b],
    ])
  })

  it('delivers a waterfall only to its Peer, refuses another Peer\'s answer, and replays it to that Peer alone', async () => {
    const { ctx, peers, source } = await mount()
    const seen: RemoteEventDelivery[] = []
    const filter = onlyTo(peers.a)
    ctx.typertGateway.filterRemoteEvents((delivery, peer) => {
      if (delivery.kind === 'waterfall') seen.push(delivery)
      return filter(delivery, peer)
    })
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push(pending.dispatch)
    await settle(source, a, b)
    const frame = waterfallOf(a)!
    expect(frame).toMatchObject({ event: 'fixture/approval', agentId: 'session-a', request: { prompt: 'ship' } })
    expect(waterfallOf(b)).toBeUndefined()
    expect(seen[0]).toEqual({
      kind: 'waterfall', event: 'fixture/approval', agentId: 'session-a', request: { prompt: 'ship' },
    })

    const refused = await sendResult(ctx, 'b', a.clientId, frame.eventId, { kind: 'result', value: 'allowed' })
    expect(refused.result).toMatchObject({
      ok: false,
      error: { code: 'gateway/forbidden', details: { endpoint: '$events/result' } },
    })
    await settle(source, a, b)
    expect(pending.settled()).toBe(false)

    await closeClient(a)
    await closeClient(b)
    expect(pending.settled()).toBe(false)

    const b2 = await openEventClient(ctx, 'b', 'events-b2')
    await settle(source, b2)
    expect(waterfallOf(b2)).toBeUndefined()

    const a2 = await openEventClient(ctx, 'a', 'events-a2')
    await settle(source, a2)
    const replayed = waterfallOf(a2)!
    expect(replayed.eventId).toBe(frame.eventId)
    // First delivery to A and B, then one replay to each reconnected Client.
    expect(seen).toEqual(Array.from({ length: 4 }, () => seen[0]))

    const answered = await sendResult(ctx, 'a', a2.clientId, replayed.eventId, { kind: 'result', value: 'allowed' })
    expect(answered.result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'allowed' })
  })

  it('keeps a waterfall no connected Client may receive pending, and settles next once its Peer delegates', async () => {
    const { ctx, peers, source } = await mount()
    ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push(pending.dispatch)
    await settle(source, b)
    expect(waterfallOf(b)).toBeUndefined()
    expect(pending.settled()).toBe(false)

    const a = await openEventClient(ctx, 'a', 'events-a')
    await settle(source, a)
    const frame = waterfallOf(a)!
    expect((await sendResult(ctx, 'a', a.clientId, frame.eventId, { kind: 'next' })).result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'next' })
  })

  it('withholds and logs every delivery the filter throws for, on broadcast, first delivery, and replay', async () => {
    const { ctx, source, warnings } = await mount()
    ctx.typertGateway.filterRemoteEvents((delivery) => {
      if (delivery.event === SENTINEL) return true
      throw new Error('fixture filter failure')
    })
    const a = await openEventClient(ctx, 'a', 'events-a')
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push({ event: 'fixture/notice', args: [] })
    source.push(pending.dispatch)
    await settle(source, a)
    const late = await openEventClient(ctx, 'b', 'events-b')
    await settle(source, a, late)

    expect(eventsOf(a)).toEqual([SENTINEL, SENTINEL])
    expect(eventsOf(late)).toEqual([SENTINEL])
    expect(pending.settled()).toBe(false)
    expect(warnings).toEqual([
      'api-gateway: the Remote event filter threw for "fixture/notice"; the event is withheld',
      'api-gateway: the Remote event filter threw for "fixture/approval"; the event is withheld',
      'api-gateway: the Remote event filter threw for "fixture/approval"; the event is withheld',
    ])
  })

  it('withholds, without logging, every delivery the filter answers with anything but true', async () => {
    const { ctx, source, warnings } = await mount()
    // A JavaScript installer can return any value; the parsed string is truthy but not `true`.
    const truthy = JSON.parse('"yes"') as boolean
    ctx.typertGateway.filterRemoteEvents(delivery => delivery.event === SENTINEL || truthy)
    const a = await openEventClient(ctx, 'a', 'events-a')
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push({ event: 'fixture/notice', args: [] })
    source.push(pending.dispatch)
    await settle(source, a)
    const late = await openEventClient(ctx, 'b', 'events-b')
    await settle(source, a, late)

    expect(eventsOf(a)).toEqual([SENTINEL, SENTINEL])
    expect(eventsOf(late)).toEqual([SENTINEL])
    expect(pending.settled()).toBe(false)
    expect(warnings).toEqual([])
  })

  it('accepts one filter at a time, removed by its disposer or its Context\'s unload, after which no Client of an admitting Host receives events', async () => {
    const { ctx, peers, source } = await mount()
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')

    const remove = ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    expect(() => ctx.typertGateway.filterRemoteEvents(() => true)).toThrow('a Remote event filter is already installed')
    source.push({ event: 'fixture/first', args: [] })
    await settle(source, a, b)
    await remove()
    source.push({ event: 'fixture/second', args: [] })
    await drain()

    const owner = ctx.plugin({
      inject: ['typertGateway'],
      apply: (pluginCtx: Context) => { pluginCtx.typertGateway.filterRemoteEvents(onlyTo(peers.a)) },
    })
    await owner
    source.push({ event: 'fixture/third', args: [] })
    await settle(source, a, b)
    await owner.dispose()
    source.push({ event: 'fixture/fourth', args: [] })
    await drain()
    ctx.typertGateway.filterRemoteEvents(() => true)
    await settle(source, a, b)

    expect(eventsOf(a)).toEqual(['fixture/first', SENTINEL, 'fixture/third', SENTINEL, SENTINEL])
    expect(eventsOf(b)).toEqual([SENTINEL, SENTINEL, SENTINEL])
  })

  it('restores delivery to every Client when the filter is removed while member admission is off', async () => {
    const { ctx, peers, removeAdmitter, source } = await mount()
    await removeAdmitter()
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const remove = ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    source.push({ event: 'fixture/first', args: [] })
    await settle(source, a, b)
    await remove()
    source.push({ event: 'fixture/second', args: [] })
    await settle(source, a, b)

    // Both Clients speak for the operator, which the filter for member A does not accept.
    expect(eventsOf(a)).toEqual([SENTINEL, 'fixture/second', SENTINEL])
    expect(eventsOf(b)).toEqual([SENTINEL, 'fixture/second', SENTINEL])
  })

  it('opens $events but delivers nothing while member admission is on and no filter is installed, and delivers the pending waterfall to the admitted Client once one is', async () => {
    const { ctx, peers, source } = await mount()
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    expect(ctx.typertGateway.hasLiveClient()).toBe(true)
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push({ event: 'fixture/notice', args: [] })
    source.push(pending.dispatch)
    await drain()
    const late = await openEventClient(ctx, 'a', 'events-a-late')
    await drain()
    expect([a, b, late].map(eventsOf)).toEqual([[], [], []])
    expect(pending.settled()).toBe(false)

    ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    await settle(source, a, b, late)
    expect(eventsOf(a)).toEqual(['fixture/approval', SENTINEL])
    expect(eventsOf(late)).toEqual(['fixture/approval', SENTINEL])
    expect(eventsOf(b)).toEqual([SENTINEL])
    const frame = waterfallOf(a)!
    expect(waterfallOf(late)?.eventId).toBe(frame.eventId)
    expect((await sendResult(ctx, 'a', a.clientId, frame.eventId, { kind: 'result', value: 'allowed' })).result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'allowed' })
  })

  it('delivers a pending waterfall on installation only to Clients that never received it', async () => {
    const { ctx, source } = await mount()
    const remove = ctx.typertGateway.filterRemoteEvents(() => true)
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')
    source.push(pending.dispatch)
    await settle(source, a, b)
    const frame = waterfallOf(a)!
    // A delegates; B still holds the waterfall, so it stays pending.
    expect((await sendResult(ctx, 'a', a.clientId, frame.eventId, { kind: 'next' })).result?.ok).toBe(true)
    expect(pending.settled()).toBe(false)

    await remove()
    ctx.typertGateway.filterRemoteEvents(() => true)
    const c = await openEventClient(ctx, 'a', 'events-c')
    await settle(source, a, b, c)
    expect([a, b, c].map(waterfallsOf)).toEqual([1, 1, 1])
  })

  it('answers ok and changes nothing when a member posts a result for its own Client with another member\'s event', async () => {
    const { ctx, peers, source } = await mount()
    ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')
    source.push(pending.dispatch)
    await settle(source, a, b)
    const frame = waterfallOf(a)!

    const stray = await sendResult(ctx, 'b', b.clientId, frame.eventId, { kind: 'result', value: 'allowed' })
    expect(stray.result?.ok).toBe(true)
    await settle(source, a, b)
    expect(pending.settled()).toBe(false)
    expect(itemsOf(a).filter(value => value.type === 'cancel')).toEqual([])

    expect((await sendResult(ctx, 'a', a.clientId, frame.eventId, { kind: 'result', value: 'denied' })).result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'denied' })
  })

  it('refuses a result from another Peer even when the filter delivers to every Client, and accepts each Peer\'s answer for its own Client', async () => {
    const { ctx, source } = await mount()
    ctx.typertGateway.filterRemoteEvents(() => true)
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')

    source.push(pending.dispatch)
    await settle(source, a, b)
    const frame = waterfallOf(a)!
    expect(waterfallOf(b)?.eventId).toBe(frame.eventId)

    const refused = await sendResult(ctx, 'a', b.clientId, frame.eventId, { kind: 'next' })
    expect(refused.result?.error?.code).toBe('gateway/forbidden')
    expect((await sendResult(ctx, 'b', b.clientId, frame.eventId, { kind: 'next' })).result?.ok).toBe(true)
    expect(pending.settled()).toBe(false)
    expect((await sendResult(ctx, 'a', a.clientId, frame.eventId, { kind: 'next' })).result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'next' })
  })

  it('carries no Remote event result over the WebSocket mux', async () => {
    const { ctx, peers, source } = await mount()
    ctx.typertGateway.filterRemoteEvents(onlyTo(peers.a))
    const a = await openEventClient(ctx, 'a', 'events-a')
    const b = await openEventClient(ctx, 'b', 'events-b')
    const pending = pendingWaterfall(ctx, 'session-a')
    source.push(pending.dispatch)
    await settle(source, a, b)
    const frame = waterfallOf(a)!

    for (const client of [a, b]) {
      client.socket.send(JSON.stringify({
        type: 'open',
        streamId: `result-${client.member}`,
        endpoint: '$events/result',
        payload: { args: { clientId: a.clientId, eventId: frame.eventId, outcome: { kind: 'result', value: 'allowed' } } },
      }))
      await vi.waitFor(() => {
        expect(client.frames.find(entry => entry.streamId === `result-${client.member}`)?.type).toBe('error')
      })
    }
    await settle(source, a, b)
    expect(pending.settled()).toBe(false)
  })

  it('records the operator for an in-process stream and accepts only the operator\'s result for it', async () => {
    const { ctx, peers, source } = await mount()
    const offered: PeerScope[] = []
    ctx.typertGateway.filterRemoteEvents((delivery, peer) => {
      if (delivery.kind === 'waterfall') offered.push(peer)
      return true
    })
    const cancel = new AbortController()
    const stream = await ctx.typertGateway.wireStream.open(
      '$events',
      { args: {} },
      { [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ value: undefined, done: true }) }) },
      undefined,
      cancel.signal,
    )
    const iterator = stream[Symbol.asyncIterator]()
    const ready = (await iterator.next()).value as { readonly clientId: RemoteEventClientId }
    const pending = pendingWaterfall(ctx, 'session-operator')
    source.push(pending.dispatch)
    const delivered = (await iterator.next()).value as WaterfallFrame
    expect(delivered.type).toBe('waterfall')
    expect(offered).toEqual([ctx.connection.operator])

    const refused = await sendResult(ctx, 'a', ready.clientId, delivered.eventId, { kind: 'result', value: 'member' })
    expect(refused.result?.error?.code).toBe('gateway/forbidden')
    expect(pending.settled()).toBe(false)
    expect(peers.a).not.toBe(ctx.connection.operator)

    const shared = ctx.connection.createSharedFetchHandler('/api')
    const response = await shared.fetch(new Request('http://host/api/$events/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: resultEnvelope(ready.clientId, delivered.eventId, { kind: 'result', value: 'operator' }),
    }))
    expect(((await response.json()) as RpcBody).result?.ok).toBe(true)
    await expect(pending.outcome).resolves.toEqual({ kind: 'result', value: 'operator' })
    cancel.abort()
    await iterator.return?.()
  })
})
