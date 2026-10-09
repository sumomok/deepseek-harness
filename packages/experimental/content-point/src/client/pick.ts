/**
 * One point: a pick over the console document, and the reference payload the
 * place picked becomes.
 *
 * A place point-anchor describes becomes its description as `../place.ts`
 * lets a reference carry it — no DataPage row, no record text of an
 * original-system page — held to the console's bound by `toPromptReference`.
 * A place it refuses for one of {@link WHOLE_BLOCK_REASONS} inside a seat of
 * the content column becomes a reference to the whole block around it
 * (`../block.ts`): the block of the component view the click was in, the
 * original-system page it was on, else the seat. Every other refusal stays one.
 *
 * The picker reports no element for a refusal, so the click it takes is read
 * here as well, by capture listeners added before the picker's own on the
 * console window and on every frame window it can reach: a page's earlier
 * listeners see the events of a pick first. A cross-origin frame's click lands
 * on the shield the picker draws over it, and is placed by its coordinates. A
 * trusted click on the 「指一下」 button itself ends the point as cancelled.
 * @module @deepseek-ai/dsh-experimental-content-point/client/pick
 */

import type { PromptReference } from '@deepseek-ai/dsh-attachment'
import { toPromptReference } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal, LabelWords, PointDescription } from '@haoran/dsh-point-anchor'
import { createPicker, DOM_CONTRACT, entryShown, selectedEntry } from '@haoran/dsh-point-anchor/page'
import type { PickOutcome } from '@haoran/dsh-point-anchor/page'
import { blockData, blockLabel } from '../block.ts'
import type { BlockData } from '../block.ts'
import { forReference, placeLabel } from '../place.ts'
import type { PlaceWords } from '../place.ts'
import { POINT_SOURCE } from '../text.ts'

/** The attribute each block of the component view carries its component id in. */
export const BLOCK_ATTR = 'data-component-block'

/** The attribute each block of the component view carries its node id in. */
export const NODE_ATTR = 'data-component-node'

/** The attribute the 「指一下」 button carries; a click on it during a point cancels the point. */
export const BUTTON_ATTR = 'data-content-point-button'

/** The refusals inside the component view that point at the whole block around the click instead. */
export const BLOCK_REASONS: ReadonlySet<DescribeRefusal> = new Set(['unsupported-component', 'kit-too-old', 'not-ready', 'unknown-point', 'unknown-model'])

/** The refusals on an original-system page that point at the whole page instead: nothing named there, or a frame this page may not read. */
export const FRAME_BLOCK_REASONS: ReadonlySet<DescribeRefusal> = new Set(['nameless', 'no-column', 'unreadable-frame'])

/** Every refusal that becomes a block reference inside a seat; the picker states each of them as the whole block. */
export const WHOLE_BLOCK_REASONS: ReadonlySet<DescribeRefusal> = new Set([...BLOCK_REASONS, ...FRAME_BLOCK_REASONS])

/** A reference payload as the composer records it. */
export type ReferenceData = PromptReference['data']

/**
 * A point-anchor description or a block reference as a reference payload. Both
 * are JSON objects of strings, numbers and nested such objects, which is what
 * the payload type spells out; they are declared as interfaces, which carry no
 * index signature, so the type is stated here once.
 * @param value - the description or block reference.
 * @returns the same object as a payload.
 */
function asReferenceData(value: PointDescription | BlockData): ReferenceData {
  const plain: object = value
  return plain as ReferenceData
}

/** How one point ended. */
export type PointOutcome =
  | { readonly kind: 'reference'; readonly label: string; readonly data: ReferenceData }
  | { readonly kind: 'refused'; readonly reason: DescribeRefusal }
  | { readonly kind: 'cancelled' }

/** The names a reference shows that the locale holds. */
export interface PointNames extends PlaceWords {
  /**
   * The display name of a component the view draws.
   * @param component - the component id, or undefined for a block that carries none.
   * @returns the name.
   */
  readonly component: (component: string | undefined) => string
  /**
   * The display name of a seat holding no block.
   * @param seat - the seat kind.
   * @returns the name.
   */
  readonly seat: (seat: string) => string
}

