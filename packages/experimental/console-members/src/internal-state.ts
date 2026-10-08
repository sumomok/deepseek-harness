/**
 * The key under which a console member directory instance holds its state.
 *
 * `ctx.consoleMembers` is a Cordis traceable proxy, a new one on every read,
 * and the directory's methods run with that proxy as `this`. A property keyed
 * by a symbol passes through the proxy to the instance, so every method and
 * every entry point of this package reads the state as `directory[DIRECTORY_STATE]`.
 * This module is the only place the symbol is created; each entry point
 * imports it from here.
 * @module @deepseek-ai/dsh-experimental-console-members/src/internal-state
 */

import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { MemberPeers } from './peers.ts'
import type { RootRegistry } from './registry.ts'

/** The property key of a directory's {@link DirectoryState}. */
export const DIRECTORY_STATE: unique symbol = Symbol('console-members directory state')

/** What one loaded row's directory works with. */
export interface DirectoryState {
  /** Connection as the row's context reads it. */
  readonly connection: HostConnectionHandle
  /** The root registry. */
  readonly registry: RootRegistry
  /** The member Peer table. */
  readonly members: MemberPeers
}
