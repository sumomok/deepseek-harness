// @vitest-environment jsdom
/**
 * ShellFrame under the four-share props form: a real panel store instance
 * (createPanelStore().create() — the test-sanctioned engine path), a
 * recording renderSlot stub, a `usePanelInfo` hook over that instance's
 * selection, and a `useSessions` stub carrying the main view's
 * `contentSurface.entries` count (the content-empty collapse's own
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
import { CHAT_UNITS, CONTENT_UNITS, DETAILS_WIDTH, SESSION_RAIL, SESSION_UNITS, SIDEBAR_DRAWER, solveTracks } from '../src/client/tracks.ts'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { zh } from '../src/client/locales.ts'

const FRAME = 1680
/** A frame width below SIDEBAR_AUTO_COLLAPSE (1024) — the fold breakpoint. */
const NARROW = 500
const TEST_SESSION_ID = 'shell-frame-test-session' as SessionId
/** A listed session no view retains, ahead of the main view's row in the list. */
const BACKGROUND_SESSION_ID = 'shell-frame-background-session' as SessionId

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
 * main-view session at all, a main-view session carrying no `contentSurface`
 * projection value whatsoever (a deployment that never composes
 * `dsh-experimental-content-surface` — this package has zero dependency on
 * it, see the module doc), or `{ surface }`, a `contentSurface` value of any
 * other form.
 */
type ContentFixture = number | 'no-session' | 'no-projection' | { surface: unknown }

/**
 * Build a `useSessions` stub listing one background session no view retains,
 * then one main-view session whose `contentSurface.entries` carries
 * `contentEntries` items — see {@link ContentFixture} for the other cases
 * (all collapsed readings; see `ShellFrame.tsx`'s own `currentContentEmpty`).
 * `contentSurface` is not a type this package depends on (soft-coupled read,
 * see the module doc), so the state is built loosely and cast through
 * `unknown` rather than satisfying `SessionListState` structurally.
 */
function useSessionsStub(contentEntries: ContentFixture): ShellFrameProps['useSessions'] {
  const noSession = contentEntries === 'no-session'
  const noProjection = contentEntries === 'no-projection'
  const surface = typeof contentEntries === 'object'
    ? contentEntries.surface
    : { entries: Array.from({ length: typeof contentEntries === 'number' ? contentEntries : 0 }, () => ({})) }
  const background = {
    id: BACKGROUND_SESSION_ID,
    displayTitle: 'Background',
    running: false,
    blank: false,
    updatedAt: 1,
    retainedBy: {},
    projectionValues: { contentSurface: { entries: [{}] } },
  }
  const state = {
    ids: noSession ? [BACKGROUND_SESSION_ID] : [BACKGROUND_SESSION_ID, TEST_SESSION_ID],
    byId: noSession ? { [BACKGROUND_SESSION_ID]: background } : {
      [BACKGROUND_SESSION_ID]: background,
      [TEST_SESSION_ID]: {
        id: TEST_SESSION_ID,
        displayTitle: 'Test',
        running: false,
        blank: false,
        updatedAt: 1,
        retainedBy: { mainView: 1 },
        ...noProjection ? {} : {
          projectionValues: { contentSurface: surface },
        },
      },
    },
    phase: 'ready',
  } as unknown as SessionListState
  return ((select: (s: SessionListState) => unknown) => select(state)) as never
}

function mountFrame(occupied: readonly string[] = [], contentEntries: ContentFixture = 1) {
  window.innerWidth = FRAME
  const instance = createPanelStore().create()
  const calls: { key: string; owner: unknown; entryKey?: string | undefined }[] = []
  const renderSlot = (key: string, owner: object, opts?: { fallback?: ReactNode; entryKey?: string }) => {
    calls.push({ key, owner, entryKey: opts?.entryKey })
    return occupied.includes(key) ? <div data-testid={`${key}-occupant`} /> : opts?.fallback ?? null
  }
  const usePanelInfo = hookOf({
    subscribe: listener => instance.subscribe(listener),
    getSnapshot: () => instance.getSnapshot().panelInfo,
  })
  // The frame reads seven of its seats; the rest of the composed share is
  // framework-supplied and never touched, so the bench supplies only these.
  const props = {
    useStore: hookOf(instance),
    useSessions: useSessionsStub(contentEntries),
    usePanelInfo,
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

  it('reserves the details track when the right column reports one and keeps its occupant mounted without it', () => {
    const { instance, frame, calls } = mountFrame(['rightbar'])
    expect(tracks(frame)[3]).toBe(0)
    expect(screen.getByTestId('rightbar-occupant')).toBeDefined()
    expect(calls.find(call => call.key === 'rightbar')?.owner)
      .toEqual({ width: DETAILS_WIDTH, viewportWidth: FRAME, canShow: true })

    act(() => { instance.actions.openRightbar(true, false) })
    expect(frame.dataset['detailsOpen']).toBe('true')
    expect(tracks(frame)[3]).toBe(solveTracks(FRAME, false, true, false, false).details)

    act(() => { instance.actions.openRightbar(false, true) })
    expect(tracks(frame)[3]).toBe(0)
    expect(frame.dataset['rightbarFullscreen']).toBe('true')

    act(() => { instance.actions.closeRightbar() })
    expect(tracks(frame)[3]).toBe(0)
    expect(screen.getByTestId('rightbar-occupant')).toBeDefined()
    expect(calls.some(call => call.key === 'shell.overlay')).toBe(true)
  })

  it('renders the Conversation main entry by default and the selected panel after a selection', () => {
    const { instance, calls } = mountFrame(['main'])
    expect(calls.filter(call => call.key === 'main').at(-1)?.entryKey).toBe('conversation')

    act(() => { instance.actions.selectPanel('schedule' as MainPanelId) })
    expect(calls.filter(call => call.key === 'main').at(-1)?.entryKey).toBe('schedule')
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

  it('collapses the content column to zero width while the main view has shown nothing', () => {
    const { frame } = mountFrame([], 0)
    const solved = solveTracks(FRAME, false, false, true, false)
    expect(tracks(frame)).toEqual([solved.session, 0, solved.chat, 0])
    expect(solved.chat).toBeGreaterThan(solveTracks(FRAME, false, false, false, false).chat)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('collapses the content column when no session is on the main view', () => {
    const { frame } = mountFrame([], 'no-session')
    expect(tracks(frame)[1]).toBe(0)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('collapses the content column when the main view carries no content-surface projection at all', () => {
    const { frame } = mountFrame([], 'no-projection')
    expect(tracks(frame)[1]).toBe(0)
    expect(frame.dataset['contentEmpty']).toBe('true')
  })

  it('collapses the content column when the main view\'s content-surface value is not an entry list', () => {
    for (const surface of ['entries', null, {}, { entries: 'none' }]) {
      const { frame } = mountFrame([], { surface })
      expect(tracks(frame)[1]).toBe(0)
      expect(frame.dataset['contentEmpty']).toBe('true')
      cleanup()
    }
  })

  it('expands the content column once the main view has shown something', () => {
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
