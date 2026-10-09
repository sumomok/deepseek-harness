/**
 * A reference to one block of the content column as a whole: the seat holding
 * it; for an original-system page, the content-frame page id; for a block of
 * the component view, the component it draws and its node id. It is what a
 * point records where `@haoran/dsh-point-anchor` describes nothing finer — a
 * form page, an info card, a chart, a block whose component this build does
 * not describe, a seat holding no block, a place of an original-system page
 * the reader names nothing for or may not read — and it carries only the
 * page's structure: the attribute values the seat, the frame and the component
 * row write, the switcher entry's title, and a display name from the locale.
 *
 * `data` is durable, recorded verbatim on the accepted user message, so the
 * read refuses anything this build would not have written.
 * @module @deepseek-ai/dsh-experimental-content-point/block
 */

import { keyValue, sanitizeLabel } from '@haoran/dsh-point-anchor'

/** The format this build writes a block reference in, and the only one it reads. */
export const BLOCK_FORMAT = 1

/** The `kind` field that tells a block reference from a point-anchor description, which carries none. */
export const BLOCK_KIND = 'block'

/** Longest seat kind, component id or node id, in code points; longer ones are not the page's structure. */
export const BLOCK_ID_CODE_POINTS = 128

/** Longest display value, in code points: point-anchor's bound for `shown`. */
export const BLOCK_SHOWN_CODE_POINTS = 64

/** Display text of a block reference. */
export interface BlockShown {
  /** The switcher entry's title, when one is selected. */
  readonly page?: string
  /** What the block is: the component's display name, or the seat's. */
  readonly target?: string
}

/** One block reference, fields in the order {@link blockData} writes them. */
export interface BlockData {
  readonly v: typeof BLOCK_FORMAT
  readonly kind: typeof BLOCK_KIND
  /** The `data-content-surface-seat` value of the seat holding the block. */
  readonly seat: string
  /** The content-frame page id, from the frame's `data-content-frame-id`; for an original-system page only. */
  readonly page?: string
  /** The `data-component-block` value, the component id the block draws; absent for a seat without one. */
  readonly component?: string
  /** The `data-component-node` value, the block's node id in its view; absent where the block carries none. */
  readonly node?: string
  readonly shown: BlockShown
}

/** What {@link blockData} builds a reference from. */
export interface BlockPlace {
  readonly seat: string
  readonly pageId?: string | undefined
  readonly component?: string | undefined
  readonly node?: string | undefined
  readonly page?: string | undefined
  readonly target?: string | undefined
}

/** Seat kinds, component ids and node ids: one token the page writes as an attribute value. */
const ID = /^[^\s\p{Cc}\p{Cf}\p{Cs}]+$/u

/**
 * Whether a string is one id a block reference may carry.
 * @param value - the candidate.
 * @returns the answer.
 */
function isId(value: string): boolean {
  return ID.test(value) && Array.from(value).length <= BLOCK_ID_CODE_POINTS
}

/**
 * Clean one display value; an empty result is left out.
 * @param value - the raw text.
 * @returns the cleaned text, or undefined.
 */
function shownText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const cleaned = sanitizeLabel(value, BLOCK_SHOWN_CODE_POINTS)
  return cleaned === '' ? undefined : cleaned
}

/**
 * Build a block reference, ids that are no single token left out.
 * @param place - the seat, the block's ids, and the display text.
 * @returns the reference, or undefined when the seat kind is no single token.
 */
export function blockData(place: BlockPlace): BlockData | undefined {
  if (!isId(place.seat)) return undefined
  const page = shownText(place.page)
  const target = shownText(place.target)
  return {
    v: BLOCK_FORMAT,
    kind: BLOCK_KIND,
    seat: place.seat,
    ...place.pageId !== undefined && isId(place.pageId) ? { page: place.pageId } : {},
    ...place.component !== undefined && isId(place.component) ? { component: place.component } : {},
    ...place.node !== undefined && isId(place.node) ? { node: place.node } : {},
    shown: { ...page !== undefined ? { page } : {}, ...target !== undefined ? { target } : {} },
  }
}

