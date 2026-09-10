/**
 * Decide what one update-feed channel directory keeps after a publish.
 *
 * The decision is separated from the ssh that carries it out so it can be
 * exercised without a server: `publish-update.ts` lists the remote directory,
 * hands the names here, logs the answer, and only then deletes.
 *
 * Retention is asymmetric because the two kinds of file buy different things,
 * which is readable straight out of `electron-updater@6.8.9`. In
 * `out/AppUpdater.js`, `differentialDownloadInstaller` always fetches the
 * **new** version's blockmap from the feed, but reads the **old** version's
 * from the client's own cache (`current.blockmap`) first and falls back to the
 * feed only when that file is missing — and every completed in-app update
 * copies the new blockmap into that cache, so a client that updated in place
 * already holds it. `out/differentialDownloader/DifferentialDownloader.js`
 * opens the old **artifact** from the local cache (`open(this.options.oldFile,
 * 'r')`), never from the feed. `MacUpdater.js` reaches the same
 * `differentialDownloadInstaller`, so this holds on both platforms.
 *
 * An old artifact in the feed therefore serves rollback and manual download,
 * not differential updates; an old blockmap serves only clients whose cache
 * lost theirs. Artifacts are 138–174 MB and blockmaps are 145–181 KB, so they
 * are kept to different depths.
 * @module
 */

import { compareVersions } from '../src/version-order.ts'

/**
 * How many versions' artifacts the feed keeps: the version just published and
 * the one before it.
 *
 * Two is rollback depth. An old artifact is never fetched during an update —
 * the differential path reads the client's own copy — so the only readers are
 * someone reinstalling the previous build by hand and a rollback that puts the
 * previous manifest back. One version back covers both; a third costs another
 * ~170 MB to serve a version nothing points at.
 */
export const KEPT_ARTIFACT_VERSIONS = 2

/**
 * How many versions' `.blockmap` files the feed keeps.
 *
 * Ten is cheap insurance. A blockmap is only fetched from the feed by a client
 * whose cached `current.blockmap` is gone — a fresh install, a cleared cache, a
 * first update after a manual reinstall — and losing that fetch costs a silent
 * full download rather than an error. Ten versions is under 2 MB, which buys a
 * window several release cycles deep for clients that skipped a few builds.
 */
export const KEPT_BLOCKMAP_VERSIONS = 10

/** Suffix electron-builder gives the block map beside each artifact. */
const BLOCKMAP_SUFFIX = '.blockmap'

/**
 * Manifest names the feed serves. They carry no version in their filename and
 * deleting one takes the channel down, so they are excluded by name rather
 * than by anything the parse happens to decide.
 */
const MANIFEST_NAMES = new Set(['latest.yml', 'latest-mac.yml'])

/** A version string this product publishes: three release numbers and an optional prerelease tail. */
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

/**
 * One artifact name with its version cut out, as `${prefix}${version}${suffix}`.
 * Derived from what this publish uploaded, which is how electron-updater's own
 * `Provider.getBlockMapFiles` addresses another version's files.
 */
interface Template {
  prefix: string
  suffix: string
}

/** What a name in the directory turned out to be. */
interface Parsed {
  version: string
  kind: 'artifact' | 'blockmap'
}

/** Every name the directory holds, sorted into what happens to it. */
export interface PruneSelection {
  /** Artifacts of versions past the artifact window. */
  deleteArtifacts: string[]
  /** Blockmaps of versions past the blockmap window. */
  deleteBlockmaps: string[]
  /** Everything recognized that stays: this publish's own files, the manifests, and both windows. */
  keep: string[]
  /** Names that are not this channel's artifacts or blockmaps at a readable version; never deletion candidates. */
  unparsed: string[]
}

/**
 * Cut the version out of one name against one template.
 * @param name - the directory entry.
 * @param prefix - what precedes the version in that artifact's name.
 * @param suffix - what follows it.
 * @returns the version, or undefined when the name does not fit the template
 * or the piece between prefix and suffix is not a version.
 */
