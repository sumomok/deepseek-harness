/** The `remote/invoke` waterfall wraps every Remote method call on every carrier and is inert without listeners. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  Remote,
  RemoteError,
  RemoteScope,
  TypertRemoteService,
  type InvocationDescriptor,
  type PeerScope,
  type TypertContext,
  type TypertLookup,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService, {
  TypertGatewayError,
  type RemoteInvokeCall,
  type RemoteInvokeOutcome,
} from '@deepseek-ai/dsh-api-gateway'
import { browserCookie, provideBrowserCredentials } from './browser-credentials.ts'

interface InvokeAgent {
  readonly id: string
}

interface InvokeFile {
  readonly path: string
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertLookupMap {
    remoteInvokeAgent: TypertLookup<InvokeAgent, string>
    remoteInvokeFile: TypertLookup<InvokeFile, string>
  }

  interface TypertContextMap {
    remoteInvokeAgent: TypertContext<string>
  }
}

/** What the fixture methods observed; reset by every `mount()`. */
interface Probe {
  readonly calls: string[]
  readonly peers: (PeerScope | undefined)[]
  readonly wireArgs: (Readonly<Record<string, unknown>> | undefined)[]
  readonly stores: (string | undefined)[]
  /** Iterator steps of `follow` and of the tracked uplink. */
  readonly events: string[]
  returns: number
  failure: Error | undefined
  /** Failure `follow` throws from its iterator factory or from its iterator's `return()`. */
  followFailure: { readonly at: 'iterator' | 'return'; readonly error: Error } | undefined
  /** Whether `follow`'s iterator `return()` settles only after a timer, then records `follow:returned`. */
  slowReturn: boolean
}

type InvokeListener = (call: RemoteInvokeCall, next: () => Promise<RemoteInvokeOutcome>) => Promise<RemoteInvokeOutcome>

const member = new AsyncLocalStorage<string>()
let probe: Probe = freshProbe()

class GuardService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'guard', { namespace: 'guard' })
  }

  @Remote
  create(agent: InvokeAgent, request: { readonly title: string }): unknown {
    this.observe('create')
    return { agentId: agent.id, title: request.title }
  }

  @RemoteScope('remoteInvokeAgent')
  rename(request: { readonly title: string }): unknown {
    this.observe('rename')
    return { title: request.title }
  }

  @Remote
  read(file: InvokeFile): unknown {
    this.observe('read')
    return { path: file.path }
  }

  @Remote
  passthrough(value: unknown): unknown {
    this.observe('passthrough')
    return value
  }

  @Remote
  fail(): never {
    this.observe('fail')
    throw probe.failure ?? new Error('fixture failure')
  }

  @Remote({ mode: 'stream' })
  async *feed(count: number): AsyncGenerator {
    this.observe('feed')
    try {
      for (let index = 0; index < count; index++) {
        await Promise.resolve()
        yield { index, store: member.getStore() ?? 'none' }
      }
    } finally {
      probe.returns++
    }
  }

  @Remote({ mode: 'stream' })
  watch(label: string): AsyncIterable<string> {
    this.observe('watch')
    return toAsync([label])
  }

  @Remote({ mode: 'stream' })
  follow(label: string): AsyncIterable<string> {
    this.observe('follow')
    // A release that outlives its test records into that test's probe.
    const { events, followFailure, slowReturn } = probe
    return {
      [Symbol.asyncIterator]: () => {
        events.push('follow:iterator')
        if (followFailure?.at === 'iterator') throw followFailure.error
        return {
          next: () => {
            events.push('follow:next')
            return Promise.resolve({ done: false as const, value: label })
          },
          return: async () => {
            events.push('follow:return')
            if (followFailure?.at === 'return') throw followFailure.error
            if (slowReturn) {
              await new Promise((resolve) => { setTimeout(resolve, 10) })
              events.push('follow:returned')
            }
            return { done: true as const, value: undefined }
          },
        }
      },
    }
  }

  private observe(method: string): void {
    probe.calls.push(method)
    probe.peers.push(this.ctx.invocation?.peer)
    probe.wireArgs.push(this.ctx.invocation?.request.args)
    probe.stores.push(member.getStore())
  }
}

/** SRC methods whose markers `claimedEndpoints()` must leave out. */
class ClaimsService extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'claims', { namespace: 'claims' })
  }

  /** Shadowed by a strict definition the test registers and withdraws. */
  @Remote
  withdrawn(): string {
    return 'withdrawn'
  }

  /** Its endpoint `claims/nested/name` has three segments, which the `/api` carrier never claims. */
  @Remote
  ['nested/name'](): string {
    return 'nested'
  }
}

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

