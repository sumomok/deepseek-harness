/**
 * Path traversal prevention in the update channel.
 *
 * Two values of a feed reach the file system, and each is checked where it
 * enters: the version through `validateFeedVersion`, the artifact name
 * through `validateFeedFileName` inside the cache helpers. The `.part` file
 * name carries a fixed-length digest of the complete build identity rather
 * than any feed string, so even a value that slipped past validation cannot
 * direct the path. The cases cover POSIX and Windows-style attacks, and the
 * legitimate prerelease versions that must keep working.
 * @module
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { validateFeedVersion } from '../src/feed-validation.ts'
import { partFileFor, placeInPendingCache } from '../src/pending-cache.ts'
import type { ReleaseIdentity } from '../src/release-identity.ts'

/** The source commit every build fixture names. */
const REVISION = '0123456789abcdef0123456789abcdef01234567'

/**
 * One standard build's complete identity.
 * @param version - the version the build publishes under.
 * @param sequence - build sequence, the field two builds of one version differ in.
 * @returns the identity the cache helpers take.
 */
function build(version: string, sequence = 101): ReleaseIdentity {
  return {
    version,
    dshRelease: { schemaVersion: 2, runtimeVersion: version, buildSequence: sequence, revision: REVISION, kind: 'standard' },
  }
}

/** The build the safe-path cases transfer. */
const BUILD = build('0.2.2-rc.1')

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-path-traversal-test-'))
  directories.push(directory)
  return directory
}

describe('malicious feed version strings', () => {
  it('rejects POSIX parent directory traversal', () => {
    expect(() => validateFeedVersion('../../../etc/passwd')).toThrow()
    expect(() => validateFeedVersion('1.0.0/../../evil')).toThrow()
  })

  it('rejects Windows parent directory traversal', () => {
    expect(() => validateFeedVersion('..\\..\\Windows\\System32')).toThrow()
    expect(() => validateFeedVersion('1.0.0\\..\\..\\evil')).toThrow()
  })

  it('rejects absolute POSIX paths', () => {
    expect(() => validateFeedVersion('/etc/1.0.0')).toThrow()
    expect(() => validateFeedVersion('/tmp/../etc/1.0.0')).toThrow()
  })

  it('rejects Windows drive letters', () => {
    expect(() => validateFeedVersion('C:\\1.0.0')).toThrow()
    expect(() => validateFeedVersion('D:\\Windows\\1.0.0')).toThrow()
  })

  it('rejects UNC paths', () => {
    expect(() => validateFeedVersion('\\\\server\\share\\1.0.0')).toThrow()
  })

  it('rejects URL-encoded path traversal', () => {
    expect(() => validateFeedVersion('1.0.0%2f%2e%2e')).toThrow()
    expect(() => validateFeedVersion('%2e%2e%2f1.0.0')).toThrow()
    expect(() => validateFeedVersion('1.0.0%5c%2e%2e')).toThrow()
  })

  it('rejects double-encoded traversal', () => {
    expect(() => validateFeedVersion('1%252e0%252e0')).toThrow()
  })

  it('rejects null byte injection', () => {
    expect(() => validateFeedVersion('1.0.0\x00/etc/passwd')).toThrow()
  })

  it('rejects control characters', () => {
    expect(() => validateFeedVersion('1.0.0\n')).toThrow()
    expect(() => validateFeedVersion('1.0.0\r\n')).toThrow()
    expect(() => validateFeedVersion('1.0.0\t')).toThrow()
  })

  it('rejects shell metacharacters', () => {
    expect(() => validateFeedVersion('1.0.0|cmd')).toThrow()
    expect(() => validateFeedVersion('1.0.0;cmd')).toThrow()
    expect(() => validateFeedVersion('1.0.0&cmd')).toThrow()
  })

  it('rejects excessively long version strings', () => {
    const longVersion = '1.0.0-' + 'a'.repeat(200)
    expect(() => validateFeedVersion(longVersion)).toThrow()
  })
})

describe('malicious file names', () => {
  const cacheDir = cacheDirectory()
  const tempFile = join(cacheDir, 'temp-artifact')
  writeFileSync(tempFile, 'dummy content')

  it('rejects path separators in file names', () => {
    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: '../../etc/evil.zip',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()

    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: '..\\..\\Windows\\evil.exe',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()
  })

  it('rejects absolute paths as file names', () => {
    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: '/etc/passwd',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()

    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: 'C:\\Windows\\System32\\evil.dll',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()
  })

  it('rejects Windows reserved names', () => {
    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: 'CON',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()

    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: 'NUL.exe',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()
  })

  it('rejects parent directory references', () => {
    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: '..',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()

    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: '.',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow()
  })
})

