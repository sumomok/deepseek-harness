/**
 * What one desktop build is, independent of the SemVer it publishes under.
 *
 * A released desktop build carries three different identities that must not be
 * conflated:
 *
 * - `version` is the application version Electron reports and the update
 *   library compares. Upstream releases keep it verbatim.
 * - `buildSequence` is the only ordering input this product uses. It replaces
 *   the SemVer comparison so several builds of one upstream version can ship in
 *   order, and so a bridge build may carry a higher application version than
 *   the build that follows it.
 * - `revision` names the source commit the build came from. It is compared for
 *   equality only; it never orders anything, and no Git hash sorting is implied.
 *
 * The artifact SHA-512 is a fourth, content-level identity: it proves which
 * bytes a manifest points at. It does not replace the revision, and the
 * revision does not replace it.
 *
 * Every value here arrives from disk or from the network, so parsing is strict
 * and fails closed with a typed error. A build below the protocol version has no
 * `dshRelease` object at all; the caller decides that a legacy client follows
 * the old protocol rather than inventing an identity for it.
 * @module @deepseek-ai/dsh-desktop-shell/release-identity
 */

import semver from 'semver'
import { validateFeedFileName } from './feed-validation.ts'

/** The protocol version embedded in a build and carried by a v2 update feed. */
const RELEASE_SCHEMA_VERSION = 2

/** A Git object name as this repository writes it: 40 lowercase hexadecimal characters. */
const REVISION_PATTERN = /^[0-9a-f]{40}$/u

/** The base64 form of a 64-byte SHA-512 digest, which is what electron-builder writes. */
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u

/** Platforms a published build can target. */
export type ReleasePlatform = 'darwin' | 'win32'

/** Architectures a published build can target. */
export type ReleaseArch = 'arm64' | 'x64'

/**
 * Which naming protocol produced a build.
 *
 * `standard` keeps the application version equal to the DSH runtime version.
 * `bridge` exists only to carry a client from the old protocol to this one, so
 * its application version may be higher than the runtime it embeds.
 */
export type ReleaseKind = 'bridge' | 'standard'

/**
 * The `dshRelease` object embedded in a build's package manifest and repeated
 * in the matching v2 feed entry.
 */
export interface DesktopReleaseMetadata {
  /** Always [[RELEASE_SCHEMA_VERSION]]; a reader refuses anything else. */
  readonly schemaVersion: 2
  /**
   * The DSH runtime version the bundled server actually reports, which is what
   * plugin compatibility is evaluated against.
   */
  readonly runtimeVersion: string
  /** The only ordering input: strictly larger is newer, across upstream versions. */
  readonly buildSequence: number
  /** The full source commit the artifact was built from. */
  readonly revision: string
  /** Which naming protocol this build belongs to. */
  readonly kind: ReleaseKind
}

/** One build: the version Electron reports, and the identity this product adds. */
export interface ReleaseIdentity {
  /** The installed application version, exactly as the package manifest declares it. */
  readonly version: string
  /** The release identity embedded beside that version. */
  readonly dshRelease: DesktopReleaseMetadata
}

/** One downloadable artifact of a build. */
export interface ReleaseArtifact {
  /** The artifact's bare file name inside the feed directory. */
  readonly fileName: string
  /** The manifest's base64 SHA-512 for those bytes. */
  readonly sha512: string
  /** The artifact's byte length, as the manifest states it. */
  readonly size: number
  /** Whether the installer must run elevated; set for a per-machine Windows build. */
  readonly isAdminRightsRequired: boolean
}

/** A build together with the artifact this platform would download for it. */
export interface UpdateOffer {
  /** The build the feed offers. */
  readonly identity: ReleaseIdentity
  /** The artifact selected for this platform. */
  readonly artifact: ReleaseArtifact
  /** The platform the artifact was selected for. */
  readonly platform: ReleasePlatform
  /** The architecture the artifact was selected for. */
  readonly arch: ReleaseArch
  /** The publisher's red line in build-sequence terms, when the feed sets one. */
  readonly minimumBuildSequence?: number
  /** Release notes the manifest carries, passed through as the feed wrote them. */
  readonly releaseNotes?: string
}

