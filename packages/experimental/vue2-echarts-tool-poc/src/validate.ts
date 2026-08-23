/**
 * What `show_chart` decides about an option before any browser sees it: the
 * bounds a deployment sets, and the series types the component row can paint.
 *
 * Every rejection here is model-facing text, so each one names the offending
 * value and the correction. Nothing in this module touches a browser, an
 * attachment, or a session — a refusal costs one round trip and no state.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/validate
 */

import { Buffer } from 'node:buffer'
import { countSeriesPoints, SUPPORTED_SERIES_TYPES } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc'

/** The supported series types as one model-facing list, used by both the description and the refusals. */
export const SUPPORTED_SERIES_LIST = SUPPORTED_SERIES_TYPES.join(', ')

/** The deployment bounds one option is measured against. */
export interface ChartLimits {
  /** Largest accepted `JSON.stringify(option)` in UTF-8 bytes. */
  readonly maxOptionBytes: number
  /** Largest accepted total of `series[i].data` entries. */
  readonly maxPoints: number
}

/** An option as the tool's parameter schema guarantees it: an object carrying a `series` array. */
export interface ChartOptionArgument {
  /** The series list; the schema enforces the array, this module enforces its contents. */
  readonly series: readonly unknown[]
}

/** Name one series' declared type in a refusal. */
function seriesTypeLabel(type: unknown): string {
  return typeof type === 'string' ? JSON.stringify(type) : 'none'
}

/** Whether one series entry declares a type this row registers a chart module for. */
function isSupported(type: unknown): boolean {
  return typeof type === 'string' && (SUPPORTED_SERIES_TYPES as readonly string[]).includes(type)
}

/**
 * Decide whether one model-supplied option may reach a browser.
 * @param option - the validated `option` argument.
 * @param limits - the deployment bounds.
 * @returns the model-facing refusal, or `undefined` when the option is paintable.
 */
export function validateChartOption(
  option: ChartOptionArgument,
  limits: ChartLimits,
): string | undefined {
  const bytes = Buffer.byteLength(JSON.stringify(option), 'utf8')
  if (bytes > limits.maxOptionBytes) {
    return `show_chart: the option is ${bytes} bytes; this deployment accepts at most ${limits.maxOptionBytes}. Send fewer points or shorter labels.`
  }
  if (option.series.length === 0) {
    return 'show_chart: option.series must list at least one series.'
  }
  for (const [index, entry] of option.series.entries()) {
    const type = entry === null || typeof entry !== 'object'
      ? undefined
      : (entry as { type?: unknown }).type
    if (!isSupported(type)) {
      return `show_chart: unsupported series type ${seriesTypeLabel(type)} at series[${index}]. Supported types: ${SUPPORTED_SERIES_LIST}.`
    }
  }
  const points = countSeriesPoints(option.series)
  if (points > limits.maxPoints) {
    return `show_chart: the option carries ${points} data points; this deployment accepts at most ${limits.maxPoints}. Aggregate the data before charting it.`
  }
  return undefined
}
