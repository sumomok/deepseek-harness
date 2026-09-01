// @vitest-environment jsdom
/**
 * The page seat under its props form, driven by the entries the content column
 * hands over. The assertions are the user-visible ones plus the three decisions
 * the package rests on: the frame carries no `sandbox`, which is what keeps the
 * hosted document same-origin with the shell; a frame the user comes back to is
 * the SAME DOM element — across another page, another content kind, and another
 * session — which is what keeps that document alive; and the seat is where the
 * reader lives, because it is the only placement holding those elements.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { zh } from '../src/client/locales.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ReadOutcome } from '../src/access/wire.ts'
import type { ContentReadRequest } from '../src/types.ts'
import type { ContentPageView } from '../src/types.ts'

/** One `page` entry, as the column's projection resolves it. */
function pageEntry(page: string, payload: ContentPageView): ContentFrameProps['entry'] {
  return { kind: 'page', entryId: page, seq: 1, title: page, payload }
}

/** What the seat reads off the session list: the column's entries and its open reads. */
interface Published {
  entries?: readonly ContentSurfaceEntry[]
  pending?: readonly ContentReadRequest[]
}

/** The values the framework's session-list hook serves this seat. */
let published: Published = {}

/** A stand-in for the framework hook every root slot receives. */
function useSessions<S>(select: (state: never) => S): S {
  return select({
    current: 'a',
    byId: {
      a: {
        projectionValues: {
          contentSurface: { entries: published.entries },
          contentAccess: { pending: published.pending },
        },
      },
    },
  } as never)
}

/** Render the seat for one selection, reusing an existing tree when given one. */
function mount(
  sessionId: string | undefined,
  entry: ContentFrameProps['entry'],
  cacheSize = 3,
  view?: ReturnType<typeof render>,
  pageAccess?: { outlineChars: number; readTimeoutMs: number },
): ReturnType<typeof render> {
  const props = {
    sessionId,
    entry,
    cacheSize,
    useSessions,
    t: makeTranslate(zh),
    ...pageAccess === undefined ? {} : { pageAccess },
  } as unknown as ContentFrameProps
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

beforeEach(() => {
  published = {}
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
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

describe('the page seat as the reader\'s seat', () => {
  /** Every document posted to a read route, in order. */
  let posted: { route: string; body: Record<string, unknown> }[] = []

  /**
   * The page these cases put in front. `about:blank` rather than the hosted
   * route: jsdom fetches no subresources, so a frame pointed at a real path
   * stays forever `loading` with no document at all. Reading the real route
   * through a real frame belongs to the browser lane.
   */
  const BLANK: ContentPageView = { state: 'shown', page: 'reports', url: 'about:blank', title: 'Weekly reports' }

  /** The one page entry the reader answers about. */
  const ENTRY: ContentSurfaceEntry = {
    kind: 'page', entryId: 'reports', seq: 1, title: 'Weekly reports', payload: BLANK,
  }

  beforeEach(() => {
    posted = []
    vi.stubGlobal('fetch', vi.fn((route: string, init: RequestInit) => {
      posted.push({ route, body: JSON.parse(init.body as string) as Record<string, unknown> })
      const answer = route === CONTENT_CLAIM_ROUTE ? { claimed: true } : { accepted: true }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
    }))
  })

  /** Put one document inside the frame the seat mounted. */
  function fill(view: ReturnType<typeof render>, html: string): HTMLIFrameElement {
    const frame = active(view)
    if (frame?.contentWindow == null) throw new Error('the seat mounted no readable frame')
    frame.contentWindow.document.body.innerHTML = html
    return frame
  }

  /** The outcomes posted so far. */
  function outcomes(): ReadOutcome[] {
    return posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE).map(entry => entry.body.outcome as ReadOutcome)
  }

  /** Wait until the reader has posted `count` outcomes. */
  async function settled(count: number): Promise<void> {
    await vi.waitFor(() => { expect(outcomes()).toHaveLength(count) }, { timeout: 3000 })
  }

  it('reads the document of the frame it holds, for the page it has in front', async () => {
    published = { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] }
    const view = mount('a', ENTRY, 3, undefined, { outlineChars: 4000, readTimeoutMs: 500 })
    fill(view, '<main><button>Refresh</button></main>')
    await settled(1)
    const outcome = outcomes()[0]
    if (outcome?.status !== 'ok') throw new Error('the seat answered a failure')
    expect(outcome.page).toEqual({ id: 'reports', title: 'Weekly reports' })
    expect(outcome.snapshot.text).toContain('Refresh')
  })

  it('retires a frame\'s numbering when the page inside it navigates', async () => {
    published = { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] }
    const view = mount('a', ENTRY, 3, undefined, { outlineChars: 4000, readTimeoutMs: 500 })
    const frame = fill(view, '<main><button>Refresh</button></main>')
    await settled(1)
    const before = outcomes()[0]

    // A load is what a navigation looks like from the seat, and every ref the
    // model still holds names an element of the document that just left.
    frame.dispatchEvent(new Event('load'))
    published = { entries: [ENTRY], pending: [{ callId: 'call_2', tool: 'content_read', args: {} }] }
    mount('a', ENTRY, 3, view, { outlineChars: 4000, readTimeoutMs: 500 })
    await settled(2)
    const after = outcomes()[1]

    if (before?.status !== 'ok' || after?.status !== 'ok') throw new Error('the seat answered a failure')
    // Numbers are never reused, reset included, so the same button comes back
    // under a ref the earlier listing never mentioned.
    expect(after.snapshot.text).not.toBe(before.snapshot.text)
  })

  it('installs no reader at all where the deployment configured no page access', async () => {
    published = { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] }
    const view = mount('a', ENTRY)
    fill(view, '<main><button>Refresh</button></main>')
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(posted).toEqual([])
  })
})
