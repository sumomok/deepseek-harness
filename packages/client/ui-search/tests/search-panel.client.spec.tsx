// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SearchPanel, type SearchPanelProps } from '../src/client/SearchPanel.tsx'
import { zh } from '../src/client/locales.ts'
import { IDLE_STATE, type SearchPanelState, type SearchResultRow } from '../src/client/state.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const t: SearchPanelProps['t'] = makeTranslate(zh)

/** One result on a named session. */
function row(over: Partial<SearchResultRow> = {}): SearchResultRow {
  return {
    sessionId: 'sess-a' as SessionId,
    seq: 3,
    title: '重构消息级全文搜索',
    snippet: '游标里记 offset，下一页用分页游标续读。',
    matches: [{ start: 16, length: 2 }],
    ...over,
  }
}

/** A panel state derived from the idle template. */
function state(over: Partial<SearchPanelState> = {}): SearchPanelState {
  return { ...IDLE_STATE, open: true, query: '分页', phase: 'ready', rows: [row()], active: 0, ...over }
}

/** Props over one fixed state; the callbacks record what the panel asked for. */
function props(current: SearchPanelState, calls: {
  index?: { phase: 'opening' | 'reconciling' | 'ready'; examined: number; total: number; skipped: number } | undefined
  setQuery?: (value: string) => void
  moveActive?: (delta: number) => void
  openActive?: () => void
  openAt?: (index: number) => void
  loadMore?: () => void
  retry?: () => void
  close?: () => void
} = {}): SearchPanelProps {
  function useSearch<T>(select: (value: SearchPanelState) => T): T {
    return select(current)
  }
  function useSearchIndex<T>(select: (value: typeof calls.index) => T): T {
    return select(calls.index)
  }
  return {
    useSearch,
    useSearchIndex,
    setQuery: calls.setQuery ?? (() => {}),
    moveActive: calls.moveActive ?? (() => {}),
    openActive: calls.openActive ?? (() => {}),
    openAt: calls.openAt ?? (() => {}),
    loadMore: calls.loadMore ?? (() => {}),
    retry: calls.retry ?? (() => {}),
    close: calls.close ?? (() => {}),
    t,
  } as SearchPanelProps
}

/** The field the keyboard path drives. */
function field(): HTMLInputElement {
  return screen.getByRole('textbox') as HTMLInputElement
}

describe('SearchPanel visibility', () => {
  it('renders nothing while the overlay is closed', () => {
    const { container } = render(<SearchPanel {...props(state({ open: false }))} />)
    expect(container.innerHTML).toBe('')
  })

  it('mounts a modal dialog named by the localized label', () => {
    render(<SearchPanel {...props(state())} />)
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe(zh['panel.aria'])
  })
})

describe('SearchPanel results', () => {
  it('shows the session title and paints the matched span as a mark', () => {
    const { container } = render(<SearchPanel {...props(state())} />)
    expect(screen.getByText('重构消息级全文搜索')).toBeTruthy()
    expect(container.querySelector('mark')?.textContent).toBe('分页')
  })

  it('falls back to the untitled label when a result carries no title', () => {
    render(<SearchPanel {...props(state({ rows: [row({ title: undefined })] }))} />)
    expect(screen.getByText(zh['result.untitled'])).toBeTruthy()
  })

  it('keeps a match that runs past the excerpt inside the excerpt', () => {
    const { container } = render(<SearchPanel {...props(state({
      rows: [row({ snippet: 'abc分', matches: [{ start: 3, length: 8 }] })],
    }))} />)
    expect(container.querySelector('mark')?.textContent).toBe('分')
  })

  it('marks the active row and leaves the others unmarked', () => {
    const { container } = render(<SearchPanel {...props(state({
      rows: [
        row(),
        row({ seq: 4, snippet: '另一条分页记录', matches: [{ start: 3, length: 2 }] }),
      ],
      active: 1,
    }))} />)
    const rows = [...container.querySelectorAll('button')].filter(node => node.getAttribute('data-active') !== null)
    expect(rows.map(node => node.getAttribute('data-active'))).toEqual(['false', 'true'])
  })

  it('invites a query while the field is empty and reports no match once it is not', () => {
    const { rerender } = render(<SearchPanel {...props(state({ query: '  ', rows: [], phase: 'idle', active: -1 }))} />)
    expect(screen.getByText(zh['panel.idle'])).toBeTruthy()
    rerender(<SearchPanel {...props(state({ rows: [], active: -1 }))} />)
    expect(screen.getByText(zh['panel.empty'])).toBeTruthy()
    rerender(<SearchPanel {...props(state())} />)
    expect(screen.queryByText(zh['panel.empty'])).toBeNull()
  })
})

