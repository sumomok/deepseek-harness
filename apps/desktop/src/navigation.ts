/**
 * The boot window's `will-navigate` policy: once a navigation is declined
 * (it does not target the running server), which targets still reach the
 * OS's own handler rather than being silently dropped. Depends on nothing
 * Electron-specific, so it is importable outside the main process.
 * @module @deepseek-ai/dsh-desktop/navigation
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
