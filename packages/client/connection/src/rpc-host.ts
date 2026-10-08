/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import {
  RpcId,
  type ClientRequest,
  type RpcId as RpcIdType,
} from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge, DEFAULT_MAX_REQUEST_BODY_BYTES } from './http-bridge.ts'
import { isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import type { BrowserAuth } from './browser-auth.ts'
import { ConnectionPeer, OperatorPeer } from './operator-peer.ts'
import type {
  PeerAdmission,
  PeerAdmitter,
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionFetchCall,
  ConnectionFetchMethod,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionRequestRejection,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionPeers,
  HostConnectionRpc,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = RpcId('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  /** The declared methods in registration order, as `fetch.list()` reports them. */
  readonly declared: readonly ConnectionFetchMethod[]
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
}

/** One `connection/fetch` listener as Cordis resolves it for a dispatch. */
type FetchListener = (call: ConnectionFetchCall, next: () => Promise<Response>) => Promise<Response>

/** One Response a `next()` of `connection/fetch` produced, and that Response once it has resolved. */
interface DispatchedResponse {
  readonly pending: Promise<Response>
  settled: Response | undefined
}

interface ConnectionServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: ConnectionRpcResult<unknown>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host Connection transport and RPC registrations. */
    connection: HostConnectionHandle
  }
}

