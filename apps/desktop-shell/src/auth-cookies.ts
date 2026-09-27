/**
 * Remove the shell's browser-session cookies on `127.0.0.1`: once per process
 * before this launch starts its server, when the server exits unexpectedly,
 * and as the app quits, before the server is stopped.
 *
 * The served page stores one persistent `dsh-auth-<sha256(authority)>` cookie
 * per server it signs into. The authority carries the port, so a launch or a
 * crash rebind on a new port adds a cookie under a new name, while the browser
 * sends cookies by host and not by port: every one of them goes out with every
 * request to `127.0.0.1`. Enough of them push the request header past Node's
 * 16 KB limit, and the server answers the plugin bundle request with 431,
 * which the window reports as `Failed to load plugins`.
 *
 * A cookie is not bound to the process that issued it. It is signed with a
 * secret the Harness home keeps, so it stays valid, until its expiry, for any
 * later server on the same authority, and a launch asks for the previous
 * launch's port ([[@deepseek-ai/dsh-desktop-shell/server-port]]). The removal
 * at launch keeps a stored copy from being sent again; the removals after a
 * crash and at quit keep the window, still open and still reconnecting, from
 * sending one to a port the server no longer holds
 * ([[@deepseek-ai/dsh-desktop-shell/server-lifecycle]]). A copy taken before a
 * removal — by a process that listened on the port while the window was
 * sending to it — is not revoked by removing the stored cookie.
 *
 * Before the spawn this process has no server yet, so removing every
 * `dsh-auth-*` cookie cannot remove the one this launch is about to be issued.
 * Reopening a window never calls this: it keeps the cookie the running server
 * issued. A rebind runs after the removal its crash triggered, and the
 * window's load of the new server is issued a new cookie.
 * @module @deepseek-ai/dsh-desktop-shell/auth-cookies
 */

/**
 * The name prefix of the browser-session cookie the served UI stores; the rest
 * of the name is a hash of the server's authority. Named by upstream
 * `packages/client/connection/src/browser-auth.ts`.
 */
export const AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** The host every launch serves the UI on. */
const LOOPBACK_HOST = '127.0.0.1'

/** One stored cookie, as far as removing it needs: Electron's `Cookie` has these two fields. */
export interface StoredCookie {
  /** The cookie name. */
  name: string
  /** The cookie path; Electron leaves it undefined for a cookie stored without one. */
  path?: string
}

/** The two calls this module makes on Electron's `session.cookies`. */
export interface CookieStore {
  /**
   * Read the stored cookies that match a filter.
   * @param filter - the domain to read.
   * @returns every cookie stored for that domain.
   */
  get: (filter: { domain: string }) => Promise<StoredCookie[]>
  /**
   * Remove one cookie.
   * @param url - an URL whose host and path select the cookie.
   * @param name - the cookie name.
   */
  remove: (url: string, name: string) => Promise<void>
}

/**
 * Remove every `dsh-auth-*` cookie stored for `127.0.0.1`, leaving every other
 * cookie on that host. Called before the spawn, after an unexpected exit,
 * and at quit; see the module description.
 *
 * The cookies are read by domain rather than by URL, because a URL filter also
 * matches the path and would miss a cookie stored under a path other than `/`;
 * each one is removed at its own path. A failed read or removal writes one line
 * to `log` and the launch continues: a leftover cookie costs header space, not
 * the launch.
 * @param cookies - the default session's cookie store.
 * @param log - receives one line per removal that failed and one summary line.
 * @returns the number of cookies removed.
 */
export async function clearStaleAuthCookies(cookies: CookieStore, log: (line: string) => void): Promise<number> {
  let stored: StoredCookie[]
  try {
    stored = await cookies.get({ domain: LOOPBACK_HOST })
  } catch (error) {
    log(`[desktop] could not read the ${LOOPBACK_HOST} cookies: ${String(error)}\n`)
    return 0
  }
  let removed = 0
  for (const cookie of stored) {
    if (!cookie.name.startsWith(AUTH_COOKIE_PREFIX)) continue
    try {
      await cookies.remove(`http://${LOOPBACK_HOST}${cookie.path ?? '/'}`, cookie.name)
      removed += 1
    } catch (error) {
      log(`[desktop] could not remove cookie ${cookie.name}: ${String(error)}\n`)
    }
  }
  if (removed > 0) log(`[desktop] removed ${String(removed)} browser-session cookies on ${LOOPBACK_HOST}\n`)
  return removed
}
