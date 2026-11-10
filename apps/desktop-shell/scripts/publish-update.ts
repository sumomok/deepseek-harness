/**
 * Publish a verified final desktop artifact inventory. Build identities are
 * independent of the checkout running this command. Bridge builds target v1;
 * standard builds target v2. Artifacts and sequence reservations are immutable.
 * Each platform's v2 build must have a higher sequence and a runtime at least
 * as new as its identified bridge, regardless of which protocol is published first.
 *
 * One remote atomic directory lock covers history, preflight, recovery copies,
 * uploads, pointer replacement, readback and pruning across both protocols and
 * platforms. Each attempt has unique local and remote staging paths. Mutations
 * run once; a lost response retains the lock for manual reconciliation, even
 * when pointer readback confirms its target. Locks never expire automatically.
 *
 * Before replacing a pointer or deleting artifacts, the publisher preserves and
 * independently hashes its predecessor and download dependencies, and saves
 * release records plus local/origin tag refs. Legacy directories retain every
 * recognized artifact and blockmap. Recovery files are outside prune scope.
 *
 * Platform pointers commit independently. Typed failures distinguish confirmed
 * partial publication from unknown outcomes. Client URL readback must match
 * identity, files, digests, sizes and red lines before tagging. Dry runs perform
 * advisory remote reads without uploading or acquiring the publication lock.
 * @module
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { CORE_SCHEMA, DEFAULT_SCHEMA, dump, load } from 'js-yaml'
import {
  expectedArtifacts,
  parseArtifactName,
  verifyArtifactDigests,
  type ArtifactDigestMismatch,
} from './artifact-names.ts'
import { ensurePathContainment, validateFeedFileName, validateFeedVersion } from '../src/feed-validation.ts'
import {
  isSameBuild,
  parseDesktopReleaseMetadata,
  parseReleaseIdentity,
  ReleaseIdentityError,
  type ReleaseIdentity,
  type ReleasePlatform,
} from '../src/release-identity.ts'
import {
  parseReleaseManifest,
  releaseManifestArtifacts,
  releaseManifestIdentity,
  ReleaseManifestError,
  type ReleaseManifest,
  type ReleaseManifestArtifact,
} from './release-manifest.ts'
import {
  planPrune,
  type FeedProtocol,
  type PruneDecision,
  type PruneProtection,
} from './prune-feed.ts'
import { PublishTransaction, PublishTransactionError, shellQuote } from './publish-transaction.ts'
import { planReleaseTag, releaseTagName, type ReleaseTagPlan, type RepositoryState } from './release-tag.ts'
import { compareVersions } from '../src/version-order.ts'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(APP_DIR, 'dist-app')

/** The ssh alias that reaches the update server; key-based, no password prompt. */
const REMOTE_HOST = 'macmini-rescue-server'

/**
 * Keepalives for every ssh call. A publish pushes a few hundred megabytes over
 * one long-lived connection, which is exactly the traffic a NAT or firewall
 * idle timer cuts; without these the transfer dies partway through.
 */
const SSH_KEEPALIVE = ['-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=8']

/** Document root of the feed on that host, served by nginx under /dsh-updates/. */
const REMOTE_ROOT = '/var/www/dsh-updates'

/** Public base of the feed, matching the `publish` blocks in electron-builder.yml. */
const FEED_BASE = 'https://lhr.ink/dsh-updates'

/** The base64 form of a 64-byte SHA-512 digest, which is what electron-builder writes. */
const SHA512_BASE64_PATTERN = /^[A-Za-z0-9+/]{86}==$/u

/** Suffix electron-builder gives the block map beside each artifact. */
const BLOCKMAP_SUFFIX = '.blockmap'

/** One platform's feed: its manifest, its platform, and its directory name. */
export interface FeedChannel {
  /** Feed subdirectory and log label. */
  readonly name: 'win' | 'mac'
  /** The platform whose artifacts this channel serves. */
  readonly platform: ReleasePlatform
  /** Manifest the update library fetches for this platform. */
  readonly manifest: string
}

/** Every channel this product publishes, in the order a publish normally touches them. */
export const FEED_CHANNELS: readonly FeedChannel[] = [
  { name: 'win', platform: 'win32', manifest: 'latest.yml' },
  { name: 'mac', platform: 'darwin', manifest: 'latest-mac.yml' },
]

/** One directory a publish reads and writes. */
export interface ChannelLocation {
  /** Which protocol's naming this directory serves. */
  readonly protocol: FeedProtocol
  /** The platform channel. */
  readonly channel: FeedChannel
  /** Destination directory relative to the feed root, e.g. `win` or `v2/mac`. */
  readonly relative: string
  /** Absolute destination directory on the update server. */
  readonly remoteDir: string
  /** Base URL a client fetches that directory from. */
  readonly url: string
}

/** Stable machine identity of every refusal this module raises. */
export type PublishErrorCode =
  /** The publish did not start, or stopped before any pointer moved. */
  | 'PUBLISH_REFUSED'
  /** Nothing reached the feed, but a command that was supposed to failed. */
  | 'PUBLISH_FAILED'
  /** At least one platform's pointer moved and another did not. */
  | 'PUBLISH_PARTIAL'
  | 'PUBLISH_UNKNOWN'
  | 'PUBLISH_LOCKED'

/**
 * A refusal this module raises, carrying the stable discriminant callers branch
 * on and the part of the release it is about.
 */
export class PublishError extends Error {
  /** Stable machine identity; never parsed out of [[message]]. */
  readonly code: PublishErrorCode

  /** The file, field, or directory the refusal is about. */
  readonly subject: string

  /**
   * @param code - the stable discriminant.
   * @param subject - the file, field, or directory that failed.
   * @param detail - what was wrong, appended to the human-readable message.
   */
  constructor(code: PublishErrorCode, subject: string, detail: string, cause?: unknown) {
    super(`${subject}: ${detail}`, { cause })
    this.name = 'PublishError'
    this.code = code
    this.subject = subject
  }
}

/**
 * Build the refusal for a publish that must not start.
 * @param subject - the file, field, or directory that failed.
 * @param detail - what was wrong and how to fix it.
 * @returns the error to throw.
 */
function refuse(subject: string, detail: string): PublishError {
  return new PublishError('PUBLISH_REFUSED', subject, detail)
}

/**
 * Shorten a value for a one-line diagnostic without echoing unbounded input.
 * @param value - the value to describe.
 * @returns a short description, quoted when it is a string.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value.length > 64 ? `${JSON.stringify(value.slice(0, 64))}…` : JSON.stringify(value)
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

/**
 * Whether a value is a YAML mapping.
 * @param value - the candidate.
 * @returns true for a non-null, non-array object.
 */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The protocol a build publishes to, decided by its kind alone.
 * @param identity - the build being published.
 * @returns `v1` for a bridge build, `v2` for a standard one.
 */
export function feedProtocolFor(identity: ReleaseIdentity): FeedProtocol {
  return identity.dshRelease.kind === 'bridge' ? 'v1' : 'v2'
}

/**
 * Resolve the protocol this publish writes, refusing a request that names the
 * other one.
 *
 * The flag exists so an operator can state the intent the feed layout encodes,
 * and so a mistyped target is a refusal rather than a publish into the wrong
 * tree: a bridge belongs to the old clients' directory and a standard build to
 * the new one, and neither can serve the other's clients.
 * @param identity - the build being published.
 * @param requested - the raw `--feed-protocol` value, absent when the run did not pass it.
 * @returns the protocol the identity belongs to.
 * @throws [[PublishError]] when the requested protocol is unknown or disagrees
 * with the build's kind.
 */
export function resolveFeedProtocol(identity: ReleaseIdentity, requested: string | undefined): FeedProtocol {
  const derived = feedProtocolFor(identity)
  if (requested === undefined) return derived
  if (requested !== 'v1' && requested !== 'v2') {
    throw refuse('--feed-protocol', `must be v1 or v2, got ${describe(requested)}`)
  }
  if (requested !== derived) {
    throw refuse(
      '--feed-protocol',
      `a ${identity.dshRelease.kind} build publishes to ${derived} only, not ${requested} — the other directory serves the other protocol's clients`,
    )
  }
  return derived
}

/**
 * The directory one channel is published into under one protocol.
 * @param protocol - the protocol whose tree is addressed.
 * @param channel - the platform channel.
 * @returns the relative path, the absolute remote directory, and the client URL base.
 */
export function channelLocation(protocol: FeedProtocol, channel: FeedChannel): ChannelLocation {
  const relative = protocol === 'v2' ? `v2/${channel.name}` : channel.name
  return {
    protocol,
    channel,
    relative,
    remoteDir: `${REMOTE_ROOT}/${relative}`,
    url: `${FEED_BASE}/${relative}`,
  }
}

/** One artifact entry of a feed manifest, as `files[]` states it. */
export interface FeedFile {
  /** The bare file name the entry names. */
  readonly url: string
  /** The base64 SHA-512 of those bytes. */
  readonly sha512: string
  /** The artifact's byte length. */
  readonly size: number
}

/** One live feed manifest, read and validated. */
export interface LiveFeed {
  /** The protocol whose directory this manifest was read from. */
  readonly protocol: FeedProtocol
  /** The version the manifest serves. */
  readonly version: string
  /** Every artifact entry the manifest lists. */
  readonly files: readonly FeedFile[]
  /** The bytes as served, kept for the pre-pointer re-read comparison. */
  readonly text: string
  /** The v1 red line, when the manifest sets one. */
  readonly minimumVersion?: string
  /** The build identity a v2 manifest repeats. */
  readonly identity?: ReleaseIdentity
  /** The v2 red line in build-sequence terms, when the manifest sets one. */
  readonly minimumBuildSequence?: number
}

/**
 * What one channel's live feed reading found.
 *
 * The three failures are deliberately distinct: a first publish has no feed,
 * and an unreadable or malformed one must stop the publish instead of being
 * mistaken for the first. Only [[channelLocation]]'s own directory is read for
 * ordering; the other protocol's feed is read for the prune protection set.
 */
export type LiveRead =
  /** No manifest is there: this is the channel's first publish. */
  | { readonly kind: 'absent' }
  /** The manifest was read and validated. */
  | { readonly kind: 'present'; readonly feed: LiveFeed }
  /** The server could not be read; the feed may or may not exist. */
  | { readonly kind: 'unreadable'; readonly reason: string }
  /** The bytes came back but are not a usable manifest. */
  | { readonly kind: 'damaged'; readonly reason: string }

/**
 * Turn one `files[].url` into the feed directory entry it names.
 *
 * The name is what an upload writes and what a client asks for, so it is the
 * decoded, validated file name; a name that escapes the directory, carries a
 * separator, or is a Windows reserved name is refused by the shared validator.
 * @param url - the manifest's entry.
 * @returns the bare, validated file name.
 * @throws when the entry names no usable feed file.
 */
function feedFileName(url: unknown): string {
  const text = typeof url === 'string' ? url : invalidFileEntry(`must be a string, got ${describe(url)}`)
  let decoded = text
  try {
    decoded = decodeURIComponent(text)
  } catch {
    // A malformed escape is not a percent-encoded name; the raw value is then
    // checked on its own, and the validator decides whether it is usable.
  }
  return validateFeedFileName(decoded)
}

/**
 * Throw the refusal for one unusable feed file entry.
 * @param detail - what was wrong.
 * @returns never; the return type keeps the caller's expression typed.
 * @throws [[PublishError]] always.
 */
function invalidFileEntry(detail: string): never {
  throw refuse('feed manifest files[].url', detail)
}

/**
 * Read the `files[]` entries of a live manifest.
 * @param value - the manifest's `files` value.
 * @returns every entry, validated.
 * @throws [[PublishError]] when an entry is missing or malformed.
 */
function parseLiveFiles(value: unknown): FeedFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw refuse('live manifest files[]', `must be a non-empty array, got ${describe(value)}`)
  }
  return value.map((entry, index) => {
    const subject = `live manifest files[${String(index)}]`
    if (!isMapping(entry)) throw refuse(subject, `must be a mapping, got ${describe(entry)}`)
    let fileName: string
    try {
      fileName = feedFileName(entry.url)
    } catch (error) {
      throw refuse(subject, `names no usable feed file: ${error instanceof Error ? error.message : String(error)}`)
    }
    const sha512 = entry.sha512
    if (typeof sha512 !== 'string' || !SHA512_BASE64_PATTERN.test(sha512)) {
      throw refuse(`${subject}.sha512`, `must be the base64 form of a SHA-512 digest, got ${describe(sha512)}`)
    }
    const size = entry.size
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
      throw refuse(`${subject}.size`, `must be a positive safe integer, got ${describe(size)}`)
    }
    return { url: fileName, sha512, size }
  })
}

/**
 * Parse one live feed manifest under the protocol its directory serves.
 *
 * A v2 manifest must carry a usable `dshRelease` of a `standard` build; the v2
 * feed never delivers a bridge, and without a build sequence there is nothing
 * to order against. A v1 manifest has no identity to read, so ordering falls
 * back to its version. Anything unreadable is refused here and turned into
 * [[LiveRead]]'s `damaged` case by the reader, which keeps "not there" strictly
 * apart from "there but unusable".
 * @param protocol - the protocol whose directory the bytes came from.
 * @param text - the manifest's bytes.
 * @returns the validated manifest.
 * @throws [[PublishError]] when the bytes do not describe a usable feed.
 */
