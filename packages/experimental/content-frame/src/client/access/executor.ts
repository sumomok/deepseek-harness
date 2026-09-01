/**
 * The reading half of `content_read`, living in the seat that owns the frames.
 *
 * A host cannot address a browser, so the call comes the other way: the session
 * publishes its open reads in the `contentAccess` projection, this seat claims
 * one, walks the frame's own document, and posts the listing back. Only the
 * claiming tab's report is taken, which is why the claim is a round trip rather
 * than an announcement.
 *
 * Layout is injected into the reader rather than read by it, because a frame's
 * layout belongs to that frame: visibility and geometry are asked of each
 * element's own window, not of the top one, so an element inside a nested
 * same-origin frame is measured where it actually lives.
 *
 * A tab that is not visible claims nothing. Its frames are still mounted and
 * would answer, but a hidden tab is not what the user is looking at, and the
 * read is defined as the page in front of them; the scan runs again when the
 * tab comes back.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/executor
 */
import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import {
  CLAIM_RETRY_MS, CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, LOAD_WAIT_SHARE, MAX_HEADER_CHARS,
  MAX_NAME_CHARS, MAX_OUTCOME_MESSAGE_CHARS, MAX_TEXT_BUDGET_MULTIPLE, MAX_URL_CHARS,
  PREFERRED_TAB_WINDOW_MS, ROUTE_REFUSAL_STATUSES, sanitize,
  type ClaimAck, type ReadArgs, type ReadOutcome, type ReadPage, type ReportAck,
} from '../../access/wire.ts'
import {
  FRAME_LOADING_MESSAGE, FRAME_RETIRED_MESSAGE, FRAME_UNREACHABLE_MESSAGE, FRAME_WIDE_LISTING_MESSAGE,
} from '../../access/text.ts'
import type { ContentFrameAccessSettings } from '../../route.ts'
import type { ContentReadRequest } from '../../types.ts'
import { RefTable } from './refs.ts'
import { snapshot } from './snapshot.ts'
import type { SnapshotOptions } from './snapshot.ts'

/**
 * The kind this seat draws, spelled out rather than imported: the node half's
 * `PAGE_KIND` lives beside its tool and projection registrations, and the seat
 * already spells the same literal in its slot key.
 */
const PAGE_KIND = 'page'

/** Reason for an outcome whose model-facing sentence the tool composes instead. */
const EMPTY_REASON = 'the content column is empty'

/** Reason for an outcome whose model-facing sentence the tool composes instead. */
const NOT_A_PAGE_REASON = 'the entry in front is not a page'

/** This page load's identity, which is what a session's reads are pinned to. */
export const TAB_ID = crypto.randomUUID()

/**
 * The window an element's own styles belong to.
 * @param el - an element the reader is measuring.
 * @returns that element's window.
 * @throws {Error} when the element's document has no window.
 */
function viewOf(el: Element): Window {
  const view = el.ownerDocument.defaultView
  /* v8 ignore next -- every element the walk yields sits in a mounted, attached document, which has a window */
  if (view === null) throw new Error('content-frame: the frame document has no window')
  return view
}

/** The part of `Element` a DOM implementation may not provide; the lib declares it unconditionally. */
interface MaybeCheckable {
  /** The browser's own visibility answer, absent under jsdom. */
  checkVisibility?: Element['checkVisibility']
}

/**
 * Whether an element is visible, by walking its ancestors for the two
 * properties that hide a whole subtree.
 *
 * There is deliberately no zero-rectangle test: a `display: contents` wrapper
 * has no box of its own while everything inside it is on screen, and a
 * rectangle gate would drop that entire subtree.
 * @param el - the element to test.
 * @returns whether the element and its ancestors are displayed.
 */
