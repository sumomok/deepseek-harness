// @vitest-environment jsdom
/**
 * The content column's chart seat: what reaches the engine, what it draws while
 * another kind holds the column, and the two things it deliberately does not do
 * — capture, and report a verdict for a call that settled long ago.
 *
 * The component row is replaced by a recorder. Painting is its business and its
 * own specs cover it; the live engine in a real column is the web e2e's
 * business.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ChartSurface, type ChartSurfaceProps } from '../src/client/ChartSurface.tsx'
import { en } from '../src/client/locales.ts'

const bridge = vi.hoisted(() => ({ renders: [] as Record<string, unknown>[] }))

vi.mock('@deepseek-ai/dsh-experimental-vue2-echarts-poc/client', () => ({
  EChartsOption: (props: Record<string, unknown>) => {
    bridge.renders.push(props)
    return null
  },
}))

const t: ChartSurfaceProps['t'] = makeTranslate(en)
const OPTION = { series: [{ type: 'bar', data: [1, 2, 3] }] }

/** One `chart` entry, as the column's projection publishes it. */
function chartEntry(payload: unknown, title = 'Revenue'): ChartSurfaceProps['entry'] {
  return { kind: 'chart', entryId: 'sales', seq: 4, title, payload }
}

/** Render the seat for one selection. */
function mount(entry: ChartSurfaceProps['entry']): ReturnType<typeof render> {
  return render(<ChartSurface {...{ sessionId: 'a', entry, t } as unknown as ChartSurfaceProps} />)
}

beforeEach(() => {
  bridge.renders.length = 0
})

afterEach(() => {
  cleanup()
  document.body.removeAttribute('data-ds-dark-theme')
})

describe('chart content seat', () => {
  it('paints the entry\'s option under its caption', () => {
    const view = mount(chartEntry({ option: OPTION }))
    expect(view.container.querySelector('[data-chart-surface-stage]')).not.toBeNull()
    expect(view.getByText('Revenue')).toBeTruthy()
    expect(bridge.renders.at(-1)?.['option']).toEqual({ ...OPTION, tooltip: { renderMode: 'richText' } })
  })

  it('sanitizes the option before a real engine sees it', () => {
    mount(chartEntry({ option: { ...OPTION, graphic: [{ type: 'image' }], tooltip: { formatter: '<img>' } } }))
    const option = bridge.renders.at(-1)?.['option'] as Record<string, unknown>
    expect(option['graphic']).toBeUndefined()
    expect(option['tooltip']).toEqual({ formatter: '<img>', renderMode: 'richText' })
  })

  it('reports no verdict and captures nothing — the transcript row owns both', () => {
    mount(chartEntry({ option: OPTION }))
    const props = bridge.renders.at(-1) as Record<string, unknown>
    expect(props['onVerdict']).toBeUndefined()
    expect(props['capture']).toBeUndefined()
    expect(props['onCapture']).toBeUndefined()
  })

  it('follows the palette the shell marked on the document', () => {
    document.body.setAttribute('data-ds-dark-theme', '')
    mount(chartEntry({ option: OPTION }))
    expect(bridge.renders.at(-1)?.['dark']).toBe(true)
  })

  it('draws nothing at all while another kind holds the column', () => {
    const view = mount(undefined)
    expect(view.container.firstChild).toBeNull()
    expect(bridge.renders).toEqual([])
  })

  it('explains an entry whose payload carries no readable option', () => {
    const view = mount(chartEntry({ option: 'not an object' }))
    expect(view.container.querySelector('[data-chart-surface-error]')?.textContent).toBe(en['row.unreadable'])
    expect(bridge.renders).toEqual([])
  })
})
