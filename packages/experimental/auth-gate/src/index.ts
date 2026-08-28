/**
 * @deepseek-ai/dsh-experimental-auth-gate — a deployment's own single sign-on,
 * wired into a dsh browser session.
 *
 * The node half serves the browser its gate settings, takes the access token
 * that browser found, and holds it for the process. It spends that token in one
 * place only: the forwarding route each configured MCP server gets, where it
 * becomes the `Authorization` header of the request going upstream.
 *
 * Trust: this package authenticates nobody. The token is accepted on its shape
 * alone, because the party that can verify its signature is the reverse proxy
 * in front of this process — one dsh process per signed-in user, selected by
 * that proxy from the same token. What the token buys inside this process is
 * therefore exactly what the proxy already granted: reaching the MCP servers
 * this deployment configured, as the user the proxy routed here.
 *
 * The token is held in memory for the process lifetime and written nowhere —
 * no session event, no settings document, no log line, no diagnostic.
 * @module @deepseek-ai/dsh-experimental-auth-gate
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { answerJson, readBoundedText, rejectCrossSite, rejectMethod, rejectNonJson } from './http.ts'
import { forwardWithToken, resolveUpstreams } from './proxy.ts'
import {
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  parseTokenPost,
  type AuthGateSettings,
} from './route.ts'

export {
  ACCESS_TOKEN_STORAGE_KEY,
  AUTH_GATE_MCP_PREFIX,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
} from './route.ts'
export type { AuthGateSettings } from './route.ts'

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
}

export const Config: z<Config> = z.object({
  loginUrl: z.string().required(),
  cookieName: z.string().required(),
  refreshMarginSeconds: z.natural().required(),
  mcpUpstreams: z.dict(z.string()).required(),
})

/**
 * Bytes a token document can possibly need: one JWT and the JSON around it. A
 * protocol bound, not a deployment choice — nothing the browser half posts is
 * larger.
 */
const MAX_TOKEN_POST_CHARS = 8 * 1024

/** How the token route names itself in a refusal. */
const TOKEN_ROUTE_LABEL = 'token route'

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
 * Validate the configuration, then claim the settings route, the token route,
 * and one forwarding route per configured MCP upstream.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load, all of it: an unusable login destination would send every
  // visitor nowhere, a cookie name that cannot be written would make the gate
  // reload forever, and a malformed upstream would answer the MCP client with
  // a route that fails only on the first tool call.
  const settings: AuthGateSettings = {
    loginUrl: requireLoginUrl(config.loginUrl),
    cookieName: requireCookieName(config.cookieName),
    refreshMarginSeconds: config.refreshMarginSeconds,
  }
  const upstreams = resolveUpstreams(config.mcpUpstreams)
  // The process's whole memory of the token. A closure rather than a service:
  // nothing outside this plugin may read it, and the fewer places name it, the
  // fewer can leak it.
  let held: string | undefined

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
      held = token
      res.writeHead(204)
      res.end()
    },
  }), 'auth-gate: token route')

  for (const upstream of upstreams) {
    const routePath = `${AUTH_GATE_MCP_PREFIX}/${upstream.name}`
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: routePath,
      handler: (req, res) => { forwardWithToken(req, res, { upstream, routePath, token: held }) },
    }), `auth-gate: "${upstream.name}" forwarding route`)
  }
}

/**
 * Decode one request body as JSON.
 * @param text - the body text.
 * @returns the decoded value, or `undefined` when the text is not JSON.
 */
function decodeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch (_bodyIsNotJson) {
    // The only thing a malformed body can mean here is a caller that is not
    // this package's browser half; the 400 above says so.
    return undefined
  }
}
