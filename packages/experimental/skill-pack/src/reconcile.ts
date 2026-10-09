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
import { anchorFormatMissing, readsDeclaredViews, viewFormatMissing } from './manifest.ts'
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

/**
 * The unmet requirements a pack is allowed to be installed carrying.
 *
 * A pack naming a plugin, a part or a platform version this deployment does
 * not have arrived before the row it was written against: it installs, stays
 * inactive, says on the status route what it is waiting for, and activates by
 * itself when that row is composed. A view the composed surface refuses is the
 * opposite case — nothing that arrives later makes it drawable — so it is
 * checked only for a pack whose other requirements this deployment already
 * meets, and it refuses the install. An anchor format this build does not read
 * is never deferred either: which formats a build reads is fixed by the build.
 */
const DEFERRED_REQUIREMENTS: ReadonlySet<PackMissing['kind']> = new Set([
  'platform-version',
  'plugin-absent',
  'plugin-version',
  'part-absent',
])

/** The member naming one view the component surface will not draw. */
export type RefusedView = Extract<PackMissing, { kind: 'view-refused' }>

/**
 * The views of one judged pack this deployment can already say it will not
 * draw. A pack still waiting on a plugin, a part or a platform version has
 * none, because its views were judged against a surface that is not finished
 * arriving.
 * @param status - the pack's status, judged on its own.
 * @returns one member per refused view, in the order the pack declares them.
 */
export function undrawableViews(status: PackStatus): RefusedView[] {
  if (status.missing.some(missing => DEFERRED_REQUIREMENTS.has(missing.kind))) return []
  return status.missing.filter((missing): missing is RefusedView => missing.kind === 'view-refused')
}

/**
 * How one view file is judged against the surface that would draw it, where a
 * surface is composed. A judge that throws on a view refuses that view, at
 * `spec`, with the thrown value's text in the reason, or fixed words where the
 * value has no text ({@link thrownText}).
 */
export type ViewJudge = (view: PackView) => PackViewRefusal | undefined

/**
 * What a thrown value says, in one line, whatever type it is: its own text, or
 * a fixed line when the value refuses to become text — a null-prototype object,
 * or one whose own `toString` throws.
 * @param error - the thrown value.
 * @returns the text of the reason.
 */
function thrownText(error: unknown): string {
  try {
    return String(error)
  } catch {
    // A thrown value whose own conversion to text throws in turn; the reason
    // still has to be written rather than the second throw ending the reading.
    return 'a value that cannot be turned into text'
  }
}

/**
 * Judge one view, reading a judgement that throws as a refusal of that view.
 *
 * The view is a pack author's file and the judge is the composed surface's, so
 * a value the judge does not expect can make it throw — an `Error`, or any
 * other value a judge hands on. Read as a refusal, that withholds the one pack
 * and leaves every other view and pack judged as usual; let through, it would
 * end the whole reading of the pack root, or the judgement of a delivery, with
 * nothing said about which file did it. The reason carries the thrown value's
 * text where it has one ({@link thrownText}).
 * @param judgeView - the composed surface's judgement.
 * @param view - one view file that parsed.
 * @returns the refusal, or `undefined` when the surface draws the view.
 */
function judgeOneView(judgeView: ViewJudge, view: PackView): PackViewRefusal | undefined {
  try {
    return judgeView(view)
  } catch (error) {
    return { path: 'spec', reason: `could not be judged (${thrownText(error)}); a view the component surface has not accepted is not drawn` }
  }
}

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
 * A view id an offered organization pack holds is that pack's: a pack of this
 * root declaring it is withheld, whatever order anything was read in, because
 * the organization set is the deployment's chosen source for a pack delivered
 * both ways. Among what remains, two packs this root would otherwise offer
 * that declare one view id are both withheld: one menu row cannot have two
 * owners, and choosing the first of them would make what a deployment offers
 * depend on the order its packs were read in. A pack that is inactive for
 * another reason, an organization claim included, claims nothing, so a pack
 * nobody is offered cannot withhold one that would be.
 * @param packs - every pack found in the pack root, in any order.
 * @param providedParts - the parts registered right now; an empty list is the state before any component plugin is mounted.
 * @param platformVersion - the console platform's own exact version.
 * @param judgeView - how a view file is judged; absent where no component
 *   surface is composed, and then a view that parsed is carried through
 *   unjudged, because nothing could draw it either way.
 * @param held - view id to the skill name of the active organization pack
 *   holding it; absent where no organization set is offered.
 * @returns one status per pack, in skill-name order by code unit.
 */