describe('SearchPanel keyboard', () => {
  it('dismisses from anywhere inside the dialog, not only the field', () => {
    const close = vi.fn()
    const { container } = render(<SearchPanel {...props(state(), { close })} />)
    const list = container.querySelector('[class*="list"]') as HTMLDivElement
    fireEvent.keyDown(list.firstElementChild!, { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('closes on Escape without opening anything', () => {
    const close = vi.fn()
    const openActive = vi.fn()
    render(<SearchPanel {...props(state(), { close, openActive })} />)
    fireEvent.keyDown(field(), { key: 'Escape' })
    expect(close).toHaveBeenCalledTimes(1)
    expect(openActive).not.toHaveBeenCalled()
  })

  it('moves the selection with the vertical arrows', () => {
    const moveActive = vi.fn()
    render(<SearchPanel {...props(state(), { moveActive })} />)
    fireEvent.keyDown(field(), { key: 'ArrowDown' })
    fireEvent.keyDown(field(), { key: 'ArrowUp' })
    expect(moveActive.mock.calls).toEqual([[1], [-1]])
  })

  it('opens the selection on Enter and stays put while the next page loads', () => {
    const openActive = vi.fn()
    const { rerender } = render(<SearchPanel {...props(state(), { openActive })} />)
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(openActive).toHaveBeenCalledTimes(1)
    rerender(<SearchPanel {...props(state({ phase: 'loadingMore' }), { openActive })} />)
    fireEvent.keyDown(field(), { key: 'Enter' })
    expect(openActive).toHaveBeenCalledTimes(1)
  })

  it('leaves Return to the input method while a composition is active', () => {
    const openActive = vi.fn()
    render(<SearchPanel {...props(state(), { openActive })} />)
    fireEvent.keyDown(field(), { key: 'Enter', isComposing: true })
    expect(openActive).not.toHaveBeenCalled()
  })

  it('reports every keystroke so the plugin body can debounce the read', () => {
    const setQuery = vi.fn()
    render(<SearchPanel {...props(state(), { setQuery })} />)
    fireEvent.change(field(), { target: { value: '分页' } })
    expect(setQuery).toHaveBeenCalledWith('分页')
  })
})

describe('SearchPanel paging', () => {
  it('asks for the next page only once the list reaches its end', () => {
    const loadMore = vi.fn()
    const { container } = render(<SearchPanel {...props(state({ nextCursor: 'cursor' as never }), { loadMore })} />)
    const list = container.querySelector('[class*="list"]') as HTMLDivElement
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    list.scrollTop = 0
    fireEvent.scroll(list)
    expect(loadMore).not.toHaveBeenCalled()
    list.scrollTop = 580
    fireEvent.scroll(list)
    expect(loadMore).toHaveBeenCalledTimes(1)
  })

  it('never asks for a next page the Host did not promise', () => {
    const loadMore = vi.fn()
    const { container } = render(<SearchPanel {...props(state(), { loadMore })} />)
    const list = container.querySelector('[class*="list"]') as HTMLDivElement
    Object.defineProperty(list, 'scrollHeight', { value: 1000, configurable: true })
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true })
    list.scrollTop = 900
    fireEvent.scroll(list)
    expect(loadMore).not.toHaveBeenCalled()
  })

  it('keeps the continuation reachable when a page comes back empty', () => {
    const loadMore = vi.fn()
    render(<SearchPanel {...props(state({ rows: [], nextCursor: 'cursor' as never, active: -1 }), { loadMore })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['panel.loadMore'] }))
    expect(loadMore).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(zh['panel.empty'])).toBeNull()
  })

  it('opens the row the pointer selected, not the keyboard selection', () => {
    const openAt = vi.fn()
    render(<SearchPanel {...props(state({
      rows: [
        row(),
        row({ seq: 4, snippet: '另一条分页记录', matches: [{ start: 3, length: 2 }] }),
      ],
      active: 0,
    }), { openAt })} />)
    fireEvent.click(screen.getAllByRole('button')[1]!)
    expect(openAt).toHaveBeenCalledWith(1)
  })

  it('offers the next page whenever the Host minted a cursor', () => {
    const loadMore = vi.fn()
    const { rerender } = render(<SearchPanel {...props(state({ nextCursor: 'cursor' as never }), { loadMore })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['panel.loadMore'] }))
    expect(loadMore).toHaveBeenCalledTimes(1)
    rerender(<SearchPanel {...props(state(), { loadMore })} />)
    expect(screen.queryByRole('button', { name: zh['panel.loadMore'] })).toBeNull()
  })

  it('closes when the pressed backdrop is the target itself', () => {
    const close = vi.fn()
    const { container } = render(<SearchPanel {...props(state(), { close })} />)
    fireEvent.pointerDown(container.firstElementChild as HTMLElement)
    expect(close).toHaveBeenCalledTimes(1)
  })
})

describe('SearchPanel status', () => {
  it('counts the rows and says whether more pages exist', () => {
    const { rerender } = render(<SearchPanel {...props(state({ nextCursor: 'cursor' as never }))} />)
    expect(screen.getByText(makeTranslate(zh)('result.countMore', { count: '1' }))).toBeTruthy()
    rerender(<SearchPanel {...props(state())} />)
    expect(screen.getByText(makeTranslate(zh)('result.count', { count: '1' }))).toBeTruthy()
  })

  it('reports index preparation ahead of the running read', () => {
    render(<SearchPanel {...props(state({ phase: 'loading', rows: [] }), {
      index: { phase: 'reconciling', examined: 73, total: 208, skipped: 40 },
    })} />)
    expect(screen.getByText(makeTranslate(zh)('panel.preparing', { examined: '73', total: '208' }))).toBeTruthy()
    expect(screen.queryByText(zh['panel.loading'])).toBeNull()
  })

  it('names the running read instead of counting', () => {
    render(<SearchPanel {...props(state({ phase: 'loading', rows: [] }))} />)
    expect(screen.getByText(zh['panel.loading'])).toBeTruthy()
  })

  it('warns when some sessions were unreadable', () => {
    render(<SearchPanel {...props(state({ coverage: { status: 'partial', skippedSessions: 2 } }))} />)
    expect(screen.getByText(zh['panel.partial'])).toBeTruthy()
  })

  it('offers a retry after a failed read', () => {
    const retry = vi.fn()
    render(<SearchPanel {...props(state({ phase: 'error', rows: [] }), { retry })} />)
    fireEvent.click(screen.getByRole('button', { name: zh['panel.retry'] }))
    expect(retry).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(zh['panel.empty'])).toBeNull()
  })
})
