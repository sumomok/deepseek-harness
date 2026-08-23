/**
 * The chart's React face: a layout-agnostic, data-driven component.
 *
 * It names no slot, owns no state, and resolves no copy — every user-visible
 * string arrives as a prop, so the same export serves the content column here
 * and a conversation-transcript placement that renders tool-call data. It is
 * the bridge plus the Vue 2.7 chart, with the optional inputs defaulted so a
 * caller with nothing to say about selection passes only data.
 */
import type { EChartsBarChartProps } from './echarts-chart.ts'
import { EChartsBarChart } from './echarts-chart.ts'
import { Vue2Bridge } from './vue2-bridge.tsx'

/** Props of {@link EChartsBar}: the chart's data plus its optional presentation inputs. */
export interface EChartsBarProps {
  /** Caption headline, already localized. */
  readonly title: string
  /** Category axis labels, already localized; one per value. */
  readonly categories: readonly string[]
  /** Bar heights, positionally paired with `categories`. */
  readonly values: readonly number[]
  /** Whether the dark palette is active; defaults to the light one. */
  readonly dark?: boolean
  /** Caption line describing the current selection; defaults to no line. */
  readonly selectedLabel?: string
  /** Called with the clicked bar's category and value; defaults to ignoring clicks. */
  readonly onSelect?: (category: string, value: number) => void
}

/** Default `onSelect`: a caller that reads no selection still gets a live chart. */
const IGNORE_SELECTION = (): void => {}

/**
 * Render the Vue 2.7 bar chart from plain data.
 * @param props - the chart's data and its optional presentation inputs.
 * @returns the bridge host carrying the Vue tree.
 */
export function EChartsBar({
  title,
  categories,
  values,
  dark = false,
  selectedLabel = '',
  onSelect = IGNORE_SELECTION,
}: EChartsBarProps) {
  return (
    <Vue2Bridge<EChartsBarChartProps>
      component={EChartsBarChart}
      props={{ title, categories, values, dark, selectedLabel, onSelect }}
    />
  )
}
