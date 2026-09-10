/**
 * How much one Session export archive will contain, announced by the Host in
 * response headers before the first archive byte and read back by the browser
 * to drive a progress bar. Both halves of the package compile this module, so
 * the header names and the units they carry have one definition.
 * @module
 */

/** One export archive's announced extent. */
export interface SessionLogExportExtent {
  /** ZIP entries the archive holds: one per included session log, one per referenced media object. */
  readonly entries: number
  /** Summed uncompressed size of those entries, in bytes. */
  readonly bytes: number
  /**
   * Estimated bytes the response body will carry. Exact only when the archive
   * stores rather than deflates; otherwise it applies the Host's calibrated
   * text-compression ratio to the log entries and takes media at face value.
   * It exists to scale a progress bar, never to size a buffer or a range.
   */
  readonly estimatedWireBytes: number
}

/** Response header carrying {@link SessionLogExportExtent.entries}. */
export const SESSION_EXPORT_ENTRIES_HEADER = 'X-Session-Export-Entries'

/** Response header carrying {@link SessionLogExportExtent.bytes}. */
export const SESSION_EXPORT_BYTES_HEADER = 'X-Session-Export-Bytes'

/** Response header carrying {@link SessionLogExportExtent.estimatedWireBytes}. */
export const SESSION_EXPORT_ESTIMATED_WIRE_BYTES_HEADER = 'X-Session-Export-Estimated-Wire-Bytes'
