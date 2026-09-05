// @vitest-environment jsdom
/**
 * The page seat answering for a session the console is not showing.
 *
 * A console shows one session and holds the frames of several: switching
 * sessions hides a frame rather than unmounting it, so the document behind the
 * one on display is still mounted and still live. These cases drive the seat
 * through its props, because which page serves which session is resolved from
 * the frame cache the seat folds during render and from nowhere else.
 *
 * The frames are pointed at `about:blank`: jsdom fetches no subresources, so a
 * frame pointed at a real path stays forever loading with no document at all.
 * The real route through a real frame belongs to the browser lane.
 */
import { useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ContentFrame, type ContentFrameProps } from '../src/client/ContentFrame.tsx'
import { zh } from '../src/client/locales.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ChannelOutcome, type ClaimAck } from '../src/access/wire.ts'
import type { ContentAccessRequest, ContentPageView } from '../src/types.ts'

/** The reader's settings: deadlines short enough for a case to sit through. */
const ACCESS = {
  outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 500, settleQuietMs: 5,
  actTimeoutMs: 1000, maxSteps: 20, settleMaxMs: 20,
}

/** One session's projection values, as the seat reads them off the list. */
interface Published {
  /** That session's column entries. */
  entries?: readonly ContentSurfaceEntry[]
  /** That session's open channel calls. */
  pending?: readonly ContentAccessRequest[]
}

/** Every session row the console holds, by session id. */
let published: Record<string, Published> = {}

/** The session the console is showing. */
let current = 'a'

/**
 * A stand-in for the framework hook every root slot receives, memoizing the
 * way `useSyncExternalStoreWithSelector` does: the selection keeps its identity
 * for as long as the caller's own equality says nothing moved. The list
 * snapshot is rebuilt on every call, which is what the real store does too.
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

/** One shown page entry of some session's column. */
function pageEntry(entryId: string, title: string): ContentSurfaceEntry {
  const payload: ContentPageView = { state: 'shown', page: entryId, url: 'about:blank', title }
  return { kind: 'page', entryId, seq: 1, title, payload }
}

/** The same entry after the deployment dropped the page it names. */
function missingEntry(entry: ContentSurfaceEntry): ContentSurfaceEntry {
  return { ...entry, payload: { state: 'missing', page: entry.entryId } satisfies ContentPageView }
}

/** Every document posted to a read route, in order. */
let posted: { route: string; body: Record<string, unknown> }[] = []

/** The claim answers the stub hands out, oldest first; exhausted means "claimed". */
let claims: ClaimAck[] = []

/** Render the seat for one selection, reusing an existing tree when given one. */
function mount(
  entry: ContentSurfaceEntry | undefined,
  cacheSize = 3,
  view?: ReturnType<typeof render>,
): ReturnType<typeof render> {
  const props = {
    sessionId: current,
    entry,
    cacheSize,
    navigationPollMs: 1000,
    onNavigated: () => {},
    pageAccess: ACCESS,
    useSessions,
    t: makeTranslate(zh),
  } as unknown as ContentFrameProps
  const element = <ContentFrame {...props} />
  if (view === undefined) return render(element)
  view.rerender(element)
  return view
}

/** Put one document inside the frame of one (session, page) pair. */
function fill(view: ReturnType<typeof render>, frameId: string, html: string): void {
  const frame = view.container.querySelector<HTMLIFrameElement>(`iframe[data-content-frame-id="${frameId}"]`)
  if (frame?.contentWindow == null) throw new Error(`the seat mounted no frame for ${frameId}`)
  frame.contentWindow.document.body.innerHTML = html
}

/** The outcomes posted so far. */
function outcomes(): ChannelOutcome[] {
  return posted.filter(entry => entry.route === CONTENT_REPORT_ROUTE).map(entry => entry.body.outcome as ChannelOutcome)
}

/** The claims posted so far. */
function claimed(): Record<string, unknown>[] {
  return posted.filter(entry => entry.route === CONTENT_CLAIM_ROUTE).map(entry => entry.body)
}