export function parseLiveFeed(protocol: FeedProtocol, text: string): LiveFeed {
  let parsed: unknown
  try {
    parsed = load(text, { schema: CORE_SCHEMA })
  } catch (error) {
    throw refuse('live manifest', `does not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isMapping(parsed)) throw refuse('live manifest', `must be a YAML mapping, got ${describe(parsed)}`)
  const versionValue = parsed.version
  if (typeof versionValue !== 'string') throw refuse('live manifest version', `must be a string, got ${describe(versionValue)}`)
  let version: string
  try {
    version = validateFeedVersion(versionValue)
  } catch (error) {
    throw refuse('live manifest version', error instanceof Error ? error.message : String(error))
  }
  const files = parseLiveFiles(parsed.files)
  if (protocol === 'v1') {
    const minimumValue = parsed.minimumVersion
    let minimumVersion: string | undefined
    if (minimumValue !== undefined) {
      try {
        minimumVersion = validateFeedVersion(minimumValue)
      } catch (error) {
        throw refuse('live manifest minimumVersion', error instanceof Error ? error.message : String(error))
      }
    }
    return { protocol, version, files, text, ...minimumVersion === undefined ? {} : { minimumVersion } }
  }
  let identity: ReleaseIdentity
  try {
    identity = parseReleaseIdentity(parsed)
  } catch (error) {
    throw refuse('live manifest dshRelease', error instanceof Error ? error.message : String(error))
  }
  if (identity.dshRelease.kind !== 'standard') {
    throw refuse('live manifest dshRelease.kind', `the v2 feed delivers standard builds only, got ${identity.dshRelease.kind}`)
  }
  const minimumRaw = parsed.minimumBuildSequence
  let minimumBuildSequence: number | undefined
  if (minimumRaw !== undefined) {
    if (typeof minimumRaw !== 'number' || !Number.isSafeInteger(minimumRaw) || minimumRaw <= 0) {
      throw refuse('live manifest minimumBuildSequence', `must be a positive safe integer, got ${describe(minimumRaw)}`)
    }
    if (minimumRaw > identity.dshRelease.buildSequence) {
      throw refuse(
        'live manifest minimumBuildSequence',
        `is ${String(minimumRaw)}, above the served build ${String(identity.dshRelease.buildSequence)}, which would leave every client stuck`,
      )
    }
    minimumBuildSequence = minimumRaw
  }
  return {
    protocol,
    version: identity.version,
    files,
    text,
    identity,
    ...minimumBuildSequence === undefined ? {} : { minimumBuildSequence },
  }
}

/** What one channel's preflight decided the publish will do there. */
export interface ChannelPublishPlan {
  /** The platform channel. */
  readonly channel: FeedChannel
  /** The protocol tree this publish writes. */
  readonly protocol: FeedProtocol
  /** The reading the ordering decision used, kept for the pre-pointer re-read. */
  readonly liveRead: LiveRead
  /** The live feed this channel serves, when there is one. */
  readonly live: LiveFeed | undefined
  /** The red line to write into the v2 manifest, if any. */
  readonly minimumBuildSequence?: number
  /** The red line to write into the v1 manifest, if any. */
  readonly minimumVersion?: string
  /** Whether this run finishes a build the feed already names. */
  readonly republish: boolean
  /** Whether the feed already serves this build (v2) or this bridge version (v1). */
  readonly alreadyServed: boolean
  /** The previous v2 red line this run was asked to move down, for the warning. */
  readonly loweredBuildSequence?: number
  /** The previous v1 red line this run was asked to move down, for the warning. */
  readonly loweredVersion?: string
}

/** One channel's publish inputs. */
export interface ChannelPublishInputs {
  /** The platform channel this preflight is about. */
  readonly channel: FeedChannel
  /** The build being published. */
  readonly identity: ReleaseIdentity
  /** What the channel's own directory currently holds. */
  readonly live: LiveRead
  /** Whether an already-served build may be re-published with identical bytes. */
  readonly republish: boolean
  /** The v2 red line the operator asked for. */
  readonly minimumBuildSequence?: number
  /** The v1 red line the operator asked for. */
  readonly minimumVersion?: string
}

/**
 * Decide whether one channel may be published, and with which red line.
 *
 * Ordering is per protocol and per platform: a v2 channel orders by build
 * sequence alone, and one sequence may not name two builds, so a sequence that
 * is already served is accepted only when the identity is exactly the same and
 * `--republish` asked to finish it. A v1 channel predates sequences and keeps
 * the version comparison it always used, with the same rule for an equal
 * version. A red line is inherited from the live manifest when the run does not
 * set one, so omitting the flag can never lower it; one the operator sets must
 * still leave the target build reachable.
 * @param inputs - the channel, the build, the live reading, and the requested red lines.
 * @returns what this channel's publish will write.
 * @throws [[PublishError]] when the channel must not be published.
 */
export function planChannelPublish(inputs: ChannelPublishInputs): ChannelPublishPlan {
  const { channel, identity, live } = inputs
  const protocol = feedProtocolFor(identity)
  const label = channelLocation(protocol, channel).relative
  if (protocol === 'v1' && inputs.minimumBuildSequence !== undefined) {
    throw refuse('--minimum-build-sequence', 'is the v2 red line; a bridge publish writes the v1 minimumVersion instead')
  }
  if (protocol === 'v2' && inputs.minimumVersion !== undefined) {
    throw refuse('--minimum-version', 'is the v1 red line; a v2 publish writes minimumBuildSequence instead')
  }
  if (live.kind === 'unreadable') {
    throw refuse(
      `${label}/${channel.manifest}`,
      `could not be read (${live.reason}); an unreadable feed is not an empty one, so nothing is published until it can be checked`,
    )
  }
  if (live.kind === 'damaged') {
    throw refuse(
      `${label}/${channel.manifest}`,
      `is not a usable feed manifest (${live.reason}); repair the served manifest first — it is neither absent nor safe to replace blindly`,
    )
  }
  if (live.kind === 'absent') {
    return {
      channel,
      protocol,
      liveRead: live,
      live: undefined,
      republish: false,
      alreadyServed: false,
      ...firstPublishRedLine(protocol, identity, inputs.minimumBuildSequence, inputs.minimumVersion),
    }
  }
  const feed = live.feed
  if (feed.protocol !== protocol) {
    throw refuse(`${label}/${channel.manifest}`, `was read as ${feed.protocol} but this publish writes ${protocol}`)
  }
  return protocol === 'v2'
    ? planStandardChannel(channel, identity, live, feed, inputs)
    : planBridgeChannel(channel, identity, live, feed, inputs)
}

/**
 * The red line a first publish may set, from the requested value alone.
 * @param protocol - the tree being written.
 * @param identity - the build being published.
 * @param requestedBuildSequence - the v2 red line the operator asked for.
 * @param requestedVersion - the v1 red line the operator asked for.
 * @returns the optional red-line fields of a [[ChannelPublishPlan]].
 * @throws [[PublishError]] when the requested line is not usable.
 */
function firstPublishRedLine(
  protocol: FeedProtocol,
  identity: ReleaseIdentity,
  requestedBuildSequence: number | undefined,
  requestedVersion: string | undefined,
): Pick<ChannelPublishPlan, 'minimumBuildSequence' | 'minimumVersion'> {
  if (protocol === 'v2') {
    const minimumBuildSequence = usableBuildSequence(requestedBuildSequence, identity)
    return minimumBuildSequence === undefined ? {} : { minimumBuildSequence }
  }
  const minimumVersion = usableMinimumVersion(requestedVersion, identity.version)
  return minimumVersion === undefined ? {} : { minimumVersion }
}

/**
 * Validate one v2 red line against the build it accompanies.
 * @param value - the requested line, if any.
 * @param identity - the build being published.
 * @returns the line, or undefined when none was requested.
 * @throws [[PublishError]] when it is not a positive safe integer or would sit
 * above the build, which no client below it could ever reach.
 */
function usableBuildSequence(value: number | undefined, identity: ReleaseIdentity): number | undefined {
  if (value === undefined) return undefined
  const sequence = identity.dshRelease.buildSequence
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw refuse('--minimum-build-sequence', `must be a positive safe integer, got ${describe(value)}`)
  }
  if (value > sequence) {
    throw refuse(
      '--minimum-build-sequence',
      `is ${String(value)}, above the ${String(sequence)} being published, which would leave every client stuck below the line`,
    )
  }
  return value
}

/**
 * Validate one v1 red line against the version it accompanies.
 * @param value - the requested line, if any.
 * @param version - the version being published.
 * @returns the line, or undefined when none was requested.
 * @throws [[PublishError]] when it is not a feed version or sits above the
 * version being published.
 */
function usableMinimumVersion(value: string | undefined, version: string): string | undefined {
  if (value === undefined) return undefined
  let validated: string
  try {
    validated = validateFeedVersion(value)
  } catch (error) {
    throw refuse('--minimum-version', error instanceof Error ? error.message : String(error))
  }
  if (compareVersions(validated, version) > 0) {
    throw refuse(
      '--minimum-version',
      `is ${validated}, above the ${version} being published, which would leave every client stuck below the line`,
    )
  }
  return validated
}

/**
 * Decide a v2 channel against its own live manifest.
 * @param channel - the platform channel.
 * @param identity - the standard build being published.
 * @param live - the reading, already known to be `present`.
 * @param feed - the parsed live manifest.
 * @param inputs - the request, for the red line.
 * @returns the channel plan.
 * @throws [[PublishError]] for a rollback, an identity conflict, or a red line
 * that is unusable.
 */
function planStandardChannel(
  channel: FeedChannel,
  identity: ReleaseIdentity,
  live: Extract<LiveRead, { kind: 'present' }>,
  feed: LiveFeed,
  inputs: ChannelPublishInputs,
): ChannelPublishPlan {
  const label = channelLocation('v2', channel).relative
  const liveIdentity = feed.identity
  if (liveIdentity === undefined) {
    throw refuse(`${label}/${channel.manifest}`, 'carries no dshRelease identity, so the served build cannot be ordered')
  }
  if (compareVersions(identity.dshRelease.runtimeVersion, liveIdentity.dshRelease.runtimeVersion) < 0) {
    throw refuse(`${label}/${channel.manifest}`, `runtime ${identity.dshRelease.runtimeVersion} is below the served ${liveIdentity.dshRelease.runtimeVersion}; clients reject runtime downgrades`)
  }
  const targetSequence = identity.dshRelease.buildSequence
  const liveSequence = liveIdentity.dshRelease.buildSequence
  if (targetSequence < liveSequence) {
    throw refuse(
      `${label}/${channel.manifest}`,
      `serves build ${String(liveSequence)}, newer than the ${String(targetSequence)} being published; a build sequence never moves backwards — allocate a larger one`,
    )
  }
  const alreadyServed = targetSequence === liveSequence
  if (alreadyServed && !isSameBuild(identity, liveIdentity)) {
    throw refuse(
      `${label}/${channel.manifest}`,
      `already names build ${String(targetSequence)} as ${describeIdentity(liveIdentity)}, but this release is ${describeIdentity(identity)}; one sequence may not name two builds — allocate a new one`,
    )
  }
  if (alreadyServed && !inputs.republish) {
    throw refuse(
      `${label}/${channel.manifest}`,
      `already serves ${describeIdentity(identity)}; pass --republish to finish an interrupted publish of the identical build`,
    )
  }
  const requested = usableBuildSequence(inputs.minimumBuildSequence, identity)
  const inherited = feed.minimumBuildSequence
  const minimumBuildSequence = requested ?? inherited
  if (minimumBuildSequence !== undefined && minimumBuildSequence > targetSequence) {
    throw refuse(
      'minimumBuildSequence',
      `would be ${String(minimumBuildSequence)}, above the ${String(targetSequence)} being published`,
    )
  }
  const lowered = requested !== undefined && inherited !== undefined && requested < inherited ? inherited : undefined
  return {
    channel,
    protocol: 'v2',
    liveRead: live,
    live: feed,
    republish: inputs.republish,
    alreadyServed,
    ...minimumBuildSequence === undefined ? {} : { minimumBuildSequence },
    ...lowered === undefined ? {} : { loweredBuildSequence: lowered },
  }
}

/**
 * Decide a bridge channel against its own live manifest.
 *
 * v1 has no identity to compare, so it keeps the version ordering the old
 * publisher used. Two different builds of one bridge version are caught by the
 * live manifest's recorded digests and then by the immutable upload check: the
 * second build's bytes cannot match the names the first one already published,
 * so the publish stops before the pointer moves.
 * @param channel - the platform channel.
 * @param identity - the bridge build being published.
 * @param live - the reading, already known to be `present`.
 * @param feed - the parsed live manifest.
 * @param inputs - the request, for the red line.
 * @returns the channel plan.
 * @throws [[PublishError]] for a rollback, an equal version without
 * `--republish`, or an unusable red line.
 */
function planBridgeChannel(
  channel: FeedChannel,
  identity: ReleaseIdentity,
  live: Extract<LiveRead, { kind: 'present' }>,
  feed: LiveFeed,
  inputs: ChannelPublishInputs,
): ChannelPublishPlan {
  const label = channel.name
  const order = compareVersions(identity.version, feed.version)
  if (order < 0) {
    throw refuse(
      `${label}/${channel.manifest}`,
      `serves ${feed.version}, newer than the ${identity.version} being published; the old feed orders by version, so publish a higher bridge version`,
    )
  }
  const sameVersion = order === 0
  if (sameVersion && !inputs.republish) {
    throw refuse(
      `${label}/${channel.manifest}`,
      `already serves ${identity.version}; pass --republish to finish an interrupted publish of the identical bytes`,
    )
  }
  const requested = usableMinimumVersion(inputs.minimumVersion, identity.version)
  const inherited = feed.minimumVersion
  const minimumVersion = requested ?? inherited
  if (minimumVersion !== undefined && compareVersions(minimumVersion, identity.version) > 0) {
    throw refuse('minimumVersion', `would be ${minimumVersion}, above the ${identity.version} being published`)
  }
  const lowered = requested !== undefined && inherited !== undefined && compareVersions(requested, inherited) < 0
    ? inherited
    : undefined
  return {
    channel,
    protocol: 'v1',
    liveRead: live,
    live: feed,
    republish: inputs.republish,
    alreadyServed: sameVersion,
    ...minimumVersion === undefined ? {} : { minimumVersion },
    ...lowered === undefined ? {} : { loweredVersion: lowered },
  }
}

/** One local artifact's bytes, as this run computed them. */
export interface LocalArtifactFile {
  /** The base64 SHA-512 the bytes carry. */
  readonly sha512: string
  /** The byte length. */
  readonly size: number
}

/** What the dist-app build holds for one platform's declared artifacts. */
export interface ReleaseArtifactReport {
  /** Declared artifacts the build directory does not hold. */
  readonly missing: readonly string[]
  /** Declared artifacts whose bytes carry another digest. */
  readonly mismatched: readonly ArtifactDigestMismatch[]
  /** Declared artifacts whose byte length disagrees with the manifest. */
  readonly sizeMismatches: readonly { readonly fileName: string; readonly expected: number; readonly actual: number }[]
  /** Files this identity's naming produces that the release manifest does not declare. */
  readonly undeclaredExpected: readonly string[]
  /** Declared names outside this platform's exact target inventory. */
  readonly unexpected: readonly string[]
}

/**
 * Compare one platform's built artifacts against the release manifest.
 *
 * `dist-app` accumulates across builds, so presence alone proves nothing; the
 * manifest's digest is what separates this build's bytes from a leftover under
 * the same name. The expected-name check uses the identity's own naming rule,
 * which is what keeps a manifest that lists another identity's file names (a
 * stale sequence or short revision) from being published.
 * @param identity - the build being published.
 * @param manifest - the release manifest that describes it.
 * @param platform - the platform whose artifacts are checked.
 * @param files - the present files' digests and sizes, keyed by file name.
 * @returns every disagreement; an empty report means the build matches.
 */
export function auditReleaseArtifacts(
  identity: ReleaseIdentity,
  manifest: ReleaseManifest,
  platform: ReleasePlatform,
  files: ReadonlyMap<string, LocalArtifactFile>,
): ReleaseArtifactReport {
  const declared = manifest.platforms[platform].artifacts
  const expected = expectedArtifacts(identity, platform === 'darwin' ? { mac: true, win: false } : { mac: false, win: true })
  const declaredNames = new Set(declared.map(artifact => artifact.fileName))
  const present = declared.filter(artifact => files.has(artifact.fileName))
  const mismatched = verifyArtifactDigests(
    new Map(present.map(artifact => [artifact.fileName, artifact.sha512])),
    new Map(present.flatMap((artifact) => {
      const file = files.get(artifact.fileName)
      return file === undefined ? [] : [[artifact.fileName, file.sha512] as const]
    })),
  )
  const sizeMismatches = present.flatMap((artifact) => {
    const file = files.get(artifact.fileName)
    if (file === undefined || file.size === artifact.size) return []
    return [{ fileName: artifact.fileName, expected: artifact.size, actual: file.size }]
  })
  return {
    missing: declared.filter(artifact => !files.has(artifact.fileName)).map(artifact => artifact.fileName),
    mismatched,
    sizeMismatches,
    undeclaredExpected: expected.filter(name => !declaredNames.has(name)),
    unexpected: declared.filter(artifact => !expected.includes(artifact.fileName)).map(artifact => artifact.fileName),
  }
}

/**
 * Whether an artifact report found nothing to refuse.
 * @param report - the report [[auditReleaseArtifacts]] produced.
 * @returns true when the build matches the release manifest.
 */
export function isCleanArtifactReport(report: ReleaseArtifactReport): boolean {
  return report.missing.length === 0
    && report.mismatched.length === 0
    && report.sizeMismatches.length === 0
    && report.undeclaredExpected.length === 0
    && report.unexpected.length === 0
}

/**
 * Compare this build's bytes with the ones the feed already serves under the
 * same file names.
 *
 * A name the live manifest already serves is immutable: it must carry exactly
 * the bytes that manifest records. This is what refuses a second bridge build
 * under a version already published even after its files were pruned from the
 * server — the manifest is the record of what old clients may have downloaded,
 * and a missing file does not make a different build safe to publish under the
 * same name.
 * @param live - the channel's live feed, when it has one.
 * @param artifacts - every artifact the release manifest declares for the platform.
 * @returns one line per shared name whose recorded bytes differ.
 */
export function servedBytesMismatches(
  live: LiveFeed | undefined,
  artifacts: readonly ReleaseManifestArtifact[],
): readonly string[] {
  if (live === undefined) return []
  const declared = new Map(artifacts.map(artifact => [artifact.fileName, artifact]))
  const mismatches: string[] = []
  for (const file of live.files) {
    const artifact = declared.get(file.url)
    if (artifact === undefined) continue
    if (artifact.sha512 !== file.sha512 || artifact.size !== file.size) {
      mismatches.push(
        `${file.url}: the feed records sha512 ${file.sha512.slice(0, 12)}… (${String(file.size)} bytes), `
        + `this build carries sha512 ${artifact.sha512.slice(0, 12)}… (${String(artifact.size)} bytes)`,
      )
    }
  }
  return mismatches
}

/** The feed manifest this publish writes. */
export interface FeedManifest {
  /** The protocol tree it belongs to. */
  readonly protocol: FeedProtocol
  /** The build it serves. */
  readonly identity: ReleaseIdentity
  /** Every `files[]` entry, normalized to the published name. */
  readonly files: readonly FeedFile[]
  /** The whole document, ready for [[dump]]. */
  readonly document: Readonly<Record<string, unknown>>
  /** The v2 red line it sets, if any. */
  readonly minimumBuildSequence?: number
  /** The v1 red line it sets, if any. */
  readonly minimumVersion?: string
}

/** One channel's feed-manifest inputs. */
export interface FeedManifestInput {
  /** The protocol tree being written, which decides which fields are legal. */
  readonly protocol: FeedProtocol
  /** The build being published. */
  readonly identity: ReleaseIdentity
  /** The builder's own manifest, as read from `dist-app`. */
  readonly source: unknown
  /** Every artifact the release manifest declares for this platform. */
  readonly artifacts: readonly ReleaseManifestArtifact[]
  /** The release notes to carry. */
  readonly releaseNotes: string
  /** The v2 red line to write. */
  readonly minimumBuildSequence?: number
  /** The v1 red line to write. */
  readonly minimumVersion?: string
}

/**
 * Build the manifest this publish serves from the builder's own manifest.
 *
 * The builder wrote the standard electron-updater fields — `files[]`, `path`,
 * `sha512`, `releaseDate` — for the bytes it just produced. This function keeps
 * those, checks each `files[]` entry against the release manifest's recorded
 * digest and size, and adds only the fields this product owns: the v2
 * `dshRelease` and red line, or the v1 `minimumVersion`. The v1 document is
 * stripped of the v2-only fields on purpose: an old client ignores them, and a
 * later reader would take a `dshRelease` there for this build's identity.
 * @param input - the protocol, build, builder manifest, release artifacts, and red lines.
 * @returns the document to publish and the normalized entries to verify.
 * @throws [[PublishError]] when the builder manifest disagrees with the
 * release manifest, the protocol, or the build identity.
 */
export function buildFeedManifest(input: FeedManifestInput): FeedManifest {
  if (input.protocol !== feedProtocolFor(input.identity)) {
    throw refuse('feed protocol', `a ${input.identity.dshRelease.kind} build publishes to ${feedProtocolFor(input.identity)}, not ${input.protocol}`)
  }
  if (!isMapping(input.source)) {
    throw refuse('the build\'s update manifest', 'is not a YAML mapping — rebuild it with package.ts')
  }
  const source = { ...input.source }
  if (source.version !== input.identity.version) {
    throw refuse(
      'update manifest version',
      `is ${describe(source.version)} but the release manifest says ${input.identity.version} — the build in dist-app is not this release`,
    )
  }
  const targetNames = new Set(expectedArtifacts(input.identity, { mac: true, win: true }))
  for (const artifact of input.artifacts) {
    if (!targetNames.has(artifact.fileName)) throw refuse(artifact.fileName, 'does not belong to the target build identity')
  }
  const declared = new Map(input.artifacts.map(artifact => [artifact.fileName, artifact]))
  const filesValue = source.files
  if (!Array.isArray(filesValue) || filesValue.length === 0) {
    throw refuse('update manifest files[]', `must be a non-empty array, got ${describe(filesValue)}`)
  }
  const files: FeedFile[] = []
  const entries: Record<string, unknown>[] = []
  const seen = new Set<string>()
  filesValue.forEach((entry, index) => {
    const subject = `update manifest files[${String(index)}]`
    if (!isMapping(entry)) throw refuse(subject, `must be a mapping, got ${describe(entry)}`)
    const fileName = feedFileNameOrRefuse(entry.url, subject)
    if (fileName.endsWith(BLOCKMAP_SUFFIX)) {
      throw refuse(subject, `names ${fileName}; a blockmap is derived by the client from the artifact's name and is not listed in files[]`)
    }
    if (seen.has(fileName)) throw refuse(subject, `lists ${fileName} again, so one feed entry would name two files`)
    const artifact = declared.get(fileName)
    if (artifact === undefined) {
      throw refuse(subject, `names ${fileName}, which the release manifest does not declare for this platform`)
    }
    if (entry.sha512 !== artifact.sha512) {
      throw refuse(
        `${subject}.sha512`,
        `is ${describe(entry.sha512)} but the release manifest records ${artifact.sha512} for ${fileName} — rebuild instead of publishing bytes nobody recorded`,
      )
    }
    if (entry.size !== artifact.size) {
      throw refuse(
        `${subject}.size`,
        `is ${describe(entry.size)} but the release manifest records ${String(artifact.size)} for ${fileName}`,
      )
    }
    seen.add(fileName)
    const isAdminRightsRequired = entry.isAdminRightsRequired === true
    files.push({
      url: fileName,
      sha512: artifact.sha512,
      size: artifact.size,
      ...isAdminRightsRequired ? { isAdminRightsRequired: true } : {},
    })
    entries.push({ ...entry, url: fileName, sha512: artifact.sha512, size: artifact.size })
  })
  const expectedFiles = input.artifacts.filter(artifact => !artifact.fileName.endsWith(BLOCKMAP_SUFFIX))
  if (expectedFiles.length !== files.length || expectedFiles.some(artifact => !seen.has(artifact.fileName))) {
    throw refuse('update manifest files[]', 'must name every target artifact exactly once')
  }
  const document: Record<string, unknown> = { ...source }
  document.version = input.identity.version
  document.files = entries
  const pathValue = source.path
  if (pathValue !== undefined) {
    const path = feedFileNameOrRefuse(pathValue, 'update manifest path')
    const primary = files.find(file => file.url === path)
    if (primary === undefined) {
      throw refuse('update manifest path', `names ${path}, which is not among the files[] entries this release publishes`)
    }
    if (source.sha512 !== undefined && source.sha512 !== primary.sha512) {
      throw refuse('update manifest sha512', `does not match the digest of the primary artifact ${path}`)
    }
    document.path = path
    document.sha512 = primary.sha512
  }
  document.releaseNotes = input.releaseNotes
  if (input.protocol === 'v2') {
    document.dshRelease = { ...input.identity.dshRelease }
    delete document.minimumVersion
    if (input.minimumBuildSequence === undefined) delete document.minimumBuildSequence
    else document.minimumBuildSequence = input.minimumBuildSequence
  } else {
    delete document.dshRelease
    delete document.minimumBuildSequence
    if (input.minimumVersion === undefined) delete document.minimumVersion
    else document.minimumVersion = input.minimumVersion
  }
  return {
    protocol: input.protocol,
    identity: input.identity,
    files,
    document,
    ...input.minimumBuildSequence === undefined ? {} : { minimumBuildSequence: input.minimumBuildSequence },
    ...input.minimumVersion === undefined ? {} : { minimumVersion: input.minimumVersion },
  }
}

