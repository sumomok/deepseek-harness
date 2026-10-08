/**
 * Carrier-independent Typert Gateway request, service, and error contracts.
 * @module @deepseek-ai/dsh-api-gateway/types
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvocationDescriptor, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteEventAgentId, RemoteEventHostInfo } from './stream-protocol.ts'

/** One Remote method request after a carrier has decoded its envelope. */
export interface InvokeRemoteRequest {
  /** Remote namespace selected by the generated descriptor. */
  readonly namespace: string
  /** Exported Service method name. */
  readonly method: string
  /** Named wire values; fields must exactly match the descriptor. */
  readonly args: Readonly<Record<string, unknown>>
  /**
   * Client uplink items of this logical stream, delivered to the method through
   * `invocation.uplink()`; absent means an immediately ended iterable.
   */
  readonly uplink?: AsyncIterable<unknown>
  /** Peer the call speaks for; absent means an in-process carrier, answered as the operator. */
  readonly peer?: PeerScope
  /** Carrier or direct-caller cancellation injected only into cancellation-aware methods. */
  readonly signal?: AbortSignal
}

/**
 * One Remote call as `remote/invoke` listeners see it: its descriptor has
 * resolved and its arguments are not yet validated.
 */
export interface RemoteInvokeCall {
  /** Canonical `<namespace>/<method>` endpoint. */
  readonly endpoint: string
  /**
   * Entry point of the call: `unary` for `invoke()` and the `/api` RPC carrier, `stream` for `stream()` and the
   * stream carriers. A method whose descriptor has the other mode fails inside `next()` with `gateway/signature-invalid`.
   */
  readonly mode: 'unary' | 'stream'
  /**
   * Peer the call speaks for: the Peer Connection admitted, or the operator for an in-process carrier that names none.
   * The Gateway fixes it when it builds the call as a non-writable property, so every listener and the method see it.
   */
  readonly peer: PeerScope
  /** Receiver selection: `direct`, or `context` with its Context kind and the wire field carrying its identity. */
  readonly invocation: InvocationDescriptor['invocation']
  /** Context projection of a direct call's sole lookup parameter; present only when the descriptor declares one. */
  readonly scope?: InvocationDescriptor['scope']
  /** Business parameters in order, each with its wire field, `json` or `lookup` source, and lookup key. */
  readonly parameters: InvocationDescriptor['parameters']
  /**
   * Named wire values, unvalidated. A listener may assign a replacement before calling `next()`; `next()`
   * validates and passes on whatever this field holds when it runs.
   */
  args: Readonly<Record<string, unknown>>
}

/** What `next()` of `remote/invoke` produced: a unary business result, or the stream the carrier delivers. */
export type RemoteInvokeOutcome =
  | { readonly kind: 'value'; readonly value: unknown }
  | { readonly kind: 'stream'; readonly source: AsyncIterable<unknown> }

/** One Host Cordis notification forwarded unchanged to Client Remote subscribers. */
export interface TypertRemoteEventFrame {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Original event argument list after the owner validates it for JSON transport. */
  readonly args: readonly unknown[]
}

/** Live Host values used to project one scoped Remote Event. */
export interface TypertRemoteEventContext {
  /** Live Agent Context that owns cancellation of the forwarded waterfall. */
  readonly value: Context
  /** Agent object carried directly by the waterfall request. */
  readonly subject: object
  /** Agent identity read directly from the scoped event subject. */
  readonly agentId: string
}

/** Result returned from a Client waterfall, or delegation back to the Host chain. */
export type TypertRemoteEventOutcome =
  | { readonly kind: 'result'; readonly value: unknown }
  | { readonly kind: 'next' }

/**
 * One scoped waterfall invocation yielded by the application event source.
 * The Gateway alone assigns transport ids and resolves the continuation after
 * a Client result or explicit delegation.
 */
export interface TypertRemoteEventInvocation {
  /** Original Host Cordis event name. */
  readonly event: string
  /** Sole request argument before the waterfall's `next()` callback. */
  readonly request: object
  readonly context: TypertRemoteEventContext
  /** Resume the source's Cordis listener with a Client result or `next()`. */
  readonly resolve: (outcome: TypertRemoteEventOutcome) => void
  /** Reject the source's Cordis listener after cancellation, transport failure, or Client rejection. */
  readonly reject: (reason: unknown) => void
}

/** Notification or scoped waterfall accepted from the sole Remote Event source. */
export type TypertRemoteEventDispatch = TypertRemoteEventFrame | TypertRemoteEventInvocation

/**
 * One forwarded event as the Remote Event filter sees it before the Gateway
 * queues it for one `$events` Client. Every field carries data the Gateway has
 * already validated as lossless JSON, and the Client receives the same values.
 */
export type RemoteEventDelivery =
  | {
    readonly kind: 'emit'
    /** Original Host Cordis event name. */
    readonly event: string
    /** Event argument list. */
    readonly args: readonly unknown[]
  }
  | {
    readonly kind: 'waterfall'
    /** Original Host Cordis event name. */
    readonly event: string
    /** Identity of the Agent the waterfall is scoped to, as the Client frame carries it. */
    readonly agentId: RemoteEventAgentId
    /** Request fields without the Agent object and the cancellation signal. */
    readonly request: Readonly<Record<string, unknown>>
  }

/**
 * Decide whether one `$events` Client receives one forwarded event. The Gateway
 * calls the filter synchronously, once per Client, and never awaits it. An
 * asynchronous filter is a type error: its promise withholds the event, and a
 * rejection it produces is the installer's to handle.
 * @param delivery - the forwarded event.
 * @param peer - the Peer that opened the Client's `$events` stream.
 * @returns `true` to deliver the event to this Client; any other value withholds it.
 */
