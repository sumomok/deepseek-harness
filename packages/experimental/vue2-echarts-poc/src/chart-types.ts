/**
 * The chart vocabulary this row shares with its consumers: the series types it
 * registers ECharts modules for, the verdict a rendered option answers with,
 * and the point count both sides derive from a series list.
 *
 * The module imports nothing — no DOM, no ECharts, no Vue — so a host plugin
 * validating a model-supplied option names the same set the browser can paint,
 * and a browser row reports counts the host recognizes.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-poc/src/chart-types
 */

/**
 * Series types this row registers ECharts chart modules for. One home for the
 * supported set: the client's module registration is derived from it, and a
 * host validating an option rejects everything outside it.
 */
export const SUPPORTED_SERIES_TYPES = ['bar', 'line', 'pie', 'radar'] as const

/** One member of {@link SUPPORTED_SERIES_TYPES}. */
export type SupportedSeriesType = typeof SUPPORTED_SERIES_TYPES[number]

/**
 * What one rendered option answers with: the totals ECharts actually painted,
 * or the message that stopped it.
 */
export type ChartVerdict =
  | {
    /** The option painted. */
    readonly ok: true
    /** Series ECharts holds after the applied option. */
    readonly seriesCount: number
    /** Data points across those series, counted by {@link countSeriesPoints}. */
    readonly pointCount: number
  }
  | {
    /** The option did not paint. */
    readonly ok: false
    /** Failure text, from the thrown value's message. */
    readonly error: string
  }

/**
 * Count the data points a series list carries. Entries whose `data` is not an
 * array contribute nothing, which is what a series driven by a dataset or by a
 * transform does.
 * @param series - the option's `series` list, however malformed.
 * @returns the total number of `data` entries across the list.
 */
export function countSeriesPoints(series: readonly unknown[]): number {
  let points = 0
  for (const entry of series) {
    if (entry === null || typeof entry !== 'object') continue
    const data = (entry as { data?: unknown }).data
    if (Array.isArray(data)) points += data.length
  }
  return points
}
