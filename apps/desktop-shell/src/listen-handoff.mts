/**
 * The server child's half of the listen-socket handoff, loaded with
 * `--import` before the `dsh` CLI entry. The shell's half and the reasons are
 * in [[@deepseek-ai/dsh-desktop-shell/listen-socket]].
 *
 * The module does nothing in a worker thread, or when the
 * `DSH_DESKTOP_LISTEN_HANDOFF_PORT` variable is absent: `--import` runs again
 * in every worker the server starts, and `child_process.fork` copies
 * `--import` to its children. Otherwise it removes the variable from the
 * environment, so no process the server starts sees it, and then:
 *
 * 1. Waits for the shell's socket on the IPC channel: it registers its
 *    `message` listener first and then writes the `ready` line, because a
 *    message that arrives before a listener exists is dropped. The shell
 *    sends on that line.
 * 2. Closes the IPC channel as soon as the socket arrived, before any server
 *    code runs, so no process the server starts can inherit a channel to the
 *    shell's main process.
 * 3. Replaces `net.Server.prototype.listen`: the first call that asks for the
 *    handed port on `127.0.0.1` — positional `(port, host, …)` or an options
 *    object — listens on the received socket instead; every other call goes
 *    to the original. The web server listens that way
 *    (`packages/host/webserver/src/index.ts`). A second call for the same port
 *    and host ends the process: its own copy of the socket is closed by then,
 *    and the shell restarts the server on the socket it holds.
 * 4. After that listen, checks that the server listens on `127.0.0.1` and the
 *    handed port, and writes the `listening` line. A socket whose bind had
 *    failed would otherwise make the server listen on every interface.
 *
 * Every protocol line goes to standard output with a synchronous write: the
 * `listening` line must reach the shell before the URL line the CLI prints
 * there, and a failure line must be complete before the process exits. A
 * failure writes `dsh-desktop listen handoff failed: <reason>` and exits 1,
 * which the shell answers by starting the server without the socket. The
 * module imports Node built-ins only, because the packaged app runs it from
 * `app.asar.unpacked`, beside no other module of this package.
 * @module @deepseek-ai/dsh-desktop-shell/listen-handoff
 */

import { writeSync } from 'node:fs'
import { Server } from 'node:net'
import { isMainThread } from 'node:worker_threads'

/** The variable carrying the handed port; the shell sets it on this process alone. */
const PORT_ENV = 'DSH_DESKTOP_LISTEN_HANDOFF_PORT'

/** The `type` of the one IPC message the shell sends, with the socket as its handle. */
const MESSAGE_TYPE = 'dsh-desktop/listen-socket'

/** The start of every protocol line. */
const LINE_PREFIX = 'dsh-desktop listen handoff'

/** The loopback address the shell binds. */
const LOOPBACK = '127.0.0.1'

/**
 * How long the process waits for the socket after writing the `ready` line.
 * The shell sends on that line, so the wait only ends a process whose shell
 * stopped answering without closing the channel.
 */
const SOCKET_WAIT_MS = 10_000

/**
 * Write one protocol line to standard output, synchronously.
 * @param line - the line, without its newline.
 */
function writeLine(line: string): void {
  writeSync(1, `${line}\n`)
}

/**
 * Write the failure line and end the process.
 * @param reason - why the handoff failed.
 * @returns never; the process exits.
 */
function fail(reason: string): never {
  writeLine(`${LINE_PREFIX} failed: ${reason}`)
  process.exit(1)
}

/**
 * Read a field off a value of unknown type.
 * @param value - the value.
 * @param key - the field.
 * @returns the field's value, or undefined when `value` is not an object or lacks it.
 */
function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null && key in value ? Reflect.get(value, key) : undefined
}

/**
 * Whether a `listen` call asks for `port` on the loopback address. Node takes
 * the port as a number or a numeric string.
 * @param args - the arguments of the call.
 * @param port - the handed port.
 * @returns true for `(port, '127.0.0.1', …)` and `({ port, host: '127.0.0.1', … }, …)`.
 */
function asksForHeldPort(args: readonly unknown[], port: number): boolean {
  const [first, second] = args
  const options = typeof first === 'object' && first !== null
  const asked = options ? field(first, 'port') : first
  const host = options ? field(first, 'host') : second
  return (typeof asked === 'number' || typeof asked === 'string') && Number(asked) === port && host === LOOPBACK
}

/**
 * Receive the socket: register the listeners, announce readiness, and wait.
 * @returns the received handle.
 */
async function receiveSocket(): Promise<object> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { fail(`no socket arrived within ${String(SOCKET_WAIT_MS / 1000)}s`) }, SOCKET_WAIT_MS)
    const onDisconnect = (): void => { fail('the IPC channel closed before the socket arrived') }
    process.once('disconnect', onDisconnect)
    process.once('message', (message, handle) => {
      clearTimeout(timer)
      process.off('disconnect', onDisconnect)
      if (field(message, 'type') !== MESSAGE_TYPE || typeof handle !== 'object' || handle === null) fail('the IPC message carried no socket')
      resolve(handle)
    })
    writeLine(`${LINE_PREFIX}: ready`)
  })
}

/**
 * Route the first `listen` for `port` on the loopback address to `handle`.
 * @param port - the handed port.
 * @param handle - the received socket.
 */
function listenOnHandle(port: number, handle: object): void {
  const original = Server.prototype.listen
  let taken = false
  Server.prototype.listen = function listenOnHeldSocket(this: Server, ...args: unknown[]): Server {
    if (!asksForHeldPort(args, port)) {
      // Node's `listen` returns the server it was called on.
      Reflect.apply(original, this, args)
      return this
    }
    if (taken) fail('second listen on the held port')
    taken = true
    const callback = args.findLast(arg => typeof arg === 'function')
    // Only for the listen itself: removed once it succeeded, so an accept
    // error later still reaches the server's own handler.
    const onError = (error: Error): void => { fail(`listen on the held socket failed: ${error.message}`) }
    this.once('error', onError)
    return original.call(this, handle, () => {
      this.off('error', onError)
      const address = this.address()
      if (address === null || typeof address === 'string' || address.address !== LOOPBACK || address.port !== port) {
        fail(`listening on ${JSON.stringify(address)}, not ${LOOPBACK}:${String(port)}`)
      }
      writeLine(`${LINE_PREFIX}: listening on ${LOOPBACK}:${String(port)}`)
      if (typeof callback === 'function') Reflect.apply(callback, this, [])
    })
  }
}

const announced = isMainThread ? process.env[PORT_ENV] : undefined
if (announced !== undefined) {
  delete process.env[PORT_ENV]
  const port = Number(announced)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) fail(`${PORT_ENV} is not a port: ${JSON.stringify(announced)}`)
  if (process.send === undefined) fail('the process has no IPC channel')
  const handle = await receiveSocket()
  if (process.connected) process.disconnect()
  listenOnHandle(port, handle)
}