/** Stable machine identity of every refusal this module raises. */
export type ReleaseIdentityErrorCode =
  /** An embedded identity, a manifest identity, or an artifact entry is malformed. */
  | 'RELEASE_IDENTITY_INVALID'
  /** A v2 feed entry is unusable: wrong protocol, no artifact for this platform, or a bad red line. */
  | 'UPDATE_MANIFEST_INVALID'
  /** One build sequence names two different builds. */
  | 'RELEASE_IDENTITY_CONFLICT'
  /** The offered build would install an older DSH runtime than the running one. */
  | 'RUNTIME_ROLLBACK_REJECTED'

/**
 * A refusal this module raises, carrying the stable discriminant callers branch
 * on and the field that failed for the log.
 */
export class ReleaseIdentityError extends Error {
  /** Stable machine identity; never parsed out of [[message]]. */
  readonly code: ReleaseIdentityErrorCode

  /** The field or subject the refusal is about, for diagnostics. */
  readonly subject: string

  /**
   * @param code - the stable discriminant.
   * @param subject - the field or subject that failed.
   * @param detail - what was wrong, appended to the human-readable message.
   */
  constructor(code: ReleaseIdentityErrorCode, subject: string, detail: string) {
    super(`${subject}: ${detail}`)
    this.name = 'ReleaseIdentityError'
    this.code = code
    this.subject = subject
  }
}

/** What [[decideUpdate]] concluded about one offered build. */
export type UpdateDecision =
  /** The offered build is ahead of the running one; it may be downloaded. */
  | { readonly kind: 'available'; readonly target: ReleaseIdentity }
  /** The running build is this build, or a newer one. */
  | { readonly kind: 'current'; readonly why: 'same-build' | 'older-build' }

/** The platforms a build manifest may name, keyed by their artifact extension. */
const ARTIFACT_EXTENSION: Readonly<Record<ReleasePlatform, string>> = {
  darwin: '.zip',
  win32: '.exe',
}

/** Base used only to resolve one feed entry the way the update library does. */
const FEED_ENTRY_BASE = new URL('https://feed.invalid/v2/mac/')

/** Characters a feed entry may not carry: path, URL syntax, and Windows-invalid names. */
const FORBIDDEN_ARTIFACT_NAME = /[/\\:*?"<>|#\u0000-\u001F]/u

/**
 * Read one property of an unknown object without asserting a shape.
 * @param value - the value to read; anything that is not a non-null object is empty.
 * @param key - the property name.
 * @returns the property's value, or undefined when the object has none.
 */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  if (!Object.hasOwn(value, key)) return undefined
  const found: unknown = Reflect.get(value, key)
  return found
}

/**
 * Require one strict SemVer string.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the same string, unchanged.
 * @throws [[ReleaseIdentityError]] when the value is missing or not strict SemVer.
 */
function semanticVersion(value: unknown, subject: string): string {
  if (typeof value !== 'string' || semver.valid(value) === null) {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', subject, `must be a strict SemVer version, got ${describe(value)}`)
  }
  return value
}

/**
 * Require one positive, safe build sequence.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the same number, unchanged.
 * @throws [[ReleaseIdentityError]] when the value is not a positive safe integer.
 */
function positiveSequence(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', subject, `must be a positive safe integer, got ${describe(value)}`)
  }
  return value
}

/**
 * Render an unknown value for a diagnostic without echoing unbounded input.
 * @param value - the value to describe.
 * @returns a short description, quoted when it is a string.
 */
function describe(value: unknown): string {
  if (typeof value === 'string') return value.length > 64 ? `${JSON.stringify(value.slice(0, 64))}…` : JSON.stringify(value)
  if (value === undefined) return 'nothing'
  if (value === null) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol') return value.toString()
  return 'an object'
}

