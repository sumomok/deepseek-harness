/** Host registry and HTTP adapter for generic Connection RPC channels. */

import { Context, Service } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import type { PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'
import type { ConnectionInteractions } from './connect-protocol.ts'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ClientRequest, RpcId as RpcIdType } from './rpc.ts'
import { clientRequestSchema } from './rpc-schema.ts'
import { bridge } from './http-bridge.ts'
import { isRemoteAuthority, isTrustedApiRequest } from './api-request-trust.ts'
import { API_PATH } from './api-path.ts'
import { Peer } from './peer.ts'
import type { ConnectionAuthentication } from './authentication.ts'
import type {
  PeerAdmission,
  ConnectionFetchRoute,
  ConnectionFetchHandler,
  HostConnectionFetch,
  ConnectionRpcEndpointMatcher,
  ConnectionRpcFailure,
  ConnectionRpcHandler,
  ConnectionRpcResult,
  ConnectionTrustRequest,
  HostConnectionHandle,
  HostConnectionPeers,
  HostConnectionRpc,
  PeerAdmitter,
} from './rpc.ts'

const INVALID_REQUEST_RPC_ID = brandString<RpcIdType>('invalid-request')
const CHANNEL_PATTERN = /^\/[A-Za-z0-9._~-]+$/
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/

interface ConnectionRpcInterceptor {
  readonly matches: ConnectionRpcEndpointMatcher
  readonly fetchHandler: ConnectionFetchHandler
}

interface RegisteredFetchRoute {
  readonly methods: ReadonlySet<string>
  readonly requestBody: ConnectionFetchRoute['requestBody']
  readonly fetch: ConnectionFetchRoute['fetch']
  readonly serveNonOwner: ConnectionFetchRoute['serveNonOwner']
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
  /** Connection-owned Peer for trusted in-process callers, not network authentication. */
  readonly browserPeer: PeerScope
  readonly authentication: ConnectionAuthentication
  private readonly owner: Context
  private disposed = false
  private admitter: PeerAdmitter | undefined
  private readonly interceptors = new Map<string, ConnectionRpcInterceptor>()
  private readonly fetchRoutes = new Map<string, RegisteredFetchRoute>()

  readonly allowsRemoteAuthorities: boolean

  /**
   * Provide the Host half over the active HTTP server.
   * @param ctx - owning Connection plugin context.
   * @param trustedHosts - deployment authorities accepted by the Host/Origin fence.
   * @param requireAdmitter - while no Peer admitter is installed, refuse with 401 every request that passes
   * the Host/Origin checks and registered authentication.
   */
  constructor(
    ctx: Context,
    private readonly trustedHosts: readonly string[],
    private readonly requireAdmitter = false,
  ) {
    super(ctx, 'connection')
    this.owner = ctx
    this.authentication = ctx['connection.authentication']
    this.browserPeer = new Peer(ctx, { principal: { kind: 'owner' } })
    ctx.effect(() => async () => {
      this.disposed = true
      await this.browserPeer.dispose()
    }, 'client-connection: Peer scopes')
    this.allowsRemoteAuthorities = trustedHosts.some(isRemoteAuthority)
    ctx.on('webserver/authorize', (request, policy) => {
      const facts = { ...request, url: request.url.href }
      if (!this.isTrustedRequest(facts)) return { kind: 'deny', status: 403 }
      if (policy === 'anonymous') return { kind: 'allow' }
      const admission = this.authenticateRequest(facts)
      return 'rejection' in admission
        ? { kind: 'deny', status: admission.rejection }
        : { kind: 'allow', peer: admission.peer }
    })
  }

  /** Generic channel registry scoped to the Context reading this service. */
  get rpc(): HostConnectionRpc {
    const owner = this.ctx
    return {
      handle: (channel, handler) => this.register(owner, channel, handler),
      intercept: (channel, matches, handler) =>
        this.registerInterceptor(owner, channel, matches, handler),
    }
  }

  /** Exact Fetch-route registry scoped to the Context reading this service. */
  get fetch(): HostConnectionFetch {
    const owner = this.ctx
    return {
      register: route => this.registerFetchRoute(owner, route),
    }
  }

  /** Peer admission seam; the admitter registration belongs to the Context reading this service. */
  get peers(): HostConnectionPeers {
    const owner = this.ctx
    return {
      requireAdmitter: this.requireAdmitter,
      admitWith: admitter => this.installAdmitter(owner, admitter),
    }
  }

  /** Apply the carrier source policy and accept the first successful provider, or delegate to an installed admitter. */
  admit(request: ConnectionTrustRequest): PeerAdmission {
    if (!this.isTrustedRequest(request)) return { rejection: 403 }
    return this.authenticateRequest(request)
  }

