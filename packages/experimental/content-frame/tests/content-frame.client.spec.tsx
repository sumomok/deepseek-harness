// @vitest-environment jsdom
/**
 * The page seat under its props form, driven by the entries the content column
 * hands over. The assertions are the user-visible ones plus the three decisions
 * the package rests on: the frame carries no `sandbox`, which is what keeps the
 * hosted document same-origin with the shell; a frame the user comes back to is
 * the SAME DOM element — across another page, another content kind, and another
 * session — which is what keeps that document alive; and the seat is where the
 * reader and the navigation watch live, because it is the only placement
 * holding those elements.
 */
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { zh } from '../src/client/locales.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ReadOutcome } from '../src/access/wire.ts'
import { NAVIGATION_SETTLE_MS } from '../src/client/perception/navigation.ts'
import type { ContentReadRequest } from '../src/types.ts'
import type { ContentPageView } from '../src/types.ts'

/** One `page` entry, as the column's projection resolves it. */
function pageEntry(page: string, payload: ContentPageView): ContentFrameProps['entry'] {
  return { kind: 'page', entryId: page, seq: 1, title: page, payload }
}

/** What the seat reads off the session list for one session: its entries and its open reads. */
interface Published {
  entries?: readonly ContentSurfaceEntry[]
  pending?: readonly ContentReadRequest[]
}

/**
 * The values the framework's session-list hook serves this seat, by session id.
 * The seat reads the whole list rather than one row, so a case naming a second
 * session is what puts a column behind the one on display.
 */
let published: Record<string, Published> = {}

/** The session the console is showing, which the column also passes to the seat. */
let current: string | undefined = 'a'

/**
 * A stand-in for the framework hook every root slot receives, memoizing the way
 * `useSyncExternalStoreWithSelector` does: the selection keeps its identity for
 * as long as the caller's own equality says nothing moved. The list snapshot is
 * rebuilt on every call, which is what the real store does too.
 */
function useSessions<S>(select: (state: never) => S, eq?: (a: S, b: S) => boolean): S {
  const held = useRef<{ value: S } | undefined>(undefined)
  const next = select({
    current,
    byId: Object.fromEntries(Object.entries(published).map(([sessionId, values]) => [sessionId, {
      projectionValues: {
        contentSurface: { entries: values.entries },
        contentAccess: { pending: values.pending },
      },
    }])),
  } as never)
  const previous = held.current
  if (previous !== undefined && eq?.(previous.value, next) === true) return previous.value
  held.current = { value: next }
  return next
}

/** Every move the seat reported, in order. */
let navigated: { sessionId: string; page: string; url: string; title: string }[] = []

/** How often the seat asks the frame in front where it is, in these cases. */
const POLL_MS = 50