function visibleByStyle(el: Element): boolean {
  const view = viewOf(el)
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const style = view.getComputedStyle(node)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

/**
 * Injected visibility: the browser's own answer where there is one.
 *
 * `checkVisibility` also covers `content-visibility` and collapsed subtrees,
 * which the style walk cannot see; the walk stands in under a DOM
 * implementation that does not provide it.
 * @param el - the element to test.
 * @returns whether the element is visible.
 */
export function isVisible(el: Element): boolean {
  const checkable: MaybeCheckable = el
  if (checkable.checkVisibility === undefined) return visibleByStyle(el)
  return checkable.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
}

/**
 * Injected geometry, used to drop the rows a pinned table column draws twice.
 * @param el - the element to measure.
 * @returns the element's rectangle in its own frame's coordinates.
 */
export function rectOf(el: Element): DOMRectReadOnly {
  return el.getBoundingClientRect()
}

/**
 * Injected clickability for an element that declares no role.
 * @param el - the element to test.
 * @returns whether the page draws it as something to click.
 */
export function isClickable(el: Element): boolean {
  return viewOf(el).getComputedStyle(el).cursor === 'pointer'
}

/** Everything the reader needs from the seat that owns the frames. */
export interface ContentReadSeat {
  /** Every live entry of the session's column, newest first. */
  entries: readonly ContentSurfaceEntry[]
  /** The session's open reads, as the host published them. */
  pending: readonly ContentReadRequest[]
  /** The page in front, when one is; absent while another kind holds the column. */
  page: ReadPage | undefined
  /** The frame showing that page, when it has one. */
  activeFrameId: string | undefined
  /** Every mounted frame element, by frame id. */
  frames: MutableRefObject<Map<string, HTMLIFrameElement>>
  /** Each frame's element numbering, minted on first read and dropped with the frame. */
  tables: MutableRefObject<Map<string, RefTable>>
  /** The node half's two values; absent turns the reader off entirely. */
  access: ContentFrameAccessSettings | undefined
  /** This tab's id. */
  tabId: string
}

/** One failure the seat itself composes, for a frame it could not read. */
function frameError(message: string): ReadOutcome {
  return { status: 'error', code: 'frame', message }
}

/**
 * Cut one string to the length the wire takes, so a document with a long title
 * or address is posted rather than refused.
 *
 * A cut falling between the two halves of one character takes the leading half
 * with it: the wire refuses a lone surrogate, so a cut that left one would
 * refuse the report this cut exists to save.
 * @param value - the string, already free of what the wire refuses.
 * @param max - the wire's bound on that field, in characters.
 * @returns the string, ending in an ellipsis when it was too long.
 */
function clipTo(value: string, max: number): string {
  if (value.length <= max) return value
  const kept = value.slice(0, max - 1)
  return `${kept.isWellFormed() ? kept : kept.slice(0, -1)}…`
}

/**
 * Take one string the page supplied to what the wire carries: what a posted
 * document may not hold removed, then cut to that field's own bound.
 *
 * That order is what {@link clipTo} is written against: it looks for a
 * surrogate pair the cut split, which only means anything on a string carrying
 * no stray half of its own.
 * @param value - the string as the page had it.
 * @param max - the wire's bound on that field, in characters.
 * @returns the string as the seat posts it.
 */
function forWire(value: string, max: number): string {
  return clipTo(sanitize(value), max)
}

/** What one post to a read route ended as, for a caller deciding whether to try again. */
type Posted<T> =
  | {
    /** Discriminant: the route answered. */
    kind: 'answered'
    /** The answer, as the route composed it. */
    value: T
  }
  | {
    /** Discriminant: the route refused this document, and would refuse it again. */
    kind: 'refused'
  }
  | {
    /** Discriminant: the post reached no route that could answer it. */
    kind: 'undelivered'
  }

/**
 * Post one document to a read route.
 *
 * A refusal and a post that never landed are different endings, and only the
 * statuses the routes themselves refuse with — {@link ROUTE_REFUSAL_STATUSES} —
 * are the first. Those the route answers this exact document with however many
 * times it is sent, so there is nothing to gain by sending it again. Every
 * other ending is worth one more try, including the rest of the 4xx range: a
 * reverse proxy refreshing a token answers 401 and a rate limiter answers 429,
 * neither of which has read the document, and treating those as final would end
 * a read the next post would have completed.
 * @param route - the route to post to.
 * @param body - the document.
 * @returns what the post ended as.
 */
async function post<T>(route: string, body: unknown): Promise<Posted<T>> {
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (response.ok) return { kind: 'answered', value: await response.json() as T }
    return ROUTE_REFUSAL_STATUSES.includes(response.status) ? { kind: 'refused' } : { kind: 'undelivered' }
  } catch (_hostUnreachable) {
    return { kind: 'undelivered' }
  }
}

/** Wait one interval before re-claiming. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Win one read, bidding again while the bid could still land.
 *
 * Two answers are worth another try. `unknown` is expected on a first claim:
 * the log records `tool/call` — which is what puts the call in this seat's
 * pending list — before the tool body registers the wait. An undelivered post
 * is the other, and one dropped request would otherwise cost the whole read:
 * the model would be told no console is open while the console sits in front of
 * the user. A refused claim ends the bidding, because the route refused the bid
 * itself and would refuse each one after it.
 *
 * The retrying is bounded by the host's claim window rather than its report
 * deadline, because that window is what the call is actually waiting inside:
 * the preferred tab's hold and one more interval are the slack on top of it.
 * @param seat - the live seat, re-read on every attempt.
 * @param callId - the call to claim.
 * @param access - the node half's settings, whose claim window bounds the bidding.
 * @returns whether this tab owns the read.
 */
