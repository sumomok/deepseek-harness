/**
 * Path comparison by text, the way the default file systems of each platform
 * compare names: macOS ignores letter case and Unicode normalization, Windows
 * ignores letter case, Linux compares exactly. On a case-sensitive volume on
 * macOS or Windows this errs toward "the same", which only ever refuses more.
 * @module @deepseek-ai/dsh-desktop-shell/path-text
 */

import { posix, win32 } from 'node:path'

/**
 * The path module whose rules apply on a platform.
 * @param platform - the platform.
 * @returns `win32` on Windows, `posix` elsewhere.
 */
export function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix
}

/**
 * A path's text folded the way the platform's file system compares names.
 * @param value - the text.
 * @param platform - the platform.
 * @returns lower case on Windows; NFC and lower case on macOS; unchanged elsewhere.
 */
export function foldPath(value: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return value.toLowerCase()
  return platform === 'darwin' ? value.normalize('NFC').toLowerCase() : value
}

/**
 * Whether two absolute paths name the same entry by their text: resolved (so
 * `.`/`..` and trailing separators go) and folded ({@link foldPath}). Links
 * are not followed; callers compare real paths when that matters.
 * @param a - one path.
 * @param b - the other.
 * @param platform - whose rules apply.
 * @returns true when they are the same text after resolving and folding.
 */
export function samePathText(a: string, b: string, platform: NodeJS.Platform): boolean {
  const api = pathApi(platform)
  return foldPath(api.resolve(a), platform) === foldPath(api.resolve(b), platform)
}
