/**
 * The checks the console member directory row runs at load, in order.
 * @module @deepseek-ai/dsh-experimental-console-members/src/load
 */

import type { KeyObject } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { readAssertionKey, readSettings, requireDefaultDeny, type Config, type MemberSettings } from './config.ts'
import { openRootRegistry, type RootRegistry } from './registry.ts'

/** What a successful load holds for the row. */
export interface LoadedMembers {
  /** The checked Config. */
  readonly settings: MemberSettings
  /** The key member assertions are verified with. */
  readonly assertionKey: KeyObject
  /** The root registry with the seeds merged in. */
  readonly registry: RootRegistry
}

/**
 * Run the load checks in order: the Config fields, the assertion key,
 * Connection's `requireAdmitter`, then the root registry at
 * `dshHomePath('console-members', 'roots.json')` with the seeds merged in.
 * The first failure throws, and nothing after it runs.
 * @param ctx - the row's context, carrying Connection.
 * @param config - the Config the schema accepted.
 * @returns the checked settings, the key, and the registry.
 * @throws {Error} from the first check that fails.
 */
export function loadMembers(ctx: Context, config: Config): LoadedMembers {
  const settings = readSettings(config)
  const assertionKey = readAssertionKey(config.assertionPublicKey)
  requireDefaultDeny(ctx.connection.peers)
  const registry = openRootRegistry({
    file: dshHomePath('console-members', 'roots.json'),
    membersRoot: settings.membersRoot,
    seeds: settings.rootSeeds,
    platform: process.platform,
    logger: ctx.logger('console-members'),
  })
  return { settings, assertionKey, registry }
}
