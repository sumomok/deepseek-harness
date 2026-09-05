/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server.
 *
 * This is the path the process sees. A deployment served under a path prefix
 * has that prefix stripped by its reverse proxy before the request arrives, so
 * this constant stays root-absolute; the browser puts the prefix back by
 * resolving it through `clientUrl` (./client/base.ts).
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'
