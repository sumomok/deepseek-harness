/**
 * The chart's Vue half: a Vue 2.7 component whose inputs are strings, two
 * arrays of plain data, a boolean, and one callback, and whose only state is a
 * Vue `ref`.
 *
 * The click counter living in that ref rather than in React state is what the
 * probe proves: Vue's reactivity runs inside the bridge's root, and a React
 * commit patches the tree instead of remounting it, so the counter survives
 * while the selection label above it changes. Copy arrives already translated —
 * the locale registry is a React-side concern.
 *
 * ECharts resolves a theme only at construction, so the palette watcher
 * disposes the instance and builds a new one; every other input is applied to
 * the live instance with `setOption`.
 */
import { defineComponent, h, onBeforeUnmount, onMounted, ref, watch, type PropType } from 'vue'
import * as echarts from 'echarts/core'
import { BarChart } from 'echarts/charts'
import { GridComponent, TooltipComponent } from 'echarts/components'
import { CanvasRenderer } from 'echarts/renderers'
import css from './chart.module.css'

echarts.use([BarChart, GridComponent, TooltipComponent, CanvasRenderer])

/** Complete prop record {@link EChartsBarChart} requires; the bridge's contract with React. */
export interface EChartsBarChartProps {
  /** Caption headline, already localized. */
  title: string
  /** Category axis labels, already localized; one per value. */
  categories: readonly string[]
  /** Bar heights, positionally paired with `categories`. */
  values: readonly number[]
  /** Whether the dark palette is active; a change rebuilds the instance. */
  dark: boolean
  /** Caption line describing the current selection, already localized. */
  selectedLabel: string
  /** Reports each bar click to the React side. */
  onSelect: (category: string, value: number) => void
}

/**
 * Chart palettes. A canvas reads no CSS custom properties, so the two palettes
 * are literal here rather than the `--dsw-*` tokens the surrounding DOM styles
 * from; they are chosen to sit on the shell's two base surfaces.
 */
const PALETTE = {
  light: {
    color: ['#4c6ef5'],
    backgroundColor: 'transparent',
    textStyle: { color: '#4c5157' },
    categoryAxis: { axisLine: { lineStyle: { color: '#d5d9de' } }, splitLine: { show: false } },
    valueAxis: { splitLine: { lineStyle: { color: '#eceef1' } } },
  },
  dark: {
    color: ['#7aa2f7'],
    backgroundColor: 'transparent',
    textStyle: { color: '#b9c0c8' },
    categoryAxis: { axisLine: { lineStyle: { color: '#3b4048' } }, splitLine: { show: false } },
    valueAxis: { splitLine: { lineStyle: { color: '#2c3037' } } },
  },
} as const

/** Build the complete option document for one prop record. */
function barOption(props: EChartsBarChartProps): echarts.EChartsCoreOption {
  return {
    // A demo surface a screenshot and a browser scenario both read: the bars
    // must be final on the frame after setOption.
    animation: false,
    grid: { left: 48, right: 16, top: 16, bottom: 32 },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: [...props.categories] },
    yAxis: { type: 'value' },
    series: [{ type: 'bar', name: props.title, data: [...props.values] }],
  }
}

/** Vue 2.7 bar chart; see the module contract for what may cross the bridge. */
export const EChartsBarChart = defineComponent({
  name: 'EChartsBarChart',
  props: {
    /** Caption headline, already localized. */
    title: { type: String, required: true },
    /** Category axis labels, already localized; one per value. */
    categories: { type: Array as PropType<EChartsBarChartProps['categories']>, required: true },
    /** Bar heights, positionally paired with `categories`. */
    values: { type: Array as PropType<EChartsBarChartProps['values']>, required: true },
    /** Whether the dark palette is active; a change rebuilds the instance. */
    dark: { type: Boolean, required: true },
    /** Caption line describing the current selection, already localized. */
    selectedLabel: { type: String, required: true },
    /**
     * Reports each bar click to the React side.
     *
     * Dropping the assertion leaves the prop typed as bare `Function`, which
     * erases the two-argument signature this component calls it with.
     */
    // oxlint-disable-next-line typescript/no-unnecessary-type-assertion
    onSelect: { type: Function as PropType<EChartsBarChartProps['onSelect']>, required: true },
  },
  setup(props) {
    const clicks = ref(0)
    const host = ref<HTMLDivElement | null>(null)

    const build = (element: HTMLDivElement): echarts.ECharts => {
      const chart = echarts.init(element, PALETTE[props.dark ? 'dark' : 'light'])
      chart.on('click', (event: echarts.ECElementEvent) => {
        clicks.value += 1
        props.onSelect(event.name, Number(event.value))
      })
      chart.setOption(barOption(props))
      return chart
    }

    onMounted(() => {
      // Vue has written the template ref by mounted time: the chart div renders
      // unconditionally, which is what the cast records.
      const element = host.value as HTMLDivElement
      let chart = build(element)

      watch(() => props.dark, () => {
        chart.dispose()
        chart = build(element)
      })
      watch(
        () => [props.title, props.categories, props.values] as const,
        () => { chart.setOption(barOption(props)) },
      )

      const observer = new ResizeObserver(() => { chart.resize() })
      observer.observe(element)

      onBeforeUnmount(() => {
        observer.disconnect()
        chart.dispose()
      })
    })

    return () => h('div', { class: css.chartBody }, [
      h('p', { class: css.caption }, [
        h('span', { class: css.title }, props.title),
        // The Vue-owned counter: it survives every React commit, which is the
        // whole claim the bridge makes.
        h('span', { class: css.clicks, attrs: { 'data-vue-clicks': clicks.value } }, String(clicks.value)),
        h('span', { class: css.selected }, props.selectedLabel),
      ]),
      h('div', { class: css.chart, ref: host }),
    ])
  },
})