describe('remote/invoke', () => {
  it('leaves every carrier unchanged when nothing listens', async () => {
    const ctx = await mount()
    await expect(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'create', args: { agentId: 'agent-1', request: { title: ' ship ' } },
    })).resolves.toEqual({ agentId: 'agent-1', title: 'ship' })
    await expect(rpc(ctx, 'guard/create', { agentId: 'agent-1', request: { title: 'land' } }))
      .resolves.toEqual({ ok: true, value: { agentId: 'agent-1', title: 'land' } })
    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 2 } })))
      .resolves.toEqual([{ index: 0, store: 'none' }, { index: 1, store: 'none' }])
    await expect(collect(await ctx.typertGateway.wireStream.open(
      'guard/feed', { args: { count: 1 } }, empty(), undefined, new AbortController().signal,
    ))).resolves.toEqual([{ index: 0, store: 'none' }])
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 1 })
    await socket.ended('feed')
    expect(socket.frames('feed')).toEqual([
      { type: 'item', streamId: 'feed', value: { index: 0, store: 'none' } },
      { type: 'end', streamId: 'feed' },
    ])

    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'create', args: { agentId: 'agent-1' },
    }), 'gateway/arguments-invalid')
    await expect(rpc(ctx, 'guard/create', { agentId: 'agent-1', request: { title: 1 } })).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/input-invalid', details: { endpoint: 'guard/create', field: 'request' } },
    })
    await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'create', args: { agentId: 'agent-1', request: { title: 'x' } },
    }), 'gateway/signature-invalid')
    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'absent', args: {},
    }), 'gateway/invocation-unavailable')
    await expectRemoteCode(ctx.typertGateway.wireStream.open(
      'guard/feed', { args: { count: 1, extra: true } }, empty(), undefined, new AbortController().signal,
    ), 'gateway/arguments-invalid')
    socket.open('unary', 'guard/passthrough', { value: 1 })
    await socket.ended('unary')
    expect(socket.frames('unary')).toEqual([{
      type: 'error',
      streamId: 'unary',
      error: {
        code: 'gateway/signature-invalid',
        message: 'typert gateway: guard/passthrough: unary Remote methods cannot be opened through the stream carrier',
        details: { endpoint: 'guard/passthrough' },
      },
    }])
    expect(probe.calls).toEqual(['create', 'create', 'feed', 'feed', 'feed'])
    await socket.close()
  })

  it('runs once per call on every carrier and hands the method the call it saw', async () => {
    const ctx = await mount()
    const seen: Pick<RemoteInvokeCall, 'endpoint' | 'mode' | 'peer'>[] = []
    ctx.on('remote/invoke', (call, next) => {
      seen.push({ endpoint: call.endpoint, mode: call.mode, peer: call.peer })
      return next()
    })
    const operator = ctx.connection.operator

    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 'in-process' } })
    await rpc(ctx, 'guard/passthrough', { value: 'http' })
    await collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 1 } }))
    await collect(await ctx.typertGateway.wireStream.open(
      'guard/feed', { args: { count: 1 } }, empty(), undefined, new AbortController().signal,
    ))
    const socket = await openSocket(ctx)
    socket.open('ws', 'guard/feed', { count: 1 })
    await socket.ended('ws')
    await socket.close()

    expect(seen).toEqual([
      { endpoint: 'guard/passthrough', mode: 'unary', peer: operator },
      { endpoint: 'guard/passthrough', mode: 'unary', peer: operator },
      { endpoint: 'guard/feed', mode: 'stream', peer: operator },
      { endpoint: 'guard/feed', mode: 'stream', peer: operator },
      { endpoint: 'guard/feed', mode: 'stream', peer: operator },
    ])
    expect(probe.peers).toEqual([operator, operator, operator, operator, operator])
  })

  it('passes the member Peer Connection admitted to the listener and the method', async () => {
    const ctx = await mount()
    const admitted = ctx.connection.peers.open()
    ctx.connection.peers.admitWith(() => admitted)
    const peers: PeerScope[] = []
    ctx.on('remote/invoke', (call, next) => {
      peers.push(call.peer)
      return next()
    })

    await expect(rpc(ctx, 'guard/passthrough', { value: 1 })).resolves.toEqual({ ok: true, value: 1 })
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 1 })
    await socket.ended('feed')
    await socket.close()
    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 2 } })

    expect(peers).toEqual([admitted, admitted, ctx.connection.operator])
    expect(probe.peers).toEqual([admitted, admitted, ctx.connection.operator])
  })

  it('refuses on every carrier when a listener throws before next(), as a method failure would', async () => {
    const ctx = await mount()
    const refusal = (call: RemoteInvokeCall): RemoteError => call.mode === 'unary'
      ? new RemoteError('gateway/forbidden', 'fixture: refused', { endpoint: call.endpoint })
      : new TypertGatewayError('gateway/forbidden', call.endpoint, 'refused')
    const stop = ctx.on('remote/invoke', (call) => { throw refusal(call) })

    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'passthrough', args: { value: 1 },
    }), 'gateway/forbidden')
    const refused = await rpc(ctx, 'guard/passthrough', { value: 1 })
    expect(refused).toEqual({
      ok: false,
      error: { code: 'gateway/forbidden', message: 'fixture: refused', details: { endpoint: 'guard/passthrough' } },
    })
    await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'feed', args: { count: 1 },
    }), 'gateway/forbidden')
    await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'watch', args: { label: 'x' },
    }), 'gateway/forbidden')
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 1 })
    await socket.ended('feed')
    expect(socket.frames('feed')).toEqual([{
      type: 'error',
      streamId: 'feed',
      error: {
        code: 'gateway/forbidden',
        message: 'typert gateway: guard/feed: refused',
        details: { endpoint: 'guard/feed' },
      },
    }])
    await socket.close()
    expect(probe.calls).toEqual([])

    stop()
    probe.failure = new RemoteError('gateway/forbidden', 'fixture: refused', { endpoint: 'guard/passthrough' })
    await expect(rpc(ctx, 'guard/fail', {})).resolves.toEqual(refused)
  })

  it('validates and delivers arguments a listener replaced before next()', async () => {
    const ctx = await mount()
    const replacements: Readonly<Record<string, unknown>>[] = [
      { value: 'replaced' },
      { value: 'replaced', extra: true },
      { value: 1n },
      { label: 'replaced' },
    ]
    ctx.on('remote/invoke', (call, next) => {
      call.args = replacements.shift() ?? call.args
      return next()
    })

    await expect(rpc(ctx, 'guard/passthrough', { value: 'original' })).resolves.toEqual({ ok: true, value: 'replaced' })
    expect(probe.wireArgs).toEqual([{ value: 'replaced' }])
    await expect(rpc(ctx, 'guard/passthrough', { value: 'original' })).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/arguments-invalid', details: { endpoint: 'guard/passthrough' } },
    })
    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'passthrough', args: { value: 'original' },
    }), 'gateway/input-invalid')
    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'watch', args: { label: 'original' } })))
      .resolves.toEqual(['replaced'])
    expect(probe.calls).toEqual(['passthrough', 'watch'])
    expect(probe.wireArgs).toEqual([{ value: 'replaced' }, { label: 'replaced' }])
  })

  it('resolves the receiver Context from the identity a listener replaced', async () => {
    const ctx = await mount()
    ctx.on('remote/invoke', (call, next) => {
      call.args = { ...call.args, agentId: 'agent-missing' }
      return next()
    })

    const failure = await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'rename', args: { agentId: 'agent-1', request: { title: 'x' } },
    }), 'gateway/context-not-found')
    expect(failure.details).toEqual({ endpoint: 'guard/rename', field: 'agentId' })
    expect(probe.calls).toEqual([])
  })

  it('returns a rewritten unary value, which the RPC carrier still encodes', async () => {
    const ctx = await mount()
    const rewrites: unknown[] = []
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      return outcome.kind === 'value' ? { kind: 'value', value: rewrites.shift() } : outcome
    })
    const date = new Date(0)
    const circular: { self?: unknown } = {}
    circular.self = circular
    rewrites.push({ rewritten: true }, { at: date }, { at: date }, circular)

    await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } }))
      .resolves.toEqual({ rewritten: true })
    await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } }))
      .resolves.toEqual({ at: date })
    await expect(rpc(ctx, 'guard/passthrough', { value: 1 }))
      .resolves.toEqual({ ok: true, value: { at: '1970-01-01T00:00:00.000Z' } })
    await expect(rpc(ctx, 'guard/passthrough', { value: 1 })).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/internal', message: 'gateway: circular RPC result' },
    })
    expect(probe.calls).toEqual(['passthrough', 'passthrough', 'passthrough', 'passthrough'])
  })

  it('delivers a wrapped stream that rewrites items and ends early', async () => {
    const ctx = await mount()
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      return outcome.kind === 'stream' ? { kind: 'stream', source: firstItems(outcome.source, 2) } : outcome
    })

    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 5 } })))
      .resolves.toEqual(['item 0', 'item 1'])
    expect(probe.returns).toBe(1)
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 5 })
    await socket.ended('feed')
    await socket.close()
    expect(socket.frames('feed')).toEqual([
      { type: 'item', streamId: 'feed', value: 'item 0' },
      { type: 'item', streamId: 'feed', value: 'item 1' },
      { type: 'end', streamId: 'feed' },
    ])
    await vi.waitFor(() => { expect(probe.returns).toBe(2) })
  })

  it('runs the method in the async context of next(), and stream items where the listener pulls them', async () => {
    const ctx = await mount()
    let reenter = true
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await member.run('member-a', next)
      if (outcome.kind === 'value' || !reenter) return outcome
      return { kind: 'stream', source: pullInside(outcome.source, pull => member.run('member-a', pull)) }
    })

    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })
    await rpc(ctx, 'guard/passthrough', { value: 1 })
    await collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'watch', args: { label: 'w' } }))
    expect(probe.stores).toEqual(['member-a', 'member-a', 'member-a'])
    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 2 } })))
      .resolves.toEqual([{ index: 0, store: 'member-a' }, { index: 1, store: 'member-a' }])
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 2 })
    await socket.ended('feed')
    await socket.close()
    expect(socket.frames('feed').slice(0, 2)).toEqual([
      { type: 'item', streamId: 'feed', value: { index: 0, store: 'member-a' } },
      { type: 'item', streamId: 'feed', value: { index: 1, store: 'member-a' } },
    ])

    reenter = false
    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 2 } })))
      .resolves.toEqual([{ index: 0, store: 'none' }, { index: 1, store: 'none' }])
  })

  it('answers without the method when a listener returns without next()', async () => {
    const ctx = await mount()
    ctx.on('remote/invoke', (call): Promise<RemoteInvokeOutcome> => Promise.resolve(call.mode === 'unary'
      ? { kind: 'value', value: 'answered' }
      : { kind: 'stream', source: toAsync(['answered']) }))

    await expect(rpc(ctx, 'guard/passthrough', { value: 1 })).resolves.toEqual({ ok: true, value: 'answered' })
    await expect(collect(await ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 1 } })))
      .resolves.toEqual(['answered'])
    expect(probe.calls).toEqual([])
  })

  it('fails a call whose listener returns the outcome of the other mode', async () => {
    const ctx = await mount()
    ctx.on('remote/invoke', (call): Promise<RemoteInvokeOutcome> => Promise.resolve(call.mode === 'unary'
      ? { kind: 'stream', source: toAsync([]) }
      : { kind: 'value', value: 'value' }))

    const unary = await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'passthrough', args: { value: 1 },
    }), 'gateway/result-invalid')
    expect(unary.details).toEqual({ endpoint: 'guard/passthrough', field: 'result' })
    const stream = await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'feed', args: { count: 1 },
    }), 'gateway/result-invalid')
    expect(stream.details).toEqual({ endpoint: 'guard/feed', field: 'result' })
  })

  it('reports the entry mode, not the method mode, when a call uses the other entry point', async () => {
    const ctx = await mount()
    const modes: RemoteInvokeCall['mode'][] = []
    ctx.on('remote/invoke', (call, next) => {
      modes.push(call.mode)
      return next()
    })

    await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'passthrough', args: { value: 1 },
    }), 'gateway/signature-invalid')
    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'guard', method: 'feed', args: { count: 1 },
    }), 'gateway/signature-invalid')
    expect(modes).toEqual(['stream', 'unary'])
    expect(probe.calls).toEqual([])
  })

  // The uplink is released before the method's iterator is returned; before the first next(), that iterator is opened only then.
  it.each([
    { pulled: false, events: ['uplink:iterator', 'uplink:return', 'follow:iterator', 'follow:return'] },
    { pulled: true, events: ['follow:iterator', 'follow:next', 'uplink:iterator', 'uplink:return', 'follow:return'] },
  ])('releases the uplink and returns the method iterator when a listener discards a stream (pulled: $pulled)', async ({ pulled, events }) => {
    const ctx = await mount()
    discardWith(ctx, async (iterator) => {
      if (pulled) await expect(iterator.next()).resolves.toEqual({ done: false, value: 'x' })
      await iterator.return?.()
    })

    await followRefused(ctx)
    expect(probe.calls).toEqual(['follow'])
    expect(probe.events).toEqual(events)
  })

  it.each([
    { pulled: false, at: 'return', events: ['uplink:iterator', 'uplink:return', 'follow:iterator', 'follow:return'] },
    { pulled: false, at: 'iterator', events: ['uplink:iterator', 'uplink:return', 'follow:iterator'] },
    { pulled: true, at: 'return', events: ['follow:iterator', 'follow:next', 'uplink:iterator', 'uplink:return', 'follow:return'] },
  ] as const)('rejects return() with the method iterator failure after releasing the uplink (pulled: $pulled, at: $at)', async ({ pulled, at, events }) => {
    const ctx = await mount()
    const error = new Error('fixture: follow failed')
    probe.followFailure = { at, error }
    discardWith(ctx, async (iterator) => {
      if (pulled) await expect(iterator.next()).resolves.toEqual({ done: false, value: 'x' })
      await expect(iterator.return?.()).rejects.toBe(error)
      await expect(iterator.return?.('again')).resolves.toEqual({ done: true, value: 'again' })
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    })

    await followRefused(ctx)
    expect(probe.events).toEqual(events)
  })

  it('settles later return() and next() calls as done without the method after a return() before the first next()', async () => {
    const ctx = await mount()
    discardWith(ctx, async (iterator) => {
      await expect(iterator.return?.('first')).resolves.toEqual({ done: true, value: 'first' })
      await expect(iterator.return?.('second')).resolves.toEqual({ done: true, value: 'second' })
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
    })

    await followRefused(ctx)
    expect(probe.calls).toEqual(['follow'])
    expect(probe.events).toEqual(['uplink:iterator', 'uplink:return', 'follow:iterator', 'follow:return'])
  })

  it('settles return() and next() calls made during an unpulled release only once it has finished', async () => {
    const ctx = await mount()
    probe.slowReturn = true
    discardWith(ctx, async (iterator) => {
      const settled = (label: string, pending: Promise<IteratorResult<unknown>> | undefined) =>
        pending?.then((result) => {
          probe.events.push(`settled:${label}`)
          return result
        })
      await expect(Promise.all([
        settled('first', iterator.return?.('first')),
        settled('second', iterator.return?.('second')),
        settled('next', iterator.next()),
      ])).resolves.toEqual([{ done: true, value: 'first' }, { done: true, value: 'second' }, { done: true, value: undefined }])
    })

    await followRefused(ctx)
    expect(probe.events.slice(0, 5))
      .toEqual(['uplink:iterator', 'uplink:return', 'follow:iterator', 'follow:return', 'follow:returned'])
    expect(probe.events.slice(5).sort()).toEqual(['settled:first', 'settled:next', 'settled:second'])
  })

  // Each next() that reaches the method opens one stream; the caller receives the listener's outcome once every opened
  // stream has returned, never the release failure.
  it.each([
    { answer: 'throws', opens: 1, releaseFails: false, code: 'gateway/forbidden' },
    { answer: 'returns a value', opens: 1, releaseFails: false, code: 'gateway/result-invalid' },
    { answer: 'throws', opens: 2, releaseFails: false, code: 'gateway/forbidden' },
    { answer: 'throws', opens: 1, releaseFails: true, code: 'gateway/forbidden' },
    { answer: 'returns a value', opens: 1, releaseFails: true, code: 'gateway/result-invalid' },
  ] as const)('returns each stream next() opened when a listener $answer after next() (opens: $opens, release fails: $releaseFails)', async ({ answer, opens, releaseFails, code }) => {
    const ctx = await mount()
    probe.slowReturn = true
    if (releaseFails) probe.followFailure = { at: 'return', error: new Error('fixture: follow failed') }
    ctx.on('remote/invoke', async (call, next): Promise<RemoteInvokeOutcome> => {
      for (let opened = 0; opened < opens; opened++) await next()
      if (answer === 'returns a value') return { kind: 'value', value: 'answered' }
      throw new RemoteError('gateway/forbidden', 'fixture: refused after next', { endpoint: call.endpoint })
    })

    await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
    }), code)
    probe.events.push('caller:failed')
    const returned = releaseFails ? ['follow:return'] : ['follow:return', 'follow:returned']
    expect(probe.calls).toEqual(Array.from({ length: opens }, () => 'follow'))
    expect(probe.events).toEqual([
      ...Array.from({ length: opens }, () => ['uplink:iterator', 'uplink:return', 'follow:iterator', ...returned]).flat(),
      'caller:failed',
    ])
  })

  // A stream still opening when the call fails is returned once it opens; the caller does not wait for that return,
  // which settles after a timer.
  it.each([
    {
      answer: 'throws synchronously after calling next()',
      code: 'gateway/forbidden',
      listener: (refusal: RemoteError): InvokeListener => (_call, next) => {
        void next()
        throw refusal
      },
    },
    {
      answer: 'throws when its race with next() rejects first',
      code: 'gateway/forbidden',
      listener: (refusal: RemoteError): InvokeListener => async (_call, next) => {
        const opening = next()
        await Promise.race([opening, Promise.reject(refusal)])
        return opening
      },
    },
    {
      answer: 'returns a value without awaiting next()',
      code: 'gateway/result-invalid',
      listener: (): InvokeListener => async (_call, next) => {
        void next()
        return { kind: 'value', value: 'answered' }
      },
    },
  ] as const)('returns the stream next() is still opening when a listener $answer', async ({ code, listener }) => {
    const ctx = await mount()
    probe.slowReturn = true
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused while next() opens', { endpoint: 'guard/follow' })
    ctx.on('remote/invoke', listener(refusal))

    const failure = await expectRemoteCode(ctx.typertGateway.stream({
      namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
    }), code)
    if (code === 'gateway/forbidden') expect(failure).toBe(refusal)
    expect(probe.events).not.toContain('follow:returned')
    await vi.waitFor(() => {
      expect(probe.events).toEqual(['uplink:iterator', 'uplink:return', 'follow:iterator', 'follow:return', 'follow:returned'])
    })
    expect(probe.calls).toEqual(['follow'])
  })

  it('keeps the Gateway-owned $events stream and $events/result outside the waterfall', async () => {
    const ctx = await mount()
    const unregister = ctx.effect(() => ctx.typertGateway.registerRemoteEvents(signal => (async function* () {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    })(), { home: '/home/fixture' }))
    const seen: string[] = []
    ctx.on('remote/invoke', (call, next) => {
      seen.push(call.endpoint)
      return next()
    })

    const socket = await openSocket(ctx)
    socket.open('events', '$events', {})
    await vi.waitFor(() => { expect(socket.frames('events')).not.toHaveLength(0) })
    const [ready] = socket.frames('events')
    expect(ready).toMatchObject({ type: 'item', value: { type: 'ready', host: { home: '/home/fixture' } } })
    const clientId = (ready?.value as { readonly clientId?: unknown } | undefined)?.clientId
    expect(typeof clientId).toBe('string')
    await expect(rpc(ctx, '$events/result', { clientId, eventId: 'missing', outcome: { kind: 'next' } }))
      .resolves.toEqual({ ok: true })
    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })
    await socket.close()
    await unregister()

    expect(seen).toEqual(['guard/passthrough'])
  })

  it('describes receiver selection and parameters as the descriptor declares them', async () => {
    const ctx = await mount()
    const seen = new Map<string, Pick<RemoteInvokeCall, 'invocation' | 'scope' | 'parameters'>>()
    ctx.on('remote/invoke', (call, next) => {
      seen.set(call.endpoint, { invocation: call.invocation, scope: call.scope, parameters: call.parameters })
      return next()
    })
    await ctx.typertGateway.invoke({
      namespace: 'guard', method: 'create', args: { agentId: 'agent-1', request: { title: 'a' } },
    })
    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'rename', args: { agentId: 'agent-1', request: { title: 'b' } } })
    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'read', args: { fileScopeId: 'notes.md' } })
    await ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })

    for (const endpoint of ['guard/create', 'guard/rename', 'guard/read']) {
      const descriptor = ctx.typert.local.get(endpoint)
      expect(seen.get(endpoint)?.invocation).toBe(descriptor?.invocation)
      expect(seen.get(endpoint)?.scope).toBe(descriptor?.scope)
      expect(seen.get(endpoint)?.parameters).toBe(descriptor?.parameters)
    }
    expect(seen.get('guard/create')).toMatchObject({
      invocation: { kind: 'direct' },
      scope: { context: 'remoteInvokeAgent', wire: 'agentId' },
    })
    expect(seen.get('guard/rename')).toMatchObject({
      invocation: { kind: 'context', context: 'remoteInvokeAgent', wire: 'agentId' },
      scope: undefined,
    })
    expect(seen.get('guard/read')).toMatchObject({
      invocation: { kind: 'direct' },
      scope: undefined,
      parameters: [{ source: 'lookup', lookup: 'remoteInvokeFile', wire: 'fileScopeId' }],
    })
    expect(seen.get('guard/passthrough')).toEqual({
      invocation: { kind: 'direct' },
      scope: undefined,
      parameters: [{ name: 'value', wire: 'value', source: 'json', codec: { mode: 'src-json' } }],
    })
  })

  it('lists exactly the method endpoints the /api carrier claims', async () => {
    const ctx = await mount()
    await registerStrict(ctx, strictOnly('retired', 'run'))()
    registerStrict(ctx, strictOnly('$events', 'result'))

    const listed = ctx.typertGateway.claimedEndpoints()
    expect(listed).toEqual(GUARD_ENDPOINTS)
    for (const endpoint of listed) expect(await httpStatus(ctx, endpoint)).toBe(200)
    expect(await httpStatus(ctx, 'retired/run')).toBe(200)
    expect(await httpStatus(ctx, '$events/result')).toBe(200)
    expect(await httpStatus(ctx, 'guard/absent')).toBe(404)
  })

  it('omits an SRC endpoint whose strict definition was withdrawn, which the carrier claims and no method answers', async () => {
    const ctx = await mount()
    await ctx.plugin(ClaimsService)
    expect(ctx.typertGateway.claimedEndpoints()).toContain('claims/withdrawn')
    await registerStrict(ctx, strictOnly('claims', 'withdrawn'))()

    expect(ctx.typertGateway.claimedEndpoints()).not.toContain('claims/withdrawn')
    expect(await httpStatus(ctx, 'claims/withdrawn')).toBe(200)
    await expect(rpc(ctx, 'claims/withdrawn', {})).resolves.toMatchObject({
      ok: false, error: { code: 'gateway/definition-unavailable', details: { endpoint: 'claims/withdrawn' } },
    })
    await expectRemoteCode(ctx.typertGateway.invoke({
      namespace: 'claims', method: 'withdrawn', args: {},
    }), 'gateway/definition-unavailable')
  })

  it('omits an SRC method whose name is not one endpoint segment, which the carrier does not claim', async () => {
    const ctx = await mount()
    await ctx.plugin(ClaimsService)

    expect(ctx.typertGateway.claimedEndpoints()).toEqual(['claims/withdrawn', ...GUARD_ENDPOINTS])
    expect(await httpStatus(ctx, 'claims/withdrawn')).toBe(200)
    expect(await httpStatus(ctx, 'claims/nested/name')).toBe(404)
  })
})

