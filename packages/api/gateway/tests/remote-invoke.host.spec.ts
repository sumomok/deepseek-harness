/** The `remote/invoke` waterfall wraps every Remote method call on every carrier and is inert without listeners. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket, { type RawData } from 'ws'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { apply as applyConnection, inject as connectionInject, type ConnectionConfig } from '@deepseek-ai/dsh-client-connection'
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
  /** The signal each call's method observed. */
  readonly signals: (AbortSignal | undefined)[]
  /** Iterator steps of the stream methods and of the tracked uplink. */
  readonly events: string[]
  returns: number
  failure: Error | undefined
  /** Failure `follow` throws from its iterator factory, rejects its iterator's `next()` with, or throws from its `return()`. */
  followFailure: { readonly at: 'iterator' | 'next' | 'return'; readonly error: Error } | undefined
  /** Whether `follow`'s iterator `return()` settles only after a timer, then records `follow:returned`. */
  slowReturn: boolean
  /** Failure `stall`'s iterator `return()` rejects with. */
  stallReturnFailure: Error | undefined
  /** Run by `relay` when its call's signal aborts, after it delivers an item to each pending pull. */
  onAbort: (() => void) | undefined
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
            if (followFailure?.at === 'next') return Promise.reject(followFailure.error)
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

  /** A stream whose iterator's `next()` never settles; its `return()` settles at once, or rejects with `stallReturnFailure`. */
  @Remote({ mode: 'stream' })
  stall(): AsyncIterable<string> {
    this.observe('stall')
    const { events, stallReturnFailure } = probe
    return {
      [Symbol.asyncIterator]: () => {
        events.push('stall:iterator')
        return {
          next: () => {
            events.push('stall:next')
            return new Promise<IteratorResult<string>>(() => undefined)
          },
          return: () => {
            events.push('stall:return')
            if (stallReturnFailure !== undefined) return Promise.reject(stallReturnFailure)
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }
  }

  /** A stream whose first pull answers at once and whose later pulls never settle; its `return()` settles at once. */
  @Remote({ mode: 'stream' })
  snap(): AsyncIterable<string> {
    this.observe('snap')
    const { events } = probe
    let pulls = 0
    return {
      [Symbol.asyncIterator]: () => {
        events.push('snap:iterator')
        return {
          next: () => {
            events.push('snap:next')
            if (pulls++ === 0) return Promise.resolve({ done: false as const, value: 'snapshot' })
            return new Promise<IteratorResult<string>>(() => undefined)
          },
          return: () => {
            events.push('snap:return')
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }
  }

  /**
   * A stream whose pulls wait for its call's signal to abort. The abort listener, added when the method is called,
   * delivers an item to each pending pull and then runs `onAbort`; the iterator's `return()` settles at once.
   */
  @Remote({ mode: 'stream' })
  relay(): AsyncIterable<string> {
    this.observe('relay')
    const hooks = probe
    const pending: PromiseWithResolvers<IteratorResult<string>>[] = []
    this.ctx.invocation?.signal.addEventListener('abort', () => {
      hooks.events.push('relay:aborted')
      for (const pull of pending) pull.resolve({ done: false, value: 'late' })
      hooks.onAbort?.()
    }, { once: true })
    return {
      [Symbol.asyncIterator]: () => {
        hooks.events.push('relay:iterator')
        return {
          next: () => {
            hooks.events.push('relay:next')
            const pull = Promise.withResolvers<IteratorResult<string>>()
            pending.push(pull)
            return pull.promise
          },
          return: () => {
            hooks.events.push('relay:return')
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }
  }

  /** A generator suspended for good on a promise that ignores its signal, so its `return()` never settles. */
  @Remote({ mode: 'stream' })
  async *hold(): AsyncGenerator<string> {
    this.observe('hold')
    probe.events.push('hold:next')
    await new Promise<void>(() => undefined)
    yield 'unreachable'
  }

  /** A generator suspended until its call's signal aborts, which then yields once more. */
  @Remote({ mode: 'stream' })
  async *wait(): AsyncGenerator<string> {
    this.observe('wait')
    const { events } = probe
    const signal = this.ctx.invocation?.signal
    events.push('wait:next')
    try {
      await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      yield 'after abort'
    } finally {
      events.push('wait:finally')
    }
  }

  private observe(method: string): void {
    probe.calls.push(method)
    probe.peers.push(this.ctx.invocation?.peer)
    probe.wireArgs.push(this.ctx.invocation?.request.args)
    probe.stores.push(member.getStore())
    probe.signals.push(this.ctx.invocation?.signal)
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

  it('refuses every carrier with gateway/service-unavailable while member admission is on and nothing listens', async () => {
    const ctx = await mount()
    const member = ctx.connection.peers.open()
    const removeAdmitter = ctx.connection.peers.admitWith(() => member)
    const unavailable = { code: 'gateway/service-unavailable', details: { endpoint: 'guard/passthrough' } }

    await expect(rpc(ctx, 'guard/passthrough', { value: 1 })).resolves.toMatchObject({ ok: false, error: unavailable })
    await expectRemoteCode(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } }),
      'gateway/service-unavailable')
    await expectRemoteCode(ctx.typertGateway.stream({ namespace: 'guard', method: 'feed', args: { count: 1 } }),
      'gateway/service-unavailable')
    await expectRemoteCode(ctx.typertGateway.wireStream.open(
      'guard/feed', { args: { count: 1 } }, empty(), undefined, new AbortController().signal,
    ), 'gateway/service-unavailable')
    const socket = await openSocket(ctx)
    socket.open('feed', 'guard/feed', { count: 1 })
    await socket.ended('feed')
    expect(socket.frames('feed')).toMatchObject([{ type: 'error', error: { code: 'gateway/service-unavailable' } }])
    await socket.close()
    // Descriptor failures still precede the refusal.
    await expectRemoteCode(ctx.typertGateway.invoke({ namespace: 'guard', method: 'absent', args: {} }),
      'gateway/invocation-unavailable')
    expect(probe.calls).toEqual([])

    await removeAdmitter()
    await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 2 } })).resolves.toBe(2)
    expect(probe.calls).toEqual(['passthrough'])
  })

  it('answers a call with gateway/service-unavailable on a Host whose requireAdmitter is set and nothing listens', async () => {
    const ctx = await mount({ requireAdmitter: true })
    const side: Promise<unknown>[] = []
    const stop = ctx.on('internal/dispatch', (_mode, name, args: readonly unknown[]) => {
      if (name === 'remote/invoke') side.push((args.at(-1) as () => Promise<unknown>)().catch((error: unknown) => error))
    }, { global: true })
    await expectRemoteCode(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } }),
      'gateway/service-unavailable')
    // A call through the chain's first position meets the same refusal.
    expect(await Promise.all(side)).toMatchObject([{ code: 'gateway/service-unavailable' }])
    stop()
    ctx.on('remote/invoke', (_call, next) => next())
    await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 2 } })).resolves.toBe(2)
    expect(probe.calls).toEqual(['passthrough'])
  })

  describe('runs the chain below each listener at most once per call', () => {
    /** Refuse member `refused` on every endpoint and let every other Peer through. */
    const authorizer = (refused: PeerScope): InvokeListener => (call, next) => {
      if (call.peer === refused) throw new RemoteError('gateway/forbidden', 'fixture: member refused', { endpoint: call.endpoint })
      return next()
    }

    it('hands a retry after a refusal the refusal again, and the method never runs', async () => {
      const ctx = await mount()
      const member = ctx.connection.peers.open()
      ctx.connection.peers.admitWith(() => member)
      ctx.on('remote/invoke', authorizer(member))
      const caught: unknown[] = []
      ctx.on('remote/invoke', async (_call, next) => {
        try {
          return await next()
        } catch (error) {
          caught.push(error)
          return await next()
        }
      }, { prepend: true })

      await expect(rpc(ctx, 'guard/passthrough', { value: 'write' })).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      expect(caught).toHaveLength(1)
      expect(caught[0]).toMatchObject({ code: 'gateway/forbidden' })
      expect(probe.calls).toEqual([])
    })

    it('hands every call of one next() the first call\'s outcome, and runs the method once', async () => {
      const ctx = await mount()
      const outcomes: Promise<RemoteInvokeOutcome>[] = []
      ctx.on('remote/invoke', async (_call, next) => {
        outcomes.push(next(), next())
        await outcomes[0]
        outcomes.push(next())
        return next()
      })

      await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })).resolves.toBe(1)
      expect(new Set(outcomes).size).toBe(1)
      expect(probe.calls).toEqual(['passthrough'])
    })

    it('throws the first synchronous throw of a position again on every later call', async () => {
      const ctx = await mount()
      const refusal = new RemoteError('gateway/forbidden', 'fixture: thrown synchronously', { endpoint: 'guard/passthrough' })
      const thrown: unknown[] = []
      ctx.on('remote/invoke', (_call, next) => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            void next()
          } catch (error) {
            thrown.push(error)
          }
        }
        return next()
      })
      ctx.on('remote/invoke', () => { throw refusal })

      await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })).rejects.toBe(refusal)
      expect(thrown).toEqual([refusal, refusal])
      expect(probe.calls).toEqual([])
    })

    it('keeps call.peer fixed, so a listener before an authorizer cannot hand it another Peer', async () => {
      const ctx = await mount()
      const member = ctx.connection.peers.open()
      ctx.connection.peers.admitWith(() => member)
      const { operator } = ctx.connection
      const seen: PeerScope[] = []
      ctx.on('remote/invoke', (call, next) => {
        seen.push(call.peer)
        if (call.peer !== operator) {
          throw new RemoteError('gateway/forbidden', 'fixture: operator only', { endpoint: call.endpoint })
        }
        return next()
      })
      const written: boolean[] = []
      const redefined: boolean[] = []
      const deleted: boolean[] = []
      ctx.on('remote/invoke', (call, next) => {
        const other = call.peer === operator ? member : operator
        written.push(Reflect.set(call, 'peer', other))
        redefined.push(Reflect.defineProperty(call, 'peer', { value: other }))
        deleted.push(Reflect.deleteProperty(call, 'peer'))
        call.args = { value: 'replaced' }
        return next()
      }, { prepend: true })

      await expect(rpc(ctx, 'guard/passthrough', { value: 'write' })).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      expect(probe.calls).toEqual([])
      await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 'judged' } }))
        .resolves.toBe('replaced')
      expect(written).toEqual([false, false])
      expect(redefined).toEqual([false, false])
      expect(deleted).toEqual([false, false])
      expect(seen).toEqual([member, operator])
      expect(probe.peers).toEqual([operator])
      expect(probe.wireArgs).toEqual([{ value: 'replaced' }])
    })

    it('settles a call of the first position with an internal/dispatch listener\'s throw, and the method never runs', async () => {
      const ctx = await mount()
      const veto = new Error('fixture: vetoed by internal/dispatch')
      const entries: (() => Promise<unknown>)[] = []
      const early: Promise<unknown>[] = []
      const stopCapture = ctx.on('internal/dispatch', (_mode, name, args: readonly unknown[]) => {
        if (name !== 'remote/invoke') return
        const entry = args.at(-1) as () => Promise<unknown>
        entries.push(entry)
        early.push(entry().catch((error: unknown) => error))
      }, { global: true })
      const stopVeto = ctx.on('internal/dispatch', (_mode, name) => {
        if (name === 'remote/invoke') throw veto
      }, { global: true })
      ctx.on('remote/invoke', (_call, next) => next())

      await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } }))
        .rejects.toBe(veto)
      stopCapture()
      stopVeto()
      expect(await Promise.all(early)).toEqual([veto])
      await expect(entries[0]?.()).rejects.toBe(veto)
      expect(probe.calls).toEqual([])
    })

    it('hands an internal/dispatch listener the whole chain, so its call meets the refusal and the method never runs', async () => {
      const ctx = await mount()
      const member = ctx.connection.peers.open()
      ctx.connection.peers.admitWith(() => member)
      ctx.on('remote/invoke', authorizer(member))
      const side: Promise<unknown>[] = []
      ctx.on('internal/dispatch', (_mode, name, args: readonly unknown[]) => {
        if (name !== 'remote/invoke') return
        const entry = args.at(-1) as () => Promise<unknown>
        side.push(entry().catch((error: unknown) => error))
      }, { global: true })

      await expect(rpc(ctx, 'guard/passthrough', { value: 'write' })).resolves.toMatchObject({
        ok: false, error: { code: 'gateway/forbidden' },
      })
      expect(await Promise.all(side)).toMatchObject([{ code: 'gateway/forbidden' }])
      expect(probe.calls).toEqual([])
    })

    it('settles a call a position receives while its first call still runs with that first call\'s outcome', async () => {
      const ctx = await mount()
      let outer: (() => Promise<unknown>) | undefined
      ctx.on('remote/invoke', (_call, next) => {
        outer = next
        return next()
      })
      let reentered: Promise<unknown> | undefined
      ctx.on('remote/invoke', (_call, next) => {
        reentered = outer?.()
        return next()
      })

      await expect(ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 1 } })).resolves.toBe(1)
      await expect(reentered).resolves.toEqual({ kind: 'value', value: 1 })
      expect(probe.calls).toEqual(['passthrough'])
    })
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

  it('releases the uplink when the method iterator factory throws on the first pull', async () => {
    const ctx = await mount()
    const error = new Error('fixture: follow iterator failed')
    probe.followFailure = { at: 'iterator', error }
    const stream = await ctx.typertGateway.stream({
      namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
    })

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toBe(error)
    expect(probe.events).toEqual(['follow:iterator', 'uplink:iterator', 'uplink:return'])
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

  // The method opens one stream however often next() is called. The caller receives the listener's outcome, never the
  // release failure, without waiting for the method iterator's return(), which settles after a timer.
  it.each([
    { answer: 'throws', nexts: 1, releaseFails: undefined, code: 'gateway/forbidden' },
    { answer: 'returns a value', nexts: 1, releaseFails: undefined, code: 'gateway/result-invalid' },
    { answer: 'throws', nexts: 2, releaseFails: undefined, code: 'gateway/forbidden' },
    { answer: 'throws', nexts: 1, releaseFails: 'return', code: 'gateway/forbidden' },
    { answer: 'returns a value', nexts: 1, releaseFails: 'return', code: 'gateway/result-invalid' },
    { answer: 'throws', nexts: 1, releaseFails: 'iterator', code: 'gateway/forbidden' },
  ] as const)('returns the stream next() opened when a listener $answer after next() (next() calls: $nexts, release fails at: $releaseFails)', async ({ answer, nexts, releaseFails, code }) => {
    const ctx = await mount()
    probe.slowReturn = true
    if (releaseFails !== undefined) probe.followFailure = { at: releaseFails, error: new Error('fixture: follow failed') }
    ctx.on('remote/invoke', async (call, next): Promise<RemoteInvokeOutcome> => {
      for (let called = 0; called < nexts; called++) await next()
      if (answer === 'returns a value') return { kind: 'value', value: 'answered' }
      throw new RemoteError('gateway/forbidden', 'fixture: refused after next', { endpoint: call.endpoint })
    })
    const returned = {
      none: ['follow:iterator', 'follow:return', 'follow:returned'],
      return: ['follow:iterator', 'follow:return'],
      iterator: ['follow:iterator'],
    }[releaseFails ?? 'none']

    const unhandled = await unhandledRejections(async () => {
      await expectRemoteCode(ctx.typertGateway.stream({
        namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
      }), code)
      expect(probe.events).not.toContain('follow:returned')
      await vi.waitFor(() => {
        expect(probe.events).toEqual(['uplink:iterator', 'uplink:return', ...returned])
      })
    })
    expect(unhandled).toEqual([])
    expect(probe.calls).toEqual(['follow'])
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

  // The pull the listener discarded settles with a failure, which the Gateway handles; the Gateway aborts the method's
  // signal with the caller's failure and returns the uplink and the method's iterator without waiting for the method
  // to settle the pull.
  it.each(IN_PROCESS_ENTRIES.flatMap(entry => [
    { ...entry, answer: 'throws', code: 'gateway/forbidden' },
    { ...entry, answer: 'returns a value', code: 'gateway/result-invalid' },
  ] as const))('fails at once when a listener $answer while a pull it discarded is pending, through $entry', async ({ open, uplink, answer, code }) => {
    const ctx = await mount()
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused while a pull is pending', { endpoint: 'guard/stall' })
    failWhilePulling(ctx, () => {
      if (answer === 'returns a value') return { kind: 'value', value: 'answered' }
      throw refusal
    })

    const unhandled = await unhandledRejections(async () => {
      const failure = await settledWithin(open(ctx, 'stall'), 50)
      expect(failure).toMatchObject({ code })
      if (answer === 'throws') expect(failure).toBe(refusal)
      expect(probe.signals).toHaveLength(1)
      expect(probe.signals[0]?.reason).toBe(failure)
      await vi.waitFor(() => {
        expect(probe.events).toEqual([
          'stall:iterator', 'stall:next', ...uplink ? ['uplink:iterator', 'uplink:return'] : [], 'stall:return',
        ])
      })
    })
    expect(unhandled).toEqual([])
    expect(probe.calls).toEqual(['stall'])
  })

  // A pull can start while the call's failure is still reaching the Gateway: one queued a microtask after the listener
  // throws, or one a consumer the listener left running makes. The caller still fails at once and the stream is returned.
  it.each(IN_PROCESS_ENTRIES.flatMap(entry => FAILURE_WINDOWS.map(window => ({ ...entry, ...window }))))('fails at once and returns the stream on $window, through $entry', async ({ open, uplink, method, listener }) => {
    const ctx = await mount()
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused during a pull', { endpoint: `guard/${method}` })
    ctx.on('remote/invoke', listener(refusal))

    const unhandled = await unhandledRejections(async () => {
      await expect(settledWithin(open(ctx, method), 50)).resolves.toBe(refusal)
      await vi.waitFor(() => {
        expect(probe.events).toEqual(expect.arrayContaining([`${method}:return`, ...uplink ? ['uplink:return'] : []]))
      })
    })
    expect(unhandled).toEqual([])
    expect(probe.calls).toEqual([method])
  })

  it.each(FAILURE_WINDOWS)('sends the error frame at once and returns the stream on $window', async ({ method, listener }) => {
    const ctx = await mount()
    ctx.on('remote/invoke', listener(new RemoteError('gateway/forbidden', 'fixture: refused during a pull', { endpoint: `guard/${method}` })))
    const socket = await openSocket(ctx)

    const unhandled = await unhandledRejections(async () => {
      socket.open('s', `guard/${method}`, {})
      await socket.ended('s')
      expect(socket.frames('s')).toMatchObject([{ type: 'error', streamId: 's', error: { code: 'gateway/forbidden' } }])
      await vi.waitFor(() => { expect(probe.events).toContain(`${method}:return`) })
    })
    expect(unhandled).toEqual([])
    await socket.close()
  })

  // The discarded pull settles with the failure of the method iterator's return(), which the Gateway handles.
  it.each(IN_PROCESS_ENTRIES)('leaves no unhandled rejection when the method iterator rejects return() after a failed call, through $entry', async ({ open, uplink }) => {
    const ctx = await mount()
    probe.stallReturnFailure = new Error('fixture: stall return failed')
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused while a pull is pending', { endpoint: 'guard/stall' })
    failWhilePulling(ctx, () => { throw refusal })

    const unhandled = await unhandledRejections(async () => {
      await expect(settledWithin(open(ctx, 'stall'), 50)).resolves.toBe(refusal)
      await vi.waitFor(() => {
        expect(probe.events).toEqual([
          'stall:iterator', 'stall:next', ...uplink ? ['uplink:iterator', 'uplink:return'] : [], 'stall:return',
        ])
      })
    })
    expect(unhandled).toEqual([])
  })

  it.each([
    { answer: 'throws a RemoteError', error: { code: 'gateway/forbidden', message: 'fixture: refused while a pull is pending' } },
    { answer: 'throws an Error', error: { code: 'gateway/internal', message: 'fixture: failed while a pull is pending' } },
    { answer: 'returns a value', error: { code: 'gateway/result-invalid' } },
  ] as const)('sends the error frame at once when a listener $answer while a pull it discarded is pending', async ({ answer, error }) => {
    const ctx = await mount()
    failWhilePulling(ctx, () => {
      if (answer === 'returns a value') return { kind: 'value', value: 'answered' }
      if (answer === 'throws an Error') throw new Error('fixture: failed while a pull is pending')
      throw new RemoteError('gateway/forbidden', 'fixture: refused while a pull is pending', { endpoint: 'guard/stall' })
    })
    const socket = await openSocket(ctx)

    const unhandled = await unhandledRejections(async () => {
      socket.open('s', 'guard/stall', {})
      await socket.ended('s')
      expect(socket.frames('s')).toMatchObject([{ type: 'error', streamId: 's', error }])
      await vi.waitFor(() => { expect(probe.events).toEqual(['stall:iterator', 'stall:next', 'stall:return']) })
    })
    expect(unhandled).toEqual([])
    await socket.close()
  })

  // The Gateway handles only the pulls its release ends: one the method's own failure ended before the listener threw is
  // the listener's, although the Gateway releases the stream in the same run of the microtask queue.
  it('leaves to the listener the rejection of a discarded pull that the method failed before the call did', async () => {
    const ctx = await mount()
    const error = new Error('fixture: follow next failed')
    probe.followFailure = { at: 'next', error }
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused after a failed pull', { endpoint: 'guard/follow' })
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') void outcome.source[Symbol.asyncIterator]().next()
      for (let step = 0; step < 10; step++) await Promise.resolve()
      throw refusal
    })

    const unhandled = await unhandledRejections(async () => {
      await expect(ctx.typertGateway.stream({ namespace: 'guard', method: 'follow', args: { label: 'x' } })).rejects.toBe(refusal)
    })
    expect(unhandled).toHaveLength(1)
    expect(unhandled[0]).toBe(error)
    expect(probe.events).toEqual(['follow:iterator', 'follow:next', 'follow:return'])
  })

  it('rejects a pending pull with the failure the caller receives, for a listener that awaits it', async () => {
    const ctx = await mount()
    const failure = new Error('fixture: failed while a pull is pending')
    let pull: Promise<IteratorResult<unknown>> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') pull = outcome.source[Symbol.asyncIterator]().next()
      throw failure
    })

    await expect(settledWithin(ctx.typertGateway.stream({ namespace: 'guard', method: 'stall', args: {} }), 50)).resolves.toBe(failure)
    await expect(pull).rejects.toBe(failure)
  })

  // A generator's `return()` waits behind its pending `next()`: `hold` ignores its aborted signal and never returns, so
  // only the uplink is released and the pull stays pending; `wait` ends on it, so the pull settles with the failure.
  // Neither delays the caller or the disposal of the Context.
  it.each([
    { method: 'hold', settled: 'pending', events: ['hold:next', 'uplink:iterator', 'uplink:return'] },
    { method: 'wait', settled: 'refusal', events: ['uplink:iterator', 'uplink:return', 'wait:finally', 'wait:next'] },
  ] as const)('fails at once while a pull waits on a generator, and disposes without it ($method)', async ({ method, settled, events }) => {
    const ctx = await mount()
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused while a pull is pending', { endpoint: `guard/${method}` })
    let pull: Promise<unknown> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') pull = outcome.source[Symbol.asyncIterator]().next().then(result => result, (error: unknown) => error)
      throw refusal
    })

    await expect(settledWithin(ctx.typertGateway.stream({
      namespace: 'guard', method, args: {}, uplink: trackedUplink(),
    }), 50)).resolves.toBe(refusal)
    expect(probe.signals[0]?.reason).toBe(refusal)
    await vi.waitFor(() => { expect([...probe.events].sort()).toEqual(events) })
    await expect(settledWithin(pull ?? Promise.resolve('no pull'), 50)).resolves.toBe(settled === 'pending' ? 'pending' : refusal)
    expect(probe.calls).toEqual([method])
    roots.splice(roots.indexOf(ctx), 1)
    await expect(settledWithin(ctx.fiber.dispose(), 1000)).resolves.not.toBe('pending')
  })

  it('disposes without a stream it still returns after sending the error frame', async () => {
    const ctx = await mount()
    failWhilePulling(ctx, () => {
      throw new RemoteError('gateway/forbidden', 'fixture: refused while a pull is pending', { endpoint: 'guard/hold' })
    })
    const socket = await openSocket(ctx)
    socket.open('s', 'guard/hold', {})
    await socket.ended('s')

    roots.splice(roots.indexOf(ctx), 1)
    await expect(settledWithin(ctx.fiber.dispose(), 1000)).resolves.not.toBe('pending')
    expect(probe.events).toEqual(['hold:next'])
  })

  // `relay` delivers an item to the pending pull from its abort listener, which runs before the stream's own.
  it('rejects with the failure a pending pull whose item the method delivers as the call fails', async () => {
    const ctx = await mount()
    const failure = new Error('fixture: failed while a pull is pending')
    let pull: Promise<unknown> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') pull = outcome.source[Symbol.asyncIterator]().next().then(result => result, (error: unknown) => error)
      throw failure
    })

    await expect(settledWithin(ctx.typertGateway.stream({ namespace: 'guard', method: 'relay', args: {} }), 50)).resolves.toBe(failure)
    await expect(pull).resolves.toBe(failure)
    expect(probe.events).toEqual(['relay:iterator', 'relay:next', 'relay:aborted', 'relay:return'])
  })

  // `relay`'s abort listener runs while the Gateway releases the call, so a pull made there reaches the stream after the
  // call failed and before the Gateway returns it.
  it.each(['awaits', 'discards'] as const)('rejects with the failure a pull made after the call failed, which the listener %s', async (use) => {
    const ctx = await mount()
    const failure = new Error('fixture: failed before a pull')
    let late: Promise<unknown> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') {
        const iterator = outcome.source[Symbol.asyncIterator]()
        probe.onAbort = () => {
          const pull = iterator.next()
          if (use === 'awaits') late = pull.then(result => result, (error: unknown) => error)
        }
      }
      throw failure
    })

    const unhandled = await unhandledRejections(async () => {
      await expect(settledWithin(ctx.typertGateway.stream({ namespace: 'guard', method: 'relay', args: {} }), 50))
        .resolves.toBe(failure)
      await vi.waitFor(() => { expect(probe.events).toEqual(['relay:aborted', 'relay:iterator', 'relay:return']) })
    })
    expect(unhandled).toEqual([])
    if (use === 'awaits') await expect(late).resolves.toBe(failure)
  })

  // A pull made from an abort listener of the method's signal is the stream's first, so it opens the method's iterator.
  it('releases the uplink when the method iterator factory throws on a first pull made as the call fails', async () => {
    const ctx = await mount()
    probe.followFailure = { at: 'iterator', error: new Error('fixture: follow iterator failed') }
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused before a first pull', { endpoint: 'guard/follow' })
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') {
        const iterator = outcome.source[Symbol.asyncIterator]()
        probe.signals[0]?.addEventListener('abort', () => { void iterator.next() }, { once: true })
      }
      throw refusal
    })

    const unhandled = await unhandledRejections(async () => {
      await expect(ctx.typertGateway.stream({
        namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
      })).rejects.toBe(refusal)
      await vi.waitFor(() => { expect(probe.events).toEqual(['follow:iterator', 'uplink:iterator', 'uplink:return']) })
    })
    expect(unhandled).toEqual([])
  })

  // A microtask queued from `relay`'s abort listener runs after the Gateway's release step, which calls `return()` on
  // the stream in the same synchronous step as the abort, so the pull it makes queues behind that `return()`.
  it('settles as done a pull made after the Gateway returned the stream of a failed call', async () => {
    const ctx = await mount()
    const failure = new Error('fixture: failed before a queued pull')
    let late: Promise<unknown> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') {
        const iterator = outcome.source[Symbol.asyncIterator]()
        probe.onAbort = () => {
          queueMicrotask(() => { late = iterator.next().then(result => result, (error: unknown) => error) })
        }
      }
      throw failure
    })

    await expect(ctx.typertGateway.stream({ namespace: 'guard', method: 'relay', args: {} })).rejects.toBe(failure)
    await vi.waitFor(() => { expect(late).toBeDefined() })
    await expect(late).resolves.toEqual({ done: true, value: undefined })
    expect(probe.events).toEqual(['relay:aborted', 'relay:iterator', 'relay:return'])
  })

  // `abort()` would replace `undefined` with an AbortError; the caller still receives what the listener threw.
  it('ends a pending pull with a Gateway Error when a listener throws undefined', async () => {
    const ctx = await mount()
    let pull: Promise<unknown> | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') pull = outcome.source[Symbol.asyncIterator]().next().then(result => result, (error: unknown) => error)
      throw undefined
    })

    await expect(ctx.typertGateway.stream({ namespace: 'guard', method: 'stall', args: {} })
      .then(() => 'resolved', (failure: unknown) => ({ failure }))).resolves.toEqual({ failure: undefined })
    const failure = await pull
    expect(failure).not.toBeInstanceOf(DOMException)
    expect(failure).toMatchObject({ message: 'typert gateway: guard/stall: a remote/invoke listener failed the call with undefined' })
    expect(probe.signals[0]?.reason).toBe(failure)
  })

  // A `next()` called once the caller has the waterfall's outcome reaches neither the method nor a stream to release:
  // a first call rejects, and a repeated call returns the outcome of the listener's first call.
  it.each([
    { mode: 'unary', ends: 'refuses', calls: [] },
    { mode: 'unary', ends: 'answers', calls: ['passthrough'] },
    { mode: 'stream', ends: 'refuses', calls: [] },
    { mode: 'stream', ends: 'answers', calls: ['watch'] },
  ] as const)('answers a next() called after a $mode waterfall that $ends has ended without running the method', async ({ mode, ends, calls }) => {
    const ctx = await mount()
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused before a late next()', {
      endpoint: `guard/${mode === 'unary' ? 'passthrough' : 'watch'}`,
    })
    const late = Promise.withResolvers<unknown>()
    let first: RemoteInvokeOutcome | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      setTimeout(() => { next().then(late.resolve, late.resolve) })
      if (ends === 'refuses') throw refusal
      first = await next()
      return first
    })

    const caller = mode === 'unary'
      ? ctx.typertGateway.invoke({ namespace: 'guard', method: 'passthrough', args: { value: 'p' } })
      : ctx.typertGateway.stream({ namespace: 'guard', method: 'watch', args: { label: 'w' } }).then(collect)
    if (ends === 'refuses') await expect(caller).rejects.toBe(refusal)
    else await expect(caller).resolves.toEqual(mode === 'unary' ? 'p' : ['w'])
    if (ends === 'refuses') {
      await expect(late.promise).resolves.toMatchObject({
        message: `remote/invoke: next() for guard/${mode === 'unary' ? 'passthrough' : 'watch'} was called after the waterfall ended`,
      })
    } else {
      expect(await late.promise).toBe(first)
    }
    expect(probe.calls).toEqual(calls)
  })

  it('answers a next() a method abort listener calls while the Gateway releases the failed call with the first outcome', async () => {
    const ctx = await mount()
    const failure = new Error('fixture: failed before a reentrant next()')
    const late = Promise.withResolvers<unknown>()
    let first: RemoteInvokeOutcome | undefined
    ctx.on('remote/invoke', async (_call, next) => {
      first = await next()
      probe.onAbort = () => { next().then(late.resolve, late.resolve) }
      throw failure
    })

    await expect(ctx.typertGateway.stream({ namespace: 'guard', method: 'relay', args: {} })).rejects.toBe(failure)
    expect(await late.promise).toBe(first)
    expect(probe.calls).toEqual(['relay'])
  })

  it('returns a stream whose pulled item arrived without making the caller wait for that return', async () => {
    const ctx = await mount()
    probe.slowReturn = true
    const refusal = new RemoteError('gateway/forbidden', 'fixture: refused after a pull', { endpoint: 'guard/follow' })
    ctx.on('remote/invoke', async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') await expect(outcome.source[Symbol.asyncIterator]().next()).resolves.toEqual({ done: false, value: 'x' })
      throw refusal
    })

    await expect(ctx.typertGateway.stream({
      namespace: 'guard', method: 'follow', args: { label: 'x' }, uplink: trackedUplink(),
    })).rejects.toBe(refusal)
    expect(probe.events).not.toContain('follow:returned')
    await vi.waitFor(() => {
      expect(probe.events).toEqual([
        'follow:iterator', 'follow:next', 'uplink:iterator', 'uplink:return', 'follow:return', 'follow:returned',
      ])
    })
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
  'guard/create', 'guard/fail', 'guard/feed', 'guard/follow', 'guard/hold', 'guard/passthrough', 'guard/read', 'guard/relay',
  'guard/rename', 'guard/snap', 'guard/stall', 'guard/wait', 'guard/watch',
]

