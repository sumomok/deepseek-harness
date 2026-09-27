/**
 * Which loopback port the embedded server listens on, so the served UI keeps
 * one origin across launches.
 *
 * Everything the web client keeps in the browser is scoped to its origin
 * `http://127.0.0.1:<port>`: localStorage (custom shortcuts in
 * `dsh.keybindings.v1`, the transcript width, right-sidebar layouts,
 * conversation drafts) and the `dsh-auth-*` cookie. A server started on
 * `--port 0` gets a new port, and with it a new, empty origin, on every launch.
 * The shell therefore remembers the port the last server actually listened on
 * and asks for it again. A port that another process holds is not waited for:
 * the launch falls back to `--port 0`, which is what every launch did before,
 * and remembers the new port for the next one.
 *
 * Nothing about authentication changes with a fixed port. The window only
 * loads the URL the server child prints, whose launch token is new on every
 * launch; `will-navigate` keeps the window on that server's origin; and the
 * stale `dsh-auth-*` cookies are cleared before each spawn. A process that
 * takes the port first gets the fallback, not the window.
 * @module @deepseek-ai/dsh-desktop-shell/server-port
 */

import { createServer } from 'node:net'
import { ServerExitedBeforeUrl, type ServerHandle, type ServerSpec } from './server.ts'

/** The loopback host the server binds and the probe checks. */
const LOOPBACK = '127.0.0.1'

/**
 * Whether a port number is one a server can be asked to listen on.
 * @param value - anything read back from the state file.
 * @returns true for an integer in 1–65535.
 */
export function isListenPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/**
 * Check whether `port` is free on the loopback host by listening on it and
 * closing again. A free answer can go stale before the server binds, which
 * [[startOnPort]] covers by falling back on `EADDRINUSE`.
 * @param port - the port to check.
 * @returns true when the listen succeeded.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => { resolve(false) })
    probe.listen(port, LOOPBACK, () => {
      probe.close(() => { resolve(true) })
    })
  })
}

/** The port to start with and the log line that says why. */
export interface PortChoice {
  /** The port to pass as `--port`; 0 asks the system for any free one. */
  port: number
  /** One log line, ending in a newline. */
  line: string
}

/**
 * Pick the port to start the server on.
 * @param remembered - the port the previous server listened on, when the state file holds one.
 * @param free - checks whether a port can be bound now; [[isPortFree]] outside tests.
 * @returns the remembered port when it is free, otherwise 0.
 */
export async function choosePort(remembered: number | undefined, free: (port: number) => Promise<boolean>): Promise<PortChoice> {
  if (remembered === undefined) {
    return { port: 0, line: '[desktop] server port: none remembered; the system picks one\n' }
  }
  if (await free(remembered)) {
    return { port: remembered, line: `[desktop] server port: reusing ${String(remembered)}\n` }
  }
  return { port: 0, line: `[desktop] server port: ${String(remembered)} is in use; the system picks one, and the UI starts on a new origin\n` }
}

/**
 * The port a started server listens on.
 * @param url - the server's origin, `http://127.0.0.1:<port>`.
 * @returns the port, or undefined when the URL names none.
 */
export function portOf(url: string): number | undefined {
  const port = Number.parseInt(new URL(url).port, 10)
  return isListenPort(port) ? port : undefined
}

/**
 * Whether a startup failure is the server finding its port taken. The server
 * exits 1 with Node's `listen EADDRINUSE` line when `--port N` is held by
 * another process.
 * @param error - what the start rejected with.
 * @returns true for an exit before the URL line whose output names `EADDRINUSE`.
 */
export function isAddressInUse(error: unknown): boolean {
  return error instanceof ServerExitedBeforeUrl && /\blisten EADDRINUSE\b/u.test(error.output)
}

/**
 * Start the server on `spec.port`, and once more on port 0 when that port
 * turned out to be taken between the check and the bind.
 * @param spec - the launch, with the port to ask for.
 * @param start - starts one server; `startServerWithQuarantine` outside tests.
 * @param log - receives one line when the fallback runs.
 * @returns the running server and the spec it was started with, whose `port`
 * is the one it listens on, so a rebind asks for the same origin again.
 */
export async function startOnPort(
  spec: ServerSpec, start: (spec: ServerSpec) => Promise<ServerHandle>, log: (line: string) => void,
): Promise<{ server: ServerHandle; spec: ServerSpec }> {
  let used = spec
  let server: ServerHandle
  try {
    server = await start(spec)
  } catch (error) {
    if (spec.port === undefined || spec.port === 0 || !isAddressInUse(error)) throw error
    log(`[desktop] server port: ${String(spec.port)} was taken before the server bound it; retrying on a port the system picks\n`)
    used = { ...spec, port: 0 }
    server = await start(used)
  }
  const listening = portOf(server.url)
  return { server, spec: listening === undefined ? used : { ...used, port: listening } }
}
