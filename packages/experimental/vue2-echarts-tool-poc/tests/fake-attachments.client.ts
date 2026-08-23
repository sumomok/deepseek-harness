/**
 * A recording image store for the specs that exercise the opt-in screenshot:
 * it answers a fixed reference, keeps every save it was asked for, and can be
 * told to refuse the next one.
 */
import { AttachmentId, AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'

/** Durable image store double; mounting one registers `ctx.attachments`. */
export class FakeAttachments extends AttachmentStore {
  readonly imageLimits: ImageAttachmentLimits = {
    maxImageBytes: 1024 * 1024,
    maxImagesPerMessage: 4,
    maxMessageImageBytes: 4 * 1024 * 1024,
    maxImagePixels: 4_000_000,
    maxImageDimension: 4000,
    mediaTypes: ['image/png'],
  }

  /** Every save this store was asked for, in order. */
  readonly saved: SaveImageAttachment[] = []
  /** Rejected by the next save when set. */
  refusal: Error | undefined

  /**
   * Accept any bytes; the real validation is the local store's business.
   * @returns immediately.
   */
  validateImage(): Promise<void> {
    return Promise.resolve()
  }

  /**
   * Record one save and answer a fixed reference.
   * @param input - the bytes, media type, and display name.
   * @returns the stored reference, or the configured refusal.
   */
  saveImage(input: SaveImageAttachment): Promise<ImageAttachmentRef> {
    this.saved.push(input)
    if (this.refusal !== undefined) return Promise.reject(this.refusal)
    return Promise.resolve({
      attachmentId: AttachmentId('sha256-chart'),
      mediaType: 'image/png',
      bytes: input.data.byteLength,
      width: 640,
      height: 320,
      ...input.name === undefined ? {} : { name: input.name },
    })
  }

  /**
   * Unused: no spec reads a stored capture back.
   * @throws always.
   */
  readImage(): Promise<StoredImageAttachment> {
    throw new Error('unused by these specs')
  }
}
