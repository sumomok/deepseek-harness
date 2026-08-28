/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-auth-gate`.
 * @module @deepseek-ai/dsh-experimental-auth-gate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-auth-gate'

/** Cordis companion plugin name. */
export const name = 'experimental-auth-gate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event and owns no
 * durable data. The one piece of mutable state it does own — the held access
 * token — is deliberately unreachable from anywhere but the plugin closure that
 * holds it, because a reader an invariant could use would be a reader an
 * attacker could use. Its shape is enforced where it enters, by the token
 * route's own parse, and `tests/auth-gate-routes.client.spec.ts` covers that
 * the route refuses everything else.
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
