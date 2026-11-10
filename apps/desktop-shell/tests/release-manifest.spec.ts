/**
 * The release manifest: one build's version, its embedded identity, and every
 * artifact it produced, each with the digest and size a download is verified
 * against.
 *
 * Every value here arrives from a file, so each refusal is a case the publisher
 * must not paper over: a manifest that describes bytes nobody built, names a
 * target this product cannot install, or lists one feed entry twice would make
 * the publish point clients at the wrong file. The tests therefore pin the
 * stable error `code` and the `subject`, never the message text.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  ReleaseManifestError,
  parseReleaseManifest,
  parseReleaseBuildInput,
  releaseManifestArtifacts,
  releaseManifestIdentity,
} from '../scripts/release-manifest.ts'
import { ReleaseIdentityError, releaseKey } from '../src/release-identity.ts'

const VERSION = '0.2.2-rc.1'
const BRIDGE_VERSION = '0.2.2-rc.4'
const REVISION = '0123456789abcdef0123456789abcdef01234567'
const SHA512 = `${'A'.repeat(86)}==`
const OTHER_SHA512 = `${'B'.repeat(86)}==`
const SHORT = REVISION.slice(0, 12)

/** The darwin artifact names of the build under test. */
const DARWIN_NAMES = [
  `DSH Desktop-${VERSION}-b101-${SHORT}-arm64-mac.zip`,
  `DSH Desktop-${VERSION}-b101-${SHORT}-arm64-mac.zip.blockmap`,
  `DSH Desktop-${VERSION}-b101-${SHORT}-arm64.dmg`,
  `DSH Desktop-${VERSION}-b101-${SHORT}-arm64.dmg.blockmap`,
]

/** The win32 artifact names of the build under test. */
const WIN32_NAMES = [
  `DSH Desktop Setup ${VERSION}-b101-${SHORT}.exe`,
  `DSH Desktop Setup ${VERSION}-b101-${SHORT}.exe.blockmap`,
]

/**
 * One artifact entry.
 * @param fileName - the artifact's bare file name.
 * @param overrides - fields to replace.
 * @returns the manifest entry.
 */
function artifact(fileName: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { fileName, sha512: SHA512, size: 123_456_789, ...overrides }
}

/**
 * The `dshRelease` object of a standard build.
 * @param overrides - fields to replace.
 * @returns the metadata.
 */
function standardMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 2, runtimeVersion: VERSION, buildSequence: 101, revision: REVISION, kind: 'standard', ...overrides }
}

/**
 * The `dshRelease` object of a bridge build: its runtime stays where upstream left it.
 * @param overrides - fields to replace.
 * @returns the metadata.
 */
function bridgeMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { schemaVersion: 2, runtimeVersion: VERSION, buildSequence: 100, revision: REVISION, kind: 'bridge', ...overrides }
}

/**
 * One platform entry.
 * @param arch - the architecture.
 * @param artifacts - the platform's artifact entries.
 * @returns the platform entry.
 */
function platform(arch: string, artifacts: unknown[]): Record<string, unknown> {
  return { arch, artifacts }
}

/**
 * Both platform entries with the standard artifact set.
 * @returns the platform map.
 */
function defaultPlatforms(): Record<string, unknown> {
  return {
    darwin: platform('arm64', DARWIN_NAMES.map(fileName => artifact(fileName))),
    win32: platform('x64', WIN32_NAMES.map(fileName => artifact(fileName))),
  }
}

/**
 * One standard build's manifest.
 * @param overrides - top-level fields to replace.
 * @returns the manifest value.
 */
function standardManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { version: VERSION, dshRelease: standardMetadata(), platforms: defaultPlatforms(), ...overrides }
}

/**
 * One manifest whose platform map is built from the given parts.
 * @param platforms - the platform map.
 * @param dshRelease - the identity metadata.
 * @param version - the application version.
 * @returns the manifest value.
 */