const GUARD_ENDPOINTS = [
  'guard/create', 'guard/fail', 'guard/feed', 'guard/follow', 'guard/passthrough', 'guard/read', 'guard/rename', 'guard/watch',
]

/** A strict definition whose Service is never mounted. */
function strictOnly(namespace: string, method: string): InvocationDescriptor {
  return {
    id: `@fixture/claims#${namespace}/${method}`,
    service: 'retired',
    namespace,
    method,
    invocation: { kind: 'direct' },
    parameters: [],
    result: { mode: 'src-json' },
  }
}

function registerStrict(ctx: Context, invocation: InvocationDescriptor): () => Promise<void> {
  return ctx.typert.register({
    package: `@fixture/claims-${invocation.namespace}`,
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: [invocation],
  })
}

function freshProbe(): Probe {
  return {
    calls: [],
    peers: [],
    wireArgs: [],
    stores: [],
    events: [],
    returns: 0,
    failure: undefined,
    followFailure: undefined,
    slowReturn: false,
  }
}

async function mount(): Promise<Context> {
  probe = freshProbe()
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
  await ctx.plugin(GuardService)
  ctx.typert.lookups.register('remoteInvokeAgent', {
    parameter: 'agent',
    wire: 'agentId',
    hostTypeSymbol: '@fixture/invoke#Agent',
    wireTypeSymbol: '@fixture/invoke#AgentId',
    resolve: id => id === 'agent-1' ? { id } : undefined,
  })
  ctx.typert.lookups.register('remoteInvokeFile', {
    parameter: 'file',
    wire: 'fileScopeId',
    hostTypeSymbol: '@fixture/invoke#File',
    wireTypeSymbol: '@fixture/invoke#FileScopeId',
    resolve: path => ({ path }),
  })
  ctx.typert.contexts.registerHost('remoteInvokeAgent', {
    wire: 'agentId',
    wireTypeSymbol: '@fixture/invoke#AgentId',
    resolve: id => id === 'agent-1' ? ctx : undefined,
  })
  ctx.typert.register({
    package: '@fixture/invoke',
    face: 'host',
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: guardDescriptors(),
  })
  return ctx
}