/** Host Connection service whose channel registrations belong to the caller fiber. */
export class HostConnectionService extends Service implements HostConnectionHandle {
  /** The operator Peer, which every admitted request speaks for while no admitter is installed and `requireAdmitter` is false. */
  readonly operator: PeerScope
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()
  /** Channels registered with `rpc.handle` whose disposer has not run. */
  private readonly dedicatedChannels = new Set<string>()
  /** Connection plugin context; member Peer scopes hang under it whichever fiber opens them, and Connection's events go through it. */
  private readonly peerOwner: Context
  private readonly members = new Map<PeerId, ConnectionPeer>()
  private admitter: PeerAdmitter | undefined

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param browserAuth - process token and persistent browser-session owner.
   * @param requireAdmitter - while no admitter is installed, refuse with 401 every request that passes
   * the Host/Origin checks and browser authentication.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly browserAuth: BrowserAuth,
    private readonly requireAdmitter = false,
  ) {
    super(ctx, 'connection')
    this.peerOwner = ctx
    this.operator = new OperatorPeer(ctx)
    ctx.effect(() => () => this.operator.dispose(), 'client-connection: operator Peer')
    ctx.effect(() => () => this.disposeMembers(), 'client-connection: member Peers')
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
      channels: () => [...this.dedicatedChannels].sort(),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
      list: () => [...this.fetchRoutes]
        .sort(([left], [right]) => left < right ? -1 : 1)
        .map(([path, route]) => ({ path, methods: [...route.declared] })),
    }
  }

  /** Member Peer registry; the admitter registration belongs to the Context reading this service. */
  get peers(): HostConnectionPeers {
    const owner = this.ctx
    const isMemberAdmission = (): boolean => this.isMemberAdmission()
    return {
      requireAdmitter: this.requireAdmitter,
      get memberAdmission() { return isMemberAdmission() },
      admitWith: admitter => this.installAdmitter(owner, admitter),
      open: () => this.openMember(),
      get: id => this.liveMember(id),
      list: () => [...this.members.values()].filter(peer => !peer.released),
    }
  }

  /** Keep only the verdict of {@link admit}. */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    const admission = this.admit(request)
    return 'rejection' in admission ? admission.rejection : undefined
  }

  /** Apply the Host/Origin fence and browser authentication, then the installed admitter or, without one, `requireAdmitter`. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const rejection = this.fenceRejection(request)
    if (rejection !== undefined) return { rejection }
    const admitter = this.admitter
    if (admitter === undefined) return this.requireAdmitter ? { rejection: 401 } : { peer: this.operator }
    const verdict = admitter(request)
    if (verdict === 401 || verdict === 403) return { rejection: verdict }
    if (verdict !== undefined && this.liveMember(verdict.id) === verdict) return { peer: verdict }
    this.peerOwner.logger.error(verdict === undefined
      ? 'client-connection: the Peer admitter named no member; refusing the request with 401'
      : 'client-connection: the Peer admitter returned a Peer that connection.peers.open() did not open or that is released; refusing the request with 401')
    return { rejection: 401 }
  }

  /** Authenticate an index request through the process-token exchange or cookie. */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean {
    return this.browserAuth.authorizeIndex(request, response)
  }

  /** Add this process's launch token to the clean application URL. */
  authenticatedUrl(baseUrl: string): string {
    return this.browserAuth.authenticatedUrl(baseUrl)
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
   * A request an exact route owns passes through `connection/fetch` first. A request whose member Peer has been
   * released since admission reaches neither an exact route nor the interceptor and is answered 401.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler that selects one owner or returns 404.
   */
  createSharedFetchHandler(
    channel: '/api',
  ): ConnectionFetchHandler {
    return {
      requestBodyMode: ({ method, url }) => {
        const route = this.fetchRoutes.get(url.pathname)
        return route?.methods.has(method) === true ? route.requestBody : 'buffered'
      },
      fetch: (request, peer = this.operator) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          const call: ConnectionFetchCall = { kind: 'exact-route', path: pathname, method: request.method, request, peer }
          // A listener may await before next(); the Peer may be released and the route's plugin may unload meanwhile.
          return this.guardFetch(call, () => {
            if (!this.isDispatchable(peer)) return Promise.resolve(releasedPeerResponse())
            return this.fetchRoutes.get(pathname) === route
              ? route.fetch(request, peer)
              : Promise.resolve(new Response('not found', { status: 404 }))
          })
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        if (!this.isDispatchable(peer)) return Promise.resolve(releasedPeerResponse())
        return interceptor.fetchHandler.fetch(request, peer)
      },
    }
  }

  /**
   * Run `connection/fetch` around one dispatch to a route or channel. While member admission is on and no listener
   * is registered, answer 503 without dispatching. An `internal/dispatch` listener receives a step that calls the
   * dispatching `next()` once the listeners are resolved, skipping them. The body of each Response the
   * route or channel produced for a `next()` called before the waterfall ended is cancelled unless the
   * caller receives that Response or its body: once the waterfall ends when the waterfall's result has
   * no body or a locked one, otherwise once the caller has read that body to its end, cancelled it, or
   * it failed. Responses and bodies are compared by identity, so a Response that another copy of undici
   * built is handled as one built in this realm. Once the waterfall has ended, a `next()` that reaches
   * the route or channel dispatches nothing and rejects.
   * @param call - the request as listeners see it.
   * @param dispatch - hand the request to the route or channel.
   * @returns 503 when member admission is on and no listener is registered; the waterfall's result itself when
   * every such `next()` has resolved to a Response the caller receives or whose body it receives, or when the
   * result has no body or a locked one; otherwise a Response with the result's status, status text, and headers
   * over a body that relays the result's body. Rejects with the waterfall's failure.
   */
  private async guardFetch(call: ConnectionFetchCall, dispatch: () => Promise<Response>): Promise<Response> {
    // A listener may call next() more than once, so each call's Response is recorded.
    const dispatched: DispatchedResponse[] = []
    let ended = false
    const next = (): Promise<Response> => {
      // The caller already has the waterfall's outcome, so nothing would read or cancel this Response. The rejection
      // belongs to the listener that called next(); one it discards is that listener's unhandled rejection.
      if (ended) return Promise.reject(new Error('connection/fetch: next() was called after the waterfall ended'))
      const entry: DispatchedResponse = { pending: (async () => dispatch())(), settled: undefined }
      void entry.pending.then((response) => { entry.settled = response }, swallowDiscardedRouteFailure)
      dispatched.push(entry)
      return entry.pending
    }
    // An `internal/dispatch` listener receives `entry`, which calls `next()` only once the listeners are resolved, so
    // a request answered 503 or failed by that listener's throw has ended first and `next()` dispatches nothing.
    const resolved = Promise.withResolvers<void>()
    const entry = (): Promise<Response> => resolved.promise.then(() => next())
    let listeners: FetchListener[]
    try {
      // The listeners `waterfall()` would run: the event has no `this` argument, so Cordis applies no context filter.
      // Resolving them here emits `internal/dispatch` once, as `waterfall()` does.
      listeners = this.peerOwner.events.dispatch('waterfall', ['connection/fetch', call, entry])
    } catch (error) {
      ended = true
      resolved.resolve()
      throw error
    }
    if (listeners.length === 0 && this.isMemberAdmission()) {
      ended = true
      resolved.resolve()
      return unguardedResponse()
    }
    resolved.resolve()
    // Cordis's waterfall: every listener receives the same `next()`, which runs the next listener not yet run.
    const run = (): Promise<Response> => (listeners.shift() ?? next)(call, run)
    let result: Response
    try {
      // A listener that throws synchronously makes `run()` throw rather than reject.
      result = await run()
    } catch (error) {
      ended = true
      discardDispatched(dispatched, undefined)
      throw error
    }
    ended = true
    if (dispatched.every(entry => entry.settled !== undefined && unreturnedBody(entry.settled, result) === undefined)) {
      return result
    }
    // The caller's body may read an unreturned body lazily, as a listener's relay stream does, so cancelling
    // waits until the caller is done with its body. A result without a body, such as the `undefined` a listener
    // returns against its declared result, leaves no body to wait for, so every unreturned body is cancelled now.
    const body = (result as Response | undefined)?.body ?? null
    if (body === null || body.locked) {
      discardDispatched(dispatched, result)
      return result
    }
    return observeBody(result, body, () => { discardDispatched(dispatched, result) })
  }

  /**
   * Report whether member admission is on.
   * @returns `true` while an admitter is installed or `requireAdmitter` is true.
   */
  private isMemberAdmission(): boolean {
    return this.admitter !== undefined || this.requireAdmitter
  }

  private fenceRejection(request: ConnectionTrustRequest): ConnectionRequestRejection {
    if (!isTrustedApiRequest(request, this.trustedHosts)) return 403
    return this.browserAuth.isAuthenticated(request) ? undefined : 401
  }

  private installAdmitter(owner: Context, admitter: PeerAdmitter): () => Promise<void> {
    return owner.effect(() => {
      if (this.admitter !== undefined) {
        throw new Error('connection: a Peer admitter is already installed')
      }
      this.admitter = admitter
      return () => {
        this.admitter = undefined
      }
    }, 'client-connection: Peer admitter')
  }

  private openMember(): ConnectionPeer {
    const peer = new ConnectionPeer(this.peerOwner, (closed) => {
      this.members.delete(closed.id)
      this.announce('connection/peer-closed', closed)
    })
    this.members.set(peer.id, peer)
    this.announce('connection/peer-opened', peer)
    return peer
  }

  private liveMember(id: PeerId): ConnectionPeer | undefined {
    const peer = this.members.get(id)
    return peer === undefined || peer.released ? undefined : peer
  }

  /**
   * Decide whether a request admitted as `peer` may still reach its route, channel, or interceptor.
   * @param peer - the Peer the request was admitted as.
   * @returns `true` for the operator, which is identified only by identity with {@link operator}, and for a member
   * Peer whose `dispose()` has not been called.
   */
  private isDispatchable(peer: PeerScope): boolean {
    return peer === this.operator || this.liveMember(peer.id) === peer
  }

  private async disposeMembers(): Promise<void> {
    await Promise.all([...this.members.values()].map(peer => peer.dispose()))
  }

  /** Emit one member Peer lifecycle event; a throwing listener is logged, not propagated. */
  private announce(event: 'connection/peer-opened' | 'connection/peer-closed', peer: PeerScope): void {
    try {
      this.peerOwner.emit(event, peer)
    } catch (error) {
      this.peerOwner.logger.error(`client-connection: a ${event} listener threw`, error)
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      declared: [...route.methods],
      requestBody: route.requestBody,
      fetch: route.fetch,
    }
    return owner.effect(() => {
      if (this.fetchRoutes.has(route.path)) {
        throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`)
      }
      this.fetchRoutes.set(route.path, registered)
      return () => { this.fetchRoutes.delete(route.path) }
    }, `client-connection: ${route.path} Fetch route`)
  }

  private register(
    owner: Context,
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    assertChannel(channel)
    const decode = rpcFetchHandler(channel, handler, this.operator)
    const fetchHandler: ConnectionFetchHandler = {
      requestBodyMode: request => decode.requestBodyMode(request),
      fetch: (request, peer = this.operator) => this.guardFetch(
        { kind: 'channel', path: channel, method: request.method, request, peer },
        () => this.isDispatchable(peer) ? decode.fetch(request, peer) : Promise.resolve(releasedPeerResponse()),
      ),
    }
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      handler: async (req, res) => {
        const admission = this.admit(req)
        if ('rejection' in admission) {
          res.writeHead(admission.rejection)
          res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        await bridge(req, res, fetchHandler, DEFAULT_MAX_REQUEST_BODY_BYTES, admission.peer)
      },
    }
    return owner.effect(() => {
      const removeRoute = owner.webServer.register(route)
      this.dedicatedChannels.add(channel)
      return () => {
        this.dedicatedChannels.delete(channel)
        removeRoute()
      }
    }, `client-connection: ${channel} rpc channel`)
  }

  private registerInterceptor(
    owner: Context,
    channel: string,
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void> {
    if (channel !== API_PATH) {
      throw new Error(`connection: invalid shared RPC channel ${JSON.stringify(channel)}`)
    }
    const interceptor: ConnectionRpcInterceptor = {
      matches,
      fetchHandler: rpcFetchHandler(channel, handler, this.operator),
    }
    return owner.effect(() => {
      if (this.interceptors.has(channel)) {
        throw new Error(`connection: shared RPC channel ${JSON.stringify(channel)} already has an interceptor`)
      }
      this.interceptors.set(channel, interceptor)
      return () => {
        this.interceptors.delete(channel)
      }
    }, `client-connection: ${channel} rpc interceptor`)
  }
}

/**
 * Cancel the body of each Response a `next()` of one `connection/fetch` dispatch produced that the
 * caller does not receive: at once for one that has resolved, once it resolves for one still pending.
 * @param dispatched - the Responses the dispatch's `next()` calls produced.
 * @param result - the waterfall's result the caller receives, which may be a value without a body that a listener
 * returned against its declared result; `undefined` when the waterfall failed or a listener returned `undefined`.
 */
function discardDispatched(dispatched: readonly DispatchedResponse[], result: Response | undefined): void {
  for (const entry of dispatched) {
    if (entry.settled !== undefined) void cancelUnreturnedBody(entry.settled, result)
    else void entry.pending.then(response => cancelUnreturnedBody(response, result), swallowDiscardedRouteFailure)
  }
}

/**
 * Select the body of one route Response that the caller does not receive.
 * @param response - the value one `next()` resolved to; a route in untyped code can resolve to `undefined`, `null`, or
 * another value without a body against its declared Response, and such a value has no body to cancel.
 * @param result - the Response the caller receives, if any.
 * @returns the body of `response`, or `undefined` when it has none or the caller receives `response` or its body.
 */
function unreturnedBody(response: Response | null | undefined, result: Response | undefined): ReadableStream<Uint8Array> | undefined {
  const body = response?.body ?? null
  // A Response built over the same body, such as one that adds headers, hands that body to the caller.
  return body === null || response === result || body === result?.body ? undefined : body
}

/**
 * Cancel one route Response's body unless the caller receives it.
 * @param response - the value one `next()` resolved to, which may be a value without a body; see `unreturnedBody`.
 * @param result - the Response the caller receives, if any.
 * @returns once the body is cancelled or left alone; never rejects.
 */
async function cancelUnreturnedBody(response: Response | null | undefined, result: Response | undefined): Promise<void> {
  const body = unreturnedBody(response, result)
  if (body === undefined) return
  try {
    await body.cancel()
  } catch (_cancelFailure) {
    // A body a listener has locked belongs to the holder of its reader, and a failed cancel must not replace the
    // caller's result.
  }
}

/**
 * Hand the caller one Response over a body that reports when the caller is done with it.
 * @param result - the waterfall's Response.
 * @param body - the unlocked body of `result`, which the returned body reads only as the caller reads.
 * @param done - called when the caller has read the body to its end, cancelled it, or reading it failed.
 * @returns a Response with the status, status text, and headers of `result` over a body that relays `body`.
 */
function observeBody(result: Response, body: ReadableStream<Uint8Array>, done: () => void): Response {
  const reader = body.getReader()
  const relay = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: ReadableStreamReadResult<Uint8Array>
      try {
        chunk = await reader.read()
      } catch (error) {
        done()
        throw error
      }
      if (chunk.done) {
        controller.close()
        done()
      } else {
        controller.enqueue(chunk.value)
      }
    },
    cancel(reason) {
      // An unreturned body that `body` holds locked ignores the cancel `done` makes; `body` receives this cancel instead.
      done()
      return reader.cancel(reason)
    },
  }, { highWaterMark: 0 })
  return new Response(relay, { status: result.status, statusText: result.statusText, headers: result.headers })
}

/**
 * Answer an exact-route or channel request that no `connection/fetch` listener guards while member admission is on.
 * @returns a 503 Response.
 */
function unguardedResponse(): Response {
  return new Response('service unavailable', { status: 503 })
}

/**
 * Answer a request whose member Peer was released after admission.
 * @returns a 401 Response with the body that admission refusals carry.
 */
function releasedPeerResponse(): Response {
  return new Response('unauthorized', { status: 401 })
}

/**
 * Absorb the rejection of a route that a `next()` dispatched; the listener that called `next()` holds the same promise.
 * @param _routeFailure - the route's rejection, which leaves no body to cancel.
 */
function swallowDiscardedRouteFailure(_routeFailure: unknown): void {
  // The caller receives the waterfall's outcome; a route rejection no listener awaited must not become an unhandled
  // rejection.
}

/**
 * Decode one RPC channel's requests for `handler`, passing each call the Peer
 * its request was admitted as.
 * @param channel - absolute channel prefix the endpoint is read below.
 * @param handler - decoded endpoint handler.
 * @param operator - Peer a call that names none speaks for.
 * @returns a buffered Fetch handler for the channel.
 */
function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
  operator: PeerScope,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, peer: PeerScope = operator): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) {
        return new Response('not found', { status: 404 })
      }

      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }

      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }

      const envelope = clientRequestSchema.safeParse(body)
      if (!envelope.success) {
        return invalidEnvelopeResponse(body, envelope.error.issues)
      }
      const message: ClientRequest = envelope.data
      if (message.method !== endpoint) {
        return errorResponse(message.rpcId, {
          code: 'gateway/bad-request',
          message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
          details: { issues: [] },
        })
      }

      try {
        const result = await handler(endpoint, message.payload, request.signal, peer)
        return fullResponse(message.rpcId, result)
      } catch (error) {
        return new Response(`handler failure: ${String(error)}`, { status: 500 })
      }
    },
  }
}

function invalidEnvelopeResponse(body: unknown, issues: readonly object[]): Response {
  const rawId = (body as { rpcId?: unknown } | null)?.rpcId
  const rpcId = typeof rawId === 'string' ? RpcId(rawId) : INVALID_REQUEST_RPC_ID
  return errorResponse(rpcId, {
    code: 'gateway/bad-request',
    message: 'invalid client-request message',
    details: { issues },
  })
}

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const segments = endpoint.split('/')
  if (segments.some(segment =>
    segment === '' || segment === '.' || segment === '..' || !ENDPOINT_SEGMENT_PATTERN.test(segment))) {
    return undefined
  }
  return endpoint
}

function errorResponse(rpcId: RpcIdType, error: ConnectionRpcFailure): Response {
  return fullResponse(rpcId, { ok: false, error })
}

function fullResponse(rpcId: RpcIdType, result: Awaited<ReturnType<ConnectionRpcHandler>>): Response {
  if (!result.ok) {
    const body: ConnectionServerResponse = { type: 'server-response', rpcId, result }
    return Response.json(body)
  }
  const { attachments, ...success } = result
  const body: ConnectionServerResponse = { type: 'server-response', rpcId, result: success }
  if (attachments === undefined || attachments.length === 0) return Response.json(body)
  const parts = new FormData()
  const attachmentMetadata = attachments.map((attachment, index) => {
    const part = `bytes-${index}`
    // FileSystem bytes may have SharedArrayBuffer backing, which BlobPart excludes.
    parts.set(part, new Blob([new Uint8Array(attachment.bytes)]))
    return { path: [...attachment.path], codec: 'bytes' as const, part }
  })
  parts.set('metadata', JSON.stringify({ ...body, attachments: attachmentMetadata }))
  return new Response(parts)
}

function assertChannel(channel: string): void {
  if (!CHANNEL_PATTERN.test(channel) || channel === '/api') {
    throw new Error(`connection: invalid or reserved RPC channel ${JSON.stringify(channel)}`)
  }
}

function assertFetchRoute(route: ConnectionFetchRoute): void {
  if (endpointFromPath(API_PATH, route.path) === undefined) {
    throw new Error(`connection: invalid exact Fetch route ${JSON.stringify(route.path)}`)
  }
  if (route.methods.length === 0) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} declares no methods`)
  }
  const methods = new Set(route.methods)
  if (methods.size !== route.methods.length) {
    throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} repeats a method`)
  }
}
