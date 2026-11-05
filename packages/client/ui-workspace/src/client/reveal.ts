/**
 * Message reveals a Session navigation asks for.
 *
 * "Open this Session at this message" is one navigation action, so its target
 * travels with the selection instead of through a second service that could
 * land before or after the selection settles. The request outlives the Session
 * open: it stays pending until the Session's Conversation renders and consumes
 * it, and a repeat for the same message still produces a new request identity,
 * so landing twice in one Session works.
 */
import { notifySubscribers, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'

/** A message one Session navigation asked the Session's transcript to show. */
export interface SessionRevealRequest {
  /** Per-request identity; a repeated request for the same message is a new identity. */
  readonly id: number
  /** Session whose transcript consumes the request. */
  readonly sessionId: SessionId
  /** Durable log position of the message to show. */
  readonly seq: SessionSeq
}

/** Optional destination of one Session navigation. */
export interface OpenSessionOptions {
  /**
   * Durable event position to land on once the Session's Conversation renders.
   * Omitted by ordinary selection changes, which also withdraw an earlier
   * pending reveal for the Session.
   */
  readonly revealSeq?: SessionSeq
}

/** One Session's pending reveal, published only when it changes. */
class MutableRevealSource implements ObservableSnapshot<SessionRevealRequest | null> {
  private readonly listeners = new Set<() => void>()
  private published: SessionRevealRequest | null

  /**
   * @param read - current pending request for the owning Session.
   */
  constructor(private readonly read: () => SessionRevealRequest | null) {
    this.published = read()
  }

  readonly getSnapshot = (): SessionRevealRequest | null => this.read()

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Publish the current request when its identity moved. */
  publish(): void {
    const next = this.getSnapshot()
    if (next === this.published) return
    this.published = next
    notifySubscribers(this.listeners, '[ui-workspace] reveal request')
  }
}

/** Pending reveal per Session, raised by navigation and consumed by the transcript. */
export class SessionReveals {
  private sequence = 0
  private readonly pending = new Map<SessionId, SessionRevealRequest>()
  private readonly sources = new Map<SessionId, MutableRevealSource>()

  /**
   * Raise one reveal, superseding any request still pending for the Session.
   * @param sessionId - Session whose transcript must land on `seq`.
   * @param seq - durability-addressed message position.
   */
  request(sessionId: SessionId, seq: SessionSeq): void {
    this.sequence += 1
    this.pending.set(sessionId, { id: this.sequence, sessionId, seq })
    this.mutableSource(sessionId).publish()
  }

  /**
   * Drop a pending request a later navigation without a message target supersedes.
   * @param sessionId - Session the superseding navigation selected.
   */
  withdraw(sessionId: SessionId): void {
    if (!this.pending.delete(sessionId)) return
    this.mutableSource(sessionId).publish()
  }

  /**
   * Read one Session's pending request. The source identity is stable for the
   * Session, so a rendered hook keeps one subscription across requests.
   * @param sessionId - Session whose transcript consumes the request.
   * @returns current pending request, or null when none awaits.
   */
  source(sessionId: SessionId): ObservableSnapshot<SessionRevealRequest | null> {
    return this.mutableSource(sessionId)
  }

  private mutableSource(sessionId: SessionId): MutableRevealSource {
    let source = this.sources.get(sessionId)
    if (source === undefined) {
      source = new MutableRevealSource(() => this.pending.get(sessionId) ?? null)
      this.sources.set(sessionId, source)
    }
    return source
  }

  /**
   * Consume one handled request. A newer request for the same Session stays
   * pending, so a landing the reader has not seen is never lost.
   * @param sessionId - Session whose transcript handled the request.
   * @param id - request identity the transcript handled.
   */
  settle(sessionId: SessionId, id: number): void {
    const current = this.pending.get(sessionId)
    if (current === undefined || current.id !== id) return
    this.pending.delete(sessionId)
    this.mutableSource(sessionId).publish()
  }
}