describe('legitimate feed versions', () => {
  it('accepts standard prerelease tags', () => {
    expect(() => validateFeedVersion('1.0.0-alpha')).not.toThrow()
    expect(() => validateFeedVersion('1.0.0-beta.1')).not.toThrow()
    expect(() => validateFeedVersion('1.0.0-rc.1')).not.toThrow()
  })

  it('accepts complex prerelease identifiers', () => {
    expect(() => validateFeedVersion('2.0.0-alpha.1.beta')).not.toThrow()
    expect(() => validateFeedVersion('1.0.0-x.7.z.92')).not.toThrow()
  })

  it('accepts build metadata', () => {
    expect(() => validateFeedVersion('1.0.0+build.123')).not.toThrow()
    expect(() => validateFeedVersion('1.0.0-rc.1+build.456')).not.toThrow()
  })

  it('accepts versions with hyphens in prerelease', () => {
    expect(() => validateFeedVersion('1.0.0-alpha-test')).not.toThrow()
    expect(() => validateFeedVersion('1.0.0-pre-release-1')).not.toThrow()
  })

  it('creates safe cache keys for all legitimate versions', () => {
    const cacheDir = cacheDirectory()
    const versions = [
      '1.0.0',
      '1.0.0-alpha',
      '1.0.0-beta.1',
      '1.0.0-rc.1',
      '2.0.0-alpha.1.beta',
      '1.0.0+build.123',
      '1.0.0-rc.1+build.456',
    ]

    for (const version of versions) {
      const partFile = partFileFor(cacheDir, build(version), 'app.zip')
      // Part file should be in cache directory
      expect(partFile.startsWith(cacheDir)).toBe(true)
      // Part file name should not contain the raw version (using digest instead)
      const partFileName = partFile.substring(cacheDir.length)
      expect(partFileName.includes(version)).toBe(false)
      // Part file should have .part extension
      expect(partFile.endsWith('.part')).toBe(true)
    }
  })
})

describe('path containment enforcement', () => {
  it('ensures part files stay within cache directory', () => {
    const cacheDir = cacheDirectory()
    const partFile = partFileFor(cacheDir, BUILD, 'app.zip')
    expect(partFile.startsWith(cacheDir)).toBe(true)
    // Should be a direct child, not in pending subdirectory
    const relativePath = partFile.substring(cacheDir.length + 1)
    expect(relativePath.includes('/') || relativePath.includes('\\')).toBe(false)
  })

  it('ensures staged files stay within pending subdirectory', () => {
    const cacheDir = cacheDirectory()
    const tempFile = join(cacheDir, 'temp-artifact')
    writeFileSync(tempFile, 'test content')

    const staged = placeInPendingCache({
      cacheDir,
      sourceFile: tempFile,
      fileName: 'app.zip',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })

    expect(staged.startsWith(join(cacheDir, 'pending'))).toBe(true)
    // Verify content was moved correctly
    expect(readFileSync(staged, 'utf8')).toBe('test content')
  })

  it('rejects when source file is outside cache directory', () => {
    const cacheDir = cacheDirectory()
    const outsideDir = cacheDirectory()
    const outsideFile = join(outsideDir, 'outside-artifact')
    writeFileSync(outsideFile, 'outside content')

    expect(() => placeInPendingCache({
      cacheDir,
      sourceFile: outsideFile,
      fileName: 'app.zip',
      sha512: 'dummy',
      isAdminRightsRequired: false,
    })).toThrow('路径超出缓存目录')
  })
})

describe('build identity to cache key conversion', () => {
  it('produces consistent keys across calls', () => {
    const cacheDir = cacheDirectory()
    const part1 = partFileFor(cacheDir, BUILD, 'app.zip')
    const part2 = partFileFor(cacheDir, BUILD, 'app.zip')
    expect(part1).toBe(part2)
  })

  it('produces different keys for different builds', () => {
    const cacheDir = cacheDirectory()
    const part1 = partFileFor(cacheDir, build('1.0.0'), 'app.zip')
    const part2 = partFileFor(cacheDir, build('1.0.1'), 'app.zip')
    expect(part1).not.toBe(part2)
  })

  it('produces fixed-length keys regardless of version length', () => {
    const cacheDir = cacheDirectory()
    const shortPart = partFileFor(cacheDir, build('1.0.0'), 'app.zip')
    const longPart = partFileFor(cacheDir, build('1.0.0-very-long-prerelease-tag'), 'app.zip')

    // Extract the hash portion (between prefix and filename)
    const shortHash = shortPart.match(/dsh-resume-([0-9a-f]+)-/)?.[1]
    const longHash = longPart.match(/dsh-resume-([0-9a-f]+)-/)?.[1]

    expect(shortHash).toBeDefined()
    expect(longHash).toBeDefined()
    expect(shortHash?.length).toBe(longHash?.length)
  })
})
