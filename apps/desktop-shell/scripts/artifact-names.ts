/**
 * What a packaging run must have produced, what `dist-app` actually holds, and
 * what one artifact's digest says about those bytes.
 *
 * `dist-app` accumulates: it is never cleared between runs, so every past
 * version's artifacts sit beside this one's, and a repackage of one version
 * after a fix finds that version's own files already there. Listing the
 * directory therefore says nothing about whether the build that just ran
 * produced anything. Naming the files this build and these platforms owe, and
 * requiring each to be present, non-empty, and written by this run, is what
 * tells a build from a leftover.
 *
 * A `standard` build's names carry its build identity — the build sequence and
 * the first twelve characters of the source revision — because one upstream
 * version now ships several builds whose bytes differ, and the names are what
 * keeps them apart in one feed directory. A `bridge` build keeps the
 * version-only names: it is published through the old feed, where a client that
 * predates this protocol is already looking for exactly those names. The
 * naming functions read the kind from the identity instead of guessing it from
 * a version string.
 *
 * The names are the names electron-builder produces from the `artifactName`
 * patterns in `apps/desktop-shell/electron-builder.yml`, which
 * [[STANDARD_ARTIFACT_NAME_PATTERNS]] and [[LEGACY_ARTIFACT_NAME_PATTERNS]]
 * state exactly; a build that keeps the version-only names overrides those
 * patterns rather than relying on builder defaults.
 * `apps/desktop-shell/tests/artifact-names.spec.ts` reads that config and pins
 * both against each other.
 * @module
 */

import semver from 'semver'
import type { DesktopReleaseMetadata, ReleaseIdentity } from '../src/release-identity.ts'

/** `productName` in electron-builder.yml, which every artifact name starts from. */
const PRODUCT_NAME = 'DSH Desktop'

/** The single arch the mac targets declare; electron-builder writes it into their names because it is not x64. */
const MAC_ARCH = 'arm64'

/** Suffix electron-builder gives the block map beside each artifact. */
const BLOCKMAP_SUFFIX = '.blockmap'

/**
 * Leading characters of a source revision a standard artifact name carries.
 *
 * The full 40-character revision stays in the release manifest; the short form
 * only has to make one build readable beside another in a file list.
 */
export const SHORT_REVISION_LENGTH = 12

/**
 * Environment variable electron-builder expands the build sequence from in the
 * standard `artifactName` patterns.
 */
const BUILD_SEQUENCE_VARIABLE = 'DSH_BUILD_SEQUENCE'

/** Environment variable electron-builder expands the short source revision from. */
const SHORT_REVISION_VARIABLE = 'DSH_SHORT_REVISION'

/** The three artifact names electron-builder produces for this product's targets. */
export type ArtifactTarget =
  /** The macOS zip. */
  | 'zip'
  /** The macOS disk image. */
  | 'dmg'
  /** The Windows NSIS installer. */
  | 'nsis'

/**
 * The `artifactName` patterns `electron-builder.yml` must declare for a
 * standard build.
 *
 * Placement matters: the zip has no config section of its own in
 * electron-builder, so its pattern is `mac.artifactName`; the disk image reads
 * `dmg.artifactName`, which has to be declared too because it would otherwise
 * inherit the mac pattern and drop the zip's `-mac` distinction; the installer
 * reads `nsis.artifactName`. The builder expands the macros itself, and the two
 * `env.` macros are what carry this build's identity into the file names — a
 * build that runs without them set fails instead of writing a name that would
 * collide with an earlier build of the same version.
 */
export const STANDARD_ARTIFACT_NAME_PATTERNS: Readonly<Record<ArtifactTarget, string>> = {
  zip: '${productName}-${version}-b${env.DSH_BUILD_SEQUENCE}-${env.DSH_SHORT_REVISION}-${arch}-mac.${ext}',
  dmg: '${productName}-${version}-b${env.DSH_BUILD_SEQUENCE}-${env.DSH_SHORT_REVISION}-${arch}.${ext}',
  nsis: '${productName} Setup ${version}-b${env.DSH_BUILD_SEQUENCE}-${env.DSH_SHORT_REVISION}.${ext}',
}

