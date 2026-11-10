/**
 * The release identity protocol: what a build declares, which build a feed
 * offers, and which of the two is newer. Every case here is a decision the
 * updater makes before it transfers a byte, so the refusals matter as much as
 * the acceptances.
 * @module
 */

import { describe, expect, it } from 'vitest'
import {
  ReleaseIdentityError,
  decideUpdate,
  identityIfPresent,
  isBelowRedLine,
  isSameBuild,
  parseDesktopReleaseMetadata,
  parseReleaseIdentity,
  parseUpdateOffer,
  releaseKey,
  type ReleaseIdentity,
} from '../src/release-identity.ts'

const REVISION = '0123456789abcdef0123456789abcdef01234567'
const SHA512 = `${'A'.repeat(86)}==`

/**
 * One build's identity.
 * @param sequence - build sequence.
 * @param overrides - fields to replace.
 * @returns the identity.
 */
function identity(sequence: number, overrides: { version?: string; runtimeVersion?: string; revision?: string; kind?: 'bridge' | 'standard' } = {}): ReleaseIdentity {
  const version = overrides.version ?? '0.2.2-rc.1'
  return {
    version,
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: overrides.runtimeVersion ?? version,
      buildSequence: sequence,
      revision: overrides.revision ?? REVISION,
      kind: overrides.kind ?? 'standard',
    },
  }
}

/**
 * One feed manifest.
 * @param sequence - build sequence.
 * @param overrides - top-level fields to replace.
 * @returns the manifest value.
 */
function manifest(sequence: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.2.2-rc.1',
    dshRelease: {
      schemaVersion: 2,
      runtimeVersion: '0.2.2-rc.1',
      buildSequence: sequence,
      revision: REVISION,
      kind: 'standard',
    },
    files: [{ url: 'DSH Desktop-0.2.2-rc.1-b101-0123456789ab-arm64-mac.zip', sha512: SHA512, size: 1024 }],
    ...overrides,
  }
}

/**
 * Capture one refusal.
 * @param run - the call expected to refuse.
 * @returns the refusal's code and message.
 */
function refusal(run: () => unknown): { code: string; message: string } {
  try {
    run()
  } catch (error) {
    expect(error).toBeInstanceOf(ReleaseIdentityError)
    const refusal = error as ReleaseIdentityError
    return { code: refusal.code, message: refusal.message }
  }
  throw new Error('expected a refusal')
}

