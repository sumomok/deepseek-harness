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
import {
  CLAIM_RETRY_MS, CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, LOAD_WAIT_SHARE, MAX_HEADER_CHARS,
  MAX_TEXT_BUDGET_MULTIPLE, MAX_TEXT_BYTES_PER_CHAR, MAX_URL_CHARS, MIN_OUTLINE_CHARS, parseReportRequest,
  PREFERRED_TAB_WINDOW_MS, ROUTE_REFUSAL_STATUSES, type ClaimAck, type ReadOutcome,
} from '../src/access/wire.ts'
import { FRAME_WIDE_LISTING_MESSAGE } from '../src/access/text.ts'
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

/** Every document posted to a read route, in order, decoded and as it went on the wire. */
let posted: { route: string; body: Record<string, unknown>; raw: string }[] = []

/** The claim answers the stub hands out, oldest first; exhausted means "claimed". */
let claims: ClaimAck[] = []

/** How long past a window a case waits before reading a count off it. */
const SETTLE_MARGIN_MS = 200

/**
 * What becomes of one posted document: taken, never delivered, or answered with
 * a status. A status in {@link ROUTE_REFUSAL_STATUSES} is the route answering
 * this exact document, which a second post would not change; every other one
 * came from between the seat and the route and says nothing about it.
 */
type Fate = 'ok' | 'unreachable' | number

/** A server failure, which says nothing about the document the seat posted. */
const SERVER_FAILURE = 503

/** What a reverse proxy answers with while it refreshes a token of its own. */
const TOKEN_REFRESH = 401

/** What a rate limiter in front of the host answers with. */
const RATE_LIMITED = 429

/** Fates the stub gives a route's next posts, oldest first; past them {@link network} stands. */
let fates: Map<string, Fate[]>

/** The fate every post gets once its route's queue is empty. */
let network: Fate = 'ok'

/** Answer the two read routes the way the node half does. */
function stubRoutes(): void {
  vi.stubGlobal('fetch', vi.fn((route: string, init: RequestInit) => {
    const raw = init.body as string
    posted.push({ route, body: JSON.parse(raw) as Record<string, unknown>, raw })
    const fate = fates.get(route)?.shift() ?? network
    if (fate === 'unreachable') return Promise.reject(new Error('offline'))
    if (fate !== 'ok') return Promise.resolve({ ok: false, status: fate })
    const answer = route === CONTENT_CLAIM_ROUTE ? claims.shift() ?? { claimed: true } : { accepted: true }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(answer) })
  }))
}

/** One C0 control a page can hold: six JSON bytes per unit where the wire's byte bound allows four. */
const CONTROL = String.fromCharCode(1)

/** The listing budget a deployment gets by writing `pageAccess: {}`, which is where a real page meets these bounds. */
const DEFAULT_OUTLINE_CHARS = 12000

/** What one string costs inside a posted report, written out rather than imported from the seat it checks. */
function jsonBytesOf(value: string): number {
  return new TextEncoder().encode(JSON.stringify(value)).length - 2
}

/**
 * The JSON a report of this suite's seat carries around its listing: the two
 * ids, the page, the header fields of a document at `about:blank`, the two
 * counters and the punctuation. Written out because every body size below is
 * this plus its listing.
 */
const SEAT_ENVELOPE_BYTES = 252

/**
 * The envelope the route allows a report, which no deployment configures: four
 * bytes for each character of a `url` (2048), three header fields (200 each), a
 * failure message (2000), four names (256 each) and a cursor (32), plus 512 for
 * the punctuation and key names. Written out rather than imported, so a bound
 * moving under it is a failure here and not a silent agreement.
 */
const ENVELOPE_BYTES = 23328

/** What the seat's first report cost on the wire, which is the total the route counts. */
function reportedBytes(): number {
  const first = posted.find(entry => entry.route === CONTENT_REPORT_ROUTE)
  if (first === undefined) throw new Error('the seat posted no report')
  return new TextEncoder().encode(first.raw).length
}