/**
 * Read one feed file name from a builder manifest field.
 * @param value - the field's value.
 * @param subject - the field path used in the refusal.
 * @returns the validated bare file name.
 * @throws [[PublishError]] when the value names no usable feed file.
 */
function feedFileNameOrRefuse(value: unknown, subject: string): string {
  try {
    return feedFileName(value)
  } catch (error) {
    throw refuse(subject, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Compare a served manifest with the one this publish wrote.
 *
 * The comparison covers what a client actually consumes: the version, every
 * `files[]` entry's `url`/`sha512`/`size`, the v2 `dshRelease` object, and the
 * red line each protocol uses. Comparing only the version would pass a feed
 * that points at other bytes, which is the failure this check exists for.
 * @param expected - the manifest this publish wrote.
 * @param actual - the document parsed from the served URL.
 * @returns one line per disagreement; an empty list means the feed serves it.
 */
export function verifyFeedReadback(expected: FeedManifest, actual: unknown): readonly string[] {
  if (!isMapping(actual)) return ['the served manifest is not a YAML mapping']
  const mismatches: string[] = []
  if (actual.version !== expected.identity.version) {
    mismatches.push(`version is ${describe(actual.version)}, expected ${expected.identity.version}`)
  }
  const servedFiles = actual.files
  if (!Array.isArray(servedFiles)) {
    mismatches.push(`files[] is missing, expected ${String(expected.files.length)} entries`)
  } else {
    if (servedFiles.length !== expected.files.length) {
      mismatches.push(`files[] lists ${String(servedFiles.length)} entries, expected ${String(expected.files.length)}`)
    }
    for (const file of expected.files) {
      const found = servedFiles.filter(isMapping).find(entry => entry.url === file.url)
      if (found === undefined) {
        mismatches.push(`files[] no longer lists ${file.url}`)
        continue
      }
      if (found.sha512 !== file.sha512) {
        mismatches.push(`${file.url} sha512 is ${describe(found.sha512)}, expected ${file.sha512}`)
      }
      if (found.size !== file.size) {
        mismatches.push(`${file.url} size is ${describe(found.size)}, expected ${String(file.size)}`)
      }
    }
    const expectedNames = new Set(expected.files.map(file => file.url))
    for (const entry of servedFiles.filter(isMapping)) {
      if (typeof entry.url === 'string' && !expectedNames.has(entry.url)) {
        mismatches.push(`files[] lists ${entry.url}, which this publish did not write`)
      }
    }
  }
  if (expected.protocol === 'v2') {
    try {
      const served = parseDesktopReleaseMetadata(actual.dshRelease)
      const wanted = expected.identity.dshRelease
      const keys = ['schemaVersion', 'runtimeVersion', 'buildSequence', 'revision', 'kind'] as const
      const differences = keys.filter(key => served[key] !== wanted[key])
      if (differences.length > 0) {
        mismatches.push(
          `dshRelease differs in ${differences.join(', ')}: the feed carries ${describeIdentity({ version: expected.identity.version, dshRelease: served })}`,
        )
      }
    } catch (error) {
      mismatches.push(`dshRelease is not a usable identity: ${error instanceof Error ? error.message : String(error)}`)
    }
    const servedMinimum = actual.minimumBuildSequence
    if (expected.minimumBuildSequence === undefined) {
      if (servedMinimum !== undefined) mismatches.push(`minimumBuildSequence is ${describe(servedMinimum)}, but this publish sets none`)
    } else if (servedMinimum !== expected.minimumBuildSequence) {
      mismatches.push(`minimumBuildSequence is ${describe(servedMinimum)}, expected ${String(expected.minimumBuildSequence)}`)
    }
    if (actual.minimumVersion !== undefined) {
      mismatches.push('a v2 manifest must not carry the v1 minimumVersion field')
    }
  } else {
    if (actual.dshRelease !== undefined) {
      mismatches.push('a v1 manifest must not carry dshRelease: old clients do not read it, and a reader would take it for this build\'s identity')
    }
    if (actual.minimumBuildSequence !== undefined) {
      mismatches.push('a v1 manifest must not carry minimumBuildSequence: the old feed orders and forces by version only')
    }
    const servedMinimum = actual.minimumVersion
    if (expected.minimumVersion === undefined) {
      if (servedMinimum !== undefined) mismatches.push(`minimumVersion is ${describe(servedMinimum)}, but this publish sets none`)
    } else if (servedMinimum !== expected.minimumVersion) {
      mismatches.push(`minimumVersion is ${describe(servedMinimum)}, expected ${expected.minimumVersion}`)
    }
  }
  return mismatches
}

/**
 * The name prefix of one artifact, covering every artifact of its build.
 *
 * A manifest lists the artifacts a platform installs, not the blockmap a
 * differential download derives from each of them. Protecting the build by
 * prefix is what keeps that derived name, and any artifact of the build the
 * manifest happens not to list, inside the retention set the prune may not
 * touch.
 * @param fileName - one artifact name, with or without `.blockmap`.
 * @returns the prefix through the build identity token, or undefined when the
 * name is not one this product's packaging produces.
 */
function artifactBuildPrefix(fileName: string): string | undefined {
  const artifact = fileName.endsWith(BLOCKMAP_SUFFIX)
    ? fileName.slice(0, fileName.length - BLOCKMAP_SUFFIX.length)
    : fileName
  const parsed = parseArtifactName(artifact)
  if (parsed === undefined) return undefined
  if (parsed.buildSequence !== undefined && parsed.shortRevision !== undefined) {
    const token = `-b${String(parsed.buildSequence)}-${parsed.shortRevision}`
    const at = artifact.indexOf(token)
    return at < 0 ? undefined : artifact.slice(0, at + token.length)
  }
  const at = artifact.indexOf(parsed.version)
  return at < 0 ? undefined : artifact.slice(0, at + parsed.version.length)
}

/** One channel's prune-protection inputs. */
export interface PruneProtectionInputs {
  /** The platform channel being pruned. */
  readonly channel: FeedChannel
  /** The `files[]` entries of the manifest just published. */
  readonly targetFiles: readonly FeedFile[]
  /** Every artifact name this publish uploaded for the platform. */
  readonly targetArtifacts: readonly string[]
  /** The v1 bridge manifest, when the directory holds one. */
  readonly bridge: LiveFeed | undefined
  /** The v2 manifest this publish replaces, when the directory holds one. */
  readonly served: LiveFeed | undefined
  /**
   * The protocol directory this protection set belongs to.
   *
   * A set spans one directory: the bridge's files live under `/mac` and `/win`,
   * the v2 manifest's under `/v2/`. Passing both to one plan would report the
   * other protocol's names as missing protections on every run, which trains
   * the operator to ignore the warning that is supposed to mean the set and the
   * directory disagree. Omitted, both feeds are protected.
   */
  readonly directory?: FeedProtocol
}

/**
 * Build the set a prune must never delete.
 *
 * Nothing is inferred that a caller could not see: the channel's manifest name,
 * every file any served manifest references, the `.blockmap` derived from each
 * of those names, and the prefix of every build being served or just published.
 * The bridge set is passed to the v1 directory and the served set to the v2
 * directory: a name that lives in the other directory would otherwise show up
 * as an absent protection and be warned about, which is exactly the signal that
 * the set and the directory disagree.
 * @param inputs - the channel, the published entries, and the live manifests.
 * @returns the names and prefixes [[planPrune]] must keep.
 */
export function pruneProtectionFor(inputs: PruneProtectionInputs): PruneProtection {
  const names = new Set<string>([inputs.channel.manifest])
  const prefixes = new Set<string>()
  const addFeed = (feed: LiveFeed | undefined): void => {
    if (feed === undefined) return
    for (const file of feed.files) {
      names.add(file.url)
      names.add(`${file.url}${BLOCKMAP_SUFFIX}`)
      const prefix = artifactBuildPrefix(file.url)
      if (prefix !== undefined) prefixes.add(prefix)
    }
  }
  if (inputs.directory !== 'v2') addFeed(inputs.bridge)
  if (inputs.directory !== 'v1') addFeed(inputs.served)
  for (const file of inputs.targetFiles) {
    names.add(file.url)
    names.add(`${file.url}${BLOCKMAP_SUFFIX}`)
  }
  for (const name of inputs.targetArtifacts) {
    const prefix = artifactBuildPrefix(name)
    if (prefix !== undefined) prefixes.add(prefix)
  }
  return { names: [...names], prefixes: [...prefixes] }
}

/**
 * A stable description of a channel's feed for the check before replacement.
 *
 * The bytes are the comparison, not a parsed subset: a concurrent publish that
 * changed only the release notes still changed the manifest this run checked
 * against, and the pointer must not move on top of it without a re-plan.
 * @param read - what reading the channel's own manifest found.
 * @returns a key two readings can be compared by.
 */
export function liveFingerprint(read: LiveRead): string {
  switch (read.kind) {
    case 'absent':
      return 'absent'
    case 'unreadable':
      return `unreadable\u0000${read.reason}`
    case 'damaged':
      return `damaged\u0000${read.reason}`
    case 'present':
      return `present\u0000${read.feed.text}`
  }
}

/**
 * Describe a build in one line, for a log or a refusal.
 * @param identity - the build.
 * @returns the version, build sequence, kind, runtime, and short revision.
 */
function describeIdentity(identity: ReleaseIdentity): string {
  const { dshRelease } = identity
  return `${identity.version} build ${String(dshRelease.buildSequence)} (${dshRelease.kind}, runtime ${dshRelease.runtimeVersion}, revision ${dshRelease.revision.slice(0, 12)})`
}

/**
 * Describe what one live reading found, in one line.
 * @param read - the reading.
 * @returns a short description including the build or the failure.
 */
function describeLiveRead(read: LiveRead): string {
  switch (read.kind) {
    case 'absent': return 'nothing (first publish)'
    case 'unreadable': return `unreadable (${read.reason})`
    case 'damaged': return `damaged (${read.reason})`
    case 'present': {
      const feed = read.feed
      const build = feed.identity === undefined ? '' : `, build ${String(feed.identity.dshRelease.buildSequence)}`
      const minimum = feed.minimumBuildSequence === undefined
        ? feed.minimumVersion === undefined ? '' : `, minimumVersion ${feed.minimumVersion}`
        : `, minimumBuildSequence ${String(feed.minimumBuildSequence)}`
      return `${feed.version}${build}${minimum}`
    }
  }
}

/** One channel's fully planned publish. */
interface ChannelWork {
  /** The platform channel. */
  readonly channel: FeedChannel
  /** The destination directory. */
  readonly location: ChannelLocation
  /** What the destination's own manifest held before this publish. */
  readonly liveRead: LiveRead
  /** What the v1 bridge directory holds, for the prune protection set. */
  readonly bridgeRead: LiveRead
  /** The preflight decision for this channel. */
  readonly plan: ChannelPublishPlan
  /** Every artifact the release manifest declares for this platform. */
  readonly artifacts: readonly ReleaseManifestArtifact[]
  /** The manifest this publish writes. */
  readonly manifest: FeedManifest
}

/** The command line one publish was asked to carry out. */
interface Cli {
  /** The release manifest naming the build being published. */
  readonly releaseManifest: string
  /** The release-notes file, which becomes the tag message. */
  readonly notes: string
  /** The channels this publish touches, in FEED_CHANNELS order. */
  readonly channels: readonly FeedChannel[]
  /** The protocol the operator named, for the mismatch refusal. */
  readonly feedProtocol: string | undefined
  /** The v1 red line, for a bridge publish. */
  readonly minimumVersion: string | undefined
  /** The v2 red line, in build-sequence terms. */
  readonly minimumBuildSequence: number | undefined
  /** Whether an already-served build may be finished idempotently. */
  readonly republish: boolean
  /** How much pruning this run does. */
  readonly prune: 'report' | 'apply' | 'skip'
  /** Whether the shipped commit is tagged once the feed serves it. */
  readonly tag: boolean
  readonly dryRun: boolean
}

/**
 * Read the command line.
 * @param argv - the arguments after the script name.
 * @returns the parsed request.
 * @throws [[PublishError]] when a required input is missing or contradictory.
 */
function parseCli(argv: string[]): Cli {
  const { values } = parseArgs({
    args: argv,
    options: {
      'release-manifest': { type: 'string' },
      'notes': { type: 'string' },
      'channel': { type: 'string', default: 'all' },
      'feed-protocol': { type: 'string' },
      'minimum-version': { type: 'string' },
      'minimum-build-sequence': { type: 'string' },
      'republish': { type: 'boolean', default: false },
      'prune': { type: 'boolean', default: false },
      'no-prune': { type: 'boolean', default: false },
      'no-tag': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (values['release-manifest'] === undefined) {
    throw refuse(
      '--release-manifest',
      'is required; the version and build identity come from that file, never from the source package',
    )
  }
  if (values.notes === undefined) {
    throw refuse('--notes', 'is required; it carries the release notes shown in the update dialog and the tag message')
  }
  if (values.prune && values['no-prune']) {
    throw refuse('--prune', 'and --no-prune contradict each other')
  }
  const selected = values.channel ?? 'all'
  const channels = selected === 'all' ? FEED_CHANNELS : FEED_CHANNELS.filter(channel => channel.name === selected)
  if (channels.length === 0) {
    throw refuse('--channel', `names no channel; use mac, win, or all (got ${describe(selected)})`)
  }
  let minimumBuildSequence: number | undefined
  const sequenceValue = values['minimum-build-sequence']
  if (sequenceValue !== undefined) {
    if (!/^[1-9]\d*$/u.test(sequenceValue)) {
      throw refuse('--minimum-build-sequence', `must be a positive integer, got ${describe(sequenceValue)}`)
    }
    const parsed = Number.parseInt(sequenceValue, 10)
    if (!Number.isSafeInteger(parsed)) {
      throw refuse('--minimum-build-sequence', `must be a safe integer, got ${describe(sequenceValue)}`)
    }
    minimumBuildSequence = parsed
  }
  return {
    releaseManifest: values['release-manifest'],
    notes: values.notes,
    channels,
    feedProtocol: values['feed-protocol'],
    minimumVersion: values['minimum-version'],
    minimumBuildSequence,
    republish: values.republish,
    prune: values['no-prune'] ? 'skip' : values.prune ? 'apply' : 'report',
    tag: !values['no-tag'],
    dryRun: values['dry-run'],
  }
}

/**
 * Run one command and capture stdout; a non-zero exit throws with stderr.
 * @param command - the executable to run.
 * @param args - its arguments, passed without a shell.
 * @returns the captured stdout.
 */
async function capture(command: string, args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.once('error', (error) => { reject(new Error(`publish: ${command} failed to spawn: ${error.message}`)) })
    child.once('close', (code) => {
      if (code === 0) resolvePromise(out)
      else reject(new Error(`publish: ${[command, ...args].join(' ')} exited ${String(code)}\n${err.trim()}`))
    })
  })
}

/**
 * The first line of a caught failure, which is what a progress log carries;
 * the rest is a remote command's stderr and belongs to whoever re-runs it.
 * @param error - the caught value.
 * @returns its first message line, or the value stringified.
 */
function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error)
}

/**
 * Read one remote text file, telling absence apart from a read failure.
 * @param remotePath - the absolute path to read.
 * @returns the bytes, or absence.
 * @throws when the read itself failed.
 */
async function readRemoteText(ctx: PublishContext, remotePath: string): Promise<{ readonly kind: 'absent' } | { readonly kind: 'present'; readonly text: string }> {
  const quoted = shellQuote(remotePath)
  const output = await ctx.transaction.read(`if [ -e ${quoted} ]; then printf 'present\\n'; cat ${quoted}; else printf 'absent\\n'; fi`)
  const newline = output.indexOf('\n')
  const status = (newline < 0 ? output : output.slice(0, newline)).trim()
  if (status === 'absent') return { kind: 'absent' }
  if (status === 'present') return { kind: 'present', text: newline < 0 ? '' : output.slice(newline + 1) }
  throw new Error(`publish: unexpected answer ${describe(status)} while reading ${remotePath}`)
}

/**
 * Read one channel's live manifest into the three-way reading the planner uses.
 * @param location - the directory to read.
 * @returns absence, the validated feed, or the reason it could not be used.
 */
async function readLiveFeed(ctx: PublishContext, location: ChannelLocation): Promise<LiveRead> {
  const path = `${location.remoteDir}/${location.channel.manifest}`
  let outcome: { readonly kind: 'absent' } | { readonly kind: 'present'; readonly text: string }
  try {
    outcome = await readRemoteText(ctx, path)
  } catch (error) {
    return { kind: 'unreadable', reason: firstLine(error) }
  }
  if (outcome.kind === 'absent') return { kind: 'absent' }
  try {
    return { kind: 'present', feed: parseLiveFeed(location.protocol, outcome.text) }
  } catch (error) {
    return { kind: 'damaged', reason: firstLine(error) }
  }
}

/** One local file's digest, computed once per publish. */
interface LocalDigest {
  /** The base64 SHA-512 the release manifest uses. */
  readonly base64: string
  /** The same digest in the form `sha512sum` prints. */
  readonly hex: string
  /** The byte length. */
  readonly size: number
}

/**
 * Compute current local bytes; digests are never shared across invocations.
 * @param path - the local file.
 * @returns both digest spellings and the size.
 */
async function digestOf(path: string): Promise<LocalDigest> {
  const hash = createHash('sha512')
  await pipeline(createReadStream(path), hash)
  const hex = hash.digest('hex')
  const stats = await stat(path)
  const value: LocalDigest = {
    base64: Buffer.from(hex, 'hex').toString('base64'),
    hex,
    size: stats.size,
  }
  return value
}

/**
 * Print a digest so two lines can be compared by eye without a wall of hex.
 * @param hex - the lowercase SHA-512.
 * @returns its first sixteen characters.
 */
function shortDigest(hex: string): string {
  return hex.slice(0, 16)
}

/**
 * Stream a file once through the caller's owned, exclusive staging command.
 * @param path - Verified local artifact or attempt manifest.
 * @param script - Guarded remote write command.
 * @returns Resolves after the SSH process and its streams close.
 */
async function sendFile(path: string, script: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('ssh', [...SSH_KEEPALIVE, REMOTE_HOST, script], {
      stdio: ['pipe', 'ignore', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
    child.once('error', (error) => { reject(new Error(`publish: ssh append failed to spawn: ${error.message}`)) })
    child.once('close', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`publish: ssh append exited ${String(code)}\n${err.trim()}`))
    })
    const source = createReadStream(path)
    source.once('error', (error) => {
      child.kill()
      reject(error)
    })
    // A failed remote stream emits EPIPE here; preserve it as an uncertain
    // transfer outcome instead of letting an unhandled socket error exit.
    child.stdin.once('error', (error: Error) => {
      source.destroy()
      child.kill()
      reject(new Error(`publish: ssh append interrupted: ${error.message}`))
    })
    source.pipe(child.stdin)
  })
}

