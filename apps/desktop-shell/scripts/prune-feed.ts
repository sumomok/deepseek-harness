/**
 * Decide what one update-feed directory keeps after a publish, without
 * touching it.
 *
 * The decision is separated from the ssh that carries it out so it can be
 * exercised without a server: `publish-update.ts` lists the remote directory,
 * hands the names here, logs the whole plan — kept, unrecognized, deleted —
 * and only then deletes. A plan is a value; deleting is the caller's separate,
 * explicitly requested step.
 *
 * Retention follows builds, not versions. Two builds of one upstream version
 * now ship as separate releases whose bytes differ, so ordering by version
 * cannot tell them apart and a version-shaped deletion rule would eventually
 * remove the build a client is updating from. A v2 directory's names carry the
 * build sequence, which is this product's only ordering input; a v1 directory
 * predates sequences and keeps its version ordering. The two protocols live in
 * separate directories, and this function reads only the protocol it is told
 * the directory serves: a name from the other naming scheme is left alone
 * rather than deleted by a rule that does not describe it.
 *
 * Some files are outside every window and must still survive, and only the
 * caller knows which: the v1 manifest a bridge build is published through, every
 * artifact that manifest serves, the blockmap an old client derives from each of
 * those artifact names without the manifest ever naming it, and the files the
 * current v2 manifest points at. They arrive as [[PruneProtection]], which this
 * module never infers. A manifest's `files` list is not the whole set: the
 * differential download path asks the feed for `<artifact>.blockmap`, so the
 * caller must protect that name too.
 * @module
 */

import { compareVersions } from '../src/version-order.ts'
import { parseArtifactName } from './artifact-names.ts'

/** Which update protocol one feed directory serves. */
export type FeedProtocol =
  /** The old feed: version-only artifact names, no build sequence anywhere. */
  | 'v1'
  /** The build-addressed feed: every artifact name carries its build sequence. */
  | 'v2'

/**
 * How many builds' artifacts the feed keeps: the build just published and the
 * one before it.
 *
 * Two is rollback depth. An old artifact is never fetched during an update —
 * the differential path reads the client's own copy — so the only readers are
 * someone reinstalling the previous build by hand and a rollback that puts the
 * previous manifest back. One build back covers both; a third costs another
 * ~170 MB to serve a build nothing points at. A v1 directory counts versions
 * here, because a version is the only identity its names carry.
 */
export const KEPT_ARTIFACT_BUILDS = 2

/**
 * How many builds' `.blockmap` files the feed keeps.
 *
 * Ten is cheap insurance. A blockmap is only fetched from the feed by a client
 * whose cached `current.blockmap` is gone — a fresh install, a cleared cache, a
 * first update after a manual reinstall — and losing that fetch costs a silent
 * full download rather than an error. Ten builds is under 2 MB, which buys a
 * window several release cycles deep for clients that skipped a few builds.
 */
export const KEPT_BLOCKMAP_BUILDS = 10

/** The retention windows one directory applies. */
export interface PrunePolicy {
  /** How many builds keep their artifacts. */
  readonly artifactGenerations: number
  /** How many builds keep their blockmaps. */
  readonly blockmapGenerations: number
}

/** The windows this product publishes with. */
export const DEFAULT_PRUNE_POLICY: PrunePolicy = {
  artifactGenerations: KEPT_ARTIFACT_BUILDS,
  blockmapGenerations: KEPT_BLOCKMAP_BUILDS,
}

/**
 * Everything this prune must leave alone, supplied by the caller.
 *
 * Nothing here is inferred. The set that matters most is the v1 bridge: the
 * manifest an old client still reads, every artifact it serves, and the
 * blockmap derived from each of those artifact names by appending `.blockmap`
 * — a name the manifest does not list but the client requests.
 */
export interface PruneProtection {
  /** Entry names that must survive whatever the windows say. */
  readonly names: readonly string[]
  /** Entry-name prefixes whose every match must survive, for a saved recovery copy or a family of files. */
  readonly prefixes: readonly string[]
}

/** Why one entry stays. */
export type PruneKeepReason =
  /** This publish uploaded or rewrote it. */
  | 'published'
  /** It is a feed manifest, which the channel cannot do without. */
  | 'manifest'
  /** The caller protected it explicitly. */
  | 'protected'
  /** Its build is inside the retention window. */
  | 'retained'

