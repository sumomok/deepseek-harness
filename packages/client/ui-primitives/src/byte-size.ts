/**
 * Byte-count formatting shared by every surface that labels an attachment's
 * size (a message-bubble file card, a composer draft chip, an attachment
 * rejection banner) — a pure, dependency-free value, kept here rather than
 * behind any one feature package's `dsh.client.external` request so every
 * client package can import it directly.
 *
 * @module @deepseek-ai/dsh-client-ui-primitives/byte-size
 */

/**
 * Byte count as user-facing megabytes (`10MB`, `2.5MB`).
 * @param bytes - the byte count.
 * @returns the rounded megabyte text.
 */
export function attachmentSizeText(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  return `${Number.isInteger(mb) ? String(mb) : mb.toFixed(1)}MB`
}
