/**
 * The boot window's navigation policy: which navigations stay in the window
 * because they target the running server, which targets reach the OS's own
 * handler, and which are dropped. Every OS hand-off resolves through the
 * shared external-URL rules first, so a blocked target never reaches the
 * opener. The policy depends on no Electron type, so it is importable in a
 * unit test with a fake web contents.
 * @module @deepseek-ai/dsh-desktop-shell/navigation
 */

import { resolveExternalUrl } from '@deepseek-ai/dsh-external-url'
import { SHELL_LINK_PROTOCOLS } from './link-protocols.ts'

/** The part of Electron's `WebContents` the navigation policy installs on. */
export interface NavigationContents {
  /**
   * Register the handler for a page's request to open another window.
   * @param handler - receives the requested URL and returns the deny decision.
   * @returns the value Electron returns for its registration.
   */
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' }): unknown

  /**
   * Register a top-level navigation listener.
   * @param event - `will-navigate` or the redirect equivalent.
   * @param listener - receives the cancellable event, its target, whether the
   * navigation is in place, and whether it belongs to the main frame.
   * @returns the value Electron returns for its registration.
   */
  on(event: 'will-navigate' | 'will-redirect', listener: (
    event: { preventDefault(): void },
    target: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => void): unknown
}

/** What the navigation policy needs from the window's owner. */
export interface NavigationPolicyOptions {
  /** The running server's URL, or undefined before it is known. */
  readonly serverUrl: () => string | undefined
  /**
   * Hand a resolved, allowed target to the OS. Rejections are logged; the
   * opener itself owns user-facing feedback for an actively requested open.
   */
  readonly openExternal: (url: string) => void | Promise<unknown>
  /** Append one safe line to the shell log. */
  readonly log: (line: string) => void
}

/** A line that leaks no query, fragment, or credential. */
const OPEN_FAILED = '[external] opening the target failed\n'

/**
 * Whether a navigation target is on the running server's origin. Both sides
 * are resolved with the shared external-URL rules and compared by parsed
 * origin: `http://127.0.0.1:P@evil.example/` starts with the server's origin
 * text but names `evil.example` as its host, with `127.0.0.1` and `P` as user
 * name and password.
 * @param target - the navigation target `will-navigate` reports.
 * @param serverUrl - the running server's URL.
 * @returns true when both resolve and their origins are equal; false otherwise.
 */
export function isServerNavigation(target: string, serverUrl: string): boolean {
  const resolved = resolveExternalUrl(target, ['http:', 'https:'])
  if (resolved.kind === 'blocked') return false
  try {
    return new URL(resolved.url).origin === new URL(serverUrl).origin
  } catch {
    // A malformed server URL names no origin to compare against.
    return false
  }
}

/**
 * Resolve one navigation target and hand it to the OS only when allowed.
 * @param target - URL the page asked to navigate to or open.
 * @param options - server source, opener, and log sink.
 */
function handOff(target: string, options: NavigationPolicyOptions): void {
  const resolution = resolveExternalUrl(target, SHELL_LINK_PROTOCOLS)
  if (resolution.kind === 'blocked') return
  try {
    const opening = options.openExternal(resolution.url)
    if (opening !== undefined) {
      void opening.catch(() => {
        options.log(OPEN_FAILED)
      })
    }
  } catch {
    // A synchronous opener failure is handled like a rejected one.
    options.log(OPEN_FAILED)
  }
}

/**
 * Install the boot window's popup, navigation, and redirect rules.
 *
 * A popup is always denied: an allowed target goes to the OS and a blocked one
 * goes nowhere. A top-level navigation stays only on the server origin;
 * everything else is cancelled before the policy decides whether the target is
 * one the OS may open. A redirect leaves the server origin only for a main
 * frame, which is cancelled without opening the browser; a subframe redirect
 * stays with Chromium, because embedded pages legitimately follow cross-site
 * HTTP(S) redirects. Failures from the opener are logged and never surface as
 * unhandled rejections.
 * @param contents - the boot window's web contents, real or faked.
 * @param options - server source, opener, and log sink.
 */
export function installNavigationPolicy(contents: NavigationContents, options: NavigationPolicyOptions): void {
  contents.setWindowOpenHandler(({ url }) => {
    handOff(url, options)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, target) => {
    const serverUrl = options.serverUrl()
    if (serverUrl !== undefined && isServerNavigation(target, serverUrl)) return
    // Cancel first: deciding whether to open the OS afterward cannot revive the
    // in-window navigation.
    event.preventDefault()
    handOff(target, options)
  })
  contents.on('will-redirect', (event, target, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return
    const serverUrl = options.serverUrl()
    if (serverUrl === undefined || !isServerNavigation(target, serverUrl)) event.preventDefault()
  })
}