/**
 * Parse the `dshRelease` object embedded in a build or repeated in a v2 feed.
 * @param value - the candidate value, typically read from a package manifest or a manifest file.
 * @returns the validated identity metadata.
 * @throws [[ReleaseIdentityError]] when a field is missing, mistyped, or out of range.
 */
export function parseDesktopReleaseMetadata(value: unknown): DesktopReleaseMetadata {
  if (typeof value !== 'object' || value === null) {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'dshRelease', `must be an object, got ${describe(value)}`)
  }
  const schemaVersion = property(value, 'schemaVersion')
  if (schemaVersion !== RELEASE_SCHEMA_VERSION) {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'dshRelease.schemaVersion', `must be ${String(RELEASE_SCHEMA_VERSION)}, got ${describe(schemaVersion)}`)
  }
  const runtimeVersion = semanticVersion(property(value, 'runtimeVersion'), 'dshRelease.runtimeVersion')
  const buildSequence = positiveSequence(property(value, 'buildSequence'), 'dshRelease.buildSequence')
  const revision = property(value, 'revision')
  if (typeof revision !== 'string' || !REVISION_PATTERN.test(revision)) {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'dshRelease.revision', `must be a 40-character lowercase Git object name, got ${describe(revision)}`)
  }
  const kind = property(value, 'kind')
  if (kind !== 'bridge' && kind !== 'standard') {
    throw new ReleaseIdentityError('RELEASE_IDENTITY_INVALID', 'dshRelease.kind', `must be "bridge" or "standard", got ${describe(kind)}`)
  }
  return { schemaVersion: RELEASE_SCHEMA_VERSION, runtimeVersion, buildSequence, revision, kind }
}

/**
 * Parse the identity of one build from the object that declares it.
 *
 * A `standard` build publishes its runtime version under the same application
 * version upstream uses; only a `bridge` may carry a different one, because its
 * whole purpose is to change the application version while leaving the runtime
 * where upstream put it.
 * @param value - the candidate, with `version` and `dshRelease` at its top level.
 * @returns the validated identity.
 * @throws [[ReleaseIdentityError]] when the version is invalid, the metadata is
 * invalid, or a standard build's two versions disagree.
 */
export function parseReleaseIdentity(value: unknown): ReleaseIdentity {
  const version = semanticVersion(property(value, 'version'), 'version')
  const dshRelease = parseDesktopReleaseMetadata(property(value, 'dshRelease'))
  if (dshRelease.kind === 'standard' && dshRelease.runtimeVersion !== version) {
    throw new ReleaseIdentityError(
      'RELEASE_IDENTITY_INVALID',
      'dshRelease.runtimeVersion',
      `must equal version for a standard build, got ${dshRelease.runtimeVersion} under ${version}`,
    )
  }
  return { version, dshRelease }
}

/**
 * Read the identity a running build reports, or nothing when it predates this
 * protocol.
 * @param manifest - the parsed `package.json` of the running application.
 * @returns the identity, or undefined when the manifest carries no `dshRelease`.
 * @throws [[ReleaseIdentityError]] when it carries one that is malformed.
 */
export function identityIfPresent(manifest: unknown): ReleaseIdentity | undefined {
  if (property(manifest, 'dshRelease') === undefined) return undefined
  return parseReleaseIdentity(manifest)
}

/**
 * Read one artifact entry of a feed manifest.
 *
 * Every entry of a v2 manifest names one file in this build's own feed
 * directory, written as that file is named, with the digest and length of its
 * bytes. The update library resolves the entry against the feed URL, decodes
 * it, and caches its basename, so an entry that percent-encodes anything, that
 * resolves somewhere else (an absolute URL, a root-relative path), or that
 * carries URL syntax is refused along with the whole document rather than
 * skipped: an entry this shell skipped is still one the library may pick.
 * @param value - the entry's candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the validated entry.
 * @throws [[ReleaseIdentityError]] when the entry names no usable local file.
 */
