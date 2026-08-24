/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc`.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc'

/** Cordis companion plugin name. */
export const name = 'experimental-vue2-echarts-tool-poc-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this package owns no event stream and no mutable
 * durable data. A `show_chart` call appends nothing of its own — the tool
 * result is the loop's, and the durable screenshot is the attachment service's
 * — and the pending-verdict table is process-local state whose single-shot
 * settlement this package's own tests exercise. The `showCharts` projection
 * owns no data either: it is a pure fold over the loop's own tool events,
 * recomputed from them on every replay.
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