/** Transfer to an attempt-owned path and verify the complete bytes. */
async function transferTo(ctx: PublishContext, localPath: string, remotePath: string, label: string): Promise<void> {
  const local = await digestOf(localPath)
  await ctx.transaction.upload(remotePath, script => ctx.options.sendFile(localPath, script))
  const uploaded = await ctx.transaction.fileState(remotePath)
  if (uploaded.kind !== 'present' || uploaded.sha512 !== local.hex || uploaded.size !== local.size) {
    throw refuse(label, 'uploaded bytes differ; preserve the staging file and publish a fresh attempt after inspecting the cause')
  }
  console.log(`publish: verified ${label} sha512 ${shortDigest(local.hex)}`)
}

/** Create one destination while the publication lock is held. */
async function ensureRemoteDirectory(ctx: PublishContext, location: ChannelLocation): Promise<void> {
  await ctx.transaction.ensureDirectory(location.remoteDir)
}

/**
 * Publish one artifact to its immutable name.
 *
 * A name the feed already holds is compared, never replaced: equal bytes mean
 * the upload is idempotent and skipped, different bytes mean two builds would
 * share one name, which the protocol does not allow. The transfer itself goes
 * to a sibling `.part` and only becomes the published file after the server's
 * digest matches.
 * @param path - the local artifact.
 * @param location - the destination directory.
 * @param declared - the release manifest's record of these bytes.
 * @throws [[PublishError]] when the existing bytes differ from this build's.
 */
