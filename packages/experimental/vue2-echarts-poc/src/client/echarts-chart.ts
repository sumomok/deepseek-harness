/**
 * The demo chart's Vue half: a Vue 2.7 component whose inputs are strings, two
 * arrays of plain data, a boolean, and one callback, and whose only state is a
 * Vue `ref`.
 *
 * The click counter living in that ref rather than in React state is what the
 * probe proves: Vue's reactivity runs inside the bridge's root, and a React
 * commit patches the tree instead of remounting it, so the counter survives
 * while the selection label above it changes. Copy arrives already translated —
 * the locale registry is a React-side concern.
 *
 * The instance lifecycle — palette rebuild, resize, disposal — belongs to
 * `echarts-host.ts`; this component owns the option document and the click.
 */
import { defineComponent, h, onMounted, ref, watch, type PropType } from 'vue'
import type * as echarts from 'echarts/core'
import { attachChart } from './echarts-host.ts'
import css from './chart.module.css'

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

    onMounted(() => {
      // Vue has written the template ref by mounted time: the chart div renders
      // unconditionally, which is what the cast records.
      const element = host.value as HTMLDivElement
      const chart = attachChart(element, () => props.dark, (created) => {
        created.on('click', (event: echarts.ECElementEvent) => {
          clicks.value += 1
          props.onSelect(event.name, Number(event.value))
        })
        created.setOption(barOption(props))
      })
      watch(
        () => [props.title, props.categories, props.values] as const,
        () => { chart().setOption(barOption(props)) },
      )
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
