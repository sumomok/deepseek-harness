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
 *
 * A read waits twice before it walks anything: for a document that is still
 * loading, and then for a loaded document to stop changing (`../perception/
 * settle.ts`). Each spends its own share of the report deadline, and the
 * second one's verdict travels with the listing rather than replacing it.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/executor
 */
import { useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import {
  ACT_RUN_SHARE, CLAIM_RETRY_MS, CONTENT_ACT_TOOL_NAME, CONTENT_CLAIM_ROUTE, CONTENT_READ_ATTRS_TOOL_NAME,
  CONTENT_READ_DOM_CONTENT_TOOL_NAME, CONTENT_READ_DOM_TOOL_NAME, CONTENT_READ_TOOL_NAME,
  CONTENT_REPORT_ROUTE, LOAD_WAIT_SHARE, MAX_BID_MS,
  MAX_HEADER_CHARS,
  MAX_NAME_CHARS, MAX_OUTCOME_MESSAGE_CHARS, MAX_TEXT_BUDGET_MULTIPLE, MAX_TEXT_BYTES_PER_CHAR,
  MAX_CLAIM_BACKOFF, MAX_URL_CHARS, REPORT_ENVELOPE_BYTES, ROUTE_REFUSAL_STATUSES, sanitize,
  SETTLE_WAIT_SHARE, type ActOutcome, type ChannelOutcome, type ClaimAck, type ReadOutcome, type ReadPage,
  type ReportAck,
} from '../../access/wire.ts'
import {
  FRAME_LOADING_MESSAGE, FRAME_RETIRED_MESSAGE, FRAME_UNREACHABLE_MESSAGE, FRAME_WIDE_LISTING_MESSAGE,
  SIGN_IN_REFUSAL, wideAttrsMessage, wideTextMessage, WIDE_DOM_MESSAGE,
} from '../../access/text.ts'
import { actReportText, frontChangedRefusal, SIGN_IN_ACT_REFUSAL } from '../../access/act-text.ts'
import type { ContentFrameAccessSettings } from '../../route.ts'
import type { ContentAccessRequest, ContentActRequest, ContentReadingRequest } from '../../types.ts'
import { settlePage } from '../perception/settle.ts'
import { runSteps } from './act.ts'
import { watchPage, type ActWatch } from './watch.ts'
import { elementMark, looksClickable, readableDocuments } from './dom.ts'
import { itemName } from './collect.ts'
import { markup } from './markup.ts'
import { RefTable } from './refs.ts'
import { snapshot } from './snapshot.ts'
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

/** This page load's identity, which is what a session's reads are pinned to. */
export const TAB_ID = randomUUID()

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

/** Everything the reader needs from the seat that owns the frames. */
export interface ContentReadSeat {
  /** Every live entry of the session's column, newest first. */
  entries: readonly ContentSurfaceEntry[]
  /** The session's open calls of both tools, as the host published them. */
  pending: readonly ContentAccessRequest[]
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
  const body = JSON.stringify({ callId, tabId: seat.tabId, outcome })
  return { body, bytes: new TextEncoder().encode(body).length }
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
 * @param body - the document, already serialized.
 * @returns what the post ended as.
 */
async function post<T>(route: string, body: string): Promise<Posted<T>> {
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
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
 * Win one call, bidding again for as long as it is still waiting for somebody.
 *
 * Two answers are worth another try. `unknown` is expected on a first claim:
 * the log records `tool/call` — which is what puts the call in this seat's
 * pending list — before the tool body registers the wait. An undelivered post
 * is the other, and one dropped request would otherwise cost the whole call:
 * the model would be told no console is open while the console sits in front of
 * the user. A refused claim ends the bidding, because the route refused the bid
 * itself and would refuse each one after it, and so does any other answer — a
 * call another tab took, or one that has already settled.
 *
 * What ends the bidding otherwise is the call leaving this seat's pending list,
 * which happens when its result reaches the log — every ending puts one there,
 * the host's own claim timeout included. A clock cannot stand in for that:
 * `content_act` registers its wait only after a person has answered its
 * approval, and a seat that gave up after the host's claim window would have
 * stopped bidding seconds before the body opened the wait, leaving the model
 * told that no console is open with the console in front of the user the whole
 * time. `claimTimeoutMs` bounds the host's side of that — a wait nobody
 * claimed — and is not this side's deadline.
 *
 * The interval doubles up to {@link MAX_CLAIM_BACKOFF} times {@link
 * CLAIM_RETRY_MS} so a wait measured in minutes costs one bid a second rather
 * than five.
 * @param seat - the live seat, re-read on every attempt.
 * @param mounted - whether this seat is still mounted; a bid outlives nothing.
 * @param callId - the call to claim.
 * @returns whether this tab owns the call.
 */
async function claimRead(
  seat: MutableRefObject<ContentReadSeat>,
  mounted: MutableRefObject<boolean>,
  callId: string,
): Promise<ClaimAck | undefined> {
  let waitMs = CLAIM_RETRY_MS
  const until = Date.now() + MAX_BID_MS
  for (;;) {
    const posted = await post<ClaimAck>(CONTENT_CLAIM_ROUTE, JSON.stringify({ callId, tabId: seat.current.tabId }))
    if (posted.kind === 'refused') return undefined
    if (posted.kind === 'answered') {
      if (posted.value.claimed) return posted.value
      if (posted.value.reason !== 'unknown') return undefined
    }
    await delay(waitMs)
    waitMs = Math.min(waitMs * 2, CLAIM_RETRY_MS * MAX_CLAIM_BACKOFF)
    // The seat went with the tab, the session, or the column: there is nothing
    // left here to read the page with, whatever the last pending list said.
    if (!mounted.current) return undefined
    // The result reached the log while this seat waited: the call is over.
    if (!seat.current.pending.some(request => request.callId === callId)) return undefined
    // And the ceiling, for the call that never leaves the list at all: a host
    // that stopped mid-write leaves one opened and never settled, and nobody is
    // coming back to an approval this old.
    if (Date.now() >= until) return undefined
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
 * @param report - the read's report, as {@link readPage} weighed it.
 */
async function reportRead(report: Report): Promise<void> {
  if ((await post<ReportAck>(CONTENT_REPORT_ROUTE, report.body)).kind !== 'undelivered') return
  await delay(CLAIM_RETRY_MS)
  await post<ReportAck>(CONTENT_REPORT_ROUTE, report.body)
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
function engineFailure(refusal: unknown): ReadOutcome {
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
    outcome: ReadOutcome
  }

/**
 * Find the loaded page one call is against, or say why there is none.
 *
 * Shared by both tools because the four answers are the same for both: a column
 * with nothing in it, an entry that is not a page, a frame the seat cannot
 * reach, and a page that never finished loading are not conditions a read or a
 * set of steps can tell apart.
 * @param seat - the seat as it stands now.
 * @param timeoutMs - this call's own report deadline, whose load share the wait spends.
 * @returns the page and its document, or the failure to post.
 */
async function prepare(seat: ContentReadSeat, timeoutMs: number): Promise<Prepared> {
  const failed = (outcome: ReadOutcome): Prepared => ({ kind: 'failed', outcome })
  if (seat.entries.length === 0) return failed({ status: 'error', code: 'empty', message: NO_ENTRY_REASON })
  if (seat.page === undefined) {
    return failed({ status: 'error', code: 'not-a-page', message: NOT_A_PAGE_REASON, ...otherKind(seat.entries) })
  }
  if (seat.activeFrameId === undefined) return failed(frameError(FRAME_RETIRED_MESSAGE))
  const frame = seat.frames.current.get(seat.activeFrameId)
  if (frame === undefined || frame.contentWindow === null) return failed(frameError(FRAME_UNREACHABLE_MESSAGE))
  // A share of the deadline, not all of it: the host started counting when it
  // granted the claim, so the work and the trip back need what is left.
  if (frame.contentWindow.document.readyState !== 'complete' && !await whenLoaded(frame, timeoutMs * LOAD_WAIT_SHARE)) {
    return failed(frameError(FRAME_LOADING_MESSAGE))
  }
  return {
    kind: 'ready',
    page: seat.page,
    frame,
    view: frame.contentWindow,
    refs: tableFor(seat.tables, seat.activeFrameId),
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
 * Each read composes its own, because what a model can do about it differs:
 * a listing narrows with `find` or `scope`, a tree with a ref further down, an
 * element's text with a smaller element, and an element's attributes with
 * nothing at all — that last one says so rather than offering a call that
 * cannot help.
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
 * column with nothing in it, a frame out of reach, a page still loading, a page
 * still drawing and a page asking for a sign-in are the same five answers for
 * every one of them.
 * @param seat - the seat as it stands now.
 * @param request - the pending call: what it asks of the page, and the id the
 * report carrying the answer will be posted under.
 * @param access - the node half's budget and deadline.
 * @returns the report to post.
 */
async function readPage(
  seat: ContentReadSeat,
  request: ContentReadingRequest,
  access: ContentFrameAccessSettings,
): Promise<Report> {
  const report = (outcome: ChannelOutcome): Report => reportOf(seat, request.callId, outcome)
  const ready = await prepare(seat, access.readTimeoutMs)
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
        signIn: read.header.signIn,
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
 * Run one call's steps against the page, or say why there was none to act on.
 *
 * The watch is installed before the first step and taken off before the report
 * is composed, so what it collected is exactly what the page did in answer to
 * these steps — and the two functions it stands in for are back before anything
 * else can reach them.
 *
 * A page asking the user to sign in is refused before the first step, by the
 * reader's own verdict rather than by a second opinion of what a sign-in form
 * looks like: `content_read` withholds such a page's listing, and a channel
 * that typed into it would be the way around that. The same verdict is taken
 * again on the closing read, because the steps themselves can produce one — a
 * sign-out, a session that expired mid-call — and the page's structure is then
 * withheld from the report the way the read withholds it.
 *
 * The closing snapshot is a whole read of the page at the deployment's own
 * budget, taken after the last step settled. It is the model's next move: the
 * refs it names are the ones a following call can use, and a call that changed
 * the page therefore never has to read it again to act on what it produced.
 * @param seat - the seat as it stands now.
 * @param request - the pending call: the steps to run, and the id the report is posted under.
 * @param access - the node half's budget, deadlines and per-step ceiling.
 * @param approved - the entry the column had in front when the call was
 * approved, absent for a column that had nothing in front then.
 * @returns the report to post.
 */
async function actOnPage(
  seat: ContentReadSeat,
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
  if (approved !== undefined && seat.page !== undefined && seat.page.id !== approved.id) {
    return report({
      status: 'error',
      code: 'front-changed',
      message: frontChangedRefusal(
        forWire(seat.page.title, MAX_NAME_CHARS),
        forWire(approved.title, MAX_NAME_CHARS),
      ),
    })
  }
  // The host granted the claim a moment ago and started counting then, so this
  // is where the call's own deadline begins — before the wait for a frame that
  // has not finished loading, which spends the same deadline.
  const started = Date.now()
  const ready = await prepare(seat, access.actTimeoutMs)
  if (ready.kind === 'failed') return report(ready.outcome)
  const options: SnapshotOptions = {
    refs: ready.refs,
    budgetChars: access.outlineChars,
    isVisible,
    isClickable: looksClickable,
  }
  let watch: ActWatch | undefined
  try {
    if (snapshot(ready.view.document, options).header.signIn) {
      return report({ status: 'error', code: 'sign-in', message: SIGN_IN_ACT_REFUSAL })
    }
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
      name: el => itemName(el, options),
      // And the reader's own marking, for the rows it printed no name for.
      mark: elementMark,
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
    // Withheld rather than described, exactly as a read withholds it: what the
    // steps left in front of the user is a credential form, and its structure
    // is not what the model needs to see. What the seat answered a dialog, or
    // where the page went, is the seat's own record of the call and quotes
    // nothing the page drew, so it is reported either way.
    const now = read.header.signIn
      ? { text: SIGN_IN_REFUSAL, truncated: false, events }
      : { text: read.text, truncated: read.truncated, events }
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
        events: now.events,
        snapshot: now.text,
      })),
      truncated: now.truncated,
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

/**
 * Claim one call and answer it from the page this seat holds.
 * @param seat - the live seat, re-read after the claim round trip.
 * @param mounted - whether this seat is still mounted, which bounds the bidding.
 * @param started - the calls this seat has taken up; a call given up on is
 * dropped from it, because it is still open on the host.
 * @param request - the pending call, of either tool.
 * @param access - the node half's budget and deadlines, settled when the seat booted.
 */
async function answer(
  seat: MutableRefObject<ContentReadSeat>,
  mounted: MutableRefObject<boolean>,
  started: MutableRefObject<Set<string>>,
  request: ContentAccessRequest,
  access: ContentFrameAccessSettings,
): Promise<void> {
  const claimed = await claimRead(seat, mounted, request.callId)
  if (claimed === undefined) {
    // Giving up is not answering. Every ending but the call leaving the list —
    // a refused bid, a claim another tab held, the bidding ceiling, a pending
    // list that blipped empty — leaves a call the host is still waiting for, so
    // the seat forgets it and can take it up again.
    started.current.delete(request.callId)
    return
  }
  await reportRead(request.tool === CONTENT_ACT_TOOL_NAME
    ? await actOnPage(seat.current, request, access, claimed.page)
    : await readPage(seat.current, request, access))
}

/**
 * Answer this session's open `content_read` calls from the frames this seat holds.
 *
 * One call is answered at most once from this tab: a call the seat has taken up
 * is remembered until it leaves the pending list, so no amount of re-rendering
 * turns one read into two claims. A claim the host does not know yet is not
 * that failure — it is bid again, at a widening interval, for as long as the
 * call is on the list — and neither is a report that never lands, which is
 * posted once more.
 *
 * A call the bidding gave up on is forgotten instead: it is still open on the
 * host, so the seat must be able to take it up again when the next projection
 * frame carries it. That forgetting happens whether or not this seat can read
 * at all, because a hidden tab that skipped it would leave the call unclaimable
 * for the rest of the seat's life.
 *
 * Each call is answered by background work nobody awaits: this hook returns as
 * soon as the reads are under way, and every result reaches the host over the
 * report route rather than through anything the seat renders.
 * @param seat - what the seat currently holds; re-read live by each running read.
 */
export function useContentRead(seat: ContentReadSeat): void {
  const live = useRef(seat)
  const mounted = useRef(true)
  const started = useRef<Set<string>>(new Set())
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')

  useEffect(() => { live.current = seat })

  // A bid outlives nothing: the loop below runs for as long as its call is
  // pending, and a seat that has gone has no frame to read the page with.
  useEffect(() => () => { mounted.current = false }, [])

  useEffect(() => {
    const onChange = (): void => { setVisible(document.visibilityState === 'visible') }
    document.addEventListener('visibilitychange', onChange)
    return () => { document.removeEventListener('visibilitychange', onChange) }
  }, [])

  useEffect(() => {
    // A call that has left the list has settled and cannot come back, so the
    // memory of having taken it up is dropped with it — a tab left open for a
    // long session would otherwise accumulate one id per read it ever saw. This
    // runs before the two guards below: a seat that cannot read still has to
    // forget, or a call it gave up on while the tab was away stays skipped when
    // the tab comes back with the call still open.
    const open = new Set(seat.pending.map(request => request.callId))
    for (const callId of started.current) {
      if (!open.has(callId)) started.current.delete(callId)
    }
    const access = seat.access
    if (access === undefined || !visible) return
    for (const request of seat.pending) {
      if (started.current.has(request.callId)) continue
      started.current.add(request.callId)
      void answer(live, mounted, started, request, access)
    }
  }, [seat.access, seat.pending, visible])
}
