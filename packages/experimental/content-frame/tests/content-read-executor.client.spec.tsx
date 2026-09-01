// @vitest-environment jsdom
/**
 * The reading half in the seat: when it claims, what it reports, and when it
 * stays out of the way.
 *
 * jsdom is the whole reason the reader's layout is injected: it implements no
 * `checkVisibility` and no layout at all, so the two injected functions are
 * exercised directly here and the walk itself runs against a real document
 * inside a real (if layout-less) frame. What jsdom cannot show — a frame that
 * really navigates, a real second document — belongs to the browser lane.
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import {
  isClickable, isVisible, rectOf, TAB_ID, useContentRead, type ContentReadSeat,
} from '../src/client/access/executor.ts'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ClaimAck, type ReadOutcome } from '../src/access/wire.ts'
import type { RefTable } from '../src/client/access/refs.ts'
import type { ContentReadRequest } from '../src/types.ts'

/** The frame id every case here reads through. */
const FRAME = 'session_1 home'

/**
 * The reader's settings. Both deadlines are short enough for a test to sit
 * through and long enough to hold several claim retries, which is the interval
 * the reader gives up inside rather than crossing.
 */
const ACCESS = { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 1000 }

/** One open call. */
const READ: ContentReadRequest = { callId: 'call_1', tool: 'content_read', args: {} }

/** One page entry as the column resolves it. */
const PAGE_ENTRY: ContentSurfaceEntry = {
  kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: { state: 'shown' },
}

/** One entry of another kind. */
function otherEntry(entryId: string, title: string): ContentSurfaceEntry {
  return { kind: 'chart', entryId, seq: 2, title, payload: {} }
}

/** Every document posted to a read route, in order. */
let posted: { route: string; body: Record<string, unknown> }[] = []

/** The claim answers the stub hands out, oldest first; exhausted means "claimed". */
let claims: ClaimAck[] = []

/** What becomes of one posted document: answered, refused, or never landing. */
type Fate = 'ok' | 'refuses' | 'unreachable'

/** Fates the stub gives a route's next posts, oldest first; past them {@link network} stands. */
let fates: Map<string, Fate[]>

/** The fate every post gets once its route's queue is empty. */
let network: Fate = 'ok'

/** Answer the two read routes the way the node half does. */
function stubRoutes(): void {
  vi.stubGlobal('fetch', vi.fn((route: string, init: RequestInit) => {
    posted.push({ route, body: JSON.parse(init.body as string) as Record<string, unknown> })
    const fate = fates.get(route)?.shift() ?? network
    if (fate === 'unreachable') return Promise.reject(new Error('offline'))
    if (fate === 'refuses') return Promise.resolve({ ok: false, status: 503 })
    const answer = route === CONTENT_CLAIM_ROUTE ? claims.shift() ?? { claimed: true } : { accepted: true }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
  }))
}

/** The claims and the reports posted so far. */
function of(route: string): Record<string, unknown>[] {
  return posted.filter(entry => entry.route === route).map(entry => entry.body)
}

/** The outcome of the first posted report. */
function reported(): ReadOutcome {
  return of(CONTENT_REPORT_ROUTE)[0]?.outcome as ReadOutcome
}

/** A mounted frame holding one document. */
function mountFrame(html: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  const view = frame.contentWindow
  if (view === null) throw new Error('jsdom gave the mounted frame no window')
  view.document.body.innerHTML = html
  return frame
}

/** Build one seat over the given frames and entries. */
function seatOf(overrides: Partial<ContentReadSeat> = {}): ContentReadSeat {
  return {
    entries: [PAGE_ENTRY],
    pending: [READ],
    page: { id: 'home', title: 'Home' },
    activeFrameId: FRAME,
    frames: { current: new Map<string, HTMLIFrameElement>() },
    tables: { current: new Map<string, RefTable>() },
    access: ACCESS,
    tabId: TAB_ID,
    ...overrides,
  }
}

/** Mount the reader over one seat. */
function Probe({ seat }: { seat: ContentReadSeat }) {
  useContentRead(seat)
  return null
}

/** Render the reader, reusing an existing tree when given one. */
function drive(seat: ContentReadSeat, view?: ReturnType<typeof render>): ReturnType<typeof render> {
  const element = <Probe seat={seat} />
  if (view === undefined) return render(element)
  view.rerender(element)
  return view
}

/** Wait until one report has been posted. */
async function settled(): Promise<void> {
  await vi.waitFor(() => { expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(1) }, { timeout: 3000 })
}

/** Set the tab's visibility the way the browser does. */
function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true })
}

