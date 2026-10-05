/** `connection/fetch`: the waterfall in front of exact Fetch routes and dedicated RPC channels, and their listings. */
import { request as httpRequest } from 'node:http'
import { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  API_PATH,
  RpcId,
  apply,
  inject,
  type ClientRequest,
  type ConnectionFetchCall,
  type ConnectionRpcHandler,
  type PeerScope,
} from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const roots: Context[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

const CHANNEL = '/guard-rpc'
const EXACT = `${API_PATH}/guard.exact`
const INTERCEPTED = 'guard/intercepted'

interface Mounted {
  readonly ctx: Context
  readonly port: number
  readonly cookie: string
  /** Peers and bodies the exact route and the channel handler received, in arrival order. */
  readonly reached: Array<{ readonly kind: 'exact-route' | 'channel' | 'interceptor'; readonly peer: PeerScope; readonly body?: string }>
  /** `warn`-level log lines, where the webserver records a request whose handling threw. */
  readonly warnings: string[]
}

async function mount(channelHandler?: ConnectionRpcHandler): Promise<Mounted> {
  const ctx = new Context()
  roots.push(ctx)
  const warnings: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])) },
  })
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...inject], apply })
  const reached: Mounted['reached'][number][] = []
  ctx.connection.fetch.register({
    path: EXACT,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request, peer) => {
      reached.push({ kind: 'exact-route', peer, body: await request.text() })
      return new Response('exact')
    },
  })
  ctx.connection.rpc.handle(CHANNEL, channelHandler ?? (async (_endpoint, payload, _signal, peer) => {
    reached.push({ kind: 'channel', peer, body: JSON.stringify(payload) })
    return { ok: true, value: 'channel' }
  }))
  ctx.connection.rpc.intercept(API_PATH, endpoint => endpoint === INTERCEPTED, async (_endpoint, _payload, _signal, peer) => {
    reached.push({ kind: 'interceptor', peer })
    return { ok: true, value: 'intercepted' }
  })
  return { ctx, port: ctx.webServer.port, cookie: browserCookie(ctx), reached, warnings }
}

