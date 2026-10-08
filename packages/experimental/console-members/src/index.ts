/**
 * The console member directory plugin. The package root is the plugin of the
 * row `name: '@deepseek-ai/dsh-experimental-console-members'`, and it
 * re-exports every type of `./types`, so importing it also loads the
 * `Context.consoleMembers` declaration.
 *
 * At load the row checks its Config, reads the assertion verification key,
 * requires Connection's `requireAdmitter` to be `true`, and opens the root
 * registry with the `rootSeeds` merged in; a failed check fails the load. The
 * row does not provide `consoleMembers` yet, so a consumer's
 * `inject: ['consoleMembers']` stays pending. Client programs import the types
 * from `@deepseek-ai/dsh-experimental-console-members/types`, never this root,
 * which imports Host entry points.
 *
 * @module @deepseek-ai/dsh-experimental-console-members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'
import { loadMembers } from './load.ts'

export type * from './types.ts'
export { Config } from './config.ts'
export type { MemberRootSeed, RootSeed, UnownedRootSeed } from './config.ts'

/** Stable Cordis plugin name. */
export const name = 'console-members'

/** Connection, whose `requireAdmitter` the load checks. */
export const inject = ['connection']

/**
 * Load the row: check the Config, the assertion key and Connection's
 * `requireAdmitter`, and open the root registry. A failed check fails the
 * load.
 * @param ctx - the row's context.
 * @param config - the Config the schema accepted.
 */
export function apply(ctx: Context, config: Config): void {
  loadMembers(ctx, config)
}
