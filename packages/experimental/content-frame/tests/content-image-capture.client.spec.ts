// @vitest-environment jsdom
/**
 * What an export decides before a browser draws anything: which elements have
 * pixels of their own, whether the page is showing this one, what size the
 * pixels come out at, how long it waits for the drawing, and which endings the
 * model is told about.
 *
 * The drawing itself is a stub here for the reason the module states — jsdom
 * has no canvas, and this package takes no native canvas dependency to give it
 * one — so what a stub records is exactly the request a browser would receive:
 * which element, at what size.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  captureElement, exportSpec, type Capture, type ExportedImage, type ExportPixels, type ExportSpec,
} from '../src/client/access/capture.ts'
import {
  emptyImageRefusal, hiddenImageRefusal, notAnImageRefusal, slowImageRefusal, taintedImageRefusal,
  unexportableImageRefusal, unloadedImageRefusal, wideImageRefusal,
} from '../src/access/text.ts'
import {
  IMAGE_MEDIA_TYPE, IMAGE_PIXEL_BUDGET, MAX_CURSOR_CHARS, MAX_EXPORT_BYTES, RASTER_MIN_SIDE, type ImageSize,
} from '../src/access/wire.ts'

/** The ref every case here names, which every refusal opens with. */
const REF = 'e12'

/** What a browser hands back for a picture it drew. */
const DRAWN: ExportedImage = { data: 'AAAA', mediaType: IMAGE_MEDIA_TYPE, bytes: 3 }

/**
 * The export deadline every case here runs under: past anything a drawing that
 * answers at all takes, and short enough for the one case that waits it out.
 */
const BUDGET_MS = 40

/** Every drawing the stub was asked for, in order. */
let asked: { el: Element; spec: ExportSpec }[] = []

beforeEach(() => {
  asked = []
  document.body.innerHTML = ''
})

/**
 * A drawing that records what it was asked for and answers with one export.
 * @param exported - what the browser is standing in to have produced.
 * @returns the injected drawing.
 */
function draws(exported: ExportedImage = DRAWN): ExportPixels {
  return (el, spec) => {
    asked.push({ el, spec })
    return Promise.resolve(exported)
  }
}

/**
 * Export one element with the recording drawing.
 * @param el - the element the ref names.
 * @param draw - the drawing to inject.
 * @param visible - injected visibility.
 * @returns what the export produced.
 */
function capture(
  el: Element,
  draw: ExportPixels = draws(),
  visible: (target: Element) => boolean = () => true,
): Promise<Capture> {
  return captureElement(el, { ref: REF, isVisible: visible, draw, budgetMs: BUDGET_MS })
}

/**
 * Mount one fragment and answer with the element the case is about.
 * @param html - the fragment.
 * @param selector - what to read out of it.
 * @returns that element.
 */
function mount(html: string, selector: string): Element {
  document.body.innerHTML = html
  const el = document.body.querySelector(selector)
  if (el === null) throw new Error(`the fixture has no ${selector}`)
  return el
}

/**
 * Give one element a stored raster the way a decoded picture has one; jsdom
 * decodes nothing and reports every image as zero by zero.
 * @param el - the `img` element.
 * @param size - the raster to report.
 */
function decoded(el: Element, size: ImageSize): void {
  Object.defineProperty(el, 'complete', { value: true })
  Object.defineProperty(el, 'naturalWidth', { value: size.width })
  Object.defineProperty(el, 'naturalHeight', { value: size.height })
}

/**
 * Give one element a layout box; jsdom lays nothing out and reports every box
 * as zero by zero.
 * @param el - the element.
 * @param size - the box to report.
 */
function laidOut(el: Element, size: ImageSize): void {
  el.getBoundingClientRect = () => ({
    width: size.width,
    height: size.height,
    x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height,
    toJSON: () => ({}),
  })
}

