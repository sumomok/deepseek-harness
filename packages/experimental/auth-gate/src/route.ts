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

/** Prefix under which each configured MCP upstream gets its forwarding route; no trailing slash, which is the webserver's route form. */
export const AUTH_GATE_MCP_PREFIX = '/auth-gate/mcp'

/**
 * The `localStorage` key the access token is read from. Fixed rather than
 * configured: it is the key the deployment's own login page writes, so it is a
 * contract with that page rather than a choice this plugin makes.
 */
export const ACCESS_TOKEN_STORAGE_KEY = 'accessToken'

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