/**
 * One table wide enough that its block is the whole listing: `find` names the
 * table by a word no cell carries, and the renderer prints that block however
 * long it is. Each cell and the pagination line are cut to 200 characters where
 * they run past it, so a column is worth a fixed number of characters and the
 * pagination line is where a fixture tunes its last bytes.
 * @param columns - how many columns the table has.
 * @param fill - the character its name and cells are made of.
 * @param pagination - the pagination line, as the page has it.
 * @returns the page's HTML.
 */
function wideTable(columns: number, fill: string, pagination: string): string {
  const cell = (tag: string): string => `<${tag}>${fill.repeat(300)}</${tag}>`
  const cells = (tag: string): string => Array.from({ length: columns }, () => cell(tag)).join('')
  return `<table aria-label="FLEET${fill.repeat(295)}">`
    + `<thead><tr>${cells('th')}</tr></thead><tbody><tr>${cells('td')}</tr></tbody></table>`
    + `<nav class="pagination">${pagination}</nav>`
}

/** Drive one read of {@link wideTable} under a budget, filtered to the table alone. */
function readTable(html: string, outlineChars: number): ReturnType<typeof drive> {
  return drive(seatOf({
    frames: { current: new Map([[FRAME, mountFrame(html)]]) },
    access: { outlineChars, claimTimeoutMs: 300, readTimeoutMs: 1000 },
    pending: [{ callId: 'call_1', tool: 'content_read', args: { find: 'FLEET' } }],
  }))
}

