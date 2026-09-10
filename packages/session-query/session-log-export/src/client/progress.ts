/**
 * The browser's model of how far one Session export has come. Pure: it reads
 * the Host's extent headers and the raw archive bytes as they arrive, and
 * reports a fraction plus the counts the panel labels. It performs no I/O,
 * retains no chunk beyond the three bytes a ZIP signature can straddle, and
 * holds no browser object.
 *
 * The bar is scaled by the Host's estimate of the bytes the body will carry,
 * so it advances smoothly through a single entry — which is what a Session
 * with no sub-Sessions and no attachments exports, and the case where nothing
 * else has any resolution. The estimate is calibrated, not exact: an archive
 * that compresses harder than the calibration reaches the ceiling before the
 * stream ends, and one that compresses softer completes from around four
 * fifths. Both read as a transfer in progress, which the archive's true
 * uncompressed total against received bytes does not — it would crawl to
 * roughly an eighth and then snap.
 *
 * Counting ZIP local file header signatures (`50 4B 03 04`) in the received
 * bytes raises that estimate off its floor: an entry is finished once the next
 * entry's header arrives, because a header precedes its own data, so the
 * larger of the two measures is reported. Both only ever understate. A chance
 * `50 4B 03 04` inside compressed data can move the entry count at most one
 * entry early, and the count is capped at the announced total.
 * @module
 */

import {
  SESSION_EXPORT_BYTES_HEADER,
  SESSION_EXPORT_ENTRIES_HEADER,
  SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER,
  type SessionLogExportExtent,
} from '../export-extent.ts'

/** One moment of an export, as the panel renders it. */
export interface SessionExportProgress {
  /**
   * Completed fraction, or `null` when the Host announced no extent and the
   * bar is indeterminate. A still-streaming export stays below 1; only a
   * settled archive reports 1.
   */
  readonly fraction: number | null
  /** ZIP entries received in full, capped at `entriesTotal`. */
  readonly entriesDone: number
  /** Entries the Host announced, or `null` when it announced none. */
  readonly entriesTotal: number | null
  /** Archive bytes received so far. */
  readonly receivedBytes: number
}

/** Where an export starts: requested, with nothing announced and nothing received. */
export const SESSION_EXPORT_PROGRESS_START: SessionExportProgress = {
  fraction: null,
  entriesDone: 0,
  entriesTotal: null,
  receivedBytes: 0,
}

/** The four bytes that open every ZIP local file header. */
const LOCAL_FILE_HEADER = [0x50, 0x4b, 0x03, 0x04] as const

/** Trailing bytes retained between chunks so a signature split across them still matches. */
const CARRY_BYTES = LOCAL_FILE_HEADER.length - 1

/** The highest fraction a still-streaming export reports; 1 means settled. */
const STREAMING_CEILING = 0.99

/**
 * Read the archive extent one export response announces.
 * @param headers - the export response's headers.
 * @returns the announced extent, or `null` when either header is absent or
 * does not carry a positive whole number (an older Host, or a mangled value).
 */
export function readSessionLogExportExtent(headers: Headers): SessionLogExportExtent | null {
  const entries = positiveInteger(headers.get(SESSION_EXPORT_ENTRIES_HEADER))
  const bytes = positiveInteger(headers.get(SESSION_EXPORT_BYTES_HEADER))
  const estimatedWireBytes = positiveInteger(headers.get(SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER))
  if (entries === null || bytes === null || estimatedWireBytes === null) return null
  return { entries, bytes, estimatedWireBytes }
}

