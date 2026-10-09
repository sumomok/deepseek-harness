/**
 * The reading half of the page channel, living in the seat that owns the frames.
 *
 * A host cannot address a browser, so the call comes the other way: the session
 * publishes its open reads in the `contentAccess` projection, this seat claims
 * one, walks the frame's own document, and posts the listing back. The claim,
 * the bidding, and the report are the shared channel's (`./channel.ts`); what
 * is this module's is what a claimed call is *run* against — the frame, its
 * numbering, and the walk.
 *
 * Layout is injected into the reader rather than read by it, because a frame's
 * layout belongs to that frame: visibility and geometry are asked of each
 * element's own window, not of the top one, so an element inside a nested
 * same-origin frame is measured where it actually lives.
 *
 * Visibility orders the bidding rather than gating it. A tab the user is not
 * looking at holds the same mounted frames and the same live documents, so it
 * bids too, after {@link HIDDEN_CLAIM_GRACE_MS} — long enough for a tab that is
 * in front to have bid first, short enough that a console nobody is looking at
 * still answers rather than leaving the call to the host's claim timeout.
 *
 * A read waits twice before it walks anything: for a document that is still
 * loading, and then for a loaded document to stop changing (`../perception/
 * settle.ts`). Each spends its own share of the report deadline, and the
 * second one's verdict travels with the listing rather than replacing it.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/executor
 */
import { useEffect, useMemo, useRef } from 'react'
import type { MutableRefObject } from 'react'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { ContentChannel, type ChannelCall, type ChannelDomain } from './channel.ts'
import {
  ACT_RUN_SHARE, CONTENT_ACT_TOOL_NAME, CONTENT_IMAGE_ROUTE,
  CONTENT_READ_ATTRS_TOOL_NAME, CONTENT_READ_DOM_CONTENT_TOOL_NAME, CONTENT_READ_DOM_TOOL_NAME,
  CONTENT_READ_IMAGE_TOOL_NAME, CONTENT_READ_TOOL_NAME,
  CONTENT_REPORT_ROUTE, EXPORT_WAIT_SHARE, forWire, LOAD_WAIT_SHARE, MAX_HEADER_CHARS,
  MAX_NAME_CHARS, MAX_OUTCOME_MESSAGE_CHARS, MAX_TEXT_BUDGET_MULTIPLE, MAX_TEXT_BYTES_PER_CHAR,
  MAX_URL_CHARS, REPORT_ENVELOPE_BYTES, sanitize,
  SETTLE_WAIT_SHARE, type ActOutcome, type ChannelOutcome, type ImageReport, type ReadFailure,
  type ReadOutcome, type ReadPage,
} from '../../access/wire.ts'
import {
  FRAME_LOADING_MESSAGE, FRAME_LOST_MESSAGE, FRAME_RETIRED_MESSAGE, FRAME_UNREACHABLE_MESSAGE,
  FRAME_WIDE_LISTING_MESSAGE,
  wideAttrsMessage, wideTextMessage, WIDE_DOM_MESSAGE,
} from '../../access/text.ts'
import { actReportText, frontChangedRefusal } from '../../access/act-text.ts'
import type { ContentFrameAccessSettings } from '../../route.ts'
import type {
  ContentAccessRequest, ContentActRequest, ContentReadImageRequest, ContentReadingRequest,
} from '../../types.ts'
import { settlePage } from '../perception/settle.ts'
import { captureElement, type ExportPixels } from './capture.ts'
import { runSteps } from './act.ts'
import { watchPage, type ActWatch } from './watch.ts'
import { computedStyleOf, elementMark, looksClickable, readableDocuments, rowMark } from './dom.ts'
import { itemName } from './collect.ts'
import { markup } from './markup.ts'
import { RefTable } from './refs.ts'
import { resolveRef, snapshot } from './snapshot.ts'
import type { SnapshotOptions } from './snapshot.ts'

/**
 * The kind this seat draws, spelled out rather than imported: the node half's
 * `PAGE_KIND` lives beside its tool and projection registrations, and the seat
 * already spells the same literal in its slot key.
 */
