/**
 * Connection Peers: the parties this Host answers to. Connection owns the
 * operator for its own lifetime and, unless its Config sets
 * `requireAdmitter`, admits every request as it while no Peer admitter is
 * installed; member Peers are opened through `connection.peers`.
 * Each Remote call receives the Peer it was admitted as in `invocation.peer`.
 * @module @deepseek-ai/dsh-client-connection/src/operator-peer
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { PeerId, PeerScope } from '@deepseek-ai/dsh-typert-protocol'

/**
 * One Peer's scope under a Connection-owned Context. The instance is its own
 * scope key, so `scopeOf(peer.ctx)` returns it and events dispatched with
 * `scopeTarget(subject, peer)` reach listeners registered through `peer.ctx`
 * and nobody else.
 */
export class ConnectionPeer implements PeerScope {
  readonly id: PeerId = randomUUID() as PeerId
  readonly ctx: Context
  private readonly scope: Scope
  private closing: Promise<void> | undefined

  /**
   * @param owner - Connection plugin context the scope fiber hangs under.
   * @param closed - called once, after the first `dispose()` call has quiesced the scope.
   */
  constructor(owner: Context, private readonly closed?: (peer: ConnectionPeer) => void) {
    this.scope = createScope(owner, this)
    this.ctx = this.scope.ctx
  }

  /**
   * Whether `dispose()` has been called. Connection admits no request as a released member Peer;
   * the operator is released only when Connection itself is disposed.
   */
  get released(): boolean {
    return this.closing !== undefined
  }

  /** Tear down every registration made through `ctx`; racing calls share one completion. */
  dispose(): Promise<void> {
    this.closing ??= this.close()
    return this.closing
  }

  private async close(): Promise<void> {
    await this.scope.dispose()
    this.closed?.(this)
  }
}

/** The operator's scope: a Connection Peer constructed without a close callback, so its disposal notifies nobody. */
export class OperatorPeer extends ConnectionPeer {}
