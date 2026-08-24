/**
 * This package's contribution to the content column's entry stream: the
 * `chart` kind.
 *
 * One entry per chart id, so the two calls of a redraw are one row in the
 * column's switcher and the later one owns it — the same supersede rule the
 * transcript already applies, read from the same events through the same
 * reader. A call that named no id is its own chart and supersedes nothing.
 *
 * The entry carries the option itself. A chart call is self-contained — the
 * whole document the engine paints is in its arguments — so nothing is
 * resolved at view time, and the column can draw a chart without reaching into
 * the conversation the call sits in.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/surface
 */

import type { ContentSurfaceExtractor } from '@deepseek-ai/dsh-experimental-content-surface'
import { readChartEvent } from './projection.ts'

/** Kind key this package owns in the content column, and in its keyed client slot. */
export const CHART_KIND = 'chart'

/** What a `chart` entry stores, which is also what its renderer receives. */
export interface ChartSurfaceData {
  /** The caption the call gave the chart, or its chart id when it gave none. */
  readonly title: string
  /** The option document to paint, exactly as the call carried it. */
  readonly option: Record<string, unknown>
}

/**
 * Build the `chart` extractor.
 * @returns the extractor to hand to `ctx.contentSurface.register`.
 */
export function chartExtractor(): ContentSurfaceExtractor<ChartSurfaceData> {
  return {
    kind: CHART_KIND,
    dataVersion: 1,
    read: (event) => {
      const recorded = readChartEvent(event)
      if (recorded === undefined) return undefined
      const entryId = recorded.call.id ?? recorded.callId
      // The switcher needs a line of text; an unnamed chart is listed under the
      // id that identifies it, which for an id-less call is its call id.
      return { entryId, data: { title: recorded.call.title ?? entryId, option: recorded.call.option } }
    },
    resolve: data => ({ title: data.title, payload: { option: data.option } }),
  }
}
