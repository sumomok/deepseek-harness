/**
 * The one thing a picture read asks of a real browser: draw an element onto a
 * surface the page cannot see, and hand the encoded bytes back.
 *
 * It is a module of its own because it is the whole of what a DOM
 * implementation without a canvas cannot run — every decision an export makes
 * is in `./capture.ts`, which is injected with this and is testable without a
 * browser. Taking a native canvas dependency to give a test one would put a
 * build toolchain into this package for a function whose entire content is four
 * browser calls.
 *
 * The surface is the seat's own: a canvas created here, never inserted
 * anywhere, and dropped when this returns. Nothing about the frame's document
 * changes, so an export cannot wake the change watch a read waits on.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/export-pixels
 */

import { IMAGE_MEDIA_TYPE } from '../../access/wire.ts'
import type { ExportedImage, ExportSpec } from './capture.ts'

/* v8 ignore start -- every line below is a canvas call, which a DOM
   implementation without a canvas runs none of; `./capture.ts` holds every
   decision an export makes and is what a test reaches. */

/** How many bytes are turned into characters at a time, so a large export does not exhaust the argument list. */
const BASE64_CHUNK = 0x8000

/**
 * Base64 one buffer.
 * @param bytes - the encoded image.
 * @returns the payload the wire carries.
 */
function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let at = 0; at < bytes.length; at += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + BASE64_CHUNK))
  }
  return btoa(binary)
}

/**
 * The vector one `svg` element holds, decoded into something drawable.
 *
 * A vector has no stored raster to draw, so it is serialized as it stands and
 * loaded back as an image, which is what gives the browser a size to rasterize
 * at. What the markup points outside itself at — an external sheet, a font, a
 * linked image — is not part of what is serialized and does not come along.
 * @param el - the `svg` element.
 * @returns the decoded image.
 */
async function decodeVector(el: Element): Promise<CanvasImageSource> {
  const markup = new XMLSerializer().serializeToString(el)
  const url = URL.createObjectURL(new Blob([markup], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * Draw one element as the export asks for it and encode the result.
 *
 * Every choice the drawing makes is the spec's: the surface is the size it
 * names, and the browser interpolates between the source's pixels only where it
 * says so. Smoothing is set on the context rather than left at the default,
 * because the default is on and an enlarged raster drawn that way arrives as a
 * blur across the edges the page drew.
 * @param el - the element to draw: an `img`, a `canvas`, or an `svg`.
 * @param spec - the size to draw it at and the smoothing to draw it with.
 * @returns the encoded bytes and the media type read back off them.
 * @throws {Error} when the browser gives no drawing surface or no bytes, and a
 * `SecurityError` when another origin's pixels marked the surface.
 */
export async function exportPixels(el: Element, spec: ExportSpec): Promise<ExportedImage> {
  const surface = el.ownerDocument.createElement('canvas')
  surface.width = spec.size.width
  surface.height = spec.size.height
  const context = surface.getContext('2d')
  if (context === null) throw new Error('content-frame: the console gave no drawing surface for this picture')
  context.imageSmoothingEnabled = spec.smooth
  const source = el.localName === 'svg' ? await decodeVector(el) : el as CanvasImageSource
  context.drawImage(source, 0, 0, spec.size.width, spec.size.height)
  const blob = await new Promise<Blob | null>((resolve) => { surface.toBlob(resolve, IMAGE_MEDIA_TYPE) })
  if (blob === null) throw new Error('content-frame: the console encoded no bytes for this picture')
  const bytes = new Uint8Array(await blob.arrayBuffer())
  return { data: toBase64(bytes), mediaType: blob.type, bytes: bytes.length }
}

/* v8 ignore stop */
