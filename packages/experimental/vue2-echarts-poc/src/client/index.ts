/**
 * Vue 2.7 component library, browser half. The row registers its dictionaries
 * and nothing else: it declares no slot and knows no layout, so a placement
 * plugin decides where its components render.
 *
 * **One Vue runtime per module graph.** Vue 2 reactivity does not cross runtime
 * copies — an observer, a `Dep`, and a render watcher from one copy are invisible
 * to another, so a component built against a second copy silently stops updating.
 * This bundle carries the only copy. A second Vue 2 package must therefore
 * request this row (`dsh.client.external: ['@deepseek-ai/dsh-experimental-vue2-echarts-poc/client']`)
 * and take `Vue` and the composition API from the re-exports below, never
 * `import 'vue'` for itself.
 *
 * The value exports are that row surface: the three React components, the
 * bridge, the chart vocabulary, the dictionary namespace, and the Vue 2.7 API a
 * consuming package needs.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-poc/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type Vue2EchartsPocKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Vue 2.7 chart panel's copy. */
    vue2EchartsPoc: Vue2EchartsPocKey
  }
}

export { NS } from './locales.ts'
export { ChartPanel } from './ChartPanel.tsx'
export { EChartsBar } from './EChartsBar.tsx'
export { EChartsOption } from './EChartsOption.tsx'
export { Vue2Bridge } from './vue2-bridge.tsx'
export { EChartsBarChart } from './echarts-chart.ts'
export { EChartsOptionChart } from './echarts-option-chart.ts'

export type { ChartPanelProps } from './ChartPanel.tsx'
export type { EChartsBarProps } from './EChartsBar.tsx'
export type { EChartsOptionProps } from './EChartsOption.tsx'
export type { EChartsBarChartProps } from './echarts-chart.ts'
export type { EChartsOptionChartProps } from './echarts-option-chart.ts'
export type { Vue2BridgeProps } from './vue2-bridge.tsx'
export type { Vue2EchartsPocKey } from './locales.ts'

// The chart vocabulary, so a browser consumer names the verdict and the
// supported series set from the same module it requests the components
// through, without reaching into this package's node half.
export { countSeriesPoints, SUPPORTED_SERIES_TYPES } from '../chart-types.ts'
export type { ChartVerdict, SupportedSeriesType } from '../chart-types.ts'

/**
 * The Vue 2.7 API surface, re-exported so a consuming package builds its
 * components against this bundle's runtime instead of inlining a second one.
 */
export {
  computed,
  default as Vue,
  defineComponent,
  h,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from 'vue'

/** Required service: the locale registry this row's dictionaries land in. */
export const inject = ['locale']

/**
 * Client plugin body: register this package's dictionaries.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'vue2-echarts-poc: dictionaries')
}
