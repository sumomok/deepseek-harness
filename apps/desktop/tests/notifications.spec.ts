/**
 * The reconnect backoff schedule and the launch-token cookie exchange of the
 * notification streams. The rest of `notifications.ts` reaches into
 * `electron` (`app`, `Notification`) the way every other Electron-facing
 * module in this package does, and is exercised by the real-process check
 * instead — see `dsh-server.log` excerpts in the PR description, not a unit
 * test here.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { exchangeLaunchToken, reconnectDelayMs } from '../src/notifications.ts'

/** Serve one fixed answer on loopback and report the URL to fetch. */
async function answering(status: number, headers: Record<string, string>): Promise<{ url: string; server: Server }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, headers)
    response.end()
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('loopback server did not bind a port')
  return { url: `http://127.0.0.1:${String(address.port)}/?token=abc`, server }
}

describe('exchangeLaunchToken', () => {
  const servers: Server[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })

  it('returns the name=value pair of the cookie a 303 exchange sets', async () => {
    const { url, server } = await answering(303, {
      location: '/',
      'set-cookie': 'dsh.127.0.0.1.7777=signed-value; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400',
    })
    servers.push(server)
    await expect(exchangeLaunchToken(url)).resolves.toBe('dsh.127.0.0.1.7777=signed-value')
  })

  it('refuses a 401 answer: the streams must not open without the cookie', async () => {
    const { url, server } = await answering(401, { 'content-type': 'text/plain' })
    servers.push(server)
    await expect(exchangeLaunchToken(url)).rejects.toThrow('answered 401 without a session cookie')
  })

  it('refuses a redirect that sets no cookie', async () => {
    const { url, server } = await answering(303, { location: '/' })
    servers.push(server)
    await expect(exchangeLaunchToken(url)).rejects.toThrow('answered 303 without a session cookie')
  })
})

describe('reconnectDelayMs', () => {
  it('starts at the base delay and doubles each consecutive attempt', () => {
    expect(reconnectDelayMs(1)).toBe(3_000)
    expect(reconnectDelayMs(2)).toBe(6_000)
    expect(reconnectDelayMs(3)).toBe(12_000)
    expect(reconnectDelayMs(4)).toBe(24_000)
    expect(reconnectDelayMs(5)).toBe(48_000)
  })

  it('caps at 60s and stays capped for every attempt after that', () => {
    expect(reconnectDelayMs(6)).toBe(60_000)
    expect(reconnectDelayMs(7)).toBe(60_000)
    expect(reconnectDelayMs(20)).toBe(60_000)
  })
})
