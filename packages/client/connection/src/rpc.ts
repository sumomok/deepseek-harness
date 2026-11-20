/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PeerScope, Principal } from '@deepseek-ai/dsh-typert-protocol'

/** Correlation id minted by a caller and echoed by the Connection response. */
export type RpcId = Branded<'rpc-id'>

/**
 * Brand one validated string as a Connection correlation id.
 * @param id - validated wire identity.
 * @returns the same string with the correlation-id brand.
 */
export function RpcId(id: string): RpcId {
  return id as RpcId
}

/** Carrier-neutral failure returned by one logical RPC endpoint. */
export interface ConnectionRpcFailure {
  readonly code: string
  readonly message: string
  readonly details: object
}

/** Carrier-neutral result returned by one logical RPC endpoint. */
export type ConnectionRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** One binary value separated from a successful RPC result before transport framing. */
export interface ConnectionRpcAttachment {
  /** Result-relative path occupied by the attachment's `null` placeholder. */
  readonly path: readonly (string | number)[]
  /** Byte view carried outside the JSON response metadata. */
  readonly bytes: Uint8Array
}

/** Successful or failed handler result ready for Connection transport framing. */
export type ConnectionRpcHandlerResult =
  | {
    readonly ok: true
    readonly value: unknown
    /** Binary fields already projected by the handler that owns the result protocol. */
    readonly attachments?: readonly ConnectionRpcAttachment[]
  }
  | { readonly ok: false; readonly error: ConnectionRpcFailure }

/** Historical short name for a generic Connection result. */
export type RpcResult<T> = ConnectionRpcResult<T>

/**
 * Convert a rejected transport operation into a generic failure result.
 * @param error - rejected transport value.
 * @returns an `internal` failure preserving the available message.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  return {
    ok: false,
    error: {
      code: 'gateway/internal',
      message: error instanceof Error ? error.message : String(error),
      details: {},
    },
  }
}

/** Narrow request form used by direct fixture adapters. */
export interface RpcRequest<P> {
  readonly rpcId: RpcId
  readonly payload: P
}

/** Narrow response form used by direct fixture adapters. */
export interface RpcResponse<T> {
  readonly rpcId: RpcId
  readonly result: RpcResult<T>
}

/** Full request envelope carried by Connection RPC transports. */
export interface ClientRequest {
  readonly type: 'client-request'
  readonly rpcId: RpcId
  readonly method: string
  readonly payload: unknown
}

/** Full response envelope carried by Connection RPC transports. */
export interface ServerResponse {
  readonly type: 'server-response'
  readonly rpcId: RpcId
  readonly result: ConnectionRpcResult<unknown>
}

/** Complete Connection RPC envelope union. */
export type RpcMessage = ClientRequest | ServerResponse

/** HTTP request facts consumed by browser trust and authentication. */
export interface ConnectionTrustRequest {
  /** Request headers supplied by either the Fetch or node:http representation. */
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
  /** Cancellation of a Fetch request. */
  readonly signal?: AbortSignal | undefined
  /** Current disconnection state of a Node carrier. */
  readonly socket?: { readonly destroyed: boolean } | undefined
  /** Method and target supplied by the HTTP carrier. */
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** A credential verifier returning the existing Peer this request may represent. */
export interface AuthenticationProvider {
  /**
   * Verify one request using this implementation's credentials.
   * @param request - current request headers and cancellation facts.
   * @returns a provider-owned Peer, or undefined to try the next provider.
   */
  authenticate(request: ConnectionTrustRequest): PeerScope | undefined
}

/** Outcome of admitting one request: the Peer it speaks for, or the status refusing it. */
export type PeerAdmission =
  | { readonly peer: PeerScope }
  | { readonly rejection: 401 | 403 | 503 }

/**
 * Decide which Peer one request speaks for. Connection calls it only for
 * requests that already passed the Host/Origin checks and registered
 * authentication, so it can refuse a request but never admit one those checks
 * refused. It runs synchronously inside {@link HostConnectionHandle.admit} and
 * `webserver/authorize`, and must answer the same for the same headers, because
 * callers may admit one request more than once. Connection cannot tell a header
 * a login proxy set from one the client sent, so an admitter that recognizes
 * the caller from a request header trusts only a header that a proxy in front
 * of the Host removes from every client request before setting it, and the Host
 * is reachable only through that proxy.
 * @param request - headers of the HTTP or upgrade request.
 * @returns a live Peer, created through {@link HostConnectionHandle.createPeer}
 * with the principal the request speaks for, the owner principal included;
 * 401 or 403 to refuse; or `undefined` when the request names no Peer, which
 * Connection refuses with 401. Connection also refuses with 401 when the
 * admitter throws, and logs only the thrown Error's `name`, or the `typeof` of
 * a thrown value that is not an Error.
 */
export type PeerAdmitter = (request: ConnectionTrustRequest) => PeerScope | 401 | 403 | undefined

/** The Peer admission seam on the Host. */
export interface HostConnectionPeers {
  /**
   * The resolved `requireAdmitter` value of Connection's Config: whether this
   * Connection refuses with 401 every authenticated request while no admitter
   * is installed. A plugin that installs the admitter for a deployment that
   * depends on default deny reads it at load and refuses to start when it is
   * false, because a later configuration layer replaces the whole Connection
   * row and can drop the field.
   */
  readonly requireAdmitter: boolean