/** Why a logged value is no block reference this build reads. */
export type BlockProblem =
  | { readonly kind: 'format'; readonly stated: number }
  | { readonly kind: 'invalid'; readonly field: string }

/** A read block reference, or why it is none. */
export type BlockParsed = { readonly ok: true; readonly value: BlockData } | { readonly ok: false; readonly problem: BlockProblem }

/** Every key a block reference may hold. */
const KEYS: ReadonlySet<string> = new Set(['v', 'kind', 'seat', 'page', 'component', 'node', 'shown'])

/** Every key `shown` may hold. */
const SHOWN_KEYS: ReadonlySet<string> = new Set(['page', 'target'])

/**
 * Whether a value is a plain JSON object.
 * @param value - the candidate.
 * @returns the answer.
 */
function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a value is a display value {@link blockData} could have written.
 * @param value - the candidate.
 * @returns the answer.
 */
function isShownValue(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && Array.from(value).length <= BLOCK_SHOWN_CODE_POINTS
    && sanitizeLabel(value, BLOCK_SHOWN_CODE_POINTS) === value
}

/**
 * Read a logged reference payload strictly as a block reference: an unknown
 * key, an id that is no single token, display text this build would have
 * cleaned, or a format other than {@link BLOCK_FORMAT} is refused.
 * @param data - the payload.
 * @returns the reference, or why it is none.
 */
export function parseBlockData(data: unknown): BlockParsed {
  const invalid = (field: string): BlockParsed => ({ ok: false, problem: { kind: 'invalid', field } })
  if (!isRecord(data)) return invalid('data')
  if (typeof data['v'] === 'number' && Number.isInteger(data['v']) && data['v'] !== BLOCK_FORMAT) {
    return { ok: false, problem: { kind: 'format', stated: data['v'] } }
  }
  if (data['v'] !== BLOCK_FORMAT) return invalid('v')
  for (const key of Object.keys(data)) if (!KEYS.has(key)) return invalid(key)
  if (data['kind'] !== BLOCK_KIND) return invalid('kind')
  const { seat, page, component, node, shown } = data
  if (typeof seat !== 'string' || !isId(seat)) return invalid('seat')
  if (page !== undefined && (typeof page !== 'string' || !isId(page))) return invalid('page')
  if (component !== undefined && (typeof component !== 'string' || !isId(component))) return invalid('component')
  if (node !== undefined && (typeof node !== 'string' || !isId(node))) return invalid('node')
  if (!isRecord(shown)) return invalid('shown')
  for (const key of Object.keys(shown)) if (!SHOWN_KEYS.has(key)) return invalid(`shown.${key}`)
  if (shown['page'] !== undefined && !isShownValue(shown['page'])) return invalid('shown.page')
  if (shown['target'] !== undefined && !isShownValue(shown['target'])) return invalid('shown.target')
  return {
    ok: true,
    value: {
      v: BLOCK_FORMAT,
      kind: BLOCK_KIND,
      seat,
      ...page !== undefined ? { page } : {},
      ...component !== undefined ? { component } : {},
      ...node !== undefined ? { node } : {},
      shown: {
        ...shown['page'] !== undefined ? { page: shown['page'] } : {},
        ...shown['target'] !== undefined ? { target: shown['target'] } : {},
      },
    },
  }
}

/**
 * The key line of a block reference: `block`, then `seat`, `page`, `component`
 * and `node` as present, each value written as point-anchor writes a key line's.
 * @param data - the reference.
 * @returns the key line.
 */
export function blockKey(data: BlockData): string {
  const fields = [['seat', data.seat], ['page', data.page], ['component', data.component], ['node', data.node]] as const
  return ['block', ...fields.flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${keyValue(value)}`]))].join(' ')
}

/**
 * The chip label of a block reference: what the block is, else the seat kind.
 * @param data - the reference.
 * @returns the label, 1–64 code points.
 */
export function blockLabel(data: BlockData): string {
  return data.shown.target ?? data.seat
}