/** One entry the plan keeps, with the rule that kept it. */
export interface PruneKept {
  /** The directory entry. */
  readonly name: string
  /** Why it stays. */
  readonly reason: PruneKeepReason
}

/** What one prune decided, with nothing deleted. */
export interface PrunePlan {
  /** Entries that survive, in the order the directory listed them. */
  readonly keep: readonly PruneKept[]
  /** Entries no rule recognizes; never deletion candidates. */
  readonly unparsed: readonly string[]
  /** Artifacts outside the artifact window. */
  readonly deleteArtifacts: readonly string[]
  /** Blockmaps outside the blockmap window. */
  readonly deleteBlockmaps: readonly string[]
  /** Names the caller protected that the directory does not hold; the caller reports them. */
  readonly absentProtections: readonly string[]
}

/**
 * A plan together with what the caller may do with it.
 *
 * `report` is not advice: it is the answer that nothing may be deleted, and the
 * reason is part of the value so a log can say why.
 */
export type PruneDecision = PrunePlan & (
  /** The caller must delete nothing. */
  | { readonly kind: 'report'; readonly reason: string }
  /** The caller may carry out the deletions. */
  | { readonly kind: 'apply' }
)

/** One directory's pruning inputs. */
export interface PruneInputs {
  /** Which protocol the directory serves, which decides how its names are read. */
  readonly protocol: FeedProtocol
  /** Every entry the directory holds, in the order the server listed them. */
  readonly names: readonly string[]
  /** The names this publish uploaded or rewrote there. */
  readonly publishedNames: readonly string[]
  /** What must survive regardless of the windows. */
  readonly protection: PruneProtection
  /** Whether the caller intends to delete; `report` never carries out the plan. */
  readonly operation: 'report' | 'apply'
  /** The windows to apply; defaults to [[DEFAULT_PRUNE_POLICY]]. */
  readonly policy?: PrunePolicy
}

/**
 * Manifest names the feed serves. They carry no build in their filename and
 * deleting one takes the channel down, so they are excluded by name rather
 * than by anything a parse happens to decide.
 */
const MANIFEST_NAMES = new Set(['latest.yml', 'latest-mac.yml'])

/** What one recognized entry is. */
type EntryKind = 'artifact' | 'blockmap'

/** One directory entry this module understands, read under one protocol. */
type ParsedEntry =
  | { readonly name: string; readonly kind: EntryKind; readonly protocol: 'v1'; readonly version: string }
  | { readonly name: string; readonly kind: EntryKind; readonly protocol: 'v2'; readonly version: string; readonly buildSequence: number }

/**
 * Read one directory entry under the protocol the directory serves.
 * @param name - the directory entry.
 * @param protocol - the protocol whose naming this directory uses.
 * @returns the entry, or undefined when the name is not one of this protocol's files.
 */
function parseEntry(name: string, protocol: FeedProtocol): ParsedEntry | undefined {
  const parsed = parseArtifactName(name)
  if (parsed === undefined) return undefined
  const kind: EntryKind = parsed.blockmap ? 'blockmap' : 'artifact'
  if (protocol === 'v2') {
    if (parsed.buildSequence === undefined) return undefined
    return { name, kind, protocol: 'v2', version: parsed.version, buildSequence: parsed.buildSequence }
  }
  // A build-addressed name in a v1 directory belongs to the other protocol.
  // Leaving it in `unparsed` is what keeps the two trees from pruning each
  // other by accident.
  if (parsed.buildSequence !== undefined) return undefined
  return { name, kind, protocol: 'v1', version: parsed.version }
}

/**
 * The retention group of one entry: the build sequence for v2, the version for v1.
 * @param entry - one parsed entry.
 * @returns the key of the group it belongs to.
 */
function entryGroup(entry: ParsedEntry): string {
  return entry.protocol === 'v2' ? buildGroup(entry.buildSequence) : entry.version
}

/**
 * The group key of one build sequence.
 * @param sequence - the build sequence.
 * @returns a key that cannot collide with a version.
 */
function buildGroup(sequence: number): string {
  return `b${String(sequence)}`
}

/**
 * Order the retention groups newest first, by the only ordering the protocol has.
 *
 * The v2 protocol orders by build sequence, which is this product's only
 * ordering input; the v1 protocol has no sequence, so it falls back to semver
 * precedence, never to string comparison: `0.1.0-rc.9` sorts *after*
 * `0.1.0-rc.10` lexicographically, which would keep the older build and delete
 * the newer one.
 * @param entries - every parsed entry of one directory.
 * @param protocol - the protocol the directory serves.
 * @returns one key per group, newest first.
 */
