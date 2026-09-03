/**
 * The reconnect backoff schedule, the launch-token cookie exchange, and the
 * download notice. The stream half of `notifications.ts` reaches into
 * `electron` (`app`, `Notification`) the way every other Electron-facing
 * module in this package does and is exercised by the real-process check
 * instead; `announceDownload` is covered here against a stand-in `electron`,
 * because what it promises the user — a click that reveals the saved file — is
 * a callback no log line can show.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  class StandInNotification {
    static supported = true
    static instances: StandInNotification[] = []
    /** Paths `shell.showItemInFolder` was asked to reveal, recorded here so no test holds an unbound method. */
    static revealed: string[] = []
    readonly listeners = new Map<string, () => void>()
    shown = false
    constructor(readonly options: { title: string; body: string }) {
      StandInNotification.instances.push(this)
    }

    static isSupported(): boolean {
      return StandInNotification.supported
    }

    on(event: string, listener: () => void): this {
      this.listeners.set(event, listener)
      return this
    }

    show(): void {
      this.shown = true
    }
  }
  return {
    app: { dock: undefined, on: () => undefined },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: StandInNotification,
    shell: { showItemInFolder: (path: string) => { StandInNotification.revealed.push(path) } },
  }
})

const { Notification } = await import('electron')
const { announceDownload, exchangeLaunchToken, reconnectDelayMs } = await import('../src/notifications.ts')

/** The stand-in's own surface, which the `electron` types do not describe. */
interface StandIn {
  supported: boolean
  instances: { options: { title: string; body: string }; listeners: Map<string, () => void>; shown: boolean }[]
  revealed: string[]
}

const standIn = Notification as unknown as StandIn

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

describe('announceDownload', () => {
  beforeEach(() => {
    standIn.supported = true
    standIn.instances.length = 0
    standIn.revealed.length = 0
  })

  it('reveals the saved file when a completed notice is clicked', () => {
    announceDownload({ title: '已保存到下载', body: 'dsh-session-session-1.zip', savePath: '/d/dsh-session-session-1.zip' })
    const notice = standIn.instances[0]
    expect(notice?.options).toEqual({ title: '已保存到下载', body: 'dsh-session-session-1.zip' })
    expect(notice?.shown).toBe(true)
    expect(standIn.revealed).toEqual([])
    notice?.listeners.get('click')?.()
    expect(standIn.revealed).toEqual(['/d/dsh-session-session-1.zip'])
  })

  it('registers no click on a notice with no file to reveal', () => {
    announceDownload({ title: '下载失败', body: 'dsh-session-session-1.zip:传输中断,请重新导出' })
    const notice = standIn.instances[0]
    expect(notice?.listeners.has('click')).toBe(false)
    expect(notice?.shown).toBe(true)
  })

  it('posts nothing where the platform supports no notifications', () => {
    standIn.supported = false
    announceDownload({ title: '已保存到下载', body: 'dsh-session-session-1.zip', savePath: '/d/dsh-session-session-1.zip' })
    expect(standIn.instances).toHaveLength(0)
  })
})