  /**
   * Install the sole Peer admitter. From then on every authenticated HTTP
   * request and WebSocket upgrade speaks for the Peer the admitter returns or
   * is refused; none is admitted directly as an authentication provider's Peer.
   * Removing the admitter restores provider admission, or refusal with 401 when
   * {@link requireAdmitter} is true.
   * @param admitter - synchronous decision applied after Connection's own checks.
   * @returns asynchronous disposer removing the admitter; it also leaves with the registering fiber.
   * @throws Error when another admitter is installed.
   */
  admitWith(admitter: PeerAdmitter): () => Promise<void>
}

/**
 * Handler invoked after Connection has decoded the transport envelope.
 * `peer` is the Peer the carrier admitted or the in-process caller supplied.
 */
export type ConnectionRpcHandler = (
  endpoint: string,
  payload: unknown,
  signal: AbortSignal,
  peer: PeerScope,
) => Promise<ConnectionRpcHandlerResult>

/** Synchronous ownership test for one endpoint on a shared RPC channel. */
export type ConnectionRpcEndpointMatcher = (endpoint: string) => boolean

/** HTTP methods supported by exact Fetch routes on the shared API channel. */
export type ConnectionFetchMethod = 'GET' | 'HEAD' | 'POST'

/** How the node:http bridge presents one request body to its Fetch route. */
export type ConnectionRequestBodyMode = 'buffered' | 'streaming'

/** One exact, transport-independent Fetch route owned by a Host feature. */
export interface ConnectionFetchRoute {
  /** Absolute path below `/api`; query parameters remain available on the request URL. */
  readonly path: string
  /** Methods this route owns. Other methods continue through normal shared-channel dispatch. */
  readonly methods: readonly ConnectionFetchMethod[]
  /** Buffered requests obey the configured JSON cap; streaming requests arrive with backpressure and no aggregate cap. */
  readonly requestBody: ConnectionRequestBodyMode
  /**
   * Handle one request from an owner Peer after the physical carrier has
   * applied its trust and authentication policy.
   */
  readonly fetch: (request: Request) => Promise<Response>
  /**
   * This route's own access rule for non-owner Peers. Without it the shared
   * handler answers 403 to every non-owner principal. With it, a request from
   * a live non-owner Peer is handed here instead of to {@link fetch}; a
   * disposed Peer is answered 401 first. The rule decides before the route
   * reads, writes, or opens anything, normally through `remoteAccess.decide()`
   * with the route path as the action, answers 403 when it refuses, and serves
   * the request itself when it allows. Each `decide()` call lists at least one
   * resource, because remote access allows a request that lists none. The
   * values the rule decides on come from the same parse of the request that
   * the route then serves, so a repeated query parameter cannot name one
   * resource to the decision and another to the read or write.
   */
  readonly serveNonOwner?: (request: Request, peer: PeerScope) => Promise<Response>
}

/** Host registry for exact Fetch routes that cannot use JSON Remote invocation. */
export interface HostConnectionFetch {
  /**
   * Register one exact route on the shared API channel.
   * @param route - path, methods, and Fetch-shaped implementation.
   * @returns asynchronous disposer removing this exact contribution.
   */
  register(route: ConnectionFetchRoute): () => Promise<void>
}

/** Host registry for logical RPC channels carried by the current transport. */
export interface HostConnectionRpc {
  /**
   * Register one authenticated absolute channel prefix.
   * @param channel - absolute logical channel such as `/rpc`.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the channel and its physical route.
   */
  handle(
    channel: string,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>

  /**
   * Intercept owned endpoints on the shared `/api` channel before its fallback.
   * @param channel - reserved shared channel; currently `/api`.
   * @param matches - synchronous endpoint ownership test.
   * @param handler - decoded endpoint handler returning the existing RPC result shape.
   * @returns asynchronous disposer removing the interceptor.
   */
  intercept(
    channel: '/api',
    matches: ConnectionRpcEndpointMatcher,
    handler: ConnectionRpcHandler,
  ): () => Promise<void>
}

/** Host `ctx.connection` members consumed by transport-independent adapters. */
export interface HostConnectionHandle {
  /** Generic RPC channel registry. */
  readonly rpc: HostConnectionRpc
  /** Exact Fetch routes for streaming or browser-native responses. */
  readonly fetch: HostConnectionFetch
  /** Connection-owned Peer for trusted in-process callers, not network authentication. */
  readonly browserPeer: PeerScope
  /** Peer admission seam; the admitter registration belongs to the Context reading it. */
  readonly peers: HostConnectionPeers

