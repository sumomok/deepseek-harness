/**
 * @deepseek-ai/dsh-experimental-server-base — tells the browser the deployment
 * facts a served page cannot work out for itself: which path prefix this
 * process is published under, and whether reaching the page means owning the
 * Host behind it.
 *
 * A dsh process never learns its own deployment prefix: the web server reads no
 * forwarded-prefix header and its routes are registered at root-absolute paths,
 * so a reverse proxy in front of it has to strip the prefix before a request
 * arrives. What the browser gets back is then a shell that would address every
 * route from the origin root. This plugin closes that half by putting the
 * prefix into the served index in the two forms the browser reads it from:
 *
 * - `<base href="<basePath>">`, which the HTML parser applies to every relative
 *   URL that follows it — the built shell's own asset references and the
 *   parser-blocking plugin-bundle tags the client module system contributes.
 * - `globalThis.__DSH_BASE__`, which runtime code reads to build a fetch,
 *   WebSocket, or EventSource URL, and which is available before any document
 *   script runs.
 *
 * Both rows carry the same configured value, so the prefix has one source of
 * truth in the process and none in the proxy.
 *
 * Off a loopback authority the client reads the page as somebody else's Host
 * and stands its operator-only surface down — the settings sections, the
 * settings document actions, and the produced-file open action. A deployment
 * that admits nobody but the Host's operator says so with `ownsHost`, and this
 * plugin serves the `__DSH_TRANSPORT__` carrier the client reads that
 * declaration from.
 * @module @deepseek-ai/dsh-experimental-server-base
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'server-base'

/**
 * Service required before the index rows can be contributed. The rows only
 * reach a browser through this service's index render, so a composition without
 * it leaves the row waiting rather than silently serving a prefix-free shell.
 */
export const inject = ['webServer']

/**
 * Browser global carrying the deployment prefix. The browser half of the client
 * packages reads this name as a literal rather than importing it: an
 * experimental package must not become a dependency of the shipped client
 * spine, and the name is part of the served page's contract either way.
 */
export const DSH_BASE_GLOBAL = '__DSH_BASE__'

/** Plugin config: the deployment facts the served page is given. */
export interface Config {
  /**
   * Deployment prefix as the browser addresses it, leading and trailing slash
   * included — `/console/` for a process behind `location /console/`, `/` for
   * one served at the origin root. It must carry no query string, no fragment,
   * and no empty segment, because every browser-side URL is resolved against
   * it.
   */
  basePath: string
  /**
   * Declare that whoever reaches the served page is this Host's operator. The
   * page then carries a `__DSH_TRANSPORT__` carrier whose `ownsHost` makes
   * `ctx.connection.isLoopback` true on an authority that is not loopback, so
   * the client offers the surface it otherwise keeps for the operator's own
   * machine: settings read and write the Host's settings document instead of a
   * process-local mirror that answers every read `unavailable`, the settings
   * document actions appear, and a produced-file chip offers to open its path
   * on the Host. Set it only where something in front of the page decides who
   * reaches it — the console sample pairs the dsh browser session cookie with
   * the proxy's `auth_request` login gate — because every visitor those admit
   * gets that surface. It moves no server-side check: the browser-trust fence
   * still refuses a Host that is neither loopback nor declared, and the Host's
   * settings RPC already answered any caller the deployment admitted. Omit it,
   * and the page is served exactly as it is without this claim; the default is
   * false.
   */
  ownsHost?: boolean
}

export const Config: z<Config> = z.object({
  basePath: z.string().required(),
  ownsHost: z.boolean().default(false),
})

/**
 * Path characters this prefix admits: the unreserved, sub-delimiter, and
 * `:@%` characters a URL path segment may carry, less `&`. Everything else is
 * refused, which is what keeps the value safe to place in the `<base>`
 * element's quoted attribute with no escaping step between the configuration
 * and the served markup: `"`, `<`, and `>` would break out of the attribute,
 * and `&` — a legal path character otherwise — begins a character reference
 * there, so a value carrying one would be read back as something else.
 */
const SEGMENT_CHARACTERS = /^[\w.~%!$'()*+,;=:@\/-]*$/

/**
 * Reject a prefix the browser could not resolve its URLs against.
 * @param basePath - the configured value.
 * @returns the same value once it is usable.
 * @throws {Error} when it is not an absolute, slash-terminated, query-free,
 * fragment-free path of non-empty segments.
 */
export function requireBasePath(basePath: string): string {
  if (!basePath.startsWith('/')) {
    throw new Error(`server-base: basePath must start with "/", received "${basePath}"`)
  }
  if (!basePath.endsWith('/')) {
    throw new Error(`server-base: basePath must end with "/", received "${basePath}"`)
  }
  if (basePath.includes('?')) {
    throw new Error(`server-base: basePath must carry no query string, received "${basePath}"`)
  }
  if (basePath.includes('#')) {
    throw new Error(`server-base: basePath must carry no fragment, received "${basePath}"`)
  }
  if (basePath.includes('//')) {
    throw new Error(`server-base: basePath must carry no empty path segment, received "${basePath}"`)
  }
  if (!SEGMENT_CHARACTERS.test(basePath)) {
    throw new Error(`server-base: basePath must be a plain URL path, received "${basePath}"`)
  }
  return basePath
}

/**
 * Inline script installing the carrier that declares the page owns its Host.
 * `fetch` is the page's own, the same caller `client-connection` uses when no
 * carrier is present, so the RPC keeps its HTTP requests and its Gateway
 * WebSocket; no `openStream` and no `loadBundle`, so the plugin bundles keep
 * loading over HTTP. `??=` leaves whatever a shell assembled for itself — the
 * worker preview's postMessage tunnel — in place.
 */
const OWNS_HOST_SCRIPT
  = 'globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };'

/**
 * Validate the prefix, then contribute the index rows that carry the
 * deployment facts.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // Loud at load: a prefix the browser cannot resolve against would serve a
  // shell whose every request goes to the wrong path, and the first symptom is
  // a blank page with a 404 for each asset.
  const basePath = requireBasePath(config.basePath)
  // Prepended, because `<base>` governs only the URLs that follow it in the
  // document and every head row is rendered in table order: a row pushed by a
  // listener that ran earlier — the client module system's parser-blocking
  // bundle tags among them — would resolve against the document URL instead.
  ctx.on('webserver/index-inject', (table) => {
    table.push(
      { kind: 'html', placement: 'head', html: `<base href="${basePath}">` },
      { kind: 'global', name: DSH_BASE_GLOBAL, value: basePath },
    )
    // Behind the prefix rows and ahead of every document script, which is where
    // the carrier has to be: `client-connection` reads the global once, at its
    // own plugin boot.
    if (config.ownsHost === true) table.push({ kind: 'script', placement: 'head', text: OWNS_HOST_SCRIPT })
  }, { prepend: true })
}