async function publishArtifact(
  ctx: PublishContext, path: string, location: ChannelLocation, declared: ReleaseManifestArtifact,
): Promise<void> {
  const name = basename(path)
  const finalPath = `${location.remoteDir}/${name}`
  const stagedPath = ctx.transaction.stagedPath(finalPath)
  const local = await digestOf(path)
  if (local.base64 !== declared.sha512) {
    throw refuse(name, 'does not carry the release manifest\'s digest, so nothing was uploaded')
  }
  const existing = await ctx.transaction.fileState(finalPath)
  if (existing.kind === 'present') {
    if (existing.sha512 !== local.hex || existing.size !== local.size) {
      throw refuse(
        `${location.relative}/${name}`,
        `already holds different bytes (sha512 ${shortDigest(existing.sha512)}, ${String(existing.size)} bytes) than this build `
        + `(sha512 ${shortDigest(local.hex)}, ${String(local.size)} bytes). The feed is immutable: one file name always means one content, `
        + 'so publish a new build — a larger build sequence, or a higher bridge app version — instead of overwriting; '
        + '--republish only re-uploads identical bytes',
      )
    }
    console.log(`publish: ${location.relative}/${name} already holds these bytes; upload skipped`)
    return
  }
  await transferTo(ctx, path, stagedPath, `${location.relative}/${name}`)
  await ctx.transaction.commitImmutable(stagedPath, finalPath, { sha512: local.hex, size: local.size })
  console.log(`publish: published ${location.relative}/${name} sha512 ${shortDigest(local.hex)}`)
}

/**
 * Stage one injected manifest under a temporary name and verify it there.
 *
 * The pointer does not move in this step. Everything this run uploads is
 * staged before any platform's manifest is switched, so a client polling
 * during the upload sees the previous manifest naming files that are all still
 * present, never a manifest naming a file still in flight.
 * @param item - the channel whose manifest is staged.
 * @returns the local path written, for the entry listing.
 */
async function stageManifest(ctx: PublishContext, item: ChannelWork): Promise<string> {
  const finalPath = `${item.location.remoteDir}/${item.channel.manifest}`
  const stagedPath = ctx.transaction.stagedPath(finalPath)
  const localDirectory = join(ctx.dist, `.publish-${ctx.transaction.attempt}`)
  await mkdir(localDirectory, { recursive: true })
  const localPath = join(localDirectory, item.channel.manifest)
  const text = dump(item.manifest.document, { schema: DEFAULT_SCHEMA, lineWidth: -1, noRefs: true })
  await writeFile(localPath, text)
  await transferTo(ctx, localPath, stagedPath, `${item.location.relative}/${item.channel.manifest}.tmp`)
  return localPath
}

/**
 * Re-read one channel's live manifest and switch its pointer only if the feed
 * still holds what the preflight checked.
 *
 * The global publication lock remains held. This reread also detects writers
 * outside the publisher; changed state is retained for manual reconciliation.
 * @param item - the channel whose manifest moves.
 * @throws [[PublishError]] when the live feed changed since preflight.
 */
async function commitManifest(ctx: PublishContext, item: ChannelWork): Promise<void> {
  const finalPath = `${item.location.remoteDir}/${item.channel.manifest}`
  const stagedPath = ctx.transaction.stagedPath(finalPath)
  const current = await readLiveFeed(ctx, item.location)
  if (liveFingerprint(current) !== liveFingerprint(item.liveRead)) {
    throw refuse(
      `the ${item.location.relative} feed`,
      `changed while this publish was staging its files (preflight ${describeLiveRead(item.liveRead)}, now ${describeLiveRead(current)}), `
      + 'so the pointer was not switched; an external writer bypassed the publication lock',
    )
  }
  const text = dump(item.manifest.document, { schema: DEFAULT_SCHEMA, lineWidth: -1, noRefs: true })
  await ctx.transaction.commitPointer(stagedPath, finalPath, { sha512: createHash('sha512').update(text).digest('hex'), size: Buffer.byteLength(text) })
  console.log(`publish: ${item.location.relative}/${item.channel.manifest} now points at ${describeIdentity(item.manifest.identity)}`)
}

/**
 * List one remote feed directory.
 * @param location - the directory to list.
 * @returns its entry names.
 * @throws when the server cannot list it.
 */
async function remoteDirectoryNames(ctx: PublishContext, location: ChannelLocation): Promise<string[]> {
  const output = await ctx.transaction.read(`ls -1 ${shellQuote(location.remoteDir)}`)
  return output.split('\n').map(line => line.trim()).filter(line => line !== '')
}

/**
 * Print and optionally carry out one directory's prune plan.
 *
 * The plan is printed in full before anything is deleted, and a name is only
 * deleted when [[planPrune]] listed it. A protection the directory does not
 * hold is warned about: the set and the directory then disagree, and the
 * operator needs to see that before trusting either.
 * @param location - the directory being pruned.
 * @param protection - what must survive.
 * @param publishedNames - what this publish uploaded or rewrote there.
 * @param operation - whether the caller may delete.
 * @param note - a policy line to print with the plan, when the caller has one.
 */
async function pruneDirectory(ctx: PublishContext,
  location: ChannelLocation,
  protection: PruneProtection,
  publishedNames: readonly string[],
  operation: 'report' | 'apply',
  note: string | undefined,
): Promise<void> {
  let names: string[]
  try {
    names = await remoteDirectoryNames(ctx, location)
  } catch (error) {
    console.log(`publish: WARNING — could not list ${location.remoteDir}, so nothing is pruned there: ${firstLine(error)}`)
    return
  }
  const decision: PruneDecision = planPrune({
    protocol: location.protocol,
    names,
    publishedNames,
    protection,
    operation,
  })
  if (note !== undefined) console.log(`publish: ${location.relative}: ${note}`)
  console.log(
    `publish: ${location.relative}: keeps ${String(decision.keep.length)} of ${String(names.length)} entries, `
    + `leaves ${String(decision.unparsed.length)} unrecognized, `
    + `would delete ${String(decision.deleteArtifacts.length)} artifact(s) and ${String(decision.deleteBlockmaps.length)} blockmap(s)`,
  )
  if (decision.unparsed.length > 0) {
    console.log(`publish: ${location.relative}: leaving unrecognized names alone: ${decision.unparsed.join(', ')}`)
  }
  for (const name of decision.absentProtections) {
    console.log(`publish: WARNING — ${location.relative}: protected file ${JSON.stringify(name)} is not in this directory`)
  }
  const targets = [...decision.deleteArtifacts, ...decision.deleteBlockmaps]
  if (targets.length > 0) {
    console.log(`publish: ${location.relative}: ${decision.kind === 'report' ? 'would delete' : 'deleting'}: ${targets.join(', ')}`)
  }
  if (decision.kind === 'report') {
    console.log(`publish: ${location.relative}: nothing was deleted — ${decision.reason}`)
    return
  }
  if (targets.length === 0) return
  const offender = targets.find(name => name === '.' || name === '..' || name.includes('/') || name.includes('\\'))
  if (offender !== undefined) {
    throw new Error(`publish: ${JSON.stringify(offender)} names a path rather than a directory entry; nothing was deleted in ${location.relative}`)
  }
  const paths = targets.map(name => `${location.remoteDir}/${name}`)
  await ctx.transaction.backup(paths, ctx.recoveryTags)
  await ctx.transaction.prune(paths)
  console.log(`publish: ${location.relative}: deleted ${String(targets.length)} file(s)`)
}

/** What one publish uploaded or rewrote in one directory. */
function publishedNamesIn(item: ChannelWork, location: ChannelLocation): string[] {
  if (location.protocol !== item.location.protocol) return []
  return [
    item.channel.manifest,
    ...item.artifacts.map(artifact => artifact.fileName),
    ...item.manifest.files.flatMap(file => [file.url, `${file.url}${BLOCKMAP_SUFFIX}`]),
  ]
}

/**
 * Prune the directories this publish wrote, one independently of the other.
 *
 * The manifests are already served by the time this runs, so a prune that
 * fails has nothing to undo: it is reported and the publish stands, and the
 * next run tries again with one more build of backlog. The v1 bridge directory
 * stays report-only in this first round: its protection set is proved by the
 * plan, not yet by a real old client.
 * @param work - every channel this publish planned.
 * @param cli - how much pruning the run was asked to do.
 */
