/**
 * Vue 2.7-in-React component library, node half. Pure UI plugin: the empty
 * apply exists so the plugin appears in the host cordis.yml / Loader, which is
 * what makes the browser half discoverable through the package.json
 * `dsh.client` declaration and the `exports["./client"]` bundle.
 *
 * The chart vocabulary (`./chart-types.ts`, its one home) is re-exported here
 * so a host plugin validating a model-supplied option reads the supported
 * series set and the point counter from the row that paints them, instead of
 * restating either.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-poc
 */

export { countSeriesPoints, SUPPORTED_SERIES_TYPES } from './chart-types.ts'
export type { ChartVerdict, SupportedSeriesType } from './chart-types.ts'

/** Host plugin body — this surface plugin has no host-side behavior. */
export function apply(): void {}
