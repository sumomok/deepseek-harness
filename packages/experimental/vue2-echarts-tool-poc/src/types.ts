/**
 * Pure types of the chart-projection domain: the ONE home of the `showCharts`
 * projection key, free of this package's host-side value imports (zod, node,
 * dsh-tools). Two namespace projections serve it — the package root for host
 * consumers, `./client` for the browser row — with zero content duplication.
 *
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/types
 */

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    showCharts: ShowChartEntry[]
  }
  interface SessionProjectionMap {
    /**
     * Every `show_chart` call this session's log recorded, in log order, plus
     * the call that currently owns each chart id. The host folds it because
     * the log is the host's; the browser resolves nothing.
     */
    showCharts: ShowChartsView
  }
}

/**
 * One recorded `show_chart` call. `chartId` is the id the call named, or its
 * own call id when it named none — a call without an id is therefore its own
 * chart and can supersede nothing.
 */
export interface ShowChartEntry {
  /** The chart this call belongs to: the call's trimmed `id`, or its `callId`. */
  readonly chartId: string
  /** The call that drew it — a top-level `callId`, or a code-mode `subCallId`. */
  readonly callId: string
  /** Caption the call gave the chart; null when it gave none. */
  readonly title: string | null
  /** Log sequence number of the call event, so consumers can order without re-reading the log. */
  readonly seq: number
}

/** Whole current value of the `showCharts` projection. */
export interface ShowChartsView {
  /** Every recorded chart call, in log order. */
  readonly entries: readonly ShowChartEntry[]
  /**
   * The call id currently owning each chart id — the last call that named it.
   * A row whose own call id is not the one listed for its chart has been
   * superseded by a later call.
   */
  readonly latest: Readonly<Record<string, string>>
}
