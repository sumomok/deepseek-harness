// @vitest-environment jsdom
/**
 * The two React components this row exports, over a fake ECharts instance: the
 * data-driven `EChartsBar` (what reaches the chart, what its optional inputs
 * default to, and the lifecycle it drives) and the `ChartPanel` demo wrapper
 * (its seeded data set, the Randomize round trip, and the selection echo).
 *
 * ECharts is replaced because jsdom has no canvas; ResizeObserver because jsdom
 * has no layout. Both stubs record what the component asked them to do, which
 * is the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { nextTick } from 'vue'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { EChartsBar } from '../src/client/EChartsBar.tsx'
import { ChartPanel, type ChartPanelProps } from '../src/client/ChartPanel.tsx'
import { zh } from '../src/client/locales.ts'

/** One fake chart instance, recording every call the component made on it. */
interface FakeChart {
  theme: unknown
  element: unknown
  options: Record<string, unknown>[]
  handlers: Map<string, (event: { name: string; value: unknown }) => void>
  resizes: number
  disposed: boolean
  setOption: (option: Record<string, unknown>) => void
  on: (name: string, handler: (event: { name: string; value: unknown }) => void) => void
  resize: () => void
  dispose: () => void
}

const echarts = vi.hoisted(() => {
  const charts: {
    theme: unknown
    element: unknown
    options: Record<string, unknown>[]
    handlers: Map<string, (event: { name: string; value: unknown }) => void>
    resizes: number
    disposed: boolean
    setOption: (option: Record<string, unknown>) => void
    on: (name: string, handler: (event: { name: string; value: unknown }) => void) => void
    resize: () => void
    dispose: () => void
  }[] = []
  return {
    charts,
    used: [] as unknown[],
    init(element: unknown, theme: unknown) {
      const chart = {
        theme,
        element,
        options: [] as Record<string, unknown>[],
        handlers: new Map<string, (event: { name: string; value: unknown }) => void>(),
        resizes: 0,
        disposed: false,
        setOption(option: Record<string, unknown>) { chart.options.push(option) },
        on(name: string, handler: (event: { name: string; value: unknown }) => void) {
          chart.handlers.set(name, handler)
        },
        resize() { chart.resizes += 1 },
        dispose() { chart.disposed = true },
      }
      charts.push(chart)
      return chart
    },
  }
})

vi.mock('echarts/core', () => ({
  init: (element: unknown, theme: unknown) => echarts.init(element, theme),
  use: (parts: unknown) => { echarts.used.push(parts) },
}))
vi.mock('echarts/charts', () => ({
  BarChart: 'BarChart',
  LineChart: 'LineChart',
  PieChart: 'PieChart',
  RadarChart: 'RadarChart',
}))
vi.mock('echarts/components', () => ({
  GridComponent: 'GridComponent',
  LegendComponent: 'LegendComponent',
  RadarComponent: 'RadarComponent',
  TitleComponent: 'TitleComponent',
  TooltipComponent: 'TooltipComponent',
}))
vi.mock('echarts/renderers', () => ({ CanvasRenderer: 'CanvasRenderer' }))

/** Latest ResizeObserver callback, so a spec can deliver a resize jsdom never will. */
let notifyResize: (() => void) | undefined
/** How many observers the mounted trees currently hold open. */
let openObservers = 0

class StubResizeObserver {
  constructor(callback: () => void) {
    notifyResize = callback
  }

  observe(): void { openObservers += 1 }
  disconnect(): void { openObservers -= 1 }
}