function parseFeedFile(value: unknown, subject: string): ReleaseArtifact {
  const url = property(value, 'url')
  if (typeof url !== 'string') {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, `must be a string, got ${describe(url)}`)
  }
  let fileName: string
  try {
    fileName = validateFeedFileName(url)
  } catch (error) {
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      `${subject}.url`,
      error instanceof Error ? error.message : String(error),
    )
  }
  let resolved: URL
  try {
    resolved = new URL(fileName, FEED_ENTRY_BASE)
  } catch {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'must resolve inside this build’s feed directory')
  }
  if (resolved.origin !== FEED_ENTRY_BASE.origin || !resolved.pathname.startsWith(FEED_ENTRY_BASE.pathname)) {
    // An absolute URL or a root-relative path: the library would fetch bytes
    // from somewhere other than this feed, and its cache name would be that
    // path's last segment rather than the name this shell froze.
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'must resolve inside this build’s feed directory')
  }
  if (resolved.search !== '' || resolved.hash !== '') {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'must be a file name, not a URL with a query or fragment')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(fileName)
  } catch {
    // The library decodes this same string to name its cached file; malformed
    // percent-encoding would leave it unable to cache what it downloads.
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'is not valid percent-encoding')
  }
  if (decoded !== fileName) {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'is percent-encoded; the v2 feed names files as they are')
  }
  if (FORBIDDEN_ARTIFACT_NAME.test(fileName)) {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.url`, 'must be one file name, not a URL or a path')
  }
  const sha512 = property(value, 'sha512')
  if (typeof sha512 !== 'string' || !SHA512_PATTERN.test(sha512)) {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.sha512`, 'must be the base64 form of a SHA-512 digest')
  }
  const size = property(value, 'size')
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', `${subject}.size`, `must be a positive safe integer, got ${describe(size)}`)
  }
  return { fileName, sha512, size, isAdminRightsRequired: property(value, 'isAdminRightsRequired') === true }
}

/**
 * Which of the manifest's files this machine's updater would download.
 *
 * The update library resolves the manifest's whole file list and then picks one
 * artifact, using rules the library keeps to itself: on macOS it prefers the
 * `arm64` files when the hardware is arm64 and drops them otherwise, then takes
 * the first file with the platform's archive extension; on Windows it takes the
 * first `.exe`. This function reproduces that selection so the file this shell
 * freezes is the file the library later downloads, and it refuses a manifest
 * whose selection it cannot pin down instead of guessing: exactly one artifact
 * must remain for this platform and architecture.
 * @param files - every validated entry of the manifest.
 * @param platform - the platform reading the feed.
 * @param arch - the architecture the library would select for.
 * @returns the artifact the library will download.
 * @throws [[ReleaseIdentityError]] when no entry fits, or when the manifest
 * names more than one candidate and the choice would be ambiguous.
 */
function selectArtifact(files: readonly ReleaseArtifact[], platform: ReleasePlatform, arch: ReleaseArch): ReleaseArtifact {
  const extension = ARTIFACT_EXTENSION[platform]
  // macOS only, and over the whole list before the extension is considered:
  // the library filters arm64-named files on an x64 host and keeps only them on
  // arm64 hardware when the feed offers both. Doing the extension first would
  // keep an x64 zip the library drops beside an arm64 dmg, or refuse a feed the
  // library can use.
  const forArch = platform === 'darwin' ? macArtifactsForArch(files, arch) : files
  const candidates = forArch.filter(file => file.fileName.toLowerCase().endsWith(extension))
  const [chosen] = candidates
  if (chosen === undefined) {
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      'files[]',
      `lists no ${extension} artifact for ${platform}/${arch}`,
    )
  }
  if (candidates.length > 1) {
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      'files[]',
      `lists ${String(candidates.length)} ${extension} artifacts for ${platform}/${arch}; the v2 feed must name exactly one`,
    )
  }
  if (platform === 'win32' && namesOtherArchitecture(chosen.fileName, arch)) {
    // The library does not filter Windows artifacts by architecture, so a feed
    // that offers the other one would otherwise be downloaded and run.
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      'files[].url',
      `names the ${arch === 'x64' ? 'arm64' : 'x64'} installer ${chosen.fileName}`,
    )
  }
  return chosen
}