/** A surrogate with no partner, which costs the same and is not a character at all. */
const LONE_SURROGATE = String.fromCharCode(0xd800)

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
    // deadline below is twenty times the claim window, which would allow many
    // times as many bids.
    claims = Array.from({ length: 40 }, () => ({ claimed: false, reason: 'unknown' as const }))
    const access = { outlineChars: 4000, claimTimeoutMs: 250, readTimeoutMs: 5000 }
    // One bid at once, then one more every interval while another still fits
    // inside the claim window, the preferred tab's hold, and one last interval.
    const expected = Math.floor((access.claimTimeoutMs + PREFERRED_TAB_WINDOW_MS) / CLAIM_RETRY_MS) + 2
    // The last bid can be sent one interval before the window closes, so the
    // count is read past the window itself, with room for the scheduler.
    const bidding = access.claimTimeoutMs + PREFERRED_TAB_WINDOW_MS + CLAIM_RETRY_MS + SETTLE_MARGIN_MS
    const view = drive(seatOf({ access }))
    await new Promise<void>((resolve) => { setTimeout(resolve, bidding) })
    const bids = of(CONTENT_CLAIM_ROUTE).length
    await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_RETRY_MS * 2 + SETTLE_MARGIN_MS) })
    expect({ bids, later: of(CONTENT_CLAIM_ROUTE).length }).toEqual({ bids, later: bids })
    // One either way for the scheduler; a bidding loop bounded by the report
    // deadline instead would be far outside this window.
    expect(bids).toBeGreaterThanOrEqual(expected - 1)
    expect(bids).toBeLessThanOrEqual(expected + 1)
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
    for (const fate of [SERVER_FAILURE, 'unreachable', TOKEN_REFRESH, RATE_LIMITED] as const) {
      posted = []
      fates.set(CONTENT_CLAIM_ROUTE, [fate])
      const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
      const view = drive(seatOf({ frames: { current: frames } }))
      await settled()
      // The console is in front of the user the whole time; neither one dropped
      // request nor one answer from something in front of the route may be what
      // tells the model there is no console at all.
      expect({ fate, bids: of(CONTENT_CLAIM_ROUTE).length }).toEqual({ fate, bids: 2 })
      view.unmount()
    }
  })

  it('keeps bidding while the claim never lands, and answers nothing when it never does', async () => {
    for (const state of [SERVER_FAILURE, 'unreachable'] as const) {
      posted = []
      network = state
      const view = drive(seatOf({ access: { outlineChars: 4000, claimTimeoutMs: 50, readTimeoutMs: 500 } }))
      await vi.waitFor(() => { expect(of(CONTENT_CLAIM_ROUTE).length).toBeGreaterThanOrEqual(2) }, { timeout: 3000 })
      await new Promise<void>((resolve) => { setTimeout(resolve, 600) })
      expect({ state, reports: of(CONTENT_REPORT_ROUTE) }).toEqual({ state, reports: [] })
      view.unmount()
    }
  })

  it('stops bidding once the route has refused the bid itself', async () => {
    // Every status the routes themselves refuse a document with, rather than
    // one of them: what ends the bidding is the set, and a status outside it
    // leaves the seat bidding.
    for (const status of ROUTE_REFUSAL_STATUSES) {
      posted = []
      fates.set(CONTENT_CLAIM_ROUTE, [status])
      const view = drive(seatOf())
      await vi.waitFor(() => { expect(of(CONTENT_CLAIM_ROUTE)).toHaveLength(1) })
      // A refusal is the route answering this exact bid; bidding again with the
      // same body would spend the whole claim window on the same answer.
      await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_RETRY_MS + SETTLE_MARGIN_MS) })
      expect({ status, bids: of(CONTENT_CLAIM_ROUTE).length, reports: of(CONTENT_REPORT_ROUTE) })
        .toEqual({ status, bids: 1, reports: [] })
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
    // A server failure and a rate limiter's answer alike: neither has read the
    // document, so neither is the route deciding about it.
    for (const fate of [SERVER_FAILURE, 'unreachable', RATE_LIMITED] as const) {
      posted = []
      fates.set(CONTENT_REPORT_ROUTE, [fate])
      const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
      const view = drive(seatOf({ frames: { current: frames } }))
      await vi.waitFor(() => { expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(2) }, { timeout: 3000 })
      expect(of(CONTENT_REPORT_ROUTE)[1]).toEqual(of(CONTENT_REPORT_ROUTE)[0])
      // Past one retry the host's own deadline owns the ending; the seat does
      // not sit on a call the host has already answered.
      await new Promise<void>((resolve) => { setTimeout(resolve, 400) })
      expect({ fate, posts: of(CONTENT_REPORT_ROUTE).length }).toEqual({ fate, posts: 2 })
      view.unmount()
    }
  })

  it('does not post a report the route refused a second time', async () => {
    for (const status of ROUTE_REFUSAL_STATUSES) {
      posted = []
      fates.set(CONTENT_REPORT_ROUTE, [status])
      const frames = new Map([[FRAME, mountFrame('<main><h1>Fleet</h1></main>')]])
      const view = drive(seatOf({ frames: { current: frames } }))
      await settled()
      // The route answered this exact document; the second post would carry it
      // to the same check, and the host's own deadline is what ends the call.
      await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_RETRY_MS + SETTLE_MARGIN_MS) })
      expect({ status, posts: of(CONTENT_REPORT_ROUTE).length }).toEqual({ status, posts: 1 })
      view.unmount()
    }
  })

  it('cuts a page-supplied title and address to the lengths the wire takes', async () => {
    const frame = mountFrame('<main><h1>Fleet</h1></main>')
    const doc = frame.contentWindow?.document
    if (doc === null || doc === undefined) throw new Error('jsdom gave the mounted frame no document')
    doc.title = 'T'.repeat(6000)
    Object.defineProperty(doc, 'URL', { value: `http://x/${'u'.repeat(6000)}`, configurable: true })
    drive(seatOf({ frames: { current: new Map([[FRAME, frame]]) } }))
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    // Cut rather than posted whole: the wire refuses a longer one, and a
    // refused report reaches the model as a console that never answered.
    expect({ title: outcome.snapshot.title.length, url: outcome.snapshot.url.length })
      .toEqual({ title: MAX_HEADER_CHARS, url: MAX_URL_CHARS })
    expect([outcome.snapshot.title.endsWith('…'), outcome.snapshot.url.endsWith('…')]).toEqual([true, true])
  })

  it('posts a listing the parser takes even when its first row runs past the smallest budget', async () => {
    // The renderer prints a listing's first row however long it is, so the
    // smallest budget a deployment may configure is where that row comes
    // closest to the character bound the parser holds a listing to.
    const cell = (tag: string, seed: string): string => `<${tag}>${seed.repeat(300)}</${tag}>`
    const cells = (tag: string): string =>
      Array.from({ length: 8 }, (_, column) => cell(tag, `c${String(column)}`)).join('')
    const frame = mountFrame(
      `<table aria-label="${'N'.repeat(300)}">`
      + `<thead><tr>${cells('th')}</tr></thead><tbody><tr>${cells('td')}</tr></tbody></table>`
      + `<nav class="pagination">${'P'.repeat(300)}</nav>`,
    )
    drive(seatOf({
      frames: { current: new Map([[FRAME, frame]]) },
      access: { outlineChars: MIN_OUTLINE_CHARS, claimTimeoutMs: 300, readTimeoutMs: 1000 },
      // The whole-page read answers with the map instead; a filtered one is
      // where an over-long row actually reaches the model.
      pending: [{ callId: 'call_1', tool: 'content_read', args: { find: 'NNN' } }],
    }))
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect(outcome.snapshot.text.length).toBeGreaterThan(MIN_OUTLINE_CHARS)
    // And the host takes it: the character bound is four times the budget, and
    // the floor on the budget is what keeps that row inside it.
    expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], MIN_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE))
      .toBeDefined()
  })

  it('cuts a title between characters rather than through one', async () => {
    const frame = mountFrame('<main><h1>Fleet</h1></main>')
    const doc = frame.contentWindow?.document
    if (doc === null || doc === undefined) throw new Error('jsdom gave the mounted frame no document')
    // The cut lands inside the first supplementary character, whose leading
    // half alone is not a string the wire carries.
    doc.title = 'a'.repeat(MAX_HEADER_CHARS - 2) + String.fromCodePoint(0x1f600).repeat(10)
    drive(seatOf({ frames: { current: new Map([[FRAME, frame]]) } }))
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    const title = outcome.snapshot.title
    expect({ inside: title.length <= MAX_HEADER_CHARS, cut: title.endsWith('…'), whole: title.isWellFormed() })
      .toEqual({ inside: true, cut: true, whole: true })
  })

  it('posts a page\'s own text without the code points the wire refuses', async () => {
    const frame = mountFrame('<main><h1 id="head"></h1></main>')
    const doc = frame.contentWindow?.document
    const head = doc?.getElementById('head')
    if (doc === null || doc === undefined || head === null || head === undefined) {
      throw new Error('the fixture lost its document')
    }
    // Appended as a text node: an `innerHTML` parse would replace them first.
    head.append(doc.createTextNode(`Fleet${CONTROL}${LONE_SURROGATE} status`))
    doc.title = `Console${CONTROL}`
    Object.defineProperty(doc, 'URL', { value: `http://x/${LONE_SURROGATE}fleet`, configurable: true })
    drive(seatOf({ frames: { current: new Map([[FRAME, frame]]) } }))
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    // The document really holds them, so what removed them is the seat.
    expect(doc.body.textContent).toContain(CONTROL)
    expect(outcome.snapshot.text).toContain('Fleet status')
    for (const [field, value] of Object.entries({
      text: outcome.snapshot.text, title: outcome.snapshot.title, url: outcome.snapshot.url,
    })) {
      expect({ field, control: value.includes(CONTROL), whole: value.isWellFormed() })
        .toEqual({ field, control: false, whole: true })
    }
    expect({ title: outcome.snapshot.title, url: outcome.snapshot.url })
      .toEqual({ title: 'Console', url: 'http://x/fleet' })
    // And the whole document is one the route takes.
    expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], ACCESS.outlineChars * MAX_TEXT_BUDGET_MULTIPLE))
      .toBeDefined()
  })

  it('says a listing is too wide instead of posting one the route would refuse', async () => {
    // Wider than the eight columns the smallest budget's character bound holds:
    // the renderer prints this block whatever the budget is, so the seat is the
    // only place the model can be told to read a smaller part of the page.
    const cell = (tag: string, seed: string): string => `<${tag}>${seed.repeat(300)}</${tag}>`
    const cells = (tag: string): string =>
      Array.from({ length: 12 }, (_, column) => cell(tag, `c${String(column)}`)).join('')
    const frame = mountFrame(
      `<table aria-label="${'N'.repeat(300)}">`
      + `<thead><tr>${cells('th')}</tr></thead><tbody><tr>${cells('td')}</tr></tbody></table>`
      + `<nav class="pagination">${'P'.repeat(300)}</nav>`,
    )
    drive(seatOf({
      frames: { current: new Map([[FRAME, frame]]) },
      access: { outlineChars: MIN_OUTLINE_CHARS, claimTimeoutMs: 300, readTimeoutMs: 1000 },
      pending: [{ callId: 'call_1', tool: 'content_read', args: { find: 'NNN' } }],
    }))
    await settled()
    expect(reported()).toEqual({
      status: 'error',
      code: 'frame',
      message: 'The page\'s first block alone is wider than this deployment\'s read budget. '
        + 'Call content_read with find, or with scope and a ref from a previous read, '
        + 'to read a smaller part of the page, or ask the user to raise pageAccess.outlineChars.',
    })
    // The same sentence the seat holds, so a wording change moves both.
    expect(reported()).toMatchObject({ message: FRAME_WIDE_LISTING_MESSAGE })
    // And a document the route takes, where the listing itself would have been
    // refused and reached the model as a console that never answered.
    expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], MIN_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE)).toBeDefined()
    // One post, not one per retry: the seat answered rather than being refused.
    await new Promise<void>((resolve) => { setTimeout(resolve, CLAIM_RETRY_MS + SETTLE_MARGIN_MS) })
    expect(of(CONTENT_REPORT_ROUTE)).toHaveLength(1)
  })

  it('measures a listing in bytes as well as in characters, because the route holds it to both', async () => {
    // The same eighty-column table twice, filled once with a character costing
    // one JSON byte and once with one costing three. The two listings are the
    // same length, so the character bound cannot tell them apart; the byte
    // bound can, and at the shipped budget it is the one a page written in a
    // three-byte language actually meets.
    const thin = readTable(wideTable(80, '~', '~'.repeat(300)), DEFAULT_OUTLINE_CHARS)
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    const thinBody = reportedBytes()
    thin.unmount()
    // The wide page's listing, unit for unit: `~` is a character the renderer's
    // own words never print, so substituting it is what the second read below
    // produces from the same document.
    const wide = outcome.snapshot.text.replaceAll('~', '甲')
    expect({
      thinChars: outcome.snapshot.text.length,
      thinBytes: jsonBytesOf(outcome.snapshot.text),
      thinBody,
      wideChars: wide.length,
      wideBytes: jsonBytesOf(wide),
      wideBody: SEAT_ENVELOPE_BYTES + jsonBytesOf(wide),
      charBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
      byteBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
    }).toEqual({
      thinChars: 32696,
      thinBytes: 33027,
      thinBody: 33279,
      wideChars: 32696,
      wideBytes: 96845,
      wideBody: 97097,
      charBound: 48000,
      byteBound: 71328,
    })

    posted = []
    const heavy = readTable(wideTable(80, '甲', '甲'.repeat(300)), DEFAULT_OUTLINE_CHARS)
    await settled()
    // The character bound would have taken this listing, so what stopped it is
    // the bytes it costs on the wire — and the seat says so rather than posting
    // a body the route answers with a 413 the host cannot trace back to the
    // call.
    expect(reported()).toMatchObject({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
    expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE))
      .toBeDefined()
    heavy.unmount()
  })

  it('posts three-byte text up to the bound on the whole body, not up to the listing\'s own share of it', async () => {
    // Three tables of Chinese under the shipped budget, told apart by the size
    // of the report each one would be posted in. Every listing here costs more
    // than the budget in bytes on its own, so a check against the listing's
    // share alone answers all three with a sentence; against the whole body's
    // bound — the same budget in bytes plus the envelope's 23,328 — the first
    // two are pages the model gets to read.
    for (const [columns, chars, listing, body] of [
      [48, 19832, 58637, 58889],
      [58, 23852, 70577, 70829],
    ] as const) {
      posted = []
      const view = readTable(wideTable(columns, '甲', '甲'.repeat(300)), DEFAULT_OUTLINE_CHARS)
      await settled()
      const outcome = reported()
      if (outcome.status !== 'ok') throw new Error(`the reader answered a failure at ${String(columns)} columns`)
      expect({
        columns,
        chars: outcome.snapshot.text.length,
        listing: jsonBytesOf(outcome.snapshot.text),
        body: reportedBytes(),
        charBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
        byteBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
      }).toEqual({ columns, chars, listing, body, charBound: 48000, byteBound: 71328 })
      // And the host takes what the seat sent, at both of its own bounds.
      expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE))
        .toBeDefined()
      view.unmount()
    }

    posted = []
    // One column more than the widest that fits: 24,254 characters, still well
    // inside the character bound, in a body of 72,023 bytes against 71,328.
    const past = readTable(wideTable(59, '甲', '甲'.repeat(300)), DEFAULT_OUTLINE_CHARS)
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
    past.unmount()
  })

  it('refuses on characters a listing whose bytes the route would have taken', async () => {
    // One-byte text, where the character bound is the tighter of the two: the
    // envelope puts the byte bound 23,328 above four times the budget, so a
    // listing of ASCII can pass what the whole body is held to and still be
    // past what the parser takes for `text`.
    const inside = readTable(wideTable(118, 'c', 'P'.repeat(300)), DEFAULT_OUTLINE_CHARS)
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect({
      chars: outcome.snapshot.text.length,
      body: reportedBytes(),
      charBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
      byteBound: DEFAULT_OUTLINE_CHARS * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
    }).toEqual({ chars: 47973, body: 48708, charBound: 48000, byteBound: 71328 })
    inside.unmount()

    posted = []
    const past = readTable(wideTable(119, 'c', 'P'.repeat(300)), DEFAULT_OUTLINE_CHARS)
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
    past.unmount()

    // Which half that was, read off the same table rather than written out: a
    // budget of 20,000 characters takes it on both — 80,000 characters and
    // 103,328 bytes — so it is posted, and what it costs there is past the
    // shipped budget's character bound while the whole report is inside that
    // budget's byte bound.
    posted = []
    const taken = readTable(wideTable(119, 'c', 'P'.repeat(300)), 20000)
    await settled()
    const listing = reported()
    if (listing.status !== 'ok') throw new Error('the reader answered a failure')
    const chars = listing.snapshot.text.length
    const body = reportedBytes()
    expect({
      chars,
      body,
      pastCharBound: chars > DEFAULT_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
      insideByteBound: body <= DEFAULT_OUTLINE_CHARS * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
    }).toEqual({ chars: 48375, body: 49114, pastCharBound: true, insideByteBound: true })
    taken.unmount()
  })

  it('takes a report whose bytes land on the bound, and stops one byte past it', async () => {
    // A budget chosen so a whole table lands the report exactly on the route's
    // bound: 3,817 characters holds a body of 3,817 × 4 + 23,328 = 38,596
    // bytes, and thirty-one columns of Chinese with a two-hundred-character
    // pagination line is that body to the byte. The two fixtures differ in one
    // character of that line — `é` costs two UTF-8 bytes where 甲 costs three —
    // so the listings are the same length and the bodies are one byte apart.
    const budget = 3817
    const at = readTable(wideTable(31, '甲', `${'甲'.repeat(199)}é`), budget)
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect({
      chars: outcome.snapshot.text.length,
      body: reportedBytes(),
      charBound: budget * MAX_TEXT_BUDGET_MULTIPLE,
      byteBound: budget * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
    }).toEqual({ chars: 13000, body: 38596, charBound: 15268, byteBound: 38596 })
    at.unmount()

    posted = []
    const past = readTable(wideTable(31, '甲', '甲'.repeat(200)), budget)
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
    // The first listing with that one character swapped is the second listing,
    // unit for unit: the same 13,000 characters in a body of 38,597 bytes. One
    // byte is the whole difference between the two answers.
    expect(SEAT_ENVELOPE_BYTES + jsonBytesOf(outcome.snapshot.text.replace('é', '甲')))
      .toBe(budget * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES + 1)
    past.unmount()
  })

  it('holds an eight-column table of three-byte text at the smallest budget a deployment may set', async () => {
    // What the floor on the budget is stated for: four times 1000 characters
    // holds a table block of eight columns, and the byte bound on the body is
    // nowhere near binding there — 11,128 bytes against 27,328.
    const inside = readTable(wideTable(8, '甲', '甲'.repeat(300)), MIN_OUTLINE_CHARS)
    await settled()
    const outcome = reported()
    if (outcome.status !== 'ok') throw new Error('the reader answered a failure')
    expect({
      chars: outcome.snapshot.text.length,
      body: reportedBytes(),
      charBound: MIN_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE,
      byteBound: MIN_OUTLINE_CHARS * MAX_TEXT_BYTES_PER_CHAR + ENVELOPE_BYTES,
    }).toEqual({ chars: 3751, body: 11128, charBound: 4000, byteBound: 27328 })
    expect(parseReportRequest(of(CONTENT_REPORT_ROUTE)[0], MIN_OUTLINE_CHARS * MAX_TEXT_BUDGET_MULTIPLE))
      .toBeDefined()
    inside.unmount()

    posted = []
    // A ninth column is 402 characters more, which is what puts the block past
    // four times the floor — the column count the floor is chosen for, not a
    // byte count, is what ends this.
    const past = readTable(wideTable(9, '甲', '甲'.repeat(300)), MIN_OUTLINE_CHARS)
    await settled()
    expect(reported()).toMatchObject({ status: 'error', code: 'frame', message: FRAME_WIDE_LISTING_MESSAGE })
    past.unmount()
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
    const access = { outlineChars: 4000, claimTimeoutMs: 300, readTimeoutMs: 800 }
    const opened = Date.now()
    drive(seatOf({ frames: { current: frames }, access }))
    await settled()
    expect(reported()).toEqual({
      status: 'error',
      code: 'frame',
      message: 'The page in the content column had not finished loading; retry once.',
    })
    // At most half, because the host started its report deadline when it
    // granted the claim: the walk and the trip back need the other half, and a
    // seat that spent the whole deadline waiting would post into a call that
    // had already given up — this sentence would never reach the model at all.
    expect(LOAD_WAIT_SHARE).toBeLessThanOrEqual(0.5)
    // And the seat spends that share rather than some shorter interval that
    // would satisfy the bound above by accident.
    const waited = Date.now() - opened
    const budget = access.readTimeoutMs * LOAD_WAIT_SHARE
    expect(waited).toBeGreaterThanOrEqual(budget * 0.9)
    expect(waited).toBeLessThanOrEqual(budget + 100)
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
