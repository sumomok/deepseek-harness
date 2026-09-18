/**
 * Judging packs against what a component plugin has actually registered.
 *
 * The judgement is whole-pack: a pack whose every requirement is met is active
 * and everything else about it is offered, and a pack with one unmet
 * requirement is inactive and nothing about it is offered. There is no partial
 * state, because half a pack is a page with a hole in it.
 *
 * This module reads no files and no services. The caller reads the pack root,
 * parses each manifest and each declared view, and hands the results here, so
 * the judgement is the same whether it runs against a real pack root or a
 * table written in a test.
 * @module @deepseek-ai/dsh-experimental-skill-pack/src/reconcile
 */

import semver from 'semver'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type {
  PackManifestResult,
  PackMissing,
  PackStatus,
  PackView,
  PackViewRefusal,
  PackViewResult,
  ProvidedPart,
} from './types.ts'

/**
 * Prereleases are compared by their release numbers.
 *
 * Every package in this workspace carries a prerelease version, and a default
 * semver range excludes a prerelease whose release numbers it otherwise
 * covers. Under that default a pack asking for `>=0.3.0` would be refused a
 * plugin at `0.4.0-rc.1`, which is the plugin the pack was written against.
 */
const RANGE_OPTIONS = { includePrerelease: true } as const

/** One pack as reconciliation reads it: its name, its manifest, and its declared views, already read. */
export interface PackObservation {
  /** The skill name the pack's frontmatter declares. */
  readonly skill: string
  /** The parsed manifest, or the field that refused it. */
  readonly manifest: PackManifestResult
  /** One entry per path in `manifest.views`, in that order; empty when the manifest did not parse. */
  readonly views: readonly PackViewResult[]
}

/** How one view file is judged against the surface that would draw it, where a surface is composed. */
export type ViewJudge = (view: PackView, claimed: readonly string[]) => PackViewRefusal | undefined

/**
 * Judge every pack against the registered parts and the platform version.
 *
 * `platformVersion` is a deployment value the plugin validates before it calls
 * here; an unparseable version would satisfy no range and make every
 * platform-bearing pack inactive, which is why the plugin refuses it at load
 * instead.
 *
 * Packs are judged in skill-name order, and an active pack claims its view ids
 * for the packs judged after it: two packs offering one view id is one menu row
 * whose owner would otherwise be decided by load order. A pack that is inactive
 * for another reason claims nothing, so a pack nobody is offered cannot hold an
 * id away from one that would be.
 * @param packs - every pack found in the pack root, in any order.
 * @param providedParts - the parts registered right now; an empty list is the state before any component plugin is mounted.
 * @param platformVersion - the console platform's own exact version.
 * @param judgeView - how a view file is judged; absent where no component
 *   surface is composed, and then a view that parsed is carried through
 *   unjudged, because nothing could draw it either way.
 * @returns one status per pack, in skill-name order.
 */
export function reconcilePacks(
  packs: readonly PackObservation[],
  providedParts: readonly ProvidedPart[],
  platformVersion: string,
  judgeView?: ViewJudge,
): PackStatus[] {
  const pluginVersions = new Map<string, string>()
  const partIds = new Set<string>()
  for (const part of providedParts) {
    if (!pluginVersions.has(part.plugin)) pluginVersions.set(part.plugin, part.version)
    partIds.add(part.id)
  }
  const claimed: string[] = []
  const statuses: PackStatus[] = []
  for (const pack of [...packs].sort((left, right) => left.skill.localeCompare(right.skill))) {
    const { status, viewIds } = judgePack(pack, pluginVersions, partIds, platformVersion, judgeView, claimed)
    if (status.state === 'active') claimed.push(...viewIds)
    statuses.push(status)
  }
  return statuses
}

/**
 * Judge one pack; `missing` comes back in the fixed order manifest, platform,
 * plugins, parts, unreadable views, refused views. `viewIds` is what the pack
 * claims once it is offered, read off the same walk that reports an unreadable
 * view.
 */
function judgePack(
  pack: PackObservation,
  pluginVersions: ReadonlyMap<string, string>,
  partIds: ReadonlySet<string>,
  platformVersion: string,
  judgeView: ViewJudge | undefined,
  claimed: readonly string[],
): { status: PackStatus; viewIds: readonly string[] } {
  if (!pack.manifest.ok) {
    const missing: PackMissing = {
      kind: 'manifest-invalid',
      field: pack.manifest.field,
      reason: pack.manifest.reason,
    }
    return { status: { skill: pack.skill, state: 'inactive', missing: [missing] }, viewIds: [] }
  }
  const manifest = pack.manifest.manifest
  const missing: PackMissing[] = []
  const platform = manifest.pack.platform
  if (platform !== undefined && !semver.satisfies(platformVersion, platform, RANGE_OPTIONS)) {
    missing.push({ kind: 'platform-version', range: platform, present: platformVersion })
  }
  for (const [plugin, range] of Object.entries(manifest.requires.components)) {
    const present = pluginVersions.get(plugin)
    if (present === undefined) {
      missing.push({ kind: 'plugin-absent', plugin, range })
    } else if (!semver.satisfies(present, range, RANGE_OPTIONS)) {
      missing.push({ kind: 'plugin-version', plugin, range, present })
    }
  }
  for (const part of manifest.requires.parts) {
    if (!partIds.has(part)) missing.push({ kind: 'part-absent', part })
  }
  const viewIds: string[] = []
  for (const view of pack.views) {
    if (view.ok) viewIds.push(view.view.id)
    else missing.push({ kind: 'view-unreadable', view: view.path, reason: view.reason })
  }
  if (judgeView !== undefined) {
    // Every view of the pack, so the report names all of them rather than one
    // at a time: a pack whose two views are both wrong is corrected once.
    for (const view of pack.views) {
      if (!view.ok) continue
      const refusal = judgeView(view.view, claimed)
      if (refusal !== undefined) {
        missing.push({ kind: 'view-refused', view: view.path, path: refusal.path, reason: refusal.reason })
      }
    }
  }
  return {
    status: {
      skill: pack.skill,
      version: manifest.pack.version,
      state: missing.length === 0 ? 'active' : 'inactive',
      missing,
    },
    viewIds,
  }
}

/**
 * State one unmet requirement in one line, for a deployment log.
 * @param missing - the unmet requirement.
 * @returns the sentence naming the refused value.
 */
export function describeMissing(missing: PackMissing): string {
  switch (missing.kind) {
    case 'manifest-invalid':
      return `${missing.field} ${missing.reason}`
    case 'platform-version':
      return `platform ${missing.present} is outside ${missing.range}`
    case 'plugin-absent':
      return `${missing.plugin} ${missing.range} is not installed`
    case 'plugin-version':
      return `${missing.plugin} is installed at ${missing.present}, outside ${missing.range}`
    case 'part-absent':
      return `no component plugin registers the part ${missing.part}`
    case 'view-unreadable':
      return `view ${missing.view} is unreadable: ${missing.reason}`
    case 'view-refused':
      return `view ${missing.view} cannot be drawn: ${missing.reason}`
    /* v8 ignore start -- PackMissing is a closed union; a future member must fail compilation here. */
    default:
      return assertNever(missing, 'PackMissing.kind')
    /* v8 ignore stop */
  }
}
