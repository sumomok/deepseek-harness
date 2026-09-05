/**
 * Deployment-base resolution for every URL the browser half builds.
 *
 * The Host registers its routes at the server root (`/api`, `/plugins`), and a
 * reverse proxy serving this app under a path prefix strips that prefix before
 * the request arrives. The page therefore has to put the prefix back on every
 * URL it builds from a Host route constant. This module owns that decision:
 * route constants stay root-absolute everywhere else, and {@link clientUrl} is
 * the only supported way to turn one into a URL the browser may request.
 */

/**
 * Authority used when the page has no usable origin: a non-browser carrier
 * (Node, a worker) or a sandboxed document whose origin serializes to `null`.
 * Requests never leave the process in those carriers, so the authority only
 * has to parse.
 */
export const INTERNAL_BASE = 'http://dsh.internal/'

/** Page globals this module reads; every one is absent in a non-browser carrier. */
interface ClientBaseGlobal {
  /** Deployment prefix the Host injects as an index `global` row, `/console/` shaped. */
  __DSH_BASE__?: unknown
  location?: { origin?: string }
  document?: { baseURI?: string }
}

/**
 * The deployment base every browser URL resolves against.
 * @returns an absolute URL ending in `/`: the injected `__DSH_BASE__` prefix,
 * else the directory of `document.baseURI` (what an injected `<base href>`
 * sets), else the page root, else {@link INTERNAL_BASE}. The authority always
 * comes from the page origin — a declared prefix contributes only its path, and
 * a document base is read only when it is already on that origin — so neither
 * a `<base>` nor an injected global naming another origin can redirect Host
 * traffic.
 */
export function resolveClientBase(): string {
  const page = globalThis as ClientBaseGlobal
  const origin = page.location?.origin
  const root = origin !== undefined && origin !== 'null' ? `${origin}/` : INTERNAL_BASE
  const declared = page.__DSH_BASE__
  if (typeof declared === 'string' && declared !== '') {
    // Resolved twice on purpose: the first pass reads the declared value's
    // path, the second puts that path back on the page origin, so a value
    // naming an authority of its own contributes nothing but its path.
    const path = new URL(declared.endsWith('/') ? declared : `${declared}/`, root).pathname
    return new URL(path, root).href
  }
  const baseUri = page.document?.baseURI
  // Same-origin test first: a URL of a special scheme serializes as its origin
  // followed by `/` and the path, so this prefix admits exactly the page's own
  // origin. It also keeps `about:blank` and other cannot-be-a-base document
  // URLs away from the resolution below, which would throw on them.
  if (typeof baseUri === 'string' && baseUri.startsWith(root)) {
    return new URL(new URL('.', baseUri).pathname, root).href
  }
  return root
}

/**
 * Resolve one Host route against the deployment base.
 * @param path - the route as the Host registers it (`/api/session.export`), or
 * the same path already relative. Every leading slash is dropped: a
 * root-absolute path would replace the deployment prefix instead of extending
 * it.
 * @returns the absolute URL to request.
 */
export function clientUrl(path: string): URL {
  return new URL(path.replace(/^\/+/, ''), resolveClientBase())
}
