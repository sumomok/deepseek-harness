/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-content-surface`.
 * @module @deepseek-ai/dsh-experimental-content-surface/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-content-surface'

/** Cordis companion plugin name. */
export const name = 'experimental-content-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event and owns no
 * mutable durable data. Its entries are a pure fold over events other packages
 * own and validate, and the projection registry already validates every value
 * this row publishes against the unit's own `viewSchema`.
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
