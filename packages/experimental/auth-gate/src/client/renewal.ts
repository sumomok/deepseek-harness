/**
 * What the renewal exchange puts on the wire and reads back, as pure functions.
 *
 * Every value here is a contract with the deployment's own frontend rather than
 * a choice this package makes, so each one names where it was read off
 * `toy-core`, the runtime that frontend is built on:
 *
 * - the header table (`api/axios.js`, the request interceptor): the stored
 *   token verbatim on both `Authorization` and `CertificationToken`, whatever
 *   headers `localStorage.loginUserInfo` holds under them, and a fresh
 *   `TINY-REQUEST-ID` over all of it;
 * - the answer (`api/axios.js`, the response interceptor, and `tokenRenewal`):
 *   the response body itself, whose `token` field carries the new token;
 * - the stored form (`core/token.js`, `setToken`): the token exactly as the
 *   answer carried it, beside the time it was stored.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/renewal
 */

/**
 * Characters one request id is drawn from — the alphabet `randomString(16)`
 * draws over in `utils/commonUtils.js`.
 *
 * That call samples the alphabet without replacement, so its 16 characters are
 * all different; this one draws each position on its own, so a character can
 * repeat. The deployment reads the value as a trace id — it names one request in
 * that deployment's logs and authorizes nothing — so an id with a repeated
 * character serves it the same way, and one random byte reduced modulo the
 * alphabet length produces each position.
 */
const REQUEST_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz0123456789'

/** How many characters one request id carries, as that same call states it. */
export const REQUEST_ID_LENGTH = 16

/**
 * One `TINY-REQUEST-ID` value.
 * @param bytes - as many random bytes as the id has characters.
 * @returns the id, one character per byte.
 */
export function requestIdFrom(bytes: Uint8Array): string {
  let id = ''
  for (const byte of bytes) id += REQUEST_ID_ALPHABET.charAt(byte % REQUEST_ID_ALPHABET.length)
  return id
}

/**
 * The header table `localStorage.loginUserInfo` contributes.
 *
 * A durable boundary: the value is a document another program wrote, so what it
 * holds is checked here rather than trusted. A value that is absent, is not
 * JSON, or is not a JSON object contributes nothing — the deployment's own
 * client skips a `null` one the same way, and throws on the rest, which would
 * cost the renewal a request it can otherwise still make. Entries are read the
 * way axios reads that same table: a number or a boolean goes on the wire as
 * its own rendering, and a `null` or `undefined` one is no header at all.
 * Anything else is dropped, because a header value is a scalar and a stored
 * object is a page's fault rather than a header.
 * @param raw - whatever storage held under that key, possibly nothing.
 * @returns the headers to send, empty where the value carries none.
 */
function loginUserInfoHeaders(raw: string | null): Record<string, string> {
  let parsed: unknown
  try {
    parsed = raw === null ? undefined : JSON.parse(raw) as unknown
  } catch (_valueIsNotJson) {
    // The deployment's own client throws here; this one sends the request
    // without the headers that value would have carried, which is the closer of
    // the two to renewing.
    return {}
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === 'string') headers[name] = value
    else if (typeof value === 'number' || typeof value === 'boolean') headers[name] = String(value)
  }
  return headers
}

/**
 * Whether a name is one an HTTP field can carry: the token RFC 7230 defines a
 * field name as.
 * @param name - one key of the stored header table.
 * @returns true when a request may carry a header under that name.
 */
function isHeaderName(name: string): boolean {
  return /^[!#$%&'*+.^`|~\w-]+$/.test(name)
}

/**
 * Whether a value is one an HTTP field can carry: free of the NUL, carriage
 * return, and line feed that `fetch` refuses a header value for.
 * @param value - one value of the stored header table, already a string.
 * @returns true when a request may carry that value.
 */
function isHeaderValue(value: string): boolean {
  return !/[\0\r\n]/.test(value)
}

/**
 * The headers one renewal request carries, in the order the deployment's own
 * client assembles them: its stored header table first, the token over it, and
 * the request id last.
 *
 * The three this function names replace a stored entry of the same name in any
 * casing, because `fetch` matches header names case-insensitively and combines
 * the values of two that match: a table holding `authorization` would otherwise
 * put a stale token beside the current one on the same header rather than under
 * it.
 *
 * A stored entry whose name or value is not one an HTTP field can carry is
 * dropped rather than sent. `fetch` throws on such a header, and the throw would
 * cost this tab every renewal it makes for as long as it is open — a token
 * expiring under a page nobody signed out of, over a table entry the renewal
 * does not need.
 * @param storedAuthorization - the access token exactly as storage holds it,
 * scheme included, which is what that client puts into both token headers.
 * @param loginUserInfo - whatever storage held under `loginUserInfo`.
 * @param requestId - a fresh {@link requestIdFrom} value.
 * @returns the complete header table.
 */
export function renewalHeaders(
  storedAuthorization: string,
  loginUserInfo: string | null,
  requestId: string,
): Record<string, string> {
  const own: Record<string, string> = {
    Authorization: storedAuthorization,
    CertificationToken: storedAuthorization,
    'TINY-REQUEST-ID': requestId,
  }
  const ownNames = new Set(Object.keys(own).map(name => name.toLowerCase()))
  const stored: Record<string, string> = {}
  for (const [name, value] of Object.entries(loginUserInfoHeaders(loginUserInfo))) {
    if (ownNames.has(name.toLowerCase())) continue
    if (!isHeaderName(name) || !isHeaderValue(value)) continue
    stored[name] = value
  }
  return { ...stored, ...own }
}

/**
 * Read the new token out of one renewal answer. A wire boundary: the document
 * came from another process, so its own contract is checked here rather than
 * trusted from the type.
 *
 * The value is returned exactly as the answer carried it, because that is what
 * gets stored: the deployment's pages put the stored value into their
 * `Authorization` header verbatim, scheme included. Whether it is a token this
 * gate can run on is the gate's own question, asked of the value this returns.
 *
 * An answer carrying an error code instead of a token needs no case of its own:
 * it carries no `token` field, which is already the answer this reads nothing
 * out of.
 * @param body - the decoded answer, however malformed.
 * @returns the stored form of the new token, or `undefined` when the answer
 * carries no string one. The token is never named in a diagnostic.
 */
export function parseRenewalAnswer(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const { token } = body as { token?: unknown }
  return typeof token === 'string' ? token : undefined
}

/**
 * When a token was stored, in the form the deployment's pages read it back
 * from: an ISO 8601 instant, which is what `dayjs` parses out of
 * `accessTokenTime` to measure a token's age.
 *
 * UTC rather than `dayjs().format()`'s local-offset rendering of the same
 * instant. The two differ only in how the offset is written, `isTokenRenewal` is
 * the only reader and it takes a difference, and this rendering is the one that
 * does not change with the timezone the browser happens to be in.
 * @param nowMs - the current time in milliseconds.
 * @returns the timestamp to store.
 */
export function accessTokenTimestamp(nowMs: number): string {
  return new Date(nowMs).toISOString()
}
