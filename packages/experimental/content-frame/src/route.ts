/**
 * The one HTTP path both halves of this package are defined against: the node
 * half claims it as a webserver prefix route, the browser half points the
 * iframe at it. Not configurable — the two halves must agree on it and nothing
 * outside this package addresses it.
 */

/** Prefix route the hosted application is served under; no trailing slash, which is the webserver's route form. */
export const CONTENT_APP_ROUTE = '/content-app'

/** Same-origin URL of the hosted application's entry document, as the iframe requests it. */
export const CONTENT_APP_SRC = `${CONTENT_APP_ROUTE}/`
