/**
 * Test-only row standing in for the two services the picture read needs: an
 * attachment store that keeps what it is given and answers with a reference,
 * and an LLM registry whose every route accepts pictures, which is what lets a
 * `content_read_image` call reach its wait. Mounted from a test-only
 * cordis.yml; no shipped profile names it.
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentLimits, ImageAttachmentRef, SaveImageAttachment } from '@deepseek-ai/dsh-attachment'

/** Stable Cordis plugin name. */
export const name = 'picture-services-fixture'

/** The content-addressed id the stub store hands back. */
export const STORED_ID = 'sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640'

/** The store that keeps every saved image in {@link PictureStore.saved}. */
export class PictureStore extends AttachmentStore {
  /** Every image this store was asked to keep, in order. */
  readonly saved: SaveImageAttachment[] = []

  override readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 8 * 1024 * 1024,
    maxImagesPerMessage: 8,
    maxMessageImageBytes: 8 * 1024 * 1024,
    maxImagePixels: 40_000_000,
    maxImageDimension: 8000,
    mediaTypes: ['image/png'],
  }

  override validateImage(): Promise<void> {
    return Promise.resolve()
  }

  override saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    return Promise.resolve({
      attachmentId: STORED_ID,
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 240,
      height: 240,
      ...input.name === undefined ? {} : { name: input.name },
    } as ImageAttachmentRef)
  }

  override readImage(): never {
    throw new Error('this store is written for the route, not for reading back')
  }

  override saveFile(): never {
    throw new Error('this store keeps images only')
  }
}

/**
 * Mount the store and the LLM registry.
 * @param ctx - the row's context.
 */
export function apply(ctx: Context): void {
  // The AttachmentStore constructor is the registration.
  new PictureStore(ctx)
  ctx.provide('llm', { resolveModelInfo: () => Promise.resolve({ inputModalities: ['text', 'image'] }) } as never)
}
