/**
 * One desktop build's artifact inventory: what was built, and which bytes.
 *
 * A release is described by two files with different owners. The update feed
 * (`latest*.yml`) is written by electron-builder for a client to read; the
 * release manifest is written by the packaging run and read by the publish, so
 * a publish never has to re-derive an old build's identity from a version in
 * the working tree. It repeats the build identity exactly as the embedded
 * `dshRelease` object declares it, and lists every final artifact with its
 * SHA-512 and size — the two values a download is verified against.
 *
 * Everything here arrives from a file, so parsing is strict and fails closed
 * with a typed error whose `code` is the machine-readable answer. Bytes are
 * file names with no directory part: a manifest describes entries of one feed
 * directory, not paths on the publishing host.
 * @module
 */

import type { DesktopReleaseMetadata, ReleaseArch, ReleaseIdentity, ReleasePlatform } from '../src/release-identity.ts'
import { parseReleaseIdentity } from '../src/release-identity.ts'
import { validateFeedFileName } from '../src/feed-validation.ts'
import { expectedArtifacts } from './artifact-names.ts'

/** Build-time identity and targets; final bytes are recorded only after packaging. */
export interface ReleaseBuildInput extends ReleaseIdentity {
  /** Targets this run must produce; darwin is arm64 and win32 is x64. */
  readonly platforms: readonly ReleasePlatform[]
}

/**
 * Read a build request without requiring hashes of artifacts that do not exist.
 * @param value - Parsed build-input JSON.
 * @returns The identity and nonempty, unique target list.
 * @throws {ReleaseManifestError} If targets are absent, unsupported, or duplicated.
 */
export function parseReleaseBuildInput(value: unknown): ReleaseBuildInput {
  const identity = parseReleaseIdentity(value)
  const targets = property(value, 'platforms')
  if (!Array.isArray(targets) || targets.length === 0) invalid('platforms', 'must be a nonempty array of build targets')
  const platforms: ReleasePlatform[] = []
  for (const target of targets) {
    if (typeof target !== 'string' || !isReleasePlatform(target)) invalid('platforms', 'must contain only darwin or win32')
    if (platforms.includes(target)) invalid('platforms', `${target} is listed twice`)
    platforms.push(target)
  }
  return { ...identity, platforms }
}

/** Platforms a release manifest must describe, in the order this module lists their artifacts. */
const PLATFORMS: readonly ReleasePlatform[] = ['darwin', 'win32']

/**
 * The architecture each supported target produces today.
 *
 * A manifest naming another one describes a build this product cannot install,
 * so it is refused rather than passed through to a publisher that would point
 * a feed at it.
 */
const ARCH: Readonly<Record<ReleasePlatform, ReleaseArch>> = { darwin: 'arm64', win32: 'x64' }

/** The base64 form of a 64-byte SHA-512 digest, which is what electron-builder writes. */
const SHA512_PATTERN = /^[A-Za-z0-9+/]{86}==$/u

/** One final artifact of one build. */
export interface ReleaseManifestArtifact {
  /** The artifact's bare file name inside the feed directory. */
  readonly fileName: string
  /** The base64 SHA-512 of those bytes. */
  readonly sha512: string
  /** The artifact's byte length. */
  readonly size: number
}

/** The artifacts one platform's build produced. */
export interface ReleaseManifestPlatform {
  /** The architecture those artifacts were built for. */
  readonly arch: ReleaseArch
  /**
   * Every final artifact of this platform, blockmaps included. Empty when this
   * build did not produce the platform; a publisher refuses that platform.
   */
  readonly artifacts: readonly ReleaseManifestArtifact[]
}

/** One build: its version, its embedded identity, and every artifact it produced. */
export interface ReleaseManifest {
  /** The application version Electron reports, exactly as the package manifest declares it. */
  readonly version: string
  /** The build identity embedded in the package, repeated here for the publisher. */
  readonly dshRelease: DesktopReleaseMetadata
  /** The artifacts of each supported platform, keyed by platform. */
  readonly platforms: Readonly<Record<ReleasePlatform, ReleaseManifestPlatform>>
}

/** Stable machine identity of every refusal this module raises. */
export type ReleaseManifestErrorCode =
  /** A field is missing, mistyped, out of range, or names a target this product cannot install. */
  | 'RELEASE_MANIFEST_INVALID'
  /** One file name is listed twice, so two digests would claim the same feed entry. */
  | 'RELEASE_MANIFEST_CONFLICT'

/**
 * A refusal this module raises, carrying the stable discriminant callers branch
 * on and the field that failed for the log.
 *
 * A malformed `version` or `dshRelease` is refused by the identity module and
 * raises its `ReleaseIdentityError` unchanged, because that module owns the
 * question of what a build identity is.
 */