async function claimRead(
  seat: MutableRefObject<ContentReadSeat>,
  callId: string,
  access: ContentFrameAccessSettings,
): Promise<boolean> {
  const deadline = Date.now() + access.claimTimeoutMs + PREFERRED_TAB_WINDOW_MS + CLAIM_RETRY_MS
  for (;;) {
    const posted = await post<ClaimAck>(CONTENT_CLAIM_ROUTE, { callId, tabId: seat.current.tabId })
    if (posted.kind === 'refused') return false
    if (posted.kind === 'answered') {
      if (posted.value.claimed) return true
      if (posted.value.reason !== 'unknown') return false
    }
    if (Date.now() + CLAIM_RETRY_MS > deadline) return false
    await delay(CLAIM_RETRY_MS)
    // The result reached the log while this seat waited: the call is over.
    if (!seat.current.pending.some(request => request.callId === callId)) return false
  }
}

/**
 * Post one read back, trying a second time when the first post never lands.
 *
 * A read that was claimed and then answered nowhere is the worst ending
 * available: the call holds its whole report deadline and the model is told the
 * console went quiet. One retry covers a dropped request; past that the host's
 * own deadline is the right place for it to end. A report the route refused is
 * not that ending and is not sent again — the second post would carry the same
 * document to the same check.
 * @param seat - the live seat, read for the tab id the host granted the claim to.
 * @param callId - the call being answered.
 * @param outcome - what the read ended as.
 */
async function reportRead(
  seat: MutableRefObject<ContentReadSeat>,
  callId: string,
  outcome: ReadOutcome,
): Promise<void> {
  const body = { callId, tabId: seat.current.tabId, outcome }
  if ((await post<ReportAck>(CONTENT_REPORT_ROUTE, body)).kind !== 'undelivered') return
  await delay(CLAIM_RETRY_MS)
  await post<ReportAck>(CONTENT_REPORT_ROUTE, body)
}

/**
 * Name the entry holding the column, when exactly one non-page entry could be it.
 *
 * Which entry the user picked is a viewing decision the column keeps to itself,
 * so a session with several other kinds open leaves the failure unqualified
 * rather than naming the wrong one.
 * @param entries - every live entry.
 * @returns the kind and title to carry, or an empty record.
 */
function otherKind(entries: readonly ContentSurfaceEntry[]): { kind?: string; title?: string } {
  const others = entries.filter(entry => entry.kind !== PAGE_KIND)
  const only = others.length === 1 ? others[0] : undefined
  if (only === undefined) return {}
  return { kind: forWire(only.kind, MAX_NAME_CHARS), title: forWire(only.title, MAX_NAME_CHARS) }
}

/**
 * Wait for a frame that is still loading.
 * @param frame - the frame element.
 * @param timeoutMs - how long the read may spend waiting.
 * @returns whether the load arrived in time.
 */
function whenLoaded(frame: HTMLIFrameElement, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      frame.removeEventListener('load', onLoad)
      resolve(false)
    }, timeoutMs)
    const onLoad = (): void => {
      clearTimeout(timer)
      resolve(true)
    }
    frame.addEventListener('load', onLoad, { once: true })
  })
}

/**
 * The numbering one frame's reads share, minted on first read.
 * @param tables - the seat's per-frame tables.
 * @param frameId - the frame being read.
 * @returns that frame's table.
 */
function tableFor(tables: MutableRefObject<Map<string, RefTable>>, frameId: string): RefTable {
  const known = tables.current.get(frameId)
  if (known !== undefined) return known
  const minted = new RefTable()
  tables.current.set(frameId, minted)
  return minted
}

/**
 * Read the page one call asked for, or say why there was none to read.
 * @param seat - the seat as it stands now.
 * @param args - what the call asked of the page.
 * @param access - the node half's budget and deadline.
 * @returns the outcome to post.
 */
