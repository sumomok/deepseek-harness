/**
 * Rewrite the `workspace:` ranges of a staged manifest the way `pnpm publish`
 * does, so the payload's installation manifest reads as a published one.
 *
 * The plugin manager treats an installation whose `@deepseek-ai/dsh` manifest
 * names any `workspace:` dependency as a source checkout
 * (`officialBundleInstallTarget` in `@deepseek-ai/dsh-plugin-manager`), and a
 * payload is no checkout, so the official on-demand bundles would list an
 * error instead of an install target.
 * @module
 */

/** The dependency sections a pinned manifest rewrites; `devDependencies` are not read at run time and stay as staged. */
export const PINNED_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const

/** A manifest as far as [[pinWorkspaceRanges]] reads and writes it. */
export type PinnableManifest = Record<string, unknown> & Partial<Record<(typeof PINNED_SECTIONS)[number], Record<string, string>>>

/**
 * Replace each `workspace:` range in the pinned sections: `workspace:*` by the
 * dependency's version, `workspace:~` and `workspace:^` by that version with
 * the same prefix, and `workspace:<range>` by `<range>`.
 * @param manifest - the parsed manifest; it is not modified.
 * @param versionOf - the version of a dependency by name, or undefined when the staged tree lacks it.
 * @returns the rewritten manifest and the number of ranges replaced.
 * @throws when a `*`, `~`, or `^` range names a dependency `versionOf` cannot answer.
 */
export function pinWorkspaceRanges(
  manifest: PinnableManifest, versionOf: (name: string) => string | undefined,
): { manifest: PinnableManifest; pinned: number } {
  const next: PinnableManifest = { ...manifest }
  let pinned = 0
  for (const section of PINNED_SECTIONS) {
    const ranges = manifest[section]
    if (ranges === undefined) continue
    const rewritten: Record<string, string> = {}
    for (const [name, range] of Object.entries(ranges)) {
      if (!range.startsWith('workspace:')) {
        rewritten[name] = range
        continue
      }
      const rest = range.slice('workspace:'.length)
      if (rest === '*' || rest === '~' || rest === '^') {
        const version = versionOf(name)
        if (version === undefined) throw new Error(`pin-workspace-ranges: ${section}.${name} is ${range}, and the staged tree has no ${name}`)
        rewritten[name] = rest === '*' ? version : `${rest}${version}`
      } else {
        rewritten[name] = rest
      }
      pinned += 1
    }
    next[section] = rewritten
  }
  return { manifest: next, pinned }
}
