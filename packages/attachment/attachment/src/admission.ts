/** Wire-form admission of base64-encoded image uploads. @module @deepseek-ai/dsh-attachment/admission */

import { Buffer } from 'node:buffer'
import { AttachmentError } from './error.ts'
import type { AttachmentStore } from './index.ts'
import type {
  AdmittedPromptContentPart,
  EncodedFileAttachment,
  EncodedImageAttachment,
  FileAttachmentRef,
  ImageAttachmentRef,
  PromptContentPart,
  SaveFileAttachment,
  SaveImageAttachment,
} from './types.ts'

/** Decode one upload payload while rejecting non-canonical base64 forms. */
function decodeBase64(data: string): Uint8Array {
  const decoded = Buffer.from(data, 'base64')
  if (data.length === 0 || decoded.toString('base64') !== data) {
    throw new AttachmentError('Image upload is not canonical base64.', 'INVALID_IMAGE_BASE64')
  }
  return new Uint8Array(decoded)
}

/** Store input for one decoded upload. */
function saveInput(image: EncodedImageAttachment): SaveImageAttachment {
  return {
    data: decodeBase64(image.data),
    mediaType: image.mediaType,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Admit one wire image batch: enforce canonical base64 on every member, then
 * delegate batch admission — count and aggregate-byte limits, media-type and
 * per-image validation, ordered commit — to {@link AttachmentStore.saveImages}.
 * The shared entry for every RPC endpoint accepting browser uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param images - base64-encoded uploads in caller order.
 * @returns durable references in the same order as `images`.
 * @throws AttachmentError on a non-canonical payload or a refused batch.
 */
export async function admitEncodedImages(
  attachments: AttachmentStore,
  images: readonly EncodedImageAttachment[],
): Promise<readonly ImageAttachmentRef[]> {
  return attachments.saveImages(images.map(saveInput))
}

/**
 * Admit one browser prompt and replace each uploaded image with its durable reference.
 * Text-only prompts do not access the attachment store.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param content - browser prompt parts in message order.
 * @returns admitted prompt parts in the same order as `content`.
 * @throws AttachmentError when the image batch is refused.
 */
export async function admitPromptContent(
  attachments: AttachmentStore,
  content: readonly PromptContentPart[],
): Promise<AdmittedPromptContentPart[]> {
  if (content.every(part => part.type === 'text')) {
    return content.map(part => ({ type: 'text', text: part.text }))
  }
  const refs = await admitEncodedImages(attachments, content.filter(part => part.type === 'image'))
  let next = 0
  return content.map(part => part.type === 'text'
    ? { type: 'text', text: part.text }
    // admitEncodedImages returns one reference per image part in order.
    : { type: 'image', attachment: refs[next++] as ImageAttachmentRef })
}

/**
 * Store input for one wire text-file upload. The wire form carries plain
 * text, never base64 — encoding it back to UTF-8 bytes lets the seam's
 * `saveFile` re-validate every upload at the byte level regardless of its
 * transport, exactly like image bytes decoded from base64.
 */
function saveFileInput(file: EncodedFileAttachment): SaveFileAttachment {
  return { data: new TextEncoder().encode(file.text), name: file.name }
}

/**
 * Admit one wire text-file batch: re-encode every member to UTF-8 bytes,
 * then delegate batch admission — count and aggregate-byte limits, strict
 * UTF-8 and per-file byte-limit validation, ordered commit — to
 * {@link AttachmentStore.saveFiles}. The shared entry for every RPC endpoint
 * accepting browser file uploads.
 * @param attachments - the deployment attachment store owning batch policy.
 * @param files - text-file uploads in caller order.
 * @returns durable references in the same order as `files`.
 * @throws AttachmentError on a refused batch or an individually refused file.
 */
export async function admitEncodedFiles(
  attachments: AttachmentStore,
  files: readonly EncodedFileAttachment[],
): Promise<readonly FileAttachmentRef[]> {
  return attachments.saveFiles(files.map(saveFileInput))
}