  /**
   * Whether this deployment accepts authorities beyond loopback: true only
   * when a validated `trustedHosts` entry names a non-loopback hostname.
   */
  readonly allowsRemoteAuthorities: boolean

  /**
   * Compose exact Fetch routes and the shared-channel RPC interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler for trusted, authenticated requests.
   */
  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

  /**
   * Apply Host/Origin checks and admit the first live Peer returned by a registered
   * credential verifier. With a Peer admitter installed, an authenticated request
   * speaks for the Peer the admitter returns; without one and with `requireAdmitter`
   * set, it is refused with 401.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns the admitted Peer, or the rejection status.
   */
  admit(request: ConnectionTrustRequest): PeerAdmission

  /**
   * Create an independent in-process Peer, disposed with the Context that read `ctx.connection`.
   * @param options - fixed principal and interaction participation (default answer).
   * @returns a new Peer distinct from every other Peer.
   */
  createPeer(options: { readonly principal: Principal; readonly interactions?: 'answer' | 'none' }): PeerScope
}

/** Transport-independent Fetch handler used by HTTP and worker carriers. */
export interface ConnectionFetchHandler {
  /**
   * Resolve body handling before the bridge reads any request bytes.
   * @param request - request method and URL available from node:http headers.
   * @returns the registered route's body handling mode.
   */
  requestBodyMode(request: { readonly method: string; readonly url: URL }): ConnectionRequestBodyMode

  /**
   * Dispatch one already-authenticated request.
   * @param request - Fetch request below the shared channel.
   * @param peer - Peer to dispatch as; required, never defaulted.
   * @returns the registered response; for an exact route and a non-owner Peer, the route's own
   * `serveNonOwner` response, 401 when that Peer is disposed, or 403 when the route declares none;
   * or a 404 response.
   */
  fetch(request: Request, peer: PeerScope): Promise<Response>
}

/** Client caller for logical RPC channels carried by the current transport. */
export interface ClientConnectionRpc {
  /**
   * Call one endpoint through an already registered logical channel.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `goals/create`.
   * @param payload - channel-owned request payload.
   * @param signal - optional caller cancellation.
   * @returns the endpoint-owned success/error result; correlation stays inside Connection.
   */
  call(
    channel: string,
    endpoint: string,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<ConnectionRpcResult<unknown>>

  /**
   * Open an in-process logical stream when the selected carrier supplies one.
   * Browser transports omit this method; API Gateway owns their WebSocket mux.
   * @param channel - absolute logical channel such as `/api`.
   * @param endpoint - channel-relative endpoint such as `session/follow`.
   * @param payload - channel-owned request payload.
   * @param signal - caller cancellation for this logical stream.
   * @param uplink - Client uplink items the Host method reads through `invocation.uplink()`.
   * @returns decoded stream values from the in-process carrier.
   */
  readonly open?: (
    channel: string,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
    uplink?: AsyncIterable<unknown>,
  ) => AsyncIterable<unknown>
}