const PAGE_KIND = 'page'

/**
 * Reason for an outcome whose model-facing sentence the tool composes instead.
 * `scripts/verify-client-ui-i18n.ts` classifies by identifier name, so this name
 * must match neither its `COPY_NAME` nor its `COPY_SUFFIX` pattern; a name that
 * does is taken for product copy owed to a locale dictionary.
 */
const NO_ENTRY_REASON = 'the content column is empty'

/** Reason for an outcome whose model-facing sentence the tool composes instead. */
const NOT_A_PAGE_REASON = 'the entry in front is not a page'

/**
 * The channel this page load answers content calls through when a seat is
 * mounted without one.
 *
 * One per page load, and the instance `content-frame`'s client entry provides
 * as `ctx.contentTabChannel`: the tab id it mints is the identity the host pins
 * a session's calls to, so a second instance would make the same seats bid
 * against each other and would settle a report under an identity its claim did
 * not carry. A seat is handed the provided instance and reads its identity off
 * it; this constant is what a seat mounted without one joins, and the tab
 * {@link TAB_ID} names.
 */
export const PAGE_CHANNEL = new ContentChannel()

/** This page load's identity, which is what a session's calls are pinned to. */
export const TAB_ID = PAGE_CHANNEL.tabId

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

/** One session's column, as this seat can serve it. */
export interface SeatSession {
  /** The session the calls and the column below belong to. */
  readonly sessionId: string
  /** Every live entry of that session's column, newest first. */
  readonly entries: readonly ContentSurfaceEntry[]
  /** That session's open calls of both tools, as the host published them. */
  readonly pending: readonly ContentAccessRequest[]
  /** The page in front, when one is; absent while another kind holds the column. */
  readonly page: ReadPage | undefined
  /** The frame showing that page, when it has one. */
  readonly frameId: string | undefined
}

/** Everything the reader needs from the seat that owns the frames. */
export interface ContentReadSeat {
  /**
   * Every session this seat can answer for: the one the console has on display,
   * and every other one whose page it still holds a frame of. A session with no
   * frame here is absent rather than empty, so this seat never bids for a call
   * it has no document to answer.
   */
  sessions: readonly SeatSession[]
  /**
   * Every channel call open on any session the console holds, served or not.
   *
   * It is what the memory of the calls this seat has taken up is pruned
   * against, and it is wider than {@link sessions} on purpose: a session whose
   * frame was evicted while one of its calls was being answered leaves this
   * seat's servable list, and pruning against that list alone would forget a
   * call still being worked on and take it up a second time when the session
   * came back.
   */
  openCalls: readonly string[]
  /** Every mounted frame element, by frame id. */
  frames: MutableRefObject<Map<string, HTMLIFrameElement>>
  /** Each frame's element numbering, minted on first read and dropped with the frame. */
  tables: MutableRefObject<Map<string, RefTable>>
  /** The node half's two values; absent turns the reader off entirely. */
  access: ContentFrameAccessSettings | undefined
  /** This tab's id. */
  tabId: string
  /**
   * The browser's own drawing, which a picture read exports one element
   * through. Injected for the reason `./capture.ts` states: every decision an
   * export makes is testable without a browser and this is not.
   */
  draw: ExportPixels
}

/** One failure the seat itself composes, for a frame it could not read. */
function frameError(message: string): ReadFailure {
  return { status: 'error', code: 'frame', message }
}

/** One read's report, ready to post. */
interface Report {
  /** The serialized document, which is the string {@link post} sends. */
  body: string
  /** Its length in UTF-8 bytes, which is what the route counts. */
  bytes: number
}

/**
 * Serialize one read's report and measure what it costs the route.
 *
 * Measured rather than estimated: `JSON.stringify` writes the escapes the route
 * will receive — two bytes for a newline, three for the widest character — and
 * `TextEncoder` counts what goes on the wire, so this is the same byte-by-byte
 * total the route arrives at. The seat weighs and posts this one string, so the
 * document held against the route's bound is the document sent to it.
 * @param seat - the seat the read ran on, for the tab id the report carries.
 * @param callId - the call being answered.
 * @param outcome - what the call ended as.
 * @returns the report as it goes on the wire.
 */
