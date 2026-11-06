/**
 * Update feed validation and path containment for desktop-shell updater.
 *
 * Validates version strings from update feeds to prevent path traversal
 * attacks through malicious version strings. Feed versions are used to build
 * filesystem paths in the cache directory, so they must be validated before
 * being used in path construction.
 *
 * @module @deepseek-ai/dsh-desktop-shell/feed-validation
 */

import { createHash } from 'node:crypto'
import { resolve, isAbsolute, relative, sep } from 'node:path'

/**
 * Maximum length of a version string. Legitimate semver versions with
 * prerelease tags rarely exceed 40 characters; this bound prevents
 * excessively long strings from being used in paths.
 */
const MAX_VERSION_LENGTH = 128

/**
 * Pattern that valid version strings must match. Accepts semver-like versions
 * including prerelease tags and build metadata:
 * - 1.0.0
 * - 1.0.0-rc.1
 * - 1.0.0-beta.2+build.123
 */
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Characters forbidden in version strings to prevent path traversal and
 * encoding attacks. These are checked after pattern validation to catch
 * encoded separators and other dangerous sequences.
 */
const FORBIDDEN_CHARS = [
  '/',     // POSIX separator
  '\\',    // Windows separator
  '\0',    // Null byte
  ':',     // Windows drive letter separator, macOS path component
  '*',     // Wildcards
  '?',
  '"',     // Quote characters that could break escaping
  '<',
  '>',
  '|',     // Pipe character
  '\n',    // Newlines
  '\r',
  '\t',    // Control characters
]

/**
 * Forbidden substrings that could enable path traversal even within otherwise
 * valid characters.
 */
const FORBIDDEN_SUBSTRINGS = [
  '..',    // Parent directory traversal
  '%2e',   // URL-encoded dot
  '%2E',
  '%2f',   // URL-encoded slash
  '%2F',
  '%5c',   // URL-encoded backslash
  '%5C',
  '\\\\',  // UNC path prefix
]

/**
 * Validate a version string from an update feed.
 *
 * Ensures the version is:
 * - A non-empty string
 * - Within reasonable length bounds
 * - Matches semver-like pattern
 * - Contains no path separator or control characters
 * - Contains no path traversal sequences
 *
 * @param version - the version string to validate, typically from feed.version
 * @returns the validated version string
 * @throws when the version is invalid, carrying a user-facing message
 */
export function validateFeedVersion(version: unknown): string {
  if (typeof version !== 'string') {
    throw new Error('更新源的 version 字段必须是字符串')
  }

  if (version.length === 0) {
    throw new Error('更新源的 version 字段不能为空')
  }

  if (version.length > MAX_VERSION_LENGTH) {
    throw new Error(`更新源的 version 字段过长(${String(version.length)} 字符,上限 ${String(MAX_VERSION_LENGTH)})`)
  }

  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`更新源的 version 字段格式无效:${version}`)
  }

  // Check for forbidden characters
  for (const char of FORBIDDEN_CHARS) {
    if (version.includes(char)) {
      const display = char === '\n' ? '\\n' : char === '\r' ? '\\r' : char === '\t' ? '\\t' : char === '\0' ? '\\0' : char
      throw new Error(`更新源的 version 字段包含非法字符:${display}`)
    }
  }

  // Check for forbidden substrings (case-insensitive for encoded sequences)
  const lowerVersion = version.toLowerCase()
  for (const substring of FORBIDDEN_SUBSTRINGS) {
    if (lowerVersion.includes(substring.toLowerCase())) {
      throw new Error(`更新源的 version 字段包含非法序列:${substring}`)
    }
  }

  return version
}

/**
 * Compute a safe cache key from a version string.
 *
 * Instead of using the raw version string as a path component, this creates
 * a fixed-length SHA-256 digest. This prevents path traversal even if
 * validation is bypassed or incomplete, and ensures cache paths have
 * consistent length regardless of version string length.
 *
 * @param version - the validated version string
 * @returns a hex-encoded SHA-256 digest, safe for use as a path component
 */
export function versionToCacheKey(version: string): string {
  return createHash('sha256').update(version, 'utf8').digest('hex')
}

/**
 * Ensure a path is contained within an expected root directory.
 *
 * Validates that a constructed path stays inside its intended root, preventing
 * writes outside the cache directory even if a version string bypassed earlier
 * validation. All paths are resolved to absolute form before comparison.
 *
 * @param root - the directory that must contain the path
 * @param path - the path to validate
 * @throws when the path escapes the root directory
 */
export function ensurePathContainment(root: string, path: string): void {
  const normalizedRoot = resolve(root)
  const normalizedPath = resolve(path)

  // Check that path is within root using relative path
  const rel = relative(normalizedRoot, normalizedPath)

  // If relative path is empty, it's the root itself - allowed
  if (rel === '') return

  // If relative path starts with '..' or is absolute, it's outside root
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`路径超出缓存目录:${path} 不在 ${root} 内`)
  }
}

/**
 * Validate a file name from a feed artifact entry.
 *
 * Ensures the file name is safe to use in path construction. This is separate
 * from version validation because file names come from a different feed field
 * and have different format requirements.
 *
 * @param fileName - the file name to validate, from feed.files[].url
 * @returns the validated file name
 * @throws when the file name is invalid
 */
export function validateFeedFileName(fileName: unknown): string {
  if (typeof fileName !== 'string') {
    throw new Error('更新源的文件名必须是字符串')
  }

  if (fileName.length === 0) {
    throw new Error('更新源的文件名不能为空')
  }

  if (fileName.length > 255) {
    throw new Error(`更新源的文件名过长(${String(fileName.length)} 字符)`)
  }

  // Check for path separators in the file name
  if (fileName.includes('/') || fileName.includes('\\')) {
    throw new Error(`更新源的文件名不能包含路径分隔符:${fileName}`)
  }

  // Check for null bytes
  if (fileName.includes('\0')) {
    throw new Error('更新源的文件名不能包含空字节')
  }

  // Check for parent directory traversal
  if (fileName === '.' || fileName === '..') {
    throw new Error(`更新源的文件名无效:${fileName}`)
  }

  // Check for Windows reserved names (case-insensitive)
  const upperName = fileName.toUpperCase()
  const reserved = ['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9']
  for (const name of reserved) {
    if (upperName === name || upperName.startsWith(`${name}.`)) {
      throw new Error(`更新源的文件名是 Windows 保留名:${fileName}`)
    }
  }

  return fileName
}