describe('parseReleaseIdentity', () => {
  it('reads a standard build whose versions agree', () => {
    expect(parseReleaseIdentity(manifest(101))).toEqual({
      version: '0.2.2-rc.1',
      dshRelease: { schemaVersion: 2, runtimeVersion: '0.2.2-rc.1', buildSequence: 101, revision: REVISION, kind: 'standard' },
    })
  })

  it('reads a bridge whose application version is ahead of its runtime', () => {
    const parsed = parseReleaseIdentity(manifest(100, {
      version: '0.2.2-rc.4',
      dshRelease: { schemaVersion: 2, runtimeVersion: '0.2.2-rc.1', buildSequence: 100, revision: REVISION, kind: 'bridge' },
    }))
    expect(parsed.version).toBe('0.2.2-rc.4')
    expect(parsed.dshRelease.runtimeVersion).toBe('0.2.2-rc.1')
  })

  it('refuses a standard build whose runtime disagrees with its version', () => {
    const refused = refusal(() => parseReleaseIdentity(manifest(101, {
      version: '0.2.2-rc.4',
      dshRelease: { schemaVersion: 2, runtimeVersion: '0.2.2-rc.1', buildSequence: 101, revision: REVISION, kind: 'standard' },
    })))
    expect(refused.code).toBe('RELEASE_IDENTITY_INVALID')
    expect(refused.message).toContain('must equal version')
  })

  it('refuses every field that cannot name a build', () => {
    const cases = [
      { schemaVersion: 1 },
      { schemaVersion: 2, runtimeVersion: 'rc.1' },
      { schemaVersion: 2, buildSequence: 0 },
      { schemaVersion: 2, buildSequence: 1.5 },
      { buildSequence: 2 ** 53 },
      { schemaVersion: 2, revision: 'ABC' },
      { schemaVersion: 2, revision: '0123456789ABCDEF0123456789abcdef01234567' },
      { schemaVersion: 2, kind: 'release' },
    ]
    for (const patch of cases) {
      const value = {
        version: '0.2.2-rc.1',
        dshRelease: { schemaVersion: 2, runtimeVersion: '0.2.2-rc.1', buildSequence: 101, revision: REVISION, kind: 'standard', ...patch },
      }
      expect(refusal(() => parseDesktopReleaseMetadata(value.dshRelease)).code).toBe('RELEASE_IDENTITY_INVALID')
    }
    expect(refusal(() => parseReleaseIdentity({ version: '0.2.2', dshRelease: {} })).code).toBe('RELEASE_IDENTITY_INVALID')
    expect(refusal(() => parseReleaseIdentity({ dshRelease: manifest(1).dshRelease })).code).toBe('RELEASE_IDENTITY_INVALID')
    expect(refusal(() => parseReleaseIdentity({ version: 'v0.2.2-rc.1', dshRelease: manifest(1).dshRelease })).code).toBe('RELEASE_IDENTITY_INVALID')
    expect(refusal(() => parseReleaseIdentity(undefined)).code).toBe('RELEASE_IDENTITY_INVALID')
  })
})

describe('identityIfPresent', () => {
  it('reports nothing for a build that predates this protocol', () => {
    expect(identityIfPresent({ version: '0.2.2-rc.3' })).toBeUndefined()
  })

  it('reads an identity when one is embedded, and refuses a malformed one', () => {
    expect(identityIfPresent(manifest(101))).toEqual(parseReleaseIdentity(manifest(101)))
    expect(refusal(() => identityIfPresent({ version: '0.2.2-rc.3', dshRelease: { schemaVersion: 2 } })).code).toBe('RELEASE_IDENTITY_INVALID')
  })
})

