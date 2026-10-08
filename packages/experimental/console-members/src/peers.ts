/**
 * The member Peer table: which open Peer each admitted member speaks through,
 * the admitter Connection calls for every HTTP request and WebSocket upgrade,
 * and the idle close.
 *
 * A member keeps one Peer while it lives, so repeated admissions of one
 * request, and every request of one member, speak through the same Peer. A
 * Peer leaves the table when this table disposes it, when Connection reports
 * it closed, or when an admission finds it released; a Peer that left is
 * never re-entered, so a socket event that arrives for it afterwards changes
 * nothing. A member's next admission opens a new Peer.
 *
 * A Peer is idle while no Remote stream socket is bound to it. An idle Peer
 * is disposed once `peerIdleMs` has passed since the later of its last
 * admission and the close of its last socket. That time is measured with
 * `performance.now()`, a monotonic clock, so setting the system clock back or
 * forward neither delays nor hastens the close, and every pending idle check
 * is due within `peerIdleMs`.
 *
 * No log line or error text of this module carries a principal key, an
 * assertion, or a header value.
 * @module @deepseek-ai/dsh-experimental-console-members/src/peers
 */

import type { Logger } from '@deepseek-ai/cordis'
import type { RemoteSocketId } from '@deepseek-ai/dsh-api-gateway'
import type { ConnectionTrustRequest, HostConnectionPeers } from '@deepseek-ai/dsh-client-connection'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { verifyAssertion, type AssertionCheck } from './assertion.ts'
import type { PrincipalKey } from './types.ts'

/** A change {@link MemberPeers.onChange} reports. */
export interface MemberChange {
  /** The member. */
  readonly principal: PrincipalKey
  /** `opened` when the member's Peer opened, `closed` when it left the table. */
  readonly kind: 'opened' | 'closed'
}

/** One member's Peer in the table. */
interface MemberEntry {
  readonly principal: PrincipalKey
  readonly peer: PeerScope
  /** The Remote stream sockets bound to the Peer. */
  readonly sockets: Set<RemoteSocketId>
  /** When the Peer was last admitted, or its last socket closed, in `performance.now()` milliseconds. */
  lastActive: number
  /** The pending idle check, armed only while no socket is bound. */
  idleTimer: ReturnType<typeof setTimeout> | undefined
}

/** What a {@link MemberPeers} table works with. */
export interface MemberPeersOptions {
  /** Connection's member Peer registry. */
  readonly peers: HostConnectionPeers
  /** The assertion header, key and deployment id. */
  readonly assertion: AssertionCheck
  /** Registers a member's root on first sighting; synchronous, may throw. */
  readonly ensureMember: (principal: PrincipalKey) => string
  /** Starts a member's default-workspace registration unless one is in flight or has succeeded; the promise never rejects unhandled. */
  readonly ensureDefaultWorkspace: (principal: PrincipalKey) => Promise<unknown>
  /** Milliseconds an idle Peer stays open. */
  readonly peerIdleMs: number
  /** The row's logger. */
  readonly logger: Logger
}

/** The form of a Node system error code, the only part of an admission failure that is logged. */
const ERRNO_CODE = /^E[A-Z0-9]+$/

/** The member Peers one loaded row opened. */
export class MemberPeers {
  private readonly byPrincipal = new Map<PrincipalKey, MemberEntry>()
  private readonly byPeer = new Map<PeerId, MemberEntry>()
  private readonly listeners = new Set<(change: MemberChange) => void>()

  /**
   * @param options - Connection's Peers, the assertion check, the registration steps, the idle time and the logger.
   */
  constructor(private readonly options: MemberPeersOptions) {}

  /**
   * The Peer admitter. It verifies the request's assertion and answers the
   * member's live Peer, opening one when the member has none: the member's
   * root is registered first, and no Peer opens when that fails. Every
   * admission starts the member's default-workspace registration unless it
   * is in flight or has succeeded, without waiting for it. Every request it
   * does not admit, and every failure inside it, is answered 401; it never
   * throws and never answers `undefined`.
   * @param request - the headers of the HTTP request or upgrade.
   * @returns the member's live Peer, or 401.
   */
  admit(request: ConnectionTrustRequest): PeerScope | 401 {
    try {
      return this.admitVerified(request)
    } catch (failure) {
      const code = (failure as NodeJS.ErrnoException | undefined)?.code
      // Only an errno code is kept: the failure's text can carry a member root path.
      const detail = typeof code === 'string' && ERRNO_CODE.test(code) ? ` (${code})` : ''
      this.options.logger.warn(`console-members: admitting a member failed${detail}; the request is refused with 401`)
      return 401
    }
  }