/**
 * The `artifactName` patterns that produce the version-only bridge names.
 *
 * These are electron-builder's defaults for the targets this product declares,
 * written out because a config that carries the standard patterns above would
 * otherwise name a bridge build like a v2 build. A bridge build passes these
 * as command-line overrides (`-c.mac.artifactName=…`, `-c.dmg.artifactName=…`,
 * `-c.nsis.artifactName=…`) so the old feed keeps the names its clients already
 * resolve.
 */
export const LEGACY_ARTIFACT_NAME_PATTERNS: Readonly<Record<ArtifactTarget, string>> = {
  zip: '${productName}-${version}-${arch}-mac.${ext}',
  dmg: '${productName}-${version}-${arch}.${ext}',
  nsis: '${productName} Setup ${version}.${ext}',
}

/** The environment variables that make [[STANDARD_ARTIFACT_NAME_PATTERNS]] name this build. */
export const BUILDER_NAME_ENVIRONMENT_NAMES: Readonly<Record<'buildSequence' | 'shortRevision', string>> = {
  buildSequence: BUILD_SEQUENCE_VARIABLE,
  shortRevision: SHORT_REVISION_VARIABLE,
}

/**
 * The environment electron-builder expands the standard patterns from.
 *
 * Setting these before the builder runs is what makes the produced names agree
 * with [[standardArtifactNames]]; both sides take the sequence and the short
 * revision from the same identity.
 * @param identity - the build being packaged.
 * @returns one value per variable in [[BUILDER_NAME_ENVIRONMENT_NAMES]].
 */
export function builderNameEnvironment(identity: ReleaseIdentity): Readonly<Record<string, string>> {
  return {
    [BUILD_SEQUENCE_VARIABLE]: String(identity.dshRelease.buildSequence),
    [SHORT_REVISION_VARIABLE]: shortRevision(identity.dshRelease.revision),
  }
}

/**
 * The build identity a standard build names its artifacts from.
 *
 * The `kind` discriminator is part of the type: a bridge identity cannot be
 * passed to [[standardArtifactNames]], so the two naming protocols cannot be
 * mixed up at a typed call site.
 */
export type StandardReleaseIdentity = ReleaseIdentity & {
  readonly dshRelease: DesktopReleaseMetadata & { readonly kind: 'standard' }
}

/** The platforms one packaging run was asked to build. */
export interface PlatformSelection {
  /** The macOS zip and dmg. */
  mac: boolean
  /** The Windows NSIS installer. */
  win: boolean
}

/** One expected artifact and what the filesystem holds for it. */
export interface ArtifactSize {
  /** The file name inside `dist-app`. */
  name: string
  /** Its size in bytes. */
  bytes: number
}

/** What `dist-app` holds for one expected name. */
export interface ArtifactFile {
  /** Size in bytes. */
  bytes: number
  /** Last-modified time in epoch milliseconds. */
  mtimeMs: number
}

/** Every expected artifact, sorted by what `dist-app` holds for it. */
export interface ArtifactAudit {
  /** Files this run wrote, with content. */
  verified: ArtifactSize[]
  /** Files the build owed and did not produce. */
  missing: string[]
  /** Files that are there at zero bytes, which is a build that wrote a stub or died mid-write. */
  empty: string[]
  /** Files left by an earlier run of the same build, which this run did not rebuild. */
  stale: string[]
}

/** One expected file whose bytes do not carry the digest the manifest recorded. */
export interface ArtifactDigestMismatch {
  /** The artifact whose digest disagrees. */
  readonly fileName: string
  /** The digest the release manifest states. */
  readonly expectedSha512: string
  /** The digest computed from the bytes on disk, or undefined when the file is absent. */
  readonly actualSha512: string | undefined
}

/** One file name shape this product's packaging produces. */
interface ArtifactForm {
  /** What precedes the identity token. */
  readonly prefix: string
  /** What follows it, before any `.blockmap` suffix. */
  readonly suffix: string
}

/**
 * The three artifact names this product's targets produce, split around the
 * identity token. The macOS zip is the only name that repeats the platform, and
 * only NSIS's default name omits the arch, so each platform contributes its own
 * form rather than one shared pattern.
 */
const ARTIFACT_FORMS: readonly ArtifactForm[] = [
  { prefix: `${PRODUCT_NAME}-`, suffix: `-${MAC_ARCH}-mac.zip` },
  { prefix: `${PRODUCT_NAME}-`, suffix: `-${MAC_ARCH}.dmg` },
  { prefix: `${PRODUCT_NAME} Setup `, suffix: '.exe' },
]

