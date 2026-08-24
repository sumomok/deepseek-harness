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
import type { ContentSurfaceView } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ShowChartRow, type ShowChartRowProps } from '../src/client/ShowChartRow.tsx'
import css from '../src/client/show-chart.module.css'
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

/** The two projection values a row reads, as one composition publishes them. */
interface Published {
  /** The `showCharts` value the host published, if any. */
  charts?: ShowChartsView
  /** The `contentSurface` value, published exactly where a content column is composed. */
  surface?: ContentSurfaceView
}

/**
 * The framework's projection seat, stubbed with one session's values.
 * @param published - what the host published for this session.
 * @returns the hook the runtime share carries, selector overload included.
 */
function projections(published: Published): ShowChartRowProps['useProjection'] {
  return (key: string, selector?: (value: unknown) => unknown) => {
    const value = key === 'showCharts' ? published.charts : key === 'contentSurface' ? published.surface : undefined
    return selector === undefined ? value : selector(value)
  }
}

/** Mount one row over the owner share the transcript supplies. */
function mount(block: ToolCallBlock, screenshot = false, published: Published = {}): void {
  const props = {
    callId: block.callId,
    toolName: 'show_chart',
    block,
    openFile: () => {},
    screenshot,
    useProjection: projections(published),
    t,
  } as unknown as ShowChartRowProps
  render(<ShowChartRow {...props} />)
}

/** What the row last handed the chart. */
const chart = (): ChartProps => bridge.renders[bridge.renders.length - 1] as ChartProps

/** The row's chart stage, as the CSS reveals or hides it. */
const stage = (): HTMLElement | null => document.querySelector('[data-show-chart-stage]')

/** The compact card a row shows once a content column has the picture. */
const delegatedCard = (): HTMLElement | null => document.querySelector('[data-show-chart-delegated]')

/** A `contentSurface` value, which is published exactly where a content column is composed. */
const COLUMN: ContentSurfaceView = { entries: [] }

/** The class that takes the stage out of the conversation's layout flow. */
const OFFSTAGE = css.offstage
if (OFFSTAGE === undefined) throw new Error('offstage class missing from show-chart.module.css')

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
      charts: { entries: [], latest: { revenue: 'call_01_chart' } },
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
      charts: { entries: [], latest: { revenue: CALL_ID } },
    })
    expect(bridge.renders).not.toHaveLength(0)
    expect(stage()).not.toBeNull()
  })

  it('draws a call whose own id is the chart, when the projection lists it', () => {
    mount(running({ option: OPTION }), false, { charts: { entries: [], latest: { [CALL_ID]: CALL_ID } } })
    expect(bridge.renders).not.toHaveLength(0)
  })

  it('draws the chart while the projection has not carried this session yet', () => {
    // A composition without a projection registry publishes no value at all,
    // and a live one lags its log by a frame; neither is a superseded row.
    mount(running({ id: 'revenue', option: OPTION }), false, {})
    expect(bridge.renders).not.toHaveLength(0)
  })

  it('draws the chart while the projection lists other charts only', () => {
    mount(running({ id: 'revenue', option: OPTION }), false, {
      charts: { entries: [], latest: { traffic: 'call_02_chart' } },
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

  it('keeps the whole chart in the conversation where no content column is composed', async () => {
    mount(running({ title: 'Weekly revenue', option: OPTION }))
    await paint()
    expect(delegatedCard()).toBeNull()
    expect(stage()?.dataset.verified).toBe('yes')
  })
})

describe('ShowChartRow beside a content column', () => {
  it('paints off the flow while the call waits, and says so in one line', () => {
    mount(running({ title: 'Weekly revenue', option: OPTION }), false, { surface: COLUMN })
    expect(delegatedCard()?.dataset.showChartDelegated).toBe('pending')
    expect(delegatedCard()?.textContent).toBe('Weekly revenue: drawing…')
    // The engine still mounts — no other placement answers this call — but its
    // stage is out of the conversation's layout flow.
    expect(bridge.renders).not.toHaveLength(0)
    expect(stage()?.dataset.verified).toBe('no')
    expect(stage()?.className.split(' ')).toContain(OFFSTAGE)
    // The full-height caption line the shipped layout draws is not there.
    expect(screen.queryByText(en['row.rendering'])).toBeNull()
  })

  it('drops the engine once the verdict is in, and reports it exactly once', async () => {
    mount(running({ title: 'Weekly revenue', option: OPTION }), true, { surface: COLUMN })
    await paint('data:image/png;base64,FAKE')
    expect(delegatedCard()?.dataset.showChartDelegated).toBe('shown')
    expect(delegatedCard()?.textContent).toBe('Weekly revenue: shown in the content panel.')
    // Nothing left to paint in the conversation: the column has the picture.
    expect(stage()).toBeNull()
    expect(posted).toEqual([{
      callId: CALL_ID,
      verdict: PAINTED,
      dataUrl: 'data:image/png;base64,FAKE',
    }])
  })

  it('names the chart from its own copy when the call gave no title', async () => {
    mount(running({ option: OPTION }), false, { surface: COLUMN })
    await paint()
    expect(delegatedCard()?.textContent).toBe('Chart: shown in the content panel.')
  })

  it('keeps a failed chart in the conversation — the column cannot show what did not paint', async () => {
    mount(running({ title: 'Weekly revenue', option: OPTION }), false, { surface: COLUMN })
    const props = chart()
    await act(async () => { props.onVerdict({ ok: false, error: 'Series data is not an array' }) })
    expect(delegatedCard()).toBeNull()
    expect(screen.getByText('Weekly revenue')).toBeDefined()
    expect(screen.getByText('The chart did not render: Series data is not an array')).toBeDefined()
    expect(posted).toEqual([{ callId: CALL_ID, verdict: { ok: false, error: 'Series data is not an array' } }])
  })

  it('collapses a superseded row to its own notice rather than to the compact card', () => {
    mount(running({ id: 'revenue', title: 'Weekly revenue', option: OPTION }), false, {
      charts: { entries: [], latest: { revenue: 'call_01_chart' } },
      surface: COLUMN,
    })
    expect(screen.getByText('Weekly revenue: updated by a later call.')).toBeDefined()
    expect(delegatedCard()).toBeNull()
    expect(bridge.renders).toHaveLength(0)
  })

  it('shows the unreadable row for arguments no column could route either', () => {
    mount({ ...(running('x') as Extract<ToolCallBlock, { name: string }>), argsRaw: 'not json' }, false, {
      surface: COLUMN,
    })
    expect(screen.getByText(en['row.unreadable'])).toBeDefined()
    expect(delegatedCard()).toBeNull()
  })
})