function positiveInteger(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * Whether a local file header starts at `index`.
 * @param view - the bytes being scanned.
 * @param index - the candidate start, already known to hold the first signature byte.
 * @returns whether the full four-byte signature sits at `index`.
 */
function matchesAt(view: Uint8Array, index: number): boolean {
  if (index + LOCAL_FILE_HEADER.length > view.byteLength) return false
  for (let offset = 1; offset < LOCAL_FILE_HEADER.length; offset += 1) {
    if (view[index + offset] !== LOCAL_FILE_HEADER[offset]) return false
  }
  return true
}

/**
 * Count the local file headers that start before `startLimit`.
 * @param view - the bytes to scan.
 * @param startLimit - exclusive upper bound on a match's start index, which
 * keeps the bridge scan to signatures that actually straddle two chunks.
 * @returns how many signatures start in range.
 */
function countLocalFileHeaders(view: Uint8Array, startLimit: number): number {
  let count = 0
  let index = view.indexOf(LOCAL_FILE_HEADER[0])
  while (index >= 0 && index < startLimit) {
    if (matchesAt(view, index)) count += 1
    index = view.indexOf(LOCAL_FILE_HEADER[0], index + 1)
  }
  return count
}

/**
 * The bytes to carry into the next chunk: the last {@link CARRY_BYTES} of the
 * stream so far.
 * @param carry - what the previous chunk left behind.
 * @param chunk - the chunk just consumed.
 * @returns an owned copy of the trailing bytes (never a view into `chunk`).
 */
function tailBytes(carry: Uint8Array, chunk: Uint8Array): Uint8Array {
  if (chunk.byteLength >= CARRY_BYTES) return chunk.slice(chunk.byteLength - CARRY_BYTES)
  const combined = new Uint8Array(carry.byteLength + chunk.byteLength)
  combined.set(carry)
  combined.set(chunk, carry.byteLength)
  return combined.slice(Math.max(0, combined.byteLength - CARRY_BYTES))
}

/**
 * Accumulates one export's received bytes and entry signatures and reports the
 * progress they imply. Every reported measure only grows, so the fraction is
 * monotonic by construction.
 */
export class SessionExportProgressTracker {
  private carry: Uint8Array = new Uint8Array(0)
  private signatures = 0
  private received = 0

  /** Entries whose bytes have all arrived: every started entry but the current one. */
  private get finished(): number {
    return Math.max(this.signatures - 1, 0)
  }

  /**
   * @param extent - what the Host announced, or `null` for an indeterminate export.
   */
  constructor(private readonly extent: SessionLogExportExtent | null) {}

  /**
   * Consume one received chunk.
   * @param chunk - the archive bytes just read from the response body.
   * @returns the progress after this chunk.
   */
  push(chunk: Uint8Array): SessionExportProgress {
    this.received += chunk.byteLength
    if (this.carry.byteLength > 0) {
      const bridge = new Uint8Array(this.carry.byteLength + Math.min(CARRY_BYTES, chunk.byteLength))
      bridge.set(this.carry)
      bridge.set(chunk.subarray(0, bridge.byteLength - this.carry.byteLength), this.carry.byteLength)
      this.signatures += countLocalFileHeaders(bridge, this.carry.byteLength)
    }
    this.signatures += countLocalFileHeaders(chunk, chunk.byteLength)
    this.carry = tailBytes(this.carry, chunk)
    return this.progress
  }

  /** The progress implied by everything consumed so far. */
  get progress(): SessionExportProgress {
    const extent = this.extent
    if (extent === null) {
      return {
        fraction: null,
        entriesDone: this.finished,
        entriesTotal: null,
        receivedBytes: this.received,
      }
    }
    const entriesDone = Math.min(this.finished, extent.entries)
    // The outer clamp holds a streaming export below 1 whether the archive
    // out-compressed the Host's estimate or spurious signatures pushed the
    // entry count to the announced total.
    const fraction = Math.min(
      Math.max(entriesDone / extent.entries, this.received / extent.estimatedWireBytes),
      STREAMING_CEILING,
    )
    return { fraction, entriesDone, entriesTotal: extent.entries, receivedBytes: this.received }
  }

  /**
   * The progress of a settled archive: the stream ended, so every announced
   * entry arrived whether or not its signature was recognized.
   * @returns the completed progress.
   */
  complete(): SessionExportProgress {
    const extent = this.extent
    return {
      ...this.progress,
      fraction: 1,
      entriesDone: extent === null ? this.signatures : extent.entries,
    }
  }
}
