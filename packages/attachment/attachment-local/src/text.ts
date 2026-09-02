/** Text-file inspection: strict UTF-8 decode at admission and on verified reads. */

import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { sniffProbe } from './sniff.ts'

/** Decoded text from a verified UTF-8 file. */
export interface DetectedText {
  text: string
}

/**
 * Prove one file's bytes are valid UTF-8 text and decode them.
 *
 * A fast {@link sniffProbe} pass over the complete bytes rejects a NUL byte
 * anywhere in the file, and most invalid encodings, without paying for a
 * full strict decode. `sniffProbe`'s `stream: true` decode can still miss a
 * multi-byte sequence truncated at the very end of the file (it is built to
 * tolerate exactly that at a probe window's edge), so the authoritative
 * `TextDecoder` pass below runs without `stream: true` and catches that
 * remaining case.
 * @param data - complete submitted bytes.
 * @returns the decoded text.
 * @throws AttachmentError with code `NOT_TEXT_FILE` when the bytes are not valid UTF-8 text.
 */
export function detectText(data: Uint8Array): DetectedText {
  if (sniffProbe(data) === 'binary') {
    throw new AttachmentError('File is not valid UTF-8 text.', 'NOT_TEXT_FILE')
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(data) }
  } catch (error) {
    throw new AttachmentError('File is not valid UTF-8 text.', 'NOT_TEXT_FILE', { cause: error })
  }
}
