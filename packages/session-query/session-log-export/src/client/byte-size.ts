/**
 * Byte-count formatting for the export panel's received-bytes readout.
 * @module @deepseek-ai/dsh-session-log-export/client/byte-size
 */

/**
 * Byte count as user-facing text: whole bytes under 1 KiB (`512 B`), whole
 * kilobytes under 1 MiB (`512 KB`), else megabytes to one decimal place
 * unless the value is exact (`2.5 MB`, `10 MB`).
 * @param bytes - the byte count.
 * @returns the display-ready size text.
 */
export function byteSizeText(bytes: number): string {
  const KIB = 1024
  const MIB = 1024 * 1024
  if (bytes < KIB) return `${String(Math.round(bytes))} B`
  if (bytes < MIB) return `${String(Math.round(bytes / KIB))} KB`
  const mb = bytes / MIB
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)} MB`
}
