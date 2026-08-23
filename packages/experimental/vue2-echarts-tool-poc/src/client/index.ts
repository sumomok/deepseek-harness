/**
 * show-chart browser half: it claims the `show_chart` key of the transcript's
 * tool-view slot and paints each call's option through the Vue 2.7 component
 * row.
 *
 * `tool.call.toolview` is keyed and open, and the key is the wire tool name, so
 * claiming this package's own tool is additive: every other call keeps the row
 * it already had, and this row rides whichever shell the composition mounts —
 * the shipped one on `develop`, the service-line one on this branch. That is
 * why the placement is here rather than in a layout-aware package.
 *
 * `EChartsOption` is a value import across packages, which the client bundle
 * purity gate allows only for a declared module request: the manifest's
 * `dsh.client.external` names the component row's `/client` specifier, the
 * modules node half orders that row ahead of this one, and the loader answers
 * the require from the same materialized bundle. That is also what keeps one
 * Vue runtime in the graph.
 *
 * Whether a painted chart is captured is host configuration, and a browser half
 * receives no cordis config — the boot manifest carries plugin names, not their
 * `config` blocks — so apply reads it from the node half's settings route
 * before claiming the key. A failed read fails the row: a transcript that
 * silently captured nothing would be indistinguishable from one honoring the
 * setting.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the tool package's `tool.call.toolview` SlotMap declaration.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import { SHOW_CHART_SETTINGS_ROUTE, type ShowChartSettings } from '../route.ts'
import { ShowChartRow, type ShowChartFace } from './ShowChartRow.tsx'
import { en, NS, zh, type ShowChartKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The transcript chart row's copy. */
    showChart: ShowChartKey
  }
}

export type { ShowChartFace, ShowChartRowProps } from './ShowChartRow.tsx'
export { sanitizeChartOption } from './sanitize.ts'

/** Required services: the slot registry and the locale registry. */
export const inject = ['slots', 'locale']

/**
 * Read the browser-facing half of this plugin's configuration from its node half.
 * @returns the settings the node half serves.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a
 * document without a usable capture switch.
 */
async function readSettings(): Promise<ShowChartSettings> {
  const response = await fetch(SHOW_CHART_SETTINGS_ROUTE, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`show-chart: ${SHOW_CHART_SETTINGS_ROUTE} answered ${response.status}`)
  }
  const settings = await response.json() as Partial<ShowChartSettings>
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  if (typeof settings.screenshot !== 'boolean') {
    throw new Error(`show-chart: ${SHOW_CHART_SETTINGS_ROUTE} answered an unusable screenshot switch: ${JSON.stringify(settings.screenshot)}`)
  }
  return { screenshot: settings.screenshot }
}

/**
 * Client plugin body: register the dictionaries and claim the tool's view key.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'show-chart: dictionaries')
  const settings = await readSettings()
  const face: ShowChartFace = { screenshot: settings.screenshot }
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'show_chart',
    locale: NS,
    // Configuration is settled in the apply world and handed over as plain
    // data; the row reads none of its own.
    inject: () => face,
  }, ShowChartRow))
}
