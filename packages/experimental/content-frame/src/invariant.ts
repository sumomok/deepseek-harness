/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-content-frame`.
 * @module @deepseek-ai/dsh-experimental-content-frame/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-content-frame'

/** Cordis companion plugin name. */
export const name = 'experimental-content-frame-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package emits no cordis event and owns no mutable
 * durable data — the hosted directory is a read-only input the harness never
 * writes. Its two relationships, the webserver route registration and the
 * content-slot registration, are effects whose install and teardown this
 * package's own specs exercise directly.
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
