/**
 * Zero-dependency login gate for a dsh web console, run in one of two modes
 * chosen by PROXY_MODE. Every environment variable, its default, and the
 * values each known deployment sets are listed in this package's README
 * ("The deploy proxy and verifier"); `node proxy.mjs` reads them at start and
 * exits with a message naming the variable when one is invalid.
 *
 * `proxy` (the default) is a same-origin reverse proxy. One origin,
 * http://<PROXY_HOST>:<PROXY_PORT>, splits by path: the dsh console's own
 * routes go to the local dsh process on 127.0.0.1:<DSH_WEB_PORT>, and every
 * other path goes to the remote application at REMOTE_HOST:REMOTE_PORT. The
 * split is what makes content-frame's same-origin rule satisfiable: a
 * configured page URL must be a site-root-relative path
 * (packages/experimental/content-frame/src/pages.ts), so the remote
 * application has to answer on the shell's own origin. It is also what makes
 * auth-gate's login page reachable: `loginUrl` is opened on this origin.
 *
 * `verify` answers nginx `auth_request` subrequests for
 * deploy/nginx.console.conf: 200 admits, 401 refuses, 503 reports the
 * authentication service unavailable. It proxies nothing.
 *
 * Host and Origin are forwarded unchanged to dsh. The /api fence
 * (packages/client/connection/src/api-request-trust.ts) accepts any loopback
 * Host and then requires an attached Origin to equal that Host authority;
 * rewriting only Host to the dsh port would answer every /api call with 403.
 *
 * With LOGIN_GATE=on (the default) every request routed to dsh outside the
 * exempt list must carry a live customer login: the AUTH_COOKIE cookie (proxy
 * mode) or the Authorization header nginx sets (verify mode) is presented to
 * the authentication service's AUTH_CHECK_PATH. A login is live when that
 * service answers 2xx, the token's payload names a `login_uid`, the optional
 * claims checks pass, and, with AUTH_CHECK_REPLY=renewal, the reply's `token`
 * carries the same `login_uid` and `jti`. The token is not verified locally:
 * the customer system signs it with a symmetric key this gate does not hold.
 * Requests routed to the remote application are never gated; the remote
 * enforces its own login.
 *
 * The member assertion. Every request and WebSocket upgrade this gate
 * forwards has any client-supplied `x-dsh-member` header removed. When
 * MEMBER_ASSERTION_KEY_FILE names an Ed25519 private key, a request the gate
 * verified and forwards to dsh also carries a freshly signed assertion naming
 * the verified `login_uid`, and the verifier returns one on its 200; exempt
 * paths, remote paths, and a gate turned off carry none. The format is
 * `v1.<payload>.<signature>`: payload is the base64url of the JSON
 * `{"p": <login_uid as a string>, "aud": <MEMBER_ASSERTION_DEPLOYMENT_ID>,
 * "exp": <Unix seconds, issue time plus 120>}`, and signature is the base64url
 * Ed25519 signature over the ASCII string `v1.<payload>`. The member id and the
 * assertion are never written to a log line.
 *
 * A visitor with no dsh cookie is handed dsh's own launch-token exchange
 * instead of dsh's 401 when DSH_LAUNCH_TOKEN_FILE names the file the
 * deployment copied the launch token into (see sendExchange).
 * @module @deepseek-ai/dsh-experimental-server-base/deploy/proxy
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { createPrivateKey, sign } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/**
 * @typedef {object} ClaimsPolicy
 * @property {string | undefined} expectedIss - EXPECTED_ISS: the `iss` a token must carry.
 * @property {string[] | undefined} allowedTenants - ALLOWED_TENANTS: a token's `tenants` must list one of these.
 * @property {string[] | undefined} allowedAppIds - ALLOWED_APP_IDS: a token's `login_app_id` must be one of these.
 */

/**
 * @typedef {{ ok: true, member: string, jti: string | undefined } | { ok: false, reason: string }} Inspection
 */

/**
 * @typedef {{ outcome: 'admitted', member: string } | { outcome: 'refused', reason: string } | { outcome: 'unavailable', detail: string }} Verification
 */

/**
 * @typedef {object} Gate
 * @property {(credential: string) => Promise<Verification>} authorize - decide one credential, cached and coalesced.
 * @property {() => void} close - release the gate's outbound sockets.
 */

/**
 * @typedef {object} Runtime
 * @property {(line: string) => void} log - receives every log line.
 * @property {() => number} now - the current time in milliseconds.
 */

/**
 * @typedef {object} Settings
 * @property {'proxy' | 'verify'} mode - PROXY_MODE.
 * @property {boolean} loginGate - LOGIN_GATE.
 * @property {string} listenHost - PROXY_HOST.
 * @property {number} listenPort - PROXY_PORT.
 * @property {number | undefined} dshPort - DSH_WEB_PORT, proxy mode only.
 * @property {string | undefined} remoteHost - REMOTE_HOST, proxy mode only.
 * @property {number | undefined} remotePort - REMOTE_PORT, proxy mode only.
 * @property {URL} authOrigin - AUTH_ORIGIN.
 * @property {Buffer | undefined} authCa - the contents of AUTH_CA_FILE.
 * @property {string} authCookie - AUTH_COOKIE.
 * @property {string} authCheckPath - AUTH_CHECK_PATH.
 * @property {'renewal' | 'status'} authCheckReply - AUTH_CHECK_REPLY.
 * @property {number} authCacheSeconds - AUTH_CACHE_SECONDS.
 * @property {ClaimsPolicy} claims - the optional claims checks.
 * @property {{ privateKey: import('node:crypto').KeyObject, deploymentId: string } | undefined} assertion - the signing key and audience, when this deployment signs.
 * @property {string | undefined} launchTokenFile - DSH_LAUNCH_TOKEN_FILE, proxy mode only.
 */

/** Request header that carries the member assertion to dsh; console-members reads the same name. */
export const MEMBER_HEADER = 'x-dsh-member'
/** Seconds a member assertion stays valid after it is signed. */
export const ASSERTION_LIFETIME_SECONDS = 120
/** Format tag every assertion starts with, and the first part of the signed string. */
const ASSERTION_VERSION = 'v1'