function retentionGroups(entries: readonly ParsedEntry[], protocol: FeedProtocol): string[] {
  if (protocol === 'v2') {
    const sequences = new Set<number>()
    for (const entry of entries) {
      if (entry.protocol === 'v2') sequences.add(entry.buildSequence)
    }
    return [...sequences].sort((left, right) => right - left).map(sequence => buildGroup(sequence))
  }
  const versions = new Set<string>()
  for (const entry of entries) versions.add(entry.version)
  return [...versions].sort((left, right) => compareVersions(right, left))
}

/**
 * Sort one feed directory into what the retention windows keep and what they
 * release.
 *
 * Three rules hold whatever the windows say, and they are checked before the
 * windows: a name this publish just uploaded or rewrote is never a deletion
 * candidate, a manifest is never a candidate, and a name the caller protected —
 * exactly or by prefix — is never a candidate. A name no parser reads, or one
 * that belongs to the other protocol's naming, lands in `unparsed` and is left
 * alone rather than guessed at.
 *
 * The returned decision carries whether the caller may delete. It reports
 * instead of applying when the operator asked for a dry run, and also when no
 * protected file was supplied at all: a directory whose protection the caller
 * did not state is one this function cannot show to be safe to prune, and the
 * bridge a first migration depends on lives exactly in such names.
 * @param inputs - the directory, its protocol, the publish's own files, the
 * caller's protections, and whether deletion was requested.
 * @returns the whole plan and whether it may be carried out.
 */
export function planPrune(inputs: PruneInputs): PruneDecision {
  const policy = inputs.policy ?? DEFAULT_PRUNE_POLICY
  const present = new Set(inputs.names)
  const published = new Set(inputs.publishedNames)
  const protectedNames = new Set(inputs.protection.names)
  const entries = new Map<string, ParsedEntry>()
  for (const name of inputs.names) {
    const entry = parseEntry(name, inputs.protocol)
    if (entry !== undefined) entries.set(name, entry)
  }
  const groups = retentionGroups([...entries.values()], inputs.protocol)
  const artifactGroups = new Set(groups.slice(0, policy.artifactGenerations))
  const blockmapGroups = new Set(groups.slice(0, policy.blockmapGenerations))

  const keep: PruneKept[] = []
  const unparsed: string[] = []
  const deleteArtifacts: string[] = []
  const deleteBlockmaps: string[] = []
  for (const name of inputs.names) {
    if (published.has(name)) {
      keep.push({ name, reason: 'published' })
      continue
    }
    if (MANIFEST_NAMES.has(name)) {
      keep.push({ name, reason: 'manifest' })
      continue
    }
    if (protectedNames.has(name) || inputs.protection.prefixes.some(prefix => name.startsWith(prefix))) {
      keep.push({ name, reason: 'protected' })
      continue
    }
    const entry = entries.get(name)
    if (entry === undefined) {
      unparsed.push(name)
      continue
    }
    const group = entryGroup(entry)
    if (entry.kind === 'artifact') {
      if (artifactGroups.has(group)) keep.push({ name, reason: 'retained' })
      else deleteArtifacts.push(name)
    } else if (blockmapGroups.has(group)) {
      keep.push({ name, reason: 'retained' })
    } else {
      deleteBlockmaps.push(name)
    }
  }

  const plan: PrunePlan = {
    keep,
    unparsed,
    deleteArtifacts,
    deleteBlockmaps,
    absentProtections: [...new Set(inputs.protection.names)].filter(name => !present.has(name)),
  }
  const reason = reportReason(inputs.operation, inputs.protection.names)
  return reason === undefined ? { ...plan, kind: 'apply' } : { ...plan, kind: 'report', reason }
}

/**
 * Why one plan may not be carried out, if it may not.
 * @param operation - what the caller asked for.
 * @param protectionNames - the exact names the caller protected.
 * @returns the reason the plan is report-only, or undefined when it may apply.
 */
function reportReason(operation: 'report' | 'apply', protectionNames: readonly string[]): string | undefined {
  if (operation === 'report') return 'this is a dry run: the plan is printed and nothing is deleted.'
  if (protectionNames.length === 0) {
    return 'no protected file was supplied, so the feed may still serve a file this plan would delete — pass the manifest and every file it references before pruning.'
  }
  return undefined
}
