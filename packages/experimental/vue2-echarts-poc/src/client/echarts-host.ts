/**
 * The ECharts runtime both chart components in this row share: the registered
 * module set, the two palettes, and the instance lifecycle.
 *
 * ECharts resolves a theme only at construction, so a palette change cannot be
 * applied to a live instance — {@link attachChart} disposes and rebuilds. Every
 * other input reaches the instance through `setOption`, which is the caller's
 * business.
 */
import * as echarts from 'echarts/core'
import { BarChart, LineChart, PieChart, RadarChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
} from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import { onBeforeUnmount, watch } from 'vue'
import { SUPPORTED_SERIES_TYPES, type SupportedSeriesType } from '../chart-types.ts'

/** One registrable ECharts part; `echarts.use` also accepts a list of them. */
type EChartsPart = Exclude<Parameters<typeof echarts.use>[0], readonly unknown[]>

/**
 * The chart module each supported series type needs. Keyed by the supported
 * set, so adding a series type there fails the build until its module is named
 * here — the two lists cannot drift.
 */
const SERIES_MODULES: Readonly<Record<SupportedSeriesType, EChartsPart>> = {
  bar: BarChart,
  line: LineChart,
  pie: PieChart,
  radar: RadarChart,
}

// Registered once for the whole bundle. The shared components carry the axis
// grid, tooltips, the legend, and the title because a pass-through option may
// name any of them, the radar coordinate system because a radar series is
// drawn on one and its chart module does not carry it, and the canvas renderer
// because this row paints to canvas.
echarts.use([
  ...SUPPORTED_SERIES_TYPES.map(type => SERIES_MODULES[type]),
  GridComponent,
  LegendComponent,
  RadarComponent,
  TitleComponent,
  TooltipComponent,
  CanvasRenderer,
])

/**
 * Chart palettes. A canvas reads no CSS custom properties, so the two palettes
 * are literal here rather than the `--dsw-*` tokens the surrounding DOM styles
 * from; they are chosen to sit on the shell's two base surfaces.
 */
export const PALETTE = {
  light: {
    color: ['#4c6ef5', '#f76707', '#37b24d', '#ae3ec9', '#1098ad', '#f59f00', '#e03131'],
    backgroundColor: 'transparent',
    textStyle: { color: '#4c5157' },
    categoryAxis: { axisLine: { lineStyle: { color: '#d5d9de' } }, splitLine: { show: false } },
    valueAxis: { splitLine: { lineStyle: { color: '#eceef1' } } },
  },
  dark: {
    color: ['#7aa2f7', '#ff922b', '#69db7c', '#da77f2', '#3bc9db', '#ffd43b', '#ff8787'],
    backgroundColor: 'transparent',
    textStyle: { color: '#b9c0c8' },
    categoryAxis: { axisLine: { lineStyle: { color: '#3b4048' } }, splitLine: { show: false } },
    valueAxis: { splitLine: { lineStyle: { color: '#2c3037' } } },
  },
} as const

/**
 * Own one ECharts instance for the calling component's lifetime: build it on
 * the current palette, rebuild it when the palette changes, resize it with its
 * element, and dispose it on unmount.
 *
 * Call it from `onMounted`, where the template ref holding the element is
 * written and the component instance still owns the watcher and the unmount
 * hook this registers.
 * @param element - the laid-out element the instance renders into.
 * @param dark - reads whether the dark palette is active now; watched.
 * @param build - receives each freshly constructed instance before its first paint.
 * @returns reads the live instance, which a palette change replaces.
 */
export function attachChart(
  element: HTMLDivElement,
  dark: () => boolean,
  build: (chart: echarts.ECharts) => void,
): () => echarts.ECharts {
  const create = (): echarts.ECharts => {
    const created = echarts.init(element, PALETTE[dark() ? 'dark' : 'light'])
    build(created)
    return created
  }
  let chart = create()
  watch(dark, () => {
    chart.dispose()
    chart = create()
  })
  const observer = new ResizeObserver(() => { chart.resize() })
  observer.observe(element)
  onBeforeUnmount(() => {
    observer.disconnect()
    chart.dispose()
  })
  return () => chart
}