beforeEach(() => {
  posted = []
  claims = []
  fates = new Map<string, Fate[]>()
  network = 'ok'
  setVisibility('visible')
  stubRoutes()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the injected layout the reader runs on', () => {
  it('asks the browser itself where there is an answer, and walks the ancestors where there is not', () => {
    const frame = mountFrame('<div id="host"><span id="leaf">text</span></div>')
    const doc = frame.contentWindow?.document
    const leaf = doc?.getElementById('leaf')
    if (leaf === null || leaf === undefined) throw new Error('the fixture lost its element')
    // jsdom implements no `checkVisibility`, so this exercises the walk.
    expect(isVisible(leaf)).toBe(true)
    const host = doc?.getElementById('host')
    host?.setAttribute('style', 'display: none')
    expect(isVisible(leaf)).toBe(false)
    host?.setAttribute('style', 'visibility: hidden')
    expect(isVisible(leaf)).toBe(false)

    // A DOM implementation that does answer is believed instead of walked: the
    // browser's own answer covers content-visibility, which no walk can see.
    Object.defineProperty(leaf, 'checkVisibility', { value: () => true, configurable: true })
    expect(isVisible(leaf)).toBe(true)
  })

  it('measures and classifies an element through its own frame\'s window', () => {
    const frame = mountFrame('<button id="go" style="cursor: pointer">Go</button><span id="plain">x</span>')
    const doc = frame.contentWindow?.document
    const go = doc?.getElementById('go')
    const plain = doc?.getElementById('plain')
    if (go === null || go === undefined || plain === null || plain === undefined) {
      throw new Error('the fixture lost its elements')
    }
    expect(isClickable(go)).toBe(true)
    expect(isClickable(plain)).toBe(false)
    // The frame's own rectangle class, not the top window's, which is the
    // point: the geometry belongs to the frame the element lives in.
    expect(rectOf(go)).toMatchObject({ width: 0, height: 0 })
  })
})

describe('when the reader claims', () => {
  it('claims nothing while the tab is hidden, and catches up when it comes back', async () => {
    setVisibility('hidden')
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
    const seat = seatOf({ frames: { current: frames } })
    drive(seat)
    await Promise.resolve()
    expect(posted).toEqual([])

    setVisibility('visible')
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await settled()
    expect(of(CONTENT_CLAIM_ROUTE)).toEqual([{ callId: 'call_1', tabId: TAB_ID }])
  })

  it('claims each open call once, however often the seat re-renders', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
    const seat = seatOf({ frames: { current: frames } })
    const view = drive(seat)
    // A fresh list carrying the same call, which is what every later projection
    // frame looks like until the result lands.
    drive({ ...seat, pending: [{ ...READ }] }, view)
    await settled()
    expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(1)
  })

  it('stops bidding at the host\'s claim window, not at its report deadline', async () => {
    // Never granted, so only a deadline can end the bidding — and the report
    // deadline below would allow about twenty-five bids where the claim window
    // allows a handful.
    claims = Array.from({ length: 40 }, () => ({ claimed: false, reason: 'unknown' as const }))
    const view = drive(seatOf({ access: { outlineChars: 4000, claimTimeoutMs: 250, readTimeoutMs: 5000 } }))
    await new Promise<void>((resolve) => { setTimeout(resolve, 900) })
    const bids = of(CONTENT_CLAIM_ROUTE).length
    await new Promise<void>((resolve) => { setTimeout(resolve, 500) })
    expect({ bids, later: of(CONTENT_CLAIM_ROUTE).length }).toEqual({ bids, later: bids })
    expect(bids).toBeGreaterThanOrEqual(3)
    expect(bids).toBeLessThanOrEqual(5)
    expect(of(CONTENT_REPORT_ROUTE)).toEqual([])
    view.unmount()
  })

  it('tries again while the host does not know the call yet', async () => {
    claims = [{ claimed: false, reason: 'unknown' }]
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
    drive(seatOf({ frames: { current: frames } }))
    await settled()
    expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(2)
  })

  it('stops trying when the call settles under it', async () => {
    claims = [{ claimed: false, reason: 'unknown' }, { claimed: false, reason: 'unknown' }]
    const seat = seatOf()
    const view = drive(seat)
    await vi.waitFor(() => { expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(1) })
    drive({ ...seat, pending: [] }, view)
    await new Promise<void>((resolve) => { setTimeout(resolve, 400) })
    expect(of(CONTENT_REPORT_ROUTE)).toEqual([])
  })

  it('reads nothing for a call another tab took, or one already answered', async () => {
    for (const reason of ['taken', 'settled'] as const) {
      posted = []
      claims = [{ claimed: false, reason }]
      const view = drive(seatOf())
      await vi.waitFor(() => { expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(1) })
      await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
      expect({ reason, reports: of(CONTENT_REPORT_ROUTE) }).toEqual({ reason, reports: [] })
      view.unmount()
    }
  })

  it('bids again after a claim that never landed, rather than losing the read to one of them', async () => {
    for (const fate of ['refuses', 'unreachable'] as const) {
      posted = []
      fates.set(CONTENT_CLAIM_ROUTE, [fate])
      const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
      const view = drive(seatOf({ frames: { current: frames } }))
      await settled()
      // The console is in front of the user the whole time; one dropped request
      // must not be what tells the model there is no console at all.
      expect({ fate, bids: of(CONTENT_CLAIM_ROUTE).length }).toEqual({ fate, bids: 2 })
      view.unmount()
    }
  })

  it('keeps bidding while the claim never lands, and answers nothing when it never does', async () => {
    for (const state of ['refuses', 'unreachable'] as const) {
      posted = []
      network = state
      const view = drive(seatOf({ access: { outlineChars: 4000, claimTimeoutMs: 50, readTimeoutMs: 500 } }))
      await vi.waitFor(() => { expect(of(CONTENT_CLAIM_ROUTE).length).toBeGreaterThanOrEqual(2) }, { timeout: 3000 })
      await new Promise<void>((resolve) => { setTimeout(resolve, 600) })
      expect({ state, reports: of(CONTENT_REPORT_ROUTE) }).toEqual({ state, reports: [] })
      view.unmount()
    }
  })

  it('forgets a call once it has left the pending list', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
    const seat = seatOf({ frames: { current: frames } })
    const view = drive(seat)
    await settled()
    // The result reached the log, so the host stopped publishing the call.
    drive({ ...seat, pending: [] }, view)
    posted = []
    // No agent loop reuses a live call id; the same id arriving again is how a
    // test can see whether the seat still remembers having answered it.
    drive({ ...seat, pending: [{ ...READ }] }, view)
    await settled()
    expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(1)
  })

  it('installs nothing at all where the deployment configured no page access', async () => {
    drive(seatOf({ access: undefined }))
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    expect(posted).toEqual([])
  })
})

