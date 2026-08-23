/**
 * The two HTTP paths both halves of this package are defined against: the node
 * half claims them as webserver routes, the browser half reads its settings
 * from one and posts each call's render verdict to the other. Not configurable
 * — the two halves must agree on them and nothing outside this package
 * addresses them.
 *
 * The settings document exists because a browser half receives no cordis
 * config: the boot manifest carries plugin names, not their `config` blocks, so
 * a `Config` field the browser must obey has to be served to it.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/route
 */

import type { ChartVerdict } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc'

/** Exact route serving {@link ShowChartSettings} to this package's browser half. */
export const SHOW_CHART_SETTINGS_ROUTE = '/show-chart/settings'

/** Exact route the browser half posts one {@link ShowChartReport} to. */
export const SHOW_CHART_REPORT_ROUTE = '/show-chart/report'

/** The browser-facing half of this plugin's configuration. */
export interface ShowChartSettings {
  /** Whether a reporting row also captures and sends the painted PNG. */
  screenshot: boolean
}

/** One call's render outcome as the browser half posts it. */
export interface ShowChartReport {
  /** The `show_chart` call this verdict belongs to. */
  callId: string
  /** What the chart answered. */
  verdict: ChartVerdict
  /** PNG data URL of the painted chart; sent only while the deployment enables screenshots. */
  dataUrl?: string
}

/** What {@link SHOW_CHART_REPORT_ROUTE} answers a well-formed report with. */
export interface ShowChartReportAck {
  /**
   * Whether a waiting call took this report. `false` means the id names no
   * pending call — a replayed settled row, a second reporter, or a call that
   * already timed out — and nothing changed.
   */
  accepted: boolean
}

/** Whether one decoded value is a verdict as {@link ChartVerdict} declares it. */
function isVerdict(value: unknown): value is ChartVerdict {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { ok?: unknown; seriesCount?: unknown; pointCount?: unknown; error?: unknown }
  if (candidate.ok === true) {
    return Number.isInteger(candidate.seriesCount) && Number.isInteger(candidate.pointCount)
  }
  return candidate.ok === false && typeof candidate.error === 'string'
}

/**
 * Read one posted report. A wire boundary: the document crossed a process, so
 * its own contract is checked here rather than trusted from the type.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseShowChartReport(body: unknown): ShowChartReport | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; verdict?: unknown; dataUrl?: unknown }
  if (typeof candidate.callId !== 'string' || candidate.callId.length === 0) return undefined
  if (!isVerdict(candidate.verdict)) return undefined
  if (candidate.dataUrl !== undefined && typeof candidate.dataUrl !== 'string') return undefined
  return {
    callId: candidate.callId,
    verdict: candidate.verdict,
    ...candidate.dataUrl === undefined ? {} : { dataUrl: candidate.dataUrl },
  }
}
