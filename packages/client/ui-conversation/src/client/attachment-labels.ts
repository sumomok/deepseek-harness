/** Attachment error and limit copy owned by the conversation input flow. */

import type { FileAttachmentLimits, ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConversationKey } from './locales.ts'

/**
 * Byte count as user-facing text: whole bytes under 1 KiB (`512 B`), whole
 * kilobytes under 1 MiB (`512 KB`), else megabytes to one decimal place
 * unless the value is exact (`2.5 MB`, `10 MB`).
 * @param bytes - the byte count.
 * @returns the display-ready size text.
 */
export function attachmentSizeText(bytes: number): string {
  const KIB = 1024
  const MIB = 1024 * 1024
  if (bytes < KIB) return `${String(Math.round(bytes))} B`
  if (bytes < MIB) return `${String(Math.round(bytes / KIB))} KB`
  const mb = bytes / MIB
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)} MB`
}

/**
 * Product copy for a host attachment rejection (the `attachment-error`
 * `details.reason`). User-solvable reasons name the limit and the way out;
 * reasons the user cannot act on fold into one send-failed line carrying the
 * reason code for a bug report. Image and file reasons share one wire union
 * (`AttachmentErrorCode`), so both limit sets are accepted here and each
 * reason only reads the one it needs.
 * @param t - the conversation-namespace translate.
 * @param reason - the wire `details.reason` code.
 * @param limits - projected image limits interpolated into count/size copy, when known.
 * @param fileLimits - projected file limits interpolated into count/size copy, when known.
 * @returns the banner text.
 */
export function attachmentErrorText(
  t: Translate<ConversationKey>,
  reason: string,
  limits?: ImageAttachmentLimits,
  fileLimits?: FileAttachmentLimits,
): string {
  switch (reason) {
    case 'MODEL_DOES_NOT_SUPPORT_IMAGES': return t('image.modelUnsupported')
    case 'SUBAGENT_IMAGE_UNSUPPORTED': return t('image.subagentUnsupported')
    case 'IMAGE_TOO_MANY_PIXELS': return t('image.tooManyPixels')
    case 'IMAGE_DIMENSION_TOO_LARGE':
      if (limits !== undefined) return t('image.dimensionTooLarge', { size: limits.maxImageDimension })
      break
    // Undecodable bytes or a declared type its bytes contradict: solvable by
    // replacing or re-exporting the file, so it reads as a format problem.
    case 'INVALID_IMAGE':
    case 'IMAGE_TYPE_MISMATCH':
      return t('image.unsupportedType')
    case 'TOO_MANY_IMAGES':
      if (limits !== undefined) return t('image.tooMany', { count: limits.maxImagesPerMessage })
      break
    case 'IMAGE_TOO_LARGE':
      if (limits !== undefined) return t('image.fileTooLarge', { size: attachmentSizeText(limits.maxImageBytes) })
      break
    case 'IMAGES_TOO_LARGE':
      if (limits !== undefined) return t('image.totalTooLarge', { size: attachmentSizeText(limits.maxMessageImageBytes) })
      break
    case 'NOT_TEXT_FILE': return t('file.notText')
    case 'INVALID_FILE_NAME': return t('file.invalidName')
    case 'TOO_MANY_FILES':
      if (fileLimits !== undefined) return t('file.tooMany', { count: fileLimits.maxFilesPerMessage })
      break
    case 'FILE_TOO_LARGE':
      if (fileLimits !== undefined) return t('file.fileTooLarge', { size: attachmentSizeText(fileLimits.maxFileBytes) })
      break
    case 'FILES_TOO_LARGE':
      if (fileLimits !== undefined) {
        return t('file.totalTooLarge', { size: attachmentSizeText(fileLimits.maxMessageFileBytes) })
      }
      break
    case 'SUBAGENT_FILE_UNSUPPORTED': return t('file.subagentUnsupported')
    default: break
  }
  return t('image.sendFailed', { reason })
}
