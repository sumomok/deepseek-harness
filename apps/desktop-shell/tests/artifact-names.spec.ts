/**
 * What a packaging run owes the build directory, what checking that directory
 * reports, what the produced names read back as, and whether the bytes match
 * the digests a release manifest states.
 *
 * The expected names follow from `apps/desktop-shell/electron-builder.yml`, so
 * this reads that config and pins the two against each other rather than
 * against a memory of them. Reading it is also what lets the installed
 * application's name be pinned against `PINNED_APP_NAME` here, so neither half
 * of that pair can be removed on its own.
 *
 * The reminders this file encodes about naming: one upstream version now ships
 * several builds whose bytes differ, so a standard build's names carry its
 * build sequence and short revision, while a bridge build keeps the
 * version-only names the old feed's clients already resolve.
 * @module
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CORE_SCHEMA, load } from 'js-yaml'
import { describe, expect, it } from 'vitest'
import {
  BUILDER_NAME_ENVIRONMENT_NAMES,
  LEGACY_ARTIFACT_NAME_PATTERNS,
  SHORT_REVISION_LENGTH,
  STANDARD_ARTIFACT_NAME_PATTERNS,
  auditArtifacts,
  bridgeArtifactNames,
  builderNameEnvironment,
  expectedArtifacts,
  parseArtifactName,
  shortRevision,
  standardArtifactNames,
  verifyArtifactDigests,
  type ArtifactFile,
  type ArtifactTarget,
  type StandardReleaseIdentity,
} from '../scripts/artifact-names.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'
import { PINNED_APP_NAME } from '../src/app-identity.ts'

/** The parts of electron-builder.yml the artifact names follow from. */
interface BuilderConfig {
  productName: string
  extraMetadata: { name: string }
  artifactName?: string
  mac: { artifactName?: string; target: { target: string; arch: string[] }[] }
  win: { artifactName?: string; target: { target: string; arch: string[] }[] }
  dmg?: { artifactName?: string }
  nsis: { artifactName?: string }
}

const config = load(
  readFileSync(fileURLToPath(new URL('../electron-builder.yml', import.meta.url)), 'utf8'),
  { schema: CORE_SCHEMA },
) as BuilderConfig

const VERSION = '0.2.2-rc.1'
const SEQUENCE = 101
const REVISION = '0123456789abcdef0123456789abcdef01234567'
const SHORT = REVISION.slice(0, SHORT_REVISION_LENGTH)

/** The targets whose `artifactName` electron-builder reads. */
const TARGETS: readonly ArtifactTarget[] = ['zip', 'dmg', 'nsis']

/** The extension each target's artifact carries. */
const EXTENSION: Readonly<Record<ArtifactTarget, string>> = { zip: 'zip', dmg: 'dmg', nsis: 'exe' }

/** The single arch each target declares in electron-builder.yml. */
const ARCH: Readonly<Record<ArtifactTarget, string>> = { zip: 'arm64', dmg: 'arm64', nsis: 'x64' }

/**
 * electron-builder's own default patterns for the targets this config declares,
 * written out so a config without `artifactName` can still be expanded. They
 * are the bridge names: the arch is part of both mac defaults because the
 * declared arch is not x64, and NSIS appends no arch suffix for x64.
 */
const BUILDER_DEFAULTS: Readonly<Record<ArtifactTarget, string>> = {
  zip: '${productName}-${version}-${arch}-mac.${ext}',
  dmg: '${productName}-${version}-${arch}.${ext}',
  nsis: '${productName} Setup ${version}.${ext}',
}

/**
 * One standard build's identity.
 * @param overrides - fields to replace.
 * @returns the identity.
 */
function standardIdentity(overrides: { version?: string } = {}): StandardReleaseIdentity {
  const version = overrides.version ?? VERSION
  return {
    version,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: version,
      buildSequence: SEQUENCE,
      revision: REVISION,
      kind: 'standard',
    },
  }
}