  private authenticateRequest(request: ConnectionTrustRequest): PeerAdmission {
    if (this.disposed) return { rejection: 401 }
    const admission = this.authentication.authenticate(request)
    if ('rejection' in admission) return admission
    const admitter = this.admitter
    if (admitter !== undefined) return this.admitWithAdmitter(request, admitter)
    if (this.requireAdmitter) return { rejection: 401 }
    return admission
  }

  private admitWithAdmitter(request: ConnectionTrustRequest, admitter: PeerAdmitter): PeerAdmission {
    let verdict: ReturnType<PeerAdmitter>
    try {
      verdict = admitter(request)
    } catch (error) {
      // A thrown message may quote request headers, so the log names only an Error's `name` or another value's `typeof`.
      const thrown = error instanceof Error ? error.name : typeof error
      this.owner.logger.error(`client-connection: the Peer admitter threw ${thrown}; refusing the request with 401`)
      return { rejection: 401 }
    }
    if (verdict === 401 || verdict === 403) return { rejection: verdict }
    if (verdict !== undefined && !verdict.signal.aborted) return { peer: verdict }
    this.owner.logger.error(verdict === undefined
      ? 'client-connection: the Peer admitter named no Peer; refusing the request with 401'
      : 'client-connection: the Peer admitter returned a disposed Peer; refusing the request with 401')
    return { rejection: 401 }
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

  /** Create one in-process Peer owned by the Context that read this service. */
  createPeer(options: {
    readonly principal: Principal
    readonly interactions?: ConnectionInteractions
  }): PeerScope {
    if (this.disposed) throw new Error('connection: cannot create a Peer after disposal')
    return new Peer(this.ctx, options)
  }

  /** Check the deployment's request-source policy without credential verification. */
  private isTrustedRequest(request: ConnectionTrustRequest): boolean {
    const carrier = this.owner.get('webServer')
    return isTrustedApiRequest(request, this.trustedHosts, carrier?.host, carrier?.protocol ?? 'http:')
  }

  /**
   * Compose one shared-channel Fetch handler from exact routes and its interceptor.
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
      fetch: (request, peer) => {
        const pathname = new URL(request.url).pathname
        const route = this.fetchRoutes.get(pathname)
        if (route?.methods.has(request.method) === true) {
          // Exact routes bypass Gateway access checks, so only the owner reaches them unless the route declares its own rule.
          // oxlint-disable-next-line typescript/no-unnecessary-condition -- other packages merge non-owner kinds into PrincipalMap.
          if (peer.principal.kind !== 'owner') return nonOwnerFetch(route, request, peer)
          return route.fetch(request)
        }
        const endpoint = endpointFromPath(channel, pathname)
        const interceptor = this.interceptors.get(channel)
        if (endpoint === undefined || interceptor === undefined || !interceptor.matches(endpoint)) {
          return Promise.resolve(new Response('not found', { status: 404 }))
        }
        return interceptor.fetchHandler.fetch(request, peer)
      },
    }
  }

  private registerFetchRoute(
    owner: Context,
    route: ConnectionFetchRoute,
  ): () => Promise<void> {
    assertFetchRoute(route)
    const registered: RegisteredFetchRoute = {
      methods: new Set(route.methods),
      requestBody: route.requestBody,
      fetch: route.fetch,
      serveNonOwner: route.serveNonOwner,
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
    const fetchHandler = rpcFetchHandler(channel, handler)
    const route: WebRoute = {
      kind: 'prefix',
      path: channel,
      auth: 'required',
      handler: async (req, res, peer) => {
        if (peer === undefined || res.destroyed) return
        await bridge(req, res, fetchHandler, peer)
      },
    }
    return owner.effect(() => {
      const webServer = owner.get('webServer')
      if (webServer === undefined) throw new Error('connection: RPC channels require a WebServer')
      return webServer.register(route)
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
      fetchHandler: rpcFetchHandler(channel, handler),
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

/** Hand a non-owner request to the route's own access rule; without one, refuse it. */
function nonOwnerFetch(route: RegisteredFetchRoute, request: Request, peer: PeerScope): Promise<Response> {
  if (route.serveNonOwner === undefined) return Promise.resolve(new Response('forbidden', { status: 403 }))
  // The Peer may have been disposed while the bridge read the body or a connection/request listener awaited.
  if (peer.signal.aborted) return Promise.resolve(new Response('unauthorized', { status: 401 }))
  return route.serveNonOwner(request, peer)
}

function rpcFetchHandler(
  channel: string,
  handler: ConnectionRpcHandler,
): ConnectionFetchHandler {
  return {
    requestBodyMode: () => 'buffered',
    async fetch(request: Request, peer: PeerScope): Promise<Response> {
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
  const rpcId = typeof rawId === 'string' ? brandString<RpcIdType>(rawId) : INVALID_REQUEST_RPC_ID
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