/** Address of the local dsh process. dsh listens only on loopback, which is what keeps it unreachable except through this gate. */
const DSH_HOST = '127.0.0.1'
/** How long a refusal is remembered, so an expired token cannot spin the authentication service. */
const AUTH_REFUSED_CACHE_MS = 10_000
/** How long the check itself may take before the gate calls the authentication service unavailable. */
const AUTH_CHECK_TIMEOUT_MS = 8_000
/** Cache ceiling; each entry is one presented credential string. */
const AUTH_CACHE_LIMIT = 500
/** Outbound connections the checks may hold against the authentication service at once. */
const AUTH_CHECK_MAX_SOCKETS = 16
/** Checks that may wait on the authentication service at once; past it the gate answers 503. */
const AUTH_CHECK_MAX_INFLIGHT = 64
/** Largest renewal reply body the gate reads; a longer one counts as the service being unavailable. */
const AUTH_REPLY_LIMIT_BYTES = 65_536
/** One-shot marker set with the exchange redirect; see sendExchange. */
const EXCHANGE_MARKER_COOKIE = 'dsh-auth-exchange'
const EXCHANGE_MARKER_SECONDS = 15

/**
 * Paths the local dsh console owns. Everything else belongs to the remote
 * application: its bundles build API URLs from site-root-relative constants
 * (/nrms-*, /iot-basic-auth, /toy-proxy, /manager, /uav-analysis, ...) and the
 * login sub-app adds its own, so an allowlist of remote prefixes keeps growing
 * a hole at a time. The console's own surface is small and fixed: the SPA
 * shell (apps/web/dist: index.html, assets/, the two favicons,
 * manifest.webmanifest), /sw.js, /plugins (client plugin modules and their
 * event stream), and /api, which also carries the one WebSocket upgrade
 * route, /api/remote.mux (packages/api/gateway/src/stream-protocol.ts).
 */
const DSH_EXACT = new Set(['/', '/index.html', '/sw.js', '/favicon.svg', '/favicon-dark.svg', '/manifest.webmanifest'])
// Plugin route roots: grep -rhoE "ROUTE[A-Z_]* *= *'/[^']+'" packages apps --include='*.ts' | sort -u,
// plus the open-in-app paths (packages/host/open-in-app/src/shared.ts).
// /component-surface is the view directory this composition's show-component row serves.
const DSH_PREFIXES = [
  '/assets',
  '/api',
  '/plugins',
  '/auth-gate',
  '/component-surface',
  '/component-kit',
  '/skill-pack',
  '/content-app',
  '/content-frame',
  '/server-menu',
  '/show-chart',
  '/render',
  '/open-in-app',
]

/**
 * dsh paths the login gate lets through unchecked, because a browser needs them
 * before anyone is logged in: the SPA shell, its static assets (/assets), the
 * client plugin modules (/plugins), and the route the browser half of auth-gate
 * reads to find the customer login page. Prefixes match the way DSH_PREFIXES
 * do: the path equals the prefix or continues with a slash.
 */
const GATE_EXEMPT_EXACT = new Set([
  '/',
  '/index.html',
  '/sw.js',
  '/favicon.svg',
  '/favicon-dark.svg',
  '/manifest.webmanifest',
  '/auth-gate/settings',
  // The data page's request prefix (`bizBasePath`, no secret in it), read
  // once when component-kit's browser half starts — with the shell, before
  // anyone is logged in — and memoized for the page's life, so a gated 401
  // here would keep every data page shut until the next full reload.
  '/component-kit/settings',
])
const GATE_EXEMPT_PREFIXES = ['/assets', '/plugins']

/** Headers that describe one hop and must not be copied to the next one. */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * The path dsh will route this request as. dsh's web server resolves the raw
 * target with `new URL(req.url ?? '/', 'http://x').pathname` before matching
 * routes (packages/host/webserver/src/index.ts), and that parser resolves `..`
 * and `%2e%2e` segments. Classification must see the same pathname as the
 * routing target: on the raw target, /plugins/../api/x reads as an exempt
 * asset and still reaches /api.
 * @param {string | undefined} url - the raw request target.
 * @returns {string} the pathname dsh will match routes against.
 * @throws {TypeError} when the target does not parse as a URL.
 */
export function requestPathname(url) {
  return new URL(url ?? '/', 'http://x').pathname
}

/**
 * Whether a request path belongs to the remote application.
 * @param {string} pathname - request path, query stripped.
 * @returns {boolean} true when the remote origin owns it.
 */
export function isRemote(pathname) {
  if (DSH_EXACT.has(pathname)) return false
  return !DSH_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
}

/**
 * Whether a dsh-routed path is reachable without a customer login.
 * @param {string} pathname - request path, query stripped.
 * @returns {boolean} true when the gate lets it through unchecked.
 */
export function isGateExempt(pathname) {
  if (GATE_EXEMPT_EXACT.has(pathname)) return true
  return GATE_EXEMPT_PREFIXES.some(prefix => pathname === prefix || pathname.startsWith(prefix + '/'))
}

/**
 * Copy headers for one hop. The member header is removed whatever its casing
 * and whichever way the headers travel, and is then set only from `assertion`.
 * @param {import('node:http').IncomingHttpHeaders} headers - inbound headers.
 * @param {string | undefined} host - replacement Host, or undefined to keep the inbound one.
 * @param {string | undefined} [assertion] - a freshly signed member assertion to attach, or undefined to attach none.
 * @returns {Record<string, string | string[]>} headers for the next hop.
 */
export function forwardHeaders(headers, host, assertion) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (HOP_BY_HOP.has(lower) || lower === MEMBER_HEADER || value === undefined) continue
    out[name] = value
  }
  if (host !== undefined) out.host = host
  if (assertion !== undefined) out[MEMBER_HEADER] = assertion
  return out
}

/**
 * Strip the framing and cookie attributes that would break an http loopback
 * origin embedding the remote application in an iframe.
 * @param {import('node:http').IncomingHttpHeaders} headers - upstream response headers.
 * @returns {Record<string, string | string[]>} headers for the client.
 */
export function remoteResponseHeaders(headers) {
  const out = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue
    if (name === 'x-frame-options') continue
    if (name === 'content-security-policy' || name === 'content-security-policy-report-only') {
      const stripped = String(value)
        .split(';')
        .filter(directive => directive.trim().toLowerCase().split(/\s+/)[0] !== 'frame-ancestors')
        .join(';')
        .trim()
      if (stripped !== '') out[name] = stripped
      continue
    }
    if (name === 'set-cookie') {
      const cookies = Array.isArray(value) ? value : [String(value)]
      out[name] = cookies.map(cookie => cookie
        .split(';')
        .filter((attribute) => {
          const key = attribute.trim().toLowerCase()
          return key !== 'secure' && !key.startsWith('domain=')
        })
        .join(';'))
      continue
    }
    out[name] = value
  }
  return out
}