beforeEach(() => {
  echarts.charts.length = 0
  notifyResize = undefined
  openObservers = 0
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The single live fake chart; every spec here mounts exactly one component. */
const chart = (index = echarts.charts.length - 1): FakeChart => echarts.charts[index] as FakeChart

/** The last option document the component pushed into the chart. */
const lastOption = (target: FakeChart = chart()): Record<string, unknown> =>
  target.options[target.options.length - 1] as Record<string, unknown>

/** Series data of one option document. */
const seriesData = (option: Record<string, unknown>): unknown =>
  (option.series as { data: unknown }[])[0]?.data

const CATEGORIES = ['a', 'b', 'c']
const VALUES = [1, 2, 3]

describe('EChartsBar', () => {
  it('hands the chart the data it was given', () => {
    render(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} />)
    expect(echarts.charts).toHaveLength(1)
    expect(lastOption().xAxis).toEqual({ type: 'category', data: CATEGORIES })
    expect(seriesData(lastOption())).toEqual(VALUES)
    expect(screen.getByText('Sales')).toBeDefined()
  })

  it('defaults the light palette, an empty selection line, and an ignored click', () => {
    render(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} />)
    expect((chart().theme as { color: string[] }).color[0]).toBe('#4c6ef5')
    expect(screen.getByText('0').nextElementSibling?.textContent).toBe('')
    // The default onSelect swallows the click; the Vue counter still moves.
    expect(() => { chart().handlers.get('click')?.({ name: 'b', value: 2 }) }).not.toThrow()
  })

  it('reports a clicked bar and counts the click in Vue', async () => {
    const onSelect = vi.fn()
    render(
      <EChartsBar
        title="Sales"
        categories={CATEGORIES}
        values={VALUES}
        selectedLabel="none yet"
        onSelect={onSelect}
      />,
    )
    expect(screen.getByText('none yet')).toBeDefined()
    chart().handlers.get('click')?.({ name: 'b', value: 2 })
    expect(onSelect).toHaveBeenCalledWith('b', 2)
    await nextTick()
    expect(screen.getByText('1').getAttribute('data-vue-clicks')).toBe('1')
  })

  it('applies new data to the live instance', async () => {
    const { rerender } = render(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} />)
    const live = chart()
    rerender(<EChartsBar title="Sales" categories={CATEGORIES} values={[9, 8, 7]} />)
    await nextTick()
    expect(echarts.charts).toHaveLength(1)
    expect(live.disposed).toBe(false)
    expect(seriesData(lastOption(live))).toEqual([9, 8, 7])
  })

  it('rebuilds the instance when the palette changes', async () => {
    const { rerender } = render(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} />)
    const light = chart()
    rerender(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} dark />)
    await nextTick()
    // ECharts resolves a theme only at construction.
    expect(echarts.charts).toHaveLength(2)
    expect(light.disposed).toBe(true)
    expect((chart().theme as { color: string[] }).color[0]).toBe('#7aa2f7')
  })

  it('resizes the chart from its element observer and releases both on unmount', () => {
    const { unmount } = render(<EChartsBar title="Sales" categories={CATEGORIES} values={VALUES} />)
    const live = chart()
    expect(openObservers).toBe(1)
    notifyResize?.()
    expect(live.resizes).toBe(1)

    unmount()
    expect(openObservers).toBe(0)
    expect(live.disposed).toBe(true)
  })
})

const t: ChartPanelProps['t'] = makeTranslate(zh)

describe('ChartPanel', () => {
  it('plots the seeded week with the copy the locale seat resolved', () => {
    render(<ChartPanel t={t} />)
    expect(screen.getByText(zh['panel.title'])).toBeDefined()
    expect(screen.getByText(zh['panel.unselected'])).toBeDefined()
    expect(lastOption().xAxis).toEqual({
      type: 'category',
      data: [zh['panel.category.1'], zh['panel.category.2'], zh['panel.category.3'],
        zh['panel.category.4'], zh['panel.category.5'], zh['panel.category.6'], zh['panel.category.7']],
    })
    expect(seriesData(lastOption())).toEqual([120, 200, 150, 80, 70, 110, 130])
  })

  it('echoes a chart selection back into the caption', async () => {
    render(<ChartPanel t={t} />)
    // The chart calls back outside React's event system, so the state update
    // and the commit that follows it are driven explicitly.
    await act(async () => { chart().handlers.get('click')?.({ name: zh['panel.category.2'], value: 200 }) })
    await nextTick()
    expect(screen.getByText(`已选择 ${zh['panel.category.2']}：200`)).toBeDefined()
  })

  it('replaces the data set without rebuilding the chart', async () => {
    render(<ChartPanel t={t} />)
    const live = chart()
    fireEvent.click(screen.getByRole('button', { name: zh['panel.randomize'] }))
    await nextTick()
    expect(echarts.charts).toHaveLength(1)
    expect(live.disposed).toBe(false)
    const replaced = seriesData(lastOption(live)) as number[]
    expect(replaced).toHaveLength(7)
    for (const value of replaced) expect(value).toBeGreaterThanOrEqual(20)
    for (const value of replaced) expect(value).toBeLessThanOrEqual(200)
  })
})
