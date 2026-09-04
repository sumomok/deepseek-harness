/**
 * The /api URL prefix — single source for both halves of the web transport.
 * The node half registers this prefix on the web server; both halves share the
 * event paths below for the browser WebSocket downlinks.
 *
 * These are the paths the process sees. A deployment served under a path
 * prefix has that prefix stripped by its reverse proxy before the request
 * arrives, so these constants stay root-absolute; the browser puts the prefix
 * back by resolving them through `clientUrl` (./client/base.ts).
 */

/** Route prefix owning every api request (`/api` and `/api/<anything>`). */
export const API_PATH = '/api'

/** Browser mux-frame WebSocket pathname. */
export const MUX_EVENTS_PATH = `${API_PATH}/events.mux`

/** Browser host-frame WebSocket pathname. */
export const HOST_EVENTS_PATH = `${API_PATH}/events.host`