/**
 * One bridge build's identity: its application version may trail the runtime.
 * @param version - the application version.
 * @returns the identity.
 */
function bridgeIdentity(version = VERSION): ReleaseIdentity {
  return {
    version,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: VERSION,
      buildSequence: SEQUENCE,
      revision: REVISION,
      kind: 'bridge',
    },
  }
}

/**
 * The `artifactName` electron-builder would use for one target, following
 * `artifactPatternConfig`: the target's own section first, then the platform
 * section, then the top level.
 *
 * The zip has no config section of its own — electron-builder reads the mac
 * section for it — so `mac.artifactName` is the zip pattern, and the disk image
 * overrides it from the `dmg` section.
 * @param target - the target to resolve.
 * @returns the pattern, or undefined when the config sets none.
 */
function configuredPattern(target: ArtifactTarget): string | undefined {
  switch (target) {
    case 'zip':
      return config.mac.artifactName ?? config.artifactName
    case 'dmg':
      return config.dmg?.artifactName ?? config.mac.artifactName ?? config.artifactName
    case 'nsis':
      return config.nsis.artifactName ?? config.win.artifactName ?? config.artifactName
  }
}

/**
 * Expand the macros electron-builder expands for one target of this build.
 * @param pattern - the `artifactName` pattern.
 * @param target - the target the pattern belongs to.
 * @returns the produced file name.
 */
