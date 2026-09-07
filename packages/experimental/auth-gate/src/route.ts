/**
 * The HTTP paths both halves of this package are defined against, and the two
 * documents that cross between them. The node half claims the paths as
 * webserver routes; the browser half reads its settings from one and posts the
 * access token to the other. Not configurable — the two halves must agree on
 * them and nothing outside this package addresses them.
 *
 * The settings document exists because a browser half receives no cordis
 * config: the boot manifest carries plugin names, not their `config` blocks, so
 * a `Config` field the browser must obey has to be served to it.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/route
 */

/** Exact route serving {@link AuthGateSettings} to this package's browser half. */
export const AUTH_GATE_SETTINGS_ROUTE = '/auth-gate/settings'

/** Exact route the browser half posts the current access token to. */
export const AUTH_GATE_TOKEN_ROUTE = '/auth-gate/token'

/**
 * Exact route the browser half posts to when it gives up the token it was
 * running on, so the node half stops spending it.
 */
export const AUTH_GATE_LOGOUT_ROUTE = '/auth-gate/logout'

/** Prefix under which each configured MCP upstream gets its forwarding route; no trailing slash, which is the webserver's route form. */
export const AUTH_GATE_MCP_PREFIX = '/auth-gate/mcp'

/**
 * The `localStorage` key the access token is read from. Fixed rather than
 * configured: it is the key the deployment's own login page writes, so it is a
 * contract with that page rather than a choice this plugin makes.
 *
 * It is that page's default key, and only that one. `toy-core`'s `getToken`,
 * `setToken`, and `isTokenRenewal` all switch to `accessTokenAuth` and
 * `accessTokenTimeAuth` when the deployment's own local config sets `isAuth`,
 * and neither half of this package reads or writes those names.
 */
export const ACCESS_TOKEN_STORAGE_KEY = 'accessToken'

/**
 * The `localStorage` key holding when the stored token was last written, in the
 * same contract with the deployment's own pages: their `setToken` writes it
 * beside the token, and their `isTokenRenewal` measures a token's age from it.
 * A renewal that left it behind would leave every deployment page on this origin
 * believing the token it can see is as old as the one it replaced. The default
 * key here as well, under the condition {@link ACCESS_TOKEN_STORAGE_KEY}
 * records.
 */
export const ACCESS_TOKEN_TIME_STORAGE_KEY = 'accessTokenTime'

/**
 * The `localStorage` key holding the header table the deployment's own HTTP
 * client puts on every authenticated request — a JSON object of header names to
 * values, written by its login page. Read for the renewal request and for
 * nothing else.
 */
export const LOGIN_USER_INFO_STORAGE_KEY = 'loginUserInfo'

/**
 * The base a configured renewal path is resolved against to find out which
 * origin it names. A host no deployment is served from, so an origin other than
 * this one came from the value rather than from the base.
 */
const PATH_PROBE_BASE = 'https://auth-gate.invalid/'

/** The origin {@link PATH_PROBE_BASE} carries, which a path on the page's own origin keeps. */
const PATH_PROBE_ORIGIN = 'https://auth-gate.invalid'

/**
 * Whether a configured value is a path on the page's own origin, as the browser
 * that will request it resolves the value.
 *
 * Parsed rather than read off the first characters, because the two disagree:
 * the WHATWG parser both halves resolve this value with reads `\` as `/` inside
 * an authority, so `/\host/steal` and `/\/host/steal` each name another origin
 * while starting with one `/` and no second one. A value that still carries the
 * probe origin after resolution names no authority of its own, which is the
 * property that keeps a credential on this deployment.
 * @param path - the configured value, however malformed.
 * @returns true when the value is a root-absolute path on the page's own origin.
 */
export function isOwnOriginPath(path: string): boolean {
  if (!path.startsWith('/')) return false
  let resolved: URL
  try {
    resolved = new URL(path, PATH_PROBE_BASE)
  } catch (_valueNamesNoResolvableAddress) {
    // A value whose authority the parser refuses outright — `/\[oops` — is one
    // the browser refuses the same way, so it is not a path this gate can renew
    // on either.
    return false
  }
  return resolved.origin === PATH_PROBE_ORIGIN
}

/**
 * The longest wait one browser timer carries, in milliseconds: `setTimeout`
 * holds its delay in a signed 32-bit integer, and a browser fires a longer one
 * on the next tick rather than waiting it out.
 *
 * The browser half's `schedule` sleeps a longer wait in links of this length,
 * because it has one delay no configuration bounds: the expiry margin's, which
 * is whatever `exp` the deployment's token carries.
 */
export const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * The longest renewal interval either half accepts, in seconds: as long as one
 * browser timer carries.
 *
 * A configured value above it fails the row at load rather than being slept in
 * links the way a longer margin is, because it is a number no deployment means:
 * it names a schedule that first fires 24 days out, which no token this gate
 * accepts lives to reach.
 */
export const MAX_RENEWAL_INTERVAL_SECONDS = Math.floor(MAX_TIMER_DELAY_MS / 1000)

/** What the browser half needs to renew a token without leaving the page. */
export interface AuthGateRenewalSettings {
  /**
   * The deployment's renewal endpoint, as a path on the page's own origin. The
   * browser half sends `GET` there and reads the new token out of the answer.
   */
  path: string
  /**
   * How many seconds a token is held before the browser half asks for a new
   * one: above zero and at most {@link MAX_RENEWAL_INTERVAL_SECONDS}.
   */
  intervalSeconds: number
}

/** The browser-facing half of this plugin's configuration. */
export interface AuthGateSettings {
  /**
   * Where a visitor without a usable token is sent. The browser half appends
   * `?redirect=<encoded current URL>` verbatim, which is why the value may not
   * already carry a query string.
   */
  loginUrl: string
  /** Cookie the access token is mirrored into. */
  cookieName: string
  /** How long before expiry the browser half acts on the coming expiry. */
  refreshMarginSeconds: number
  /**
   * How this deployment renews a token, when it offers a way to. Absent means
   * it does not, and the expiry margin sends the visitor through the login page
   * instead. Both fields travel together, so a browser that has this document
   * either renews or does not.
   */
  renewal?: AuthGateRenewalSettings
}

/**
 * Whether a value has the three-segment form of a JWT. Shape only: signature
 * verification belongs to whoever issued the token and to the reverse proxy in
 * front of this process, and neither half of this package is in a position to
 * do it.
 * @param value - the candidate token, however malformed.
 * @returns true when the value is a non-empty three-segment base64url string.
 */
export function isJwtShaped(value: unknown): value is string {
  return typeof value === 'string' && /^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)
}

/**
 * Read one posted token document. A wire boundary: the document crossed a
 * process, so its own contract is checked here rather than trusted from the
 * type.
 * @param body - the decoded request body, however malformed.
 * @returns the token, or `undefined` when the body does not carry a
 * JWT-shaped one. The token itself is never named in a diagnostic.
 */
export function parseTokenPost(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { token } = body as { token?: unknown }
  return isJwtShaped(token) ? token : undefined
}