function reportOf(seat: ContentReadSeat, callId: string, outcome: ChannelOutcome): Report {
  return weighed({ callId, tabId: seat.tabId, outcome })
}

/**
 * Serialize one picture read's report and measure what it costs the route,
 * which is the same measurement {@link reportOf} makes of every other read.
 *
 * The document differs because the route does: what a picture read posts is a
 * capture carrying bytes, and the arm the call settles as is composed on the
 * host once those bytes are stored.
 * @param seat - the seat the read ran on, for the tab id the report carries.
 * @param callId - the call being answered.
 * @param capture - the pixels, or the failure in their place.
 * @returns the report as it goes on the wire.
 */
function captureOf(seat: ContentReadSeat, callId: string, capture: ImageReport): Report {
  return weighed({ callId, tabId: seat.tabId, capture })
}

/**
 * Serialize one document and count the bytes the route will receive.
 * @param document - the report, in whichever of the two forms its route takes.
 * @returns the serialized body and its exact UTF-8 length.
 */
function weighed(document: unknown): Report {
  const body = JSON.stringify(document)
  return { body, bytes: new TextEncoder().encode(body).length }
}

/**
 * One session's column as this seat holds it now.
 * @param seat - the seat as it stands.
 * @param sessionId - the session to look up.
 * @returns that session's column, or undefined when this seat holds no frame of it.
 */
