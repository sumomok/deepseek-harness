/**
 * Remove the browser-session cookies earlier launches of this shell left on
 * `127.0.0.1`, once per process, before this launch starts its server.
 *
 * Every launch serves the UI on a new `--port 0` port, and the served page
 * stores one persistent `dsh-auth-<sha256(authority)>` cookie for it. The
 * authority carries the port, so each launch adds a cookie under a new name,
 * while the browser sends cookies by host and not by port: every one of them
 * goes out with every request to `127.0.0.1`. Enough launches push the request
 * header past Node's 16 KB limit, and the server answers the plugin bundle
 * request with 431, which the window reports as `Failed to load plugins`.
 *
 * Before the spawn this process has no server yet, so every `dsh-auth-*`
 * cookie on the host belongs to an earlier process and none of them can
 * authenticate anything; removing all of them cannot remove the one this
 * launch is about to be issued. Reopening a window and rebinding the server
 * never call this: they keep the cookie the running server issued.
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
 * cookie on that host.
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
  if (removed > 0) log(`[desktop] removed ${String(removed)} browser-session cookies earlier launches left on ${LOOPBACK_HOST}\n`)
  return removed
}
