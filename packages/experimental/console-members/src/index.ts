/**
 * The console member directory plugin. The package root is the plugin of the
 * row `name: '@deepseek-ai/dsh-experimental-console-members'`, and it
 * re-exports every type of `./types`, so importing it also loads the
 * `Context.consoleMembers` declaration.
 *
 * At load the row checks its Config, reads the assertion verification key,
 * requires Connection's `requireAdmitter` to be `true`, and opens the root
 * registry with the `rootSeeds` merged in; a failed check fails the load.
 * Then it provides `ctx.consoleMembers` and installs the Peer admitter that
 * admits each request as the member its signed assertion names.
 * `principalOfSession` is not implemented in this build and throws. The
 * `./credential-access` entry reads a loaded row's customer tokens and
 * registered members. Client programs import the types from
 * `@deepseek-ai/dsh-experimental-console-members/types`, never this root,
 * which imports Host entry points.
 *
 * @module @deepseek-ai/dsh-experimental-console-members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { installDirectory } from './install.ts'
import { loadMembers } from './load.ts'

export type * from './types.ts'
export { Config } from './config.ts'
export type { MemberRootSeed, RootSeed, UnownedRootSeed } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'console-members'

/** Connection, which admits members through this row, and the workspace registry, which holds each member's default workspace. */
export const inject = ['connection', 'workspaceRegistry']

/**
 * Load the row: check the Config, the assertion key and Connection's
 * `requireAdmitter`, open the root registry, then provide the directory and
 * install the Peer admitter. A failed check fails the load before anything is
 * registered.
 * @param ctx - the row's context.
 * @param config - the Config the schema accepted.
 */
export function apply(ctx: Context, config: Config): void {
  installDirectory(ctx, loadMembers(ctx, config))
}
