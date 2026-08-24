// @vitest-environment jsdom
/**
 * The pass-through chart, over a fake ECharts instance: what reaches
 * `setOption`, both verdict edges (a synchronous rejection and the first
 * `finished` after an accepted document), the stray `finished` that reports
 * nothing, re-application on a React commit, and the capture switch.
 *
 * ECharts is replaced because jsdom has no canvas; ResizeObserver because jsdom
 * has no layout. Both stubs record what the component asked them to do, which
 * is the behavior under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { nextTick } from 'vue'
import { EChartsOption } from '../src/client/EChartsOption.tsx'
import type { ChartVerdict } from '../src/chart-types.ts'

/** One fake chart instance, recording every call the component made on it. */
interface FakeChart {
  theme: unknown
  options: Record<string, unknown>[]
  handlers: Map<string, () => void>
  captures: { pixelRatio: number }[]
  disposed: boolean
  /** Applied when set: the next `setOption` throws it instead of accepting. */
  reject: Error | undefined
  /** Answered by `getOption`; defaults to the last accepted document. */
  applied: Record<string, unknown> | undefined
}

const echarts = vi.hoisted(() => {
  const charts: {
    theme: unknown
    options: Record<string, unknown>[]
    handlers: Map<string, () => void>
    captures: { pixelRatio: number }[]
    disposed: boolean
    reject: Error | undefined
    applied: Record<string, unknown> | undefined
  }[] = []
  return {
    charts,
    init(_element: unknown, theme: unknown) {
      const chart = {
        theme,
        options: [] as Record<string, unknown>[],
        handlers: new Map<string, () => void>(),
        captures: [] as { pixelRatio: number }[],
        disposed: false,
        reject: undefined as Error | undefined,
        applied: undefined as Record<string, unknown> | undefined,
        setOption(option: Record<string, unknown>) {
          if (chart.reject !== undefined) throw chart.reject
          chart.options.push(option)
          chart.applied = option
        },
        getOption() { return chart.applied ?? {} },
        getDataURL(options: { pixelRatio: number }) {
          chart.captures.push(options)
          return 'data:image/png;base64,FAKE'
        },
        on(name: string, handler: () => void) { chart.handlers.set(name, handler) },
        resize() {},
        dispose() { chart.disposed = true },
      }
      charts.push(chart)
      return chart
    },
    use() {},
  }
})