/** The identity token of a standard build's names: version, sequence, short revision. */
const STANDARD_TOKEN_PATTERN = /^(?<version>.+)-b(?<sequence>[1-9]\d*)-(?<revision>[0-9a-f]{12})$/u

/**
 * The part of a source revision a standard artifact name carries.
 * @param revision - the 40-character revision the build came from.
 * @returns its first [[SHORT_REVISION_LENGTH]] characters.
 */
export function shortRevision(revision: string): string {
  return revision.slice(0, SHORT_REVISION_LENGTH)
}

/**
 * Whether an identity belongs to the naming protocol that embeds the build.
 * @param identity - the build to classify.
 * @returns true for a `standard` build, false for a `bridge` one.
 */
export function isStandardIdentity(identity: ReleaseIdentity): identity is StandardReleaseIdentity {
  return identity.dshRelease.kind === 'standard'
}

/**
 * Every file name the platforms produce for one identity token.
 *
 * Each artifact is listed with its `.blockmap`, because the blockmap is what an
 * client fetches beside the artifact it downloads, and a publish refuses to
 * ship an artifact without one.
 * @param token - the version, or the version with the build identity appended.
 * @param platforms - the platforms this run built.
 * @returns every file name, artifacts before their blockmaps, per platform.
 */
function artifactNames(token: string, platforms: PlatformSelection): string[] {
  const artifacts: string[] = []
  if (platforms.mac) {
    artifacts.push(`${PRODUCT_NAME}-${token}-${MAC_ARCH}-mac.zip`, `${PRODUCT_NAME}-${token}-${MAC_ARCH}.dmg`)
  }
  if (platforms.win) artifacts.push(`${PRODUCT_NAME} Setup ${token}.exe`)
  return artifacts.flatMap(name => [name, `${name}${BLOCKMAP_SUFFIX}`])
}

/**
 * The files a standard build owes, named with the sequence and short revision.
 *
 * Two builds of one upstream version must be able to sit beside each other in
 * one feed directory, so the version alone cannot name them: this is the
 * naming the v2 feed serves.
 * @param identity - the standard build the run produced.
 * @param platforms - the platforms this run built.
 * @returns every file name the run must have left in `dist-app`.
 */
export function standardArtifactNames(identity: StandardReleaseIdentity, platforms: PlatformSelection): string[] {
  const { buildSequence, revision } = identity.dshRelease
  return artifactNames(`${identity.version}-b${String(buildSequence)}-${shortRevision(revision)}`, platforms)
}

/**
 * The files a bridge build owes, named by version alone.
 *
 * These are the names the old feed has always served. They are kept for the one
 * build that carries a client across protocols, and only for it: a client that
 * predates this protocol resolves those names already.
 * @param version - the bridge build's application version.
 * @param platforms - the platforms this run built.
 * @returns every file name the run must have left in `dist-app`.
 */
export function bridgeArtifactNames(version: string, platforms: PlatformSelection): string[] {
  return artifactNames(version, platforms)
}

/**
 * The files a packaging run owes for the platforms it built.
 *
 * The identity's `kind` decides the naming protocol; a standard build's
 * sequence and revision are part of its names, a bridge build's are not.
 * @param identity - the build this run produced.
 * @param platforms - the platforms this run built.
 * @returns every file name the run must have left in `dist-app`.
 */
export function expectedArtifacts(identity: ReleaseIdentity, platforms: PlatformSelection): string[] {
  return isStandardIdentity(identity)
    ? standardArtifactNames(identity, platforms)
    : bridgeArtifactNames(identity.version, platforms)
}

/** One artifact name of this product, read back. */
export interface ParsedArtifactName {
  /** The name the caller read. */
  readonly fileName: string
  /** The application version the name carries. */
  readonly version: string
  /** The build sequence a standard name carries, absent from a bridge name. */
  readonly buildSequence: number | undefined
  /** The short source revision a standard name carries, absent from a bridge name. */
  readonly shortRevision: string | undefined
  /** Whether the name is the `.blockmap` beside an artifact rather than the artifact. */
  readonly blockmap: boolean
}