function manifestWith(
  platforms: Record<string, unknown>,
  dshRelease: Record<string, unknown> = standardMetadata(),
  version = VERSION,
): Record<string, unknown> {
  return { version, dshRelease, platforms }
}

/** One refusal this module or the identity module raised. */
interface Refusal {
  readonly name: string
  readonly code: string
  readonly subject: string
}

/**
 * Parse a manifest that must be refused, and return how.
 * @param action - the parse to run.
 * @returns the refusal's name, code, and subject.
 */
function refusal(action: () => unknown): Refusal {
  try {
    action()
  } catch (error) {
    if (error instanceof ReleaseManifestError || error instanceof ReleaseIdentityError) {
      return { name: error.name, code: error.code, subject: error.subject }
    }
    throw error
  }
  throw new Error('the manifest was accepted')
}

/**
 * The darwin platform of the default set with one field replaced.
 * @param artifacts - the replacement artifact entries.
 * @returns both platform entries.
 */
function darwinWith(artifacts: unknown[]): Record<string, unknown> {
  return { darwin: platform('arm64', artifacts), win32: platform('x64', WIN32_NAMES.map(fileName => artifact(fileName))) }
}

describe('parseReleaseManifest', () => {
  it('accepts a standard build and returns every artifact it lists', () => {
    const manifest = parseReleaseManifest(standardManifest())
    expect(manifest.version).toBe(VERSION)
    expect(manifest.dshRelease).toEqual(standardMetadata())
    expect(manifest.platforms.darwin.arch).toBe('arm64')
    expect(manifest.platforms.darwin.artifacts.map(entry => entry.fileName)).toEqual(DARWIN_NAMES)
    expect(manifest.platforms.win32.arch).toBe('x64')
    expect(manifest.platforms.win32.artifacts.map(entry => entry.fileName)).toEqual(WIN32_NAMES)
    expect(manifest.platforms.darwin.artifacts[0]?.sha512).toBe(SHA512)
    expect(manifest.platforms.darwin.artifacts[0]?.size).toBe(123_456_789)
  })

  it('accepts a bridge build whose application version is not its runtime version', () => {
    // Changing the application version while leaving the runtime where
    // upstream put it is exactly what the bridge build is for, so only a
    // standard build has to keep the two equal.
    const manifest = parseReleaseManifest(
      manifestWith({
        darwin: platform('arm64', DARWIN_NAMES.map(name => artifact(name.replace(VERSION, BRIDGE_VERSION).replace(`-b101-${SHORT}`, '')))),
        win32: platform('x64', WIN32_NAMES.map(name => artifact(name.replace(VERSION, BRIDGE_VERSION).replace(`-b101-${SHORT}`, '')))),
      }, bridgeMetadata(), BRIDGE_VERSION),
    )
    expect(manifest.version).toBe(BRIDGE_VERSION)
    expect(manifest.dshRelease.runtimeVersion).toBe(VERSION)
    expect(manifest.dshRelease.kind).toBe('bridge')
  })

  it('refuses a standard build whose two versions disagree', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(defaultPlatforms(), standardMetadata({ runtimeVersion: '0.1.0-rc.20' })),
    ))
    expect(error.name).toBe('ReleaseIdentityError')
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease.runtimeVersion')
  })

  it('refuses a manifest with no identity at all', () => {
    const manifest = standardManifest()
    delete manifest.dshRelease
    const error = refusal(() => parseReleaseManifest(manifest))
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease')
  })

  it('refuses an unknown schema version', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(defaultPlatforms(), standardMetadata({ schemaVersion: 3 })),
    ))
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease.schemaVersion')
  })

  it.each([
    ['a short revision', '0123456789abcdef0123456789abcdef0123456'],
    ['an uppercase revision', '0123456789ABCDEF0123456789ABCDEF01234567'],
    ['a revision that is not hexadecimal', 'z123456789abcdef0123456789abcdef01234567'],
    ['a numeric revision', 42],
    ['no revision', undefined],
  ])('refuses %s', (_label, revision) => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(defaultPlatforms(), standardMetadata({ revision })),
    ))
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease.revision')
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '101'],
  ])('refuses a build sequence that is %s', (_label, buildSequence) => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(defaultPlatforms(), standardMetadata({ buildSequence })),
    ))
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease.buildSequence')
  })

  it('refuses an unknown build kind', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(defaultPlatforms(), standardMetadata({ kind: 'nightly' })),
    ))
    expect(error.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(error.subject).toBe('dshRelease.kind')
  })

  it.each([
    ['too short', `${'A'.repeat(85)}==`],
    ['missing the base64 padding', 'A'.repeat(86)],
    ['base64url rather than base64', `${'-'.repeat(86)}==`],
    ['too long', `${'A'.repeat(87)}=`],
    ['not a string', 7],
  ])('refuses a SHA-512 that is %s', (_label, sha512) => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(darwinWith(DARWIN_NAMES.map(fileName => artifact(fileName, { sha512 })))),
    ))
    expect(error.name).toBe('ReleaseManifestError')
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.darwin.artifacts[0].sha512')
  })

  it.each([
    ['zero', 0],
    ['negative', -3],
    ['fractional', 10.5],
    ['past the safe integer range', Number.MAX_SAFE_INTEGER + 1],
    ['a string', '1024'],
  ])('refuses a size that is %s', (_label, size) => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(darwinWith(DARWIN_NAMES.map(fileName => artifact(fileName, { size })))),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.darwin.artifacts[0].size')
  })

  it.each([
    ['a POSIX path separator', 'nested/DSH Desktop.zip'],
    ['a Windows path separator', 'nested\\DSH Desktop.zip'],
    ['an empty name', ''],
    ['the parent directory', '..'],
    ['a name that is not a string', 12],
  ])('refuses a file name carrying %s', (_label, fileName) => {
    // The manifest describes entries of one feed directory, so a name with a
    // directory part would let a publish write outside the channel it serves.
    const error = refusal(() => parseReleaseManifest(
      manifestWith(darwinWith(DARWIN_NAMES.map(name => artifact(name, { fileName })))),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.darwin.artifacts[0].fileName')
  })

  it('refuses one file name listed twice across platforms', () => {
    // One feed directory cannot hold two different files under one name; the
    // digest of whichever was uploaded last would silently win.
    const platforms = defaultPlatforms()
    const duplicate = artifact(DARWIN_NAMES[0] ?? '')
    const error = refusal(() => parseReleaseManifest(
      manifestWith({ ...platforms, win32: platform('x64', [duplicate]) }),
    ))
    expect(error.name).toBe('ReleaseManifestError')
    expect(error.code).toBe('RELEASE_MANIFEST_CONFLICT')
    expect(error.subject).toBe('platforms.win32.artifacts[].fileName')
  })

  it('refuses one file name listed twice within a platform', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(darwinWith([artifact(DARWIN_NAMES[0] ?? ''), artifact(DARWIN_NAMES[0] ?? '', { sha512: OTHER_SHA512 })])),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_CONFLICT')
    expect(error.subject).toBe('platforms.darwin.artifacts[].fileName')
  })

  it('refuses a platform this product does not install', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith({ ...defaultPlatforms(), linux: platform('arm64', []) }),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.linux')
  })

  it('refuses a manifest that omits a supported platform', () => {
    const platforms = defaultPlatforms()
    delete platforms.win32
    const error = refusal(() => parseReleaseManifest(manifestWith(platforms)))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.win32')
  })

  it('refuses an arch this product does not build for that platform', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith({ ...defaultPlatforms(), darwin: platform('x64', DARWIN_NAMES.map(fileName => artifact(fileName))) }),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.darwin.arch')
  })

  it('refuses a platform whose artifacts are not a list', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith({ ...defaultPlatforms(), darwin: platform('arm64', [artifact(DARWIN_NAMES[0] ?? '')]), win32: { arch: 'x64', artifacts: 'none' } }),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.win32.artifacts')
  })

  it('refuses an artifact entry that is not an object', () => {
    const error = refusal(() => parseReleaseManifest(
      manifestWith(darwinWith(['not an artifact'])),
    ))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('platforms.darwin.artifacts[0]')
  })

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'manifest'],
  ])('refuses a manifest that is %s', (_label, value) => {
    const error = refusal(() => parseReleaseManifest(value))
    expect(error.code).toBe('RELEASE_MANIFEST_INVALID')
    expect(error.subject).toBe('manifest')
  })

  it('accepts a platform this run did not build as an empty artifact list', () => {
    // A packaging run builds one platform on one machine; the manifest still
    // has to describe both, and an empty list is how it says "not built here".
    const manifest = parseReleaseManifest(manifestWith({
      darwin: platform('arm64', DARWIN_NAMES.map(fileName => artifact(fileName))),
      win32: platform('x64', []),
    }))
    expect(manifest.platforms.win32.artifacts).toEqual([])
    expect(releaseManifestArtifacts(manifest).map(entry => entry.fileName)).toEqual(DARWIN_NAMES)
  })
})