/** Exchange the process token for the loopback authority's Cookie header. */
function browserCookie(ctx: Context): string {
  const target = new URL(ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`))
  let setCookie: string | undefined
  ctx.connection.authorizeIndex(
    { method: 'GET', url: `${target.pathname}${target.search}`, headers: { host: target.host } },
    { writeHead(_status, headers) { setCookie = headers?.['set-cookie'] }, end() {} },
  )
  if (setCookie === undefined) throw new Error('fetch-guard fixture did not receive a browser cookie')
  return setCookie.split(';', 1)[0]!
}

interface Answer {
  readonly status: number
  readonly body: string
}

function send(mounted: Mounted, path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: mounted.port,
      path,
      method,
      headers: { cookie: mounted.cookie, ...headers },
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
      response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }) })
    })
    request.on('error', reject)
    request.end(body)
  })
}

function envelope(method: string, payload: unknown = { hello: 'world' }): string {
  const message: ClientRequest = { type: 'client-request', rpcId: RpcId('guard'), method, payload }
  return JSON.stringify(message)
}

const JSON_HEADERS = { 'content-type': 'application/json' }

const callChannel = (mounted: Mounted, headers: Record<string, string> = {}): Promise<Answer> =>
  send(mounted, `${CHANNEL}/guard/check`, 'POST', { ...JSON_HEADERS, ...headers }, envelope('guard/check'))

/** A Response whose unread body records whether it was cancelled. */
function trackedResponse(text = 'route body'): { readonly response: Response; readonly cancelled: () => boolean } {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
    cancel() { cancelled = true },
  })
  return { response: new Response(body), cancelled: () => cancelled }
}

/** Run `body`, then wait 20ms, and return the reasons of the unhandled rejections Node reported meanwhile. */
async function unhandledRejectionsDuring(body: () => Promise<void>): Promise<unknown[]> {
  const reasons: unknown[] = []
  const record = (reason: unknown): void => { reasons.push(reason) }
  process.on('unhandledRejection', record)
  try {
    await body()
    await new Promise(resolve => setTimeout(resolve, 20))
  } finally {
    process.off('unhandledRejection', record)
  }
  return reasons
}

/** Register one exact route on a bare Connection and return its shared Fetch handler. */
async function bareRoute(fetch: (request: Request, peer: PeerScope) => Promise<Response>): Promise<{
  readonly ctx: Context
  readonly fetch: (request?: Request) => Promise<Response>
}> {
  const ctx = new Context()
  roots.push(ctx)
  provideBrowserCredentials(ctx)
  await ctx.plugin({ inject: [...inject], apply })
  ctx.connection.fetch.register({ path: EXACT, methods: ['GET', 'POST'], requestBody: 'buffered', fetch })
  const shared = ctx.connection.createSharedFetchHandler(API_PATH)
  return { ctx, fetch: request => shared.fetch(request ?? new Request(`http://127.0.0.1${EXACT}`)) }
}

describe('connection/fetch', () => {
  it('runs before every exact route and dedicated channel, but not before the /api interceptor', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const calls: ConnectionFetchCall[] = []
    mounted.ctx.on('connection/fetch', async (call, next) => {
      calls.push(call)
      return next()
    })

    expect(await send(mounted, `${EXACT}?q=1`, 'GET')).toEqual({ status: 200, body: 'exact' })
    expect(await callChannel(mounted)).toMatchObject({ status: 200 })
    expect(await send(mounted, `${API_PATH}/${INTERCEPTED}`, 'POST', JSON_HEADERS, envelope(INTERCEPTED)))
      .toMatchObject({ status: 200 })

    expect(calls.map(call => [call.kind, call.path, call.method, new URL(call.request.url).pathname])).toEqual([
      ['exact-route', EXACT, 'GET', EXACT],
      ['channel', CHANNEL, 'POST', `${CHANNEL}/guard/check`],
    ])
    expect(new URL(calls[0]!.request.url).search).toBe('?q=1')
    for (const call of calls) expect(call.peer).toBe(connection.operator)
    expect(mounted.reached.map(entry => entry.kind)).toEqual(['exact-route', 'channel', 'interceptor'])
  })

  it('lets a listener refuse without reaching the route or the channel', async () => {
    const mounted = await mount()
    mounted.ctx.on('connection/fetch', async () => new Response('refused by guard', { status: 403 }))

    expect(await send(mounted, EXACT, 'GET')).toEqual({ status: 403, body: 'refused by guard' })
    expect(await callChannel(mounted)).toEqual({ status: 403, body: 'refused by guard' })
    // A request below the channel that the channel itself would answer 404 reaches the listener too.
    expect(await send(mounted, `${CHANNEL}/guard/check`, 'GET')).toEqual({ status: 403, body: 'refused by guard' })
    expect(mounted.reached).toEqual([])
  })

  it('answers next() with 404 when the route the request matched is no longer registered, without running a route', async () => {
    const ctx = new Context()
    roots.push(ctx)
    provideBrowserCredentials(ctx)
    await ctx.plugin({ inject: [...inject], apply })
    const unloaded = vi.fn(async () => new Response('unloaded route'))
    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => {
        pluginCtx.connection.fetch.register({ path: EXACT, methods: ['GET'], requestBody: 'buffered', fetch: unloaded })
      },
    })
    await owner
    let whileListenerWaits: () => Promise<unknown> = () => owner.dispose()
    ctx.on('connection/fetch', async (_call, next) => {
      await whileListenerWaits()
      return next()
    })
    const shared = ctx.connection.createSharedFetchHandler(API_PATH)
    const get = async (): Promise<readonly [number, string]> => {
      const response = await shared.fetch(new Request(`http://127.0.0.1${EXACT}`))
      return [response.status, await response.text()]
    }

    expect(await get()).toEqual([404, 'not found'])
    expect(unloaded).not.toHaveBeenCalled()

    // A route registered again at the same path while the listener waits is not the one the request matched.
    const removed = vi.fn(async () => new Response('removed route'))
    const replacement = vi.fn(async () => new Response('replacement route'))
    const remove = ctx.connection.fetch.register({ path: EXACT, methods: ['GET'], requestBody: 'buffered', fetch: removed })
    whileListenerWaits = async () => {
      await remove()
      ctx.connection.fetch.register({ path: EXACT, methods: ['GET'], requestBody: 'buffered', fetch: replacement })
    }
    expect(await get()).toEqual([404, 'not found'])
    expect(removed).not.toHaveBeenCalled()
    expect(replacement).not.toHaveBeenCalled()
    whileListenerWaits = async () => undefined
    expect(await get()).toEqual([200, 'replacement route'])
  })

  it('hands the listener the Peer each request was admitted as, per path', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    const first = connection.peers.open()
    const second = connection.peers.open()
    connection.peers.admitWith((request) => {
      const member = (request.headers as Record<string, string | undefined>)['x-member']
      return member === 'first' ? first : member === 'second' ? second : 401
    })
    const seen: Array<readonly [ConnectionFetchCall['kind'], PeerScope]> = []
    mounted.ctx.on('connection/fetch', (call, next) => {
      seen.push([call.kind, call.peer])
      return next()
    })

    expect((await send(mounted, EXACT, 'GET', { 'x-member': 'first' })).status).toBe(200)
    expect((await callChannel(mounted, { 'x-member': 'second' })).status).toBe(200)
    expect((await send(mounted, EXACT, 'GET', { 'x-member': 'second' })).status).toBe(200)
    expect((await callChannel(mounted, { 'x-member': 'first' })).status).toBe(200)

    expect(seen).toEqual([['exact-route', first], ['channel', second], ['exact-route', second], ['channel', first]])
    expect(mounted.reached.map(entry => entry.peer)).toEqual([first, second, second, first])
    // A carrier that dispatches the shared handler directly, naming no Peer, speaks for the operator.
    await connection.createSharedFetchHandler(API_PATH).fetch(new Request(`http://127.0.0.1${EXACT}`))
    expect(seen.at(-1)).toEqual(['exact-route', connection.operator])
  })

  it('leaves the request body to the route when a listener reads a clone', async () => {
    const mounted = await mount()
    const streamed: string[] = []
    mounted.ctx.connection.fetch.register({
      path: `${API_PATH}/guard.stream`,
      methods: ['POST'],
      requestBody: 'streaming',
      fetch: async (request) => {
        streamed.push(await request.text())
        return new Response('streamed')
      },
    })
    const read: string[] = []
    mounted.ctx.on('connection/fetch', async (call, next) => {
      read.push(await call.request.clone().text())
      return next()
    })

    expect((await send(mounted, EXACT, 'POST', { 'content-type': 'text/plain' }, 'exact payload')).status).toBe(200)
    expect((await callChannel(mounted)).status).toBe(200)
    expect(await send(mounted, `${API_PATH}/guard.stream`, 'POST', {}, 'streamed payload'))
      .toEqual({ status: 200, body: 'streamed' })

    expect(read).toEqual(['exact payload', envelope('guard/check'), 'streamed payload'])
    expect(mounted.reached.map(entry => entry.body)).toEqual(['exact payload', JSON.stringify({ hello: 'world' })])
    expect(streamed).toEqual(['streamed payload'])
  })

  it('leaves a route or channel an unusable body when a listener consumes the request body itself', async () => {
    const mounted = await mount()
    mounted.ctx.on('connection/fetch', async (call, next) => {
      await call.request.text()
      return next()
    })

    // The exact route's read throws, so the carrier answers as for any throwing route.
    expect(await send(mounted, EXACT, 'POST', { 'content-type': 'text/plain' }, 'exact payload')).toEqual({ status: 400, body: '' })
    expect(mounted.warnings).toEqual(['TypeError: Body is unusable: Body has already been read'])
    expect(await callChannel(mounted)).toEqual({ status: 400, body: 'body is not JSON' })
    expect(mounted.reached).toEqual([])
    expect(mounted.warnings).toHaveLength(1)
  })

  it('returns the route Response itself, body untouched, when no listener is registered', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)

    const response = await route.fetch()
    expect(response).toBe(tracked.response)
    expect(await response.text()).toBe('route body')
    expect(tracked.cancelled()).toBe(false)
  })

  it('cancels the body of a route Response the listener did not return: at once when its answer has no body', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    route.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return new Response(null, { status: 403 })
    })

    const response = await route.fetch()
    expect(response.status).toBe(403)
    expect(tracked.cancelled()).toBe(true)
  })

  it('cancels the body of a route Response the listener did not return once the caller has read its answer', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    route.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return new Response('refused after inspection', { status: 403, statusText: 'Refused', headers: { 'x-guard': 'refused' } })
    })

    const response = await route.fetch()
    expect([response.status, response.statusText, response.headers.get('x-guard')]).toEqual([403, 'Refused', 'refused'])
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(tracked.cancelled()).toBe(false)
    expect(await response.text()).toBe('refused after inspection')
    expect(tracked.cancelled()).toBe(true)
  })

  it('cancels the body of a route Response the listener did not return when the caller cancels its answer', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    route.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return new Response('refused after inspection', { status: 403 })
    })

    const response = await route.fetch()
    expect(tracked.cancelled()).toBe(false)
    await response.body!.cancel()
    expect(tracked.cancelled()).toBe(true)
  })

  it('cancels the body of a route Response the listener did not return when its answer fails while the caller reads it', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    route.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return new Response(new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new Error('answer failed')) } }))
    })

    const response = await route.fetch()
    expect(tracked.cancelled()).toBe(false)
    await expect(response.text()).rejects.toThrow('answer failed')
    expect(tracked.cancelled()).toBe(true)
  })

  it('returns a listener answer whose body is already locked as it is, and cancels the route body at once', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    const answer = new Response('locked answer', { status: 403 })
    answer.body!.getReader()
    route.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return answer
    })

    expect(await route.fetch()).toBe(answer)
    expect(tracked.cancelled()).toBe(true)
  })

  describe('hands the caller the whole route body through a listener that relays it lazily', () => {
    async function* relay(body: ReadableStream<Uint8Array<ArrayBuffer>>): AsyncGenerator<Uint8Array<ArrayBuffer>> {
      for await (const chunk of body) yield chunk
    }
    // The DOM typings that `Response` takes omit `ReadableStream.from`, and Node's web-stream typings differ from them.
    const streamFrom = (body: ReadableStream<Uint8Array<ArrayBuffer>>): ReadableStream<Uint8Array<ArrayBuffer>> =>
      NodeReadableStream.from(relay(body)) as ReadableStream<Uint8Array<ArrayBuffer>>
    const relays: ReadonlyArray<readonly [string, (body: ReadableStream<Uint8Array<ArrayBuffer>>) => Response]> = [
      ['ReadableStream.from(asyncGenerator)', body => new Response(streamFrom(body))],
      // Node's Response accepts an async iterable body, which the DOM typings omit.
      ['new Response(asyncGenerator)', body => new Response(relay(body) as AsyncIterable<Uint8Array> as BodyInit)],
      ['a stream that takes the reader in pull()', (body) => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
        return new Response(new ReadableStream<Uint8Array>({
          async pull(controller) {
            reader ??= body.getReader()
            const chunk = await reader.read()
            if (chunk.done) controller.close()
            else controller.enqueue(chunk.value)
          },
        }, { highWaterMark: 0 }))
      }],
    ]
    for (const [writing, relayed] of relays) {
      it(writing, async () => {
        const route = await bareRoute(async () => new Response('route body over the relay'))
        route.ctx.on('connection/fetch', async (_call, next) => relayed((await next()).body!))

        const response = await route.fetch()
        expect([response.status, await response.text()]).toEqual([200, 'route body over the relay'])
      })
    }

    it('and reads the route body no earlier than the caller reads', async () => {
      let pulled = false
      const route = await bareRoute(async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled = true
          controller.enqueue(new TextEncoder().encode('read on demand'))
          controller.close()
        },
      }, { highWaterMark: 0 })))
      route.ctx.on('connection/fetch', async (_call, next) => new Response(streamFrom((await next()).body!)))

      const response = await route.fetch()
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(pulled).toBe(false)
      expect(await response.text()).toBe('read on demand')
      expect(pulled).toBe(true)
    })

    it('and cancels the route body when the caller cancels the relay before reading it', async () => {
      const tracked = trackedResponse()
      const route = await bareRoute(async () => tracked.response)
      route.ctx.on('connection/fetch', async (_call, next) => new Response(streamFrom((await next()).body!)))

      const response = await route.fetch()
      await response.body!.cancel()
      expect(tracked.cancelled()).toBe(true)
    })
  })

  it('hands the caller the route Response a listener returns, or rewraps, as the listener returned it, body intact', async () => {
    const returned = trackedResponse('returned')
    const wrapped = trackedResponse('wrapped')
    let next: Response = returned.response
    const route = await bareRoute(async () => next)
    const remove = route.ctx.on('connection/fetch', (_call, delegate) => delegate())

    const received = await route.fetch()
    expect(received).toBe(returned.response)
    expect(await received.text()).toBe('returned')
    expect(returned.cancelled()).toBe(false)
    remove()

    next = wrapped.response
    let rewrap: Response | undefined
    route.ctx.on('connection/fetch', async (_call, delegate) => {
      const response = await delegate()
      rewrap = new Response(response.body, { status: 202, headers: { 'x-guard': 'seen' } })
      return rewrap
    })
    const rewrapped = await route.fetch()
    expect(rewrapped).toBe(rewrap)
    expect(rewrapped.status).toBe(202)
    expect(rewrapped.headers.get('x-guard')).toBe('seen')
    expect(await rewrapped.text()).toBe('wrapped')
    expect(wrapped.cancelled()).toBe(false)
  })

  it('cancels the route body when a listener throws after next(), asynchronously or synchronously', async () => {
    const asyncTracked = trackedResponse()
    const asyncRoute = await bareRoute(async () => asyncTracked.response)
    asyncRoute.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      throw new Error('guard failed after next')
    })
    await expect(asyncRoute.fetch()).rejects.toThrow('guard failed after next')
    expect(asyncTracked.cancelled()).toBe(true)

    const syncTracked = trackedResponse()
    const settledRoute = Promise.resolve(syncTracked.response)
    const syncRoute = await bareRoute(() => settledRoute)
    syncRoute.ctx.on('connection/fetch', (_call, next) => {
      void next()
      throw new Error('guard threw synchronously')
    })
    await expect(syncRoute.fetch()).rejects.toThrow('guard threw synchronously')
    await vi.waitFor(() => { expect(syncTracked.cancelled()).toBe(true) })
  })

  it('cancels a route body that arrives after the listener answered, without making the caller wait for it', async () => {
    for (const answer of [null, 'answered first']) {
      const tracked = trackedResponse()
      let release!: () => void
      const routeStarted = vi.fn()
      const route = await bareRoute(async () => {
        routeStarted()
        await new Promise<void>((resolve) => { release = resolve })
        return tracked.response
      })
      route.ctx.on('connection/fetch', async (_call, next) => {
        void next()
        return new Response(answer, { status: 409 })
      })

      const response = await route.fetch()
      expect([response.status, await response.text()]).toEqual([409, answer ?? ''])
      expect(routeStarted).toHaveBeenCalledOnce()
      expect(tracked.cancelled()).toBe(false)
      release()
      await vi.waitFor(() => { expect(tracked.cancelled()).toBe(true) })
    }
  })

  it('swallows the failure of a route whose Response the caller does not receive', async () => {
    const route = await bareRoute(async () => { throw new Error('route failed unseen') })
    route.ctx.on('connection/fetch', async (_call, next) => {
      void next()
      // The route rejects while the listener is still running.
      await new Promise(resolve => setTimeout(resolve, 20))
      return new Response('answered', { status: 403 })
    })
    expect(await unhandledRejectionsDuring(async () => {
      expect((await route.fetch()).status).toBe(403)
    })).toEqual([])
  })

  it('leaves a body the listener locked to the holder of its reader, without an unhandled rejection', async () => {
    const tracked = trackedResponse()
    const route = await bareRoute(async () => tracked.response)
    route.ctx.on('connection/fetch', async (_call, next) => {
      ;(await next()).body!.getReader()
      return new Response('refused after locking', { status: 403 })
    })
    expect(await unhandledRejectionsDuring(async () => {
      const response = await route.fetch()
      expect([response.status, await response.text()]).toEqual([403, 'refused after locking'])
    })).toEqual([])
    expect(tracked.cancelled()).toBe(false)
  })

  it('dispatches nothing for a next() called after the waterfall ended, and rejects it', async () => {
    const onTimer = (run: () => void): void => { setTimeout(run, 0) }
    const onImmediate = (run: () => void): void => { setImmediate(run) }
    const refuse = (): Response => new Response('refused', { status: 403 })
    const fail = (): Response => { throw new Error('guard failed') }
    const cases = [[onTimer, refuse, 403], [onImmediate, refuse, 403], [onTimer, fail, 'Error: guard failed']] as const
    for (const [schedule, answer, callerOutcome] of cases) {
      const route = vi.fn(async () => new Response('route body'))
      const guarded = await bareRoute(route)
      let late!: Promise<unknown>
      guarded.ctx.on('connection/fetch', async (_call, next) => {
        // The handlers attach in the turn that calls next(), so its rejection is never unhandled.
        late = new Promise((settle) => { schedule(() => { next().then(settle, settle) }) })
        return answer()
      })

      expect(await guarded.fetch().then(response => response.status, (error: unknown) => String(error))).toBe(callerOutcome)
      const outcome = await late
      expect(outcome).toBeInstanceOf(Error)
      expect(outcome).toHaveProperty('message', 'connection/fetch: next() was called after the waterfall ended')
      expect(route).not.toHaveBeenCalled()
    }
  })

  it('shares one next() among listeners: a second call skips every listener that already ran', async () => {
    const first = trackedResponse('first')
    const second = trackedResponse('second')
    const responses = [first.response, second.response]
    const route = await bareRoute(async () => responses.shift()!)
    const order: string[] = []
    route.ctx.on('connection/fetch', async (_call, next) => {
      order.push('outer')
      const refused = await next()
      order.push(`outer saw ${String(refused.status)}`)
      return next()
    })
    route.ctx.on('connection/fetch', async () => {
      order.push('inner refuses')
      return new Response('inner refusal', { status: 403 })
    })

    const response = await route.fetch()
    expect(await response.text()).toBe('first')
    expect(order).toEqual(['outer', 'inner refuses', 'outer saw 403'])
    expect(first.cancelled()).toBe(false)
    expect(responses).toEqual([second.response])

    // One listener that calls next() twice runs the route twice; the Response it does not return is cancelled.
    const twice = [trackedResponse('one'), trackedResponse('two')]
    const queue = twice.map(entry => entry.response)
    const doubled = await bareRoute(async () => queue.shift()!)
    doubled.ctx.on('connection/fetch', async (_call, next) => {
      await next()
      return next()
    })
    expect(await (await doubled.fetch()).text()).toBe('two')
    expect(twice.map(entry => entry.cancelled())).toEqual([true, false])
  })

  it('answers a listener throw the way the carrier answers a throwing route: 400 with an empty body', async () => {
    const throwing = await mount()
    throwing.ctx.on('connection/fetch', () => { throw new Error('listener threw') })
    expect(await send(throwing, EXACT, 'GET')).toEqual({ status: 400, body: '' })
    expect(await callChannel(throwing)).toEqual({ status: 400, body: '' })
    expect(throwing.reached).toEqual([])
    expect(throwing.warnings).toHaveLength(2)

    const routeThrows = await mount(async () => { throw new Error('channel handler threw') })
    routeThrows.ctx.connection.fetch.register({
      path: `${API_PATH}/guard.throws`,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => { throw new Error('route threw') },
    })
    expect(await send(routeThrows, `${API_PATH}/guard.throws`, 'GET')).toEqual({ status: 400, body: '' })
    // A dedicated channel answers its own handler's throw; a listener's throw on a channel does not reach that answer.
    expect(await callChannel(routeThrows)).toEqual({ status: 500, body: 'handler failure: Error: channel handler threw' })
  })
})

