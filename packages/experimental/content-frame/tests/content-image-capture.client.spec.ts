// @vitest-environment jsdom
/**
 * What an export decides before a browser draws anything: which elements have
 * pixels of their own, whether the page is showing this one, what size the
 * pixels come out at, and which endings the model is told about.
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
  captureElement, exportSize, type Capture, type ExportedImage, type ExportPixels,
} from '../src/client/access/capture.ts'
import {
  emptyImageRefusal, hiddenImageRefusal, notAnImageRefusal, taintedImageRefusal, unexportableImageRefusal,
  unloadedImageRefusal, wideImageRefusal,
} from '../src/access/text.ts'
import {
  IMAGE_MEDIA_TYPE, IMAGE_PIXEL_BUDGET, MAX_EXPORT_BYTES, SVG_RASTER_MIN_PIXELS, type ImageSize,
} from '../src/access/wire.ts'

/** The ref every case here names, which every refusal opens with. */
const REF = 'e12'

/** What a browser hands back for a picture it drew. */
const DRAWN: ExportedImage = { data: 'AAAA', mediaType: IMAGE_MEDIA_TYPE, bytes: 3 }

/** Every size the stub was asked to draw at, in order. */
let asked: { el: Element; size: ImageSize }[] = []

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
  return (el, size) => {
    asked.push({ el, size })
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
  return captureElement(el, { ref: REF, isVisible: visible, draw })
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
  it('exports a decoded image at its own stored size and never larger', async () => {
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
    expect(asked).toEqual([{ el, size: { width: 240, height: 240 } }])
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
    expect(asked).toEqual([{ el, size: { width: 320, height: 180 } }])
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
    expect(asked[0]?.size).toEqual({ width: 384, height: 384 })
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
})

describe('the size one element\'s pixels are exported at', () => {
  it('leaves a bitmap inside the budget exactly as it is', () => {
    expect(exportSize({ width: 220, height: 40 }, false)).toEqual({ width: 220, height: 40 })
  })

  it('never enlarges a bitmap, however small', () => {
    expect(exportSize({ width: 16, height: 16 }, false)).toEqual({ width: 16, height: 16 })
  })

  it('enlarges a vector to the pixel floor, keeping its ratio', () => {
    const raised = exportSize({ width: 48, height: 24 }, true)
    // Both axes are rounded, so the pair lands just past the floor rather than
    // exactly on it — which is the side of it that matters.
    expect(raised).toEqual({ width: 543, height: 272 })
    expect(raised.width * raised.height).toBeGreaterThanOrEqual(SVG_RASTER_MIN_PIXELS)
  })

  it('leaves a vector already past the floor alone', () => {
    expect(exportSize({ width: 800, height: 400 }, true)).toEqual({ width: 800, height: 400 })
  })

  it('scales anything past the pixel budget down inside it, keeping its ratio', () => {
    const lowered = exportSize({ width: 4000, height: 2000 }, false)
    // Flooring the long side and rounding the short one off it can still land
    // past the budget, so the pair is walked down until it does not.
    expect(lowered).toEqual({ width: 1130, height: 565 })
    expect(lowered.width * lowered.height).toBeLessThanOrEqual(IMAGE_PIXEL_BUDGET)
  })

  it('scales a tall picture down by its own long side', () => {
    expect(exportSize({ width: 2000, height: 4000 }, false)).toEqual({ width: 565, height: 1130 })
  })
})
