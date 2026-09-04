/**
 * What one element on the page exports as a picture, and at what size.
 *
 * Every decision an export makes is here — which elements have pixels of their
 * own, whether the page is showing this one, what size the pixels come out at,
 * and which endings the model is told about — and no drawing is. The drawing
 * itself is one injected function (`./export-pixels.ts`), because a DOM
 * implementation with no canvas can run every decision below and none of it.
 *
 * The export reads and never writes. Nothing is added to the frame's document,
 * no attribute is touched, and nothing here can wake the change watch a read
 * waits on: the surface the pixels are drawn onto belongs to the seat and is
 * never part of the page.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/capture
 */

import {
  CAPTURE_MEDIA_TYPES, forWire, IMAGE_PIXEL_BUDGET, MAX_CURSOR_CHARS, MAX_EXPORT_BYTES, SVG_RASTER_MIN_PIXELS,
  type CaptureMediaType, type ImageSize,
} from '../../access/wire.ts'
import {
  emptyImageRefusal, hiddenImageRefusal, notAnImageRefusal, slowImageRefusal, taintedImageRefusal,
  unexportableImageRefusal, unloadedImageRefusal, wideImageRefusal,
} from '../../access/text.ts'
import { isSkipped } from './dom.ts'

/**
 * The tags whose whole content is pixels a browser can hand back. `picture` is
 * absent because it draws nothing itself: it chooses a source for the `img`
 * inside it, and that `img` is what has the pixels.
 */
const DRAWN_TAGS: readonly string[] = ['img', 'canvas', 'svg']

/** The tag that draws through the `img` it wraps. */
const WRAPPER_TAG = 'picture'

/** The one tag whose size is a layout box rather than a stored raster. */
const VECTOR_TAG = 'svg'

/** One export's bytes, and what the browser actually encoded them as. */
export interface ExportedImage {
  /** The bytes, base64. */
  readonly data: string
  /**
   * The media type read back off the exported blob rather than the one asked
   * for: an engine that does not support a requested type encodes something
   * else, and reporting the request would describe bytes nobody produced.
   */
  readonly mediaType: string
  /** How many bytes those characters decode to. */
  readonly bytes: number
}

/**
 * Draw one element at a given size and encode the result.
 *
 * Injected rather than called directly, for one reason: a DOM implementation
 * without a canvas cannot draw at all, and this package takes no native canvas
 * dependency to give one to a test. `./export-pixels.ts` is the browser's own.
 * @param el - the element to draw: an `img`, a `canvas`, or an `svg`.
 * @param size - the size to draw it at.
 * @returns the encoded bytes.
 * @throws a `SecurityError` when another origin's pixels marked the surface.
 */
export type ExportPixels = (el: Element, size: ImageSize) => Promise<ExportedImage>

/** What one export produced, or why there was nothing to produce. */
export type Capture =
  | {
    /** Discriminant: the element's pixels are here. */
    readonly kind: 'captured'
    /** The tag the ref named, which for a wrapper is the wrapper's own. */
    readonly tag: string
    /** The element's own pixel size, before this export scaled it. */
    readonly natural: ImageSize
    /** What the browser encoded the pixels as, read back off the exported blob. */
    readonly mediaType: CaptureMediaType
    /** The bytes, base64. */
    readonly data: string
  }
  | {
    /** Discriminant: there are no pixels, and this is what the model is told. */
    readonly kind: 'refused'
    /** The model-facing sentence. */
    readonly message: string
  }

/** What the reader needs of the seat to run one export. */
export interface CaptureOptions {
  /** The ref the read named, which every refusal opens with. */
  readonly ref: string
  /** Injected visibility, the same one every other read of the page is measured by. */
  readonly isVisible: (el: Element) => boolean
  /** The browser's own drawing. */
  readonly draw: ExportPixels
  /**
   * How long the drawing may take before this read gives up on it, which is the
   * share of the call's own deadline the export gets.
   */
  readonly budgetMs: number
}

