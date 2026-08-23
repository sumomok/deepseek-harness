/**
 * Content-column placement, browser half: it claims the service-line shell's
 * `content` seat and renders the chart panel the component row exports.
 *
 * The split is the point. The components live in
 * [`vue2-echarts-poc`](../../../vue2-echarts-poc/README.md), which knows no
 * layout; this row knows only where they go. `content` is declared by
 * `dsh-experimental-server-layout`, a shell that exists on this product branch
 * alone, so the placement is what stays here while the components travel.
 *
 * `ChartPanel` is a value import across packages, which the bundle purity gate
 * allows only for a declared module request: the manifest's
 * `dsh.client.external` names the component row's `/client` specifier, the
 * modules node half orders that row ahead of this one, and the loader answers
 * the require from the same materialized bundle. That is also what keeps one
 * Vue runtime in the graph.
 *
 * `content` is a `single` slot, so this row and `dsh-experimental-content-frame`
 * are alternatives: a composition mounts one or the other, never both.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-content-poc/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the service-line shell's `content` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-experimental-server-layout/client'
import { ChartPanel, NS } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'

/** Required service: the slot registry this row's contribution lands in. */
export const inject = ['slots']

/**
 * Client plugin body: claim the content column once the shell declares it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('content', () => ctx.slots.register({ name: 'content', locale: NS }, ChartPanel))
}
