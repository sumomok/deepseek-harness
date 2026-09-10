/**
 * The HTTP path both halves of this package are defined against, and the one
 * document that crosses it. The node half claims the path as a webserver route;
 * the browser half reads its settings from it before it draws the block that
 * needs them. Not configurable — the two halves must agree on it and nothing
 * outside this package addresses it.
 *
 * The settings document exists because a browser half receives no cordis
 * config: the boot manifest carries plugin names, not their `config` blocks, so
 * a `Config` field the browser must obey has to be served to it. The one field
 * served is the base path the vendored data page requests its table under,
 * which is deployment-varying and which the page's own request layer reads
 * once, at module evaluation, from `window.$toy_env.VUE_APP_BASE_URL`.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/route
 */

/** Exact route serving {@link ComponentKitSettings} to this package's browser half. */
export const COMPONENT_KIT_SETTINGS_ROUTE = '/component-kit/settings'

/** The browser-facing half of this plugin's configuration. */
export interface ComponentKitSettings {
  /**
   * Root-absolute path prefix the data page's requests go under, ending in
   * `/`. Same-origin as {@link requireBizBasePath} establishes it: a value the
   * URL parser resolves to this origin and to the path it literally spells, so
   * the page's requests reach the shell's own origin and whatever reverse proxy
   * stands in front of it, carrying the visitor's own token from the browser.
   */
  bizBasePath: string
}

/**
 * The origin a candidate base path is resolved against to judge it. `.invalid`
 * is reserved and resolves to no host, so a value that comes back on this
 * origin cannot have named a real one.
 */
const PROBE_ORIGIN = 'https://component-kit.invalid'

/**
 * Read one configured base path into the form the page's request layer takes.
 *
 * A path and nothing else: root-absolute; no query or fragment, because a
 * request path is appended to it; no whitespace, backslash or control
 * character. The trailing `/` is added where missing, because the request layer
 * joins its routes onto it with no separator of its own.
 *
 * The check that actually holds the same-origin claim up is the last one: the
 * normalized value is resolved against {@link PROBE_ORIGIN} with the same URL
 * parser the browser uses for its requests, and is refused unless both the
 * origin and the path come back unchanged. Reading the string by hand is not
 * enough, because that parser rewrites values that pass a hand-written reading:
 * under a special scheme it treats `\` as `/`, so `/\host/` names another
 * origin, and it normalizes percent-encoded dot segments, so `/%2e%2e/api/`
 * requests a path other than the one written. Every request the page makes
 * carries the visitor's own credential, so a value that resolves anywhere but
 * where it says is refused rather than repaired.
 * @param raw - the `bizBasePath` value, as `cordis.yml` wrote it.
 * @returns the normalized path.
 * @throws {Error} naming the field, when the value is not a root-absolute path this origin resolves literally.
 */
export function requireBizBasePath(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new Error('component-kit: bizBasePath must be a root-absolute path such as "/" or "/nrms-server/"')
  }
  if (/[\s?#\\\p{Cc}]/u.test(raw)) {
    throw new Error('component-kit: bizBasePath must carry no query, fragment, whitespace, backslash or control character')
  }
  const normalized = raw.endsWith('/') ? raw : `${raw}/`
  const resolved = new URL(normalized, PROBE_ORIGIN)
  if (resolved.origin !== PROBE_ORIGIN || resolved.pathname !== normalized) {
    throw new Error(`component-kit: bizBasePath must resolve to the path it spells on this origin; ${JSON.stringify(normalized)} resolves to ${JSON.stringify(resolved.href)}`)
  }
  return normalized
}

/**
 * Read one settings document off the wire. A wire boundary: the document
 * crossed a process, so its own contract is checked here rather than trusted
 * from the type, and the same rule the node half applied at load is applied
 * again to what arrived.
 * @param value - the decoded document, however malformed.
 * @returns the settings, or `undefined` when the document is not one this half can run on.
 */
export function readComponentKitSettings(value: unknown): ComponentKitSettings | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const { bizBasePath } = value as { bizBasePath?: unknown }
  if (typeof bizBasePath !== 'string') return undefined
  try {
    return { bizBasePath: requireBizBasePath(bizBasePath) }
  } catch (_valueIsNotABasePathThisHalfCanRunOn) {
    // The only thing `requireBizBasePath` throws is its own refusal of the
    // value, and on the wire a refused value is a document this half cannot
    // run on rather than a diagnostic to raise.
    return undefined
  }
}
