/** Generic unary RPC contracts shared by the Host and Client Connection halves. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'

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
}

/** HTTP status returned before dispatch, or undefined when the request may proceed. */
export type ConnectionRequestRejection = 401 | 403 | undefined

/** Root/index request facts used by the browser-token exchange. */
export interface ConnectionIndexRequest extends ConnectionTrustRequest {
  readonly method?: string | undefined
  readonly url?: string | undefined
}

/** Root/index response operations owned by the browser-token exchange. */
export interface ConnectionIndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}

/** Outcome of admitting one request: the Peer it speaks for, or the status refusing it. */
export type PeerAdmission =
  | { readonly peer: PeerScope }
  | { readonly rejection: 401 | 403 }

/**
 * Deployment-supplied decision about which member Peer one request speaks
 * for. Connection calls it only for requests that already passed the
 * Host/Origin checks and browser authentication, so it can refuse a request
 * but never admit one those checks refused. It runs synchronously inside
 * {@link HostConnectionHandle.admit} and must answer the same for the same
 * headers, because route handlers may admit one request more than once.
 * @param request - headers of the HTTP or upgrade request.
 * @returns a live Peer from {@link HostConnectionPeers.open}; 401 or 403 to
 * refuse; or `undefined` when the request names no member, which Connection
 * refuses with 401.
 */
export type PeerAdmitter = (request: ConnectionTrustRequest) => PeerScope | 401 | 403 | undefined

/**
 * Member Peers on the Host. A member Peer carries no identity; the plugin that
 * installs the admitter keeps its own mapping from members to Peers.
 */
export interface HostConnectionPeers {
  /**
   * The resolved `requireAdmitter` value of Connection's Config: whether this
   * Connection refuses with 401 every request that passes its own checks while
   * no admitter is installed. A plugin that installs the admitter for a
   * deployment that depends on default deny reads it at load and refuses to
   * start when it is false, because a later configuration layer replaces the
   * whole Connection row and can drop the field.
   */
  readonly requireAdmitter: boolean

  /**
   * Install the sole Peer admitter. From then on every HTTP request and
   * WebSocket upgrade speaks for the member Peer the admitter returns, or is
   * refused; none is admitted as the operator. Removing the admitter restores
   * operator admission, or refusal with 401 when {@link requireAdmitter} is
   * true.
   * @param admitter - synchronous decision applied after Connection's own checks.
   * @returns asynchronous disposer removing the admitter; it also leaves with the registering fiber.
   * @throws Error when another admitter is installed.
   */
  admitWith(admitter: PeerAdmitter): () => Promise<void>

  /**
   * Open one member Peer scope under Connection and emit
   * `connection/peer-opened` before returning it. The first completed
   * `dispose()` emits `connection/peer-closed`; unloading Connection disposes
   * every member Peer still open.
   * @returns the new Peer.
   */
  open(): PeerScope

  /**
   * Look up one live member Peer.
   * @param id - identity of a Peer returned by {@link open}.
   * @returns the Peer while it is open and `dispose()` has not been called, otherwise `undefined`.
   */
  get(id: PeerId): PeerScope | undefined

  /**
   * List the live member Peers.
   * @returns Peers returned by {@link open} whose `dispose()` has not been called; never the operator.
   */
  list(): readonly PeerScope[]
}

/**
 * Handler invoked after Connection has decoded the transport envelope.
 * `peer` is the Peer the request was admitted as: the operator, or the member
 * Peer an installed admitter returned.
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
   * Handle one request after the physical carrier has applied its trust and
   * authentication policy; `peer` is the Peer the request was admitted as.
   */
  readonly fetch: (request: Request, peer: PeerScope) => Promise<Response>
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
  /**
   * The operator Peer, which every admitted request speaks for while no
   * admitter is installed and `requireAdmitter` is false; its scope lives as
   * long as Connection.
   */
  readonly operator: PeerScope
  /** Member Peer admission and lifetime. */
  readonly peers: HostConnectionPeers

  /**
   * Compose exact Fetch routes and the shared-channel RPC interceptor.
   * @param channel - shared channel mounted by Connection.
   * @returns Fetch handler for trusted, authenticated requests.
   */
  createSharedFetchHandler(channel: '/api'): ConnectionFetchHandler

  /**
   * Apply {@link admit} to another Web route and keep only its verdict:
   * Connection's Host/Origin checks, browser authentication, and the installed
   * Peer admitter's refusal all reject.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns rejection status, or undefined when the route may accept the request.
   */
  requestRejection(request: ConnectionTrustRequest): ConnectionRequestRejection

  /**
   * Admit one request. A failed Host/Origin check is refused with 403 and a
   * missing browser session with 401, before any admitter runs. Without an
   * admitter the request speaks for the operator, or is refused with 401
   * when {@link HostConnectionPeers.requireAdmitter} is true. With one, it
   * speaks for the live member Peer the admitter returns; 401 and 403 from
   * the admitter refuse it, and `undefined` or a Peer that is released or was
   * not opened by {@link HostConnectionPeers.open} refuses it with 401 and
   * logs one error. Synchronous; repeated calls for the same headers agree
   * while the admitter does.
   * @param request - request headers from the HTTP or upgrade request.
   * @returns the admitted Peer, or the rejection status.
   */
  admit(request: ConnectionTrustRequest): PeerAdmission

  /**
   * Authenticate one frontend index request, owning a token redirect or 401.
   * @param request - root or configured-index HTTP request.
   * @param response - response owned when the result is false.
   * @returns true only when the frontend may serve index.html.
   */
  authorizeIndex(request: ConnectionIndexRequest, response: ConnectionIndexResponse): boolean

  /**
   * Add the fresh process token to an ordinary Web application URL.
   * @param baseUrl - clean application URL whose authority and mount are preserved.
   * @returns tokenized URL for initial login; a mount proxy strips its prefix before {@link authorizeIndex}.
   */
  authenticatedUrl(baseUrl: string): string
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
   * @param peer - Peer the request was admitted as; omitted, the request speaks for the operator.
   * @returns the registered response or a 404 response.
   */
  fetch(request: Request, peer?: PeerScope): Promise<Response>
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
