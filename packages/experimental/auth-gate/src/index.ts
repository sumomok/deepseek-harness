/**
 * @deepseek-ai/dsh-experimental-auth-gate — a deployment's own single sign-on,
 * wired into a dsh browser session.
 *
 * The node half serves the browser its gate settings, takes the access token
 * that browser found, and holds it for the process. It spends that token in two
 * places, both of them the deployment's own: the forwarding route each
 * configured MCP server gets, where the token becomes the `Authorization`
 * header of the request going upstream, and — when `bizUpstream` is configured
 * — `ctx.bizBackend`, the reads of this deployment's data backend that
 * `@deepseek-ai/dsh-experimental-biz-backend` serves.
 *
 * Trust: this package authenticates nobody. The token is accepted on its shape
 * alone, because the party that can verify its signature is the reverse proxy
 * in front of this process — one dsh process per signed-in user, selected by
 * that proxy from the same token. What the token buys inside this process is
 * therefore exactly what the proxy already granted: reaching the MCP servers
 * and the data backend this deployment configured, as the user the proxy routed
 * here.
 *
 * The token is held in memory and written nowhere — no session event, no
 * settings document, no log line, no diagnostic. It is dropped when the browser
 * half gives it up, which is what the sign-out route is for; when the data
 * backend refuses it; and otherwise when the process ends.
 * @module @deepseek-ai/dsh-experimental-auth-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BizBackendService, type HeldCredential } from '@deepseek-ai/dsh-experimental-biz-backend'
import { answerJson, decodeJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { forwardWithToken, resolveUpstreams } from './proxy.ts'
import {
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  isOwnOriginPath,
  MAX_RENEWAL_INTERVAL_SECONDS,
  parseTokenPost,
  type AuthGateRenewalSettings,
  type AuthGateSettings,
} from './route.ts'

export {
  ACCESS_TOKEN_STORAGE_KEY,
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
} from './route.ts'
export type { AuthGateRenewalSettings, AuthGateSettings } from './route.ts'

/** Stable Cordis plugin name. */
export const name = 'auth-gate'

/** Service required before the routes can be claimed. */
export const inject = ['webServer']

/** Plugin config: where a visitor signs in, how the token is mirrored, and which MCP servers it is spent on. */
export interface Config {
  /**
   * Page an unauthenticated visitor is sent to. The browser half appends
   * `?redirect=<the encoded page it came from>`, so the value may not already
   * carry a query string. A hash-routed login page (`/sign-in/#/`) takes the
   * parameter inside its fragment, which is where a hash router reads it.
   *
   * A browser-side address, assigned as it stands: a deployment served under a
   * path prefix writes that prefix into the value, because nothing resolves it
   * against the deployment base. A login page outside the shell's prefix is a
   * valid choice, and it receives no mirror cookie — that cookie is scoped to
   * the prefix.
   */
  loginUrl: string
  /**
   * Cookie the browser half mirrors the access token into, so a request that
   * carries no `Authorization` header — a navigation, an image, an iframe —
   * still identifies the visitor to whatever sits in front of this process.
   */
  cookieName: string
  /**
   * How many seconds before expiry the browser half acts on the coming expiry.
   * Zero acts at the expiry instant.
   */
  refreshMarginSeconds: number
  /**
   * MCP servers this deployment forwards to, as route segment to absolute
   * target URL. Each entry claims `/auth-gate/mcp/<name>`; point the matching
   * `dsh-mcp-client` row's `url` at that path instead of at the server itself.
   * An empty table is the deployment that gates its browser and forwards
   * nothing.
   */
  mcpUpstreams: Record<string, string>
  /**
   * Base URL of this deployment's own data backend, ending in `/` and carrying
   * the deployment's API prefix — `https://<host>/ini-server/` for a standard
   * install. That prefix is the frontend's `VUE_APP_BASE_URL`, so it is read off
   * the deployment rather than assumed: an install built without one publishes
   * its API at the origin root instead.
   *
   * There is no default. Left out, the `bizBackend` service is not registered
   * at all, and a row that consumes it stays pending with the missing service
   * named — a deployment that does not offer a data backend says so by staying
   * silent, rather than by registering reads that always fail.
   */
  bizUpstream?: string
  /**
   * The deployment's own renewal endpoint, as a path on the page's own origin —
   * `/<the API prefix>/nrms-auth/api/renewal` for a standard install, where the
   * prefix is the frontend's `VUE_APP_BASE_URL`. A browser-side address, like
   * `loginUrl`: a deployment served under a path prefix writes that prefix into
   * the value, because nothing resolves it against the deployment base.
   *
   * There is no default. Left out, this deployment offers no renewal and the
   * expiry margin sends the visitor back through the login page, which is the
   * one renewal route every deployment has. Set, it must be paired with
   * {@link Config.renewalIntervalSeconds}.
   */
  renewalPath?: string
  /**
   * How many seconds the browser half holds a token before asking the renewal
   * endpoint for a new one: above zero, and at most 2147483, which is as long
   * as a browser timer waits. The deployment's own client renews on its next
   * request once the token it holds is older than `accessTokenRenewalTime`
   * minutes, 30 by default; this is that rule as a timer, so a value well under
   * the token's lifetime is what keeps a console left open signed in.
   *
   * Required when {@link Config.renewalPath} is set, and refused when it is
   * not: an interval configured against no endpoint is a deployment that
   * believes it renews and does not.
   */
  renewalIntervalSeconds?: number
}