async function pruneFeed(ctx: PublishContext, work: readonly ChannelWork[], cli: Cli): Promise<void> {
  if (cli.prune === 'skip') {
    console.log('publish: --no-prune — the feed keeps every file it already holds.')
    return
  }
  for (const item of work) {
    if (item.bridgeRead.kind === 'unreadable' || item.bridgeRead.kind === 'damaged') {
      console.log(`publish: WARNING — ${item.channel.name}: the v1 bridge feed could not be read (${item.bridgeRead.reason}), so the protection set is incomplete and nothing may be deleted`)
      continue
    }
    const protectionInputs = {
      channel: item.channel,
      targetFiles: item.manifest.files,
      targetArtifacts: item.artifacts.map(artifact => artifact.fileName),
      bridge: item.bridgeRead.kind === 'present' ? item.bridgeRead.feed : undefined,
      served: item.location.protocol === 'v2' && item.liveRead.kind === 'present' ? item.liveRead.feed : undefined,
    } as const
    const applyV2 = cli.prune === 'apply' && !cli.dryRun && item.location.protocol === 'v2'
    try {
      await pruneDirectory(ctx,
        locationFor(ctx, 'v2', item.channel),
        pruneProtectionFor({ ...protectionInputs, directory: 'v2' }),
        publishedNamesIn(item, locationFor(ctx, 'v2', item.channel)),
        applyV2 ? 'apply' : 'report',
        undefined,
      )
      await pruneDirectory(ctx,
        locationFor(ctx, 'v1', item.channel),
        pruneProtectionFor({ ...protectionInputs, directory: 'v1' }),
        publishedNamesIn(item, locationFor(ctx, 'v1', item.channel)),
        'report',
        'the v1 bridge directory is report-only until a real old client has proven what it still fetches',
      )
    } catch (error) {
      throw error
    }
  }
}

/**
 * Run the prune step without letting it fail a publish that is already live.
 *
 * The manifests are served by the time this runs, so there is nothing a prune
 * failure could undo; reporting it is the whole response, and the next publish
 * tries again with one more build of backlog.
 * @param work - every channel this publish planned.
 * @param cli - how much pruning the run was asked to do.
 */
async function runPrune(ctx: PublishContext, work: readonly ChannelWork[], cli: Cli): Promise<void> {
  await pruneFeed(ctx, work, cli)
}

/**
 * Fetch one feed URL and parse it.
 *
 * The request defeats a cached answer: a query the server ignores plus
 * `no-store`/`no-cache` headers mean a 200 returns the file currently on disk,
 * so a stale intermediary cannot pass itself off as the readback this publish
 * needs.
 * @param url - the URL a client fetches.
 * @returns the parsed document.
 * @throws when the request fails or the response does not parse.
 */
async function fetchServedManifest(ctx: PublishContext, url: string): Promise<unknown> {
  const separator = url.includes('?') ? '&' : '?'
  const target = `${url}${separator}readback=${String(Date.now())}-${String(process.pid)}`
  const response = await ctx.options.fetch(target, {
    cache: 'no-store',
    headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`HTTP ${String(response.status)} ${response.statusText}`)
  const text = await response.text()
  try {
    return load(text, { schema: CORE_SCHEMA })
  } catch (error) {
    throw new Error(`the served bytes do not parse: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Run one git command in this repository and return its stdout.
 * @param args - the git arguments, without the executable.
 * @returns the captured stdout.
 */
async function git(ctx: PublishContext, ...args: string[]): Promise<string> {
  return ctx.options.capture('git', ['-C', APP_DIR, ...args])
}

/**
 * The commit a tag names in this repository.
 * @param tag - the tag to resolve.
 * @returns the commit, or undefined when the tag is not here.
 */
async function localTagCommit(ctx: PublishContext, tag: string): Promise<string | undefined> {
  try {
    return (await git(ctx, 'rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`)).trim()
  } catch {
    // `rev-parse --verify` exits non-zero for a ref that is not there, which is
    // the answer this returns rather than a failure. Nothing else runs in the
    // try, so no other error can be swallowed here.
    return undefined
  }
}

/**
 * The commit a tag names on `origin`.
 *
 * The peeled ref is asked for by name: an annotated tag's own object name is
 * not the commit, and `ls-remote` matches `refs/tags/<tag>^{}` only against a
 * pattern that spells it out — a lookup of the plain name alone returns the
 * tag object and reads as a tag pointing somewhere other than HEAD. A
 * lightweight tag has no peeled line and its one line already names the commit.
 * @param tag - the tag to look up.
 * @returns the commit, or undefined when `origin` does not carry the tag.
 */
async function remoteTagCommit(ctx: PublishContext, tag: string): Promise<string | undefined> {
  const lines = (await git(ctx, 'ls-remote', '--tags', 'origin', `refs/tags/${tag}`, `refs/tags/${tag}^{}`))
    .split('\n').map(line => line.trim()).filter(line => line !== '')
  const peeled = lines.find(line => line.endsWith('^{}'))
  return (peeled ?? lines[0])?.split(/\s+/)[0]
}

/**
 * Read everything the tag decision needs from git, unless tagging is off — in
 * which case nothing is read, so a repository that could not be tagged anyway
 * still publishes.
 * @param cli - the parsed command line.
 * @param tag - the tag this release would carry.
 * @returns the repository state, or undefined when tagging is off.
 */
async function readRepositoryState(ctx: PublishContext, cli: Cli, tag: string): Promise<RepositoryState | undefined> {
  if (!cli.tag) return undefined
  const remotes = (await git(ctx, 'remote')).split('\n').map(line => line.trim())
  const hasOrigin = remotes.includes('origin')
  return {
    headSha: (await git(ctx, 'rev-parse', 'HEAD')).trim(),
    localTagSha: await localTagCommit(ctx, tag),
    remoteTagSha: hasOrigin ? await remoteTagCommit(ctx, tag) : undefined,
    // Tracked files only. A release run leaves its own logs in the worktree and
    // an ignored `.env` lives there permanently; neither reaches the build, and
    // refusing on them would refuse every publish. This is the `git describe
    // --dirty` definition.
    dirty: (await git(ctx, 'status', '--porcelain', '--untracked-files=no')).trim() !== '',
    hasOrigin,
  }
}

/**
 * Announce the tagging plan before the first upload, and refuse the publish
 * when the tag could not follow it.
 *
 * Refusing here is the whole point of planning this early: the artifacts are
 * still only local, so a refusal costs a re-run rather than a live release
 * with no tag naming its source.
 * @param plan - what [[planReleaseTag]] decided.
 * @param identity - the build being published.
 */
function announceReleaseTag(plan: ReleaseTagPlan, identity: ReleaseIdentity): void {
  switch (plan.action) {
    case 'refuse':
      throw refuse('the release tag', plan.reason)
    case 'skip':
      console.log(`publish: ${plan.reason}`)
      return
    case 'create':
      console.log(`publish: will tag HEAD ${plan.tag} once the feed serves ${describeIdentity(identity)}`)
      return
    case 'push-existing':
      console.log(`publish: ${plan.tag} already names HEAD here; it will be pushed once the feed serves ${describeIdentity(identity)}`)
      return
    case 'fetch-existing':
      console.log(`publish: origin already carries ${plan.tag} at HEAD; it will be fetched once the feed serves ${describeIdentity(identity)}`)
      return
    case 'already-on-origin':
      console.log(`publish: origin and this repository already carry ${plan.tag} at HEAD; nothing will be created or pushed`)
  }
}

/**
 * What the tag step would do, for the dry-run log.
 * @param plan - what [[planReleaseTag]] decided.
 * @returns the line to print, or undefined when the step does nothing to print.
 */
function dryRunTagLine(plan: ReleaseTagPlan): string | undefined {
  switch (plan.action) {
    case 'create': return `would tag HEAD ${plan.tag} and push it to origin.`
    case 'push-existing': return `${plan.tag} already names HEAD here; would push it to origin.`
    case 'fetch-existing': return `origin already carries ${plan.tag} at HEAD; would fetch it.`
    case 'already-on-origin': return `origin already carries ${plan.tag} at HEAD; would run no git at all.`
    case 'skip': case 'refuse': return undefined
  }
}

/** What the tagging step did, for the closing summary. */
type TagOutcome = 'tagged' | 'skipped' | 'failed'

/**
 * Carry out the tagging plan, after the feed is serving the release: create
 * and push, push what is already here, fetch what `origin` already published,
 * or run no git at all when both sides already name HEAD.
 *
 * Nothing here can undo the publish, so a git failure is reported as exactly
 * what it is — a published release whose tag did not follow — with the command
 * that finishes it by hand. The message says in as many words that the feed is
 * already serving these bytes and must not be rebuilt: a second build would
 * carry different bytes under an immutable name.
 * @param plan - what [[planReleaseTag]] decided before the upload.
 * @param identity - the build now serving.
 * @param notesPath - the release-notes file, which becomes the tag message.
 * @returns what happened, for the closing summary.
 */
async function applyReleaseTag(
  ctx: PublishContext, plan: ReleaseTagPlan, identity: ReleaseIdentity, notesPath: string,
): Promise<TagOutcome> {
  if (plan.action === 'skip' || plan.action === 'refuse') return 'skipped'
  if (plan.action === 'already-on-origin') {
    console.log(`publish: ${plan.tag} already names HEAD on origin and here; nothing to create or push`)
    return 'tagged'
  }
  let created = plan.action === 'push-existing'
  try {
    if (plan.action === 'fetch-existing') {
      // origin published this tag from another clone or worktree. Creating a
      // second annotated object for the same name here would only produce a
      // push origin rejects; copying origin's is what makes the two agree.
      await git(ctx, 'fetch', 'origin', 'tag', plan.tag)
      console.log(`publish: fetched ${plan.tag} from origin, which already names HEAD`)
      return 'tagged'
    }
    if (!created) {
      await git(ctx, 'tag', '-a', plan.tag, '-F', notesPath)
      created = true
      console.log(`publish: tagged ${plan.tag}`)
    }
    await git(ctx, 'push', 'origin', plan.tag)
    console.log(`publish: pushed ${plan.tag} to origin`)
    return 'tagged'
  } catch (error) {
    const fetching = plan.action === 'fetch-existing'
    const manual = fetching
      ? `git fetch origin tag ${plan.tag}`
      : created
        ? `git push origin ${plan.tag}`
        : `git tag -a ${plan.tag} -F ${notesPath} && git push origin ${plan.tag}`
    console.log(`publish: the feed is published — ${describeIdentity(identity)} is serving; only the release tag failed: ${firstLine(error)}`)
    console.log(`publish: finish the tag by hand: ${manual}`)
    console.log('publish: do NOT rebuild or re-upload the artifacts — the feed already serves these bytes, and the file names are immutable.')
    return 'failed'
  }
}

/**
 * State the release's final position in one line, whatever the tag step did.
 * @param plan - what [[planReleaseTag]] decided.
 * @param identity - the build now serving.
 * @param outcome - what [[applyReleaseTag]] did.
 * @param servingOn - the directory labels now serving the build.
 */
function summarize(plan: ReleaseTagPlan, identity: ReleaseIdentity, outcome: TagOutcome, servingOn: readonly string[]): void {
  const tag = releaseTagName(identity)
  const target = describeIdentity(identity)
  const channels = servingOn.join(', ')
  if (outcome === 'tagged') console.log(`publish: ${target} is serving on ${channels}, tagged ${tag}.`)
  else if (plan.action === 'skip') console.log(`publish: ${target} is serving on ${channels}; --no-tag, so no ${tag} tag was created.`)
  else console.log(`publish: ${target} is serving on ${channels}; ${tag} is NOT tagged — see the command above.`)
}

/**
 * Read the release manifest this publish describes.
 * @param cli - the parsed command line.
 * @returns the validated manifest.
 * @throws [[PublishError]] when the file cannot be read or does not parse.
 */
async function readReleaseManifest(cli: Cli): Promise<ReleaseManifest> {
  const path = resolve(cli.releaseManifest)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw refuse('--release-manifest', `cannot read ${path}: ${firstLine(error)}`)
  }
  try {
    return parseReleaseManifest(parsed)
  } catch (error) {
    const code = error instanceof ReleaseManifestError || error instanceof ReleaseIdentityError ? `${error.code}: ` : ''
    throw refuse('--release-manifest', `${code}${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Verify one platform's build in `dist-app` against the release manifest,
 * before anything is uploaded.
 * @param identity - the build being published.
 * @param manifest - the release manifest that describes it.
 * @param channel - the platform channel being published.
 */
async function verifyLocalBuild(
  ctx: PublishContext, identity: ReleaseIdentity, manifest: ReleaseManifest, channel: FeedChannel,
): Promise<void> {
  const declared = manifest.platforms[channel.platform].artifacts
  if (declared.length === 0) {
    throw refuse(
      `platforms.${channel.platform}.artifacts`,
      `is empty, so this release manifest has nothing to publish on the ${channel.name} channel`,
    )
  }
  const files = new Map<string, LocalArtifactFile>()
  for (const artifact of declared) {
    const path = join(ctx.dist, artifact.fileName)
    try {
      ensurePathContainment(ctx.dist, path)
    } catch (error) {
      throw refuse(artifact.fileName, `does not stay inside ${ctx.dist}: ${firstLine(error)}`)
    }
    if (!existsSync(path)) continue
    const digest = await digestOf(path)
    files.set(artifact.fileName, { sha512: digest.base64, size: digest.size })
  }
  const report = auditReleaseArtifacts(identity, manifest, channel.platform, files)
  const problems = [
    ...report.missing.map(name => `${name} is missing from ${ctx.dist}`),
    ...report.mismatched.map(entry => `${entry.fileName} carries sha512 ${entry.actualSha512 ?? 'nothing'} but the release manifest records ${entry.expectedSha512}`),
    ...report.sizeMismatches.map(entry => `${entry.fileName} is ${String(entry.actual)} bytes but the release manifest records ${String(entry.expected)}`),
    ...report.unexpected.map(name => `${name} does not belong to the target build`),
    ...report.undeclaredExpected.map(name => `${name} is a file this identity's naming produces but the release manifest does not list it`),
  ]
  if (!isCleanArtifactReport(report)) {
    throw refuse(`the build in ${ctx.dist} does not match the release manifest`, problems.join('; '))
  }
  await ctx.options.verifyPackage({ distDir: ctx.dist, identity, platform: channel.platform, artifacts: declared })
  console.log(`publish: ${channel.name}: verified ${String(declared.length)} artifact(s) of ${describeIdentity(identity)} against the release manifest`)
}