/** Wait until the reader has posted one outcome. */
async function settled(): Promise<void> {
  await vi.waitFor(() => { expect(outcomes()).toHaveLength(1) }, { timeout: 3000 })
}

/** One open read of the session named. */
function readOf(callId: string): ContentAccessRequest {
  return { callId, tool: 'content_read', args: {} }
}

/** Session A's two pages, and session B's. */
const A_PAGE = pageEntry('reports', 'Weekly reports')
const A_OTHER = pageEntry('summary', 'Fleet summary')
const B_PAGE = pageEntry('dashboard', 'Fleet dashboard')

/**
 * Show session A's page, then switch the console to session B's, which is the
 * state every case here starts from: two mounted frames, one of them hidden.
 * @returns the rendered tree.
 */
function showThenSwitch(cacheSize = 3): ReturnType<typeof render> {
  published = { a: { entries: [A_PAGE] }, b: { entries: [B_PAGE] } }
  const view = mount(A_PAGE, cacheSize)
  fill(view, 'a reports', '<main><h1>Fleet A</h1></main>')
  current = 'b'
  mount(B_PAGE, cacheSize, view)
  return view
}

beforeEach(() => {
  published = {}
  current = 'a'
  posted = []
  claims = []
  vi.stubGlobal('fetch', vi.fn((route: string, init: RequestInit) => {
    posted.push({ route, body: JSON.parse(init.body as string) as Record<string, unknown> })
    const answer = route === CONTENT_CLAIM_ROUTE ? claims.shift() ?? { claimed: true } : { accepted: true }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
  }))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('the page seat serving a session the console is not showing', () => {
  it('reads the page that session last had in front, from the frame still holding it', async () => {
    const view = showThenSwitch()
    published = { a: { entries: [A_PAGE], pending: [readOf('call_1')] }, b: { entries: [B_PAGE] } }
    mount(B_PAGE, 3, view)
    await settled()
    const outcome = outcomes()[0]
    if (outcome?.status !== 'ok') throw new Error('the seat answered a failure')
    // Session A's page and session A's document, with session B on display.
    expect(outcome.page).toEqual({ id: 'reports', title: 'Weekly reports' })
    expect(outcome.snapshot.text).toContain('Fleet A')
  })

  it('keeps each session\'s read in its own frame', async () => {
    const view = showThenSwitch()
    fill(view, 'b dashboard', '<main><h1>Fleet B</h1></main>')
    published = {
      a: { entries: [A_PAGE], pending: [readOf('call_1')] },
      b: { entries: [B_PAGE], pending: [readOf('call_2')] },
    }
    mount(B_PAGE, 3, view)
    await vi.waitFor(() => { expect(outcomes()).toHaveLength(2) }, { timeout: 3000 })
    const answered = posted
      .filter(entry => entry.route === CONTENT_REPORT_ROUTE)
      .map(entry => [entry.body.callId, (entry.body.outcome as { page?: { id: string } }).page?.id])
    // One call, one column: the id the host published is what decides which
    // frame answers, so neither read reaches the other session's document.
    expect(new Map(answered as [string, string][]))
      .toEqual(new Map([['call_1', 'reports'], ['call_2', 'dashboard']]))
  })

  it('bids for nothing on a session whose page this seat never showed', async () => {
    published = { a: { entries: [A_PAGE] }, b: { entries: [B_PAGE], pending: [readOf('call_1')] } }
    current = 'a'
    const view = mount(A_PAGE)
    fill(view, 'a reports', '<main><h1>Fleet A</h1></main>')
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    // The host's claim window is what answers this, and it says no console tab
    // is showing that session's column — which is the truth here.
    expect(posted).toEqual([])
  })

  it('bids for nothing on a session whose frame has been evicted', async () => {
    // One frame at a time: showing session B destroyed session A's.
    const view = showThenSwitch(1)
    published = { a: { entries: [A_PAGE], pending: [readOf('call_1')] }, b: { entries: [B_PAGE] } }
    mount(B_PAGE, 1, view)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(posted).toEqual([])
  })

  it('bids for nothing on a session whose entry no longer names a shown page', async () => {
    const view = showThenSwitch()
    published = { a: { entries: [missingEntry(A_PAGE)], pending: [readOf('call_1')] }, b: { entries: [B_PAGE] } }
    mount(B_PAGE, 3, view)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(posted).toEqual([])
  })

  it('falls back to the older page it still holds when the newest one is gone from the column', async () => {
    // Two pages of session A are cached and the newer one is dismissed while
    // the console is on session B. The older document is mounted and readable,
    // so the read runs there rather than the session going unanswerable.
    published = { a: { entries: [A_PAGE, A_OTHER] }, b: { entries: [B_PAGE] } }
    const view = mount(A_PAGE)
    fill(view, 'a reports', '<main><h1>Fleet A</h1></main>')
    mount(A_OTHER, 3, view)
    fill(view, 'a summary', '<main><h1>Fleet summary</h1></main>')
    current = 'b'
    mount(B_PAGE, 3, view)

    published = { a: { entries: [A_PAGE], pending: [readOf('call_1')] }, b: { entries: [B_PAGE] } }
    mount(B_PAGE, 3, view)
    await settled()
    const outcome = outcomes()[0]
    if (outcome?.status !== 'ok') throw new Error('the seat answered a failure')
    expect(outcome.page).toEqual({ id: 'reports', title: 'Weekly reports' })
    expect(outcome.snapshot.text).toContain('Fleet A')
  })

  it('answers nothing more for a list notification that moved neither column', async () => {
    // The session store rebuilds its whole snapshot on every notification, for
    // any session and any reason. A refused bid leaves the call takeable again,
    // so a re-render that carries the same two views must not become a bid: the
    // selection compares the views, not the snapshot.
    const view = showThenSwitch()
    published = { a: { entries: [A_PAGE], pending: [readOf('call_1')] }, b: { entries: [B_PAGE] } }
    // Both bids are refused, so this case ends where it began: no read runs.
    claims = [{ claimed: false, reason: 'settled' }, { claimed: false, reason: 'settled' }]
    mount(B_PAGE, 3, view)
    await vi.waitFor(() => { expect(claimed()).toHaveLength(1) }, { timeout: 3000 })

    mount(B_PAGE, 3, view)
    mount(B_PAGE, 3, view)
    await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    expect(claimed()).toHaveLength(1)

    // And the same seat does bid again the moment a view actually moves.
    published = { a: { entries: [A_PAGE], pending: [readOf('call_2')] }, b: { entries: [B_PAGE] } }
    mount(B_PAGE, 3, view)
    await vi.waitFor(() => { expect(claimed()).toHaveLength(2) }, { timeout: 3000 })
  })

  it('reads nothing for a session whose column the host has published nothing of', async () => {
    // A session's row reaches the list before either of its projection values
    // does. That is a column with nothing in it — no entries, no open calls —
    // rather than a session the seat leaves off, because it is the session the
    // console is showing and the column may fill in at any frame.
    published = { a: {} }
    const view = mount(undefined)
    expect(view.container.querySelector('iframe')).toBeNull()
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(posted).toEqual([])
  })

  it('refuses steps agreed on another entry of that session', async () => {
    // The guard the whole arrangement rests on: the approval names the entry
    // the user was reading the request against, and a session behind the one on
    // display can have moved since. It is compared against that session's own
    // page, not the console's.
    const view = showThenSwitch()
    claims = [{ claimed: true, page: { id: 'summary', title: '汇总' } }]
    published = {
      a: {
        entries: [A_PAGE],
        pending: [{
          callId: 'call_1',
          tool: 'content_act',
          args: { steps: [{ action: 'click', ref: 'e1', label: '查询' }] },
        }],
      },
      b: { entries: [B_PAGE] },
    }
    mount(B_PAGE, 3, view)
    await settled()
    expect(outcomes()[0]).toMatchObject({ status: 'error', code: 'front-changed' })
  })
})
