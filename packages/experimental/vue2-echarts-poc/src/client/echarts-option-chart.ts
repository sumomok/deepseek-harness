/**
 * The pass-through chart's Vue half: it paints one complete ECharts option
 * document and reports what happened.
 *
 * The option is opaque to this component — it applies it with `notMerge` and
 * answers a {@link ChartVerdict}. Its caller is responsible for the option's
 * content: sanitizing it, deciding it is safe to paint, and deciding what to do
 * with the verdict.
 *
 * Verdict timing has two edges, because ECharts reports failure and success on
 * different channels. `setOption` throws synchronously on a malformed document,
 * which is the failure verdict. A document it accepts paints asynchronously, so
 * the success verdict waits for the next `finished` event — the first one after
 * an accepted `setOption`, never a stray one from a resize or a hover.
 *
 * The optional capture is delivered ahead of the success verdict, so a consumer
 * sending both to a host does it in one message. It is read at
 * {@link CAPTURE_PIXEL_RATIO} device pixels per CSS pixel.
 */
import { defineComponent, h, onMounted, ref, watch, type PropType } from 'vue'
import type * as echarts from 'echarts/core'
import { countSeriesPoints, type ChartVerdict } from '../chart-types.ts'
import { attachChart } from './echarts-host.ts'
import css from './chart.module.css'

/** Complete prop record {@link EChartsOptionChart} requires; the bridge's contract with React. */
export interface EChartsOptionChartProps {
  /** The complete ECharts option to paint, already sanitized by the caller. */
  option: object
  /** Whether the dark palette is active; a change rebuilds the instance. */
  dark: boolean
  /** Whether to read a PNG data URL after the first paint; false never calls `getDataURL`. */
  capture: boolean
  /** Reports each applied option's outcome. */
  onVerdict: (verdict: ChartVerdict) => void
  /** Receives the painted PNG data URL; called only while `capture` is true. */
  onCapture: (dataUrl: string) => void
}

/**
 * Device pixel ratio of a capture. Two, because the capture is read for a
 * consumer that hands the PNG to a model: at the conversation column's CSS
 * size, a one-to-one raster leaves axis labels and legend entries too coarse to
 * read back, and doubling the raster is the cheapest way to keep them legible.
 */
const CAPTURE_PIXEL_RATIO = 2

/** The message a thrown value carries, for the failure verdict's text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Series ECharts holds after an accepted option; `getOption` normalizes it to a list. */
function appliedSeries(chart: echarts.ECharts): readonly unknown[] {
  const series = (chart.getOption() as { series?: unknown }).series
  return Array.isArray(series) ? series : []
}

/** Vue 2.7 pass-through chart; see the module contract for the verdict's two edges. */
export const EChartsOptionChart = defineComponent({
  name: 'EChartsOptionChart',
  props: {
    /** The complete ECharts option to paint, already sanitized by the caller. */
    option: { type: Object as PropType<EChartsOptionChartProps['option']>, required: true },
    /** Whether the dark palette is active; a change rebuilds the instance. */
    dark: { type: Boolean, required: true },
    /** Whether to read a PNG data URL after the first paint. */
    capture: { type: Boolean, required: true },
    /**
     * Reports each applied option's outcome.
     *
     * Dropping the assertion leaves the prop typed as bare `Function`, which
     * erases the verdict argument this component calls it with.
     */
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    onVerdict: { type: Function as PropType<EChartsOptionChartProps['onVerdict']>, required: true },
    /** Receives the painted PNG data URL; called only while `capture` is true. */
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    onCapture: { type: Function as PropType<EChartsOptionChartProps['onCapture']>, required: true },
  },
  setup(props) {
    const host = ref<HTMLDivElement | null>(null)

    onMounted(() => {
      // Vue has written the template ref by mounted time: the chart div renders
      // unconditionally, which is what the cast records.
      const element = host.value as HTMLDivElement
      // Set by an accepted setOption and cleared by the `finished` that
      // answers it, so only a paint this component asked for reports success.
      let awaitingPaint = false

      const apply = (chart: echarts.ECharts): void => {
        try {
          // The document is opaque JSON to this component; the engine's own
          // index signature is the only thing the call site can claim about it.
          chart.setOption(props.option as echarts.EChartsCoreOption, { notMerge: true })
        } catch (rejectedOption) {
          awaitingPaint = false
          props.onVerdict({ ok: false, error: messageOf(rejectedOption) })
          return
        }
        awaitingPaint = true
      }

      const chart = attachChart(element, () => props.dark, (created) => {
        created.on('finished', () => {
          if (!awaitingPaint) return
          awaitingPaint = false
          // Capture first: a consumer that sends both across one wire has the
          // picture in hand by the time the verdict arrives.
          if (props.capture) props.onCapture(created.getDataURL({ pixelRatio: CAPTURE_PIXEL_RATIO }))
          const series = appliedSeries(created)
          props.onVerdict({ ok: true, seriesCount: series.length, pointCount: countSeriesPoints(series) })
        })
        apply(created)
      })
      watch(() => props.option, () => { apply(chart()) })
    })

    return () => h('div', { class: css.optionBody }, [h('div', { class: css.chart, ref: host })])
  },
})
