// @vitest-environment jsdom
/**
 * ShellFrame under the four-share props form: a real panel store instance
 * (createPanelStore().create() — the test-sanctioned engine path), a
 * recording renderSlot stub, and a `useSessions` stub carrying the current
 * session's `contentSurface.entries` count (the content-empty collapse's own
 * input — see `ShellFrame.tsx`'s module doc). jsdom has no layout engine, so
 * the frame's own box arrives through the ResizeObserver stub rather than a
 * real measurement. The assertions are the user-visible ones: the four
 * tracks the grid gets, the owner share the session column receives, the
 * empty content column's own body, the content-empty collapse itself, and
 * that every resident column stays mounted across a fold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { ShellFrame, type ShellFrameProps } from '../src/client/ShellFrame.tsx'
import { createPanelStore } from '../src/client/stores.ts'
import { CHAT_UNITS, CONTENT_UNITS, SESSION_RAIL, SESSION_UNITS, solveTracks } from '../src/client/tracks.ts'
import { zh } from '../src/client/locales.ts'

const FRAME = 1680
const TEST_SESSION_ID = 'shell-frame-test-session' as SessionId

/** Observer stub: captures the callback so a spec can deliver a resize. */
let deliverResize: ((width: number) => void) | null = null
class ResizeObserverStub {
  #callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) { this.#callback = callback }
  observe(): void {
    deliverResize = (width) => {
      this.#callback([{ contentRect: { width } } as ResizeObserverEntry], this)
    }
  }
  unobserve(): void {}
  disconnect(): void { deliverResize = null }
}

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(instance: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(select: (state: T) => S): S {
    return select(useSyncExternalStore(instance.subscribe, instance.getSnapshot))
  }
}

/**
 * `mountFrame`'s content-surface control: a positive/zero entry count, no
 * current session at all, or a current session carrying no `contentSurface`
 * projection value whatsoever (a deployment that never composes
 * `dsh-experimental-content-surface` — this package has zero dependency on
 * it, see the module doc).
 */
type ContentFixture = number | 'no-session' | 'no-projection'

/**
 * Build a `useSessions` stub reporting one current session whose
 * `contentSurface.entries` carries `contentEntries` items — see
 * {@link ContentFixture} for the two sentinel cases (both collapsed
 * readings; see `ShellFrame.tsx`'s own `currentContentEmpty`).
 * `contentSurface` is not a type this package depends on (soft-coupled read,
 * see the module doc), so the state is built loosely and cast through
 * `unknown` rather than satisfying `SessionListState` structurally.
 */
function useSessionsStub(contentEntries: ContentFixture): ShellFrameProps['useSessions'] {
  const noSession = contentEntries === 'no-session'
  const noProjection = contentEntries === 'no-projection'
  const entryCount = noSession || noProjection ? 0 : contentEntries
  const state = {
    ids: noSession ? [] : [TEST_SESSION_ID],
    byId: noSession ? {} : {
      [TEST_SESSION_ID]: {
        id: TEST_SESSION_ID,
        displayTitle: 'Test',
        running: false,
        blank: false,
        updatedAt: 1,
        ...noProjection ? {} : {
          projectionValues: { contentSurface: { entries: Array.from({ length: entryCount }, () => ({})) } },
        },
      },
    },
    current: noSession ? undefined : TEST_SESSION_ID,
    phase: 'ready',
  } as unknown as SessionListState
  return ((select: (s: SessionListState) => unknown) => select(state)) as never
}

function mountFrame(occupied: readonly string[] = [], contentEntries: ContentFixture = 1) {
  window.innerWidth = FRAME
  const instance = createPanelStore().create()
  const calls: { key: string; owner: unknown }[] = []
  const renderSlot = (key: string, owner: object, opts?: { fallback?: ReactNode }) => {
    calls.push({ key, owner })
    return occupied.includes(key) ? <div data-testid={`${key}-occupant`} /> : opts?.fallback ?? null
  }
  // The frame reads five of its seats; the rest of the composed share is
  // framework-supplied and never touched, so the bench supplies only these.
  const props = {
    useStore: hookOf(instance),
    useSessions: useSessionsStub(contentEntries),
    actions: instance.actions,
    renderSlot,
    t: makeTranslate(zh),
  } as unknown as ShellFrameProps
  const view = render(<ShellFrame {...props} />)
  return { instance, calls, frame: view.container.firstElementChild as HTMLElement }
}