describe('connection.fetch.list() and connection.rpc.channels()', () => {
  it('list the exact routes and dedicated channels in effect', async () => {
    const mounted = await mount()
    const { connection } = mounted.ctx
    expect(connection.fetch.list()).toEqual([{ path: EXACT, methods: ['GET', 'POST'] }])
    expect(connection.rpc.channels()).toEqual([CHANNEL])

    const removeRoute = connection.fetch.register({
      path: `${API_PATH}/guard.added`, methods: ['HEAD'], requestBody: 'streaming', fetch: async () => new Response(),
    })
    const removeChannel = connection.rpc.handle('/added-rpc', async () => ({ ok: true, value: null }))
    expect(connection.fetch.list()).toEqual([
      { path: `${API_PATH}/guard.added`, methods: ['HEAD'] },
      { path: EXACT, methods: ['GET', 'POST'] },
    ])
    expect(connection.rpc.channels()).toEqual(['/added-rpc', CHANNEL])

    await removeRoute()
    await removeChannel()
    expect(connection.fetch.list()).toEqual([{ path: EXACT, methods: ['GET', 'POST'] }])
    expect(connection.rpc.channels()).toEqual([CHANNEL])
  })

  it('drop the routes of a plugin when it unloads, list no channel a duplicate failed to add, and return copies', async () => {
    const mounted = await mount()
    const { ctx } = mounted
    const owner = ctx.plugin({
      inject: ['connection'],
      apply: (pluginCtx: Context) => {
        pluginCtx.connection.fetch.register({
          path: `${API_PATH}/guard.plugin`, methods: ['GET'], requestBody: 'buffered', fetch: async () => new Response(),
        })
      },
    })
    await owner
    expect(ctx.connection.fetch.list().map(route => route.path)).toEqual([EXACT, `${API_PATH}/guard.plugin`])

    // A prefix route registered directly on the webserver makes the channel registration throw.
    ctx.webServer.register({ kind: 'prefix', path: '/taken-rpc', handler: (_req, res) => { res.end() } })
    expect(() => ctx.connection.rpc.handle('/taken-rpc', async () => ({ ok: true, value: null })))
      .toThrow('webserver: duplicate prefix route "/taken-rpc"')
    expect(ctx.connection.rpc.channels()).toEqual([CHANNEL])
    await owner.dispose()
    expect(ctx.connection.fetch.list().map(route => route.path)).toEqual([EXACT])
    expect(ctx.connection.rpc.channels()).toEqual([CHANNEL])
    // The listing returns copies; changing them leaves the registry intact.
    const listed = ctx.connection.fetch.list() as Array<{ path: string; methods: string[] }>
    listed[0]!.methods.push('HEAD')
    ;(ctx.connection.rpc.channels() as string[]).push('/forged')
    expect(ctx.connection.fetch.list()).toEqual([{ path: EXACT, methods: ['GET', 'POST'] }])
    expect(ctx.connection.rpc.channels()).toEqual([CHANNEL])
  })
})