/**
 * Read the customer token the browser half of auth-gate mirrors into a cookie
 * and turn it into the credential the authentication service expects. The
 * cookie holds a bare JWT; a value that already names the scheme is presented
 * verbatim.
 * @param {string | undefined} header - the inbound Cookie header, if any.
 * @param {string} cookieName - the cookie the token is mirrored into.
 * @returns {string | undefined} the credential to present, or undefined when there is no usable cookie.
 */
export function presentedCredential(header, cookieName) {
  if (header === undefined) return undefined
  for (const pair of header.split(';')) {
    const entry = pair.trim()
    const separator = entry.indexOf('=')
    if (separator < 0 || entry.slice(0, separator) !== cookieName) continue
    let value
    try {
      value = decodeURIComponent(entry.slice(separator + 1))
    } catch (_malformedEscape) {
      // decodeURIComponent throws URIError on a malformed percent escape. A
      // cookie value this proxy cannot decode is no credential at all.
      return undefined
    }
    return headerCredential(value)
  }
  return undefined
}

/**
 * Turn a credential carrier's value into the credential to present. A value
 * that names the Bearer scheme is presented verbatim, a bare value gets the
 * scheme added, and the scheme alone, as nginx's `"Bearer $cookie_…"` renders
 * an absent cookie, is no credential.
 * @param {string | undefined} value - an Authorization header or decoded cookie value.
 * @returns {string | undefined} the credential, or undefined when the value carries none.
 */
export function headerCredential(value) {
  if (value === undefined) return undefined
  const trimmed = value.trim()
  if (trimmed === '' || /^bearer$/i.test(trimmed)) return undefined
  // A JWT is base64url plus dots and the scheme adds one space, so nothing
  // legitimate is excluded; anything else would be an invalid HTTP header
  // value and http.request would throw on it.
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return undefined
  return /^bearer /i.test(trimmed) ? trimmed : `Bearer ${trimmed}`
}

/**
 * The bare token inside a credential, without the Bearer scheme.
 * @param {string} credential - a credential or a stored token, with or without the scheme.
 * @returns {string} the token.
 */
function bareToken(credential) {
  return credential.replace(/^bearer\s+/i, '')
}

/**
 * JSON.parse reviver that keeps every number as its exact source text. A
 * 19-digit `login_uid` written as a JSON number does not survive conversion to
 * a JavaScript number, and two members must never collapse into one id.
 * @param {string} _key - the property name.
 * @param {unknown} value - the parsed value.
 * @param {{ source?: string } | undefined} context - source text access, present on Node 21 and later.
 * @returns {unknown} the value, with a number replaced by its digits.
 */
function keepNumberSource(_key, value, context) {
  return typeof value === 'number' ? context?.source : value
}

/**
 * Whether this runtime gives JSON.parse revivers the source text of a number.
 * @returns {boolean} true when numeric claims can be read exactly.
 */
function jsonKeepsNumberSource() {
  return JSON.parse('12345678901234567890', keepNumberSource) === '12345678901234567890'
}

/**
 * Decode a JWT's payload claims without verifying its signature. Numeric
 * claim values come back as their exact source digits.
 * @param {string} token - the bare JWT, no scheme.
 * @returns {Record<string, unknown> | undefined} the payload object, or undefined when the token is not three base64url parts with a JSON object payload.
 */
export function decodeClaims(token) {
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every(part => /^[\w-]+$/.test(part))) return undefined
  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'), keepNumberSource)
  } catch (_payloadIsNotJson) {
    // A payload that is not JSON names no member; the caller refuses it.
    return undefined
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  return payload
}

/**
 * A claim value as text: a non-empty string, or a number already carried as
 * its digits by decodeClaims.
 * @param {unknown} value - one claim value.
 * @returns {string | undefined} the text, or undefined for any other value.
 */
function claimText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * The tenants a token's `tenants` claim lists: an array of values, or one
 * string read as a comma-separated list.
 * @param {unknown} value - the `tenants` claim.
 * @returns {string[]} the listed tenants, empty when the claim lists none.
 */
function tenantsOf(value) {
  if (Array.isArray(value)) return value.map(claimText).filter(tenant => tenant !== undefined)
  const text = claimText(value)
  return text === undefined ? [] : text.split(',').map(tenant => tenant.trim()).filter(tenant => tenant !== '')
}

/**
 * The first claims check a token fails, or undefined when it passes them all.
 * A check runs only when its policy field is set, and a token missing the
 * claim a running check reads fails it.
 * @param {Record<string, unknown>} claims - decoded token claims.
 * @param {ClaimsPolicy} policy - the configured checks.
 * @returns {'iss' | 'tenants' | 'app-id' | undefined} the failed check.
 */
export function claimsRefusal(claims, policy) {
  if (policy.expectedIss !== undefined && claimText(claims.iss) !== policy.expectedIss) return 'iss'
  if (policy.allowedTenants !== undefined && !tenantsOf(claims.tenants).some(tenant => policy.allowedTenants.includes(tenant))) return 'tenants'
  if (policy.allowedAppIds !== undefined) {
    const appId = claimText(claims.login_app_id)
    if (appId === undefined || !policy.allowedAppIds.includes(appId)) return 'app-id'
  }
  return undefined
}

/**
 * What a presented credential claims before the authentication service is
 * asked: the member it names and its token id, or why it cannot be admitted
 * whatever the service answers.
 * @param {string} credential - the credential, scheme included.
 * @param {ClaimsPolicy} policy - the configured claims checks.
 * @returns {Inspection} the member and `jti`, or the refusal reason.
 */
export function inspectCredential(credential, policy) {
  const claims = decodeClaims(bareToken(credential))
  if (claims === undefined) return { ok: false, reason: 'undecodable' }
  const member = claimText(claims.login_uid)
  if (member === undefined) return { ok: false, reason: 'no-member' }
  const refusal = claimsRefusal(claims, policy)
  if (refusal !== undefined) return { ok: false, reason: refusal }
  return { ok: true, member, jti: claimText(claims.jti) }
}

/**
 * The token a renewal reply carries in its `token` field. A wire boundary: the
 * body comes from another process.
 * @param {string} body - the reply body.
 * @returns {string | undefined} the token as the reply carries it, or undefined when there is none.
 */