/** What a point runs with. */
export interface PointOptions {
  /** The names a reference shows. */
  readonly names: PointNames
  /** The tooltip's words for a refusal, over point-anchor's own. */
  readonly refusalWords?: Partial<Record<DescribeRefusal, string>>
  /** The words the tooltip and the label state a place in, point-anchor's when omitted. */
  readonly words?: Partial<LabelWords>
  /** Ends the point as cancelled when aborted. */
  readonly signal?: AbortSignal
}

/** The click a pick was taken on, as the point's own listeners saw it. */
export interface Clicked {
  /** The element clicked, in whichever document the click was. */
  readonly element: Element
  /** The pointer's position in the viewport of that document, for a mouse event. */
  readonly x?: number
  readonly y?: number
}

/**
 * The element of the console document an element is in: itself, or the frame
 * element around the document it is in, frame by frame up to the outermost
 * document within reach, which is the console's.
 * @param el - the element.
 * @returns the element.
 */
function consoleElement(el: Element): Element {
  let current = el
  let frame = current.ownerDocument.defaultView?.frameElement ?? null
  while (frame !== null) {
    current = frame
    frame = current.ownerDocument.defaultView?.frameElement ?? null
  }
  return current
}

/**
 * The seat around an element of the console document.
 * @param el - the element.
 * @returns the seat, or null outside every seat.
 */
function seatOf(el: Element): Element | null {
  return el.closest(`[${DOM_CONTRACT.surfaceSeatAttr}]`)
}

/**
 * The elements under a point of the console document's viewport, topmost first.
 * @param doc - the console document.
 * @param x - the point's x.
 * @param y - the point's y.
 * @returns the elements, none where the document cannot say.
 */
function elementsAt(doc: Document, x: number, y: number): readonly Element[] {
  try {
    return doc.elementsFromPoint(x, y)
  } catch (_error) {
    // A document without layout (jsdom) answers nothing here; the click then places nothing.
    return []
  }
}

/**
 * The content-frame page id of a frame element, from its `data-content-frame-id` key.
 * @param el - the element around the place.
 * @returns the page id, or undefined outside every page frame.
 */
function framePageId(el: Element): string | undefined {
  const key = el.closest(`[${DOM_CONTRACT.frameAttr}]`)?.getAttribute(DOM_CONTRACT.frameIdAttr) ?? ''
  const prefix = `${DOM_CONTRACT.pageKind} `
  return key.startsWith(prefix) ? key.slice(prefix.length) : undefined
}

/**
 * The block reference for an element inside a seat of the content column.
 * @param el - the element of the console document the click was on.
 * @param names - the display names.
 * @returns the reference, or undefined outside every seat.
 */
export function blockAt(el: Element, names: PointNames): BlockData | undefined {
  const seat = seatOf(el)
  const kind = seat?.getAttribute(DOM_CONTRACT.surfaceSeatAttr)
  if (seat === null || kind === null || kind === undefined) return undefined
  const doc = seat.ownerDocument
  const block = el.closest(`[${NODE_ATTR}]`)
  const inSeat = block !== null && seat.contains(block) ? block : undefined
  const component = inSeat?.getAttribute(BLOCK_ATTR) ?? undefined
  const node = inSeat?.getAttribute(NODE_ATTR) ?? undefined
  const selected = selectedEntry(doc)
  const pageId = kind === DOM_CONTRACT.pageKind
    ? framePageId(el) ?? (selected?.kind === DOM_CONTRACT.pageKind ? selected.entryId : undefined)
    : undefined
  const around = pageId !== undefined
    ? entryShown(doc, DOM_CONTRACT.pageKind, pageId)
    : selected === undefined ? {} : entryShown(doc, selected.kind, selected.entryId)
  return blockData({
    seat: kind,
    pageId,
    component,
    node,
    page: around.page ?? around.nav,
    target: inSeat === undefined ? names.seat(kind) : names.component(component),
  })
}

