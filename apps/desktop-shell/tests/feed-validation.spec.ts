/**
 * Path traversal prevention in update feed validation.
 *
 * These tests verify that malicious version strings and file names from
 * update feeds cannot be used to write outside the cache directory or
 * cause other filesystem security issues.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ensurePathContainment,
  validateFeedFileName,
  validateFeedVersion,
  versionToCacheKey,
} from '../src/feed-validation.ts'

describe('validateFeedVersion', () => {
  it('accepts valid semver versions', () => {
    expect(validateFeedVersion('1.0.0')).toBe('1.0.0')
    expect(validateFeedVersion('0.1.0')).toBe('0.1.0')
    expect(validateFeedVersion('10.20.30')).toBe('10.20.30')
  })

  it('accepts prerelease versions', () => {
    expect(validateFeedVersion('1.0.0-alpha')).toBe('1.0.0-alpha')
    expect(validateFeedVersion('1.0.0-alpha.1')).toBe('1.0.0-alpha.1')
    expect(validateFeedVersion('1.0.0-beta.2')).toBe('1.0.0-beta.2')
    expect(validateFeedVersion('1.0.0-rc.1')).toBe('1.0.0-rc.1')
    expect(validateFeedVersion('2.0.0-alpha.1.beta')).toBe('2.0.0-alpha.1.beta')
  })

  it('accepts build metadata', () => {
    expect(validateFeedVersion('1.0.0+build.123')).toBe('1.0.0+build.123')
    expect(validateFeedVersion('1.0.0-rc.1+build.456')).toBe('1.0.0-rc.1+build.456')
  })

  it('rejects non-string values', () => {
    expect(() => validateFeedVersion(undefined)).toThrow('更新源的 version 字段必须是字符串')
    expect(() => validateFeedVersion(null)).toThrow('更新源的 version 字段必须是字符串')
    expect(() => validateFeedVersion(123)).toThrow('更新源的 version 字段必须是字符串')
    expect(() => validateFeedVersion({})).toThrow('更新源的 version 字段必须是字符串')
  })

  it('rejects empty string', () => {
    expect(() => validateFeedVersion('')).toThrow('更新源的 version 字段不能为空')
  })

  it('rejects excessively long strings', () => {
    const long = '1.0.0-' + 'a'.repeat(200)
    expect(() => validateFeedVersion(long)).toThrow('更新源的 version 字段过长')
  })

  it('rejects versions with POSIX path separators', () => {
    expect(() => validateFeedVersion('1.0.0/../etc/passwd')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('../1.0.0')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.0.0/malicious')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with Windows path separators', () => {
    expect(() => validateFeedVersion('1.0.0\\..\\Windows')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('C:\\Windows\\System32')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with parent directory traversal', () => {
    expect(() => validateFeedVersion('1.0.0..')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('..1.0.0')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('1...0')).toThrow('更新源的 version 字段格式无效')
  })

  it('rejects versions with URL-encoded path separators', () => {
    expect(() => validateFeedVersion('1.0.0%2f')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('1.0.0%2F')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('1.0.0%5c')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('1.0.0%5C')).toThrow('更新源的 version 字段包含非法序列')
  })

  it('rejects versions with URL-encoded dots', () => {
    expect(() => validateFeedVersion('1%2e0%2e0')).toThrow('更新源的 version 字段包含非法序列')
    expect(() => validateFeedVersion('1.0.0%2E')).toThrow('更新源的 version 字段包含非法序列')
  })

  it('rejects versions with UNC paths', () => {
    expect(() => validateFeedVersion('\\\\server\\share')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with Windows drive letters', () => {
    expect(() => validateFeedVersion('C:1.0.0')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('D:\\1.0.0')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with null bytes', () => {
    expect(() => validateFeedVersion('1.0.0\x00')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with control characters', () => {
    expect(() => validateFeedVersion('1.0.0\n')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.0.0\r')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.0.0\t')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with wildcards', () => {
    expect(() => validateFeedVersion('1.0.*')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.?.0')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects versions with shell metacharacters', () => {
    expect(() => validateFeedVersion('1.0.0|cmd')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.0.0<script>')).toThrow('更新源的 version 字段包含非法字符')
    expect(() => validateFeedVersion('1.0.0>out')).toThrow('更新源的 version 字段包含非法字符')
  })

  it('rejects invalid semver patterns', () => {
    expect(() => validateFeedVersion('1.0')).toThrow('更新源的 version 字段格式无效')
    expect(() => validateFeedVersion('1')).toThrow('更新源的 version 字段格式无效')
    expect(() => validateFeedVersion('v1.0.0')).toThrow('更新源的 version 字段格式无效')
    expect(() => validateFeedVersion('1.0.0.0')).toThrow('更新源的 version 字段格式无效')
    expect(() => validateFeedVersion('a.b.c')).toThrow('更新源的 version 字段格式无效')
  })
})

describe('versionToCacheKey', () => {
  it('produces fixed-length hex strings', () => {
    const key1 = versionToCacheKey('1.0.0')
    const key2 = versionToCacheKey('10.20.30')
    const key3 = versionToCacheKey('1.0.0-very-long-prerelease-tag')

    expect(key1).toMatch(/^[0-9a-f]{64}$/)
    expect(key2).toMatch(/^[0-9a-f]{64}$/)
    expect(key3).toMatch(/^[0-9a-f]{64}$/)
    expect(key1.length).toBe(64)
    expect(key2.length).toBe(64)
    expect(key3.length).toBe(64)
  })

  it('produces different keys for different versions', () => {
    const key1 = versionToCacheKey('1.0.0')
    const key2 = versionToCacheKey('1.0.1')
    const key3 = versionToCacheKey('2.0.0')

    expect(key1).not.toBe(key2)
    expect(key1).not.toBe(key3)
    expect(key2).not.toBe(key3)
  })

  it('produces consistent keys for the same version', () => {
    const key1 = versionToCacheKey('1.0.0')
    const key2 = versionToCacheKey('1.0.0')

    expect(key1).toBe(key2)
  })

  it('handles prerelease versions', () => {
    const key1 = versionToCacheKey('1.0.0-alpha')
    const key2 = versionToCacheKey('1.0.0-beta')

    expect(key1).toMatch(/^[0-9a-f]{64}$/)
    expect(key2).toMatch(/^[0-9a-f]{64}$/)
    expect(key1).not.toBe(key2)
  })
})

describe('ensurePathContainment', () => {
  const testRoot = join(tmpdir(), 'dsh-containment-test')

  beforeEach(() => {
    rmSync(testRoot, { force: true, recursive: true })
    mkdirSync(testRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(testRoot, { force: true, recursive: true })
  })

  it('allows paths within the root', () => {
    expect(() => ensurePathContainment(testRoot, join(testRoot, 'file.txt'))).not.toThrow()
    expect(() => ensurePathContainment(testRoot, join(testRoot, 'subdir', 'file.txt'))).not.toThrow()
    expect(() => ensurePathContainment(testRoot, join(testRoot, 'a', 'b', 'c', 'file.txt'))).not.toThrow()
  })

  it('allows the root itself', () => {
    expect(() => ensurePathContainment(testRoot, testRoot)).not.toThrow()
  })

  it('rejects paths outside the root with parent traversal', () => {
    expect(() => ensurePathContainment(testRoot, join(testRoot, '..'))).toThrow('路径超出缓存目录')
    expect(() => ensurePathContainment(testRoot, join(testRoot, '..', 'other'))).toThrow('路径超出缓存目录')
    expect(() => ensurePathContainment(testRoot, join(testRoot, 'sub', '..', '..'))).toThrow('路径超出缓存目录')
  })

  it('rejects absolute paths outside the root', () => {
    expect(() => ensurePathContainment(testRoot, '/etc/passwd')).toThrow('路径超出缓存目录')
    expect(() => ensurePathContainment(testRoot, '/tmp/other')).toThrow('路径超出缓存目录')
  })

  it('rejects Windows absolute paths outside the root', () => {
    expect(() => ensurePathContainment(testRoot, 'C:\\Windows')).toThrow('路径超出缓存目录')
    expect(() => ensurePathContainment(testRoot, 'D:\\other')).toThrow('路径超出缓存目录')
  })

  it('handles paths with . components', () => {
    expect(() => ensurePathContainment(testRoot, join(testRoot, '.', 'file.txt'))).not.toThrow()
    expect(() => ensurePathContainment(testRoot, join(testRoot, 'sub', '.', 'file.txt'))).not.toThrow()
  })

  it('normalizes paths before comparison', () => {
    expect(() => ensurePathContainment(testRoot, `${testRoot}/sub/../file.txt`)).not.toThrow()
    expect(() => ensurePathContainment(testRoot, `${testRoot}/./file.txt`)).not.toThrow()
  })
})

describe('validateFeedFileName', () => {
  it('accepts valid file names', () => {
    expect(validateFeedFileName('app-1.0.0.zip')).toBe('app-1.0.0.zip')
    expect(validateFeedFileName('installer.exe')).toBe('installer.exe')
    expect(validateFeedFileName('update-darwin-x64.zip')).toBe('update-darwin-x64.zip')
    expect(validateFeedFileName('app_v2.0.0.dmg')).toBe('app_v2.0.0.dmg')
  })

  it('rejects non-string values', () => {
    expect(() => validateFeedFileName(undefined)).toThrow('更新源的文件名必须是字符串')
    expect(() => validateFeedFileName(null)).toThrow('更新源的文件名必须是字符串')
    expect(() => validateFeedFileName(123)).toThrow('更新源的文件名必须是字符串')
  })

  it('rejects empty string', () => {
    expect(() => validateFeedFileName('')).toThrow('更新源的文件名不能为空')
  })

  it('rejects excessively long names', () => {
    const long = 'a'.repeat(300) + '.zip'
    expect(() => validateFeedFileName(long)).toThrow('更新源的文件名过长')
  })

  it('rejects names with path separators', () => {
    expect(() => validateFeedFileName('path/to/file.zip')).toThrow('更新源的文件名不能包含路径分隔符')
    expect(() => validateFeedFileName('..\\..\\file.zip')).toThrow('更新源的文件名不能包含路径分隔符')
    expect(() => validateFeedFileName('/etc/passwd')).toThrow('更新源的文件名不能包含路径分隔符')
  })

  it('rejects names with null bytes', () => {
    expect(() => validateFeedFileName('file\x00.zip')).toThrow('更新源的文件名不能包含空字节')
  })

  it('rejects parent directory references', () => {
    expect(() => validateFeedFileName('..')).toThrow('更新源的文件名无效')
    expect(() => validateFeedFileName('.')).toThrow('更新源的文件名无效')
  })

  it('rejects Windows reserved names', () => {
    expect(() => validateFeedFileName('CON')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('PRN')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('AUX')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('NUL')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('COM1')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('LPT1')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('con.txt')).toThrow('更新源的文件名是 Windows 保留名')
    expect(() => validateFeedFileName('CON.exe')).toThrow('更新源的文件名是 Windows 保留名')
  })

  it('allows names with dots and dashes', () => {
    expect(validateFeedFileName('app-1.0.0-beta.1.zip')).toBe('app-1.0.0-beta.1.zip')
    expect(validateFeedFileName('update.v2.zip')).toBe('update.v2.zip')
  })
})
