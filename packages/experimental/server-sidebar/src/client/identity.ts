/**
 * Who the sidebar's footer says is signed in: the deployment's access token,
 * read out of `localStorage` and decoded for one claim.
 *
 * **Display only, and not authority.** Nothing here verifies a signature —
 * the party that can is the reverse proxy in front of this process, which has
 * already decided who is on the other end by the time a page loads. A forged
 * token changes the name in the footer and nothing else: this module grants
 * no access, gates no surface, and its value never leaves the browser. It is
 * also never model-visible; no session event carries it and no model request
 * can reach it.
 *
 * `storedToken` and `decodeJwtPayload` are literal copies of
 * `@deepseek-ai/dsh-experimental-auth-gate`'s own (`src/client/browser.ts`
 * and `src/client/gate.ts`), not imports of them: a cross-package value
 * import is not this repository's sanctioned way to couple two
 * client-adjacent plugins (`packages/client/AGENTS.md`'s export-discipline
 * section), and this sidebar must also work in a composition that does not
 * compose auth-gate at all. The storage key is a copy for the same reason —
 * it is a contract with the deployment's login page, which both packages
 * hold independently. Both copies must keep step with that package; see this
 * package's README.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/identity
 */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import { SERVER_IDENTITY_ROUTE, type ServerIdentitySettings } from '../route.ts'

/**
 * Must match `@deepseek-ai/dsh-experimental-auth-gate`'s
 * `ACCESS_TOKEN_STORAGE_KEY`: the key the deployment's own login page writes.
 */
const ACCESS_TOKEN_STORAGE_KEY = 'accessToken'

/**
 * One stored value with the login page's `Bearer` scheme removed.
 *
 * A literal copy of auth-gate's `storedToken` (see this module's doc). That
 * page stores `"Bearer <jwt>"`, because its own HTTP client puts the stored
 * value into the `Authorization` header verbatim; any casing of the scheme,
 * whitespace before it, and any run of whitespace after it are tolerated, and
 * everything else is left as it stands.
 * @param raw - the stored value, or `null` when nothing is stored.
 * @returns the bare token, unchanged when it carries no scheme, or `null`
 * when nothing is stored.
 */
export function storedToken(raw: string | null): string | null {
  return raw === null ? null : raw.replace(/^\s*Bearer\s+/i, '')
}

/**
 * Decode a JWT's payload without verifying anything.
 *
 * A literal copy of auth-gate's `decodeJwtPayload` (see this module's doc).
 * @param token - a JWT-shaped string.
 * @returns the payload object, or `undefined` when the segment is not
 * base64url-encoded JSON describing an object.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segment = token.slice(token.indexOf('.') + 1, token.lastIndexOf('.'))
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
  let decoded: unknown
  try {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (_payloadIsNotJson) {
    // A token whose payload does not decode carries no name to show; the
    // footer falls back to its anonymous placeholder.
    return undefined
  }
  // An array decodes as an object and carries no claims; a payload that is
  // not a claim set is one this module reads nothing out of.
  return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : undefined
}

/**
 * The name to show for one stored access token.
 * @param raw - the stored value, or `null` when nothing is stored.
 * @param claim - the claim the deployment carries the display name in.
 * @returns the name, or `undefined` when nothing is stored, the token does
 * not decode, or the claim is absent or not a non-empty string.
 */
export function displayNameFrom(raw: string | null, claim: string): string | undefined {
  const token = storedToken(raw)
  if (token === null) return undefined
  const value = decodeJwtPayload(token)?.[claim]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Read this package's browser-facing settings from its node half.
 *
 * Failure is contained rather than thrown, the same way `pages.ts` contains
 * its own: a deployment composing this sidebar without a webserver is an
 * ordinary composition, and a footer that cannot name the signed-in person
 * must not take the whole sidebar down with it.
 * @returns the settings, or `undefined` when the route is unreachable,
 * answers non-200, or answers a document with no usable claim name.
 */
export async function readIdentitySettings(): Promise<ServerIdentitySettings | undefined> {
  try {
    const response = await fetch(SERVER_IDENTITY_ROUTE, { cache: 'no-store' })
    if (!response.ok) return undefined
    // A wire boundary: the document crossed a process, so its own contract is
    // checked here rather than trusted from the type.
    const { displayNameClaim } = await response.json() as Partial<ServerIdentitySettings>
    return typeof displayNameClaim === 'string' && displayNameClaim.length > 0 ? { displayNameClaim } : undefined
  } catch (_routeUnreachable) {
    return undefined
  }
}

/**
 * Subscribe to another tab changing storage in a way that may have moved the
 * token. A literal copy of auth-gate's own storage watch, including its
 * `null`-key case; the listener re-reads rather than trusting the payload.
 * @param listener - called after each such change.
 * @returns the disposer removing the subscription.
 */
export function subscribeIdentity(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    // A `null` key is `localStorage.clear()`, which took the token with it.
    if (event.key === null || event.key === ACCESS_TOKEN_STORAGE_KEY) listener()
  }
  addEventListener('storage', onStorage)
  return () => { removeEventListener('storage', onStorage) }
}

/**
 * The current display name, read from storage.
 * @param claim - the configured claim, absent when the settings route
 * answered nothing usable.
 * @returns the name, or `undefined` when there is no claim to read or no
 * usable token to read it from.
 */
function readDisplayName(claim: string | undefined): string | undefined {
  return claim === undefined ? undefined : displayNameFrom(localStorage.getItem(ACCESS_TOKEN_STORAGE_KEY), claim)
}

/**
 * The footer's name as an observable source, so the shell's own component
 * subscribes to it through the framework's bound `use<Name>` hook rather than
 * mirroring storage into local state (`packages/client/AGENTS.md`'s reactive
 * read discipline).
 *
 * The source keeps no copy of the name: every snapshot re-reads storage, and
 * every storage change notifies every subscriber. A copy would have to be
 * refreshed from somewhere, and the only place to refresh it from is a
 * subscription — which leaves it stale for the stretch between this factory
 * running and the first mount, and again between an unmount and the next
 * mount, and lets whichever subscriber the refresh runs under swallow the
 * notification the others were owed. The name is a string, which
 * `useSyncExternalStore` compares by value, so a re-read finding the same
 * name renders nothing.
 * @param claim - the configured claim, absent when the settings route
 * answered nothing usable.
 * @returns the source, reading the name afresh each time it is asked.
 */
export function createDisplayNameSource(claim: string | undefined): HostObservable<string | undefined> {
  return {
    getSnapshot: () => readDisplayName(claim),
    subscribe: subscribeIdentity,
  }
}