/**
 * The element whose pixels answer for the one a ref named.
 * @param el - the element the ref named.
 * @returns that element, the `img` a `picture` renders through, or `undefined`
 * for an element that draws no picture of its own.
 */
function drawnElement(el: Element): Element | undefined {
  if (el.localName === WRAPPER_TAG) return el.querySelector('img') ?? undefined
  return DRAWN_TAGS.includes(el.localName) ? el : undefined
}

/**
 * The pixel size one element has of its own.
 *
 * A bitmap has a stored raster and answers with it; a vector has none, so its
 * layout box is the only size it has. The box is rounded rather than truncated
 * because a browser lays out in fractions and a canvas has whole pixels.
 * @param el - the element being exported.
 * @returns its own size, which may be zero for an element the page draws nothing in.
 */
function naturalSize(el: Element): ImageSize {
  if (el.localName === 'img') {
    const image = el as HTMLImageElement
    return { width: image.naturalWidth, height: image.naturalHeight }
  }
  if (el.localName === 'canvas') {
    const drawing = el as HTMLCanvasElement
    return { width: drawing.width, height: drawing.height }
  }
  const box = el.getBoundingClientRect()
  return { width: Math.round(box.width), height: Math.round(box.height) }
}

/**
 * Scale one size up to a pixel floor, keeping its ratio.
 * @param size - the source size.
 * @param floor - the total pixels to reach.
 * @returns the raised size, or the source when it is already at or past the floor.
 */
function raiseTo(size: ImageSize, floor: number): ImageSize {
  const pixels = size.width * size.height
  if (pixels >= floor) return size
  const scale = Math.sqrt(floor / pixels)
  return { width: Math.round(size.width * scale), height: Math.round(size.height * scale) }
}

/**
 * Scale one size down inside a pixel budget, keeping its ratio.
 *
 * The same geometry the attachment layer projects a request image with
 * (`requestImageDimensions` in `@deepseek-ai/dsh-attachment`), restated rather
 * than imported: that package is the host's, and this runs in a browser. The
 * long side is floored and the short one rounded off it, then walked down until
 * the product is inside the budget — rounding one axis can otherwise put the
 * pair back over it.
 * @param size - the source size.
 * @param budget - the total pixels the export may come to.
 * @returns the lowered size, or the source when it is already inside the budget.
 */
function lowerTo(size: ImageSize, budget: number): ImageSize {
  const scale = Math.min(1, Math.sqrt(budget / (size.width * size.height)))
  if (scale === 1) return size
  const wide = size.width >= size.height
  const long = wide ? size.width : size.height
  const short = wide ? size.height : size.width
  let projected = Math.max(1, Math.floor(long * scale))
  let other = Math.max(1, Math.round(projected * short / long))
  while (projected * other > budget && projected > 1) {
    projected -= 1
    other = Math.max(1, Math.round(projected * short / long))
  }
  return wide ? { width: projected, height: other } : { width: other, height: projected }
}

/**
 * The size one element's pixels are exported at.
 *
 * A bitmap is never enlarged: the provider scales a small image up before it
 * prices one, so enlarging here would add bytes and no information and no
 * detail. A vector is enlarged, because it has detail at every size and
 * rasterizing it at its layout box would throw away what the provider's own
 * floor is about to ask for. Both are then held to the request's pixel budget.
 * @param natural - the element's own size.
 * @param vector - whether the element is drawn from a vector.
 * @returns the size to draw at.
 */
export function exportSize(natural: ImageSize, vector: boolean): ImageSize {
  return lowerTo(vector ? raiseTo(natural, SVG_RASTER_MIN_PIXELS) : natural, IMAGE_PIXEL_BUDGET)
}

/**
 * Whether one thrown value is the browser refusing to hand back pixels another
 * origin supplied.
 *
 * The name is read off the value rather than tested by class, because a
 * `DOMException` is not an `Error` in every engine. It is read unguarded
 * because every value this can see was thrown by the injected drawing, whose
 * own two failures and the browser's are all objects; a value that is not one
 * makes this read throw, and the reader reports that the way it reports every
 * other failure of the drawing.
 * @param refusal - whatever the drawing threw.
 * @returns whether it is that refusal.
 */
