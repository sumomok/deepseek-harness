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
  CLAIM_RETRY_MS, CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE, type ClaimAck, type ReadArgs, type ReadOutcome,
  type ReadPage,
} from '../../access/wire.ts'
import { FRAME_LOADING_MESSAGE, FRAME_RETIRED_MESSAGE, FRAME_UNREACHABLE_MESSAGE } from '../../access/text.ts'
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
 * Post one document to a read route.
 * @param route - the route to post to.
 * @param body - the document.
 * @returns the parsed answer, or `undefined` when the route refused it or could
 * not be reached — both of which leave the call to its own deadline.
 */
async function post<T>(route: string, body: unknown): Promise<T | undefined> {
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!response.ok) return undefined
    return await response.json() as T
  } catch (_hostUnreachable) {
    // Nothing else consumes this: a claim or report that never lands leaves the
    // waiting call to its own deadline, which answers that no console replied.
    return undefined
  }
}

/** Wait one interval before re-claiming. */
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}

/**
 * Win one read, retrying only while the host says it does not know the call yet.
 *
 * That answer is expected on a first claim: the log records `tool/call` — which
 * is what puts the call in this seat's pending list — before the tool body
 * registers the wait.
 * @param seat - the live seat, re-read on every attempt.
 * @param callId - the call to claim.
 * @param readTimeoutMs - the host's own deadline for this call, which bounds the retrying.
 * @returns whether this tab owns the read.
 */
async function claimRead(
  seat: MutableRefObject<ContentReadSeat>,
  callId: string,
  readTimeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + readTimeoutMs
  for (;;) {
    const ack = await post<ClaimAck>(CONTENT_CLAIM_ROUTE, { callId, tabId: seat.current.tabId })
    if (ack?.claimed === true) return true
    if (ack?.reason !== 'unknown') return false
    if (Date.now() + CLAIM_RETRY_MS > deadline) return false
    await delay(CLAIM_RETRY_MS)
    // The result reached the log while this seat waited: the call is over.
    if (!seat.current.pending.some(request => request.callId === callId)) return false
  }
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
  return only === undefined ? {} : { kind: only.kind, title: only.title }
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
  if (frame.contentWindow.document.readyState !== 'complete' && !await whenLoaded(frame, access.readTimeoutMs)) {
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
    return {
      status: 'ok',
      page: seat.page,
      snapshot: {
        kind: read.kind,
        url: read.header.url,
        title: read.header.title,
        ...read.header.breadcrumb === undefined ? {} : { breadcrumb: read.header.breadcrumb },
        ...read.header.modal === undefined ? {} : { modal: read.header.modal },
        signIn: read.header.signIn,
        text: read.text,
        truncated: read.truncated,
        shown: read.shown,
        total: read.total,
        ...read.cursor === undefined ? {} : { cursor: read.cursor },
      },
    }
  } catch (refusal) {
    /* v8 ignore next 2 -- the reader throws Error and nothing else; String() keeps a thrown non-Error readable. */
    const message = refusal instanceof Error ? refusal.message : String(refusal)
    return { status: 'error', code: 'engine', message }
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
  if (!await claimRead(seat, request.callId, access.readTimeoutMs)) return
  const outcome = await readPage(seat.current, request.args, access)
  await post(CONTENT_REPORT_ROUTE, { callId: request.callId, tabId: seat.current.tabId, outcome })
}

/**
 * Answer this session's open `content_read` calls from the frames this seat holds.
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
    for (const request of seat.pending) {
      if (started.current.has(request.callId)) continue
      started.current.add(request.callId)
      void answer(live, request, access)
    }
  }, [seat.access, seat.pending, visible])
}
