/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-component-kit`.
 * @module @deepseek-ai/dsh-experimental-component-kit/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-component-kit'

/** Cordis companion plugin name. */
export const name = 'experimental-component-kit-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package is a table of React renderers. Its host
 * half is an empty plugin, it appends no session event, owns no mutable durable
 * data, and reads no projection — every value a renderer draws arrives as props
 * from the placement package, which validates them against the catalog that
 * admitted the block. The one relationship it does own, the dictionary
 * registration and its removal on teardown, is a locale effect this package's
 * own tests exercise.
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
