/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-server-base`.
 * @module @deepseek-ai/dsh-experimental-server-base/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-server-base'

/** Cordis companion plugin name. */
export const name = 'experimental-server-base-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event and owns no
 * mutable or durable data. Its one contribution is two index rows built from a
 * configuration value that `requireBasePath` has already refused every
 * unusable form of, and the rows exist only inside the table the web server
 * collects per index render — a relation an invariant would have to re-emit
 * that event to observe, which would serve an index nobody asked for. The
 * relation between the served markup and the configured prefix is covered by
 * `tests/server-base.spec.ts`, which reads it off a real HTTP response.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
