/**
 * The order this package puts names in.
 *
 * Every ordered answer here — the statuses of a pack root, the packs a scan
 * reports, the entries an archive is written from — is ordered by code unit
 * rather than by `localeCompare`, whose answer depends on the ICU data and the
 * default locale of whichever host runs it. Two hosts holding the same packs
 * would otherwise disagree about which pack comes first, which is a difference
 * in what a deployment offers and, for an archive, a difference in its bytes.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/order
 */

/**
 * Compare two names by their UTF-16 code units.
 * @param left - the name that sorts first when the result is negative.
 * @param right - the name that sorts first when the result is positive.
 * @returns a negative number, a positive number, or zero when the two are the same name.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
