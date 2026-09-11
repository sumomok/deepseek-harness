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
 * empty content column's own body, the content-empty collapse itself, that
 * every resident column stays mounted across a fold, and — below the fold
 * breakpoint — the off-canvas session drawer, its hamburger, and its scrim,
 * Escape, and widen dismissals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ShellFrame, type ShellFrameProps } from '../src/client/ShellFrame.tsx'
import { createPanelStore } from '../src/client/stores.ts'
import { CHAT_UNITS, CONTENT_UNITS, SESSION_RAIL, SESSION_UNITS, SIDEBAR_DRAWER, solveTracks } from '../src/client/tracks.ts'
import { zh } from '../src/client/locales.ts'

const FRAME = 1680
/** A frame width below SIDEBAR_AUTO_COLLAPSE (1024) — the fold breakpoint. */
const NARROW = 500
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
  // The frame reads seven of its seats; the rest of the composed share is
  // framework-supplied and never touched, so the bench supplies only these.
  // The renderer injects `SessionProvider`; this bench renders its children
  // straight through, because no assertion here turns on the scope binding.
  const props = {
    useStore: hookOf(instance),
    useSessions: useSessionsStub(contentEntries),
    actions: instance.actions,
    renderSlot,
    SessionProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
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

const hamburgerOf = (frame: HTMLElement) => frame.querySelector<HTMLElement>('[data-shell-drawer-toggle]')
const drawerOf = (frame: HTMLElement) => frame.querySelector<HTMLElement>('[data-shell-drawer]')
const scrimOf = (frame: HTMLElement) => frame.querySelector<HTMLElement>('[data-shell-drawer-scrim]')

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
    const solved = solveTracks(FRAME, false, false, false, false)
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
    const solved = solveTracks(1200, false, false, false, false)
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
      .toEqual({ collapsed: false, width: solveTracks(FRAME, false, false, false, false).session })

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
    expect(tracks(frame)[3]).toBe(solveTracks(FRAME, false, true, false, false).details)

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
    const solved = solveTracks(FRAME, false, false, true, false)
    expect(tracks(frame)).toEqual([solved.session, 0, solved.chat, 0])
    expect(solved.chat).toBeGreaterThan(solveTracks(FRAME, false, false, false, false).chat)
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

  it('takes the session column out of the grid and shows a hamburger below the breakpoint', () => {
    const { frame } = mountFrame(['sidebar'])
    act(() => { deliverResize?.(NARROW) })
    expect(frame.dataset['narrow']).toBe('true')
    expect(tracks(frame)[0]).toBe(0)
    expect(hamburgerOf(frame)).not.toBeNull()
    // The list moves to the drawer, so the 0-width grid column no longer
    // mounts the sidebar occupant; the drawer is still closed, so it is
    // nowhere on the page yet.
    expect(screen.queryByTestId('sidebar-occupant')).toBeNull()
  })

  it('opens the drawer at its clamped width with a scrim when the hamburger is tapped', () => {
    const { calls, frame } = mountFrame(['sidebar'])
    act(() => { deliverResize?.(NARROW) })
    act(() => { hamburgerOf(frame)?.click() })

    const drawer = drawerOf(frame)
    expect(drawer).not.toBeNull()
    expect(scrimOf(frame)).not.toBeNull()
    expect(hamburgerOf(frame)).toBeNull()
    expect(drawer?.style.width).toBe(`${Math.min(SIDEBAR_DRAWER, NARROW)}px`)
    expect(screen.getByTestId('sidebar-occupant')).toBeDefined()
    expect(calls.filter(call => call.key === 'sidebar').at(-1)?.owner)
      .toEqual({ collapsed: false, width: Math.min(SIDEBAR_DRAWER, NARROW) })
  })

  it('moves focus into the drawer on open and back to the hamburger on scrim-close', () => {
    const { frame } = mountFrame()
    act(() => { deliverResize?.(NARROW) })
    act(() => { hamburgerOf(frame)?.click() })
    expect(document.activeElement?.getAttribute('data-shell-drawer')).toBe('true')

    act(() => { scrimOf(frame)?.click() })
    expect(drawerOf(frame)).toBeNull()
    expect(document.activeElement?.getAttribute('data-shell-drawer-toggle')).toBe('true')
  })

  it('closes the drawer on Escape and ignores other keys', () => {
    const { frame } = mountFrame()
    act(() => { deliverResize?.(NARROW) })
    act(() => { hamburgerOf(frame)?.click() })
    expect(drawerOf(frame)).not.toBeNull()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })) })
    expect(drawerOf(frame)).not.toBeNull()

    act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
    expect(drawerOf(frame)).toBeNull()
    expect(hamburgerOf(frame)).not.toBeNull()
  })

  it('forces the drawer closed when the frame widens back past the breakpoint', () => {
    const { frame } = mountFrame(['sidebar'])
    act(() => { deliverResize?.(NARROW) })
    act(() => { hamburgerOf(frame)?.click() })
    expect(drawerOf(frame)).not.toBeNull()

    act(() => { deliverResize?.(FRAME) })
    expect(frame.dataset['narrow']).toBeUndefined()
    expect(drawerOf(frame)).toBeNull()
    expect(hamburgerOf(frame)).toBeNull()
    // The session column is back in the grid at its solved width.
    expect(tracks(frame)[0]).toBe(solveTracks(FRAME, false, false, false, false).session)
  })
})
