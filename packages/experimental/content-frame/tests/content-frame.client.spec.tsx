// @vitest-environment jsdom
/**
 * The page seat under its props form, driven by the entries the content column
 * hands over. The assertions are the user-visible ones plus the two decisions
 * the package rests on: the frame carries no `sandbox`, which is what keeps the
 * hosted document same-origin with the shell, and a frame the user comes back
 * to is the SAME DOM element — across another page, another content kind, and
 * another session — which is what keeps that document alive.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { zh } from '../src/client/locales.ts'
import type { ContentPageView } from '../src/types.ts'

/** One `page` entry, as the column's projection resolves it. */
function pageEntry(page: string, payload: ContentPageView): ContentFrameProps['entry'] {
  return { kind: 'page', entryId: page, seq: 1, title: page, payload }
}

/** Render the seat for one selection, reusing an existing tree when given one. */
function mount(
  sessionId: string | undefined,
  entry: ContentFrameProps['entry'],
  cacheSize = 3,
  view?: ReturnType<typeof render>,
): ReturnType<typeof render> {
  const props = { sessionId, entry, cacheSize, t: makeTranslate(zh) } as unknown as ContentFrameProps
  const element = <ContentFrame {...props} />
  if (view === undefined) return render(element)
  view.rerender(element)
  return view
}

/** Every mounted frame, in DOM order, as `frameId → element`. */
function frames(view: ReturnType<typeof render>): Map<string, HTMLIFrameElement> {
  return new Map([...view.container.querySelectorAll<HTMLIFrameElement>('iframe[data-content-frame]')]
    .map(frame => [frame.getAttribute('data-content-frame-id') ?? '', frame]))
}

/** The frame the seat currently shows, if any. */
function active(view: ReturnType<typeof render>): HTMLIFrameElement | null {
  return view.container.querySelector<HTMLIFrameElement>('iframe[data-content-active]')
}

const REPORTS: ContentPageView = { state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports' }
const DASHBOARD: ContentPageView = { state: 'shown', page: 'dashboard', url: '/content-app/', title: 'Fleet dashboard' }

afterEach(() => {
  cleanup()
})

describe('content-frame page seat', () => {
  it('points one iframe at the URL the host resolved', () => {
    const view = mount('a', pageEntry('reports', REPORTS))
    const frame = active(view)
    // The attribute, not the resolved `src` property: the value must stay the
    // relative path the host published, so the frame follows the dsh origin.
    expect(frame?.getAttribute('src')).toBe('/content-app/reports/')
    expect(frame?.title).toBe(zh['frame.title'])
    expect(frame?.hasAttribute('sandbox')).toBe(false)
  })

  it('keeps one frame per page, so a session\'s two pages both stay alive', () => {
    const view = mount('a', pageEntry('reports', REPORTS))
    const first = frames(view).get('a reports')
    expect(first).toBeDefined()

    mount('a', pageEntry('dashboard', DASHBOARD), 3, view)
    expect(active(view)?.getAttribute('src')).toBe('/content-app/')
    expect(frames(view).get('a reports')).toBe(first)
    expect(frames(view).get('a reports')?.hasAttribute('data-content-active')).toBe(false)

    mount('a', pageEntry('reports', REPORTS), 3, view)
    expect(active(view)).toBe(first)
  })

  it('keeps the same iframe element when another content kind takes the column and gives it back', () => {
    const view = mount('a', pageEntry('reports', REPORTS))
    const first = frames(view).get('a reports')

    // The column hides this seat rather than unmounting it, and hands it no
    // entry while another kind is on display.
    mount('a', undefined, 3, view)
    expect(active(view)).toBeNull()
    expect(frames(view).get('a reports')).toBe(first)

    mount('a', pageEntry('reports', REPORTS), 3, view)
    expect(active(view)).toBe(first)
  })

  it('keeps each session\'s own frame across a switch and back', () => {
    const view = mount('a', pageEntry('reports', REPORTS))
    const first = frames(view).get('a reports')

    mount('b', pageEntry('reports', REPORTS), 3, view)
    expect([...frames(view).keys()].sort()).toEqual(['a reports', 'b reports'])
    expect(active(view)).toBe(frames(view).get('b reports'))

    mount('a', pageEntry('reports', REPORTS), 3, view)
    expect(active(view)).toBe(first)
  })

  it('drops the least recently shown frame past the configured bound', () => {
    const view = mount('a', pageEntry('reports', REPORTS), 2)
    const first = frames(view).get('a reports')
    mount('b', pageEntry('reports', REPORTS), 2, view)
    mount('c', pageEntry('reports', REPORTS), 2, view)
    expect([...frames(view).keys()].sort()).toEqual(['b reports', 'c reports'])
    // Returning to the evicted frame mounts a new element: its document is gone.
    mount('a', pageEntry('reports', REPORTS), 2, view)
    expect(frames(view).get('a reports')).not.toBe(first)
  })

  it('shows nothing at all while no session is current', () => {
    const view = mount(undefined, undefined)
    expect(active(view)).toBeNull()
    expect(view.container.querySelector('[data-content-notice]')).toBeNull()
  })

  it('explains a page the deployment retired, and keeps the frames behind it', () => {
    const view = mount('a', pageEntry('reports', REPORTS))
    const first = frames(view).get('a reports')

    mount('a', pageEntry('gone', { state: 'missing', page: 'gone' }), 3, view)
    expect(view.container.querySelector('[data-content-notice]')?.textContent).toBe(zh['frame.missing'])
    expect(active(view)).toBeNull()
    expect(frames(view).get('a reports')).toBe(first)
  })

  it('explains an entry whose payload is not a page view', () => {
    const view = mount('a', { kind: 'page', entryId: 'reports', seq: 1, title: 'reports', payload: { state: 'empty' } })
    expect(view.container.querySelector('[data-content-notice]')?.textContent).toBe(zh['frame.missing'])
  })
})
