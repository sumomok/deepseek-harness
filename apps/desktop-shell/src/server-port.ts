/**
 * Which loopback port the embedded server listens on, so the served UI keeps
 * one origin across launches and across crash rebinds.
 *
 * Everything the web client keeps in the browser is scoped to its origin
 * `http://127.0.0.1:<port>`: localStorage (the open session in
 * `dsh.sessions.current`, conversation drafts, custom shortcuts in
 * `dsh.keybindings.v1`, the transcript width, right-sidebar layouts) and the
 * `dsh-auth-*` cookie. A server started on `--port 0` gets a new port, and
 * with it a new, empty origin. The shell therefore remembers the port the last
 * server actually listened on and asks for it again. A port that another
 * process holds is not waited for: the launch falls back to a port the system
 * picks, and remembers that one for the next launch.
 *
 * Within one run the shell holds the port itself
 * ([[@deepseek-ai/dsh-desktop-shell/listen-socket]]): [[holdLaunchSocket]]
 * binds it before the first server starts, and every server of the run —
 * the first one, each crash rebind, the restart after a failed install —
 * listens on that socket through [[startHeldOrFallback]]. When the handoff
 * fails, the shell closes the socket, logs one line, and starts the server
 * the way it would without the socket at that point; from then on the run
 * changes origin on every crash rebind
 * ([[@deepseek-ai/dsh-desktop-shell/server-lifecycle]]).
 *
 * What a fixed port changes for sign-in: the `dsh-auth-*` cookie is signed
 * with a secret the Harness home keeps across processes and names its
 * authority, so a cookie issued by one launch is valid for the next launch's
 * server on the same port until it expires. The lifecycle module states which
 * process can accept a connection on the port at each moment. Everything else
 * is as before: the window loads only the URL the server child prints, whose
 * launch token is new on every start; `will-navigate` keeps the window on that
 * server's origin; and a process holding the port at launch gets the
 * fallback, not the window.
 * @module @deepseek-ai/dsh-desktop-shell/server-port
 */

import { createServer } from 'node:net'
import { holdLoopbackPort, LOOPBACK, type HeldListenSocket, type ListenHandoff } from './listen-socket.ts'
import { ListenHandoffFailed, ServerExitedBeforeUrl, type ServerHandle, type ServerSpec } from './server.ts'

/**
 * Whether a port number is one a server can be asked to listen on.
 * @param value - anything read back from the state file.
 * @returns true for an integer in 1–65535.
 */
export function isListenPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65_535
}

/** What one listen attempt on a host found. */
export type ListenOutcome = 'free' | 'taken' | 'unavailable'

/**
 * Try to listen on `host:port` and close again.
 * @param port - the port to try.
 * @param host - the address to bind.
 * @returns `free` when the listen succeeded; `unavailable` when the host has no
 * such address or address family (`EADDRNOTAVAIL`, `EAFNOSUPPORT`, as for `::`
 * on a machine without IPv6); `taken` for any other failure, `EADDRINUSE` and
 * `EACCES` among them.
 */
export async function listenOutcome(port: number, host: string): Promise<ListenOutcome> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' ? 'unavailable' : 'taken')
    })
    probe.listen(port, host, () => {
      probe.close(() => { resolve('free') })
    })
  })
}

/**
 * The addresses a port must be free on. Checking the loopback address alone
 * is not enough: on macOS a process listening on the IPv4 or IPv6 wildcard
 * does not stop a listen on `127.0.0.1` with the same port, and connections
 * the window makes can then reach either listener.
 */
const PROBE_HOSTS = [LOOPBACK, '0.0.0.0', '::'] as const

/**
 * Check whether `port` is free on the loopback address and both wildcard
 * addresses, one listen at a time. An address family the machine lacks does
 * not make the port taken. A free answer can go stale before the server binds,
 * which [[startOnPort]] covers by falling back on `EADDRINUSE`.
 * @param port - the port to check.
 * @param probe - one listen attempt; [[listenOutcome]] outside tests.
 * @returns true when no probe found the port taken.
 */
