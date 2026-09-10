/**
 * Loopback update service: the desktop shell lends the embedded server a view
 * of its own update channel, so the Settings window can show what the channel
 * is doing and start the install.
 *
 * The shell starts this before it spawns the server and passes the address and
 * the bearer token to that child process alone ([[ENDPOINT_ENV]] /
 * [[TOKEN_ENV]]); a deployment that is not this shell — every `dsh web` on a
 * server — sets neither, and a plugin that finds neither reports the capability
 * unavailable rather than looking for an updater itself.
 *
 * This is a **third** service beside the render and plugin-admin listeners,
 * with a token of its own, because the three lend different powers: this one
 * buys the replacement of the whole application, which is heavier than a
 * screenshot or a package install. Admission to one is never admission to
 * another.
 *
 * The protocol is four routes and no request body.
 *
 * | Route | Answer |
 * |---|---|
 * | `GET /state` | `200` — the {@link UpdateSnapshot} as its own JSON object |
 * | `POST /check` | `202` — the snapshot; a check runs in the background and downloads what it finds |
 * | `POST /download` | `202` — the snapshot; the transfer of the version already found is (re)started |
 * | `POST /install` | `202` — `{ "ok": true }`, written before anything stops. `409` when the phase is not `ready` |
 *
 * Every other path and method is `404`, decided before the token is read, so
 * the answer says nothing about what this service offers to a caller that
 * cannot authenticate anyway. A missing or wrong token is `401`. Failures are
 * one line of `text/plain`, because the caller puts the sentence in a settings
 * page. There is no CORS handling, because no browser origin is meant to reach
 * this listener.
 *
 * **`POST /install` opens no dialog.** The click in the Settings window is the
 * consent, and asking again would only repeat the question that click answered.
 * The route therefore refuses everything but the one phase in which an update
 * is downloaded and verified.
 *
 * It also answers before it acts. The install stops the embedded server and
 * hands the machine to an installer that replaces this process, so a caller
 * still waiting on the response would read the dropped socket as a failed
 * install. `{ "ok": true }` is written first and the install is scheduled for
 * the next tick, after the answer is on the wire.
 * @module @deepseek-ai/dsh-desktop-shell/update-service
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { authorized, listenLoopback, mintToken, sendJson, sendText } from './loopback-service.ts'
import type { UpdateSnapshot } from './update-state.ts'

/** Environment variable naming this service's origin, set on the server child alone. */
export const ENDPOINT_ENV = 'DSH_DESKTOP_UPDATE_ENDPOINT'

/** Environment variable carrying this service's bearer token, set on the server child alone. */
export const TOKEN_ENV = 'DSH_DESKTOP_UPDATE_TOKEN'

/** The route reporting where the update channel stands. */
export const STATE_PATH = '/state'

/** The route starting a background check. */
export const CHECK_PATH = '/check'

/** The route starting or restarting the transfer of the version already found. */
export const DOWNLOAD_PATH = '/download'

/** The route that quits the app and installs the downloaded update. */
export const INSTALL_PATH = '/install'

/** What the shell gives this service to read and to drive. */
export interface UpdateServiceSpec {
  /**
   * Where the update channel stands right now.
   * @returns the snapshot to answer with.
   */
  state: () => UpdateSnapshot
  /**
   * Start a background check, which downloads whatever it finds. Returns at
   * once; the check reports through [[state]].
   */
  check: () => void
  /**
   * Start or restart the transfer of the version the last check found, running
   * a check first when none is known. Returns at once.
   */
  download: () => void
  /**
   * Stop the embedded server and hand the downloaded update to the installer.
   * Called only when [[state]] reports `ready`, only after the user clicked the
   * button that says so, and only once the answer to that request has been
   * written.
   */
  install: () => void
}

/** A listening update service: where it is, what opens it, and how it stops. */
export interface UpdateServiceHandle {
  /** Origin the server child is told to call, always on the loopback address. */
  endpoint: string
  /** The bearer token this service accepts, generated fresh for every launch. */
  token: string
  /** Stop listening and drop open connections; resolves once the listener is closed. */
  close: () => Promise<void>
}

/** What the four routes are, once method and path have been read. */
type Route = 'state' | 'check' | 'download' | 'install'

/**
 * Which route one request names.
 * @param method - the HTTP method.
 * @param path - the request path.
 * @returns the route, or undefined for the 404 every other method and path gets.
 */
function routeOf(method: string, path: string): Route | undefined {
  if (method === 'GET' && path === STATE_PATH) return 'state'
  if (method !== 'POST') return undefined
  if (path === CHECK_PATH) return 'check'
  if (path === DOWNLOAD_PATH) return 'download'
  if (path === INSTALL_PATH) return 'install'
  return undefined
}

/**
 * Start the loopback update service and listen on an ephemeral port.
 * @param spec - what to report and what the three actions do.
 * @returns the listening service: its endpoint, its token, and its stop.
 * @throws when the loopback listener cannot be opened.
 */
export async function startUpdateService(spec: UpdateServiceSpec): Promise<UpdateServiceHandle> {
  const token = mintToken()

  const handle = (request: IncomingMessage, response: ServerResponse): void => {
    // No route reads a body, and an unread request would take the socket down
    // with the answer rather than letting the connection be reused.
    request.resume()
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const method = request.method ?? 'unknown'
    const route = routeOf(method, path)
    if (route === undefined) {
      sendText(response, 404, `no route for ${method} ${path}`)
      return
    }
    if (!authorized(request.headers.authorization, token)) {
      sendText(response, 401, 'authorization must be Bearer <token> carrying this service\'s token')
      return
    }
    if (route === 'state') {
      sendJson(response, 200, spec.state())
      return
    }
    if (route === 'install') {
      if (spec.state().phase !== 'ready') {
        sendText(response, 409, 'no update is downloaded and verified; install is offered only in the ready phase')
        return
      }
      sendJson(response, 202, { ok: true })
      // After the answer, never before it: the install takes the server and
      // this process down, and a caller still waiting would read the dropped
      // socket as a failure.
      setImmediate(() => { spec.install() })
      return
    }
    if (route === 'check') spec.check()
    else spec.download()
    sendJson(response, 202, spec.state())
  }

  const server = createServer((request, response) => {
    try {
      handle(request, response)
    } catch (error) {
      sendText(response, 500, `update service failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const endpoint = await listenLoopback(server, 'update service')
  return {
    endpoint,
    token,
    close: async () => {
      // Sockets a caller left open would otherwise hold the listener open past
      // the quit that asked for it to close.
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}
