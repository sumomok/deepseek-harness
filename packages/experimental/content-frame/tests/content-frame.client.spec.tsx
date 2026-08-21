// @vitest-environment jsdom
/**
 * The content column under its props form, driven by a fake session feed. The
 * assertions are the user-visible ones plus the two decisions the package rests
 * on: the frame carries no `sandbox`, which is what keeps the hosted document
 * same-origin with the shell, and a frame the user comes back to is the SAME
 * DOM element, which is what keeps that document alive across a session switch.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { zh } from '../src/client/locales.ts'
import type { ContentPageView } from '../src/types.ts'

/** The session facts the column reads, as one render's worth of feed. */
interface Feed {
  current?: string
  views?: Record<string, ContentPageView>
}

/**
 * Stand in for the framework's `useSessions` selector hook over one feed.
 * @param feed - the session list state this render sees.
 * @returns the hook the column calls.
 */
function sessionsHook(feed: Feed): ContentFrameProps['useSessions'] {
  const state = {
    current: feed.current,
    byId: Object.fromEntries(Object.entries(feed.views ?? {})
      .map(([id, content]) => [id, { projectionValues: { content } }])),
  }
  return ((selector: (snapshot: unknown) => unknown) => selector(state)) as ContentFrameProps['useSessions']
}

/** Render the column for one feed, reusing an existing tree when given one. */
function mount(
  feed: Feed,
  cacheSize = 3,
  view?: ReturnType<typeof render>,
  defaultPage?: { url: string; title: string },
): ReturnType<typeof render> {
  const props = {
    useSessions: sessionsHook(feed),
    cacheSize,
    ...defaultPage === undefined ? {} : { defaultPage },
    t: makeTranslate(zh),
  } as unknown as ContentFrameProps
  const element = <ContentFrame {...props} />
  if (view === undefined) return render(element)
  view.rerender(element)
  return view
}

/** Every mounted frame, in DOM order, as `sessionId → element`. */
function frames(view: ReturnType<typeof render>): Map<string, HTMLIFrameElement> {
  return new Map([...view.container.querySelectorAll<HTMLIFrameElement>('iframe[data-content-frame]')]
    .map(frame => [frame.getAttribute('data-content-session') ?? '', frame]))
}

/** The frame the column currently shows, if any. */
function active(view: ReturnType<typeof render>): HTMLIFrameElement | null {
  return view.container.querySelector<HTMLIFrameElement>('iframe[data-content-active]')
}

const SHOWN: ContentPageView = { state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports' }
const OTHER: ContentPageView = { state: 'shown', page: 'dashboard', url: '/content-app/', title: 'Fleet dashboard' }

afterEach(() => {
  cleanup()
})

describe('content column', () => {
  it('points one iframe at the URL the host resolved', () => {
    const view = mount({ current: 'a', views: { a: SHOWN } })
    const frame = active(view)
    // The attribute, not the resolved `src` property: the value must stay the
    // relative path the host published, so the frame follows the dsh origin.
    expect(frame?.getAttribute('src')).toBe('/content-app/reports/')
    expect(frame?.title).toBe(zh['frame.title'])
    expect(frame?.hasAttribute('sandbox')).toBe(false)
  })

  it('shows the default page the host resolved for a session that has shown nothing', () => {
    const view = mount({ current: 'a', views: { a: { state: 'default', url: '/content-app/', title: 'Home' } } })
    expect(active(view)?.getAttribute('src')).toBe('/content-app/')
  })

  it('keeps the same iframe element when the user leaves a session and comes back', () => {
    const view = mount({ current: 'a', views: { a: SHOWN, b: OTHER } })
    const first = frames(view).get('a')
    expect(first).toBeDefined()

    mount({ current: 'b', views: { a: SHOWN, b: OTHER } }, 3, view)
    expect(active(view)?.getAttribute('src')).toBe('/content-app/')
    // A's frame is still mounted, merely not shown — that is what keeps its
    // document, and everything the user left in it, alive.
    expect(frames(view).get('a')).toBe(first)
    expect(frames(view).get('a')?.hasAttribute('data-content-active')).toBe(false)

    mount({ current: 'a', views: { a: SHOWN, b: OTHER } }, 3, view)
    expect(frames(view).get('a')).toBe(first)
    expect(active(view)).toBe(first)
  })

  it('drops the least recently shown frame past the configured bound', () => {
    const views = { a: SHOWN, b: OTHER, c: SHOWN }
    const view = mount({ current: 'a', views }, 2)
    const first = frames(view).get('a')
    mount({ current: 'b', views }, 2, view)
    mount({ current: 'c', views }, 2, view)
    expect([...frames(view).keys()].sort()).toEqual(['b', 'c'])
    // Returning to the evicted session mounts a new element: its document is gone.
    mount({ current: 'a', views }, 2, view)
    expect(frames(view).get('a')).not.toBe(first)
  })

  it('keeps every cached frame while the column shows none', () => {
    const view = mount({ current: 'a', views: { a: SHOWN } })
    const first = frames(view).get('a')
    mount({}, 3, view)
    expect(active(view)).toBeNull()
    expect(frames(view).get('a')).toBe(first)
    mount({ current: 'a', views: { a: SHOWN } }, 3, view)
    expect(active(view)).toBe(first)
  })

  it('shows the deployment default before any session is current, and keeps that frame', () => {
    const home = { url: '/content-app/', title: 'Home' }
    const view = mount({}, 3, undefined, home)
    const first = active(view)
    expect(first?.getAttribute('src')).toBe('/content-app/')

    // Opening a session moves the column to that session's own page; the
    // no-session frame stays cached under its own key.
    mount({ current: 'a', views: { a: SHOWN } }, 3, view, home)
    expect(active(view)?.getAttribute('src')).toBe('/content-app/reports/')
    expect([...frames(view).keys()].sort()).toEqual(['', 'a'])
    mount({}, 3, view, home)
    expect(active(view)).toBe(first)
  })

  it('holds the default page while a current session\'s history has not landed', () => {
    const view = mount({ current: 'a' }, 3, undefined, { url: '/content-app/', title: 'Home' })
    expect(active(view)?.getAttribute('src')).toBe('/content-app/')
    // The projection arriving navigates that session's own frame in place.
    mount({ current: 'a', views: { a: SHOWN } }, 3, view, { url: '/content-app/', title: 'Home' })
    expect(frames(view).size).toBe(1)
    expect(active(view)?.getAttribute('src')).toBe('/content-app/reports/')
  })

  it('explains an empty column and a retired page with different notices', () => {
    const view = mount({})
    expect(view.container.querySelector('[data-content-notice]')?.textContent).toBe(zh['frame.empty'])

    mount({ current: 'a', views: { a: { state: 'empty' } } }, 3, view)
    expect(view.container.querySelector('[data-content-notice]')?.textContent).toBe(zh['frame.empty'])

    mount({ current: 'a', views: { a: { state: 'missing', page: 'reports' } } }, 3, view)
    expect(view.container.querySelector('[data-content-notice]')?.textContent).toBe(zh['frame.missing'])
  })

  it('navigates a session\'s own frame when the agent shows it another page', () => {
    const view = mount({ current: 'a', views: { a: SHOWN } })
    const first = frames(view).get('a')
    mount({ current: 'a', views: { a: OTHER } }, 3, view)
    expect(frames(view).size).toBe(1)
    expect(frames(view).get('a')).toBe(first)
    expect(active(view)?.getAttribute('src')).toBe('/content-app/')
  })
})
