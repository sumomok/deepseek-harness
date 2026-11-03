// @vitest-environment jsdom
/**
 * Landing on a message the navigation layer asked for: page history to the
 * position, open the Turn fold that hides its row, scroll the row into view,
 * wash it, and settle. A repeated request for the same message lands again.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionRevealRequest } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { useChatScroll, type ChatScrollInput } from '../src/client/chat/use-chat-scroll.ts'
import type { ChatRevealTarget } from '../src/client/contract/reveal.ts'

const SESSION = SessionId('sess-reveal')

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function ScrollHarness({ input }: { readonly input: ChatScrollInput }) {
  const state = useChatScroll(input)
  return (
    <div ref={state.listRef} data-testid="scrollport">
      <div ref={state.columnRef} data-testid="column" data-chat-flow="" />
      <div data-chat-turn-spacer="" />
    </div>
  )
}

const VIEWPORT_HEIGHT = 400
const ROW_HEIGHT = 100

/**
 * One scrollport of stacked Chat rows whose boxes follow `scrollTop`, with the
 * anchor attributes the viewport addresses rows by.
 * @param count - number of rows to mount.
 */
function mountLanding(count = 10) {
  class Observer implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this) }
    unobserve(): void {}
    disconnect(): void {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  const loadThrough = vi.fn<(seq: number) => Promise<void>>(async () => {})
  const openAt = vi.fn<(seq: number) => Promise<boolean>>(async () => false)
  const settleReveal = vi.fn<(id: number) => void>()
  const notifyRevealFailure = vi.fn<() => void>()
  const setTurnProcessOpen = vi.fn<(turn: number, answerStep: number, open: boolean) => void>()
  let target: ChatRevealTarget | undefined
  let input: ChatScrollInput = {
    ready: true,
    order: [],
    firstSeq: null,
    lastKey: null,
    lastIsUser: false,
    steeringId: null,
    submissionId: null,
    submissionSteers: false,
    running: false,
    deferCompletedTurns: false,
    transcriptView: 'standard',
    loadedTurns: [],
    hasMore: false,
    loadingOlder: false,
    openAt,
    openTail: vi.fn(async () => {}), loadNewer: vi.fn(async () => false),
    loadOlder: vi.fn(),
    loadThrough,
    chatScroll: { read: () => null, save: vi.fn() },
    reveal: null,
    locateReveal: () => target,
    settleReveal,
    notifyRevealFailure,
    setTurnProcessOpen,
  }
  const view = render(<ScrollHarness input={input} />)
  const scroller = view.getByTestId('scrollport')
  const column = view.getByTestId('column')
  const rows: HTMLElement[] = Array.from({ length: count }, (_, index) => {
    const row = document.createElement('div')
    row.dataset.chatAnchorKey = `row:${String(index)}`
    row.dataset.chatNodeKey = `row:${String(index)}`
    row.dataset.chatTurn = '1'
    column.append(row)
    return row
  })
  const sizeOf = (row: HTMLElement): number => row.hidden ? 0 : ROW_HEIGHT
  const docTop = (row: HTMLElement): number => rows.indexOf(row) * ROW_HEIGHT
  const content = (): number => rows.reduce((sum, row) => sum + sizeOf(row), 0)
  let top = 0
  Object.defineProperties(scroller, {
    clientHeight: { value: VIEWPORT_HEIGHT },
    scrollHeight: { get: content },
    scrollTop: {
      get: () => top,
      set: (value: number) => { top = Math.max(0, Math.min(value, content() - VIEWPORT_HEIGHT)) },
    },
    scrollTo: {
      value: (options: ScrollToOptions) => {
        top = Math.max(0, Math.min(options.top ?? top, content() - VIEWPORT_HEIGHT))
      },
    },
    getBoundingClientRect: { value: () => ({ top: 0, bottom: VIEWPORT_HEIGHT, height: VIEWPORT_HEIGHT }) },
  })
  Object.defineProperty(column, 'offsetHeight', { get: content })
  for (const row of rows) {
    Object.defineProperty(row, 'getBoundingClientRect', {
      value: () => {
        const rowTop = docTop(row) - top
        return { top: rowTop, bottom: rowTop + sizeOf(row), height: sizeOf(row) }
      },
    })
  }
  const update = (patch: Partial<ChatScrollInput>): void => {
    input = { ...input, ...patch }
    view.rerender(<ScrollHarness input={input} />)
  }
  return {
    scroller,
    row: (index: number): HTMLElement => {
      const found = rows[index]
      if (found === undefined) throw new Error(`no row ${String(index)}`)
      return found
    },
    top: () => top,
    target: (next: ChatRevealTarget | undefined) => { target = next },
    raise: async (request: SessionRevealRequest): Promise<void> => {
      await act(async () => {
        update({ reveal: request })
        await Promise.resolve()
      })
      await act(async () => { await Promise.resolve() })
    },
    settleFrame: async (): Promise<void> => {
      await act(async () => { vi.advanceTimersByTime(32) })
      await act(async () => { await Promise.resolve() })
    },
    loadThrough,
    settleReveal,
    notifyRevealFailure,
    setTurnProcessOpen,
  }
}

