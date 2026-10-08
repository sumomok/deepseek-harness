/**
 * Package-internal access to one console member directory row, for the
 * console line's organization credential source: members' customer tokens
 * through the attached reader, and every member in the root registry.
 *
 * Neither function is a method of {@link ConsoleMemberDirectory}; a plugin
 * calls them by importing this subpath and passing its `ctx.consoleMembers`.
 * Both read the row's state through the symbol the package root's directory
 * holds it under, so this entry and the package root must share one copy of
 * that module. This entry is a typed access path, not a confidentiality
 * boundary: any plugin holding `ctx.consoleMembers` can reach the same state.
 * Its source imports Host modules, so only Host plugins import it; Client
 * programs import `./types`.
 *
 * Every `onChange`, `onDetached` and `onAdded` returns a plain disposer and
 * belongs to no fiber; register it inside the calling plugin's `ctx.effect`
 * so it ends when that plugin unloads. An access object is bound to the row
 * instance it was created from, so create it in the scope that injects
 * `consoleMembers`. When the row unloads, that scope is disposed before the
 * token holder's disposer runs, so an `onDetached` listener registered in it
 * is not called; the scope's own cleanup counts as every token being
 * dropped.
 * @module @deepseek-ai/dsh-experimental-console-members/credential-access
 */

import { directoryState } from './internal-state.ts'
import type { ConsoleMemberDirectory, PrincipalKey } from './types.ts'

/** Members' customer tokens through the reader attached to one directory row. */
export interface CustomerCredentialAccess {
  /**
   * The member's current customer token from the attached reader.
   * @param principal - the member.
   * @returns the bare JWT, or `undefined` when no reader is attached, its disposer has started, or the member has no
   *   token.
   */
  read(principal: PrincipalKey): string | undefined
  /**
   * Observe the attached reader reporting a member's token set or dropped.
   * The listener stays registered across detach and attach, and receives
   * the changes of whichever reader is attached. Once a reader's disposer
   * has started, no listener receives a change from that reader, including
   * a change being forwarded at that moment. Detaching a reader reports no
   * `dropped`; {@link CustomerCredentialAccess.onDetached} reports it.
   * @param listener - called with the member and the kind of change.
   * @returns the disposer that removes the listener; a notification already running still calls it.
   */
  onChange(listener: (principal: PrincipalKey, kind: 'set' | 'dropped') => void): () => void
  /**
   * Observe the attached reader being detached, which counts as every
   * member's token being dropped. Each listener is called once per detach,
   * synchronously inside the holder's disposer, before another reader can
   * attach. The holder may have revoked the reader before running the
   * disposer, so a listener must not read tokens; {@link CustomerCredentialAccess.read}
   * answers `undefined` from the moment the disposer starts.
   * @param listener - called with no argument.
   * @returns the disposer that removes the listener; a notification already running still calls it.
   */
  onDetached(listener: () => void): () => void
}

/** Every member in one directory row's root registry. */
export interface MemberRegistryAccess {
  /**
   * The members that have a member root: each member admitted at least
   * once, including members with no open Peer. A principal that only a
   * `rootSeeds` entry names joins at its first admission.
   * @returns their keys, in registration order.
   */
  principals(): readonly PrincipalKey[]
  /**
   * Observe a member's first admission registering their member root. The
   * listener is called synchronously inside that admission, after
   * `roots.json` is written and before the member's Peer opens; later
   * admissions of the member, and the members `roots.json` held at load, are
   * not reported. The registry has no removal.
   * @param listener - called with the member.
   * @returns the disposer that removes the listener; a notification already running still calls it.
   */
  onAdded(listener: (principal: PrincipalKey) => void): () => void
}

/**
 * Access the customer tokens of one directory row's members.
 * @param directory - `ctx.consoleMembers`, or the instance behind it.
 * @returns the access object, bound to that row.
 * @throws {Error} when the directory is not one this package's plugin row provided with this module copy's state symbol.
 */
export function customerCredentialAccess(directory: ConsoleMemberDirectory): CustomerCredentialAccess {
  const { credentials } = directoryState(directory)
  return {
    read: principal => credentials.read(principal),
    onChange: listener => credentials.onChange(listener),
    onDetached: listener => credentials.onDetached(listener),
  }
}

/**
 * Access the root registry's members of one directory row.
 * @param directory - `ctx.consoleMembers`, or the instance behind it.
 * @returns the access object, bound to that row.
 * @throws {Error} when the directory is not one this package's plugin row provided with this module copy's state symbol.
 */
export function memberRegistryAccess(directory: ConsoleMemberDirectory): MemberRegistryAccess {
  const { registry } = directoryState(directory)
  return {
    principals: () => registry.memberPrincipals(),
    onAdded: listener => registry.onMemberAdded(listener),
  }
}