export function reconcilePacks(
  packs: readonly PackObservation[],
  providedParts: readonly ProvidedPart[],
  platformVersion: string,
  judgeView?: ViewJudge,
  held: ReadonlyMap<string, string> = new Map(),
): PackStatus[] {
  const parts = indexParts(providedParts)
  const judged = [...packs]
    .sort((left, right) => compareCodeUnits(left.skill, right.skill))
    .map(pack => judgePack(pack, parts, platformVersion, judgeView))
  return withContestedIds(judged.map(pack => withHeldIds(pack, held)))
}

/**
 * Judge one pack on its own, against nothing but the registered parts and the
 * platform version: no other pack's view ids are compared with its own.
 * @param pack - the pack, already read.
 * @param providedParts - the parts registered right now.
 * @param platformVersion - the console platform's own exact version.
 * @param judgeView - how a view file is judged; absent where no component surface is composed.
 * @returns the pack's status, with `origin: 'pack-root'` for the caller to restate.
 */
export function judgePackAlone(
  pack: PackObservation,
  providedParts: readonly ProvidedPart[],
  platformVersion: string,
  judgeView?: ViewJudge,
): PackStatus {
  return judgePack(pack, indexParts(providedParts), platformVersion, judgeView).status
}

/** The registered parts as a judgement reads them: each plugin's first-seen version, and every part id. */
interface PartIndex {
  readonly pluginVersions: ReadonlyMap<string, string>
  readonly partIds: ReadonlySet<string>
}

/** Index the registered parts once for every pack judged against them. */
function indexParts(providedParts: readonly ProvidedPart[]): PartIndex {
  const pluginVersions = new Map<string, string>()
  const partIds = new Set<string>()
  for (const part of providedParts) {
    if (!pluginVersions.has(part.plugin)) pluginVersions.set(part.plugin, part.version)
    partIds.add(part.id)
  }
  return { pluginVersions, partIds }
}

/**
 * Withhold a pack that would otherwise be offered and declares a view id an
 * offered organization pack holds, naming that pack for each such id.
 * @param judged - one pack, judged for everything but its view ids.
 * @param held - view id to the skill name of the organization pack holding it.
 * @returns the pack, unchanged or withheld; a withheld pack claims no id.
 */
function withHeldIds(judged: JudgedPack, held: ReadonlyMap<string, string>): JudgedPack {
  if (judged.status.missing.length > 0) return judged
  const missing = [...new Set(judged.viewIds)].flatMap((id): PackMissing[] => {
    const holder = held.get(id)
    return holder === undefined ? [] : [{ kind: 'view-id-conflict', id, pack: holder, origin: 'organization' }]
  })
  return missing.length === 0 ? judged : { status: { ...judged.status, state: 'inactive', missing }, viewIds: [] }
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
      .map((other): PackMissing => ({ kind: 'view-id-conflict', id, pack: other, origin: 'pack-root' })))
    return missing.length === 0 ? status : { ...status, state: 'inactive', missing }
  })
}

/**
 * Judge one pack; `missing` comes back in the fixed order manifest, platform,
 * plugins, parts, anchor format, view format, unreadable views, refused views. `viewIds` is
 * what the pack claims once it is offered, read off the same walk that reports
 * an unreadable view.
 */
function judgePack(
  pack: PackObservation,
  { pluginVersions, partIds }: PartIndex,
  platformVersion: string,
  judgeView: ViewJudge | undefined,
): JudgedPack {
  if (!pack.manifest.ok) {
    const missing: PackMissing = {
      kind: 'manifest-invalid',
      field: pack.manifest.field,
      reason: pack.manifest.reason,
    }
    return { status: { skill: pack.skill, origin: 'pack-root', state: 'inactive', missing: [missing] }, viewIds: [] }
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
  const anchorFormat = anchorFormatMissing(manifest)
  if (anchorFormat !== undefined) missing.push(anchorFormat)
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
        const refusal = judgeOneView(judgeView, view.view)
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
      origin: 'pack-root',
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
    case 'anchor-format':
      return `states anchor format ${String(missing.stated)}; this build reads ${missing.reads.join(', ')}`
    case 'view-format':
      return `declares views ${missing.stated === undefined ? 'without metadata.pack.viewFormat' : `in view format ${String(missing.stated)}`}`
        + `; this build reads ${missing.reads.join(', ')}`
    case 'view-unreadable':
      return `view ${missing.view} is unreadable: ${missing.reason}`
    case 'view-refused':
      return `view ${missing.view} cannot be drawn: ${missing.reason}`
    case 'view-id-conflict':
      return missing.origin === 'organization'
        ? `the view id ${missing.id} is held by the organization pack ${missing.pack}`
        : `the view id ${missing.id} is declared by ${missing.pack} as well`
    /* v8 ignore start -- PackMissing is a closed union; a future member must fail compilation here. */
    default:
      return assertNever(missing, 'PackMissing.kind')
    /* v8 ignore stop */
  }
}