export const Config: z<Config> = z.object({
  loginUrl: z.string().required(),
  cookieName: z.string().required(),
  refreshMarginSeconds: z.natural().required(),
  mcpUpstreams: z.dict(z.string()).required(),
  bizUpstream: z.string(),
  renewalPath: z.string(),
  renewalIntervalSeconds: z.natural(),
})

/**
 * Bytes a token document can possibly need: one JWT and the JSON around it. A
 * protocol bound, not a deployment choice — nothing the browser half posts is
 * larger.
 */
const MAX_TOKEN_POST_CHARS = 8 * 1024

/** How the token route names itself in a refusal. */
const TOKEN_ROUTE_LABEL = 'token route'

/** How the sign-out route names itself in a refusal. */
const LOGOUT_ROUTE_LABEL = 'sign-out route'

/**
 * Reject a login destination the browser half cannot build a redirect from.
 * @param loginUrl - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is empty or already carries a query string.
 */
function requireLoginUrl(loginUrl: string): string {
  if (loginUrl.length === 0) throw new Error('auth-gate: loginUrl must not be empty')
  if (loginUrl.includes('?')) {
    throw new Error(`auth-gate: loginUrl must carry no query string, received "${loginUrl}"`)
  }
  return loginUrl
}

/**
 * Reject a cookie name that cannot be written as one.
 * @param cookieName - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is not a bare cookie-name token.
 */
