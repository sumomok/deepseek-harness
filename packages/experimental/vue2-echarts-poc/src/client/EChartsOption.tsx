/**
 * The pass-through chart's React face: one complete ECharts option in, one
 * verdict out.
 *
 * It names no slot, owns no state, and resolves no copy, so the same export
 * serves a resident panel and a conversation-transcript row rendering a tool
 * call's arguments. The option is passed through untouched — deciding what is
 * safe to paint belongs to whoever supplied it.
 */
import type { ChartVerdict } from '../chart-types.ts'
import type { EChartsOptionChartProps } from './echarts-option-chart.ts'
import { EChartsOptionChart } from './echarts-option-chart.ts'
import { Vue2Bridge } from './vue2-bridge.tsx'

/** Props of {@link EChartsOption}: the option plus its optional presentation inputs. */
export interface EChartsOptionProps {
  /** The complete ECharts option to paint, already sanitized by the caller. */
  readonly option: object
  /** Whether the dark palette is active; defaults to the light one. */
  readonly dark?: boolean
  /** Whether to read a PNG data URL after the first paint; defaults to no capture at all. */
  readonly capture?: boolean
  /** Called with each applied option's outcome; defaults to ignoring it. */
  readonly onVerdict?: (verdict: ChartVerdict) => void
  /** Called with the painted PNG data URL; reached only when `capture` is true. */
  readonly onCapture?: (dataUrl: string) => void
}

/** Default `onVerdict`/`onCapture`: a caller that reads neither still gets a live chart. */
const IGNORE = (): void => {}

/**
 * Render one complete ECharts option through the Vue 2.7 chart.
 * @param props - the option and its optional presentation inputs.
 * @returns the bridge host carrying the Vue tree.
 */
export function EChartsOption({
  option,
  dark = false,
  capture = false,
  onVerdict = IGNORE,
  onCapture = IGNORE,
}: EChartsOptionProps) {
  return (
    <Vue2Bridge<EChartsOptionChartProps>
      component={EChartsOptionChart}
      props={{ option, dark, capture, onVerdict, onCapture }}
    />
  )
}