function expand(pattern: string, target: ArtifactTarget): string {
  return pattern.replace(/\$\{([_a-zA-Z./*+]+)\}/gu, (macro: string, name: string) => {
    switch (name) {
      case 'productName':
        return config.productName
      case 'version':
        return VERSION
      case 'arch':
        return ARCH[target]
      case 'ext':
        return EXTENSION[target]
      case 'env.DSH_BUILD_SEQUENCE':
        return String(SEQUENCE)
      case 'env.DSH_SHORT_REVISION':
        return SHORT
      default:
        throw new Error(`unexpected macro ${macro} in ${pattern}`)
    }
  })
}

describe('the installed application name', () => {
  it('is the name both halves of the pin declare', () => {
    // The packaged half is this field; the source-tree half is
    // PINNED_APP_NAME. They name the same per-user directories, so removing
    // either one alone has to fail here rather than at a user's next update.
    expect(config.extraMetadata.name).toBe(PINNED_APP_NAME)
  })
})

describe('expectedArtifacts', () => {
  it('names a standard build with its sequence and short revision', () => {
    expect(standardArtifactNames(standardIdentity(), { mac: true, win: false })).toEqual([
      `DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64-mac.zip`,
      `DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64-mac.zip.blockmap`,
      `DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64.dmg`,
      `DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64.dmg.blockmap`,
    ])
    expect(standardArtifactNames(standardIdentity(), { mac: false, win: true })).toEqual([
      `DSH Desktop Setup ${VERSION}-b${String(SEQUENCE)}-${SHORT}.exe`,
      `DSH Desktop Setup ${VERSION}-b${String(SEQUENCE)}-${SHORT}.exe.blockmap`,
    ])
  })

  it('keeps the version-only names for a bridge build, because the old feed already serves them', () => {
    expect(bridgeArtifactNames(VERSION, { mac: true, win: false })).toEqual([
      `DSH Desktop-${VERSION}-arm64-mac.zip`,
      `DSH Desktop-${VERSION}-arm64-mac.zip.blockmap`,
      `DSH Desktop-${VERSION}-arm64.dmg`,
      `DSH Desktop-${VERSION}-arm64.dmg.blockmap`,
    ])
    expect(bridgeArtifactNames(VERSION, { mac: false, win: true })).toEqual([
      `DSH Desktop Setup ${VERSION}.exe`,
      `DSH Desktop Setup ${VERSION}.exe.blockmap`,
    ])
  })

  it('follows the identity\'s kind instead of guessing from the version', () => {
    // The same version under the two kinds names different files. Only the
    // declared kind decides which protocol a build belongs to.
    expect(expectedArtifacts(standardIdentity(), { mac: true, win: false })).toEqual(
      standardArtifactNames(standardIdentity(), { mac: true, win: false }),
    )
    expect(expectedArtifacts(bridgeIdentity(), { mac: true, win: false })).toEqual(
      bridgeArtifactNames(VERSION, { mac: true, win: false }),
    )
  })

  it('owes both platforms\' files when both were built', () => {
    const identity = standardIdentity()
    expect(expectedArtifacts(identity, { mac: true, win: true })).toEqual([
      ...expectedArtifacts(identity, { mac: true, win: false }),
      ...expectedArtifacts(identity, { mac: false, win: true }),
    ])
  })

  it('owes nothing when no platform was built', () => {
    expect(expectedArtifacts(standardIdentity(), { mac: false, win: false })).toEqual([])
  })

  it('shortens a revision to the length the names carry', () => {
    expect(shortRevision(REVISION)).toBe(SHORT)
    expect(shortRevision(REVISION)).toHaveLength(SHORT_REVISION_LENGTH)
  })
})

describe('the builder artifactName contract', () => {
  it('declares a pattern for every target or for none, never a mixture', () => {
    // A mixture would name one target per protocol: the configured target
    // would carry the build identity and the other would not, so the two files
    // of one build would disagree about which build they belong to.
    const declared = TARGETS.filter(target => configuredPattern(target) !== undefined)
    expect(declared.length === 0 || declared.length === TARGETS.length).toBe(true)
  })

  it('keeps electron-builder and this module on one naming rule', () => {
    const declared = TARGETS.filter(target => configuredPattern(target) !== undefined)
    const macArtifacts = standardArtifactNames(standardIdentity(), { mac: true, win: true })
      .filter(name => !name.endsWith('.blockmap'))
    const expected: Record<ArtifactTarget, string | undefined> = {
      zip: macArtifacts.find(name => name.endsWith('-mac.zip')),
      dmg: macArtifacts.find(name => name.endsWith('.dmg')),
      nsis: macArtifacts.find(name => name.endsWith('.exe')),
    }
    for (const target of TARGETS) {
      const configured = configuredPattern(target)
      if (declared.length === 0) {
        // The config still relies on builder defaults, which name the bridge
        // files; the standard names are then unreachable from the config, and
        // the legacy patterns are exactly those defaults.
        expect(LEGACY_ARTIFACT_NAME_PATTERNS[target]).toBe(BUILDER_DEFAULTS[target])
        expect(expand(BUILDER_DEFAULTS[target], target)).toBe(expand(LEGACY_ARTIFACT_NAME_PATTERNS[target], target))
        continue
      }
      expect(configured).toBe(STANDARD_ARTIFACT_NAME_PATTERNS[target])
      expect(expand(STANDARD_ARTIFACT_NAME_PATTERNS[target], target)).toBe(expected[target])
    }
  })

  it('carries the productName and the single arch each target declares', () => {
    // The arch is in the mac names because it is not x64; NSIS's name carries
    // none, which is why only the mac side asserts one.
    expect(config.mac.target.map(target => target.arch)).toEqual([['arm64'], ['arm64']])
    expect(config.win.target.map(target => target.arch)).toEqual([['x64']])
    for (const name of expectedArtifacts(standardIdentity(), { mac: true, win: false })) {
      expect(name.startsWith(config.productName)).toBe(true)
      expect(name).toContain('-arm64')
    }
  })
})

describe('builderNameEnvironment', () => {
  it('supplies the two values the standard patterns expand', () => {
    // The builder expands these itself, so the environment and the names this
    // module expects have to come from the same identity.
    expect(builderNameEnvironment(standardIdentity())).toEqual({
      [BUILDER_NAME_ENVIRONMENT_NAMES.buildSequence]: String(SEQUENCE),
      [BUILDER_NAME_ENVIRONMENT_NAMES.shortRevision]: SHORT,
    })
  })
})

describe('parseArtifactName', () => {
  it('reads a standard name back into its build', () => {
    expect(parseArtifactName(`DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64-mac.zip`)).toEqual({
      fileName: `DSH Desktop-${VERSION}-b${String(SEQUENCE)}-${SHORT}-arm64-mac.zip`,
      version: VERSION,
      buildSequence: SEQUENCE,
      shortRevision: SHORT,
      blockmap: false,
    })
    expect(parseArtifactName(`DSH Desktop Setup ${VERSION}-b${String(SEQUENCE)}-${SHORT}.exe.blockmap`)).toEqual({
      fileName: `DSH Desktop Setup ${VERSION}-b${String(SEQUENCE)}-${SHORT}.exe.blockmap`,
      version: VERSION,
      buildSequence: SEQUENCE,
      shortRevision: SHORT,
      blockmap: true,
    })
  })

  it('reads a bridge name as having no build identity', () => {
    expect(parseArtifactName(`DSH Desktop-${VERSION}-arm64.dmg`)).toEqual({
      fileName: `DSH Desktop-${VERSION}-arm64.dmg`,
      version: VERSION,
      buildSequence: undefined,
      shortRevision: undefined,
      blockmap: false,
    })
  })

  it('reads every name either naming rule produces', () => {
    for (const name of expectedArtifacts(standardIdentity(), { mac: true, win: true })) {
      expect(parseArtifactName(name)?.buildSequence, name).toBe(SEQUENCE)
    }
    for (const name of expectedArtifacts(bridgeIdentity(), { mac: true, win: true })) {
      expect(parseArtifactName(name)?.buildSequence, name).toBeUndefined()
    }
  })

  it('leaves a name that is not one of this product\'s artifacts unrecognized', () => {
    for (const name of ['latest.yml', 'latest-mac.yml', 'notes.txt', 'DSH Desktop Setup nightly.exe', 'DSH Desktop-nightly-arm64.dmg', 'win-unpacked']) {
      expect(parseArtifactName(name), name).toBeUndefined()
    }
  })
})

describe('verifyArtifactDigests', () => {
  const GOOD = `${'A'.repeat(86)}==`
  const OTHER = `${'B'.repeat(86)}==`

  it('reports nothing when every file carries the digest the manifest states', () => {
    const expected = new Map([['a.zip', GOOD], ['a.dmg', OTHER]])
    expect(verifyArtifactDigests(expected, new Map([['a.zip', GOOD], ['a.dmg', OTHER], ['notes.txt', OTHER]]))).toEqual([])
  })

  it('reports a file whose bytes differ from its manifest digest', () => {
    const expected = new Map([['a.zip', GOOD]])
    expect(verifyArtifactDigests(expected, new Map([['a.zip', OTHER]]))).toEqual([
      { fileName: 'a.zip', expectedSha512: GOOD, actualSha512: OTHER },
    ])
  })

  it('reports a file the build did not produce as having no digest', () => {
    // A missing file is not silently equal: absence has to reach the caller,
    // which is what stops a publish from uploading a manifest for bytes nobody
    // built.
    expect(verifyArtifactDigests(new Map([['a.zip', GOOD]]), new Map())).toEqual([
      { fileName: 'a.zip', expectedSha512: GOOD, actualSha512: undefined },
    ])
  })

  it('reports one entry per disagreeing file, in manifest order', () => {
    const expected = new Map([['b.zip', GOOD], ['a.zip', GOOD], ['c.zip', GOOD]])
    expect(verifyArtifactDigests(expected, new Map([['a.zip', OTHER]])).map(entry => entry.fileName)).toEqual(['b.zip', 'a.zip', 'c.zip'])
  })
})

describe('auditArtifacts', () => {
  const expected = expectedArtifacts(standardIdentity(), { mac: true, win: true })
  const STARTED_AT = 1_000_000

  /**
   * A directory holding each named file, written after this run began.
   * @param names - the files present.
   * @param bytes - the size each one has.
   * @returns what the directory holds, for the audit.
   */
  function built(names: string[], bytes = 1024): Map<string, ArtifactFile> {
    return new Map(names.map(name => [name, { bytes, mtimeMs: STARTED_AT + 1 }]))
  }

  it('verifies every expected file when each was written by this run with content', () => {
    const audit = auditArtifacts(expected, built(expected), STARTED_AT)
    expect(audit.verified.map(entry => entry.name)).toEqual(expected)
    expect(audit.verified.every(entry => entry.bytes === 1024)).toBe(true)
    expect(audit.missing).toEqual([])
    expect(audit.empty).toEqual([])
    expect(audit.stale).toEqual([])
  })

  it('reports the platform whose build never ran, artifact and blockmap alike', () => {
    const win = expectedArtifacts(standardIdentity(), { mac: false, win: true })
    const audit = auditArtifacts(expected, built(win), STARTED_AT)
    expect(audit.missing).toEqual(expectedArtifacts(standardIdentity(), { mac: true, win: false }))
    expect(audit.verified.map(entry => entry.name)).toEqual(win)
  })

  it('reports a file that is there at zero bytes separately from a missing one', () => {
    const files = built(expected)
    files.set(expected[0] ?? '', { bytes: 0, mtimeMs: STARTED_AT + 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.empty).toEqual([expected[0]])
    expect(audit.missing).toEqual([])
    expect(audit.stale).toEqual([])
  })

  it('reports this build\'s own file from an earlier run as stale, not as a product', () => {
    // Repackaging one build after a fix: the previous run's artifacts carry
    // exactly the expected names, so only their age separates them.
    const files = built(expected)
    const leftover = expected[4] ?? ''
    files.set(leftover, { bytes: 138_000_000, mtimeMs: STARTED_AT - 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.stale).toEqual([leftover])
    expect(audit.verified.map(entry => entry.name)).not.toContain(leftover)
    expect(audit.missing).toEqual([])
  })

  it('reports a whole platform left over from an earlier run of the same build', () => {
    const mac = expectedArtifacts(standardIdentity(), { mac: true, win: false })
    const win = expectedArtifacts(standardIdentity(), { mac: false, win: true })
    const files = new Map([
      ...built(mac),
      ...new Map(win.map(name => [name, { bytes: 1024, mtimeMs: STARTED_AT - 60_000 }] as const)),
    ])
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.stale).toEqual(win)
    expect(audit.verified.map(entry => entry.name)).toEqual(mac)
  })

  it('accepts a file written exactly when the run started', () => {
    const audit = auditArtifacts(expected, new Map(expected.map(name => [name, { bytes: 1, mtimeMs: STARTED_AT }])), STARTED_AT)
    expect(audit.stale).toEqual([])
    expect(audit.verified.length).toBe(expected.length)
  })

  it('ignores whatever else the directory holds, including older builds', () => {
    const files = built(expected)
    files.set('DSH Desktop Setup 0.1.0-rc.19.exe', { bytes: 138_000_000, mtimeMs: STARTED_AT - 1 })
    const audit = auditArtifacts(expected, files, STARTED_AT)
    expect(audit.verified.map(entry => entry.name)).toEqual(expected)
    expect(audit.stale).toEqual([])
  })

  it('accounts for every expected name exactly once', () => {
    const files = new Map<string, ArtifactFile>([
      [expected[0] ?? '', { bytes: 0, mtimeMs: STARTED_AT + 1 }],
      [expected[1] ?? '', { bytes: 7, mtimeMs: STARTED_AT + 1 }],
      [expected[2] ?? '', { bytes: 7, mtimeMs: STARTED_AT - 1 }],
    ])
    const audit = auditArtifacts(expected, files, STARTED_AT)
    const accounted = [...audit.verified.map(entry => entry.name), ...audit.missing, ...audit.empty, ...audit.stale]
    expect([...accounted].sort()).toEqual([...expected].sort())
  })
})
