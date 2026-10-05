/**
 * The part of the console member directory this package calls: the
 * `consoleMembers` service, which owns which console member a request or a
 * session belongs to, and the read-only view of the held customer tokens this
 * package hands it.
 *
 * Signatures are the directory's own, copied member for member; only the
 * members this package calls are declared.
 *
 * TODO: delete this module and import these two types from
 * `@deepseek-ai/dsh-experimental-console-members` once that package is on
 * `product/server-console`. That package declares `Context.consoleMembers`
 * itself, and two declarations of the same property cannot compile together.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/member-directory
 */

import type { IncomingMessage } from 'node:http'
import type { PrincipalKey } from '@deepseek-ai/dsh-experimental-biz-backend'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

declare module '@deepseek-ai/cordis' {
  interface Context {
    consoleMembers: ConsoleMemberDirectory
  }
}

/** The members of the `consoleMembers` service this package calls. */
export interface ConsoleMemberDirectory {
  /**
   * The member one webserver request was admitted as. The directory runs the
   * connection's own admission first and verifies the deployment's signed
   * member assertion; this package reads no identity header of its own.
   * @param req - the request a webserver route is answering.
   * @returns that member's key, or `undefined` when the request is refused or names no member.
   */
  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined
  /**
   * The member one session belongs to. A session with a parent belongs to
   * whoever its top-level ancestor belongs to, and a chain with any link the
   * directory cannot place belongs to nobody.
   * @param sessionId - the session a read names.
   * @returns that member's key, or `undefined` when the session belongs to nobody the directory knows.
   */
  principalOfSession(sessionId: SessionId): PrincipalKey | undefined
  /**
   * Take the reader of the customer tokens this package holds. Accepted once;
   * a second call throws.
   * @param reader - the read-only view of the held tokens.
   * @returns a disposer that releases the reader.
   */
  attachCustomerCredentials(reader: CustomerCredentialReader): () => void
}

/**
 * The read-only view of the customer tokens this package holds, one per
 * member. It names no way to list the members it holds a token for.
 */
export interface CustomerCredentialReader {
  /**
   * The token held for one member.
   * @param principal - the member.
   * @returns the bare JWT, or `undefined` while none is held.
   */
  read(principal: PrincipalKey): string | undefined
  /**
   * Subscribe to the moments one member's token is set or dropped.
   * @param listener - called with the member and which of the two happened.
   * @returns a disposer that ends the subscription.
   */
  onChange(listener: (principal: PrincipalKey, kind: 'set' | 'dropped') => void): () => void
}