export type RemoteEventFilter = (delivery: RemoteEventDelivery, peer: PeerScope) => boolean

/**
 * Open the application-selected event stream for one Client carrier. The
 * factory must attach all incremental Host listeners before it returns; the
 * Gateway publishes its readiness item immediately afterward.
 * @param signal - cancellation shared with the Client stream and registration.
 * @returns the long-lived stream of notifications and scoped waterfall invocations.
 */
export type TypertRemoteEventSource = (
  signal: AbortSignal,
) => AsyncIterable<TypertRemoteEventDispatch>

/** Carrier-facing access to decoded Remote streams and their stable failures. */
export interface TypertGatewayWireStream {
  /**
   * Open one logical stream from its wire endpoint and payload.
   * @param endpoint - canonical Remote endpoint or Gateway-owned stream name.
   * @param payload - decoded carrier payload.
   * @param uplink - Client-to-Host items of the logical stream; a Gateway-owned endpoint returns its iterator
   * as soon as it opens, so the carrier drops those items instead of buffering them.
   * @param peer - Peer the stream speaks for; `undefined` means the operator's in-process carrier.
   * @param signal - logical-stream cancellation.
   * @returns validated stream values.
   */
  readonly open: (
    endpoint: string,
    payload: unknown,
    uplink: AsyncIterable<unknown>,
    peer: PeerScope | undefined,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<unknown>>

  /**
   * Convert a stream failure to the carrier-safe Remote failure fields.
   * @param error - failure raised while opening or consuming a stream.
   * @returns stable code, message, and details for the Client.
   */
  readonly failure: (error: unknown) => {
    readonly code: string
    readonly message: string
    readonly details: object
  }
}

/** Stable infrastructure and boundary failures emitted before or after business execution. */
export type TypertGatewayErrorCode =
  | 'gateway/ambiguous-endpoint'
  | 'gateway/arguments-invalid'
  | 'gateway/binding-invalid'
  | 'gateway/context-failed'
  | 'gateway/context-not-found'
  | 'gateway/context-unavailable'
  | 'gateway/definition-unavailable'
  | 'gateway/forbidden'
  | 'gateway/input-invalid'
  | 'gateway/invocation-unavailable'
  | 'gateway/lookup-failed'
  | 'gateway/lookup-not-found'
  | 'gateway/lookup-unavailable'
  | 'gateway/method-unavailable'
  | 'gateway/protocol'
  | 'gateway/provider-mismatch'
  | 'gateway/result-invalid'
  | 'gateway/service-unavailable'
  | 'gateway/signature-invalid'
  | 'gateway/uplink-overflow'

/** Host dispatcher consumed by Connection adapters. */
export interface TypertGateway {
  /** Carrier adapter shared by WebSocket and in-process transports. */
  readonly wireStream: TypertGatewayWireStream

  /**
   * Check for an active Client event stream.
   * @returns whether a stream is open and has not been cancelled.
   */
  hasLiveClient(): boolean

  /**
   * Register the application-selected forwarded-event source.
   * @param source - stream factory installed by the Remote assembly.
   * @param host - stable Host facts included in each Client generation's opening frame.
   * @returns disposer removing this exact source and cancelling its active streams.
   */
  registerRemoteEvents(
    source: TypertRemoteEventSource,
    host: RemoteEventHostInfo,
  ): () => Promise<void>

  /**
   * Install the sole Remote Event filter. From then on a forwarded notification reaches, and a scoped waterfall
   * is delivered to, only the `$events` Clients whose opening Peer the filter accepts, both when the event arrives
   * and when a Client connects while a waterfall is pending. A filter that throws counts as `false` and is logged.
   * A waterfall that no Client receives stays pending. Installing the filter delivers each pending waterfall to each
   * connected Client it accepts that has not received it; notifications are not replayed, and removing the filter
   * withdraws nothing already queued. Without a filter, every Client receives every event while
   * `connection.peers.memberAdmission` is false or no Connection is mounted, and no Client receives any while it is
   * true.
   * @param filter - synchronous decision per event and Client.
   * @returns asynchronous disposer removing the filter; it also leaves with the installing fiber.
   * @throws Error when another filter is installed.
   */
  filterRemoteEvents(filter: RemoteEventFilter): () => Promise<void>

  /**
   * Invoke one live Remote method without assuming a carrier or response envelope.
   * @param request - decoded endpoint and named wire arguments.
   * @returns the business result without output decoding.
   * @throws {@link TypertGatewayError} for dispatch, provider, or boundary failures; lookup-policy and business errors retain identity.
   */
  invoke(request: InvokeRemoteRequest): Promise<unknown>

  /**
   * Open one live stream Remote method without assuming a physical carrier.
   * @param request - decoded endpoint, named wire arguments, and the Client uplink when the carrier has one.
   * @returns a cancellation-aware iterable over the business results.
   */
  stream(request: InvokeRemoteRequest): Promise<AsyncIterable<unknown>>

  /**
   * List the method endpoints the `/api` carrier claims: every live strict definition and every SRC
   * marker on an active Service, each a `<namespace>/<method>` the carrier accepts. The carrier also
   * claims `$events/result` and withdrawn strict endpoints, which no method serves; neither is listed.
   * @returns sorted endpoints, read from the registry and Services at call time.
   */
  claimedEndpoints(): readonly string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host dispatcher for Typert Remote calls. */
    typertGateway: TypertGateway
  }
}