describe('parseUpdateOffer', () => {
  it('selects this platform\u2019s artifact and carries the notes', () => {
    const offer = parseUpdateOffer(
      manifest(101, {
        releaseNotes: 'fixes the thing',
        files: [
          { url: 'DSH Desktop Setup 0.2.2-rc.1.exe', sha512: SHA512, size: 2048, isAdminRightsRequired: true },
          { url: 'DSH Desktop-0.2.2-rc.1-arm64-mac.zip', sha512: SHA512, size: 1024 },
        ],
      }),
      'darwin',
      'arm64',
    )
    expect(offer.artifact).toEqual({
      fileName: 'DSH Desktop-0.2.2-rc.1-arm64-mac.zip',
      sha512: SHA512,
      size: 1024,
      isAdminRightsRequired: false,
    })
    expect(offer.releaseNotes).toBe('fixes the thing')
    expect(offer.platform).toBe('darwin')
    expect(offer.arch).toBe('arm64')
  })

  it('keeps the Windows installer\u2019s elevation flag', () => {
    const offer = parseUpdateOffer(
      manifest(101, { files: [{ url: 'DSH Desktop Setup 0.2.2-rc.1.exe', sha512: SHA512, size: 2048, isAdminRightsRequired: true }] }),
      'win32',
      'x64',
    )
    expect(offer.artifact.isAdminRightsRequired).toBe(true)
  })

  it('refuses a manifest this protocol must not deliver or cannot use', () => {
    expect(refusal(() => parseUpdateOffer(manifest(101, {
      dshRelease: { schemaVersion: 2, runtimeVersion: '0.2.2-rc.1', buildSequence: 101, revision: REVISION, kind: 'bridge' },
    }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101, { files: [] }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101), 'win32', 'x64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101, {
      files: [{ url: '../escape.zip', sha512: SHA512, size: 1024 }],
    }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101, {
      files: [{ url: 'a.zip', sha512: 'not-a-digest', size: 1024 }],
    }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101, {
      files: [{ url: 'a.zip', sha512: SHA512, size: 0 }],
    }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
  })

  it('refuses a manifest that names an entry outside this build’s feed directory', () => {
    // The library builds the URL it downloads from this list, so an entry it
    // would take must not be skipped here: the whole document is refused and
    // nothing is frozen from it.
    const attack = manifest(101, {
      files: [
        { url: 'https://other.invalid/unvalidated.zip', sha512: SHA512, size: 1024 },
        { url: 'DSH Desktop-0.2.2-rc.1-arm64-mac.zip', sha512: SHA512, size: 1024 },
      ],
    })
    const failure = refusal(() => parseUpdateOffer(attack, 'darwin', 'arm64'))
    expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
    expect(failure.message).toContain('files[0].url')
  })

  it('refuses an ambiguous feed instead of guessing which artifact the library takes', () => {
    const failure = refusal(() => parseUpdateOffer(manifest(101, {
      files: [
        { url: 'a-arm64-mac.zip', sha512: SHA512, size: 1024 },
        { url: 'b-arm64-mac.zip', sha512: SHA512, size: 2048 },
      ],
    }), 'darwin', 'arm64'))
    expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
    expect(failure.message).toContain('must name exactly one')
  })

  it('refuses an entry that percent-encodes a separator or a traversal', () => {
    for (const url of ['a%2fb.zip', 'a%5Cb.zip', '%2e%2e%2fescape.zip', 'a%00b.zip']) {
      const failure = refusal(() => parseUpdateOffer(manifest(101, {
        files: [{ url, sha512: SHA512, size: 1024 }],
      }), 'darwin', 'arm64'))
      expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
    }
  })

  it('refuses an entry that carries URL syntax instead of a file name', () => {
    for (const url of ['filename#other.zip', 'file?x=.zip', 'a:b.zip']) {
      const failure = refusal(() => parseUpdateOffer(manifest(101, {
        files: [{ url, sha512: SHA512, size: 1024 }],
      }), 'darwin', 'arm64'))
      expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
      expect(failure.message).toContain('files[0].url')
    }
  })

  it('applies the library’s architecture filter before the archive extension', () => {
    // An arm64 dmg beside an x64 zip: the library keeps only the arm64 file, so
    // there is no zip for it to download — the x64 zip is not this machine's.
    const mixed = manifest(101, {
      files: [
        { url: 'DSH Desktop-0.2.2-rc.1-arm64.dmg', sha512: SHA512, size: 4096 },
        { url: 'DSH Desktop-0.2.2-rc.1-mac.zip', sha512: SHA512, size: 1024 },
      ],
    })
    const failure = refusal(() => parseUpdateOffer(mixed, 'darwin', 'arm64'))
    expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
    expect(failure.message).toContain('no .zip artifact for darwin/arm64')
    // On x64 the same feed names the x64 zip the library would download.
    expect(parseUpdateOffer(mixed, 'darwin', 'x64').artifact.fileName).toBe('DSH Desktop-0.2.2-rc.1-mac.zip')
  })

  it('drops arm64 artifacts on an x64 host and prefers them on arm64', () => {
    const both = manifest(101, {
      files: [
        { url: 'DSH Desktop-0.2.2-rc.1-arm64-mac.zip', sha512: SHA512, size: 1024 },
        { url: 'DSH Desktop-0.2.2-rc.1-mac.zip', sha512: SHA512, size: 2048 },
      ],
    })
    expect(parseUpdateOffer(both, 'darwin', 'arm64').artifact.fileName).toBe('DSH Desktop-0.2.2-rc.1-arm64-mac.zip')
    expect(parseUpdateOffer(both, 'darwin', 'x64').artifact.fileName).toBe('DSH Desktop-0.2.2-rc.1-mac.zip')
  })

  it('refuses a Windows installer that names the other architecture', () => {
    const failure = refusal(() => parseUpdateOffer(manifest(101, {
      files: [{ url: 'DSH Desktop Setup arm64.exe', sha512: SHA512, size: 1024 }],
    }), 'win32', 'x64'))
    expect(failure.code).toBe('UPDATE_MANIFEST_INVALID')
    expect(failure.message).toContain('arm64')
  })

  it('refuses a red line that is malformed or above the offered build', () => {
    expect(refusal(() => parseUpdateOffer(manifest(101, { minimumBuildSequence: 102 }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(refusal(() => parseUpdateOffer(manifest(101, { minimumBuildSequence: 0 }), 'darwin', 'arm64')).code).toBe('UPDATE_MANIFEST_INVALID')
    expect(parseUpdateOffer(manifest(101, { minimumBuildSequence: 101 }), 'darwin', 'arm64').minimumBuildSequence).toBe(101)
  })
})

describe('decideUpdate', () => {
  it('offers a later build of the same upstream version', () => {
    expect(decideUpdate(identity(101), identity(102))).toEqual({ kind: 'available', target: identity(102) })
  })

  it('treats the same build and an older one as current', () => {
    expect(decideUpdate(identity(102), identity(102))).toEqual({ kind: 'current', why: 'same-build' })
    expect(decideUpdate(identity(102), identity(101))).toEqual({ kind: 'current', why: 'older-build' })
  })

  it('accepts the bridge migration that lowers the application version', () => {
    const bridge = identity(100, { version: '0.2.2-rc.4', runtimeVersion: '0.2.2-rc.1', kind: 'bridge' })
    expect(decideUpdate(bridge, identity(101))).toEqual({ kind: 'available', target: identity(101) })
  })

  it('accepts an upstream runtime upgrade', () => {
    expect(decideUpdate(identity(101), identity(201, { version: '0.3.0-rc.1' }))).toEqual({ kind: 'available', target: identity(201, { version: '0.3.0-rc.1' }) })
  })

  it('refuses an older runtime even under a larger sequence', () => {
    const refused = refusal(() => decideUpdate(identity(201, { version: '0.3.0-rc.1' }), identity(999, { version: '0.2.2-rc.1' })))
    expect(refused.code).toBe('RUNTIME_ROLLBACK_REJECTED')
  })

  it('refuses one sequence naming two builds', () => {
    const refused = refusal(() => decideUpdate(identity(101), identity(101, { revision: 'f'.repeat(40) })))
    expect(refused.code).toBe('RELEASE_IDENTITY_CONFLICT')
    const kindRefused = refusal(() => decideUpdate(identity(101), identity(101, { version: '0.2.2-rc.2', kind: 'bridge' })))
    expect(kindRefused.code).toBe('RELEASE_IDENTITY_CONFLICT')
  })
})

describe('keys and red lines', () => {
  it('gives one build one key and distinguishes every field', () => {
    expect(releaseKey(identity(101))).toBe(releaseKey(identity(101)))
    expect(releaseKey(identity(101))).not.toBe(releaseKey(identity(102)))
    expect(releaseKey(identity(101))).not.toBe(releaseKey(identity(101, { revision: 'f'.repeat(40) })))
    expect(releaseKey(identity(101, { kind: 'bridge' }))).not.toBe(releaseKey(identity(101)))
    expect(isSameBuild(identity(101), identity(101))).toBe(true)
  })

  it('measures the red line by sequence alone', () => {
    expect(isBelowRedLine(identity(100), undefined)).toBe(false)
    expect(isBelowRedLine(identity(100), 101)).toBe(true)
    expect(isBelowRedLine(identity(102), 101)).toBe(false)
  })
})