export class ReleaseManifestError extends Error {
  /** Stable machine identity; never parsed out of [[message]]. */
  readonly code: ReleaseManifestErrorCode

  /** The field the refusal is about, for diagnostics. */
  readonly subject: string

  /**
   * @param code - the stable discriminant.
   * @param subject - the field that failed.
   * @param detail - what was wrong, appended to the human-readable message.
   */
  constructor(code: ReleaseManifestErrorCode, subject: string, detail: string) {
    super(`${subject}: ${detail}`)
    this.name = 'ReleaseManifestError'
    this.code = code
    this.subject = subject
  }
}

/**
 * Whether a property name is a platform this product installs.
 * @param value - the property name from the manifest's platform map.
 * @returns true for a supported platform.
 */
function isReleasePlatform(value: string): value is ReleasePlatform {
  return PLATFORMS.some(platform => platform === value)
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
  if (Array.isArray(value)) return 'an array'
  return typeof value === 'object' ? 'an object' : String(value)
}

/**
 * Read one property of an unknown object without asserting a shape.
 * @param value - the value to read; anything that is not a non-null object is empty.
 * @param key - the property name.
 * @returns the property's value, or undefined when the object has none.
 */
function property(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  if (!Object.hasOwn(value, key)) return undefined
  return Reflect.get(value, key)
}

/**
 * Refuse a value with the manifest's structural error code.
 * @param subject - the field that failed.
 * @param detail - what was wrong.
 * @throws [[ReleaseManifestError]] always.
 */
function invalid(subject: string, detail: string): never {
  throw new ReleaseManifestError('RELEASE_MANIFEST_INVALID', subject, detail)
}

/**
 * Require one bare artifact file name.
 *
 * The name is a feed directory entry, so it is checked against the same rules
 * the updater applies to names it reads from the feed: no directory part, no
 * null byte, no Windows reserved name.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the same name, unchanged.
 * @throws [[ReleaseManifestError]] when the value is not a usable feed file name.
 */
