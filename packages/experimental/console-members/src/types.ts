/**
 * Types of `ctx.consoleMembers`, the console member directory: which
 * signed-in member a browser request, a Remote caller, or a Session belongs
 * to, which directories are that member's roots, and per-member non-secret
 * storage.
 *
 * Importing this module, even with `import type {}`, loads the
 * `Context.consoleMembers` declaration. It imports no Host entry point, so a
 * Client program may import it.
 *
 * @module @deepseek-ai/dsh-experimental-console-members/types
 */

import type { IncomingMessage } from 'node:http'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { PeerScope } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'

/**
 * The key one signed-in console member is known by inside this process. Its
 * value is that member's `login_uid`.
 *
 * Consumers treat it as opaque. It reaches no model request, log line, or
 * upload.
 */
export type PrincipalKey = Branded<'PrincipalKey'>

/**
 * The console member directory, `ctx.consoleMembers`.
 *
 * Every method is synchronous; a {@link MemberStore} it returns reads and
 * writes asynchronously. No method returns, enumerates, or exposes a customer
 * token or the attached {@link CustomerCredentialReader}.
 */
export interface ConsoleMemberDirectory {
  /**
   * The member one browser request was admitted as, for a webServer route.
   *
   * Admits the request through `connection.admit(req)`, the check the `/api`
   * route applies, and looks up the member of the admitted Peer. This is the
   * only way a fork webServer route obtains the member of a request: such a
   * route reads no identity header and calls no `connection.admit` of its own.
   * @param req - the request the route is answering.
   * @returns that member's key, or `undefined` when admission refuses the request or the admitted Peer belongs to no member.
   */
  principalOfRequest(req: IncomingMessage): PrincipalKey | undefined
  /**
   * The member a Remote method's caller acts for. A member Peer that is
   * released, which `ctx.connection.peers.get(peer.id) === peer` decides,
   * acts for no member. The operator is recognised only by
   * `peer === ctx.connection.operator`: an `undefined` answer never means the
   * operator.
   * @param peer - the caller's Peer, `this.ctx.invocation.peer` inside a Remote method.
   * @returns that member's key, or `undefined` for the operator Peer, for a Peer this directory did not open for a member,
   *   and for a released member Peer.
   */
  principalOfCaller(peer: PeerScope): PrincipalKey | undefined
  /**
   * The member one Session belongs to.
   *
   * A Session without `parentSession` belongs to the member whose registered
   * root contains its `header.cwd`; a cwd under a root registered to no one, or
   * under no registered root, belongs to no member. A Session with
   * `parentSession` belongs to whoever its parent belongs to, followed up to the
   * topmost Session; when any Session on that chain is unknown or belongs to no
   * member, the answer is `undefined`. A child Session whose own `header.cwd`
   * lies under a root registered to another member or to no one answers
   * `undefined` and logs one warning that carries no principal key; a child
   * cwd under no registered root is not a conflict and leaves the parent-chain
   * answer in force. A child Session takes its parent's member synchronously
   * on `session/created`, and a Session not loaded since startup is resolved
   * through its parent chain. The Host alone writes `parentSession`, at fork
   * and at subagent creation; no RPC caller can set it.
   * @param sessionId - the Session to look up.
   * @returns that member's key, or `undefined` when the Session is unknown or belongs to no member.
   */
  principalOfSession(sessionId: SessionId): PrincipalKey | undefined
  /**
   * The member's default root, `<membersRoot>/<directory id>`. The member's
   * default workspace is its `workspace` subdirectory. The directory id does
   * not contain the principal key.
   * @param principal - the member.
   * @returns the absolute path of that member's default root.
   */
  memberRoot(principal: PrincipalKey): string
  /**
   * Every root registered to the member: the default root plus each root a
   * migration seed registers to them.
   * @param principal - the member.
   * @returns those roots' absolute paths.
   */
  rootsOf(principal: PrincipalKey): readonly string[]
  /**
   * The members that currently have an open Peer.
   * @returns their keys.
   */
  principals(): readonly PrincipalKey[]
  /**
   * Observe members opening and closing Peers: `opened` when a member's Peer
   * opens and `closed` when it closes, the changes {@link ConsoleMemberDirectory.principals}
   * reports.
   * @param listener - called with the member and the kind of change.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: (event: { principal: PrincipalKey; kind: 'opened' | 'closed' }) => void): () => void
  /**
   * Per-member storage for one caller-named unit, kept at
   * `dshHomePath('console-members', <directory id>, '<unit>.json')`. It holds
   * non-secret data only.
   * @param principal - the member the data belongs to.
   * @param unit - the caller's own name for its data, for example `'server-sidebar'`.
   * @returns the store for that member and unit.
   */
  memberStore(principal: PrincipalKey, unit: string): MemberStore
  /**
   * Attach the reader of members' customer tokens. The directory holds one
   * reader at a time: attaching while a reader is attached throws, and once
   * the returned disposer has run a new reader may be attached, as the token
   * holder's plugin does when it restarts. The holder calls this inside its
   * own `ctx.effect` and runs the disposer from that effect's cleanup.
   * Running the disposer counts as every member's token being dropped: the
   * directory stops reading and forwarding the reader, calls every detach
   * listener synchronously, and only then accepts another reader; the reader
   * emits no `dropped` for it. The disposer acts once, and a late call leaves
   * a reader attached since in place.
   * @param reader - the read-only customer-token reader.
   * @returns the disposer that detaches the reader.
   * @throws Error when a reader is already attached, including while its disposer calls the detach listeners and
   *   while the `onChange` of a reader being attached is subscribing.
   */
  attachCustomerCredentials(reader: CustomerCredentialReader): () => void
}

/**
 * Non-secret storage for one member and one unit, from
 * {@link ConsoleMemberDirectory.memberStore}.
 */
export interface MemberStore {
  /**
   * Read the stored value.
   * @returns the stored value, or `undefined` when nothing is stored.
   */
  read(): Promise<JsonValue | undefined>
  /**
   * Replace the whole stored value.
   * @param value - the new value.
   * @returns a promise that settles once the value is stored.
   */
  write(value: JsonValue): Promise<void>
}

/**
 * The read-only reader of members' customer tokens that a token holder hands
 * to {@link ConsoleMemberDirectory.attachCustomerCredentials}.
 */
export interface CustomerCredentialReader {
  /**
   * The member's current customer token.
   * @param principal - the member.
   * @returns the bare JWT, or `undefined` when the member has none.
   */
  read(principal: PrincipalKey): string | undefined
  /**
   * Observe a member's token being set or dropped.
   * @param listener - called with the member and the kind of change.
   * @returns the disposer that stops the notifications.
   */
  onChange(listener: (principal: PrincipalKey, kind: 'set' | 'dropped') => void): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The console member directory. */
    consoleMembers: ConsoleMemberDirectory
  }
}
