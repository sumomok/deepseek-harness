/**
 * The boot window's `will-navigate` policy: which navigations stay in the
 * window because they target the running server, and, once a navigation is
 * declined, which targets still reach the OS's own handler rather than being
 * silently dropped. Depends on nothing
 * Electron-specific, so it is importable outside the main process.
 * @module @deepseek-ai/dsh-desktop-shell/navigation
 */

/**
 * Whether a declined navigation target should be forwarded to
 * `shell.openExternal` instead of just being dropped. `http(s)` targets are
 * ordinary web pages; `mailto:` targets are a markdown-sanitizer-allowed
 * link destination that never carries `target="_blank"`, so without this
 * predicate a rendered `mailto:` link lands here `preventDefault`-ed with no
 * visible effect — a dead click.
 * @param target - the navigation target `will-navigate` reports.
 * @returns true when the target should be handed to the OS's own handler.
 */
export function isExternalNavigationTarget(target: string): boolean {
  return target.startsWith('http') || target.startsWith('mailto:')
}

/**
 * Whether a navigation target is on the running server's origin. The origins
 * are compared parsed, not as string prefixes: `http://127.0.0.1:P@evil.example/`
 * starts with the server's origin text but names `evil.example` as its host,
 * with `127.0.0.1` and `P` as user name and password.
 * @param target - the navigation target `will-navigate` reports.
 * @param serverUrl - the running server's origin.
 * @returns true when both parse and their origins are equal; false otherwise.
 */
export function isServerNavigation(target: string, serverUrl: string): boolean {
  try {
    return new URL(target).origin === new URL(serverUrl).origin
  } catch {
    // An unparsable target is declined like any other foreign one.
    return false
  }
}
