/**
 * The gate's one contact with the browser's global objects. Everything impure
 * the gate does — reading storage and cookies, writing a cookie, leaving the
 * page, waiting for a clock — passes through this interface, so the gate itself
 * is exercised without a DOM and this file stays small enough to read.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/browser
 */

import { ACCESS_TOKEN_STORAGE_KEY } from '../route.ts'

/** The browser operations the gate performs. */
export interface GateBrowser {
  /** The current time in milliseconds. */
  now(): number
  /** The address the visitor is on, which is also the address they return to after signing in. */
  currentHref(): string
  /** The stored access token, or `null` when nothing is stored. */
  readToken(): string | null
  /** The named cookie's value, or `undefined` when the visitor carries no such cookie. */
  readCookie(name: string): string | undefined
  /** Write the named cookie for the whole origin. */
  writeCookie(name: string, value: string): void
  /** Leave for another address. */
  navigate(url: string): void
  /** Load the current address again. */
  reload(): void
  /**
   * Subscribe to another tab changing storage in a way that may have moved the
   * token; the listener re-reads rather than trusting the event's payload.
   * @param listener - called after each such change.
   * @returns the disposer removing the subscription.
   */
  onStorageChanged(listener: () => void): () => void
  /**
   * Run something once, later.
   * @param delayMs - how long to wait.
   * @param run - what to run.
   * @returns the disposer cancelling it.
   */
  schedule(delayMs: number, run: () => void): () => void
}

/**
 * Read one cookie out of a `document.cookie` string.
 * @param jar - the full cookie string.
 * @param name - the cookie to find.
 * @returns its value, or `undefined` when the jar carries no such cookie.
 */
export function readCookieFrom(jar: string, name: string): string | undefined {
  for (const pair of jar.split(';')) {
    const at = pair.indexOf('=')
    if (at !== -1 && pair.slice(0, at).trim() === name) return decodeURIComponent(pair.slice(at + 1).trim())
  }
  return undefined
}

/**
 * The cookie line that mirrors one token for the whole origin.
 *
 * Not `HttpOnly`, deliberately: the token already lives in `localStorage`, where
 * the deployment's login page put it and where any script on the page can read
 * it, so a cookie the script cannot read would narrow nothing while making the
 * mirror impossible to keep in step. `Secure` and `SameSite=Lax` still apply —
 * the first keeps it off plaintext hops, the second keeps it off cross-site
 * subrequests.
 * @param name - the cookie name.
 * @param value - the token to mirror.
 * @returns the assignment for `document.cookie`.
 */
export function mirrorCookieLine(name: string, value: string): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Secure; SameSite=Lax`
}

/**
 * The gate's browser, backed by the page's own globals.
 * @returns the operations bound to `window`, `document`, and `localStorage`.
 */
export function windowGateBrowser(): GateBrowser {
  return {
    now: () => Date.now(),
    currentHref: () => location.href,
    readToken: () => localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY),
    readCookie: name => readCookieFrom(document.cookie, name),
    writeCookie: (name, value) => { document.cookie = mirrorCookieLine(name, value) },
    navigate: (url) => { location.href = url },
    reload: () => { location.reload() },
    onStorageChanged: (listener) => {
      const onStorage = (event: StorageEvent): void => {
        // A `null` key is `localStorage.clear()`, which took the token with it.
        if (event.key === null || event.key === ACCESS_TOKEN_STORAGE_KEY) listener()
      }
      addEventListener('storage', onStorage)
      return () => { removeEventListener('storage', onStorage) }
    },
    schedule: (delayMs, run) => {
      const timer = setTimeout(run, delayMs)
      return () => { clearTimeout(timer) }
    },
  }
}