/** Render the seat for one selection, reusing an existing tree when given one. */
function mount(
  sessionId: string | undefined,
  entry: ContentFrameProps['entry'],
  cacheSize = 3,
  view?: ReturnType<typeof render>,
  pageAccess?: { outlineChars: number; claimTimeoutMs: number; readTimeoutMs: number; settleQuietMs: number },
): ReturnType<typeof render> {
  const props = {
    sessionId,
    entry,
    cacheSize,
    navigationPollMs: POLL_MS,
    onNavigated: (session: string, page: string, url: string, title: string) => {
      navigated.push({ sessionId: session, page, url, title })
    },
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
  current = 'a'
  navigated = []
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

describe('the page seat as the navigation watch\'s seat', () => {
  /**
   * The page these cases put in front. `about:blank` for the same reason the
   * reader's cases use it: jsdom fetches no subresources, so a frame pointed at
   * a real path never has a document at all.
   */
  const BLANK: ContentPageView = { state: 'shown', page: 'reports', url: 'about:blank', title: 'Weekly reports' }
  const OTHER: ContentPageView = { state: 'shown', page: 'dashboard', url: 'about:blank#other', title: 'Fleet dashboard' }

  /** Wait for the settling window the watch holds every signal in. */
  async function reported(count: number): Promise<void> {
    await vi.waitFor(() => { expect(navigated).toHaveLength(count) }, { timeout: 3000 })
  }

  it('reports the frame in front moving, naming the session and the page it belongs to', async () => {
    const view = mount('a', pageEntry('reports', BLANK))
    const frame = active(view)
    if (frame?.contentWindow == null) throw new Error('the seat mounted no frame')
    frame.contentWindow.location.hash = '#/device'
    await reported(1)
    expect(navigated[0]).toMatchObject({ sessionId: 'a', page: 'reports' })
    expect(navigated[0]?.url).toContain('#/device')
  })

  it('watches the frame in front and no other', async () => {
    const view = mount('a', pageEntry('reports', BLANK))
    const first = frames(view).get('a reports')
    // Another page takes the column; the first frame stays mounted and hidden.
    mount('a', pageEntry('dashboard', OTHER), 3, view)
    expect(frames(view).get('a reports')).toBe(first)
    if (first?.contentWindow == null) throw new Error('the cached frame lost its window')
    first.contentWindow.location.hash = '#/behind'

    const shown = active(view)
    if (shown?.contentWindow == null) throw new Error('the seat mounted no frame')
    shown.contentWindow.location.hash = '#/front'
    await reported(1)
    expect(navigated).toEqual([expect.objectContaining({ page: 'dashboard' })])
  })

  /** Wait past a settling window and several polls, for a case asserting nothing more happens. */
  async function quiet(): Promise<void> {
    await new Promise<void>((resolve) => { setTimeout(resolve, NAVIGATION_SETTLE_MS + POLL_MS * 3) })
  }

  it('does not report an address again when the user comes back to the frame it was reported for', async () => {
    // The watch is remade every time this frame returns to the front; what the
    // log already carries is the seat's memory, not the watch's.
    const view = mount('a', pageEntry('reports', BLANK))
    const frame = active(view)
    if (frame?.contentWindow == null) throw new Error('the seat mounted no frame')
    frame.contentWindow.location.hash = '#/device'
    await reported(1)

    mount('a', pageEntry('dashboard', OTHER), 3, view)
    await quiet()
    mount('a', pageEntry('reports', BLANK), 3, view)
    await quiet()
    // Counted per page, because the other page reports about itself in this
    // fixture (see the next case): the returning watch says nothing new about
    // the frame it was handed.
    expect(navigated.filter(move => move.page === 'reports')).toHaveLength(1)
  })

  it('reports once for an application that moved while its page was not in front', async () => {
    const view = mount('a', pageEntry('reports', BLANK))
    const behind = frames(view).get('a reports')
    mount('a', pageEntry('dashboard', OTHER), 3, view)
    await quiet()
    // The other page's own reports are this fixture's, not this case's: a
    // frame `src`-ed at `about:blank#other` reads its address back as
    // `blank#other`, so the seat sees the page as having moved off its own
    // entry point. A configured page's URL is a path, and reads back as one.
    const other = navigated.length

    if (behind?.contentWindow == null) throw new Error('the cached frame lost its window')
    // Nothing watches it here; the move is noticed when the page comes back.
    behind.contentWindow.location.hash = '#/hidden'
    await quiet()
    expect(navigated).toHaveLength(other)

    mount('a', pageEntry('reports', BLANK), 3, view)
    await reported(other + 1)
    expect(navigated[other]).toMatchObject({ page: 'reports' })
    expect(navigated[other]?.url).toContain('#/hidden')
    await quiet()
    expect(navigated).toHaveLength(other + 1)
  })

  it('stops watching when the seat goes away, mid-settle included', async () => {
    const view = mount('a', pageEntry('reports', BLANK))
    const frame = active(view)
    if (frame?.contentWindow == null) throw new Error('the seat mounted no frame')
    // Moved, then unmounted inside the settling window: the move is dropped
    // with the watch rather than landing on a session nothing is showing.
    frame.contentWindow.location.hash = '#/mid'
    view.unmount()
    await new Promise<void>((resolve) => { setTimeout(resolve, NAVIGATION_SETTLE_MS + POLL_MS * 2) })
    expect(navigated).toEqual([])
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
    published = { a: { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] } }
    const view = mount('a', ENTRY, 3, undefined, { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 500, settleQuietMs: 5 })
    fill(view, '<main><button>Refresh</button></main>')
    await settled(1)
    const outcome = outcomes()[0]
    if (outcome?.status !== 'ok') throw new Error('the seat answered a failure')
    expect(outcome.page).toEqual({ id: 'reports', title: 'Weekly reports' })
    expect(outcome.snapshot.text).toContain('Refresh')
  })

  it('retires a frame\'s numbering when the page inside it navigates', async () => {
    published = { a: { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] } }
    const view = mount('a', ENTRY, 3, undefined, { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 500, settleQuietMs: 5 })
    const frame = fill(view, '<main><button>Refresh</button></main>')
    await settled(1)
    const before = outcomes()[0]

    // A load is what a navigation looks like from the seat, and every ref the
    // model still holds names an element of the document that just left.
    frame.dispatchEvent(new Event('load'))
    published = { a: { entries: [ENTRY], pending: [{ callId: 'call_2', tool: 'content_read', args: {} }] } }
    mount('a', ENTRY, 3, view, { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 500, settleQuietMs: 5 })
    await settled(2)
    const after = outcomes()[1]

    if (before?.status !== 'ok' || after?.status !== 'ok') throw new Error('the seat answered a failure')
    // Numbers are never reused, reset included, so the same button comes back
    // under a ref the earlier listing never mentioned.
    expect(after.snapshot.text).not.toBe(before.snapshot.text)
  })

  it('installs no reader at all where the deployment configured no page access', async () => {
    published = { a: { entries: [ENTRY], pending: [{ callId: 'call_1', tool: 'content_read', args: {} }] } }
    const view = mount('a', ENTRY)
    fill(view, '<main><button>Refresh</button></main>')
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(posted).toEqual([])
  })
})
