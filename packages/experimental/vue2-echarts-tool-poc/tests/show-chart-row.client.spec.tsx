// @vitest-environment jsdom
/**
 * The transcript row on its own: what it draws for a running and a settled
 * call, what reaches the chart, the hidden-until-verified stage, the error row,
 * and the one report per call id it posts back to the node half.
 *
 * The component row is replaced by a recorder. Painting is its business and its
 * own specs cover it; what this file can prove is the row's half of the round
 * trip — the props it hands over and what it does with each verdict. The live
 * engine is the web e2e's business. `fetch` is stubbed to record the report.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ToolCallBlock } from '@deepseek-ai/dsh-client-runtime/client'
import { ShowChartRow, type ShowChartRowProps } from '../src/client/ShowChartRow.tsx'
import { SHOW_CHART_REPORT_ROUTE } from '../src/route.ts'
import type { ShowChartsView } from '../src/types.ts'
import { en } from '../src/client/locales.ts'

/** What the row handed the chart on its last render. */
interface ChartProps {
  option: Record<string, unknown>
  dark: boolean
  capture: boolean
  onVerdict: (verdict: { ok: true; seriesCount: number; pointCount: number } | { ok: false; error: string }) => void
  onCapture: (dataUrl: string) => void
}

const bridge = vi.hoisted(() => ({ renders: [] as unknown[] }))

vi.mock('@deepseek-ai/dsh-experimental-vue2-echarts-poc/client', () => ({
  EChartsOption: (props: unknown) => {
    bridge.renders.push(props)
    return null
  },
}))

/** Every report the row posted, decoded. */
let posted: unknown[] = []

beforeEach(() => {
  bridge.renders.length = 0
  posted = []
  vi.stubGlobal('fetch', vi.fn((input: string, init: { body: string }) => {
    if (input !== SHOW_CHART_REPORT_ROUTE) throw new Error(`unexpected fetch: ${input}`)
    posted.push(JSON.parse(init.body))
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ accepted: true }) })
  }))
})

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
  vi.unstubAllGlobals()
})

const t: ShowChartRowProps['t'] = makeTranslate(en)
const CALL_ID = 'call_00_chart'
const OPTION = { series: [{ type: 'bar', data: [1, 2, 3] }] }
const PAINTED = { ok: true, seriesCount: 1, pointCount: 3 } as const

/** A running call slice carrying one chart's arguments. */
function running(args: unknown, callId = CALL_ID): ToolCallBlock {
  return {
    callId,
    name: 'show_chart',
    argsRaw: JSON.stringify(args),
    turn: 1,
    step: 1,
    time: 0,
    callView: null,
    subCalls: [],
  }
}

/** A settled call slice whose head still carries the arguments. */
function settled(args: unknown, callId = CALL_ID): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 2,
    time: 0,
    callId,
    call: { name: 'show_chart', argsRaw: JSON.stringify(args) },
    callTime: 0,
    content: [],
    isError: false,
    callView: null,
    resultView: null,
    subCalls: [],
  }
}

/**
 * The framework's projection seat, stubbed with one session's value.
 * @param charts - the `showCharts` value the host published, if any.
 * @returns the hook the runtime share carries.
 */
function projections(charts: ShowChartsView | undefined): ShowChartRowProps['useProjection'] {
  return (key: string) => (key === 'showCharts' ? charts : undefined)
}

/** Mount one row over the owner share the transcript supplies. */
function mount(block: ToolCallBlock, screenshot = false, charts?: ShowChartsView): void {
  const props = {
    callId: block.callId,
    toolName: 'show_chart',
    block,
    openFile: () => {},
    screenshot,
    useProjection: projections(charts),
    t,
  } as unknown as ShowChartRowProps
  render(<ShowChartRow {...props} />)
}

/** What the row last handed the chart. */
const chart = (): ChartProps => bridge.renders[bridge.renders.length - 1] as ChartProps

/** The row's chart stage, as the CSS reveals or hides it. */
const stage = (): HTMLElement | null => document.querySelector('[data-show-chart-stage]')

/** Answer the chart's paint the way the component row does: capture, then verdict. */
async function paint(dataUrl?: string): Promise<void> {
  const props = chart()
  await act(async () => {
    if (dataUrl !== undefined) props.onCapture(dataUrl)
    props.onVerdict(PAINTED)
  })
}

