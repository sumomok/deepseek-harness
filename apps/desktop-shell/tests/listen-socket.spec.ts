/**
 * Holding a loopback port: the socket holds only an address it really bound,
 * a taken port yields no socket, and closing releases the port. Every case
 * binds real loopback sockets on ports the system picks.
 * @module
 */

import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { holdLoopbackPort, type HeldListenSocket } from '../src/listen-socket.ts'

/** Listeners and held sockets a case opened, closed after it. */
const listeners: Server[] = []
const held: HeldListenSocket[] = []

afterEach(async () => {
  for (const socket of held.splice(0)) socket.close()
  await Promise.all(listeners.splice(0).map(listener => new Promise((resolve) => { listener.close(resolve) })))
})

/**
 * Listen on `port` at the loopback address.
 * @param port - the port; 0 lets the system pick one.
 * @returns the listener's outcome: its port, or the error code.
 */
async function listenOn(port: number): Promise<number | string> {
  const listener = createServer()
  return new Promise((resolve) => {
    listener.once('error', (error: NodeJS.ErrnoException) => { resolve(error.code ?? error.message) })
    listener.listen(port, '127.0.0.1', () => {
      listeners.push(listener)
      const address = listener.address()
      resolve(address !== null && typeof address === 'object' ? address.port : 'no address')
    })
  })
}

/**
 * Hold `port`, failing the case when the bind does not hold.
 * @param port - the port; 0 lets the system pick one.
 * @returns the held socket, closed after the case.
 */
function hold(port: number): HeldListenSocket {
  const result = holdLoopbackPort(port)
  if (result.kind !== 'held') throw new Error(`expected a held socket: ${result.reason}`)
  held.push(result.socket)
  return result.socket
}

describe('holdLoopbackPort', () => {
  it('holds a port the system picks and reports the one getsockname names', () => {
    const socket = hold(0)
    expect(socket.port).toBeGreaterThan(0)
    expect(socket.port).toBeLessThanOrEqual(65_535)
  })

  it('holds the asked port when it is free', () => {
    const socket = hold(0)
    const port = socket.port
    socket.close()
    expect(hold(port).port).toBe(port)
  })

  // On Linux a socket that sets SO_REUSEADDR, as libuv does on every bind
  // there, may bind and listen on an address no socket listens on yet; the
  // address is kept from the first server's listen on, which
  // listen-handoff.spec.ts checks after a kill.
  it.skipIf(process.platform === 'linux')('keeps the address from every other listener while it holds it', async () => {
    const socket = hold(0)
    expect(await listenOn(socket.port)).toBe('EADDRINUSE')
  })

  it('returns no socket for a port a listener already holds', async () => {
    const taken = await listenOn(0)
    if (typeof taken !== 'number') throw new Error(`could not listen: ${taken}`)
    const result = holdLoopbackPort(taken)
    expect(result.kind).toBe('failed')
    if (result.kind === 'failed') expect(result.reason).toContain(`127.0.0.1:${String(taken)}`)
  })

  it('releases the port on close, and a second close does nothing', async () => {
    const socket = hold(0)
    socket.close()
    socket.close()
    expect(await listenOn(socket.port)).toBe(socket.port)
  })
})