function requireCookieName(cookieName: string): string {
  if (!/^[\w!#$%&'*+.^`|~-]+$/.test(cookieName)) {
    throw new Error(`auth-gate: cookieName must be a bare cookie name, received "${cookieName}"`)
  }
  return cookieName
}

/**
 * Drop any user name and password written into an address, so a value the
 * parser accepted can still be quoted back.
 *
 * Hand-written rather than read off the parsed URL, because the callers are the
 * branches the parser accepted and the credentials check below passed: a value
 * `URL` reads as an opaque scheme keeps its whole authority, password included,
 * inside a path, where `username` and `password` are both empty. The authority
 * is what stands between the scheme separator and the first `/`, `?` or `#`
 * after it, and anything up to the last `@` inside it is the part a password
 * can be in.
 * @param raw - the address as it was configured.
 * @returns the address with its userinfo removed, unchanged where it has none.
 */
function withoutUserinfo(raw: string): string {
  const separator = raw.indexOf('://')
  const start = separator < 0 ? 0 : separator + 3
  const rest = raw.slice(start)
  const stop = rest.search(/[/?#]/)
  const authority = stop < 0 ? rest : rest.slice(0, stop)
  const at = authority.lastIndexOf('@')
  return at < 0 ? raw : raw.slice(0, start) + raw.slice(start + at + 1)
}

/**
 * Reject a data-backend base URL a read cannot be built onto.
 *
 * Loud at load, all of it: the value decides where the visitor's credential is
 * sent, and every fault below would otherwise surface as a request to the wrong
 * place rather than as a row that fails to start. It is also what
 * {@link BizBackendService} states as its own precondition on the base it is
 * given, so the check belongs to whoever configures that base.
 *
 * A refusal quotes the value only where the parser accepted it and reported no
 * credentials in it, and even then quotes it with its userinfo removed. A value
 * the parser refuses is quoted nowhere at all: it can carry a password that no
 * check here is able to recognize, and the load failure is read by whatever
 * collects this deployment's logs.
 * @param raw - the configured `bizUpstream` value.
 * @returns the same address, normalized by the URL parser.
 * @throws {Error} when the value is not an absolute http(s) URL, carries a
 * query string, a fragment, credentials of its own, or an empty path segment,
 * or has a path that does not end in `/`.
 */
function requireBizUpstream(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch (_valueIsNotAbsolute) {
    // Quoting nothing at all, like the credentials check below it. A value the
    // parser refuses can still carry a password — `//user:secret@host/` and
    // `https://user:secret@host:99999/` are both refused here, and neither ever
    // reaches a check that could recognize one — so this branch names the field
    // and stops. The field name is what makes the fault findable; the common
    // value is a relative or misspelled address, a deployment prefix alone
    // (`/ini-server/`) being the usual one.
    throw new Error('auth-gate: bizUpstream must be an absolute URL')
  }
  if (parsed.username !== '' || parsed.password !== '') {
    // Same reason: an address the parser read a password out of is one this
    // deployment must rewrite, and the field name is the whole of what has to
    // be said to get that done.
    throw new Error('auth-gate: bizUpstream must carry no credentials of its own')
  }
  // Every message below quotes this rendering rather than the value: the check
  // above misses a password inside an address the parser read as an opaque
  // scheme, where the authority is part of a path.
  const quoted = withoutUserinfo(raw)
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`auth-gate: bizUpstream must be an http or https URL, received "${quoted}"`)
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new Error(`auth-gate: bizUpstream must carry no query string or fragment, received "${quoted}"`)
  }
  if (!parsed.pathname.endsWith('/')) {
    // The deployment's API prefix is a path segment, and a base missing its
    // trailing slash reads as a sibling of that segment rather than its parent.
    throw new Error(`auth-gate: bizUpstream must end in "/", received "${quoted}"`)
  }
  if (parsed.pathname.includes('//')) {
    throw new Error(`auth-gate: bizUpstream must carry no empty path segment, received "${quoted}"`)
  }
  return parsed.href
}

/**
 * Reject a renewal configuration the browser half cannot spend a token on.
 *
 * Loud at load, in both directions: a path the browser cannot address would
 * surface as a renewal that quietly never happens and a visitor signed out
 * every time a token runs out, and an interval configured against no path is a
 * deployment that believes it renews and does not.
 *
 * The path is required to name this deployment's own origin because the value
 * decides where this visitor's credential is sent, and the browser half resolves
 * it against the page's own address: a value naming another origin — a
 * protocol-relative `//host/path`, or the `/\host/path` the URL parser reads as
 * one — would send the token off this deployment. {@link isOwnOriginPath}
 * answers that by resolving the value rather than by reading its first
 * characters.
 * @param path - the configured `renewalPath`, absent where this deployment
 * offers no renewal.
 * @param intervalSeconds - the configured `renewalIntervalSeconds`.
 * @returns the renewal settings to serve the browser half, or `undefined` where
 * no renewal is configured.
 * @throws {Error} when one field is configured without the other, when the path
 * is empty or is not a path on this deployment's own origin, or when the
 * interval is zero or longer than a browser timer waits.
 */
function requireRenewal(path: string | undefined, intervalSeconds: number | undefined): AuthGateRenewalSettings | undefined {
  if (path === undefined) {
    if (intervalSeconds !== undefined) {
      throw new Error('auth-gate: renewalIntervalSeconds needs a renewalPath to spend it on')
    }
    return undefined
  }
  if (path.length === 0) throw new Error('auth-gate: renewalPath must not be empty')
  if (!isOwnOriginPath(path)) {
    throw new Error(`auth-gate: renewalPath must be a path on this deployment's own origin, received "${path}"`)
  }
  if (intervalSeconds === undefined) {
    throw new Error('auth-gate: renewalPath needs a renewalIntervalSeconds to renew on')
  }
  if (intervalSeconds === 0) {
    throw new Error('auth-gate: renewalIntervalSeconds must be above zero')
  }
  // Refused rather than slept in links the way the expiry margin's own delay is:
  // an interval past what one browser timer carries names a schedule first
  // firing 24 days out, which no token this deployment issues lives to reach.
  if (intervalSeconds > MAX_RENEWAL_INTERVAL_SECONDS) {
    throw new Error(
      `auth-gate: renewalIntervalSeconds must be at most ${String(MAX_RENEWAL_INTERVAL_SECONDS)},`
      + ` which is as long as a browser timer waits, received ${String(intervalSeconds)}`,
    )
  }
  return { path, intervalSeconds }
}

/**
 * The process's memory of one access token, as the three operations anything is
 * allowed to perform on it.
 *
 * A closure rather than a service: nothing outside this plugin and the reads it
 * hands the closure to may see the token, and the fewer places name it, the
 * fewer can leak it. There is no reader that returns it to a caller outside
 * this package.
 * @returns the three operations, closed over one token slot.
 */
function holdCredential(): HeldCredential {
  let held: string | undefined
  return {
    read: () => held,
    set: (token: string) => { held = token },
    // Both reasons reach the same terminal state, so the closure reads neither;
    // the parameter names which event dropped the token at each call site.
    drop: (_reason) => { held = undefined },
  }
}

/**
 * Validate the configuration, then claim the settings route, the token route,
 * one forwarding route per configured MCP upstream, and — when a data backend
 * is configured — the `bizBackend` service that reads it.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load, all of it: an unusable login destination would send every
  // visitor nowhere, a cookie name that cannot be written would make the gate
  // reload forever, a half-configured renewal would sign the visitor out every
  // time a token ran out, and a malformed upstream would answer the MCP client
  // with a route that fails only on the first tool call.
  const renewal = requireRenewal(config.renewalPath, config.renewalIntervalSeconds)
  const settings: AuthGateSettings = {
    loginUrl: requireLoginUrl(config.loginUrl),
    cookieName: requireCookieName(config.cookieName),
    refreshMarginSeconds: config.refreshMarginSeconds,
    ...renewal === undefined ? {} : { renewal },
  }
  const upstreams = resolveUpstreams(config.mcpUpstreams)
  // An unusable data-backend base would send this visitor's credential to the
  // wrong place, so it fails the row here as well. Absent or empty means this
  // deployment offers no data backend, and no service is registered for one.
  const bizUpstream = config.bizUpstream === undefined || config.bizUpstream === ''
    ? undefined
    : requireBizUpstream(config.bizUpstream)
  const credential = holdCredential()
  if (bizUpstream !== undefined) {
    // The service installs itself on the context and is withdrawn with this
    // plugin's fiber, so nothing here holds the instance.
    new BizBackendService(ctx, bizUpstream, credential)
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_SETTINGS_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        rejectMethod(res, 'GET, HEAD')
        return
      }
      // The browser half reads this once per boot and the values come from the
      // row it booted with, so a cached copy would outlive its own truth.
      answerJson(res, 200, settings)
    },
  }), 'auth-gate: browser settings route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_TOKEN_ROUTE,
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(res, 'POST')
        return
      }
      if (rejectCrossSite(req, res, TOKEN_ROUTE_LABEL)) return
      if (rejectNonJson(req, res, TOKEN_ROUTE_LABEL)) return
      const text = await readBoundedText(req, MAX_TOKEN_POST_CHARS)
      const token = text === undefined ? undefined : parseTokenPost(decodeJson(text))
      if (token === undefined) {
        // The refusal names the field and nothing else: a diagnostic quoting
        // what was posted would put a credential in whatever reads it.
        answerJson(res, 400, { error: 'auth-gate: expected a JSON body whose "token" field is a JWT' })
        return
      }
      credential.set(token)
      res.writeHead(204)
      res.end()
    },
  }), 'auth-gate: token route')

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: AUTH_GATE_LOGOUT_ROUTE,
    handler: (req, res) => {
      if (req.method !== 'POST') {
        rejectMethod(res, 'POST')
        return
      }
      // Both halves of the fence the token route carries, for the same reason:
      // same-site alone leaves the route reachable by a cross-origin page as a
      // preflight-free simple request, because a request carrying no
      // `sec-fetch-site` at all passes it. Requiring `application/json`
      // withdraws it from that set, so a cross-origin page cannot sign a visitor
      // out of the deployment they are working in. No body is read even so — the
      // route names no token, it drops whichever one is held, which is the token
      // of the one visitor this process serves.
      if (rejectCrossSite(req, res, LOGOUT_ROUTE_LABEL)) return
      if (rejectNonJson(req, res, LOGOUT_ROUTE_LABEL)) return
      credential.drop('sign-out')
      res.writeHead(204)
      res.end()
    },
  }), 'auth-gate: sign-out route')

  for (const upstream of upstreams) {
    const routePath = `${AUTH_GATE_MCP_PREFIX}/${upstream.name}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: routePath,
      handler: (req, res) => { forwardWithToken(req, res, { upstream, routePath, token: credential.read() }) },
    }), `auth-gate: "${upstream.name}" forwarding route`)
  }
}