describe('what the reader reports', () => {
  it('reports the listing it read, naming the page the column had in front', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1><button>Refresh</button></main>')]])
    drive(seatOf({ frames: { current: frames } }))
    await settled()
    const outcome = reported()
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect(outcome.page).toEqual({ id: 'home', title: 'Home' })
    expect(outcome.snapshot.kind).toBe('outline')
    expect(outcome.snapshot.signIn).toBe(false)
    expect(outcome.snapshot.text).toContain('Refresh')
    expect(of(CONTENT_REPORT_ROUTE)[0]).toMatchObject({ callId: 'call_1', tabId: TAB_ID })
  })

  it('posts the read a second time when the first report never landed, and no third', async () => {
    fates.set(CONTENT_REPORT_ROUTE, ['refuses'])
    const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
    drive(seatOf({ frames: { current: frames } }))
    await vi.waitFor(() => { expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(2) }, { timeout: 3000 })
    expect(of(CONTENT_REPORT_ROUTE)[1]).toEqual(of(CONTENT_REPORT_ROUTE)[0])
    // Past one retry the host's own deadline owns the ending; the seat does not
    // sit on a call the host has already answered.
    await new Promise<void>((resolve) => { setTimeout(resolve, 400) })
    expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(2)
  })

  it('keeps one numbering per frame, so a ref survives the read that minted it', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><button>Refresh</button></main>')]])
    const tables = { current: new Map<string, RefTable>() }
    const seat = seatOf({
      frames: { current: frames },
      tables,
    })
    const view = drive(seat)
    await settled()
    const first = reported()
    posted = []
    drive({ ...seat, pending: [{ ...READ, callId: 'call_2' }] }, view)
    await settled()
    const second = reported()
    if (first.status !== 'ok' || second.status !== 'ok') throw new Error('the reader answered a failure')
    expect(second.snapshot.text).toBe(first.snapshot.text)
    expect(tables.current.size).toBe(1)
  })

  it('says the column is empty when the session has produced nothing', async () => {
    drive(seatOf({ entries: [], page: undefined, activeFrameId: undefined }))
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'empty' })
  })

  it('names the entry in front when exactly one other kind could be it', async () => {
    drive(seatOf({
      entries: [otherEntry('revenue', 'Revenue'), PAGE_ENTRY],
      page: undefined,
      activeFrameId: undefined,
    }))
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'not-a-page', kind: 'chart', title: 'Revenue' })
  })

  it('leaves the entry unnamed when the column holds several of another kind', async () => {
    drive(seatOf({
      entries: [otherEntry('revenue', 'Revenue'), otherEntry('traffic', 'Traffic')],
      page: undefined,
      activeFrameId: undefined,
    }))
    await settled()
    const outcome = reported()
    expect(outcome).toMatchObject({ status: 'error', code: 'not-a-page' })
    expect(Object.hasOwn(outcome, 'kind')).toBe(false)
  })

  it('says there is nothing to read when the page in front left the deployment', async () => {
    drive(seatOf({ activeFrameId: undefined }))
    await settled()
    expect(reported()).toEqual({
      status: 'error',
      code: 'frame',
      message: 'The page in front is no longer in this deployment\'s page list, so there is nothing to read. '
        + 'Call content_show to put a page in front.',
    })
  })

  it('says the frame could not be reached when the seat holds no live document for it', async () => {
    const detached = document.createElement('iframe')
    for (const frames of [new Map<string, HTMLIFrameElement>(), new Map([[FRAME, detached]])]) {
      posted = []
      const view = drive(seatOf({ frames: { current: frames } }))
      await settled()
      expect(reported()).toMatchObject({
        status: 'error',
        code: 'frame',
        message: 'The content column\'s frame could not be read from the console; '
          + 'ask the user to reload the console, then retry.',
      })
      view.unmount()
    }
  })

  it('waits for a page that is still loading, and reads it once it is', async () => {
    const frame = mountFrame('<main><button>Refresh</button></main>')
    const doc = frame.contentWindow?.document
    Object.defineProperty(doc, 'readyState', { value: 'loading', configurable: true })
    const frames = new Map([[FRAME, frame]])
    drive(seatOf({ frames: { current: frames } }))
    // The listener is attached only once the claim round trip has come back,
    // so the event is re-sent until the read it releases has been posted.
    await vi.waitFor(() => {
      frame.dispatchEvent(new Event('load'))
      expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(1)
    }, { timeout: 3000 })
    expect(reported().status).toBe('ok')
  })

  it('gives up on a page that never finishes loading while the host is still listening', async () => {
    const frame = mountFrame('<main><button>Refresh</button></main>')
    Object.defineProperty(frame.contentWindow?.document, 'readyState', { value: 'loading', configurable: true })
    const frames = new Map([[FRAME, frame]])
    const access = { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 400 }
    const opened = Date.now()
    drive(seatOf({ frames: { current: frames }, access }))
    await settled()
    expect(reported()).toEqual({
      status: 'error',
      code: 'frame',
      message: 'The page in the content column had not finished loading; retry once.',
    })
    // The host started its report deadline when it granted the claim, so a seat
    // that spent all of it waiting would post into a call that had already
    // given up and this message would never reach the model.
    expect(Date.now() - opened).toBeLessThan(access.readTimeoutMs)
  })

  it('passes the reader\'s own refusal through untouched', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><button>Refresh</button></main>')]])
    drive(seatOf({
      frames: { current: frames },
      pending: [{ callId: 'call_1', tool: 'content_read', args: { scope: 'e99' } }],
    }))
    await settled()
    const outcome = reported()
    expect(outcome).toMatchObject({ status: 'error', code: 'engine' })
    // The reader owns its wording; this asserts only that it survived the trip.
    expect(outcome.status === 'error' && outcome.message.length).toBeGreaterThan(0)
  })

  it('passes every argument the call carried down to the reader', async () => {
    const frames = new Map([[FRAME, mountFrame('<main><button>Refresh</button><span>Ada</span></main>')]])
    drive(seatOf({
      frames: { current: frames },
      pending: [{ callId: 'call_1', tool: 'content_read', args: { mode: 'map', after: 'e99', find: 'Ada' } }],
    }))
    await settled()
    // Every one of them reaches a reader that refuses this combination, which
    // is exactly what proves they were all passed down.
    expect(reported()).toMatchObject({ status: 'error', code: 'engine' })
  })

  it('carries the page\'s trail, its open dialog, and the cursor of a listing it had to cut', async () => {
    const frames = new Map([[FRAME, mountFrame(
      '<nav class="breadcrumb">Home / Fleet</nav>'
      + '<dialog open aria-modal="true" aria-label="Confirm delete"><button>Delete</button></dialog>'
      + '<main><button>Refresh one</button><button>Refresh two</button><button>Refresh three</button></main>',
    )]])
    drive(seatOf({
      frames: { current: frames },
      // A budget one listing cannot fit, so the read is cut and names where to
      // continue from rather than stopping silently.
      access: { outlineChars: 30, claimTimeoutMs: 300, readTimeoutMs: 500 },
      pending: [{ callId: 'call_1', tool: 'content_read', args: { find: 'Refresh' } }],
    }))
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect(outcome.snapshot.breadcrumb).toContain('Home')
    expect(outcome.snapshot.modal).toContain('Confirm delete')
    expect(outcome.snapshot.truncated).toBe(true)
    expect(outcome.snapshot.cursor).toMatch(/^e\d+$/)
  })
})