/** The in-process stream entry points, opening a `guard` stream method that takes no arguments. */
const IN_PROCESS_ENTRIES: readonly {
  readonly entry: string
  readonly uplink: boolean
  readonly open: (ctx: Context, method: string) => Promise<AsyncIterable<unknown>>
}[] = [
  {
    entry: 'stream() with an uplink',
    uplink: true,
    open: (ctx, method) => ctx.typertGateway.stream({ namespace: 'guard', method, args: {}, uplink: trackedUplink() }),
  },
  {
    entry: 'stream() without an uplink',
    uplink: false,
    open: (ctx, method) => ctx.typertGateway.stream({ namespace: 'guard', method, args: {} }),
  },
  {
    entry: 'wireStream.open()',
    uplink: true,
    open: (ctx, method) => ctx.typertGateway.wireStream.open(
      `guard/${method}`, { args: {} }, trackedUplink(), undefined, new AbortController().signal,
    ),
  },
]

/**
 * Listeners that fail a stream call while a pull of its stream outcome can still start: a pull of `stall` queued to run
 * after the listener throws, and a consumer of `snap`, whose second pull never settles, left running while the listener
 * throws five microtasks later.
 */
const FAILURE_WINDOWS: readonly {
  readonly window: string
  readonly method: string
  readonly listener: (refusal: RemoteError) => InvokeListener
}[] = [
  {
    window: 'a pull queued after the listener throws',
    method: 'stall',
    listener: refusal => async (_call, next) => {
      const outcome = await next()
      void Promise.resolve().then(() => undefined).then(() => {
        if (outcome.kind === 'stream') void outcome.source[Symbol.asyncIterator]().next().catch(() => undefined)
      })
      throw refusal
    },
  },
  {
    window: 'a consumer left pulling while the listener throws',
    method: 'snap',
    listener: refusal => async (_call, next) => {
      const outcome = await next()
      if (outcome.kind === 'stream') void consume(outcome.source)
      for (let step = 0; step < 5; step++) await Promise.resolve()
      throw refusal
    },
  },
]

