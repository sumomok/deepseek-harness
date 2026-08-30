/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-attachment-spill`.
 * @module @deepseek-ai/dsh-attachment-spill/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-attachment-spill'

/** Cordis companion plugin name. */
export const name = 'attachment-spill-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the idempotency cache and its `attachment/materialized`
 * log record are enforced directly at the `resolveSpill` call site; this
 * package exposes no independent event sequence or mutable data relation
 * beyond that.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