function renewalToken(body) {
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch (_replyIsNotJson) {
    // A reply that is not JSON carries no token, which the caller refuses.
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  return typeof parsed.token === 'string' ? parsed.token : undefined
}

/**
 * Decide a credential from the authentication service's answer. 401 and 403
 * refuse; any other non-2xx status reports the service unavailable. A 2xx
 * admits the member the submitted token names, and with `reply` set to
 * `renewal` only when the reply's `token` names the same `login_uid` and the
 * same `jti` as the submitted one.
 * @param {{ status: number, body: string }} answer - the service's status and reply body.
 * @param {{ member: string, jti: string | undefined }} identity - what the submitted token claims.
 * @param {'renewal' | 'status'} reply - whether the reply body is checked.
 * @returns {Verification} the decision.
 */
export function verdictOf(answer, identity, reply) {
  const { status } = answer
  if (status === 401 || status === 403) return { outcome: 'refused', reason: 'service' }
  if (status < 200 || status >= 300) return { outcome: 'unavailable', detail: String(status) }
  if (reply === 'renewal') {
    const replied = renewalToken(answer.body)
    const claims = replied === undefined ? undefined : decodeClaims(bareToken(replied))
    if (identity.jti === undefined || claims === undefined
      || claimText(claims.login_uid) !== identity.member || claimText(claims.jti) !== identity.jti) {
      return { outcome: 'refused', reason: 'reply-mismatch' }
    }
  }
  return { outcome: 'admitted', member: identity.member }
}

/**
 * Sign one member assertion in the documented `v1.<payload>.<signature>` format.
 * @param {string} member - the verified `login_uid`.
 * @param {string} deploymentId - the audience, MEMBER_ASSERTION_DEPLOYMENT_ID.
 * @param {import('node:crypto').KeyObject} privateKey - the Ed25519 private key.
 * @param {number} nowSeconds - the issue time in Unix seconds.
 * @returns {string} the assertion, valid until `nowSeconds` plus ASSERTION_LIFETIME_SECONDS.
 */
export function signAssertion(member, deploymentId, privateKey, nowSeconds) {
  const payload = Buffer.from(JSON.stringify({ p: member, aud: deploymentId, exp: nowSeconds + ASSERTION_LIFETIME_SECONDS })).toString('base64url')
  const signed = `${ASSERTION_VERSION}.${payload}`
  return `${signed}.${sign(null, Buffer.from(signed, 'ascii'), privateKey).toString('base64url')}`
}

/**
 * One environment value, with an empty string read as unset.
 * @param {Record<string, string | undefined>} env - the environment.
 * @param {string} name - the variable name.
 * @returns {string | undefined} the value, or undefined when unset or empty.
 */
function envText(env, name) {
  const value = env[name]
  return value === undefined || value === '' ? undefined : value
}

/**
 * One environment value restricted to a closed set.
 * @param {Record<string, string | undefined>} env - the environment.
 * @param {string} name - the variable name.
 * @param {readonly string[]} allowed - the accepted values; the first is the default.
 * @returns {string} the value.
 * @throws {Error} when the value is outside the set.
 */
function envChoice(env, name, allowed) {
  const value = envText(env, name) ?? allowed[0]
  if (!allowed.includes(value)) throw new Error(`proxy: ${name} must be one of ${allowed.join(', ')}`)
  return value
}

/**
 * One environment value read as a whole number in a range.
 * @param {Record<string, string | undefined>} env - the environment.
 * @param {string} name - the variable name.
 * @param {string | undefined} fallback - the default, or undefined when the variable is required.
 * @param {number} min - the smallest accepted value.
 * @param {number} max - the largest accepted value.
 * @returns {number} the value.
 * @throws {Error} when the value is missing or not a whole number in range.
 */
function envInteger(env, name, fallback, min, max) {
  const value = Number(envText(env, name) ?? fallback ?? '')
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`proxy: ${name} must be a whole number from ${String(min)} to ${String(max)}`)
  }
  return value
}

/**
 * One environment value read as a comma-separated list.
 * @param {Record<string, string | undefined>} env - the environment.
 * @param {string} name - the variable name.
 * @returns {string[] | undefined} the entries, or undefined when the variable is unset.
 * @throws {Error} when the variable is set but lists nothing.
 */
function envList(env, name) {
  const value = envText(env, name)
  if (value === undefined) return undefined
  const entries = value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  if (entries.length === 0) throw new Error(`proxy: ${name} is set but lists no value`)
  return entries
}

/**
 * Read and validate this process's configuration from the environment. Every
 * misconfiguration throws, so `node proxy.mjs` exits before it listens.
 * @param {Record<string, string | undefined>} env - the environment, normally `process.env`.
 * @param {(path: string) => Buffer} [readFile] - reads the key and trust-store files.
 * @returns {Settings} the validated settings.
 * @throws {Error} naming the variable that is missing, malformed, or contradicts another.
 */
