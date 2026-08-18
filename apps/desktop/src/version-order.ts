/**
 * Semver precedence for the update channel. The running app compares its own
 * version against the published feed, and the publish script compares the
 * build it is about to upload against what the feed already serves; both need
 * the same answer, including for the `-rc.N` prereleases this product ships.
 *
 * Depends on nothing, so the Electron main process and a plain-Node script can
 * both import it.
 * @module @deepseek-ai/dsh-desktop/version-order
 */

/**
 * Split a semantic version into its release numbers and prerelease
 * identifiers. A leading `v` and surrounding space are tolerated because the
 * value arrives from a published manifest rather than from typed code.
 * @param version - the version string to split.
 * @returns the release numbers and the dot-separated prerelease identifiers.
 */
function parseVersion(version: string): { release: number[]; prerelease: string[] } {
  const trimmed = version.trim().replace(/^v/, '')
  const dash = trimmed.indexOf('-')
  const core = dash < 0 ? trimmed : trimmed.slice(0, dash)
  const tail = dash < 0 ? '' : trimmed.slice(dash + 1)
  return {
    release: core.split('.').map((part) => {
      const value = Number.parseInt(part, 10)
      return Number.isNaN(value) ? 0 : value
    }),
    prerelease: tail === '' ? [] : tail.split('.'),
  }
}

/**
 * Compare two versions by semver precedence: release numbers first, then the
 * prerelease tail, where any prerelease sorts below the same release version
 * and numeric identifiers compare numerically (so `rc.10` follows `rc.9`).
 * @param left - the version on the left of the comparison.
 * @param right - the version on the right of the comparison.
 * @returns a negative number when `left` precedes `right`, positive when it
 * follows, and zero when the two have equal precedence.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < Math.max(a.release.length, b.release.length); index += 1) {
    const difference = (a.release[index] ?? 0) - (b.release[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      const difference = Number(leftPart) - Number(rightPart)
      if (difference !== 0) return difference
    } else if (leftNumeric !== rightNumeric) {
      return leftNumeric ? -1 : 1
    } else if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  return 0
}