  /**
   * The member a Peer speaks for.
   * @param peer - a Peer, for example a Remote caller's.
   * @returns the member, or `undefined` for the operator, for a Peer this table did not open, and for a Peer
   *   that is released, which `peers.get(peer.id) === peer` decides.
   */
  principalOf(peer: PeerScope): PrincipalKey | undefined {
    const entry = this.byPeer.get(peer.id)
    return entry?.peer === peer && this.options.peers.get(peer.id) === peer ? entry.principal : undefined
  }

  /**
   * The members whose Peer is in the table and not released. A Peer is
   * released as soon as its disposal starts, before Connection reports it
   * closed, so a member leaves this list at the moment {@link principalOf}
   * stops answering for their Peer.
   * @returns their keys, in the order their Peers opened.
   */
  principals(): readonly PrincipalKey[] {
    return [...this.byPrincipal.values()]
      .filter(entry => this.options.peers.get(entry.peer.id) === entry.peer)
      .map(entry => entry.principal)
  }

  /**
   * Observe members' Peers opening and leaving the table. A throwing listener
   * is logged without its error or the member, and the others still run.
   * @param listener - called with each change.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: (change: MemberChange) => void): () => void {
    const registered = (change: MemberChange): void => { listener(change) }
    this.listeners.add(registered)
    return () => { this.listeners.delete(registered) }
  }

  /**
   * Record a Remote stream socket bound to a Peer. A Peer not in the table is
   * ignored.
   * @param peer - the Peer the upgrade was admitted as.
   * @param socketId - the socket.
   */
  socketOpened(peer: PeerScope, socketId: RemoteSocketId): void {
    const entry = this.entryOf(peer)
    if (entry === undefined) return
    entry.sockets.add(socketId)
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
  }

  /**
   * Record a Remote stream socket closing. When it was the Peer's last
   * socket, the idle time starts. A Peer not in the table is ignored.
   * @param peer - the Peer the upgrade was admitted as.
   * @param socketId - the socket.
   */
  socketClosed(peer: PeerScope, socketId: RemoteSocketId): void {
    const entry = this.entryOf(peer)
    if (entry === undefined) return
    entry.sockets.delete(socketId)
    if (entry.sockets.size > 0) return
    entry.lastActive = performance.now()
    this.armIdle(entry, this.options.peerIdleMs)
  }

  /**
   * Remove a Peer Connection reports closed. A Peer not in the table is ignored.
   * @param peer - the closed Peer.
   */
  peerClosed(peer: PeerScope): void {
    const entry = this.entryOf(peer)
    if (entry !== undefined) this.discard(entry)
  }

  /**
   * Remove every Peer from the table and dispose it; Connection's Gateway
   * closes each Peer's sockets with code 1001. Only the Peers themselves are
   * used, so this works after Connection has unloaded.
   * @returns a promise that settles once every Peer is disposed.
   */
  async disposeAll(): Promise<void> {
    const entries = [...this.byPeer.values()]
    for (const entry of entries) this.discard(entry)
    await Promise.all(entries.map(entry => entry.peer.dispose()))
  }

  /**
   * Admit a request whose failures {@link admit} turns into 401.
   * @param request - the headers of the HTTP request or upgrade.
   * @returns the member's live Peer, or 401 when the assertion is refused.
   * @throws {Error} when registering a new member's root fails.
   */
  private admitVerified(request: ConnectionTrustRequest): PeerScope | 401 {
    const verdict = verifyAssertion(request.headers, this.options.assertion, Math.floor(Date.now() / 1000))
    if ('refusal' in verdict) return 401
    const { principal } = verdict
    const entry = this.liveEntry(principal) ?? this.open(principal)
    void this.options.ensureDefaultWorkspace(principal)
    entry.lastActive = performance.now()
    if (entry.sockets.size === 0) this.armIdle(entry, this.options.peerIdleMs)
    return entry.peer
  }

