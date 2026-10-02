/**
 * The loopback listening socket the shell binds itself and lends to each
 * server child, so that a crash rebind serves the UI from the same origin.
 *
 * The shell binds `127.0.0.1:<port>` once, through the bind Node's cluster
 * primary uses in its round-robin-free mode (`net._createServerHandle`): the
 * socket is bound, never listened on or accepted from in this process, and
 * stays bound until the shell process exits. Each server child receives a
 * duplicate over an IPC channel and listens on it through the preload in
 * `listen-handoff.mts`. A child that dies closes only its own duplicate: the
 * address stays bound by the shell, so no other process can bind it while the
 * shell lives, and the next child receives the same socket again.
 *
 * A bind that fails does not return a number on every platform. libuv defers
 * `EADDRINUSE` to the listen, so the call can hand back a handle that is not
 * bound at all, and a child that listens on such a handle binds it implicitly
 * to `0.0.0.0` on a port the system picks — every interface instead of the
 * loopback address. [[holdLoopbackPort]] therefore accepts a handle only when
 * `getsockname` reports the loopback address and the asked port; the child's
 * preload checks the address it ended up listening on as well.
 * @module @deepseek-ai/dsh-desktop-shell/listen-socket
 */

import * as net from 'node:net'
import { getSystemErrorName } from 'node:util'

/** The fields `getsockname` writes into the object it is given. */
export interface SocketName {
  /** The bound address. */
  address?: string
  /** `IPv4` or `IPv6`. */
  family?: string
  /** The bound port. */
  port?: number
}

/**
 * The libuv TCP handle `net._createServerHandle` returns, as far as this shell
 * uses it. Node's IPC accepts it as a `sendHandle` and sends it as a native
 * handle, which the receiving process can pass to `server.listen`.
 */
export interface NativeListenHandle {
  /**
   * Write the bound address into `out`.
   * @param out - receives `address`, `family` and `port`.
   * @returns 0, or a negative errno when the handle is not bound.
   */
  getsockname: (out: SocketName) => number
  /** Close the handle; the bound address is released once every process holding a duplicate closed its own. */
  close: () => void
}

declare module 'net' {
  /**
   * Node's internal bind (`createServerHandle` in `lib/net.js`), exported for
   * the cluster primary, which binds with it and sends the handle to its
   * workers. Declared as possibly absent, because it is not a public API.
   * @param address - the address to bind.
   * @param port - the port to bind; 0 lets the system pick one.
   * @param addressType - 4 for IPv4, 6 for IPv6.
   * @returns the bound handle, or a negative errno when the bind failed at once.
   */
  export const _createServerHandle: ((address: string, port: number, addressType: 4 | 6) => NativeListenHandle | number) | undefined
}

declare module 'child_process' {
  interface ChildProcess {
    /**
     * Send `message` with a native listening handle over the IPC channel.
     * Node sends a raw TCP handle as `net.Native`; @types/node lists only
     * sockets and servers as handles.
     * @param message - the message carrying the handle.
     * @param sendHandle - the handle to duplicate into the child.
     * @param callback - called once the message was written, or with the failure.
     * @returns false when the channel is closed or its write buffer is full.
     */
    send(message: Serializable, sendHandle: NativeListenHandle, callback: (error: Error | null) => void): boolean
  }
}

/** The one address the shell holds and the served UI's origin names. */
export const LOOPBACK = '127.0.0.1'

/** A bound loopback socket the shell holds for the life of its process. */
export interface HeldListenSocket {
  /** The bound port, as `getsockname` reported it. */
  readonly port: number
  /** The handle every server child receives a duplicate of. */
  readonly handle: NativeListenHandle
  /** Release the shell's own copy; calling it again does nothing. */
  close: () => void
}

/** The result of [[holdLoopbackPort]]. */
export type HoldResult =
  | { readonly kind: 'held'; readonly socket: HeldListenSocket }
  | { readonly kind: 'failed'; readonly reason: string }

/**
 * Bind `127.0.0.1:<port>` and keep it, after checking that the bind really
 * took that address.
 * @param port - the port to bind; 0 lets the system pick one.
 * @returns the held socket, or why the bind could not be held. A failure
 * closes whatever the bind returned, so no unbound handle is ever handed on.
 */
export function holdLoopbackPort(port: number): HoldResult {
  const create = net._createServerHandle
  if (typeof create !== 'function') return { kind: 'failed', reason: 'this Node runtime has no net._createServerHandle' }
  const handle = create(LOOPBACK, port, 4)
  if (typeof handle === 'number') return { kind: 'failed', reason: `bind ${LOOPBACK}:${String(port)} failed with ${errorName(handle)}` }
  const name: SocketName = {}
  const status = handle.getsockname(name)
  const bound = name.port
  const portMatches = bound !== undefined && (port === 0 ? bound > 0 : bound === port)
  if (status !== 0 || name.address !== LOOPBACK || !portMatches) {
    handle.close()
    const found = status === 0 ? `${name.address ?? '?'}:${String(name.port ?? '?')}` : errorName(status)
    return { kind: 'failed', reason: `bind ${LOOPBACK}:${String(port)} did not take that address (${found})` }
  }
  let closed = false
  return {
    kind: 'held',
    socket: {
      port: bound,
      handle,
      close: () => {
        if (closed) return
        closed = true
        handle.close()
      },
    },
  }
}

/**
 * The system name of a libuv errno.
 * @param errno - a negative errno.
 * @returns its name, such as `EADDRINUSE`, or the number when Node knows no name for it.
 */
function errorName(errno: number): string {
  try {
    return getSystemErrorName(errno)
  } catch {
    // RangeError for a value that is not a negative errno: the number itself is the most this can say.
    return String(errno)
  }
}

/** A held socket and the preload that takes it in the server child. */
export interface ListenHandoff {
  /** The socket the shell holds. */
  readonly socket: HeldListenSocket
  /**
   * Absolute path of the built `listen-handoff.mjs`. A packaged app runs it
   * from `app.asar.unpacked`, because the bundled Node cannot read the asar.
   */
  readonly preload: string
}

/** The variable that names the handed port to the server child and switches its preload on. */
export const LISTEN_HANDOFF_ENV = 'DSH_DESKTOP_LISTEN_HANDOFF_PORT'

/** The one IPC message the shell sends, with the socket as its handle. */
export const LISTEN_HANDOFF_MESSAGE = { type: 'dsh-desktop/listen-socket' } as const

/** The line the preload writes once it waits for the socket; the shell sends on it. */
export const HANDOFF_READY_LINE = 'dsh-desktop listen handoff: ready'

/** The start of the line the preload writes before it exits on a failure; the reason follows it. */
export const HANDOFF_FAILED_PREFIX = 'dsh-desktop listen handoff failed: '

/**
 * The line the preload writes once the server listens on the held socket,
 * before the server's own URL line.
 * @param port - the held port.
 * @returns the line, without its newline.
 */
export function handoffListeningLine(port: number): string {
  return `dsh-desktop listen handoff: listening on ${LOOPBACK}:${String(port)}`
}
