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
import { readsDeclaredViews, viewFormatMissing } from './manifest.ts'
import { compareCodeUnits } from './order.ts'
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
export type ViewJudge = (view: PackView) => PackViewRefusal | undefined

/** One pack as it was judged before the view ids of the whole root were compared. */
interface JudgedPack {
  /** The pack's state and reasons, before a contested view id is counted among them. */
  readonly status: PackStatus
  /** The ids of the views that parsed, empty where this build does not read the format they are written in. */
  readonly viewIds: readonly string[]
}

/**
 * Judge every pack against the registered parts and the platform version.
 *
 * `platformVersion` is a deployment value the plugin validates before it calls
 * here; an unparseable version would satisfy no range and make every
 * platform-bearing pack inactive, which is why the plugin refuses it at load
 * instead.
 *
 * Two packs this root would otherwise offer that declare one view id are both
 * withheld: one menu row cannot have two owners, and choosing the first of them
 * would make what a deployment offers depend on the order its packs were read
 * in. A pack that is inactive for another reason claims nothing, so a pack
 * nobody is offered cannot withhold one that would be.
 * @param packs - every pack found in the pack root, in any order.
 * @param providedParts - the parts registered right now; an empty list is the state before any component plugin is mounted.
 * @param platformVersion - the console platform's own exact version.
 * @param judgeView - how a view file is judged; absent where no component
 *   surface is composed, and then a view that parsed is carried through
 *   unjudged, because nothing could draw it either way.
 * @returns one status per pack, in skill-name order by code unit.
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
  const judged = [...packs]
    .sort((left, right) => compareCodeUnits(left.skill, right.skill))
    .map(pack => judgePack(pack, pluginVersions, partIds, platformVersion, judgeView))
  return withContestedIds(judged)
}

/**
 * Withhold both packs wherever two this root would otherwise offer declare one
 * view id.
 *
 * Judged over the whole root rather than pack by pack, because which pack is
 * being judged cannot decide the answer: a rule that let the first of them keep
 * the id would answer differently depending on where each pack sits in the
 * list.
 * @param judged - every pack, already judged for everything but a contested id.
 * @returns one status per pack, in the order they were judged.
 */
function withContestedIds(judged: readonly JudgedPack[]): PackStatus[] {
  const claimants = new Map<string, string[]>()
  for (const { status, viewIds } of judged) {
    if (status.missing.length > 0) continue
    for (const id of viewIds) claimants.set(id, [...claimants.get(id) ?? [], status.skill])
  }
  const contested = new Map([...claimants].filter(([, skills]) => skills.length > 1))
  return judged.map(({ status, viewIds }) => {
    if (status.missing.length > 0) return status
    const missing = viewIds.flatMap(id => (contested.get(id) ?? [])
      .filter(other => other !== status.skill)
      .map((other): PackMissing => ({ kind: 'view-id-conflict', id, pack: other })))
    return missing.length === 0 ? status : { ...status, state: 'inactive', missing }
  })
}

/**
 * Judge one pack; `missing` comes back in the fixed order manifest, platform,
 * plugins, parts, view format, unreadable views, refused views. `viewIds` is
 * what the pack claims once it is offered, read off the same walk that reports
 * an unreadable view.
 */
function judgePack(
  pack: PackObservation,
  pluginVersions: ReadonlyMap<string, string>,
  partIds: ReadonlySet<string>,
  platformVersion: string,
  judgeView: ViewJudge | undefined,
): JudgedPack {
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
  // A format this build does not read is the pack's only view reason: what
  // each of those files parsed into was read under rules written for another
  // version, so nothing further about them is worth reporting.
  if (!readsDeclaredViews(manifest)) {
    missing.push(viewFormatMissing(manifest))
  } else {
    for (const view of pack.views) {
      if (view.ok) viewIds.push(view.view.id)
      else missing.push({ kind: 'view-unreadable', view: view.path, reason: view.reason })
    }
    if (judgeView !== undefined) {
      // Every view of the pack, so the report names all of them rather than one
      // at a time: a pack whose two views are both wrong is corrected once.
      for (const view of pack.views) {
        if (!view.ok) continue
        const refusal = judgeView(view.view)
        if (refusal !== undefined) {
          missing.push({ kind: 'view-refused', view: view.path, path: refusal.path, reason: refusal.reason })
        }
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
    case 'view-format':
      return `declares views ${missing.stated === undefined ? 'without metadata.pack.viewFormat' : `in view format ${String(missing.stated)}`}`
        + `; this build reads ${missing.reads.join(', ')}`
    case 'view-unreadable':
      return `view ${missing.view} is unreadable: ${missing.reason}`
    case 'view-refused':
      return `view ${missing.view} cannot be drawn: ${missing.reason}`
    case 'view-id-conflict':
      return `the view id ${missing.id} is declared by ${missing.pack} as well`
    /* v8 ignore start -- PackMissing is a closed union; a future member must fail compilation here. */
    default:
      return assertNever(missing, 'PackMissing.kind')
    /* v8 ignore stop */
  }
}
