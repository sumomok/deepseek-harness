/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-vue2-echarts-content-poc`.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-content-poc/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-vue2-echarts-content-poc'

/** Cordis companion plugin name. */
export const name = 'experimental-vue2-echarts-content-poc-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event stream and no mutable
 * durable data. Its only relationship — the content-column registration and its
 * removal on teardown — is a slot effect this package's own tests exercise.
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