/**
 * The block reference for the click a refused pick was taken on: the element's
 * own seat, through the frames around it; else, for a click on a cross-origin
 * frame's shield, the seat of what lies under the pointer.
 * @param clicked - the click.
 * @param names - the display names.
 * @returns the reference, or undefined outside every seat.
 */
function blockFor(clicked: Clicked, names: PointNames): BlockData | undefined {
  const el = consoleElement(clicked.element)
  const block = blockAt(el, names)
  if (block !== undefined || clicked.x === undefined || clicked.y === undefined) return block
  const under = elementsAt(el.ownerDocument, clicked.x, clicked.y).find(item => seatOf(item) !== null)
  return under === undefined ? undefined : blockAt(under, names)
}

/**
 * Turn how a pick ended into how the point ended.
 * @param outcome - the pick's outcome.
 * @param clicked - the click the pick was taken on, if one was seen.
 * @param names - the display names.
 * @param words - the words a label is stated in, point-anchor's when omitted.
 * @returns the point's outcome.
 */
export function pointOutcome(
  outcome: PickOutcome,
  clicked: Clicked | undefined,
  names: PointNames,
  words?: Partial<LabelWords>,
): PointOutcome {
  switch (outcome.kind) {
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'picked': {
      const reference = toPromptReference(forReference(outcome.point), POINT_SOURCE, words)
      if (reference === undefined) return { kind: 'refused', reason: 'too-large' }
      return { kind: 'reference', label: placeLabel(reference.data, names) ?? reference.label, data: asReferenceData(reference.data) }
    }
    case 'refused': {
      const block = WHOLE_BLOCK_REASONS.has(outcome.reason) && clicked !== undefined ? blockFor(clicked, names) : undefined
      return block === undefined ? { kind: 'refused', reason: outcome.reason } : { kind: 'reference', label: blockLabel(block), data: asReferenceData(block) }
    }
  }
}

/**
 * Whether an event target is an element, in whichever window it was made.
 * @param target - the target.
 * @returns the answer.
 */
function isElement(target: EventTarget | undefined): target is Element {
  return target !== undefined && (target as Partial<Node>).nodeType === 1
}

/**
 * The console window and every frame window reachable from it: the windows a
 * click of the pick can be heard in.
 * @param doc - the console document.
 * @returns the windows, the console's first.
 */
function reachableWindows(doc: Document): Window[] {
  const windows: Window[] = []
  const documents = [doc]
  for (const current of documents) {
    if (current.defaultView !== null) windows.push(current.defaultView)
    for (const frame of current.querySelectorAll('iframe, frame')) {
      const inner = (frame as HTMLIFrameElement).contentDocument
      if (inner !== null) documents.push(inner)
    }
  }
  return windows
}

/**
 * Run one point over a console document.
 * @param doc - the console document.
 * @param options - the names, the tooltip's words, and the cancellation.
 * @returns how the point ended.
 */
export async function point(doc: Document, options: PointOptions): Promise<PointOutcome> {
  const controller = new AbortController()
  const stop = (): void => { controller.abort() }
  if (options.signal?.aborted === true) stop()
  options.signal?.addEventListener('abort', stop)
  let clicked: Clicked | undefined
  const seen = (event: MouseEvent): void => {
    const target = event.composedPath()[0]
    if (!event.isTrusted || !isElement(target)) return
    if (target.closest(`[${BUTTON_ATTR}]`) !== null) {
      stop()
      return
    }
    clicked = { element: target, x: event.clientX, y: event.clientY }
  }
  // Added before the picker's own capture listeners, so they hear the click the pick is taken on first.
  const windows = reachableWindows(doc)
  for (const view of windows) view.addEventListener('click', seen, true)
  try {
    const picker = createPicker(doc, {
      purpose: 'reference',
      ...options.words !== undefined ? { words: options.words } : {},
      ...options.refusalWords !== undefined ? { refusalWords: options.refusalWords } : {},
    })
    const outcome = await picker.start(controller.signal)
    return pointOutcome(outcome, clicked, options.names, options.words)
  } finally {
    for (const view of windows) view.removeEventListener('click', seen, true)
    options.signal?.removeEventListener('abort', stop)
  }
}
