/**
 * The customer-token reader slot of one loaded row: the reader a token
 * holder attaches, and the listeners `./credential-access` registers.
 *
 * The slot holds one reader at a time. Running an attachment's disposer
 * stops forwarding the reader's changes and stops reading it, then calls
 * every detach listener synchronously, then frees the slot; until the slot
 * is free, attaching throws. The disposer acts once, and only for its own
 * attachment, so a repeated or late call neither notifies again nor detaches
 * a reader attached since.
 *
 * No log line or error text of this module carries a principal key or a
 * token.
 * @module @deepseek-ai/dsh-experimental-console-members/src/credentials
 */

import type { Logger } from '@deepseek-ai/cordis'
import { Listeners } from './listeners.ts'
import type { CustomerCredentialReader, PrincipalKey } from './types.ts'

/** One attached reader and its `onChange` subscription. */
class Attachment {
  /** Stops the forwarding of the reader's changes. */
  readonly stopForwarding: () => void

  /**
   * Subscribe to the reader. `forward` receives this attachment with each
   * change, including a change the reader reports while subscribing.
   * @param reader - the token holder's reader.
   * @param forward - called with this attachment and each change the reader reports.
   */
  constructor(readonly reader: CustomerCredentialReader, forward: (source: Attachment, principal: PrincipalKey, kind: 'set' | 'dropped') => void) {
    this.stopForwarding = reader.onChange((principal, kind) => { forward(this, principal, kind) })
  }
}

/** The customer-token reader slot. */
export class CustomerCredentials {
  /** The attachment that holds the slot, from attach until its disposer has notified every detach listener. */
  private holder: Attachment | undefined
  /** The attachment whose reader is read and forwarded: the holder until its disposer starts. */
  private live: Attachment | undefined
  private readonly changed: Listeners<[PrincipalKey, 'set' | 'dropped']>
  private readonly detached: Listeners<[]>

  /**
   * @param logger - the row's logger.
   */
  constructor(private readonly logger: Logger) {
    this.changed = new Listeners(logger, 'console-members: a customer credential onChange listener threw')
    this.detached = new Listeners(logger, 'console-members: a customer credential onDetached listener threw')
  }

  /**
   * Attach a reader and start forwarding its changes.
   * A change the reader reports while its `onChange` is subscribing is not
   * forwarded, because the reader is not attached until `onChange` returns.
   * @param reader - the token holder's reader.
   * @returns the disposer that detaches this reader.
   * @throws {Error} when a reader holds the slot, including while its disposer is notifying detach listeners, and
   *   with the reader's own error when its `onChange` throws; the slot is unchanged then.
   */
  attach(reader: CustomerCredentialReader): () => void {
    if (this.holder !== undefined) {
      throw new Error('console-members: a customer credential reader is already attached; its disposer must run before another reader attaches')
    }
    const attachment = new Attachment(reader, (source, principal, kind) => {
      if (this.live === source) this.changed.emit(principal, kind)
    })
    this.holder = attachment
    this.live = attachment
    return () => { this.detach(attachment) }
  }

  /**
   * A member's customer token from the live reader.
   * @param principal - the member.
   * @returns the token, or `undefined` when no reader is live or it has none for the member.
   */
  read(principal: PrincipalKey): string | undefined {
    return this.live?.reader.read(principal)
  }

  /**
   * Observe the live reader's `set` and `dropped`, across every reader attached later.
   * @param listener - called with the member and the kind of change.
   * @returns the disposer that removes the listener.
   */
  onChange(listener: (principal: PrincipalKey, kind: 'set' | 'dropped') => void): () => void {
    return this.changed.add(listener)
  }

  /**
   * Observe a reader being detached.
   * @param listener - called inside the disposer, before the slot is free.
   * @returns the disposer that removes the listener.
   */
  onDetached(listener: () => void): () => void {
    return this.detached.add(listener)
  }

  /**
   * Detach one attachment while it is live: stop forwarding and reading it,
   * call the detach listeners, then free the slot.
   * @param attachment - the attachment whose disposer ran.
   */
  private detach(attachment: Attachment): void {
    if (this.live !== attachment) return
    this.live = undefined
    try {
      attachment.stopForwarding()
    } catch (_stopFailure) {
      // The reader belongs to another plugin, and its error text is not ours to repeat.
      this.logger.warn('console-members: the customer credential reader\'s onChange disposer threw; its changes are no longer forwarded')
    }
    this.detached.emit()
    this.holder = undefined
  }
}
