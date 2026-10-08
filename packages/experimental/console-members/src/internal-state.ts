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
import type { CustomerCredentials } from './credentials.ts'
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
  /** The customer-token reader slot. */
  readonly credentials: CustomerCredentials
}

/** A directory instance, or the proxy of one, as {@link directoryState} recognises it. */
interface StatefulDirectory {
  readonly [DIRECTORY_STATE]: DirectoryState
}

/**
 * Whether a value carries a directory state under this module's symbol.
 * @param value - the value.
 * @returns `true` for a directory created with this module's symbol, or the proxy of one.
 */
function isStateful(value: object): value is StatefulDirectory {
  return DIRECTORY_STATE in value
}

/**
 * The state of a directory, read through the symbol so that the traceable
 * proxy another plugin receives works as the instance does.
 * @param directory - `ctx.consoleMembers` or the instance behind it.
 * @returns the directory's state.
 * @throws {Error} when the value is not a directory this package's plugin row created with this module's symbol.
 */
export function directoryState(directory: object): DirectoryState {
  if (!isStateful(directory)) {
    throw new Error('console-members: the value is not a console member directory this package\'s plugin row provided')
  }
  return directory[DIRECTORY_STATE]
}
