/**
 * The reconnect backoff schedule, the launch-token cookie exchange, the
 * approval toast's buttons, and the end of the reconnect loop once the stream
 * is stopped. The rest of `notifications.ts` reaches into
 * `electron` (`app`, `Notification`) the way every other Electron-facing
 * module in this package does and is exercised by the real-process check
 * instead; the stand-in module below is what lets these be imported at all.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { dock: undefined, on: () => undefined, once: () => undefined },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: { isSupported: () => false },
}))

const {
  approvalActions, exchangeLaunchToken, reconnectDelayMs, setupNotifications, stopNotifications, toastButtons,
} = await import('../src/notifications.ts')

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

describe('approvalActions', () => {
  it('offers a refusal and a way to look, in that order, and never an approval', () => {
    const actions = approvalActions(() => undefined, () => undefined)
    expect(actions.map(action => action.text)).toEqual(['拒绝', '去看看'])
  })

  it('presses the refusal at index 0 and the reveal at index 1', () => {
    const pressed: string[] = []
    const actions = approvalActions(() => { pressed.push('reject') }, () => { pressed.push('reveal') })
    actions[0]?.press()
    actions[1]?.press()
    expect(pressed).toEqual(['reject', 'reveal'])
  })
})

describe('toastButtons', () => {
  const actions = approvalActions(() => undefined, () => undefined)

  it('draws one button per action on Windows, in order', () => {
    expect(toastButtons(actions, 'win32')).toEqual([
      { type: 'button', text: '拒绝' },
      { type: 'button', text: '去看看' },
    ])
  })

  it('draws none on a platform whose notifications ignore them', () => {
    expect(toastButtons(actions, 'linux')).toEqual([])
    expect(toastButtons(actions, 'darwin')).toEqual([])
  })

  it('draws none for a message that asks for nothing', () => {
    expect(toastButtons([], 'win32')).toEqual([])
  })
})

describe('stopNotifications', () => {
  let server: Server | undefined
  afterEach(async () => {
    stopNotifications()
    vi.useRealTimers()
    if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
    server = undefined
  })

  it('ends the reconnect loop: a running stream retries its cookie exchange, a stopped one sends nothing more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true })
    const exchanges: string[] = []
    // A server that refuses every launch token, as one that no longer knows it does.
    const refusing = createServer((request, response) => {
      exchanges.push(request.url ?? '')
      response.writeHead(401)
      response.end()
    })
    server = refusing
    await new Promise<void>((resolve) => { refusing.listen(0, '127.0.0.1', resolve) })
    const address = refusing.address()
    if (address === null || typeof address === 'string') throw new Error('loopback server did not bind a port')
    const lines: string[] = []
    setupNotifications({ log: (line) => { lines.push(line) }, reveal: () => {} }, `http://127.0.0.1:${String(address.port)}/?token=abc`)
    await vi.waitFor(() => { expect(lines.join('')).toContain('cookie exchange failed') })
    expect(exchanges).toEqual(['/?token=abc'])
    await vi.advanceTimersByTimeAsync(reconnectDelayMs(2))
    await vi.waitFor(() => { expect(exchanges).toHaveLength(2) })
    stopNotifications()
    // Each round lets every retry due within a minute fire, then gives a
    // request it started 100 ms of real time to reach the server.
    for (let round = 0; round < 5; round += 1) {
      await vi.advanceTimersByTimeAsync(60_000)
      await new Promise((resolve) => { setTimeout(resolve, 100) })
    }
    expect(exchanges).toHaveLength(2)
  })
})