/** Pull `source` until it ends or fails, recording each item as `consumer:item`. */
async function consume(source: AsyncIterable<unknown>): Promise<void> {
  const iterator = source[Symbol.asyncIterator]()
  try {
    while ((await iterator.next()).done !== true) probe.events.push('consumer:item')
  } catch (_failure) {
    // The failure of the call that opened `source` ends the pending pull; the listener already failed the call.
  }
}

/** Answer each stream call by pulling one item of its stream outcome, discarding that pull, and then failing. */
function failWhilePulling(ctx: Context, fail: () => RemoteInvokeOutcome): void {
  ctx.on('remote/invoke', async (_call, next) => {
    const outcome = await next()
    if (outcome.kind === 'stream') void outcome.source[Symbol.asyncIterator]().next()
    return fail()
  })
}

/** Settle to the value or rejection reason of `promise`, or to `'pending'` once `ms` have passed. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise.then(value => value, (error: unknown) => error),
      new Promise((resolve) => { timer = setTimeout(resolve, ms, 'pending') }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/** Run `use`, let two macrotasks pass, and collect each unhandled rejection the process reported meanwhile. */
async function unhandledRejections(use: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = []
  const record = (reason: unknown): void => { reasons.push(reason) }
  process.on('unhandledRejection', record)
  try {
    await use()
    // Node reports a rejection as unhandled once the microtask queue has drained after it.
    await new Promise((resolve) => { setImmediate(resolve) })
    await new Promise((resolve) => { setImmediate(resolve) })
  } finally {
    process.off('unhandledRejection', record)
  }
  return reasons
}

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
    signals: [],
    events: [],
    returns: 0,
    failure: undefined,
    followFailure: undefined,
    slowReturn: false,
    stallReturnFailure: undefined,
    onAbort: undefined,
  }
}

async function mount(connectionConfig?: ConnectionConfig): Promise<Context> {
  probe = freshProbe()
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  await ctx.plugin({ inject: [...connectionInject], apply: applyConnection }, connectionConfig)
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
