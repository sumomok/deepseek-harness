/**
 * The `showCharts` projection unit: every `show_chart` call one session's log
 * recorded, and which call currently owns each chart id.
 *
 * The fold keeps only what the log said; the `latest` view is derived in
 * `view`, so the ownership rule lives in one place and the stored state stays
 * the minimum that replays. Two log shapes carry a chart call and both count:
 * a top-level `tool/call`, whose `arguments` is raw JSON, and a Code Mode
 * `tool/code-dispatch-start`, whose `arguments` is already decoded and whose
 * call id is the `subCallId`. A model reaching the tool through `run_code`
 * logs only the second, so a fold reading one shape would see no charts at all
 * for that session.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/projection
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
// Type-only: pulls this package's own `showCharts` projection declarations.
import type { ShowChartEntry, ShowChartsView } from './types.ts'
import { parseChartCall, readChartCall, SHOW_CHART_TOOL_NAME, type ChartCall } from './chart-call.ts'

/** The `showCharts` unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ShowChartsProjectionDefinition =
  & Omit<ProjectionDefinition<'showCharts', ShowChartEntry[]>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'showCharts', ShowChartEntry[]>['wire']> }

/** One folded entry, as the persisted checkpoint carries it. */
const entrySchema = zod.object({
  chartId: zod.string(),
  callId: zod.string(),
  title: zod.union([zod.string(), zod.null()]),
  seq: zod.number(),
})

/** Fold state: the recorded calls in log order. */
const stateSchema: ZodType<ShowChartEntry[]> = zod.array(entrySchema)

/** Wire payload schema of the `showCharts` projection. */
const viewSchema: ZodType<ShowChartsView> = zod.object({
  entries: zod.array(entrySchema),
  latest: zod.record(zod.string(), zod.string()),
})

/**
 * Build the entry one recognized call contributes.
 * @param call - the call's chart arguments.
 * @param callId - the call id the log recorded for it.
 * @param seq - the log sequence number of the recording event.
 * @returns the entry.
 */
function entryOf(call: ChartCall, callId: string, seq: number): ShowChartEntry {
  return {
    chartId: call.id ?? callId,
    callId,
    title: call.title ?? null,
    seq,
  }
}

/** One recognized chart call: the arguments, and the call id the log recorded for them. */
export interface RecordedChartCall {
  /** The call's chart arguments. */
  readonly call: ChartCall
  /** A top-level `callId`, or a code-mode `subCallId`. */
  readonly callId: string
}

/**
 * Read the chart one committed event recorded, in either of the two log shapes.
 *
 * Shared with the content-surface `chart` extractor, so the transcript row, the
 * supersede rule, and the content column all count exactly the same calls.
 * @param event - the committed session event.
 * @returns the call, or `undefined` when the event records no readable chart call.
 */
export function readChartEvent(event: SessionEvent): RecordedChartCall | undefined {
  if (event.type === 'tool/call') {
    if (event.data.name !== SHOW_CHART_TOOL_NAME) return undefined
    const call = parseChartCall(event.data.arguments)
    return call === undefined ? undefined : { call, callId: event.data.callId }
  }
  if (event.type === 'tool/code-dispatch-start') {
    if (event.data.name !== SHOW_CHART_TOOL_NAME) return undefined
    const call = readChartCall(event.data.arguments)
    return call === undefined ? undefined : { call, callId: event.data.subCallId }
  }
  return undefined
}

/**
 * Resolve the whole current value from the folded calls.
 * @param state - the recorded calls in log order.
 * @returns the calls plus the current owner of each chart id.
 */
function resolveView(state: ShowChartEntry[]): ShowChartsView {
  const latest: Record<string, string> = {}
  // Log order, so the last call naming an id is the one left standing.
  for (const entry of state) latest[entry.chartId] = entry.callId
  return { entries: state, latest }
}

/**
 * Build the `showCharts` projection unit.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function showChartsProjection(): ShowChartsProjectionDefinition {
  return {
    key: 'showCharts',
    stateSchema,
    init: () => [],
    apply: (state: ShowChartEntry[], event: SessionEvent) => {
      const recorded = readChartEvent(event)
      return recorded === undefined ? state : [...state, entryOf(recorded.call, recorded.callId, event.seq)]
    },
    wire: { viewSchema, view: resolveView },
    stateVersion: 1,
  }
}
