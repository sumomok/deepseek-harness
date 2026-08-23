/**
 * The opt-in screenshot path: a PNG data URL the browser posted becomes a
 * durably committed attachment, exactly the lifecycle `read_image` uses. Bytes
 * never ride the session log inline.
 * @module @deepseek-ai/dsh-experimental-vue2-echarts-tool-poc/src/screenshot
 */

import { Buffer } from 'node:buffer'
import { AttachmentError, type AttachmentStore, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'

/** The only encoding the browser half sends, and the only one accepted here. */
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,'

/** The durable image reference as the tool's output schema carries it. */
export interface ChartImageValue {
  /** Content-addressed attachment id. */
  attachmentId: string
  /** Always `image/png`; the browser captures nothing else. */
  mediaType: 'image/png'
  /** Stored byte length. */
  bytes: number
  /** Intrinsic width in pixels. */
  width: number
  /** Intrinsic height in pixels. */
  height: number
}

/**
 * Decode the PNG a browser captured.
 * @param dataUrl - the posted data URL, which crossed a process boundary and is
 *   therefore checked rather than trusted.
 * @returns the image bytes, or `undefined` when the value is not a PNG data URL.
 */
export function decodePngDataUrl(dataUrl: string): Buffer | undefined {
  if (!dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return undefined
  const encoded = dataUrl.slice(PNG_DATA_URL_PREFIX.length)
  const bytes = Buffer.from(encoded, 'base64')
  return bytes.byteLength === 0 ? undefined : bytes
}

/**
 * Commit one captured chart before its tool result is appended.
 * @param attachments - the durable image store.
 * @param dataUrl - the PNG data URL the browser posted.
 * @param callId - the owning call, used only as the stored object's display
 *   name; the model reads the verdict line, not the file name, so the name
 *   stays out of the returned reference.
 * @returns the durable reference, or `undefined` when the capture is unusable
 *   or the store refuses it.
 */
export async function storeChartImage(
  attachments: AttachmentStore,
  dataUrl: string,
  callId: string,
): Promise<ChartImageValue | undefined> {
  const data = decodePngDataUrl(dataUrl)
  if (data === undefined) return undefined
  let ref: ImageAttachmentRef
  try {
    ref = await attachments.saveImage({ data, mediaType: 'image/png', name: `show_chart-${callId}.png` })
  } catch (error: unknown) {
    // A refused capture drops the image and keeps the verdict: the model still
    // learns what was painted, and a deployment's image policy is not a reason
    // to fail a chart the user is already looking at. Anything that is not an
    // admission decision is a real fault and stays fatal.
    if (!(error instanceof AttachmentError)) throw error
    return undefined
  }
  return {
    attachmentId: ref.attachmentId,
    mediaType: 'image/png',
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
  }
}