function artifactFileName(value: unknown, subject: string): string {
  if (typeof value !== 'string') invalid(subject, `must be a string, got ${describe(value)}`)
  try {
    return validateFeedFileName(value)
  } catch (error) {
    // The shared validator rejects with a localized message; this module
    // reports the same refusal under its own stable code and keeps the
    // validator's detail, which names the exact rule that fired.
    return invalid(subject, `must be a bare feed file name: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Require one positive, safe artifact size.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the same number, unchanged.
 * @throws [[ReleaseManifestError]] when the value is not a positive safe integer.
 */
function artifactSize(value: unknown, subject: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    invalid(subject, `must be a positive safe integer, got ${describe(value)}`)
  }
  return value
}

/**
 * Require one base64 SHA-512 digest.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the same digest, unchanged.
 * @throws [[ReleaseManifestError]] when the value is not the base64 form of a 64-byte digest.
 */
function artifactDigest(value: unknown, subject: string): string {
  if (typeof value !== 'string' || !SHA512_PATTERN.test(value)) {
    invalid(subject, `must be the base64 form of a SHA-512 digest, got ${describe(value)}`)
  }
  return value
}

/**
 * Parse one artifact entry.
 * @param value - the entry's candidate value.
 * @param subject - the field path used in refusals.
 * @returns the validated artifact.
 * @throws [[ReleaseManifestError]] when a field is missing or out of range.
 */
function parseArtifact(value: unknown, subject: string): ReleaseManifestArtifact {
  if (typeof value !== 'object' || value === null) invalid(subject, `must be an object, got ${describe(value)}`)
  return {
    fileName: artifactFileName(property(value, 'fileName'), `${subject}.fileName`),
    sha512: artifactDigest(property(value, 'sha512'), `${subject}.sha512`),
    size: artifactSize(property(value, 'size'), `${subject}.size`),
  }
}

/**
 * Require one architecture this product installs.
 * @param value - the candidate value.
 * @param subject - the field name used in the refusal.
 * @returns the validated architecture.
 * @throws [[ReleaseManifestError]] when the value is not a supported architecture.
 */
function releaseArch(value: unknown, subject: string): ReleaseArch {
  if (value !== 'arm64' && value !== 'x64') {
    invalid(subject, `must be arm64 or x64, got ${describe(value)}`)
  }
  return value
}

/**
 * Parse one platform's artifact list.
 * @param value - the platform's candidate value.
 * @param platform - the platform the entry must describe.
 * @returns the validated platform entry.
 * @throws [[ReleaseManifestError]] when the entry is missing, names another
 * arch, or lists something that is not an artifact.
 */
function parsePlatform(value: unknown, platform: ReleasePlatform): ReleaseManifestPlatform {
  const subject = `platforms.${platform}`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(subject, `must be an object, got ${describe(value)}`)
  }
  const arch = releaseArch(property(value, 'arch'), `${subject}.arch`)
  if (arch !== ARCH[platform]) {
    invalid(`${subject}.arch`, `must be ${ARCH[platform]} on ${platform}, got ${arch}`)
  }
  const artifacts = property(value, 'artifacts')
  if (!Array.isArray(artifacts)) invalid(`${subject}.artifacts`, `must be an array, got ${describe(artifacts)}`)
  const listed: readonly unknown[] = artifacts
  return {
    arch,
    artifacts: listed.map((entry, index) => parseArtifact(entry, `${subject}.artifacts[${String(index)}]`)),
  }
}

/**
 * Parse a release manifest produced by one packaging run.
 *
 * The identity is validated by the identity module, which also enforces that a
 * `standard` build's two versions are equal; a `bridge` build is allowed to
 * disagree with its runtime, because changing the application version is what
 * it is for. What this module adds is the inventory: every artifact of the
 * build, each with a bare file name, a SHA-512, and a positive size, and no
 * file name listed twice — one feed entry cannot be two different files.
 * @param value - the parsed JSON document, as read from disk.
 * @returns the validated manifest.
 * @throws [[ReleaseIdentityError]] when the version or `dshRelease` is invalid.
 * @throws [[ReleaseManifestError]] when a platform or artifact entry is invalid,
 * or a file name is listed more than once.
 */
export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('manifest', `must be an object, got ${describe(value)}`)
  }
  const identity = parseReleaseIdentity(value)
  const platformsValue = property(value, 'platforms')
  if (typeof platformsValue !== 'object' || platformsValue === null || Array.isArray(platformsValue)) {
    invalid('platforms', `must be an object, got ${describe(platformsValue)}`)
  }
  for (const key of Object.keys(platformsValue)) {
    if (!isReleasePlatform(key)) {
      invalid(`platforms.${key}`, `must be one of ${PLATFORMS.join(', ')}; this product installs no other target`)
    }
  }
  const darwin = parsePlatform(property(platformsValue, 'darwin'), 'darwin')
  const win32 = parsePlatform(property(platformsValue, 'win32'), 'win32')
  const platforms: Readonly<Record<ReleasePlatform, ReleaseManifestPlatform>> = { darwin, win32 }
  const seen = new Set<string>()
  for (const platform of PLATFORMS) {
    for (const artifact of platforms[platform].artifacts) {
      if (seen.has(artifact.fileName)) {
        throw new ReleaseManifestError(
          'RELEASE_MANIFEST_CONFLICT',
          `platforms.${platform}.artifacts[].fileName`,
          `${artifact.fileName} is listed more than once, so one feed entry would name two files`,
        )
      }
      seen.add(artifact.fileName)
    }
  }
  for (const platform of PLATFORMS) {
    const names = platforms[platform].artifacts.map(artifact => artifact.fileName)
    if (names.length === 0) continue
    const expected = expectedArtifacts(identity, { mac: platform === 'darwin', win: platform === 'win32' })
    if (names.length !== expected.length || names.some(name => !expected.includes(name))) {
      invalid(`platforms.${platform}.artifacts`, 'must contain exactly this build\'s artifacts and blockmaps')
    }
  }
  if (seen.size === 0) invalid('platforms', 'must contain at least one completed platform')
  return { version: identity.version, dshRelease: identity.dshRelease, platforms }
}

/**
 * Every artifact of a manifest, across platforms, in a stable order.
 *
 * The publisher and the packaging check both need this flat list: the feed
 * directory is one directory, so duplicate names and missing files are
 * questions about the whole inventory rather than about one platform.
 * @param manifest - the validated manifest.
 * @returns the darwin artifacts followed by the win32 ones, in listed order.
 */
export function releaseManifestArtifacts(manifest: ReleaseManifest): readonly ReleaseManifestArtifact[] {
  return PLATFORMS.flatMap(platform => manifest.platforms[platform].artifacts)
}

/**
 * The identity a manifest declares.
 * @param manifest - the validated manifest.
 * @returns the version and embedded build identity, in the identity module's
 * form, so callers use one comparison and one key function.
 */
export function releaseManifestIdentity(manifest: ReleaseManifest): ReleaseIdentity {
  return { version: manifest.version, dshRelease: manifest.dshRelease }
}
