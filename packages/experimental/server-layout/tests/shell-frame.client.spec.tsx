// @vitest-environment jsdom
/**
 * ShellFrame under the four-share props form: a real panel store instance
 * (createPanelStore().create() — the test-sanctioned engine path) and a
 * recording renderSlot stub. jsdom has no layout engine, so the frame's own
 * box arrives through the ResizeObserver stub rather than a real measurement.
 * The assertions are the user-visible ones: the four tracks the grid gets, the
 * owner share the session column receives, the empty content column's own
 * body, and that every resident column stays mounted across a fold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ShellFrame, type ShellFrameProps } from '../src/client/ShellFrame.tsx'
import { createPanelStore } from '../src/client/stores.ts'
import { SESSION_RAIL, solveTracks } from '../src/client/tracks.ts'
import { zh } from '../src/client/locales.ts'

const FRAME = 1680

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

function mountFrame(occupied: readonly string[] = []) {
  window.innerWidth = FRAME
  const instance = createPanelStore().create()
  const calls: { key: string; owner: unknown }[] = []
  const renderSlot = (key: string, owner: object, opts?: { fallback?: ReactNode }) => {
    calls.push({ key, owner })
    return occupied.includes(key) ? <div data-testid={`${key}-occupant`} /> : opts?.fallback ?? null
  }
  // The frame reads four of its seats; the rest of the composed share is
  // framework-supplied and never touched, so the bench supplies only these.
  const props = {
    useStore: hookOf(instance),
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
  it('lays four resident tracks out on the 4:12:8 ratio with details closed', () => {
    const { frame } = mountFrame()
    const solved = solveTracks(FRAME, false, false)
    expect(tracks(frame)).toEqual([solved.session, solved.content, solved.chat, 0])
    expect(solved.content / solved.session).toBeCloseTo(3, 5)
    expect(solved.content / solved.chat).toBeCloseTo(1.5, 5)
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
    const solved = solveTracks(1200, false, false)
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
      .toEqual({ collapsed: false, width: solveTracks(FRAME, false, false).session })

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
    expect(tracks(frame)[3]).toBe(solveTracks(FRAME, false, true).details)

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
})