/**
 * The entries the updater library keeps for one macOS architecture.
 *
 * This mirrors `MacUpdater.filterFilesForArch`: arm64 hardware keeps only the
 * files whose names say arm64 when the manifest has any, and x64 hardware drops
 * every arm64-named file. Universal builds, and arm64 hardware offered only
 * x64 files, keep the rest.
 * @param files - every validated entry of the manifest.
 * @param arch - the architecture the library treats the machine as.
 * @returns the entries the library would still consider.
 */
function macArtifactsForArch(files: readonly ReleaseArtifact[], arch: ReleaseArch): readonly ReleaseArtifact[] {
  const arm64Files = files.filter(file => file.fileName.includes('arm64'))
  if (arch === 'arm64') return arm64Files.length > 0 ? arm64Files : files
  return files.filter(file => !file.fileName.includes('arm64'))
}

/** Names an x64 Windows installer, whichever spelling the publisher used. */
const X64_INSTALLER_NAME = /x64|amd64|x86[_-]64/iu

/**
 * Whether one Windows installer's name says it is for the other architecture.
 * @param fileName - the installer's file name.
 * @param arch - the architecture this machine runs.
 * @returns true when the name contradicts the machine.
 */
function namesOtherArchitecture(fileName: string, arch: ReleaseArch): boolean {
  if (arch === 'x64') return fileName.includes('arm64')
  return X64_INSTALLER_NAME.test(fileName)
}

/**
 * Parse one v2 feed manifest into the build and artifact this platform would use.
 *
 * The artifact is chosen here rather than by the update library so that the
 * bytes a check accepted are the bytes the caller can later freeze, resume, and
 * install; the selection follows the library's own rules (see
 * [[selectArtifact]]), and the library still performs the download and its own
 * checksum verification. The caller binds the downloaded file to this artifact
 * before it reports anything installable.
 * @param value - the parsed `latest*.yml` document.
 * @param platform - the platform reading the feed.
 * @param arch - the architecture reading the feed.
 * @returns the offer this platform can download.
 * @throws [[ReleaseIdentityError]] when the manifest is malformed, names the
 * `bridge` protocol this version does not deliver, lists no artifact (or more
 * than one) for this platform, or sets a red line above its own build.
 */
export function parseUpdateOffer(value: unknown, platform: ReleasePlatform, arch: ReleaseArch): UpdateOffer {
  const identity = parseReleaseIdentity(value)
  if (identity.dshRelease.kind !== 'standard') {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', 'dshRelease.kind', `the v2 feed delivers standard builds only, got ${identity.dshRelease.kind}`)
  }
  const files = property(value, 'files')
  if (!Array.isArray(files) || files.length === 0) {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', 'files', `must be a non-empty array, got ${describe(files)}`)
  }
  const entries = files.map((file, index) => parseFeedFile(file, `files[${String(index)}]`))
  const artifact = selectArtifact(entries, platform, arch)
  const minimumBuildSequence = property(value, 'minimumBuildSequence')
  const releaseNotes = property(value, 'releaseNotes')
  return {
    identity,
    artifact,
    platform,
    arch,
    ...minimumBuildSequence === undefined
      ? {}
      : { minimumBuildSequence: redLine(minimumBuildSequence, identity.dshRelease.buildSequence) },
    ...typeof releaseNotes === 'string' ? { releaseNotes } : {},
  }
}

/**
 * Validate the publisher's red line against the build it accompanies.
 * @param value - the manifest's `minimumBuildSequence`.
 * @param buildSequence - the build that manifest offers.
 * @returns the validated red line.
 * @throws [[ReleaseIdentityError]] when it is not a positive safe integer or
 * exceeds the offered build, which would leave every client unable to proceed.
 */