vi.mock('echarts/core', () => ({
  init: (element: unknown, theme: unknown) => echarts.init(element, theme),
  use: () => { echarts.use() },
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

class StubResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  echarts.charts.length = 0
  vi.stubGlobal('ResizeObserver', StubResizeObserver)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** The single live fake chart; every spec here mounts exactly one component. */
const chart = (index = echarts.charts.length - 1): FakeChart => echarts.charts[index] as FakeChart

/** Deliver the `finished` event the real engine emits after a paint. */
function finishPaint(target: FakeChart = chart()): void {
  target.handlers.get('finished')?.()
}

const BAR_OPTION = { series: [{ type: 'bar', data: [1, 2, 3] }] }
const PIE_OPTION = { series: [{ type: 'pie', data: [{ value: 1 }, { value: 2 }] }] }
const RADAR_OPTION = {
  radar: { indicator: [{ name: 'Speed' }, { name: 'Range' }, { name: 'Cost' }] },
  series: [{ type: 'radar', data: [{ value: [80, 60, 40] }] }],
}

describe('EChartsOption', () => {
  it('applies the option it was given, replacing rather than merging', () => {
    render(<EChartsOption option={BAR_OPTION} />)
    expect(echarts.charts).toHaveLength(1)
    expect(chart().options).toEqual([BAR_OPTION])
  })

  it('reports the painted totals on the first finished event', () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    render(<EChartsOption option={PIE_OPTION} onVerdict={onVerdict} />)
    expect(onVerdict).not.toHaveBeenCalled()

    finishPaint()
    expect(onVerdict).toHaveBeenCalledWith({ ok: true, seriesCount: 1, pointCount: 2 })
  })

  it('ignores a finished event that no applied option is waiting for', () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    render(<EChartsOption option={BAR_OPTION} onVerdict={onVerdict} />)
    finishPaint()
    finishPaint()
    expect(onVerdict).toHaveBeenCalledTimes(1)
  })

  it('reports the rejection message when the engine refuses the document', async () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    const { rerender } = render(<EChartsOption option={BAR_OPTION} onVerdict={onVerdict} />)
    finishPaint()
    onVerdict.mockClear()

    chart().reject = new Error('unknown series type')
    rerender(<EChartsOption option={{ series: [{ type: 'scatter' }] }} onVerdict={onVerdict} />)
    await nextTick()
    expect(onVerdict).toHaveBeenCalledWith({ ok: false, error: 'unknown series type' })

    // A rejected document arms nothing, so the engine's next frame is silent.
    onVerdict.mockClear()
    finishPaint()
    expect(onVerdict).not.toHaveBeenCalled()
  })

  it('reports a non-Error rejection as its string form', async () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    const { rerender } = render(<EChartsOption option={BAR_OPTION} onVerdict={onVerdict} />)
    chart().reject = 'plain rejection' as unknown as Error
    rerender(<EChartsOption option={PIE_OPTION} onVerdict={onVerdict} />)
    await nextTick()
    expect(onVerdict).toHaveBeenCalledWith({ ok: false, error: 'plain rejection' })
  })

  it('re-applies to the live instance when React hands it a new option', async () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    const { rerender } = render(<EChartsOption option={BAR_OPTION} onVerdict={onVerdict} />)
    const live = chart()
    finishPaint(live)

    rerender(<EChartsOption option={PIE_OPTION} onVerdict={onVerdict} />)
    await nextTick()
    expect(echarts.charts).toHaveLength(1)
    expect(live.disposed).toBe(false)
    expect(live.options).toEqual([BAR_OPTION, PIE_OPTION])

    finishPaint(live)
    expect(onVerdict).toHaveBeenLastCalledWith({ ok: true, seriesCount: 1, pointCount: 2 })
  })

  it('counts nothing for a series list the engine normalized away', () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    render(<EChartsOption option={{ title: { text: 'empty' } }} onVerdict={onVerdict} />)
    finishPaint()
    expect(onVerdict).toHaveBeenCalledWith({ ok: true, seriesCount: 0, pointCount: 0 })
  })

  it('never reads a data URL while capture is off', () => {
    render(<EChartsOption option={BAR_OPTION} />)
    finishPaint()
    expect(chart().captures).toEqual([])
  })

  it('reads one data URL after the paint while capture is on', () => {
    const onCapture = vi.fn<(dataUrl: string) => void>()
    render(<EChartsOption option={BAR_OPTION} capture onCapture={onCapture} />)
    finishPaint()
    // Two device pixels per CSS pixel: the capture is read for a model to look
    // at, and a one-to-one raster of this column is too coarse to read back.
    expect(chart().captures).toEqual([{ pixelRatio: 2 }])
    expect(onCapture).toHaveBeenCalledWith('data:image/png;base64,FAKE')
  })

  it('paints a radar option, whose series type the row registers a module for', () => {
    const onVerdict = vi.fn<(verdict: ChartVerdict) => void>()
    render(<EChartsOption option={RADAR_OPTION} onVerdict={onVerdict} />)
    expect(chart().options).toEqual([RADAR_OPTION])
    finishPaint()
    expect(onVerdict).toHaveBeenCalledWith({ ok: true, seriesCount: 1, pointCount: 1 })
  })

  it('defaults to the light palette, no verdict reader, and no capture', () => {
    render(<EChartsOption option={BAR_OPTION} />)
    expect((chart().theme as { color: string[] }).color[0]).toBe('#4c6ef5')
    // The defaulted callbacks swallow both edges; neither path throws.
    expect(() => { finishPaint() }).not.toThrow()
    expect(chart().captures).toEqual([])
  })

  it('rebuilds the instance on the dark palette', async () => {
    const { rerender } = render(<EChartsOption option={BAR_OPTION} />)
    const light = chart()
    rerender(<EChartsOption option={BAR_OPTION} dark />)
    await nextTick()
    expect(echarts.charts).toHaveLength(2)
    expect(light.disposed).toBe(true)
    expect((chart().theme as { color: string[] }).color[0]).toBe('#7aa2f7')
  })
})
