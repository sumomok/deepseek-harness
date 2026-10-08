/**
 * `ctx.consoleMembers`, the console member directory one loaded row provides.
 *
 * Every method reads the row's state through {@link DIRECTORY_STATE}, so it
 * works when called through the traceable proxy another plugin receives.
 * `principalOfSession` and `attachCustomerCredentials` are not implemented
 * in this build: both throw.
 * @module @deepseek-ai/dsh-experimental-console-members/src/directory
 */

import type { IncomingMessage } from 'node:http'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import { DIRECTORY_STATE, type DirectoryState } from './internal-state.ts'
import type { ConsoleMemberDirectory, CustomerCredentialReader, MemberStore, PrincipalKey } from './types.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** The console member directory service. */
export class ConsoleMembersDirectory extends Service implements ConsoleMemberDirectory {
  /** The row's state; see {@link DIRECTORY_STATE}. */
  readonly [DIRECTORY_STATE]: DirectoryState

  /**
   * Provide `ctx.consoleMembers` on the row's fiber.
   * @param ctx - the row's context.
   * @param state - the row's Connection, root registry and member Peer table.
   */
  constructor(ctx: Context, state: DirectoryState) {
    super(ctx, 'consoleMembers')
    this[DIRECTORY_STATE] = state
  }

  /**
   * Admit the request through Connection, as the `/api` route does, and look
   * up the member of the admitted Peer.
   * @param req - the request the route is answering.
   * @returns that member's key, or `undefined` when admission refuses the request.
   */
  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined {
    const state = this[DIRECTORY_STATE]
    const admission = state.connection.admit(req)
    return 'peer' in admission ? state.members.principalOf(admission.peer) : undefined
  }

  /**
   * The member a Remote caller's Peer speaks for. The operator is recognised
   * only by `peer === ctx.connection.operator`; an `undefined` answer does not
   * mean the operator.
   * @param peer - the caller's Peer.
   * @returns that member's key, or `undefined` for the operator, for a Peer this directory did not open, and for a
   *   released member Peer.
   */
  principalOfCaller(peer: PeerScope): PrincipalKey | undefined {
    return this[DIRECTORY_STATE].members.principalOf(peer)
  }

  /**
   * Not implemented in this build.
   * @param _sessionId - the Session to look up.
   * @returns never.
   * @throws {Error} always.
   */
  principalOfSession(_sessionId: SessionId): PrincipalKey | undefined {
    throw new Error('console-members: principalOfSession is not implemented in this build')
  }

  /**
   * The member's default root from the root registry.
   * @param principal - a member admitted at least once.
   * @returns the root's absolute path.
   */
  memberRoot(principal: PrincipalKey): string {
    return this[DIRECTORY_STATE].registry.memberRoot(principal)
  }

  /**
   * Every root registered to the member.
   * @param principal - the member.
   * @returns those roots' absolute paths.
   */
  rootsOf(principal: PrincipalKey): readonly string[] {
    return this[DIRECTORY_STATE].registry.rootsOf(principal)
  }

  /**
   * The members whose Peer is open.
   * @returns their keys.
   */
  principals(): readonly PrincipalKey[] {
    return this[DIRECTORY_STATE].members.principals()
  }

  /**
   * Observe members' Peers opening and closing. The registration belongs to
   * the calling plugin's fiber and ends when that fiber unloads.
   * @param listener - called with the member and the kind of change.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: (event: { principal: PrincipalKey; kind: 'opened' | 'closed' }) => void): () => void {
    const members = this[DIRECTORY_STATE].members
    const dispose = this.ctx.effect(() => members.onChange(listener), 'console-members: onChange listener')
    return () => { void dispose() }
  }

  /**
   * The member's store for one unit.
   * @param principal - a member admitted at least once.
   * @param unit - lower-case letters, digits and `-`.
   * @returns the store.
   */
  memberStore(principal: PrincipalKey, unit: string): MemberStore {
    return this[DIRECTORY_STATE].registry.memberStore(principal, unit)
  }

  /**
   * Not implemented in this build.
   * @param _reader - the customer-token reader.
   * @returns never.
   * @throws {Error} always.
   */
  attachCustomerCredentials(_reader: CustomerCredentialReader): () => void {
    throw new Error('console-members: attachCustomerCredentials is not implemented in this build')
  }
}