/** The message one refused export answers with. */
function refusal(capture: Capture): string {
  if (capture.kind !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(capture)}`)
  return capture.message
}

describe('what one element exports as a picture', () => {
  it('exports a decoded image at its own stored size when no whole multiple of it fits the floor', async () => {
    const el = mount('<img src="/qr.png" alt="">', 'img')
    decoded(el, { width: 240, height: 240 })
    const answer = await capture(el)
    expect(answer).toEqual({
      kind: 'captured',
      tag: 'img',
      natural: { width: 240, height: 240 },
      mediaType: IMAGE_MEDIA_TYPE,
      data: DRAWN.data,
    })
    expect(asked).toEqual([{ el, spec: { size: { width: 240, height: 240 }, smooth: true } }])
  })

  it('exports a small image at a whole multiple of itself, reporting the raster it stores', async () => {
    const el = mount('<img src="/logo.png" alt="">', 'img')
    decoded(el, { width: 32, height: 32 })
    expect(await capture(el)).toMatchObject({ kind: 'captured', tag: 'img', natural: { width: 32, height: 32 } })
    // Twelve times over, with the browser told to invent nothing between two
    // stored pixels.
    expect(asked).toEqual([{ el, spec: { size: { width: 384, height: 384 }, smooth: false } }])
  })

  it('exports the image a picture element renders through, under the wrapper\'s own tag', async () => {
    const el = mount('<picture><source srcset="/qr.webp"><img src="/qr.png" alt=""></picture>', 'picture')
    const image = el.querySelector('img')
    if (image === null) throw new Error('the fixture lost its image')
    decoded(image, { width: 64, height: 64 })
    const answer = await capture(el)
    expect(answer).toMatchObject({ kind: 'captured', tag: 'picture', natural: { width: 64, height: 64 } })
    // The wrapper draws nothing itself; what the browser is asked for is the
    // image inside it.
    expect(asked[0]?.el).toBe(image)
  })

  it('refuses a picture element the page gave no image', async () => {
    const el = mount('<picture><source srcset="/qr.webp"></picture>', 'picture')
    expect(refusal(await capture(el))).toBe(notAnImageRefusal(REF, 'picture'))
  })

  it('refuses an element that draws no picture of its own', async () => {
    expect(refusal(await capture(mount('<div>ops</div>', 'div')))).toBe(notAnImageRefusal(REF, 'div'))
  })

  it('refuses an element the page is not showing', async () => {
    const el = mount('<img src="/qr.png" alt="" aria-hidden="true">', 'img')
    decoded(el, { width: 240, height: 240 })
    expect(refusal(await capture(el))).toBe(hiddenImageRefusal(REF))
    expect(asked).toEqual([])
  })

  it('refuses an element the injected visibility answers for', async () => {
    const el = mount('<img src="/qr.png" alt="">', 'img')
    decoded(el, { width: 240, height: 240 })
    expect(refusal(await capture(el, draws(), () => false))).toBe(hiddenImageRefusal(REF))
  })

  it('refuses an image whose own bytes have not arrived', async () => {
    const el = mount('<img src="/slow.png" alt="">', 'img')
    Object.defineProperty(el, 'complete', { value: false })
    expect(refusal(await capture(el))).toBe(unloadedImageRefusal(REF))
  })

  it('refuses an image that finished loading nothing', async () => {
    const el = mount('<img src="/gone.png" alt="">', 'img')
    decoded(el, { width: 0, height: 0 })
    expect(refusal(await capture(el))).toBe(unloadedImageRefusal(REF))
  })

  it('exports a canvas at its backing store\'s own size', async () => {
    const el = mount('<canvas width="320" height="180"></canvas>', 'canvas')
    expect(await capture(el)).toMatchObject({ kind: 'captured', tag: 'canvas', natural: { width: 320, height: 180 } })
    expect(asked).toEqual([{ el, spec: { size: { width: 320, height: 180 }, smooth: true } }])
  })

  it('refuses a canvas the page draws nothing in', async () => {
    const el = mount('<canvas width="0" height="0"></canvas>', 'canvas')
    expect(refusal(await capture(el))).toBe(emptyImageRefusal(REF))
  })

  it('refuses a vector the page laid out to nothing', async () => {
    const el = mount('<svg viewBox="0 0 24 24"></svg>', 'svg')
    laidOut(el, { width: 0, height: 0 })
    expect(refusal(await capture(el))).toBe(emptyImageRefusal(REF))
  })

  it('rasterizes a small vector up to the floor a request image is priced from', async () => {
    const el = mount('<svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg>', 'svg')
    laidOut(el, { width: 24, height: 24 })
    const answer = await capture(el)
    // The element's own size is what it was laid out at; the export is what a
    // vector still has detail for.
    expect(answer).toMatchObject({ kind: 'captured', tag: 'svg', natural: { width: 24, height: 24 } })
    // A vector has no stored grid to keep the edges of, so the browser
    // interpolates the way it does for every drawing but an enlarged raster.
    expect(asked[0]?.spec).toEqual({ size: { width: 384, height: 384 }, smooth: true })
  })

  it('reports what the browser encoded rather than what was asked for', async () => {
    const el = mount('<canvas width="8" height="8"></canvas>', 'canvas')
    const answer = await capture(el, draws({ data: 'BBBB', mediaType: 'image/jpeg', bytes: 3 }))
    expect(answer).toMatchObject({ mediaType: 'image/jpeg' })
  })

  it('refuses an export the browser encoded as a format this channel does not carry', async () => {
    const el = mount('<canvas width="8" height="8"></canvas>', 'canvas')
    const answer = await capture(el, draws({ data: 'CCCC', mediaType: 'image/avif', bytes: 3 }))
    expect(refusal(answer)).toBe(unexportableImageRefusal(REF, 'image/avif'))
  })

  it('refuses an export past the bytes one image may carry, with its size', async () => {
    const el = mount('<canvas width="8" height="8"></canvas>', 'canvas')
    const bytes = MAX_EXPORT_BYTES + 1
    expect(refusal(await capture(el, draws({ data: 'DDDD', mediaType: IMAGE_MEDIA_TYPE, bytes }))))
      .toBe(wideImageRefusal(REF, bytes, MAX_EXPORT_BYTES))
  })

  it('refuses the pixels another origin supplied', async () => {
    const el = mount('<img src="https://elsewhere.example/qr.png" alt="">', 'img')
    decoded(el, { width: 64, height: 64 })
    const tainted: ExportPixels = () => Promise.reject(Object.assign(new Error('tainted'), { name: 'SecurityError' }))
    expect(refusal(await capture(el, tainted))).toBe(taintedImageRefusal(REF))
  })

  it('lets every other failure of the browser through, for the reader to report', async () => {
    const el = mount('<canvas width="8" height="8"></canvas>', 'canvas')
    const broken: ExportPixels = () => Promise.reject(new Error('the console gave no drawing surface'))
    await expect(capture(el, broken)).rejects.toThrow('the console gave no drawing surface')
  })

  it('refuses a drawing that never finishes, naming the deadline it was given', async () => {
    const el = mount('<canvas width="8" height="8"></canvas>', 'canvas')
    // Nothing in a browser cancels a draw, so what the deadline ends is this
    // read's wait for it: the export answers, and the promise stays pending.
    const never: ExportPixels = () => new Promise<ExportedImage>(() => {})
    expect(refusal(await capture(el, never))).toBe(slowImageRefusal(REF, BUDGET_MS))
  })

  it('cuts a tag the page spelled longer than the wire carries, rather than posting it whole', async () => {
    const name = `x-${'o'.repeat(MAX_CURSOR_CHARS * 2)}`
    const el = mount(`<${name}>ops</${name}>`, name)
    // Cut to the bound the parser holds a posted `tag` to, which is the bound
    // the route's envelope was sized against: a captured arm carrying a longer
    // one is answered 400, and the seat reads that as final.
    expect(refusal(await capture(el)))
      .toBe(notAnImageRefusal(REF, `${name.slice(0, MAX_CURSOR_CHARS - 1)}…`))
  })
})

describe('the size one element\'s pixels are exported at', () => {
  /** The area every export is enlarged toward and never past. */
  const FLOOR = RASTER_MIN_SIDE * RASTER_MIN_SIDE

  it('draws a small raster twelve times over, landing on the floor\'s own area', () => {
    expect(exportSpec({ width: 32, height: 32 }, false))
      .toEqual({ size: { width: 384, height: 384 }, smooth: false })
  })

  it('draws a raster a quarter of the floor twice over', () => {
    expect(exportSpec({ width: 64, height: 64 }, false))
      .toEqual({ size: { width: 384, height: 384 }, smooth: false })
  })

  it('measures the multiple by area, so a long raster is enlarged by its own ratio', () => {
    // 16 × 64 has the area of a 32 × 32 and takes the same twelve, which a
    // side-by-side rule would have cut to six.
    expect(exportSpec({ width: 16, height: 64 }, false))
      .toEqual({ size: { width: 192, height: 768 }, smooth: false })
  })

  it('takes the largest whole multiple that fits rather than the one that reaches the floor', () => {
    // Four times over would be 400 × 400, past the floor and past what the
    // provider prices at the floor; three is the largest that stays inside it.
    expect(exportSpec({ width: 100, height: 100 }, false))
      .toEqual({ size: { width: 300, height: 300 }, smooth: false })
  })

  it('leaves a raster no whole multiple fits exactly as it is', () => {
    // Twice over is four times the area, so anything past a quarter of the
    // floor is exported as it stands — including the 348 × 348 the recorded
    // Web scenario exports.
    expect(exportSpec({ width: 240, height: 240 }, false))
      .toEqual({ size: { width: 240, height: 240 }, smooth: true })
    expect(exportSpec({ width: 348, height: 348 }, false))
      .toEqual({ size: { width: 348, height: 348 }, smooth: true })
  })

  it('leaves a strip already past the floor\'s area as it is', () => {
    expect(exportSpec({ width: 100, height: 2000 }, false))
      .toEqual({ size: { width: 100, height: 2000 }, smooth: true })
  })

  it('never enlarges a raster past the area the provider prices at the floor', () => {
    // Which is what makes the enlargement free: the provider scales anything
    // under this area up to exactly it, so an enlarged raster and its own
    // natural size land on one grid and are priced the same.
    for (const natural of [
      { width: 1, height: 1 }, { width: 32, height: 32 }, { width: 13, height: 17 },
      { width: 16, height: 64 }, { width: 100, height: 100 }, { width: 191, height: 191 },
    ]) {
      const { size } = exportSpec(natural, false)
      expect(size.width * size.height).toBeLessThanOrEqual(FLOOR)
      expect(size.width % natural.width).toBe(0)
      expect(size.width / natural.width).toBe(size.height / natural.height)
    }
  })

  it('enlarges a vector to the floor\'s own area, keeping its ratio', () => {
    const raised = exportSpec({ width: 48, height: 24 }, true)
    // Both axes are rounded, so the pair lands just past the floor rather than
    // exactly on it — which is the side of it that matters.
    expect(raised).toEqual({ size: { width: 543, height: 272 }, smooth: true })
    expect(raised.size.width * raised.size.height).toBeGreaterThanOrEqual(FLOOR)
  })

  it('leaves a vector already past the floor alone', () => {
    expect(exportSpec({ width: 800, height: 400 }, true))
      .toEqual({ size: { width: 800, height: 400 }, smooth: true })
  })

  it('scales anything past the pixel budget down inside it, keeping its ratio', () => {
    const lowered = exportSpec({ width: 4000, height: 2000 }, false)
    // Flooring the long side and rounding the short one off it can still land
    // past the budget, so the pair is walked down until it does not. Nothing is
    // enlarged here, so the browser averages the pixels it drops rather than
    // discarding them.
    expect(lowered).toEqual({ size: { width: 1130, height: 565 }, smooth: true })
    expect(lowered.size.width * lowered.size.height).toBeLessThanOrEqual(IMAGE_PIXEL_BUDGET)
  })

  it('scales a tall picture down by its own long side', () => {
    expect(exportSpec({ width: 2000, height: 4000 }, false))
      .toEqual({ size: { width: 565, height: 1130 }, smooth: true })
  })
})