describe('build input and completed inventory', () => {
  it('accepts build identity and targets before final hashes exist', () => {
    expect(parseReleaseBuildInput({ version: BRIDGE_VERSION, dshRelease: bridgeMetadata(), platforms: ['win32', 'darwin'] })).toEqual({
      version: BRIDGE_VERSION, dshRelease: bridgeMetadata(), platforms: ['win32', 'darwin'],
    })
  })

  it.each([[], ['darwin', 'darwin'], ['linux'], undefined, {}].map(platforms => ({ platforms })))('rejects invalid build targets $platforms', ({ platforms }) => {
    expect(() => parseReleaseBuildInput({ version: VERSION, dshRelease: standardMetadata(), platforms })).toThrow(ReleaseManifestError)
  })

  it('does not accept build input as a final publish manifest', () => {
    expect(() => parseReleaseManifest({ version: VERSION, dshRelease: standardMetadata(), platforms: ['darwin'] })).toThrow(ReleaseManifestError)
  })

  it.each([
    DARWIN_NAMES.slice(1),
    [...DARWIN_NAMES, DARWIN_NAMES[0]!.replace('b101-', 'b100-')],
    DARWIN_NAMES.map(name => name.replace('b101-', 'b100-')),
  ].map(names => ({ names })))('rejects incomplete or mixed artifacts $names', ({ names }) => {
    const manifest = standardManifest({ platforms: darwinWith(names.map(name => artifact(name))) })
    expect(() => parseReleaseManifest(manifest)).toThrow(ReleaseManifestError)
  })

  it('rejects an inventory without any completed platform', () => {
    expect(() => parseReleaseManifest(standardManifest({ platforms: {
      darwin: platform('arm64', []), win32: platform('x64', []),
    } }))).toThrow(ReleaseManifestError)
  })
})

describe('releaseManifestArtifacts', () => {
  it('lists every artifact of both platforms in a stable order', () => {
    expect(releaseManifestArtifacts(parseReleaseManifest(standardManifest())).map(entry => entry.fileName)).toEqual([
      ...DARWIN_NAMES,
      ...WIN32_NAMES,
    ])
  })
})

describe('releaseManifestIdentity', () => {
  it('returns the identity the identity module compares and keys', () => {
    const identity = releaseManifestIdentity(parseReleaseManifest(standardManifest()))
    expect(identity.version).toBe(VERSION)
    expect(identity.dshRelease.kind).toBe('standard')
    // The manifest repeats the identity the package embeds, so the same build
    // read from either file must produce one key.
    expect(releaseKey(identity)).toBe(releaseKey({
      version: VERSION,
      dshRelease: {
        schemaVersion: 2,
        runtimeVersion: VERSION,
        buildSequence: 101,
        revision: REVISION,
        kind: 'standard',
      },
    }))
  })
})