/**
 * Read one produced file name back into the build it belongs to.
 *
 * Recognition is by the three shapes this product produces; anything else is
 * not an artifact of this product and the caller leaves it alone. The standard
 * shape is tried first because it is the more specific one: it requires a
 * sequence and a short revision, so a plain version cannot match it.
 * @param fileName - the file name to read, with or without `.blockmap`.
 * @returns the version, the build identity when the name carries one, and
 * whether this is a blockmap; undefined when the name is not one of these forms.
 */
export function parseArtifactName(fileName: string): ParsedArtifactName | undefined {
  const blockmap = fileName.endsWith(BLOCKMAP_SUFFIX)
  const artifact = blockmap ? fileName.slice(0, fileName.length - BLOCKMAP_SUFFIX.length) : fileName
  const token = tokenOf(artifact)
  if (token === undefined) return undefined
  const standard = STANDARD_TOKEN_PATTERN.exec(token)
  if (standard !== null) {
    const version = standard.groups?.version
    const sequence = standard.groups?.sequence
    const revision = standard.groups?.revision
    if (version === undefined || sequence === undefined || revision === undefined) return undefined
    if (semver.valid(version) === null) return undefined
    return { fileName, version, buildSequence: Number.parseInt(sequence, 10), shortRevision: revision, blockmap }
  }
  if (semver.valid(token) === null) return undefined
  return { fileName, version: token, buildSequence: undefined, shortRevision: undefined, blockmap }
}

/**
 * Cut the identity token out of one produced artifact name.
 * @param artifact - the name of the artifact, without any `.blockmap` suffix.
 * @returns the piece between the product name and the target suffix, or
 * undefined when the name fits none of the three forms.
 */
function tokenOf(artifact: string): string | undefined {
  for (const { prefix, suffix } of ARTIFACT_FORMS) {
    if (!artifact.startsWith(prefix) || !artifact.endsWith(suffix)) continue
    if (artifact.length <= prefix.length + suffix.length) continue
    return artifact.slice(prefix.length, artifact.length - suffix.length)
  }
  return undefined
}

/**
 * Sort the expected files by what the build directory holds for each.
 *
 * Presence is not enough. A build is repackaged after a fix often enough that
 * the directory usually already holds this build's files from an earlier run,
 * so a platform this run did not build leaves last run's artifact sitting under
 * exactly the name that is expected. Anything older than the run that is
 * checking it was written by something else and is reported, not accepted.
 * @param expected - the names [[expectedArtifacts]] produced.
 * @param files - size and modification time per name, absent for a name the directory does not hold.
 * @param startedAt - epoch milliseconds at which this packaging run began.
 * @returns each expected name in exactly one of the four groups.
 */
export function auditArtifacts(expected: string[], files: ReadonlyMap<string, ArtifactFile>, startedAt: number): ArtifactAudit {
  const audit: ArtifactAudit = { verified: [], missing: [], empty: [], stale: [] }
  for (const name of expected) {
    const file = files.get(name)
    if (file === undefined) audit.missing.push(name)
    else if (file.bytes === 0) audit.empty.push(name)
    else if (file.mtimeMs < startedAt) audit.stale.push(name)
    else audit.verified.push({ name, bytes: file.bytes })
  }
  return audit
}

/**
 * Check every manifest digest against the bytes their files actually carry.
 *
 * The mtime-and-size audit above cannot tell a rebuild from a leftover that has
 * the right size by accident, and a release manifest states one SHA-512 per
 * artifact precisely so a later run can tell. This comparison is what
 * `package.ts` runs over the files it just built and what a republish checks
 * before re-uploading, so a mismatch is found before a feed points at bytes
 * nobody verified.
 * @param expected - digest per file name, as the release manifest states it.
 * @param actual - digest per file name computed from the bytes on disk; a name
 * missing from this map is a file that is not there.
 * @returns one entry per expected name whose digest differs or that is absent;
 * an empty list means every listed file matches.
 */
export function verifyArtifactDigests(
  expected: ReadonlyMap<string, string>,
  actual: ReadonlyMap<string, string>,
): ArtifactDigestMismatch[] {
  const mismatches: ArtifactDigestMismatch[] = []
  for (const [fileName, expectedSha512] of expected) {
    const actualSha512 = actual.get(fileName)
    if (actualSha512 !== expectedSha512) mismatches.push({ fileName, expectedSha512, actualSha512 })
  }
  return mismatches
}