/**
 * Read the builder's own feed manifest for one channel.
 * @param channel - the platform channel.
 * @returns the parsed YAML document.
 * @throws [[PublishError]] when it is missing or does not parse.
 */
async function readBuiltFeedManifest(ctx: PublishContext, channel: FeedChannel): Promise<unknown> {
  const path = join(ctx.dist, channel.manifest)
  if (!existsSync(path)) {
    throw refuse(
      path,
      `is missing — build first: pnpm exec tsx apps/desktop-shell/scripts/package.ts --build-input <file> --${channel.platform === 'darwin' ? 'mac' : 'win'}`,
    )
  }
  try {
    return load(await readFile(path, 'utf8'), { schema: CORE_SCHEMA })
  } catch (error) {
    throw refuse(path, `does not parse: ${firstLine(error)}`)
  }
}

/**
 * Turn a failure into the publish state the operator needs to act on.
 *
 * Before any pointer moves, the feed still serves what it did; after one or
 * more pointers moved, the publish is partial and the message lists both
 * sides. The distinction is the whole point: a partial publish is finished by
 * re-running, never by rebuilding the bytes that are already immutable.
 * @param error - the caught failure.
 * @param identity - the build being published.
 * @param committed - the channels whose pointer already moved.
 * @param all - every channel this publish planned.
 * @returns the error to throw, carrying [[PublishErrorCode]].
 */
function asPublishFailure(
  error: unknown,
  identity: ReleaseIdentity,
  committed: readonly string[],
  all: readonly string[],
): PublishError {
  if (error instanceof PublishTransactionError) {
    return new PublishError(error.code, error.subject, `${error.message}; confirmed pointers: ${committed.join(', ') || 'none'}; other pointer outcomes may be unknown; reconcile the retained lock before retrying`, error)
  }
  if (error instanceof PublishError && (error.code === 'PUBLISH_PARTIAL' || error.code === 'PUBLISH_UNKNOWN')) return error
  const detail = error instanceof PublishError ? error.message : firstLine(error)
  const unfinished = all.filter(name => !committed.includes(name))
  if (committed.length === 0) {
    if (error instanceof PublishError) return error
    return new PublishError(
      'PUBLISH_FAILED',
      'publish',
      `${detail}; no manifest pointer was switched, so the feed still serves what it served before — `
      + 'the files already uploaded are unreferenced and safe to reuse',
    )
  }
  return new PublishError(
    'PUBLISH_PARTIAL',
    'the publish is partially complete',
    `published: ${committed.join(', ')}; unfinished: ${unfinished.length === 0 ? 'none' : unfinished.join(', ')}; `
    + `target ${describeIdentity(identity)}: ${detail}. Re-run with --republish to finish the missing platform idempotently; `
    + 'do not rebuild or re-upload the bytes that are already published',
  )
}

/** External process, HTTP and archive readers used by one invocation. */
export interface PublishOptions {
  /** Local directory containing the final artifacts and builder feeds. */
  readonly distDir: string
  /** Absolute remote feed root shared by both protocols. */
  readonly remoteRoot: string
  /** Public URL of that root. */
  readonly feedBase: string
  /** Execute one remote shell command, without mutation retries. */
  executeRemote(script: string): Promise<string>
  /** Stream a local file through the supplied guarded remote command. */
  sendFile(path: string, script: string): Promise<void>
  /** Execute a local process, including Git. */
  capture(command: string, args: string[]): Promise<string>
  /** Read the client-facing HTTP URL. */
  readonly fetch: typeof fetch
  /** Inspect final archives against their declared identity. */
  verifyPackage(input: {
    distDir: string
    identity: ReleaseIdentity
    platform: ReleasePlatform
    artifacts: readonly ReleaseManifestArtifact[]
  }): Promise<void>
}

interface PublishContext {
  readonly argv: string[]
  readonly dist: string
  readonly options: PublishOptions
  readonly transaction: PublishTransaction
  recoveryTags: string
}

/** Resolve one channel using this invocation's destinations. */
function locationFor(ctx: PublishContext, protocol: FeedProtocol, channel: FeedChannel): ChannelLocation {
  const location = channelLocation(protocol, channel)
  return { ...location, remoteDir: `${ctx.options.remoteRoot}/${location.relative}`, url: `${ctx.options.feedBase}/${location.relative}` }
}

/** Stable record serialization makes inventory order irrelevant to identity. */
function releaseRecord(manifest: ReleaseManifest): string {
  return JSON.stringify({
    version: manifest.version,
    dshRelease: {
      schemaVersion: manifest.dshRelease.schemaVersion,
      runtimeVersion: manifest.dshRelease.runtimeVersion,
      buildSequence: manifest.dshRelease.buildSequence,
      revision: manifest.dshRelease.revision,
      kind: manifest.dshRelease.kind,
    },
    platforms: Object.fromEntries(FEED_CHANNELS.map(channel => [channel.platform, {
      arch: manifest.platforms[channel.platform].arch,
      artifacts: [...manifest.platforms[channel.platform].artifacts]
        .sort((left, right) => left.fileName.localeCompare(right.fileName))
        .map(artifact => ({ fileName: artifact.fileName, sha512: artifact.sha512, size: artifact.size })),
    }])),
  })
}

/** One sequence has one identity; each platform independently binds its artifact bytes. */
interface ReleaseHistory {
  readonly identities: readonly ReleaseIdentity[]
  readonly inventories: readonly ReleaseManifest[]
}

/** Canonical identity fields are independent of JSON key ordering. */
function identityRecord(identity: ReleaseIdentity): string {
  return JSON.stringify({ version: identity.version, dshRelease: {
    schemaVersion: identity.dshRelease.schemaVersion,
    runtimeVersion: identity.dshRelease.runtimeVersion,
    buildSequence: identity.dshRelease.buildSequence,
    revision: identity.dshRelease.revision,
    kind: identity.dshRelease.kind,
  } })
}

/** Read every permanent sequence reservation; malformed history stops publication. */
async function readReleaseHistory(ctx: PublishContext): Promise<ReleaseHistory> {
  const directory = `${ctx.options.remoteRoot}/.releases`
  const listing = await ctx.transaction.read(`if [ -d ${shellQuote(directory)} ]; then for f in ${shellQuote(directory)}/b*.json; do [ -e "$f" ] || continue; printf '%s\\n' "\${f##*/}"; done; fi`)
  const identities: ReleaseIdentity[] = []
  const inventories: ReleaseManifest[] = []
  for (const name of listing.split('\n').filter(Boolean)) {
    if (!/^b[1-9][0-9]*(?:-(?:darwin|win32)\.inventory)?\.json$/u.test(name)) throw refuse('release history', `invalid record name ${name}`)
    const read = await readRemoteText(ctx, `${directory}/${name}`)
    if (read.kind === 'absent') throw refuse('release history', `${name} disappeared while the publish lock was held`)
    try {
      const parsed: unknown = JSON.parse(read.text)
      const identity = parseReleaseIdentity(parsed)
      const prefix = `b${String(identity.dshRelease.buildSequence)}`
      if (name === `${prefix}.json`) identities.push(identity)
      else {
        const manifest = parseReleaseManifest(parsed)
        const platform = name === `${prefix}-darwin.inventory.json` ? 'darwin' : name === `${prefix}-win32.inventory.json` ? 'win32' : undefined
        if (platform === undefined || manifest.platforms[platform].artifacts.length === 0
          || FEED_CHANNELS.some(channel => channel.platform !== platform && manifest.platforms[channel.platform].artifacts.length > 0)) {
          throw refuse(name, 'record identity or platform differs from its file name')
        }
        inventories.push(manifest)
      }
    } catch (cause) {
      throw new PublishError('PUBLISH_REFUSED', name, 'release history is damaged; restore its verified record before publishing', cause)
    }
  }
  for (const inventory of inventories) {
    const identity = identities.find(record => record.dshRelease.buildSequence === inventory.dshRelease.buildSequence)
    if (identity === undefined || !isSameBuild(identity, inventory)) throw refuse('release history', 'platform inventory has no matching global identity record')
  }
  return { identities, inventories }
}

/** Bind a sequence to its complete identity and final inventory across protocols. */
function verifyReleaseHistory(target: ReleaseManifest, history: ReleaseHistory): void {
  const previous = history.identities.find(record => record.dshRelease.buildSequence === target.dshRelease.buildSequence)
  if (previous !== undefined && !isSameBuild(previous, target)) {
    throw refuse('buildSequence', `build ${String(target.dshRelease.buildSequence)} is permanently assigned to another identity; allocate a new sequence`)
  }
  for (const inventory of history.inventories.filter(record => record.dshRelease.buildSequence === target.dshRelease.buildSequence)) {
    for (const channel of FEED_CHANNELS) {
      const oldArtifacts = inventory.platforms[channel.platform].artifacts
      const targetArtifacts = target.platforms[channel.platform].artifacts
      if (oldArtifacts.length > 0 && targetArtifacts.length > 0
        && releaseRecord(platformInventory(inventory, channel.platform)) !== releaseRecord(platformInventory(target, channel.platform))) {
        throw refuse('artifact inventory', `${channel.name} bytes are permanently assigned for this sequence; rebuild with a new sequence`)
      }
    }
  }
}

/** Isolate one platform's inventory so other platforms can be built independently. */
function platformInventory(manifest: ReleaseManifest, platform: ReleasePlatform): ReleaseManifest {
  return { ...manifest, platforms: {
    darwin: { arch: 'arm64', artifacts: platform === 'darwin' ? manifest.platforms.darwin.artifacts : [] },
    win32: { arch: 'x64', artifacts: platform === 'win32' ? manifest.platforms.win32.artifacts : [] },
  } }
}

/** Recover the identity a v1 pointer omits from its immutable publication record. */
function recordedLiveIdentity(channel: FeedChannel, live: LiveRead, history: ReleaseHistory): ReleaseIdentity | undefined {
  if (live.kind !== 'present') return undefined
  if (live.feed.identity !== undefined) return live.feed.identity
  const matchingVersion = history.inventories.filter(record => record.dshRelease.kind === 'bridge' && record.version === live.feed.version && record.platforms[channel.platform].artifacts.length > 0)
  const matching = matchingVersion.filter((record) => {
    const artifacts = record.platforms[channel.platform].artifacts.filter(artifact => !artifact.fileName.endsWith(BLOCKMAP_SUFFIX))
    return artifacts.length === live.feed.files.length && live.feed.files.every(file => artifacts.some(artifact =>
      artifact.fileName === file.url && artifact.sha512 === file.sha512 && artifact.size === file.size))
  })
  if (matching.length > 1 || (matchingVersion.length > 0 && matching.length === 0)) throw refuse(channel.name, 'v1 pointer disagrees with its permanent release history')
  return matching[0] === undefined ? undefined : releaseManifestIdentity(matching[0])
}

/** Persist the sequence reservation before uploading any of its artifacts. */
async function reserveRelease(ctx: PublishContext, manifest: ReleaseManifest, channels: readonly FeedChannel[]): Promise<void> {
  const prefix = `${ctx.options.remoteRoot}/.releases/b${String(manifest.dshRelease.buildSequence)}`
  await reserveRecord(ctx, `${prefix}.json`, identityRecord(manifest))
  for (const channel of channels) {
    await reserveRecord(ctx, `${prefix}-${channel.platform}.inventory.json`, releaseRecord(platformInventory(manifest, channel.platform)))
  }
}

/** Write and verify one non-overwritable history entry. */
async function reserveRecord(ctx: PublishContext, path: string, text: string): Promise<void> {
  const expected = { sha512: createHash('sha512').update(text).digest('hex'), size: Buffer.byteLength(text) }
  const existing = await ctx.transaction.fileState(path)
  if (existing.kind === 'present') {
    if (existing.sha512 !== expected.sha512 || existing.size !== expected.size) throw refuse(path, 'sequence record bytes differ; history is immutable')
    return
  }
  const staged = ctx.transaction.stagedPath(path)
  await ctx.transaction.stageText(staged, text)
  await ctx.transaction.commitImmutable(staged, path, expected)
}

/** Preserve every recognized legacy dependency, including implicit old blockmaps. */
async function backupFeeds(ctx: PublishContext, work: readonly ChannelWork[], history: ReleaseHistory): Promise<void> {
  const localTags = await git(ctx, 'for-each-ref', '--format=%(refname) %(objectname) %(*objectname)', 'refs/tags')
  const remotes = (await git(ctx, 'remote')).split('\n')
  const originTags = remotes.includes('origin') ? await git(ctx, 'ls-remote', '--tags', 'origin') : ''
  ctx.recoveryTags = JSON.stringify({ localTags, originTags, history })
  const paths = new Set<string>()
  for (const item of work) {
    const locations = item.location.protocol === 'v1' ? [item.location] : [item.location, locationFor(ctx, 'v1', item.channel)]
    for (const location of locations) {
      const live = location.protocol === item.location.protocol ? item.liveRead : item.bridgeRead
      if (live.kind === 'absent') continue
      if (live.kind !== 'present') throw refuse(location.relative, 'cannot establish the previous feed and its recovery dependencies')
      paths.add(`${location.remoteDir}/${location.channel.manifest}`)
      for (const file of live.feed.files) {
        paths.add(`${location.remoteDir}/${file.url}`)
        paths.add(`${location.remoteDir}/${file.url}${BLOCKMAP_SUFFIX}`)
      }
      if (location.protocol === 'v1') {
        const names = await remoteDirectoryNames(ctx, location)
        for (const name of names) if (parseArtifactName(name) !== undefined) paths.add(`${location.remoteDir}/${validateFeedFileName(name)}`)
      }
    }
  }
  const recovery = await ctx.transaction.backup([...paths], ctx.recoveryTags)
  console.log(`publish: verified recovery copies and tag inventory at ${recovery}`)
}

