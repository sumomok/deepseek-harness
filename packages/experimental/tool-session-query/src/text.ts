/** Text pagination helpers shared by event-read validation and presentation. */

/**
 * Whether one UTF-16 offset falls between a high and low surrogate.
 * @param text - complete text being paginated.
 * @param offset - candidate code-unit offset.
 * @returns true when slicing at offset would split a Unicode pair.
 */
export function splitsUnicodePair(text: string, offset: number): boolean {
  if (offset <= 0 || offset >= text.length) return false
  const before = text.charCodeAt(offset - 1)
  const after = text.charCodeAt(offset)
  return before >= 0xD800 && before <= 0xDBFF && after >= 0xDC00 && after <= 0xDFFF
}
