/**
 * @deepseek-ai/dsh-experimental-server-base — tells the browser which path
 * prefix this process is served under.
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

/** Plugin config: the path prefix this process is served under. */
export interface Config {
  /**
   * Deployment prefix as the browser addresses it, leading and trailing slash
   * included — `/console/` for a process behind `location /console/`, `/` for
   * one served at the origin root. It must carry no query string, no fragment,
   * and no empty segment, because every browser-side URL is resolved against
   * it.
   */
  basePath: string
}

export const Config: z<Config> = z.object({
  basePath: z.string().required(),
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
 * Validate the prefix, then contribute the two index rows that carry it.
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
  }, { prepend: true })
}
