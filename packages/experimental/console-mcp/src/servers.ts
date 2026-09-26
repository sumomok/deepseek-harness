/**
 * The request/spec split for this row's server list: every check that one
 * configuration file can answer by itself runs here, at load, before any
 * connection is attempted or any credential is read.
 *
 * @module
 */

import { isCredentialRefName } from '@deepseek-ai/dsh-credentials'

/**
 * Accepted server id. This is `dsh-mcp-client`'s own `serverName` grammar,
 * restated because the id is also this row's error vocabulary: a value this
 * pattern admits is one the bridge will accept as a tool namespace.
 */
const SERVER_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/**
 * Accepted header name — the RFC 9110 field-name token. A value outside it
 * cannot be put on the wire, so it is refused where it was written rather
 * than where the request is built.
 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/

/** One server's credential, named rather than carried. */
export interface ServerAuthRequest {
  /** Request header the credential is spent on, such as `Authorization`. */
  header: string
  /** Credential reference — an environment-variable name, never a value. */
  credential: string
  /** Text placed before the resolved value, such as `Bearer `. */
  scheme: string
}

/** One server as a deployment writes it. */
export interface ServerRequest {
  /** Tool namespace: this server's tools register as `mcp__<id>__<rawName>`. */
  id: string
  /** Streamable HTTP endpoint. */
  url: string
  /** Credential attached to every request; omitted for an endpoint that needs none. */
  auth?: ServerAuthRequest
  /** Per-tool-call timeout in milliseconds; omitted leaves the bridge's own default. */
  toolCallTimeoutMs?: number
  /** Whether a failed first connection fails the boot; omitted leaves the bridge's own default. */
  failOnStartupError?: boolean
}

/** One server after every self-contained check has passed. */
export interface ServerSpec extends ServerRequest {
  /** The endpoint, normalized by the URL parser. */
  url: string
}

/**
 * Refuse a URL this row must not put a credential on. A fragment is never
 * sent, so one written here means the author expected something the transport
 * cannot do; user information in the URL would be a secret in a configuration
 * file this row's diagnostics quote.
 * @param id - the server the URL belongs to, for the diagnostic.
 * @param raw - the configured value.
 * @returns the same endpoint, normalized.
 * @throws {Error} when the value is not an absolute, credential-free http(s) URL.
 */
function requireEndpoint(id: string, raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // The value is unreadable, so it is not quoted back: a string the parser
    // could not read can still carry a password, and this message is read
    // wherever the boot's output goes.
    throw new Error(`console-mcp: server "${id}" has a url that is not an absolute URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`console-mcp: server "${id}" must use an http or https url, received "${url.protocol}"`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error(`console-mcp: server "${id}" must not write a user name or password into its url; name a credential instead`)
  }
  if (url.hash !== '') {
    throw new Error(`console-mcp: server "${id}" must not write a fragment into its url, received "${url.hash}"`)
  }
  return url.href
}

/**
 * Judge the configured server list as a whole and return what this row will
 * mount. Every failure here is a configuration file contradicting itself, so
 * each one throws while the row loads rather than surfacing as a tool that
 * fails on first use.
 * @param servers - the configured list, in the order it was written.
 * @returns one spec per server, in the same order.
 * @throws {Error} when an id, url, header name, or credential reference is
 * unusable, or when two servers claim the same id.
 */
export function resolveServers(servers: readonly ServerRequest[]): ServerSpec[] {
  const claimed = new Set<string>()
  return servers.map((server) => {
    if (!SERVER_ID_PATTERN.test(server.id)) {
      throw new Error(`console-mcp: server id "${server.id}" must match ${String(SERVER_ID_PATTERN)}`)
    }
    if (claimed.has(server.id)) {
      throw new Error(`console-mcp: two servers claim the id "${server.id}"; an id is one server's tool namespace`)
    }
    claimed.add(server.id)
    const url = requireEndpoint(server.id, server.url)
    if (server.auth !== undefined) {
      if (!HEADER_NAME_PATTERN.test(server.auth.header)) {
        throw new Error(`console-mcp: server "${server.id}" names header "${server.auth.header}", which is not a header name`)
      }
      if (!isCredentialRefName(server.auth.credential)) {
        throw new Error(`console-mcp: server "${server.id}" names credential "${server.auth.credential}", which is not a credential reference`)
      }
    }
    return { ...server, url }
  })
}
