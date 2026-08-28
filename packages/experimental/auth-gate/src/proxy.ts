/**
 * The token-injecting forward to one MCP server.
 *
 * An MCP server behind the deployment's single sign-on wants the visitor's
 * bearer token, and `dsh-mcp-client` resolves its headers once when its row
 * loads — it has no way to attach a credential that arrives later and changes
 * per session. This module closes that gap by giving each configured upstream a
 * local route: the MCP client points at the route, the route carries the request
 * upstream unchanged except for the `Authorization` header it adds.
 *
 * Bytes are forwarded rather than decoded, in both directions, because the
 * streamable-HTTP transport answers a POST with either a JSON document or an
 * `text/event-stream` held open, and holds a GET open for the server-to-client
 * stream. The webserver's route handler owns the full response lifecycle, which
 * is what lets a route hold one open.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/proxy
 */

import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from 'node:http'
import { request as httpsRequest } from 'node:https'
import { answerJson, rejectCrossSite } from './http.ts'

/** One configured MCP server, with the route segment it is reached under. */
export interface McpUpstream {
  /** Route segment under the package's MCP prefix; also the name in diagnostics. */
  name: string
  /** Where requests on that route are sent. */
  target: URL
}

/**
 * Headers that describe one hop rather than the message, plus the two this
 * forward owns. `host` is re-derived for the upstream authority. `authorization`
 * is replaced by the held token, so a caller cannot smuggle its own past it.
 * `cookie` is dropped because the shell mirrors the very same token into a
 * cookie, and an upstream has no business receiving the browser's cookie jar.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  'host', 'authorization', 'cookie',
])

/** Hop-by-hop headers stripped from the upstream's answer before it is relayed. */
const DROPPED_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'transfer-encoding', 'upgrade',
])

/**
 * One direction's headers, minus the ones this hop owns.
 * @param headers - the headers as they arrived.
 * @param dropped - the header names this direction does not relay.
 * @returns the headers to send on.
 */
function relayed(headers: IncomingHttpHeaders, dropped: ReadonlySet<string>): OutgoingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([header]) => !dropped.has(header)))
}

/**
 * Validate the configured upstream table and resolve each target.
 * @param configured - the `mcpUpstreams` config value.
 * @returns one entry per configured upstream, in declaration order.
 * @throws {Error} when a name cannot be a path segment, or a target is not an
 * absolute HTTP(S) URL without a query string or fragment.
 */
export function resolveUpstreams(configured: Record<string, string>): McpUpstream[] {
  return Object.entries(configured).map(([name, raw]) => {
    if (!/^[\w-]+$/.test(name)) {
      throw new Error(`auth-gate: mcpUpstreams name "${name}" must be a plain route segment`)
    }
    let target: URL
    try {
      target = new URL(raw)
    } catch (_targetIsNotAbsolute) {
      // The only thing an unparseable value can mean is a relative or
      // misspelled URL; the message below says which name carries it.
      throw new Error(`auth-gate: mcpUpstreams["${name}"] must be an absolute URL, received "${raw}"`)
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      throw new Error(`auth-gate: mcpUpstreams["${name}"] must be an http or https URL, received "${raw}"`)
    }
    if (target.search !== '' || target.hash !== '') {
      // The incoming query is forwarded verbatim, so a target carrying one of
      // its own would silently lose it on every request.
      throw new Error(`auth-gate: mcpUpstreams["${name}"] must carry no query string or fragment, received "${raw}"`)
    }
    return { name, target }
  })
}

/**
 * The request function for one target's scheme.
 * @param target - the upstream URL.
 * @returns `node:https`' request function for an https target, `node:http`'s otherwise.
 */
export function requesterFor(target: URL): typeof httpRequest {
  return target.protocol === 'https:' ? httpsRequest : httpRequest
}

/**
 * The upstream URL one incoming request maps to: the target's path with the
 * part of the request path past the route prefix appended, and the request's
 * own query string.
 * @param upstream - the configured upstream.
 * @param routePath - the route prefix this upstream is registered under.
 * @param requestUrl - the request's raw url (path and query).
 * @returns the URL to send upstream.
 */
export function upstreamUrlFor(upstream: McpUpstream, routePath: string, requestUrl: string): URL {
  const incoming = new URL(requestUrl, 'http://x')
  const rest = decodeURIComponent(incoming.pathname).slice(routePath.length)
  const out = new URL(upstream.target.href)
  out.pathname = `${upstream.target.pathname.replace(/\/$/, '')}${rest}`
  out.search = incoming.search
  return out
}

/** Everything one forward needs from its route registration. */
export interface ForwardOptions {
  /** The configured upstream this route serves. */
  upstream: McpUpstream
  /** The route prefix the upstream is registered under. */
  routePath: string
  /** The access token to spend, or `undefined` while no browser has posted one. */
  token: string | undefined
}

/**
 * Forward one request to its upstream with the held token attached.
 * @param req - the incoming request; its body is streamed upstream unread.
 * @param res - the response; the upstream's answer is streamed into it, which
 * keeps an event stream incremental.
 * @param options - the upstream, its route prefix, and the token to spend.
 */
export function forwardWithToken(req: IncomingMessage, res: ServerResponse, options: ForwardOptions): void {
  const { upstream, routePath, token } = options
  if (rejectCrossSite(req, res, `"${upstream.name}" forwarding route`)) return
  if (token === undefined) {
    answerJson(res, 503, {
      error: `auth-gate: no access token is held yet, so the "${upstream.name}" upstream cannot be reached`,
    })
    return
  }
  const headers = { ...relayed(req.headers, DROPPED_REQUEST_HEADERS), authorization: `Bearer ${token}` }
  /* v8 ignore next -- node:http always sets url on server requests */
  const url = upstreamUrlFor(upstream, routePath, req.url ?? '/')
  const forwarded = requesterFor(upstream.target)(url, { method: req.method, headers })
  const fail = (): void => {
    // Past the first byte of the answer there is no status left to change, so
    // the only honest report is a truncated response.
    if (res.headersSent) res.destroy()
    else answerJson(res, 502, { error: `auth-gate: forwarding to the "${upstream.name}" upstream failed` })
  }
  forwarded.on('error', fail)
  forwarded.on('response', (answer) => {
    /* v8 ignore next -- node:http always sets statusCode on a client response */
    res.writeHead(answer.statusCode ?? 502, relayed(answer.headers, DROPPED_RESPONSE_HEADERS))
    answer.on('error', fail)
    answer.pipe(res)
  })
  // A client that walks away mid-stream must not leave the upstream request
  // running; destroying a settled request does nothing.
  res.on('close', () => { forwarded.destroy() })
  req.pipe(forwarded)
}