function sessionOf(seat: ContentReadSeat, sessionId: string): SeatSession | undefined {
  return seat.sessions.find(session => session.sessionId === sessionId)
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
 * Weigh one report against the two bounds the route holds a body to, and answer
 * the sentence about a page too wide to post where it crosses either.
 *
 * The renderer prints a listing's first block however long it is, so this is
 * where a page too wide for the wire is answered rather than posted. What the
 * two checks weigh is the document the route will receive — this call's id and
 * this page load's tab id are what the post carries — against the two bounds
 * that route holds it to: the character half is the parser's refusal of the
 * body alone, and the byte half is the read of the whole document around it,
 * which stops past the budget in bytes plus the envelope. Posting past either
 * spends the whole report deadline on a refusal the host cannot trace back to
 * the call, and the model is told the console went quiet; saying so here is
 * what puts a narrower answer in front of it instead.
 *
 * The body is serialized rather than estimated, so the two halves change sides
 * on the same byte the route does — and so the call id is weighed at its own
 * size, it being the one field no bound holds before the parser has read it.
 *
 * Both halves have work. The envelope leaves the byte bound above four times
 * the budget even in one-byte text, so a body between the two — past the
 * character bound, inside the byte allowance — is refused by the character half
 * and by nothing else; text costing three bytes a character reaches the byte
 * half first, which is what a wide table of Chinese does at the shipped budget.
 * How wide turns on what the page draws in the cells, so the widths at which
 * each half takes over are pinned in this seat's own suite rather than named
 * here.
 * @param report - this call's own serializer, which is what the post will send.
 * @param outcome - the answer about to be posted.
 * @param text - the part of it the character bound holds: the listing, or the body of a call that ran steps.
 * @param access - the deployment's budget, which both bounds are computed from.
 * @param wide - what the model is told instead, which each call composes for
 * itself: what to narrow, and whether narrowing is even available to it.
 * @returns the weighed report, or the one saying the answer is too wide to post.
 */
function weigh(
  report: (outcome: ChannelOutcome) => Report,
  outcome: ChannelOutcome,
  text: string,
  access: ContentFrameAccessSettings,
  wide: string,
): Report {
  const weighed = report(outcome)
  if (
    text.length > access.outlineChars * MAX_TEXT_BUDGET_MULTIPLE
    || weighed.bytes > access.outlineChars * MAX_TEXT_BYTES_PER_CHAR + REPORT_ENVELOPE_BYTES
  ) {
    return report(frameError(wide))
  }
  return weighed
}

/**
 * The failure for a reader that threw, which is the one ending neither half of
 * this package composes a sentence for.
 * @param refusal - whatever was thrown.
 * @returns the failure to post.
 */
function engineFailure(refusal: unknown): ReadFailure {
  /* v8 ignore next 2 -- the reader throws Error and nothing else; String() keeps a thrown non-Error readable. */
  const message = refusal instanceof Error ? refusal.message : String(refusal)
  return { status: 'error', code: 'engine', message: forWire(message, MAX_OUTCOME_MESSAGE_CHARS) }
}

/** What one call found when it went looking for the page to work on. */
type Prepared =
  | {
    /** Discriminant: there is a loaded page in front. */
    kind: 'ready'
    /** The page the column has in front, as the deployment names it. */
    page: ReadPage
    /** The frame showing it. */
    frame: HTMLIFrameElement
    /**
     * That frame's window. The window rather than the document, because a
     * navigation replaces the document and every reader here wants the one the
     * frame has now.
     */
    view: Window
    /** The numbering this frame's calls share. */
    refs: RefTable
  }
  | {
    /** Discriminant: there was not, and this is what the model is told. */
    kind: 'failed'
    /** The failure to post. */
    outcome: ReadFailure
  }

/**
 * Find the loaded page one call is against, or say why there is none.
 *
 * Shared by both tools because the four answers are the same for both: a column
 * with nothing in it, an entry that is not a page, a frame the seat cannot
 * reach, and a page that never finished loading are not conditions a read or a
 * set of steps can tell apart.
 * @param seat - the seat as it stands now, for the frames it holds.
 * @param session - the column this call is against, absent when this seat no
 * longer holds it.
 * @param timeoutMs - this call's own report deadline, whose load share the wait spends.
 * @returns the page and its document, or the failure to post.
 */
async function prepare(
  seat: ContentReadSeat,
  session: SeatSession | undefined,
  timeoutMs: number,
): Promise<Prepared> {
  const failed = (outcome: ReadFailure): Prepared => ({ kind: 'failed', outcome })
  // A claim can outlive the frame it was granted on: the console switched to a
  // page that evicted it, or the session left the console's list. What is gone
  // is this console's copy of the page, not the column, so the failure says so.
  if (session === undefined) return failed(frameError(FRAME_LOST_MESSAGE))
  if (session.entries.length === 0) return failed({ status: 'error', code: 'empty', message: NO_ENTRY_REASON })
  if (session.page === undefined) {
    return failed({ status: 'error', code: 'not-a-page', message: NOT_A_PAGE_REASON, ...otherKind(session.entries) })
  }
  if (session.frameId === undefined) return failed(frameError(FRAME_RETIRED_MESSAGE))
  const frame = seat.frames.current.get(session.frameId)
  if (frame === undefined || frame.contentWindow === null) return failed(frameError(FRAME_UNREACHABLE_MESSAGE))
  // A share of the deadline, not all of it: the host started counting when it
  // granted the claim, so the work and the trip back need what is left.
  if (frame.contentWindow.document.readyState !== 'complete' && !await whenLoaded(frame, timeoutMs * LOAD_WAIT_SHARE)) {
    return failed(frameError(FRAME_LOADING_MESSAGE))
  }
  return {
    kind: 'ready',
    page: session.page,
    frame,
    view: frame.contentWindow,
    refs: tableFor(seat.tables, session.frameId),
  }
}

/**
 * What one read asks of the page beyond the deployment's own budget.
 *
 * Only the listing adds anything: what the three markup reads were asked is
 * read off the call by the reader that prints them, so the seat hands them the
 * budget, the numbering and the injected layout and nothing else.
 * @param request - the pending call.
 * @returns the options that call adds.
 */
function readOptions(request: ContentReadingRequest): Partial<SnapshotOptions> {
  if (request.tool !== CONTENT_READ_TOOL_NAME) return {}
  const args = request.args
  return {
    ...args.mode === undefined ? {} : { mode: args.mode },
    ...args.scope === undefined ? {} : { scope: args.scope },
    ...args.after === undefined ? {} : { after: args.after },
    ...args.find === undefined ? {} : { find: args.find },
  }
}

/**
 * What one read is told when its answer is too wide for the wire.
 *
 * Each read composes its own, because what ran past the budget differs: the
 * listing's first block, one element of a tree, one element's whole text, and
 * one element's attributes, the last two of which say how many characters they
 * came to.
 * @param request - the pending call.
 * @param chars - how long the answer came out.
 * @param budget - the deployment's configured listing budget.
 * @returns the model-facing sentence.
 */
function wideMessage(request: ContentReadingRequest, chars: number, budget: number): string {
  switch (request.tool) {
    case CONTENT_READ_TOOL_NAME: return FRAME_WIDE_LISTING_MESSAGE
    case CONTENT_READ_DOM_TOOL_NAME: return WIDE_DOM_MESSAGE
    case CONTENT_READ_ATTRS_TOOL_NAME: return wideAttrsMessage(chars, request.args.ref, budget)
    case CONTENT_READ_DOM_CONTENT_TOOL_NAME: return wideTextMessage(chars, request.args.ref, budget)
    /* v8 ignore next 2 -- the reading union is closed and typed; the arm keeps a new read loud. */
    default: return FRAME_WIDE_LISTING_MESSAGE
  }
}

/**
 * Read the page one call asked for, or say why there was none to read.
 *
 * Shared by all four reads: what each of them wants of the page differs, and a
 * column with nothing in it, a frame out of reach, a page still loading and a
 * page still drawing are the same four answers for every one of them.
 * @param seat - the seat as it stands now, for the frames it holds.
 * @param session - the column this call is against, absent when this seat no
 * longer holds it.
 * @param request - the pending call: what it asks of the page, and the id the
 * report carrying the answer will be posted under.
 * @param access - the node half's budget and deadline.
 * @returns the report to post.
 */
async function readPage(
  seat: ContentReadSeat,
  session: SeatSession | undefined,
  request: ContentReadingRequest,
  access: ContentFrameAccessSettings,
): Promise<Report> {
  const report = (outcome: ChannelOutcome): Report => reportOf(seat, request.callId, outcome)
  const ready = await prepare(seat, session, access.readTimeoutMs)
  if (ready.kind === 'failed') return report(ready.outcome)
  // A loaded document is not a drawn one: an application that just changed
  // route has its markup and not yet its data. This is the second share of the
  // same deadline, spent on the page going quiet, and what it found travels
  // with the listing either way — a read taken while the page moved says so
  // rather than passing itself off as the settled page.
  const settlement = await settlePage(
    ready.view.document,
    { quietMs: access.settleQuietMs, budgetMs: access.readTimeoutMs * SETTLE_WAIT_SHARE },
    isVisible,
  )
  const options: SnapshotOptions = {
    refs: ready.refs,
    budgetChars: access.outlineChars,
    ...readOptions(request),
    isVisible,
    isClickable: looksClickable,
    computedStyle: computedStyleOf,
  }
  try {
    // Re-read after the wait: a navigation replaces the frame's document.
    const read = request.tool === CONTENT_READ_TOOL_NAME
      ? snapshot(ready.view.document, options)
      : markup(ready.view.document, request, options)
    const text = sanitize(read.text)
    // Every string below the listing itself comes from the document, and the
    // wire holds each of them to a length and to what JSON carries cheaply; a
    // page with a long title posts a cut title rather than a report the route
    // refuses.
    const listing: ReadOutcome = {
      status: 'ok',
      page: { id: ready.page.id, title: forWire(ready.page.title, MAX_NAME_CHARS) },
      snapshot: {
        kind: read.kind,
        url: forWire(read.header.url, MAX_URL_CHARS),
        title: forWire(read.header.title, MAX_HEADER_CHARS),
        ...read.header.modal === undefined ? {} : { modal: forWire(read.header.modal, MAX_HEADER_CHARS) },
        text,
        truncated: read.truncated,
        shown: read.shown,
        total: read.total,
        ...read.cursor === undefined ? {} : { cursor: read.cursor },
        settled: settlement.settled,
        ...settlement.busy.length === 0 ? {} : { busy: [...settlement.busy] },
      },
    }
    return weigh(report, listing, text, access, wideMessage(request, text.length, access.outlineChars))
  } catch (refusal) {
    return report(engineFailure(refusal))
  }
}

/**
 * Export one element's pixels, or say why there are none to export.
 *
 * It shares the front half of every other read — the same claim, the same page
 * in front, the same wait for a document that is still loading and then for one
 * that is still drawing — and parts from them at the answer: what it posts is
 * bytes, on a route of their own, because a listing's route is bounded by the
 * deployment's character budget and pixels are of another order.
 *
 * The export gets a share of that same deadline of its own, after the load wait
 * and the settle wait ({@link EXPORT_WAIT_SHARE}), so a drawing that never
 * settles ends as a refusal naming this picture rather than as the host's own
 * report deadline and its sentence about a console that went quiet.
 * @param seat - the seat as it stands now, for the frames it holds.
 * @param session - the column this call is against, absent when this seat no
 * longer holds it.
 * @param request - the pending call: the ref to export, and the id the report is posted under.
 * @param access - the node half's budget and deadline.
 * @returns the report to post.
 */
async function readImage(
  seat: ContentReadSeat,
  session: SeatSession | undefined,
  request: ContentReadImageRequest,
  access: ContentFrameAccessSettings,
): Promise<Report> {
  const report = (capture: ImageReport): Report => captureOf(seat, request.callId, capture)
  const ready = await prepare(seat, session, access.readTimeoutMs)
  if (ready.kind === 'failed') return report(ready.outcome)
  // The same second wait every other read takes: an application that just
  // changed route has its markup and not yet the picture it is going to draw.
  const settlement = await settlePage(
    ready.view.document,
    { quietMs: access.settleQuietMs, budgetMs: access.readTimeoutMs * SETTLE_WAIT_SHARE },
    isVisible,
  )
  try {
    // Re-read after the wait: a navigation replaces the frame's document.
    ready.refs.sweep()
    const el = resolveRef('ref', request.args.ref, ready.refs)
    const capture = await captureElement(el, {
      ref: request.args.ref,
      isVisible,
      draw: seat.draw,
      // Rounded, because the deadline is named in the refusal a drawing that
      // never settles composes, and a share of a configured number is not
      // always a whole millisecond.
      budgetMs: Math.round(access.readTimeoutMs * EXPORT_WAIT_SHARE),
    })
    // Clipped like every other page-supplied string this seat posts: the
    // refusal names the element's own tag, which a custom element spells
    // however long it likes, and a message past the wire's bound would be
    // refused by the route rather than delivered to the model.
    if (capture.kind === 'refused') return report(frameError(forWire(capture.message, MAX_OUTCOME_MESSAGE_CHARS)))
    // No weighing here, unlike a listing: the payload is bounded by the export
    // itself and every string beside it is cut to the wire's own bound, so the
    // envelope the route's bound is computed from covers what this posts.
    return report({
      status: 'captured',
      page: { id: ready.page.id, title: forWire(ready.page.title, MAX_NAME_CHARS) },
      url: forWire(ready.view.document.URL, MAX_URL_CHARS),
      ref: request.args.ref,
      tag: capture.tag,
      natural: capture.natural,
      settled: settlement.settled,
      mediaType: capture.mediaType,
      data: capture.data,
    })
  } catch (refusal) {
    return report(engineFailure(refusal))
  }
}

/**
 * Run one call's steps against the page, or say why there was none to act on.
 *
 * The watch is installed before the first step and taken off before the report
 * is composed, so what it collected is exactly what the page did in answer to
 * these steps — and the two functions it stands in for are back before anything
 * else can reach them.
 *
 * The closing snapshot is a whole read of the page at the deployment's own
 * budget, taken after the last step settled. It is the model's next move: the
 * refs it names are the ones a following call can use, and a call that changed
 * the page therefore never has to read it again to act on what it produced.
 * @param seat - the seat as it stands now, for the frames it holds.
 * @param session - the column this call is against, absent when this seat no
 * longer holds it.
 * @param request - the pending call: the steps to run, and the id the report is posted under.
 * @param access - the node half's budget, deadlines and per-step ceiling.
 * @param approved - the entry the column had in front when the call was
 * approved, absent for a column that had nothing in front then.
 * @returns the report to post.
 */
async function actOnPage(
  seat: ContentReadSeat,
  session: SeatSession | undefined,
  request: ContentActRequest,
  access: ContentFrameAccessSettings,
  approved: ReadPage | undefined,
): Promise<Report> {
  const report = (outcome: ChannelOutcome): Report => reportOf(seat, request.callId, outcome)
  // Before anything is looked at, let alone pressed. The user agreed to these
  // steps on the entry that was in front while they were reading the request,
  // and the switcher strip is one click: a call that arrives to find another
  // page there has lost the thing it was agreed about. A column now holding
  // something that is not a page, or nothing at all, is answered by the
  // failures below instead — they say more about what to do next than this one.
  if (approved !== undefined && session?.page !== undefined && session.page.id !== approved.id) {
    return report({
      status: 'error',
      code: 'front-changed',
      message: frontChangedRefusal(
        forWire(session.page.title, MAX_NAME_CHARS),
        forWire(approved.title, MAX_NAME_CHARS),
      ),
    })
  }
  // The host granted the claim a moment ago and started counting then, so this
  // is where the call's own deadline begins — before the wait for a frame that
  // has not finished loading, which spends the same deadline.
  const started = Date.now()
  const ready = await prepare(seat, session, access.actTimeoutMs)
  if (ready.kind === 'failed') return report(ready.outcome)
  const options: SnapshotOptions = {
    refs: ready.refs,
    budgetChars: access.outlineChars,
    isVisible,
    isClickable: looksClickable,
    computedStyle: computedStyleOf,
  }
  let watch: ActWatch | undefined
  try {
    // The documents this call is scoped to, fixed before the first step: every
    // same-origin document the reader walked, which is where its refs come
    // from.
    const documents = readableDocuments(ready.view.document)
    watch = watchPage(documents, request.args.dialogs ?? 'cancel')
    const run = await runSteps(request.args.steps, {
      doc: ready.view.document,
      docs: documents,
      refs: ready.refs,
      isVisible,
      // The reader's own naming, under this read's own injections: what the
      // listing printed for an element is what a step naming it is held to.
      name: el => itemName(el, options, ready.view.document),
      // And the reader's own marking, for the rows it printed no name for: the
      // listing's, and the class tokens a markup tree prints.
      mark: rowMark,
      treeMark: elementMark,
    }, {
      settleQuietMs: access.settleQuietMs,
      settleMaxMs: access.settleMaxMs,
      // The steps' share of this call's deadline. What is left of it pays for
      // the closing read and the trip back with it, and the deployment's own
      // bounds are checked at load against this same share.
      deadline: started + access.actTimeoutMs * ACT_RUN_SHARE,
    })
    const events = watch.events()
    // Re-read after the steps: a navigation replaces the frame's document, and
    // the closing snapshot is of the page the user is looking at now.
    const read = snapshot(ready.view.document, options)
    const outcome: ActOutcome = {
      status: run.results.some(result => result.status === 'failed') ? 'failed' : 'done',
      page: { id: ready.page.id, title: forWire(ready.page.title, MAX_NAME_CHARS) },
      title: forWire(read.header.title, MAX_HEADER_CHARS),
      steps: run.results.map(result => (result.status === 'failed'
        ? { ...result, message: forWire(result.message, MAX_OUTCOME_MESSAGE_CHARS) }
        : result)),
      text: sanitize(actReportText({
        page: forWire(ready.page.title, MAX_NAME_CHARS),
        steps: request.args.steps,
        results: run.results,
        redacted: run.redacted,
        settledMs: run.settledMs,
        events,
        snapshot: read.text,
      })),
      truncated: read.truncated,
    }
    return weigh(report, outcome, outcome.text, access, FRAME_WIDE_LISTING_MESSAGE)
  } catch (refusal) {
    return report(engineFailure(refusal))
  } finally {
    // Even where a step threw: a frame left with this package's stand-ins is a
    // frame whose own dialogs never open again.
    watch?.stop()
  }
}

/** One page call as this seat answers it: the call it was offered, and the pending request behind it. */
interface PageCall extends ChannelCall {
  /** The call as the projection published it, which is what says how to answer it. */
  readonly request: ContentAccessRequest
}

/**
 * The page domain of the shared channel.
 *
 * What this adds to the channel is where a claimed call is run: the frame the
 * session's column holds, its numbering, and the reader's own injections. A
 * seat that has left the channel or lost its frames answers with the failure
 * every one of its tools composes for that, so the model is told what happened
 * rather than left waiting.
 * @param seat - the live seat, re-read when a claimed call runs.
 * @returns the domain to join to the channel.
 */
function pageDomain(seat: MutableRefObject<ContentReadSeat>): ChannelDomain<PageCall> {
  return {
    name: 'page',
    ready: () => seat.current.access !== undefined,
    answer: async (call, claimed) => {
      const live = seat.current
      const access = live.access
      const session = sessionOf(live, call.sessionId)
      // The deployment's reader is settled when the page boots, so a seat with
      // none never offered a call; the answer keeps the arm total.
      /* v8 ignore next -- an offered call only exists where `ready()` was true */
      if (access === undefined) {
        const lost = reportOf(live, call.request.callId, frameError(FRAME_LOST_MESSAGE))
        return { kind: 'body', route: CONTENT_REPORT_ROUTE, body: lost.body }
      }
      if (call.request.tool === CONTENT_ACT_TOOL_NAME) {
        const report = await actOnPage(live, session, call.request, access, claimed.page)
        return { kind: 'body', route: CONTENT_REPORT_ROUTE, body: report.body }
      }
      // One call, one settling route: a picture read's failures travel the
      // picture route too, so no call id is ever raced by two routes.
      if (call.request.tool === CONTENT_READ_IMAGE_TOOL_NAME) {
        const report = await readImage(live, session, call.request, access)
        return { kind: 'body', route: CONTENT_IMAGE_ROUTE, body: report.body }
      }
      const report = await readPage(live, session, call.request, access)
      return { kind: 'body', route: CONTENT_REPORT_ROUTE, body: report.body }
    },
  }
}

/**
 * Answer the open channel calls of every session this seat holds a frame of.
 *
 * The console shows one session and this seat serves them all: the frames of
 * the sessions behind it are still mounted and still hold their documents, so a
 * call against one of them is answered from the page that session last had in
 * front. A session with no frame here is not on the list at all, and its call
 * ends on the host's claim window instead.
 *
 * Every offer carries the whole of what this seat can answer, and the channel
 * decides what to do with it: one call is claimed at most once, a call the
 * bidding gave up on is forgotten so the next projection frame can offer it
 * again, and each call is answered by background work nobody awaits. What this
 * hook owns is only when the seat's own list moved.
 * @param seat - what the seat currently holds; re-read live when a call runs.
 * @param channel - the page load's channel, injected for a case that drives one of its own.
 */
export function useContentRead(seat: ContentReadSeat, channel: ContentChannel = PAGE_CHANNEL): void {
  const live = useRef(seat)
  useEffect(() => { live.current = seat })

  const domain = useMemo(() => pageDomain(live), [])
  const joined = useMemo(() => channel.join(domain), [channel, domain])

  // A bid outlives nothing: parking drops the calls this seat was offering, and
  // the loop that is bidding for one ends because it is no longer held.
  useEffect(() => () => { joined.park() }, [joined])

  useEffect(() => {
    joined.offer({
      calls: seat.sessions.flatMap(session => session.pending.map(request => ({
        callId: request.callId,
        sessionId: session.sessionId,
        request,
      }))),
      openCalls: seat.openCalls,
    })
  }, [joined, seat.access, seat.sessions, seat.openCalls])
}
