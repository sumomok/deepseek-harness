/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-server-layout`.
 * @module @deepseek-ai/dsh-experimental-server-layout/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-server-layout'

/** Cordis companion plugin name. */
export const name = 'experimental-server-layout-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the shell's panel store emits no cordis event and
 * holds no durable data, and the only relationship this package owns — the
 * root registration plus the ctx.layout face it provides in the same effect —
 * is a slot/service effect whose install and teardown this package's own
 * specs exercise directly.
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