/**
 * Run the same command entry used by the CLI, with instance-owned external I/O.
 * A failed or interrupted remote mutation preserves its lock and recovery files;
 * only confirmed pointer writes contribute to the published-platform report.
 * @param argv - Arguments after the script name.
 * @param overrides - Explicit transport and artifact-reader substitutions.
 * @returns Resolves after client URL verification; typed failures retain effects.
 */
export async function runPublish(argv: string[], overrides: Partial<PublishOptions> = {}): Promise<void> {
  if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
    console.log('Usage: publish-update.ts --release-manifest <final-inventory.json> --notes <notes.md> [--channel all|mac|win] [--feed-protocol v1|v2] [--minimum-version <version>] [--minimum-build-sequence <number>] [--republish] [--prune|--no-prune] [--no-tag] [--dry-run]')
    console.log('Dry runs read SSH and Git remotes. They do not acquire a lock, upload, switch pointers, prune, or tag.')
    return
  }
  const options: PublishOptions = {
    distDir: DIST,
    remoteRoot: REMOTE_ROOT,
    feedBase: FEED_BASE,
    executeRemote: script => capture('ssh', [...SSH_KEEPALIVE, REMOTE_HOST, script]),
    sendFile,
    capture,
    fetch,
    verifyPackage: async (input) => {
      const { verifyPackagedRelease } = await import('./build-release.ts')
      await verifyPackagedRelease(input)
    },
    ...overrides,
  }
  const transaction = new PublishTransaction(options.remoteRoot, { execute: options.executeRemote })
  const ctx: PublishContext = { argv, dist: options.distDir, options, transaction, recoveryTags: '' }
  let failure: { cause: unknown } | undefined
  try {
    await main(ctx)
  } catch (cause) {
    failure = { cause }
  }
  try {
    await transaction.release()
  } catch (cause) {
    const detail = failure === undefined ? 'publication completed' : firstLine(failure.cause)
    const causes = failure === undefined ? [cause] : [failure.cause, cause]
    failure = { cause: new PublishError(
      'PUBLISH_UNKNOWN', 'publish lock release',
      `${detail}; lock release could not be confirmed; inspect this attempt before another publish`,
      new AggregateError(causes, 'publication and lock-release results'),
    ) }
  }
  if (transaction.requiresReconciliation) {
    console.error(`publish: lock state requires reconciliation at ${transaction.lockPath}; recovery at ${transaction.recoveryPath}; inspect attempt ${transaction.attempt}, confirm every remote command has stopped, and reconcile pointer and artifact digests before removing only this attempt's lock`)
  }
  if (failure !== undefined) {
    const { cause } = failure
    if (cause instanceof PublishTransactionError) throw new PublishError(cause.code, cause.subject, cause.message, cause)
    throw cause
  }
}

async function main(ctx: PublishContext): Promise<void> {
  const cli = parseCli(ctx.argv)
  const notesPath = resolve(cli.notes)
  if (!existsSync(notesPath)) throw refuse('--notes', `${notesPath} does not exist`)
  const notes = (await readFile(notesPath, 'utf8')).trim()
  if (notes === '') throw refuse('--notes', `${notesPath} is empty`)

  const releaseManifest = await readReleaseManifest(cli)
  const identity = releaseManifestIdentity(releaseManifest)
  const protocol = resolveFeedProtocol(identity, cli.feedProtocol)
  console.log(`publish: releasing ${describeIdentity(identity)} into the ${protocol} tree`)
  console.log(`publish: attempt ${ctx.transaction.attempt}; one remote lock covers both protocols and all platforms`)

  // Local artifacts first: a build that does not match its own manifest must
  // not reach a server, because an upload cannot be taken back.
  for (const channel of cli.channels) await verifyLocalBuild(ctx, identity, releaseManifest, channel)

  // Every channel's live feed is read on its own. The v1 bridge feed is read
  // even for a v2 publish, because the prune protection set is built from it.
  if (!cli.dryRun) await ctx.transaction.acquire()
  const history = await readReleaseHistory(ctx)
  verifyReleaseHistory(releaseManifest, history)
  // A sequence is global even when another protocol or platform owns its live pointer.
  for (const channel of FEED_CHANNELS) {
    for (const directoryProtocol of ['v1', 'v2'] as const) {
      const live = await readLiveFeed(ctx, locationFor(ctx, directoryProtocol, channel))
      if (live.kind === 'damaged' || live.kind === 'unreadable') throw refuse(`${directoryProtocol}/${channel.name}`, `cannot audit global release identity: ${live.reason}`)
      const recorded = recordedLiveIdentity(channel, live, history)
      if (recorded?.dshRelease.buildSequence === identity.dshRelease.buildSequence && !isSameBuild(recorded, identity)) {
        throw refuse('buildSequence', 'another live protocol or platform already assigns this sequence to a different identity')
      }
    }
  }
  const work: ChannelWork[] = []
  const tagPlanRepository = await readRepositoryState(ctx, cli, releaseTagName(identity))
  const tagPlan = planReleaseTag({ identity, repository: tagPlanRepository })
  announceReleaseTag(tagPlan, identity)
  for (const channel of cli.channels) {
    const location = locationFor(ctx, protocol, channel)
    const liveRead = await readLiveFeed(ctx, location)
    const bridgeRead = protocol === 'v1' ? liveRead : await readLiveFeed(ctx, locationFor(ctx, 'v1', channel))
    if (protocol === 'v2' && (bridgeRead.kind === 'unreadable' || bridgeRead.kind === 'damaged')) {
      if (cli.prune !== 'skip') {
        throw refuse(
          `v1/${channel.name}/${channel.manifest}`,
          `could not be read (${bridgeRead.reason}), so the prune protection set cannot include the bridge — `
          + 'fix the feed access, or pass --no-prune to publish without a prune plan',
        )
      }
      console.log(`publish: WARNING — v1/${channel.name}: the bridge feed could not be read (${bridgeRead.reason}); the prune step is skipped`)
    }
    const recorded = recordedLiveIdentity(channel, liveRead, history)
    if (recorded !== undefined) {
      if (identity.dshRelease.buildSequence < recorded.dshRelease.buildSequence) throw refuse(channel.name, 'build sequence would move backwards')
      if (compareVersions(identity.dshRelease.runtimeVersion, recorded.dshRelease.runtimeVersion) < 0) throw refuse(channel.name, 'runtime would move backwards')
    }
    const otherRead = protocol === 'v2' ? bridgeRead : await readLiveFeed(ctx, locationFor(ctx, 'v2', channel))
    if (otherRead.kind === 'unreadable' || otherRead.kind === 'damaged') {
      throw refuse(channel.name, `cannot verify the bridge-to-v2 runtime transition: ${otherRead.reason}`)
    }
    const otherIdentity = recordedLiveIdentity(channel, otherRead, history)
    if (otherIdentity !== undefined) {
      const bridge = protocol === 'v1' ? identity : otherIdentity
      const standard = protocol === 'v2' ? identity : otherIdentity
      const bridgeRuntime = bridge.dshRelease.runtimeVersion
      const standardRuntime = standard.dshRelease.runtimeVersion
      if (compareVersions(standardRuntime, bridgeRuntime) < 0) {
        throw refuse(
          channel.name,
          `bridge-to-v2 runtime would move backwards (${bridgeRuntime} → ${standardRuntime}); `
          + 'publish a v2 build with a runtime at least as new as the bridge before exposing this transition',
        )
      }
      if (standard.dshRelease.buildSequence <= bridge.dshRelease.buildSequence) {
        throw refuse(
          channel.name,
          `bridge-to-v2 build sequence must increase (b${String(bridge.dshRelease.buildSequence)} → b${String(standard.dshRelease.buildSequence)}); `
          + 'publish a newer v2 build before exposing this transition',
        )
      }
    }
    const plan = planChannelPublish({
      channel,
      identity,
      live: liveRead,
      republish: cli.republish,
      ...cli.minimumBuildSequence === undefined ? {} : { minimumBuildSequence: cli.minimumBuildSequence },
      ...cli.minimumVersion === undefined ? {} : { minimumVersion: cli.minimumVersion },
    })
    const artifacts = releaseManifest.platforms[channel.platform].artifacts
    const shared = servedBytesMismatches(plan.live, artifacts)
    if (shared.length > 0) {
      throw refuse(
        `${location.relative}/${channel.manifest}`,
        `already records different bytes under a file name this build reuses: ${shared.join('; ')}. `
        + 'The feed is immutable, so republish only identical bytes — otherwise publish a build with a new version or sequence',
      )
    }
    const manifest = buildFeedManifest({
      protocol,
      identity,
      source: await readBuiltFeedManifest(ctx, channel),
      artifacts,
      releaseNotes: notes,
      ...plan.minimumBuildSequence === undefined ? {} : { minimumBuildSequence: plan.minimumBuildSequence },
      ...plan.minimumVersion === undefined ? {} : { minimumVersion: plan.minimumVersion },
    })
    work.push({ channel, location, liveRead, bridgeRead, plan, artifacts, manifest })
    console.log(`publish: ${location.relative}: ${describeLiveRead(liveRead)} → ${describeIdentity(identity)}`)
    if (plan.loweredBuildSequence !== undefined) {
      console.log(`publish: WARNING — minimumBuildSequence is being lowered from ${String(plan.loweredBuildSequence)} to ${String(plan.minimumBuildSequence ?? 0)}; clients below the old line now run until they reach the new one`)
    }
    if (plan.loweredVersion !== undefined) {
      console.log(`publish: WARNING — minimumVersion is being lowered from ${plan.loweredVersion} to ${plan.minimumVersion ?? 'unset'}; clients below the old line now run until they reach the new one`)
    }
  }
  console.log(`publish: ${String(releaseManifestArtifacts(releaseManifest).length)} artifact(s) recorded by the release manifest across both platforms`)

  if (cli.dryRun) {
    for (const item of work) {
      console.log(
        `publish: dry run — would upload to ${item.location.relative}: `
        + `${item.artifacts.map(artifact => artifact.fileName).join(', ')}, then switch ${item.channel.manifest}`,
      )
    }
    await runPrune(ctx, work, cli)
    const tagLine = dryRunTagLine(tagPlan)
    if (tagLine !== undefined) console.log(`publish: dry run — ${tagLine}`)
    console.log('publish: dry run — nothing was uploaded and no pointer moved.')
    return
  }

  const committed: string[] = []
  try {
    await backupFeeds(ctx, work, history)
    await reserveRelease(ctx, releaseManifest, cli.channels)
    // Directory creation first, so a first publish into the v2 tree has a
    // destination; then every artifact, then every staged manifest. No pointer
    // moves until all of it has verified.
    for (const item of work) await ensureRemoteDirectory(ctx, item.location)
    for (const item of work) {
      for (const artifact of item.artifacts) {
        await publishArtifact(ctx, join(ctx.dist, artifact.fileName), item.location, artifact)
      }
    }
    for (const item of work) await stageManifest(ctx, item)
    for (const item of work) {
      await commitManifest(ctx, item)
      committed.push(item.channel.name)
    }

    // Read back from the URL a client actually fetches. Only a complete match
    // counts: a served version alone would pass a feed pointing at other bytes.
    const readbackFailures: { readonly item: ChannelWork; readonly detail: string }[] = []
    for (const item of work) {
      const url = `${item.location.url}/${item.channel.manifest}`
      try {
        const actual = await fetchServedManifest(ctx, url)
        const mismatches = verifyFeedReadback(item.manifest, actual)
        if (mismatches.length === 0) {
          console.log(`publish: read back ${url}: ${describeIdentity(item.manifest.identity)}, every field as written`)
        } else {
          readbackFailures.push({ item, detail: mismatches.join('; ') })
        }
      } catch (error) {
        readbackFailures.push({ item, detail: `could not be read back (${firstLine(error)})` })
      }
    }
    if (readbackFailures.length > 0) {
      const failedChannels = new Set(readbackFailures.map(failure => failure.item.channel.name))
      const served = work.filter(item => !failedChannels.has(item.channel.name)).map(item => item.location.relative)
      const unfinished = work.filter(item => failedChannels.has(item.channel.name)).map(item => item.location.relative)
      const details = readbackFailures.map(failure => `${failure.item.location.relative}: ${failure.detail}`)
      throw new PublishError(
        'PUBLISH_PARTIAL',
        'the feed did not read back as written',
        `published: ${served.length === 0 ? 'none' : served.join(', ')}; unfinished: ${unfinished.join(', ')}; `
        + `target ${describeIdentity(identity)}: ${details.join(' | ')}. The pointers moved, so fix the cause and re-run with --republish`,
      )
    }

    if (ctx.transaction.requiresReconciliation) {
      throw new PublishError('PUBLISH_UNKNOWN', 'remote transport', `target pointers and client URLs verified on ${committed.join(', ')}; an earlier mutation response was lost, so the lock is retained and prune/tag are stopped until the attempt is reconciled`)
    }
    await runPrune(ctx, work, cli)
    const tagged = await applyReleaseTag(ctx, tagPlan, identity, notesPath)
    summarize(tagPlan, identity, tagged, work.map(item => item.location.relative))
  } catch (error) {
    throw asPublishFailure(error, identity, committed, work.map(item => item.channel.name))
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    await runPublish(process.argv.slice(2))
  } catch (error) {
    const detail = error instanceof PublishError ? error.message : firstLine(error)
    const code = error instanceof PublishError ? `${error.code}: ` : ''
    console.error(`publish: ${code}${detail}`)
    process.exitCode = 1
  }
}