async function readPage(
  seat: ContentReadSeat,
  args: ReadArgs,
  access: ContentFrameAccessSettings,
): Promise<ReadOutcome> {
  if (seat.entries.length === 0) return { status: 'error', code: 'empty', message: EMPTY_REASON }
  if (seat.page === undefined) {
    return { status: 'error', code: 'not-a-page', message: NOT_A_PAGE_REASON, ...otherKind(seat.entries) }
  }
  if (seat.activeFrameId === undefined) return frameError(FRAME_RETIRED_MESSAGE)
  const frame = seat.frames.current.get(seat.activeFrameId)
  if (frame === undefined || frame.contentWindow === null) return frameError(FRAME_UNREACHABLE_MESSAGE)
  // A share of the deadline, not all of it: the host started counting when it
  // granted the claim, so the walk and the trip back need what is left.
  const loadBudgetMs = access.readTimeoutMs * LOAD_WAIT_SHARE
  if (frame.contentWindow.document.readyState !== 'complete' && !await whenLoaded(frame, loadBudgetMs)) {
    return frameError(FRAME_LOADING_MESSAGE)
  }
  const options: SnapshotOptions = {
    refs: tableFor(seat.tables, seat.activeFrameId),
    budgetChars: access.outlineChars,
    ...args.mode === undefined ? {} : { mode: args.mode },
    ...args.scope === undefined ? {} : { scope: args.scope },
    ...args.after === undefined ? {} : { after: args.after },
    ...args.find === undefined ? {} : { find: args.find },
    isVisible,
    rectOf,
    isClickable,
  }
  try {
    // Re-read after the wait: a navigation replaces the frame's document.
    const read = snapshot(frame.contentWindow.document, options)
    const text = sanitize(read.text)
    // The renderer prints a listing's first block however long it is, and the
    // parser refuses a listing past this multiple of the budget. Posting one
    // anyway spends the whole report deadline on a refusal the host cannot
    // trace back to the call, and the model is told the console went quiet;
    // saying so here is what puts a narrower read in front of it instead.
    if (text.length > access.outlineChars * MAX_TEXT_BUDGET_MULTIPLE) {
      return frameError(FRAME_WIDE_LISTING_MESSAGE)
    }
    // Every string below the listing itself comes from the document, and the
    // wire holds each of them to a length and to what JSON carries cheaply; a
    // page with a long title posts a cut title rather than a report the route
    // refuses.
    return {
      status: 'ok',
      page: { id: seat.page.id, title: forWire(seat.page.title, MAX_NAME_CHARS) },
      snapshot: {
        kind: read.kind,
        url: forWire(read.header.url, MAX_URL_CHARS),
        title: forWire(read.header.title, MAX_HEADER_CHARS),
        ...read.header.breadcrumb === undefined ? {} : { breadcrumb: forWire(read.header.breadcrumb, MAX_HEADER_CHARS) },
        ...read.header.modal === undefined ? {} : { modal: forWire(read.header.modal, MAX_HEADER_CHARS) },
        signIn: read.header.signIn,
        text,
        truncated: read.truncated,
        shown: read.shown,
        total: read.total,
        ...read.cursor === undefined ? {} : { cursor: read.cursor },
      },
    }
  } catch (refusal) {
    /* v8 ignore next 2 -- the reader throws Error and nothing else; String() keeps a thrown non-Error readable. */
    const message = refusal instanceof Error ? refusal.message : String(refusal)
    return { status: 'error', code: 'engine', message: forWire(message, MAX_OUTCOME_MESSAGE_CHARS) }
  }
}

/**
 * Claim one call, read the page, and report.
 * @param seat - the live seat, re-read after the claim round trip.
 * @param request - the pending call.
 * @param access - the node half's budget and deadline, settled when the seat booted.
 */
async function answer(
  seat: MutableRefObject<ContentReadSeat>,
  request: ContentReadRequest,
  access: ContentFrameAccessSettings,
): Promise<void> {
  if (!await claimRead(seat, request.callId, access)) return
  const outcome = await readPage(seat.current, request.args, access)
  await reportRead(seat, request.callId, outcome)
}

/**
 * Answer this session's open `content_read` calls from the frames this seat holds.
 *
 * One call is answered at most once from this tab: a call the seat has taken up
 * is remembered until it leaves the pending list, so no amount of re-rendering
 * turns one read into two claims. A claim that fails in transit is not that
 * failure — it is retried every `CLAIM_RETRY_MS` until the host's claim window
 * is out, and so is a report that never lands, once.
 *
 * Each call is answered by background work nobody awaits: this hook returns as
 * soon as the reads are under way, and every result reaches the host over the
 * report route rather than through anything the seat renders.
 * @param seat - what the seat currently holds; re-read live by each running read.
 */
export function useContentRead(seat: ContentReadSeat): void {
  const live = useRef(seat)
  const started = useRef<Set<string>>(new Set())
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => { live.current = seat })

  useEffect(() => {
    const onChange = (): void => { setVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', onChange)
    return () => { document.removeEventListener('visibilitychange', onChange) }
  }, [])

  useEffect(() => {
    const access = seat.access
    if (access === undefined || !visible) return
    // A call that has left the list has settled and cannot come back, so the
    // memory of having answered it is dropped with it — a tab left open for a
    // long session would otherwise accumulate one id per read it ever saw.
    const open = new Set(seat.pending.map(request => request.callId))
    for (const callId of started.current) {
      if (!open.has(callId)) started.current.delete(callId)
    }
    for (const request of seat.pending) {
      if (started.current.has(request.callId)) continue
      started.current.add(request.callId)
      void answer(live, request, access)
    }
  }, [seat.access, seat.pending, visible])
}