export function readSettings(env, readFile = readFileSync) {
  if (!jsonKeepsNumberSource()) throw new Error('proxy: this Node runtime gives JSON.parse revivers no source text; numeric claims cannot be read exactly')
  const mode = /** @type {'proxy' | 'verify'} */ (envChoice(env, 'PROXY_MODE', ['proxy', 'verify']))
  const loginGate = envChoice(env, 'LOGIN_GATE', ['on', 'off']) === 'on'
  if (mode === 'verify' && !loginGate) throw new Error('proxy: PROXY_MODE=verify is the login gate and needs LOGIN_GATE=on')
  const listenHost = envText(env, 'PROXY_HOST') ?? '127.0.0.1'
  const listenPort = envInteger(env, 'PROXY_PORT', '8082', 1, 65_535)

  let dshPort
  let remoteHost
  let remotePort
  if (mode === 'proxy') {
    dshPort = envInteger(env, 'DSH_WEB_PORT', undefined, 1, 65_535)
    remoteHost = envText(env, 'REMOTE_HOST')
    if (remoteHost === undefined) throw new Error('proxy: REMOTE_HOST must name the remote application host')
    remotePort = envInteger(env, 'REMOTE_PORT', undefined, 1, 65_535)
  }

  const originText = envText(env, 'AUTH_ORIGIN') ?? (mode === 'proxy' ? `http://${String(remoteHost)}:${String(remotePort)}` : undefined)
  if (originText === undefined) throw new Error('proxy: AUTH_ORIGIN must name the authentication service in PROXY_MODE=verify')
  let authOrigin
  try {
    authOrigin = new URL(originText)
  } catch (_notAUrl) {
    throw new Error('proxy: AUTH_ORIGIN must be an http or https origin')
  }
  if ((authOrigin.protocol !== 'http:' && authOrigin.protocol !== 'https:')
    || authOrigin.pathname !== '/' || authOrigin.search !== '' || authOrigin.hash !== '' || authOrigin.username !== '') {
    throw new Error('proxy: AUTH_ORIGIN must be an http or https origin with no path, query, or credentials')
  }
  const caFile = envText(env, 'AUTH_CA_FILE')
  if (caFile !== undefined && authOrigin.protocol !== 'https:') throw new Error('proxy: AUTH_CA_FILE needs an https AUTH_ORIGIN')
  const authCa = caFile === undefined ? undefined : readFile(caFile)

  const authCheckPath = envText(env, 'AUTH_CHECK_PATH') ?? '/nrms-auth/api/renewal'
  if (!authCheckPath.startsWith('/')) throw new Error('proxy: AUTH_CHECK_PATH must be a path starting with /')
  const authCookie = envText(env, 'AUTH_COOKIE') ?? 'accessToken'
  if (!/^[!#$%&'*+.^`|~\w-]+$/.test(authCookie)) throw new Error('proxy: AUTH_COOKIE must be a cookie name')

  const keyFile = envText(env, 'MEMBER_ASSERTION_KEY_FILE')
  const deploymentId = envText(env, 'MEMBER_ASSERTION_DEPLOYMENT_ID')
  let assertion
  if (keyFile !== undefined) {
    if (deploymentId === undefined || deploymentId.trim() === '') throw new Error('proxy: MEMBER_ASSERTION_KEY_FILE needs MEMBER_ASSERTION_DEPLOYMENT_ID')
    if (!loginGate) throw new Error('proxy: MEMBER_ASSERTION_KEY_FILE needs LOGIN_GATE=on, because only a verified login names a member')
    let privateKey
    try {
      privateKey = createPrivateKey(readFile(keyFile))
    } catch (_unreadableKey) {
      throw new Error('proxy: MEMBER_ASSERTION_KEY_FILE must name a readable PEM private key')
    }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('proxy: MEMBER_ASSERTION_KEY_FILE must hold an Ed25519 private key')
    assertion = { privateKey, deploymentId }
  } else if (deploymentId !== undefined) {
    throw new Error('proxy: MEMBER_ASSERTION_DEPLOYMENT_ID is set but MEMBER_ASSERTION_KEY_FILE is not')
  }

  return {
    mode,
    loginGate,
    listenHost,
    listenPort,
    dshPort,
    remoteHost,
    remotePort,
    authOrigin,
    authCa,
    authCookie,
    authCheckPath,
    authCheckReply: /** @type {'renewal' | 'status'} */ (envChoice(env, 'AUTH_CHECK_REPLY', ['renewal', 'status'])),
    authCacheSeconds: envInteger(env, 'AUTH_CACHE_SECONDS', '30', 0, 86_400),
    claims: {
      expectedIss: envText(env, 'EXPECTED_ISS'),
      allowedTenants: envList(env, 'ALLOWED_TENANTS'),
      allowedAppIds: envList(env, 'ALLOWED_APP_IDS'),
    },
    assertion,
    launchTokenFile: mode === 'proxy' ? envText(env, 'DSH_LAUNCH_TOKEN_FILE') : undefined,
  }
}

/** @type {Verification} */
const NO_CREDENTIAL = { outcome: 'refused', reason: 'no-credential' }

/**
 * The login check against the authentication service, with its cache and its
 * coalescing of concurrent checks of one credential.
 * @param {Settings} settings - validated settings.
 * @param {Runtime} runtime - the log sink and clock.
 * @returns {Gate} the gate.
 */
export function createGate(settings, runtime) {
  const secure = settings.authOrigin.protocol === 'https:'
  const transport = secure ? https : http
  // Login checks get their own pool: a flood of distinct tokens would otherwise
  // open one outbound socket per request and make this console an amplifier
  // against the customer's authentication service.
  const agent = secure
    ? new https.Agent({ keepAlive: true, maxSockets: AUTH_CHECK_MAX_SOCKETS, ...(settings.authCa === undefined ? {} : { ca: settings.authCa }) })
    : new http.Agent({ keepAlive: true, maxSockets: AUTH_CHECK_MAX_SOCKETS })
  /** @type {Map<string, { verification: Verification, expires: number }>} decided credentials, in insertion order. */
  const cache = new Map()
  /** @type {Map<string, Promise<Verification>>} checks in flight, one per credential. */
  const inflight = new Map()
  const checkLabel = `GET ${settings.authCheckPath}`

  /**
   * Ask the authentication service about one credential. The reply body is
   * read, bounded, only where the verdict needs it, and is never logged.
   * @param {string} credential - the value sent as authorization and certificationtoken.
   * @returns {Promise<{ status: number, body: string } | { error: string }>} the answer, or why there is none.
   */
  const ask = credential => new Promise((resolve) => {
    let settled = false
    /** @param {{ status: number, body: string } | { error: string }} answer - the outcome. */
    const settle = (answer) => {
      if (settled) return
      settled = true
      resolve(answer)
    }
    try {
      const request = transport.request({
        protocol: settings.authOrigin.protocol,
        hostname: settings.authOrigin.hostname.replace(/^\[|\]$/g, ''),
        port: settings.authOrigin.port === '' ? undefined : Number(settings.authOrigin.port),
        method: 'GET',
        path: settings.authCheckPath,
        headers: {
          authorization: credential,
          certificationtoken: credential,
          accept: 'application/json',
          host: settings.authOrigin.host,
        },
        agent,
      }, (response) => {
        const status = response.statusCode ?? 0
        if (settings.authCheckReply === 'status' || status < 200 || status >= 300) {
          response.resume()
          settle({ status, body: '' })
          return
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > AUTH_REPLY_LIMIT_BYTES) {
            settle({ error: 'reply-too-large' })
            request.destroy()
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => settle({ status, body: Buffer.concat(chunks).toString('utf8') }))
        response.on('error', error => settle({ error: String(error.code ?? error.name) }))
      })
      request.setTimeout(AUTH_CHECK_TIMEOUT_MS, () => {
        settle({ error: 'timeout' })
        request.destroy()
      })
      request.on('error', error => settle({ error: String(error.code ?? error.name) }))
      request.end()
    } catch (error) {
      // request() validates the header values it is given and throws
      // synchronously; this promise is awaited inside the server's handlers,
      // where a rejection would take the process down.
      settle({ error: String(error.code ?? error.name) })
    }
  })

  /**
   * Decide one credential from scratch.
   * @param {string} credential - the credential, scheme included.
   * @returns {Promise<Verification>} the decision.
   */
  const check = async (credential) => {
    const identity = inspectCredential(credential, settings.claims)
    if (!identity.ok) {
      runtime.log(`proxy: login check ${checkLabel} -> refused (${identity.reason})`)
      return { outcome: 'refused', reason: identity.reason }
    }
    const answer = await ask(credential)
    const verification = 'error' in answer
      ? { outcome: 'unavailable', detail: answer.error }
      : verdictOf(answer, identity, settings.authCheckReply)
    if (verification.outcome === 'unavailable') runtime.log(`proxy: login check ${checkLabel} -> ${verification.detail}`)
    else if (verification.outcome === 'refused' && verification.reason !== 'service') runtime.log(`proxy: login check ${checkLabel} -> refused (${verification.reason})`)
    return verification
  }

  return {
    authorize(credential) {
      const cached = cache.get(credential)
      if (cached !== undefined && cached.expires > runtime.now()) return Promise.resolve(cached.verification)
      const pending = inflight.get(credential)
      if (pending !== undefined) return pending
      // A new check past the ceiling is refused rather than queued: distinct
      // tokens defeat both the cache and the coalescing, and the service is
      // the customer's, not ours.
      if (inflight.size >= AUTH_CHECK_MAX_INFLIGHT) {
        runtime.log(`proxy: login check ${checkLabel} -> inflight-limit`)
        return Promise.resolve({ outcome: 'unavailable', detail: 'inflight-limit' })
      }
      const decided = check(credential).then((verification) => {
        // An unavailable service is never cached, so the next request asks again.
        if (verification.outcome !== 'unavailable') {
          if (!cache.has(credential) && cache.size >= AUTH_CACHE_LIMIT) {
            const oldest = cache.keys().next()
            if (!oldest.done) cache.delete(oldest.value)
          }
          const ttl = verification.outcome === 'admitted' ? settings.authCacheSeconds * 1000 : AUTH_REFUSED_CACHE_MS
          cache.set(credential, { verification, expires: runtime.now() + ttl })
        }
        return verification
      }).finally(() => {
        inflight.delete(credential)
      })
      inflight.set(credential, decided)
      return decided
    },
    close() {
      agent.destroy()
    },
  }
}

/**
 * The assertion to attach for one admitted member, or undefined when this
 * deployment signs none.
 * @param {Settings} settings - validated settings.
 * @param {Runtime} runtime - supplies the issue time.
 * @param {string} member - the verified `login_uid`.
 * @returns {string | undefined} a freshly signed assertion.
 */
function assertionFor(settings, runtime, member) {
  if (settings.assertion === undefined) return undefined
  return signAssertion(member, settings.assertion.deploymentId, settings.assertion.privateKey, Math.floor(runtime.now() / 1000))
}

/**
 * The launch token of the running dsh process, read fresh on every exchange:
 * the file is a few dozen bytes and only a dsh restart changes it.
 * @param {string | undefined} file - DSH_LAUNCH_TOKEN_FILE.
 * @returns {string | undefined} the token, or undefined when it is unavailable.
 */
function launchToken(file) {
  if (file === undefined) return undefined
  let contents
  try {
    contents = readFileSync(file, 'utf8')
  } catch (_tokenFileUnreadable) {
    // Missing, unreadable or removed: the deployment reports a capture failure
    // at startup, and the caller falls through to dsh, which answers its own
    // 401 naming the token URL.
    return undefined
  }
  const token = contents.trim()
  return token === '' ? undefined : token
}

/**
 * Whether the inbound Cookie header carries a cookie of this exact name.
 * @param {string | undefined} header - the inbound Cookie header, if any.
 * @param {string} name - the cookie name to look for.
 * @returns {boolean} true when present.
 */
function hasCookie(header, name) {
  if (header === undefined) return false
  return header.split(';').some(pair => pair.trim().split('=')[0] === name)
}

/**
 * Whether a request is one dsh's 401 may be answered with the launch-token
 * exchange: a root index request without a token query and without the
 * one-shot marker of an exchange that already failed. The decision is dsh's
 * answer, never the presence of a `dsh-auth-*` cookie: the cookie name is a
 * hash of the Host authority, so a cookie a previous dsh process signed for
 * this same origin is presented, refused by dsh, and would otherwise strand
 * the visitor on the 401 with no exchange ever offered.
 * @param {import('node:http').IncomingMessage} req - the inbound request.
 * @param {string} pathname - request path, query stripped.
 * @returns {boolean} true when a dsh 401 on this request should become the exchange redirect.
 */
function exchangeable(req, pathname) {
  if (pathname !== '/') return false
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  if (new URL(req.url ?? '/', 'http://x').searchParams.has('token')) return false
  return !hasCookie(req.headers.cookie, EXCHANGE_MARKER_COOKIE)
}

// dsh's own launch-token exchange, performed for any admitted visitor.
//
// dsh's browser auth (packages/client/connection/src/browser-auth.ts) answers
// `GET /?token=<launch token>` with a signed cookie and a 303 back to `/`, and
// answers every other `/` that carries no cookie this dsh process signed with a
// 401 telling the reader to reopen the URL dsh printed. In these deployments
// that token is not a second secret to keep: dsh is reachable only through
// this proxy, and the dsh cookie by itself identifies nobody. So the proxy
// turns dsh's 401 on a plain `GET /` into the exchange, and the console's one
// credential stays the customer login.
//
// An nginx in front rewrites the `Location: /?token=...` to its published
// prefix (`proxy_redirect / /console/;`) and every cookie's Path with it
// (`proxy_cookie_path / /console/;`), so the browser stays under the prefix.
/**
 * Send the launch-token exchange redirect. The marker cookie lives for one
 * exchange round trip: a `/` that comes back still refused by dsh (the token
 * file is stale, or the browser stores no cookie) passes dsh's 401 through
 * instead of redirecting again, so the browser never loops.
 * @param {import('node:http').IncomingMessage} req - the inbound request.
 * @param {import('node:http').ServerResponse} res - the client response, owned by this function.
 * @param {string} token - the running dsh process's launch token.
 * @param {Runtime} runtime - the log sink.
 * @returns {void}
 */
function sendExchange(req, res, token, runtime) {
  runtime.log(`proxy: dsh-auth exchange for ${req.socket.remoteAddress ?? '?'}`)
  // base64url needs no escaping; encoding it keeps the header well-formed
  // whatever the file holds.
  res.writeHead(303, {
    'location': `/?token=${encodeURIComponent(token)}`,
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'set-cookie': `${EXCHANGE_MARKER_COOKIE}=1; Path=/; Max-Age=${String(EXCHANGE_MARKER_SECONDS)}; SameSite=Lax`,
  })
  res.end()
}

/**
 * Answer a request the gate did not admit. Nothing was sent upstream.
 * @param {import('node:http').ServerResponse} res - the client response.
 * @param {'refused' | 'unavailable'} outcome - why the request stops here.
 * @returns {void}
 */
function denyRequest(res, outcome) {
  const unavailable = outcome === 'unavailable'
  res.writeHead(unavailable ? 503 : 401, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(unavailable ? '{"error":"login check unavailable"}' : '{"error":"login required"}')
}

/**
 * Answer an upgrade on the raw socket with a bodiless status and close it once
 * the status line is flushed. No upstream connection was made.
 * @param {import('node:stream').Duplex} socket - the client socket.
 * @param {string} status - the status code and reason phrase.
 * @returns {void}
 */
function closeUpgrade(socket, status) {
  if (socket.destroyed) return
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy())
}

/**
 * Answer an upgrade the gate did not admit.
 * @param {import('node:stream').Duplex} socket - the client socket.
 * @param {'refused' | 'unavailable'} outcome - why the upgrade stops here.
 * @returns {void}
 */
function denyUpgrade(socket, outcome) {
  closeUpgrade(socket, outcome === 'unavailable' ? '503 Service Unavailable' : '401 Unauthorized')
}

/**
 * Decide whether a dsh-bound request may pass, and with which assertion.
 * @param {Settings} settings - validated settings.
 * @param {Gate} gate - the login check.
 * @param {Runtime} runtime - the clock for signing.
 * @param {import('node:http').IncomingMessage} req - the inbound request.
 * @param {string} pathname - request path, query stripped.
 * @returns {Promise<{ outcome: 'admitted', assertion: string | undefined } | { outcome: 'refused' | 'unavailable' }>} the decision; an exempt path and a gate turned off admit with no assertion.
 */
async function admitToDsh(settings, gate, runtime, req, pathname) {
  if (!settings.loginGate || isGateExempt(pathname)) return { outcome: 'admitted', assertion: undefined }
  const credential = presentedCredential(req.headers.cookie, settings.authCookie)
  const verification = credential === undefined ? NO_CREDENTIAL : await gate.authorize(credential)
  if (verification.outcome !== 'admitted') return { outcome: verification.outcome }
  return { outcome: 'admitted', assertion: assertionFor(settings, runtime, verification.member) }
}

/**
 * Build the PROXY_MODE=proxy server. It is returned unlistened; the caller
 * owns `listen` and `close`.
 * @param {Settings} settings - validated settings with `mode` set to `proxy`.
 * @param {Runtime} runtime - the log sink and clock.
 * @returns {{ server: import('node:http').Server, gate: Gate }} the server and the gate whose sockets `gate.close()` releases.
 */
export function createProxyServer(settings, runtime) {
  const gate = createGate(settings, runtime)
  const remoteHostHeader = `${String(settings.remoteHost)}:${String(settings.remotePort)}`
  const remoteAgent = new http.Agent({ keepAlive: true })
  const dshAgent = new http.Agent({ keepAlive: true })

  const server = http.createServer(async (req, res) => {
    let pathname
    try {
      pathname = requestPathname(req.url)
    } catch (_badTarget) {
      // The target is attacker-controlled and never logged. Answering here keeps
      // a parse failure off the generic failure path below, which names the path.
      runtime.log('proxy: bad request target')
      res.writeHead(400, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end('{"error":"bad request"}')
      return
    }
    try {
      const remote = isRemote(pathname)
      let assertion
      if (!remote) {
        const decision = await admitToDsh(settings, gate, runtime, req, pathname)
        if (decision.outcome !== 'admitted') {
          if (decision.outcome === 'refused') runtime.log(`proxy: gate ${req.method ?? '?'} ${pathname} -> 401`)
          denyRequest(res, decision.outcome)
          return
        }
        assertion = decision.assertion
      }
      const upstream = http.request({
        host: remote ? settings.remoteHost : DSH_HOST,
        port: remote ? settings.remotePort : settings.dshPort,
        method: req.method,
        path: req.url,
        headers: forwardHeaders(req.headers, remote ? remoteHostHeader : undefined, assertion),
        agent: remote ? remoteAgent : dshAgent,
      }, (upstreamRes) => {
        const headers = remote ? remoteResponseHeaders(upstreamRes.headers) : forwardHeaders(upstreamRes.headers, undefined)
        const status = upstreamRes.statusCode ?? 502
        if (!remote && status === 401 && exchangeable(req, pathname)) {
          const token = launchToken(settings.launchTokenFile)
          if (token !== undefined) {
            upstreamRes.resume()
            sendExchange(req, res, token, runtime)
            return
          }
        }
        if (status >= 400) runtime.log(`proxy: ${remote ? 'remote' : 'dsh'} ${req.method ?? '?'} ${pathname} -> ${String(status)}`)
        res.writeHead(status, headers)
        upstreamRes.pipe(res)
      })
      upstream.on('error', (error) => {
        runtime.log(`proxy: ${remote ? 'remote' : 'dsh'} request ${req.method ?? '?'} ${pathname} failed: ${String(error)}`)
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad gateway')
      })
      req.pipe(upstream)
    } catch (error) {
      // An async handler's rejection is an unhandled rejection, which ends the
      // process and, in the container, the console with it. Nothing above is
      // expected to throw; this keeps one bad request from being fatal.
      runtime.log(`proxy: request ${req.method ?? '?'} ${pathname} failed: ${String(error)}`)
      if (!res.headersSent) {
        res.writeHead(500, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.write('{"error":"proxy failure"}')
      }
      res.end()
    }
  })

  server.on('upgrade', async (req, socket, head) => {
    // First statement on purpose: the server hands over a raw socket with no
    // error listener, and the gate below awaits a service round-trip. A client
    // that resets the connection in that window would emit 'error' with nothing
    // listening, which throws out of the emitter rather than rejecting, so the
    // try/catch below cannot see it.
    socket.on('error', (error) => {
      runtime.log(`proxy: upgrade socket error: ${String(error.code ?? error.name)}`)
      socket.destroy()
    })
    let pathname
    try {
      pathname = requestPathname(req.url)
    } catch (_badTarget) {
      // As above: the target is attacker-controlled and stays out of the log.
      runtime.log('proxy: bad request target')
      closeUpgrade(socket, '400 Bad Request')
      return
    }
    try {
      const remote = isRemote(pathname)
      let assertion
      if (!remote) {
        const decision = await admitToDsh(settings, gate, runtime, req, pathname)
        if (decision.outcome !== 'admitted') {
          if (decision.outcome === 'refused') runtime.log(`proxy: gate ${req.method ?? '?'} ${pathname} -> 401`)
          denyUpgrade(socket, decision.outcome)
          return
        }
        assertion = decision.assertion
      }
      const headers = forwardHeaders(req.headers, remote ? remoteHostHeader : undefined, assertion)
      // The upgrade handshake is replayed verbatim on a raw socket: the gateway's
      // stream client negotiates the WebSocket itself
      // (packages/api/gateway/src/client/stream-client.ts), so nothing here may
      // consume or reframe the bytes.
      const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/${req.httpVersion}`]
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [String(value)]) lines.push(`${name}: ${single}`)
      }
      lines.push('Connection: Upgrade')
      lines.push(`Upgrade: ${String(req.headers.upgrade ?? 'websocket')}`)
      const upstream = net.connect(remote ? settings.remotePort : settings.dshPort, remote ? settings.remoteHost : DSH_HOST, () => {
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length > 0) upstream.write(head)
        upstream.pipe(socket)
        socket.pipe(upstream)
      })
      const fail = (error) => {
        runtime.log(`proxy: upgrade ${pathname} failed: ${String(error)}`)
        socket.destroy()
        upstream.destroy()
      }
      upstream.on('error', fail)
      socket.on('error', fail)
    } catch (error) {
      // Same reason as the request handler: a rejection from this async listener
      // would end the process, and this socket is not worth the console.
      runtime.log(`proxy: upgrade ${req.method ?? '?'} ${pathname} failed: ${String(error)}`)
      closeUpgrade(socket, '500 Internal Server Error')
    }
  })

  server.on('clientError', (error, socket) => {
    runtime.log(`proxy: client error: ${String(error)}`)
    if (socket.writable) socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
  })
  server.on('close', () => {
    remoteAgent.destroy()
    dshAgent.destroy()
  })

  return { server, gate }
}

/**
 * Build the PROXY_MODE=verify server for nginx `auth_request`. Every request
 * is one subrequest: the credential is its Authorization header, which the
 * nginx template fills from the visitor's header or mirror cookie. 200 admits,
 * carrying a fresh assertion in the `x-dsh-member` response header when this
 * deployment signs; 401 refuses; 503 reports the service unavailable. The
 * subrequest's own path and any `x-dsh-member` it carries are ignored.
 * @param {Settings} settings - validated settings with `mode` set to `verify`.
 * @param {Runtime} runtime - the log sink and clock.
 * @returns {{ server: import('node:http').Server, gate: Gate }} the unlistened server and its gate.
 */
export function createVerifierServer(settings, runtime) {
  const gate = createGate(settings, runtime)
  const server = http.createServer(async (req, res) => {
    req.resume()
    try {
      const credential = headerCredential(req.headers.authorization)
      const verification = credential === undefined ? NO_CREDENTIAL : await gate.authorize(credential)
      if (verification.outcome !== 'admitted') {
        if (verification.outcome === 'refused') runtime.log('proxy: verify -> 401')
        res.writeHead(verification.outcome === 'unavailable' ? 503 : 401, { 'cache-control': 'no-store', 'content-length': '0' })
        res.end()
        return
      }
      const assertion = assertionFor(settings, runtime, verification.member)
      res.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': '0',
        ...(assertion === undefined ? {} : { [MEMBER_HEADER]: assertion }),
      })
      res.end()
    } catch (error) {
      // As in the proxy: an async handler's rejection would end the process.
      runtime.log(`proxy: verify failed: ${String(error)}`)
      if (!res.headersSent) res.writeHead(503, { 'cache-control': 'no-store', 'content-length': '0' })
      res.end()
    }
  })
  server.on('clientError', (error, socket) => {
    runtime.log(`proxy: client error: ${String(error)}`)
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  return { server, gate }
}

/**
 * Start the configured mode from `process.env` and listen. A configuration
 * error is printed and exits 1 before anything listens.
 * @returns {void}
 */
function main() {
  let settings
  try {
    settings = readSettings(process.env)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
  /** @type {Runtime} */
  const runtime = { log: line => console.error(line), now: () => Date.now() }
  const { server } = settings.mode === 'verify' ? createVerifierServer(settings, runtime) : createProxyServer(settings, runtime)
  // Last resort behind the specific guards above, not a substitute for them: this
  // process holds no state worth preserving, and staying up beats taking dsh and
  // every open session down with it.
  process.on('uncaughtException', (error) => {
    console.error(`proxy: uncaught ${String(error)}`)
  })
  server.listen(settings.listenPort, settings.listenHost, () => {
    const target = settings.mode === 'verify'
      ? `verifier, authentication service ${settings.authOrigin.origin}`
      : `dsh ${DSH_HOST}:${String(settings.dshPort)}, remote ${String(settings.remoteHost)}:${String(settings.remotePort)}, login gate ${settings.loginGate ? 'on' : 'off'}`
    console.error(`proxy: listening on http://${settings.listenHost}:${String(settings.listenPort)} -> ${target}, member assertions ${settings.assertion === undefined ? 'off' : 'signed'}`)
  })
}

/**
 * Whether this module is the script Node was started with, as opposed to a
 * module a test imported.
 * @returns {boolean} true under `node proxy.mjs`.
 */
function isMainModule() {
  const script = process.argv[1]
  if (script === undefined) return false
  let resolved
  try {
    resolved = realpathSync(script)
  } catch (_scriptPathUnresolvable) {
    // A script path that does not resolve is not this file.
    return false
  }
  return pathToFileURL(resolved).href === import.meta.url
}

if (isMainModule()) main()
