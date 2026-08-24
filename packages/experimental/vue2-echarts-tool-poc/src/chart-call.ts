/**
 * What one `show_chart` call looks like from outside the tool body: the wire
 * tool name, and the arguments read the same way by both halves of this
 * package.
 *
 * One home, because the host's session projection and the browser's transcript
 * row must agree on which logged calls are charts and which chart each one
 * belongs to. A call the projection counted but the row cannot draw would
 * supersede a chart the user is still looking at; a call the row draws but the
 * projection never counted could never be superseded at all.
 *
 * The module imports nothing, so the node half, the browser bundle, and the
 * session fold all read the same rules.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/chart-call
 */

/** The wire tool name, which is also the transcript view key this package claims. */
export const SHOW_CHART_TOOL_NAME = 'show_chart'

/** Largest accepted `id`, in characters. */
export const MAX_CHART_ID_LENGTH = 64

/** One call's chart arguments, as both halves of this package need them. */
export interface ChartCall {
  /** The stable chart id the call named, trimmed; absent when the call named none. */
  readonly id?: string
  /** Caption the model gave the chart, when it gave one. */
  readonly title?: string
  /** The option document to paint. */
  readonly option: Record<string, unknown>
}

/**
 * Read the chart id one argument value carries, normalized the way the tool
 * accepted it: surrounding whitespace is not part of the identity, so `" a "`
 * and `"a"` name one chart.
 * @param value - the `id` argument, however malformed.
 * @returns the trimmed id, or `undefined` when the call named none or named a blank one.
 */
export function chartIdOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed
}

/**
 * Read one call's chart arguments from the decoded argument value — the form
 * `tool/code-dispatch-start` records.
 * @param value - the decoded arguments, however malformed.
 * @returns the call, or `undefined` when the value carries no chart to draw.
 */
export function readChartCall(value: unknown): ChartCall | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { id?: unknown; title?: unknown; option?: unknown }
  if (candidate.option === null || typeof candidate.option !== 'object' || Array.isArray(candidate.option)) {
    return undefined
  }
  const id = chartIdOf(candidate.id)
  return {
    ...id === undefined ? {} : { id },
    ...typeof candidate.title === 'string' ? { title: candidate.title } : {},
    option: candidate.option as Record<string, unknown>,
  }
}

/**
 * Read one call's chart arguments from the raw argument JSON — the form
 * `tool/call` records and the transcript hands a row.
 * @param argsRaw - the raw argument JSON, however malformed.
 * @returns the call, or `undefined` when the JSON is unreadable or carries no chart.
 */
export function parseChartCall(argsRaw: string): ChartCall | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch (_argumentsAreNotJson) {
    // A log neither half can read is the only thing this tells us; the row's
    // unreadable notice says so, and there is nothing else to recover.
    return undefined
  }
  return readChartCall(parsed)
}