function redLine(value: unknown, buildSequence: number): number {
  let sequence: number
  try {
    sequence = positiveSequence(value, 'minimumBuildSequence')
  } catch {
    throw new ReleaseIdentityError('UPDATE_MANIFEST_INVALID', 'minimumBuildSequence', `must be a positive safe integer, got ${describe(value)}`)
  }
  if (sequence > buildSequence) {
    throw new ReleaseIdentityError(
      'UPDATE_MANIFEST_INVALID',
      'minimumBuildSequence',
      `must not exceed the offered build ${String(buildSequence)}, got ${String(sequence)}`,
    )
  }
  return sequence
}

/**
 * Whether two identities name exactly the same build.
 * @param left - one identity.
 * @param right - the other identity.
 * @returns true when version, sequence, revision, kind, and runtime all agree.
 */
export function isSameBuild(left: ReleaseIdentity, right: ReleaseIdentity): boolean {
  return releaseKey(left) === releaseKey(right)
}

/**
 * The canonical key of one build, for comparing identities and keying caches.
 *
 * Field order is fixed and the values are unambiguous, so two identities have
 * one spelling. A version alone would merge builds, a Git hash alone would merge
 * repackaged bytes, and sorting by either would order things that must not be
 * ordered.
 * @param identity - the build to key.
 * @returns a single-line key with no separators the values could contain.
 */
export function releaseKey(identity: ReleaseIdentity): string {
  const { dshRelease } = identity
  return [
    `schema=${String(dshRelease.schemaVersion)}`,
    `version=${identity.version}`,
    `runtime=${dshRelease.runtimeVersion}`,
    `sequence=${String(dshRelease.buildSequence)}`,
    `revision=${dshRelease.revision}`,
    `kind=${dshRelease.kind}`,
  ].join('\u0000')
}

/**
 * Decide what one offered build means for a running build.
 *
 * Ordering is by build sequence alone. The runtime version may only stay the
 * same or move forward: a bridge lowers the application version while its
 * runtime stays put, and any later build that would reinstall an older DSH
 * runtime is a downgrade of the engine under the user's data, which is refused
 * rather than offered.
 *
 * Two different builds under one sequence are a publisher error, not a
 * preference: accepting either would make "which build is newer" depend on
 * which feed answered first.
 * @param current - the identity of the running build, read from its own package.
 * @param target - the identity the feed offers.
 * @returns whether the target is available to download, or the running build is current.
 * @throws [[ReleaseIdentityError]] for a runtime rollback or a sequence collision.
 */
export function decideUpdate(current: ReleaseIdentity, target: ReleaseIdentity): UpdateDecision {
  if (current.dshRelease.runtimeVersion !== target.dshRelease.runtimeVersion
    && semver.lt(target.dshRelease.runtimeVersion, current.dshRelease.runtimeVersion)) {
    throw new ReleaseIdentityError(
      'RUNTIME_ROLLBACK_REJECTED',
      'dshRelease.runtimeVersion',
      `${target.dshRelease.runtimeVersion} is older than the running ${current.dshRelease.runtimeVersion}`,
    )
  }
  const currentSequence = current.dshRelease.buildSequence
  const targetSequence = target.dshRelease.buildSequence
  if (targetSequence < currentSequence) return { kind: 'current', why: 'older-build' }
  if (targetSequence === currentSequence) {
    if (!isSameBuild(current, target)) {
      throw new ReleaseIdentityError(
        'RELEASE_IDENTITY_CONFLICT',
        'dshRelease.buildSequence',
        `sequence ${String(targetSequence)} names two different builds`,
      )
    }
    return { kind: 'current', why: 'same-build' }
  }
  return { kind: 'available', target }
}

/**
 * Whether a running build is below the publisher's red line.
 * @param current - the identity of the running build.
 * @param minimumBuildSequence - the feed's red line, when it sets one.
 * @returns true when the running build must update before it can be used.
 */
export function isBelowRedLine(current: ReleaseIdentity, minimumBuildSequence: number | undefined): boolean {
  return minimumBuildSequence !== undefined && current.dshRelease.buildSequence < minimumBuildSequence
}