describe('ShowChartRow', () => {
  it('draws a running call as soon as its arguments exist', () => {
    mount(running({ title: 'Weekly revenue', option: OPTION }))
    expect(bridge.renders).not.toHaveLength(0)
    expect(screen.getByText('Weekly revenue')).toBeDefined()
    expect(screen.getByText(en['row.rendering'])).toBeDefined()
  })

  it('draws a settled call from the head its result kept', () => {
    mount(settled({ option: OPTION }))
    // No caption in the call, so the row names the chart from its own copy.
    expect(screen.getByText(en['row.title'])).toBeDefined()
    expect(chart().option.series).toEqual(OPTION.series)
  })

  it('hands over the sanitized option, not the one the model wrote', () => {
    mount(running({ option: { ...OPTION, graphic: [{ type: 'image' }] } }))
    expect(Object.hasOwn(chart().option, 'graphic')).toBe(false)
    expect(chart().option.tooltip).toEqual({ renderMode: 'richText' })
  })

  it('keeps the option identity stable across re-renders', async () => {
    mount(running({ option: OPTION }))
    const first = chart().option
    await paint()
    // A fresh object every render would make the chart re-apply, re-report,
    // and re-render without end.
    expect(chart().option).toBe(first)
  })

  it('keeps the stage hidden until a verdict says the option painted', async () => {
    mount(running({ option: OPTION }))
    expect(stage()?.dataset.verified).toBe('no')

    await paint()
    expect(stage()?.dataset.verified).toBe('yes')
    expect(screen.queryByText(en['row.rendering'])).toBeNull()
  })

  it('reports the painted totals to the node half exactly once', async () => {
    mount(running({ option: OPTION }))
    await paint()
    expect(posted).toEqual([{ callId: CALL_ID, verdict: PAINTED }])

    // A palette rebuild, a re-render, or a second engine frame: the call is
    // already answered.
    await paint()
    expect(posted).toHaveLength(1)
  })

  it('shows the engine\'s own message instead of the chart, and reports the failure', async () => {
    mount(running({ option: OPTION }))
    const props = chart()
    await act(async () => { props.onVerdict({ ok: false, error: 'Series data is not an array' }) })
    expect(screen.getByText('The chart did not render: Series data is not an array')).toBeDefined()
    // The stage is gone entirely: there is nothing left to reveal.
    expect(stage()).toBeNull()
    expect(posted).toEqual([{
      callId: CALL_ID,
      verdict: { ok: false, error: 'Series data is not an array' },
    }])
  })

  it('shows the unreadable row for a call whose arguments are not JSON', () => {
    mount({ ...(running('x') as Extract<ToolCallBlock, { name: string }>), argsRaw: 'not json' })
    expect(screen.getByText(en['row.unreadable'])).toBeDefined()
    expect(bridge.renders).toHaveLength(0)
  })

  it('shows the unreadable row for arguments that carry no option object', () => {
    for (const args of [42, { option: 'bar' }, { option: [1] }, { option: null }, {}]) {
      mount(running(args))
      expect(screen.getByText(en['row.unreadable'])).toBeDefined()
      cleanup()
    }
    expect(bridge.renders).toHaveLength(0)
  })

  it('shows the unreadable row for a settled call whose head was cut from the window', () => {
    mount({ ...(settled({ option: OPTION }) as Extract<ToolCallBlock, { kind: 'tool-result' }>), call: null })
    expect(screen.getByText(en['row.unreadable'])).toBeDefined()
  })

  it('asks for no capture while the deployment leaves screenshots off', async () => {
    mount(running({ option: OPTION }))
    expect(chart().capture).toBe(false)
    await paint()
    expect(posted).toEqual([{ callId: CALL_ID, verdict: PAINTED }])
  })

  it('sends the captured PNG with the verdict once the deployment enables it', async () => {
    mount(running({ option: OPTION }), true)
    expect(chart().capture).toBe(true)
    await paint('data:image/png;base64,FAKE')
    expect(posted).toEqual([{
      callId: CALL_ID,
      verdict: PAINTED,
      dataUrl: 'data:image/png;base64,FAKE',
    }])
  })

  it('reads the light palette under a document the shell left light', () => {
    mount(running({ option: OPTION }))
    expect(chart().dark).toBe(false)
  })

  it('reads the dark palette when the shell marks the document dark', () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    mount(running({ option: OPTION }))
    expect(chart().dark).toBe(true)
  })

  it('collapses to a notice when a later call redrew this chart', () => {
    mount(running({ id: 'revenue', title: 'Weekly revenue', option: OPTION }), false, {
      entries: [],
      latest: { revenue: 'call_01_chart' },
    })
    expect(screen.getByText('Weekly revenue: updated by a later call.')).toBeDefined()
    // No stage, no engine, and therefore no verdict to report: the call this
    // row would answer settled long ago.
    expect(stage()).toBeNull()
    expect(bridge.renders).toHaveLength(0)
    expect(posted).toEqual([])
  })

  it('draws the call that currently owns the chart id', () => {
    mount(running({ id: 'revenue', option: OPTION }), false, {
      entries: [],
      latest: { revenue: CALL_ID },
    })
    expect(bridge.renders).not.toHaveLength(0)
    expect(stage()).not.toBeNull()
  })

  it('draws a call whose own id is the chart, when the projection lists it', () => {
    mount(running({ option: OPTION }), false, { entries: [], latest: { [CALL_ID]: CALL_ID } })
    expect(bridge.renders).not.toHaveLength(0)
  })

  it('draws the chart while the projection has not carried this session yet', () => {
    // A composition without a projection registry publishes no value at all,
    // and a live one lags its log by a frame; neither is a superseded row.
    mount(running({ id: 'revenue', option: OPTION }), false, undefined)
    expect(bridge.renders).not.toHaveLength(0)
  })

  it('draws the chart while the projection lists other charts only', () => {
    mount(running({ id: 'revenue', option: OPTION }), false, {
      entries: [],
      latest: { traffic: 'call_02_chart' },
    })
    expect(bridge.renders).not.toHaveLength(0)
  })

  it('survives a report the node half never answers', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))))
    mount(running({ option: OPTION }))
    await expect(paint()).resolves.toBeUndefined()
    // The waiting call's own deadline answers it instead.
    expect(stage()?.dataset.verified).toBe('yes')
  })
})