function guardDescriptors(): InvocationDescriptor[] {
  const strict = (typeSymbol: string, schema: z.ZodType): InvocationDescriptor['result'] =>
    ({ mode: 'strict', typeSymbol, create: () => schema })
  const agentId = strict('@fixture/invoke#AgentId', z.string())
  const request = {
    name: 'request',
    wire: 'request',
    source: 'json' as const,
    codec: strict('@fixture/invoke#Request', z.object({ title: z.string().transform(title => title.trim()) })),
  }
  const result = strict('@fixture/invoke#Result', z.unknown())
  const direct = { kind: 'direct' as const }
  return [
    {
      id: '@fixture/invoke#guard/create',
      service: 'guard',
      namespace: 'guard',
      method: 'create',
      invocation: direct,
      scope: { context: 'remoteInvokeAgent', wire: 'agentId' },
      parameters: [
        { name: 'agent', wire: 'agentId', source: 'lookup', lookup: 'remoteInvokeAgent', codec: agentId },
        request,
      ],
      result,
    },
    {
      id: '@fixture/invoke#guard/rename',
      service: 'guard',
      namespace: 'guard',
      method: 'rename',
      invocation: { kind: 'context', context: 'remoteInvokeAgent', wire: 'agentId', codec: agentId },
      parameters: [request],
      result,
    },
    {
      id: '@fixture/invoke#guard/read',
      service: 'guard',
      namespace: 'guard',
      method: 'read',
      invocation: direct,
      parameters: [{
        name: 'file',
        wire: 'fileScopeId',
        source: 'lookup',
        lookup: 'remoteInvokeFile',
        codec: strict('@fixture/invoke#FileScopeId', z.string()),
      }],
      result,
    },
  ]
}

