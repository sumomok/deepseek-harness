/**
 * One point: a pick over the console document, and the reference payload the
 * place picked becomes.
 *
 * A place point-anchor describes becomes its description for a reference
 * without the DataPage row and the count of columns left out of it, held to the
 * console's bound by `toPromptReference`. A place it refuses for one of
 * {@link BLOCK_REASONS} inside a seat of the content column becomes a reference
 * to the whole block around it (`../block.ts`): the block of the component view
 * the click was in, else the seat. Every other refusal stays one.
 *
 * The picker reports no element for a refusal, so the click it takes is read
 * here as well, by a capture listener on the console window added before the
 * picker's own: a page's earlier listeners see the events of a pick first.
 * @module @deepseek-ai/dsh-experimental-content-point/client/pick
 */

import type { PromptReference } from '@deepseek-ai/dsh-attachment'
import { toPromptReference } from '@haoran/dsh-point-anchor'
import type { DescribeRefusal, LabelWords, PointDescription } from '@haoran/dsh-point-anchor'
import { createPicker, DOM_CONTRACT, entryShown, selectedEntry } from '@haoran/dsh-point-anchor/page'
import type { PickOutcome } from '@haoran/dsh-point-anchor/page'
import { blockData, blockLabel } from '../block.ts'
import type { BlockData } from '../block.ts'
import { POINT_SOURCE } from '../text.ts'

/** The attribute each block of the component view carries its component id in. */
export const BLOCK_ATTR = 'data-component-block'

/** The attribute each block of the component view carries its node id in. */
export const NODE_ATTR = 'data-component-node'

/** The refusals inside a seat that point at the whole block around the click instead. */
export const BLOCK_REASONS: ReadonlySet<DescribeRefusal> = new Set(['unsupported-component', 'kit-too-old', 'not-ready', 'unknown-point', 'unknown-model'])

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
  return value as ReferenceData
}

/** How one point ended. */
export type PointOutcome =
  | { readonly kind: 'reference'; readonly label: string; readonly data: ReferenceData }
  | { readonly kind: 'refused'; readonly reason: DescribeRefusal }
  | { readonly kind: 'cancelled' }

/** The names a block reference shows, from the locale. */
export interface BlockNames {
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
  /** The names a block reference shows. */
  readonly names: BlockNames
  /** The tooltip's words for a refusal, over point-anchor's own. */
  readonly refusalWords?: Partial<Record<DescribeRefusal, string>>
  /** The words a place is stated in, point-anchor's when omitted. */
  readonly words?: Partial<LabelWords>
  /** Ends the point as cancelled when aborted. */
  readonly signal?: AbortSignal
}

/**
 * A description for a reference without the DataPage row it may carry.
 * @param point - the description the pick gave.
 * @returns the description without `row` and `rowOmitted`.
 */
export function withoutRow(point: PointDescription): PointDescription {
  return {
    v: point.v,
    anchorFormat: point.anchorFormat,
    what: point.what,
    ...point.anchor !== undefined ? { anchor: point.anchor } : {},
    ...point.unanchored !== undefined ? { unanchored: point.unanchored } : {},
    shown: point.shown,
  }
}

/**
 * The block reference for an element inside a seat of the content column.
 * @param el - the element clicked.
 * @param names - the display names.
 * @returns the reference, or undefined outside every seat.
 */
export function blockAt(el: Element, names: BlockNames): BlockData | undefined {
  const seat = el.closest(`[${DOM_CONTRACT.surfaceSeatAttr}]`)
  const kind = seat?.getAttribute(DOM_CONTRACT.surfaceSeatAttr)
  if (seat === null || kind === null || kind === undefined) return undefined
  const block = el.closest(`[${NODE_ATTR}]`)
  const inSeat = block !== null && seat.contains(block) ? block : undefined
  const component = inSeat?.getAttribute(BLOCK_ATTR) ?? undefined
  const node = inSeat?.getAttribute(NODE_ATTR) ?? undefined
  const selected = selectedEntry(seat.ownerDocument)
  const around = selected === undefined ? {} : entryShown(seat.ownerDocument, selected.kind, selected.entryId)
  return blockData({
    seat: kind,
    component,
    node,
    page: around.page ?? around.nav,
    target: inSeat === undefined ? names.seat(kind) : names.component(component),
  })
}

/**
 * Turn how a pick ended into how the point ended.
 * @param outcome - the pick's outcome.
 * @param clicked - the element the pick's click was on, if one was seen.
 * @param names - the display names.
 * @returns the point's outcome.
 */
export function pointOutcome(outcome: PickOutcome, clicked: Element | undefined, names: BlockNames): PointOutcome {
  switch (outcome.kind) {
    case 'cancelled':
      return { kind: 'cancelled' }
    case 'picked': {
      const reference = toPromptReference(withoutRow(outcome.point), POINT_SOURCE)
      return reference === undefined ? { kind: 'refused', reason: 'too-large' } : { kind: 'reference', label: reference.label, data: asReferenceData(reference.data) }
    }
    case 'refused': {
      const block = BLOCK_REASONS.has(outcome.reason) && clicked !== undefined ? blockAt(clicked, names) : undefined
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
 * Run one point over a console document.
 * @param doc - the console document.
 * @param options - the names, the tooltip's words, and the cancellation.
 * @returns how the point ended.
 */
export async function point(doc: Document, options: PointOptions): Promise<PointOutcome> {
  const view = doc.defaultView
  let clicked: Element | undefined
  const seen = (event: Event): void => {
    const target = event.composedPath()[0]
    if (event.isTrusted && isElement(target)) clicked = target
  }
  // Added before the picker's own capture listener, so it hears the click the pick is taken on.
  view?.addEventListener('click', seen, true)
  try {
    const picker = createPicker(doc, {
      purpose: 'reference',
      ...options.words !== undefined ? { words: options.words } : {},
      ...options.refusalWords !== undefined ? { refusalWords: options.refusalWords } : {},
    })
    const outcome = await picker.start(options.signal)
    return pointOutcome(outcome, clicked, options.names)
  } finally {
    view?.removeEventListener('click', seen, true)
  }
}
