/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-biz-backend`.
 * @module @deepseek-ai/dsh-experimental-biz-backend/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-biz-backend'

/** Cordis companion plugin name. */
export const name = 'experimental-biz-backend-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package appends no session event, owns no durable
 * data, and keeps no mutable state of its own — the token it spends belongs to
 * whoever constructed the service and is reachable only through that closure.
 * What could be asserted about a call is its answer, and an answer is the
 * backend's to give; `tests/biz-backend.spec.ts` states what each one becomes.
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