  /**
   * The member's entry while its Peer is live. An entry whose Peer is
   * released leaves the table.
   * @param principal - the member.
   * @returns the entry, or `undefined` when the member has no live Peer.
   */
  private liveEntry(principal: PrincipalKey): MemberEntry | undefined {
    const entry = this.byPrincipal.get(principal)
    if (entry === undefined || this.options.peers.get(entry.peer.id) === entry.peer) return entry
    this.discard(entry)
    return undefined
  }

  /**
   * Register the member's root, then open and record a Peer for them.
   * Connection emits `connection/peer-opened` inside `peers.open()`, so a
   * listener that admits the same member records an entry first; the Peer
   * opened here is then disposed and that entry answered, which keeps one
   * Peer per member. When recording the Peer throws, for example on a stack
   * exhausted by listeners that keep re-entering, the Peer is disposed before
   * the error is rethrown, since neither {@link disposeAll} nor the idle close
   * reaches a Peer outside the table.
   * @param principal - the member.
   * @returns the member's entry.
   * @throws {Error} when registering the member's root fails, in which case no Peer is opened, or when recording the
   *   opened Peer fails.
   */
  private open(principal: PrincipalKey): MemberEntry {
    this.options.ensureMember(principal)
    const peer = this.options.peers.open()
    let entry: MemberEntry
    try {
      const recorded = this.byPrincipal.get(principal)
      if (recorded !== undefined) {
        void peer.dispose()
        return recorded
      }
      entry = { principal, peer, sockets: new Set(), lastActive: performance.now(), idleTimer: undefined }
      this.byPeer.set(peer.id, entry)
      this.byPrincipal.set(principal, entry)
    } catch (failure) {
      this.byPeer.delete(peer.id)
      void peer.dispose()
      throw failure
    }
    this.announce({ principal, kind: 'opened' })
    return entry
  }

  /**
   * The table entry of one Peer.
   * @param peer - a Peer.
   * @returns the entry when this exact Peer is in the table.
   */
  private entryOf(peer: PeerScope): MemberEntry | undefined {
    const entry = this.byPeer.get(peer.id)
    return entry?.peer === peer ? entry : undefined
  }

  /**
   * Schedule the idle check unless one is pending.
   * @param entry - the member's entry.
   * @param delay - milliseconds until the check.
   */
  private armIdle(entry: MemberEntry, delay: number): void {
    if (entry.idleTimer !== undefined) return
    entry.idleTimer = setTimeout(() => { this.idleCheck(entry) }, delay)
    entry.idleTimer.unref()
  }

  /**
   * Dispose the Peer when it has stayed without a socket and without an
   * admission for `peerIdleMs`; otherwise check again when that time would
   * end. Removing the entry and binding a socket both cancel the check, so it
   * runs only for an entry in the table with no socket.
   * @param entry - the member's entry.
   */
  private idleCheck(entry: MemberEntry): void {
    entry.idleTimer = undefined
    const remaining = entry.lastActive + this.options.peerIdleMs - performance.now()
    if (remaining > 0) {
      this.armIdle(entry, remaining)
      return
    }
    this.discard(entry)
    void entry.peer.dispose()
  }

  /**
   * Remove an entry that is in the table, stop its idle check, and report
   * the member closed.
   * @param entry - the member's entry.
   */
  private discard(entry: MemberEntry): void {
    this.byPeer.delete(entry.peer.id)
    this.byPrincipal.delete(entry.principal)
    clearTimeout(entry.idleTimer)
    entry.idleTimer = undefined
    this.announce({ principal: entry.principal, kind: 'closed' })
  }

  /**
   * Call every change listener.
   * @param change - the change.
   */
  private announce(change: MemberChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (_listenerFailure) {
        // The listener's error can quote the member's key, so neither the error nor the member is logged.
        this.options.logger.warn(`console-members: a consoleMembers.onChange listener threw (${change.kind})`)
      }
    }
  }
}