function versionBetween(name: string, prefix: string, suffix: string): string | undefined {
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return undefined
  if (name.length <= prefix.length + suffix.length) return undefined
  const version = name.slice(prefix.length, name.length - suffix.length)
  return VERSION_PATTERN.test(version) ? version : undefined
}

/**
 * Read the naming templates out of what this publish uploaded. The published
 * artifact names carry the published version verbatim — electron-builder
 * substitutes it into `artifactName` — so removing it leaves the pattern every
 * other version of the same artifact follows.
 * @param publishedNames - names this publish uploaded or rewrote in the channel.
 * @param publishedVersion - the version those names carry.
 * @returns one template per published artifact.
 */
function templatesOf(publishedNames: string[], publishedVersion: string): Template[] {
  const templates: Template[] = []
  for (const name of publishedNames) {
    if (name.endsWith(BLOCKMAP_SUFFIX) || MANIFEST_NAMES.has(name)) continue
    const at = name.indexOf(publishedVersion)
    if (at < 0) continue
    templates.push({ prefix: name.slice(0, at), suffix: name.slice(at + publishedVersion.length) })
  }
  return templates
}

/**
 * Recognize one directory entry as an artifact or a blockmap of some version.
 * @param name - the directory entry.
 * @param templates - the naming templates this channel publishes.
 * @returns what it is, or undefined when no template reads it.
 */
function parseName(name: string, templates: Template[]): Parsed | undefined {
  for (const { prefix, suffix } of templates) {
    const blockmap = versionBetween(name, prefix, `${suffix}${BLOCKMAP_SUFFIX}`)
    if (blockmap !== undefined) return { version: blockmap, kind: 'blockmap' }
    const artifact = versionBetween(name, prefix, suffix)
    if (artifact !== undefined) return { version: artifact, kind: 'artifact' }
  }
  return undefined
}

/**
 * Sort one channel directory into what the retention windows keep and what
 * they release.
 *
 * Three rules hold whatever the windows say. A name this publish just uploaded
 * or rewrote is never a deletion candidate, so a directory that somehow holds
 * versions above the one being published cannot take the live files with it. A
 * manifest is never a candidate. A name no template reads — a dmg, a note file,
 * anything hand-copied — lands in `unparsed` and is left alone rather than
 * guessed at.
 *
 * Versions are ordered by [[compareVersions]], never by string comparison:
 * `0.1.0-rc.9` sorts *after* `0.1.0-rc.10` lexicographically, which would keep
 * the older build and delete the newer one.
 * @param names - every entry the channel directory holds.
 * @param publishedVersion - the version this publish just wrote.
 * @param publishedNames - the names it uploaded or rewrote there.
 * @returns each input name in exactly one of the four groups.
 */
export function selectPrunable(names: string[], publishedVersion: string, publishedNames: string[]): PruneSelection {
  const protectedNames = new Set(publishedNames)
  const templates = templatesOf(publishedNames, publishedVersion)
  const parsed = new Map<string, Parsed>()
  for (const name of names) {
    const entry = parseName(name, templates)
    if (entry !== undefined) parsed.set(name, entry)
  }
  const versions = [...new Set([publishedVersion, ...[...parsed.values()].map(entry => entry.version)])]
    .sort((left, right) => compareVersions(right, left))
  const keepArtifacts = new Set(versions.slice(0, KEPT_ARTIFACT_VERSIONS))
  const keepBlockmaps = new Set(versions.slice(0, KEPT_BLOCKMAP_VERSIONS))

  const selection: PruneSelection = { deleteArtifacts: [], deleteBlockmaps: [], keep: [], unparsed: [] }
  for (const name of names) {
    const entry = parsed.get(name)
    if (protectedNames.has(name) || MANIFEST_NAMES.has(name)) {
      selection.keep.push(name)
    } else if (entry === undefined) {
      selection.unparsed.push(name)
    } else if (entry.kind === 'artifact') {
      if (keepArtifacts.has(entry.version)) selection.keep.push(name)
      else selection.deleteArtifacts.push(name)
    } else if (keepBlockmaps.has(entry.version)) {
      selection.keep.push(name)
    } else {
      selection.deleteBlockmaps.push(name)
    }
  }
  return selection
}