/** The four px track widths the frame handed to CSS grid. */
function tracks(frame: HTMLElement): number[] {
  const template = frame.style.gridTemplateColumns
  const matched = /^(\d+)px (\d+)px (\d+)px (\d+)px$/.exec(template)
  if (matched === null) throw new Error(`unexpected template: ${template}`)
  return matched.slice(1).map(Number)
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  window.innerWidth = FRAME
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('ShellFrame', () => {
  it('lays four resident tracks out on the 3:16:5 ratio with details closed', () => {
    const { frame } = mountFrame()
    const solved = solveTracks(FRAME, false, false, false)
    expect(tracks(frame)).toEqual([solved.session, solved.content, solved.chat, 0])
    expect(solved.content / solved.session).toBeCloseTo(CONTENT_UNITS / SESSION_UNITS, 5)
    expect(solved.content / solved.chat).toBeCloseTo(CONTENT_UNITS / CHAT_UNITS, 5)
  })

  it('renders every column in the fixed order session, content, chat, details', () => {
    const { frame } = mountFrame()
    const columns = [...frame.querySelectorAll('[data-shell-column]')]
      .map(node => node.getAttribute('data-shell-column'))
    expect(columns).toEqual(['session', 'content', 'chat', 'details'])
  })

  it('re-solves the ratio from the frame box the observer delivers', () => {
    const { frame } = mountFrame()
    act(() => { deliverResize?.(1200) })
    const solved = solveTracks(1200, false, false, false)
    expect(tracks(frame)).toEqual([solved.session, solved.content, solved.chat, 0])
  })

  it('ignores a zero-width observation rather than collapsing the shell', () => {
    const { frame } = mountFrame()
    const before = tracks(frame)
    act(() => { deliverResize?.(0) })
    expect(tracks(frame)).toEqual(before)
  })

  it('hands the session column its fold state and rendered width', () => {
    const { calls, instance, frame } = mountFrame()
    expect(calls.find(call => call.key === 'sidebar')?.owner)
      .toEqual({ collapsed: false, width: solveTracks(FRAME, false, false, false).session })

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.dataset['sessionFolded']).toBe('true')
    expect(calls.filter(call => call.key === 'sidebar').at(-1)?.owner)
      .toEqual({ collapsed: true, width: SESSION_RAIL })
  })

  it('opens the details band to its fixed width and keeps the subtree mounted while closed', () => {
    const { instance, frame, calls } = mountFrame(['details'])
    expect(tracks(frame)[3]).toBe(0)
    expect(screen.getByTestId('details-occupant')).toBeDefined()

    act(() => { instance.actions.openDetails() })
    expect(frame.dataset['detailsOpen']).toBe('true')
    expect(tracks(frame)[3]).toBe(solveTracks(FRAME, false, true, false).details)

    act(() => { instance.actions.closeDetails() })
    expect(tracks(frame)[3]).toBe(0)
    expect(screen.getByTestId('details-occupant')).toBeDefined()
    expect(calls.some(call => call.key === 'shell.overlay')).toBe(true)
  })

  it('fills an unclaimed content column with its own placeholder', () => {
    mountFrame()
    expect(screen.getByText(zh['content.title'])).toBeDefined()
    expect(screen.getByText(zh['content.hint'])).toBeDefined()
  })

  it('drops the placeholder once a plugin claims the content column', () => {
    mountFrame(['content'])
    expect(screen.queryByText(zh['content.title'])).toBeNull()
    expect(screen.getByTestId('content-occupant')).toBeDefined()
  })

  it('stops observing the frame on unmount', () => {
    mountFrame()
    expect(deliverResize).not.toBeNull()
    cleanup()
    expect(deliverResize).toBeNull()
  })

  it('collapses the content column to zero width while the current session has shown nothing', () => {
    const { frame } = mountFrame([], 0)
    const solved = solveTracks(FRAME, false, false, true)
    expect(tracks(frame)).toEqual([solved.session, 0, solved.chat, 0])
    expect(solved.chat).toBeGreaterThan(solveTracks(FRAME, false, false, false).chat)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('collapses the content column when there is no current session at all', () => {
    const { frame } = mountFrame([], 'no-session')
    expect(tracks(frame)[1]).toBe(0)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('collapses the content column when the current session carries no content-surface projection at all', () => {
    const { frame } = mountFrame([], 'no-projection')
    expect(tracks(frame)[1]).toBe(0)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('expands the content column once the current session has shown something', () => {
    const { frame } = mountFrame([], 1)
    expect(tracks(frame)[1]).toBeGreaterThan(0)
    expect(frame.dataset['contentEmpty']).toBeUndefined()
  })
})
