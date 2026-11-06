/**
 * Path traversal prevention in the update channel.
 *
 * These tests verify that malicious update feeds cannot cause the updater to
 * write files outside the cache directory or perform other filesystem security
 * violations. The tests cover both POSIX and Windows-style attacks, as well
 * as legitimate prerelease versions that should continue to work.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { partFileFor, placeInPendingCache } from '../src/pending-cache.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function cacheDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-path-traversal-test-'))
  directories.push(directory)
  return directory
}

describe('malicious version strings', () => {
  it('rejects POSIX parent directory traversal', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '../../../etc/passwd', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0/../../evil', 'app.zip')).toThrow()
  })

  it('rejects Windows parent directory traversal', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '..\\..\\Windows\\System32', 'app.exe')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0\\..\\..\\evil', 'app.exe')).toThrow()
  })

  it('rejects absolute POSIX paths', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '/etc/1.0.0', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '/tmp/../etc/1.0.0', 'app.zip')).toThrow()
  })

  it('rejects Windows drive letters', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, 'C:\\1.0.0', 'app.exe')).toThrow()
    expect(() => partFileFor(cacheDir, 'D:\\Windows\\1.0.0', 'app.exe')).toThrow()
  })

  it('rejects UNC paths', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '\\\\server\\share\\1.0.0', 'app.exe')).toThrow()
  })

  it('rejects URL-encoded path traversal', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0%2f%2e%2e', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '%2e%2e%2f1.0.0', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0%5c%2e%2e', 'app.exe')).toThrow()
  })

  it('rejects double-encoded traversal', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1%252e0%252e0', 'app.zip')).toThrow()
  })

  it('rejects null byte injection', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0\x00/etc/passwd', 'app.zip')).toThrow()
  })

  it('rejects control characters', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0\n', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0\r\n', 'app.zip')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0\t', 'app.zip')).toThrow()
  })

  it('rejects shell metacharacters', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0|cmd', 'app.exe')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0;cmd', 'app.exe')).toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0&cmd', 'app.exe')).toThrow()
  })

  it('rejects excessively long version strings', () => {
    const cacheDir = cacheDirectory()
    const longVersion = '1.0.0-' + 'a'.repeat(200)
    expect(() => partFileFor(cacheDir, longVersion, 'app.zip')).toThrow()
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

describe('legitimate prerelease versions', () => {
  it('accepts standard prerelease tags', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0-alpha', 'app.zip')).not.toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0-beta.1', 'app.zip')).not.toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0-rc.1', 'app.zip')).not.toThrow()
  })

  it('accepts complex prerelease identifiers', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '2.0.0-alpha.1.beta', 'app.zip')).not.toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0-x.7.z.92', 'app.zip')).not.toThrow()
  })

  it('accepts build metadata', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0+build.123', 'app.zip')).not.toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0-rc.1+build.456', 'app.zip')).not.toThrow()
  })

  it('accepts versions with hyphens in prerelease', () => {
    const cacheDir = cacheDirectory()
    expect(() => partFileFor(cacheDir, '1.0.0-alpha-test', 'app.zip')).not.toThrow()
    expect(() => partFileFor(cacheDir, '1.0.0-pre-release-1', 'app.zip')).not.toThrow()
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
      const partFile = partFileFor(cacheDir, version, 'app.zip')
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
    const partFile = partFileFor(cacheDir, '1.0.0', 'app.zip')
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

describe('version to cache key conversion', () => {
  it('produces consistent keys across calls', () => {
    const cacheDir = cacheDirectory()
    const part1 = partFileFor(cacheDir, '1.0.0', 'app.zip')
    const part2 = partFileFor(cacheDir, '1.0.0', 'app.zip')
    expect(part1).toBe(part2)
  })

  it('produces different keys for different versions', () => {
    const cacheDir = cacheDirectory()
    const part1 = partFileFor(cacheDir, '1.0.0', 'app.zip')
    const part2 = partFileFor(cacheDir, '1.0.1', 'app.zip')
    expect(part1).not.toBe(part2)
  })

  it('produces fixed-length keys regardless of version length', () => {
    const cacheDir = cacheDirectory()
    const shortPart = partFileFor(cacheDir, '1.0.0', 'app.zip')
    const longPart = partFileFor(cacheDir, '1.0.0-very-long-prerelease-tag', 'app.zip')

    // Extract the hash portion (between prefix and filename)
    const shortHash = shortPart.match(/dsh-resume-([0-9a-f]+)-/)?.[1]
    const longHash = longPart.match(/dsh-resume-([0-9a-f]+)-/)?.[1]

    expect(shortHash).toBeDefined()
    expect(longHash).toBeDefined()
    expect(shortHash?.length).toBe(longHash?.length)
  })
})