export async function isPortFree(
  port: number, probe: (port: number, host: string) => Promise<ListenOutcome> = listenOutcome,
): Promise<boolean> {
  for (const host of PROBE_HOSTS) {
    if (await probe(port, host) === 'taken') return false
  }
  return true
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

/**
 * Hold the port a launch starts on: the chosen port, or a port the system
 * picks when that bind does not hold.
 * @param port - the port [[choosePort]] chose; 0 lets the system pick one.
 * @param log - receives one line when the chosen port could not be held.
 * @returns the held socket, or undefined when no bind held, in which case the
 * launch starts without one and this run changes origin on every crash rebind.
 */
export function holdLaunchSocket(port: number, log: (line: string) => void): HeldListenSocket | undefined {
  const chosen = holdLoopbackPort(port)
  if (chosen.kind === 'held') return chosen.socket
  const picked = port === 0 ? chosen : holdLoopbackPort(0)
  if (picked.kind === 'held') {
    log(`[desktop] server port: ${chosen.reason}; holding ${String(picked.socket.port)}, and the UI starts on a new origin\n`)
    return picked.socket
  }
  log(`[desktop] listen handoff unavailable (${picked.reason}); this run changes origin on every crash rebind\n`)
  return undefined
}

/** A started server, its spec, and the socket it listens on when the handoff held. */
export interface HeldStart {
  /** The running server. */
  server: ServerHandle
  /** The spec it was started with, carrying the port it listens on and no {@link ServerSpec.listen}. */
  spec: ServerSpec
  /** The handoff the server took, or undefined after a fallback, which closed the socket. */
  held: ListenHandoff | undefined
}

/** What a fallback from a failed handoff needs. */
export interface HandoffFallback {
  /** One log line, ending in a newline. */
  log: (line: string) => void
  /**
   * Runs once before the held socket is closed. A crash rebind forgets the
   * remembered port here, so the port is no longer asked for by the time
   * another process can bind it.
   */
  beforeClose: () => void
}

/**
 * Whether a start failure is a handoff failure, and why.
 * @param error - what the start rejected with.
 * @returns the reason, or undefined for any other failure.
 */
function handoffFailure(error: unknown): string | undefined {
  if (error instanceof ListenHandoffFailed) return error.reason
  // The preload did not take the `listen` call, and the server's own bind
  // found the address the shell holds.
  if (isAddressInUse(error)) return 'the server bound the held port itself (listen EADDRINUSE)'
  return undefined
}

/**
 * Start the server on a held socket, and without it when the handoff fails.
 *
 * The fallback is the start the shell makes without a socket at that point:
 * [[startOnPort]] on `spec.port`, which retries on a system-picked port when
 * that one is taken. Any other failure leaves the socket held and propagates,
 * so a retry can use it again.
 * @param spec - the launch, without {@link ServerSpec.listen}; its `port` is the fallback's port.
 * @param handoff - the held socket and the preload.
 * @param start - starts one server; `startServerWithQuarantine` outside tests.
 * @param fallback - the log and the step before the socket closes.
 * @returns the running server, its spec, and the handoff it took or undefined after a fallback.
 */
export async function startHeldOrFallback(
  spec: ServerSpec, handoff: ListenHandoff, start: (spec: ServerSpec) => Promise<ServerHandle>, fallback: HandoffFallback,
): Promise<HeldStart> {
  const port = handoff.socket.port
  try {
    const server = await start({ ...spec, port, listen: handoff })
    return { server, spec: { ...spec, port }, held: handoff }
  } catch (error) {
    const reason = handoffFailure(error)
    if (reason === undefined) throw error
    fallback.beforeClose()
    handoff.socket.close()
    fallback.log(`[desktop] listen handoff unavailable (${reason}); this run changes origin on every crash rebind\n`)
    return { ...await startOnPort(spec, start, fallback.log), held: undefined }
  }
}