interface RpcEnvelope {
  readonly ok: boolean
  readonly value?: unknown
  readonly error: { readonly code: string; readonly message: string; readonly details: object }
}

async function rpc(ctx: Context, endpoint: string, args: object): Promise<RpcEnvelope> {
  const response = await post(ctx, endpoint, { args })
  expect(response.status).toBe(200)
  const body = await response.json() as { readonly result: RpcEnvelope }
  return body.result
}

async function httpStatus(ctx: Context, endpoint: string): Promise<number> {
  const response = await post(ctx, endpoint, { args: {} })
  await response.arrayBuffer()
  return response.status
}

function post(ctx: Context, endpoint: string, payload: object): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(ctx.webServer.port)}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: browserCookie(ctx) },
    body: JSON.stringify({ type: 'client-request', rpcId: `rpc-${endpoint}`, method: endpoint, payload }),
  })
}

interface MuxClient {
  open(streamId: string, endpoint: string, args: object): void
  /** Frames received for one logical stream, in arrival order. */
  frames(streamId: string): Record<string, unknown>[]
  /** Settle once the stream has ended or failed. */
  ended(streamId: string): Promise<void>
  close(): Promise<void>
}

async function openSocket(ctx: Context): Promise<MuxClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${String(ctx.webServer.port)}/api/remote.mux`, {
    headers: { cookie: browserCookie(ctx) },
  })
  await once(socket, 'open')
  const received: Record<string, unknown>[] = []
  socket.on('message', (data) => { received.push(JSON.parse(text(data)) as Record<string, unknown>) })
  const frames = (streamId: string): Record<string, unknown>[] => received.filter(frame => frame.streamId === streamId)
  return {
    open: (streamId, endpoint, args) => {
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
    },
    frames,
    ended: streamId => vi.waitFor(() => {
      expect(frames(streamId).some(frame => frame.type === 'end' || frame.type === 'error')).toBe(true)
    }),
    close: async () => {
      socket.close()
      await once(socket, 'close')
    },
  }
}

function text(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString('utf8')
}

async function expectRemoteCode(promise: Promise<unknown>, code: string): Promise<RemoteError> {
  const error: unknown = await promise.then(() => undefined, (failure: unknown) => failure)
  expect(error).toBeInstanceOf(RemoteError)
  expect(error).toMatchObject({ code })
  return error as RemoteError
}

/** Yield the first `count` items as `item <index>`, then return the source. */
async function *firstItems(source: AsyncIterable<unknown>, count: number): AsyncGenerator<string> {
  let index = 0
  for await (const item of source) {
    expect(item).toMatchObject({ index })
    yield `item ${String(index)}`
    if (++index === count) return
  }
}

/** Pull every item of `source`, and return it, through `enter`. */
function pullInside(
  source: AsyncIterable<unknown>,
  enter: (pull: () => Promise<IteratorResult<unknown>>) => Promise<IteratorResult<unknown>>,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = source[Symbol.asyncIterator]()
      return {
        next: () => enter(() => iterator.next()),
        return: () => enter(() => iterator.return?.() ?? Promise.resolve({ done: true, value: undefined })),
      }
    },
  }
}

async function collect(source: AsyncIterable<unknown>): Promise<unknown[]> {
  const values: unknown[] = []
  for await (const value of source) values.push(value)
  return values
}

/** Hand the iterator of every stream outcome to `use`, then refuse the call. */
function discardWith(ctx: Context, use: (iterator: AsyncIterator<unknown>) => Promise<void>): void {
  ctx.on('remote/invoke', async (call, next) => {
    const outcome = await next()
    if (outcome.kind === 'stream') await use(outcome.source[Symbol.asyncIterator]())
    throw new RemoteError('gateway/forbidden', 'fixture: refused after next', { endpoint: call.endpoint })
  })
}

/** Open `follow` with a tracked uplink and expect the refusal `discardWith` throws. */
async function followRefused(ctx: Context): Promise<void> {
  await expectRemoteCode(ctx.typertGateway.stream({
    namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
  }), 'gateway/forbidden')
}

/** An uplink with no items that records, into the probe current when it is created, when the Gateway opens and returns it. */
function trackedUplink(): AsyncIterable<unknown> {
  const { events } = probe
  return {
    [Symbol.asyncIterator]: () => {
      events.push('uplink:iterator')
      return {
        next: () => Promise.resolve({ done: true as const, value: undefined }),
        return: () => {
          events.push('uplink:return')
          return Promise.resolve({ done: true as const, value: undefined })
        },
      }
    },
  }
}

async function *toAsync<T>(values: readonly T[]): AsyncIterable<T> {
  for (const value of values) yield value
}

async function *empty(): AsyncIterable<never> {}