function isTaint(refusal: unknown): boolean {
  return (refusal as { name?: unknown }).name === 'SecurityError'
}

/**
 * Draw one element inside the deadline the read gave the export.
 *
 * The drawing is not cancelled, because nothing in a browser cancels one: a
 * `toBlob` or an `image.decode()` that never settles stays pending for the life
 * of the tab. What the deadline ends is this read's wait for it, so the seat
 * posts a refusal naming the picture instead of posting nothing and leaving the
 * host to end the call as a console that went quiet. A drawing that finishes
 * after the deadline resolves into the race that already settled, which is
 * where its value and its throw are both absorbed.
 * @param el - the element to draw.
 * @param size - the size to draw it at.
 * @param options - the injected drawing and its deadline.
 * @returns the export, or `undefined` when the deadline came first.
 * @throws whatever the drawing threw, when it threw inside the deadline.
 */
async function drawWithin(el: Element, size: ImageSize, options: CaptureOptions): Promise<ExportedImage | undefined> {
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      options.draw(el, size),
      new Promise<undefined>((resolve) => { deadline = setTimeout(() => { resolve(undefined) }, options.budgetMs) }),
    ])
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * Export one element's own rendered pixels, or say why there are none.
 *
 * The order of the checks is the order in which each becomes knowable, and each
 * refusal states the condition it found rather than what to do about it.
 * @param el - the element the ref named.
 * @param options - the ref, the injected visibility, and the browser's drawing.
 * @returns the pixels, or the refusal.
 * @throws whatever the drawing threw, other than the cross-origin refusal —
 * that is the reader failing, and the seat reports it as such.
 */
export async function captureElement(el: Element, options: CaptureOptions): Promise<Capture> {
  const { ref } = options
  // The page names its own tags and a custom element's name has no length of
  // its own, so the tag is taken here, where it is read, to the bound the
  // parser holds a posted `tag` to and the route's envelope was sized against:
  // both the refusal below and the arm the seat posts carry it.
  const tag = forWire(el.localName, MAX_CURSOR_CHARS)
  const drawn = drawnElement(el)
  if (drawn === undefined) return { kind: 'refused', message: notAnImageRefusal(ref, tag) }
  if (isSkipped(drawn, options.isVisible)) return { kind: 'refused', message: hiddenImageRefusal(ref) }
  const image = drawn as HTMLImageElement
  if (drawn.localName === 'img' && !(image.complete && image.naturalWidth > 0)) {
    return { kind: 'refused', message: unloadedImageRefusal(ref) }
  }
  const natural = naturalSize(drawn)
  if (natural.width <= 0 || natural.height <= 0) return { kind: 'refused', message: emptyImageRefusal(ref) }
  let exported: ExportedImage | undefined
  try {
    exported = await drawWithin(drawn, exportSize(natural, drawn.localName === VECTOR_TAG), options)
  } catch (refusal) {
    // The one throw this read can describe: a browser marks the surface the
    // moment another origin's pixels reach it and refuses to hand them back.
    if (!isTaint(refusal)) throw refusal
    return { kind: 'refused', message: taintedImageRefusal(ref) }
  }
  if (exported === undefined) return { kind: 'refused', message: slowImageRefusal(ref, options.budgetMs) }
  const mediaType = CAPTURE_MEDIA_TYPES.find(known => known === exported.mediaType)
  if (mediaType === undefined) return { kind: 'refused', message: unexportableImageRefusal(ref, exported.mediaType) }
  if (exported.bytes > MAX_EXPORT_BYTES) {
    return { kind: 'refused', message: wideImageRefusal(ref, exported.bytes, MAX_EXPORT_BYTES) }
  }
  return { kind: 'captured', tag, natural, mediaType, data: exported.data }
}