function request(id: number, seq: number): SessionRevealRequest {
  return { id, sessionId: SESSION, seq: SessionSeq(seq) }
}

describe('Chat reveal landing', () => {
  it('pages history, scrolls the addressed row into view, washes it, and settles the request', async () => {
    const h = mountLanding()
    h.target({ key: 'row:5', process: null })

    await h.raise(request(1, 42))

    expect(h.loadThrough).toHaveBeenCalledWith(SessionSeq(42))
    expect(h.top()).toBe(5 * ROW_HEIGHT - 24)
    expect(h.row(5).dataset.chatLanded).toBe('')
    expect(h.settleReveal).toHaveBeenCalledWith(1)
    expect(h.notifyRevealFailure).not.toHaveBeenCalled()
  })

  it('opens the folded Turn process before landing, then retries once React commits it', async () => {
    const h = mountLanding()
    // The row is hidden by its Turn's process fold until that fold opens.
    h.row(5).hidden = true
    h.target({ key: 'row:5', process: { turn: 1, answerStep: 2 } })
    h.setTurnProcessOpen.mockImplementation(() => {
      // A real fold opens on the next commit, after the synchronous attempt.
      setTimeout(() => { h.row(5).hidden = false }, 0)
    })

    await h.raise(request(1, 42))
    expect(h.setTurnProcessOpen).toHaveBeenCalledWith(1, 2, true)
    expect(h.settleReveal).not.toHaveBeenCalled()

    await h.settleFrame()

    expect(h.top()).toBe(5 * ROW_HEIGHT - 24)
    expect(h.row(5).dataset.chatLanded).toBe('')
    expect(h.settleReveal).toHaveBeenCalledWith(1)
    expect(h.notifyRevealFailure).not.toHaveBeenCalled()
  })

  it('lands again when the same Session asks for the same message a second time', async () => {
    const h = mountLanding()
    h.target({ key: 'row:5', process: null })

    await h.raise(request(1, 42))
    expect(h.settleReveal).toHaveBeenCalledWith(1)
    // A later request carries a new identity even for the same message position.
    await act(async () => { vi.advanceTimersByTime(3_000) })
    expect(h.row(5).dataset.chatLanded).toBeUndefined()

    await h.raise(request(2, 42))

    expect(h.loadThrough).toHaveBeenCalledTimes(2)
    expect(h.row(5).dataset.chatLanded).toBe('')
    expect(h.settleReveal).toHaveBeenLastCalledWith(2)
  })

  it('reports a position the loaded window cannot place instead of landing elsewhere', async () => {
    const h = mountLanding()
    h.target(undefined)

    await h.raise(request(1, 42))

    expect(h.notifyRevealFailure).toHaveBeenCalledTimes(1)
    expect(h.settleReveal).toHaveBeenCalledWith(1)
    expect(h.row(0).dataset.chatLanded).toBeUndefined()
  })
})
