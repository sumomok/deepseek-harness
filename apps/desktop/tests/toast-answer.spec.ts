/**
 * What the approval toast's buttons do: the frame a pressed 「拒绝」 sends back
 * on `$events/result`, the window a pressed 「去看看」 brings back, and the
 * nothing that happens once the request was settled without them.
 *
 * `notifications.ts` opens a real `WebSocket` and constructs a real
 * `Notification`. Both are replaced here — the socket by the stand-in
 * installed as the global before the module is imported, `electron` by the
 * mock below — while the answers themselves travel over `fetch` to a loopback
 * server, which is where the sent frame is read.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The Host's id for the shell's event client, as its `ready` frame reports it. */
const CLIENT = 'client-1'

/** The waterfall delivery every test in this file answers. */
const EVENT = 'event-1'

/** One notification the module constructed, with the handlers it attached to it. */
class FakeNotification {
  readonly handlers = new Map<string, (details: { actionIndex: number }) => void>()
  closed = 0
  shown = 0
  constructor(readonly options: { title: string; body: string; actions: unknown }) {
    notifications.push(this)
  }

  static isSupported(): boolean {
    return true
  }

  on(event: string, handler: (details: { actionIndex: number }) => void): void {
    this.handlers.set(event, handler)
  }

  close(): void {
    this.closed += 1
  }

  show(): void {
    this.shown += 1
  }
}

/** One socket the module opened, with the frames it sent and the listeners on it. */
class FakeSocket {
  readonly sent: string[] = []
  private readonly listeners = new Map<string, ((event: unknown) => void)[]>()
  constructor(readonly url: string, readonly init: { headers: Record<string, string> }) {
    sockets.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(): void {
    // Nothing reopens here: a test's generation is stopped through the
    // `before-quit` hook, and a `close` event would only arm a reconnect.
  }

  /** Deliver one event to the listeners the module attached. */
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  /** Deliver one item of the `$events` stream this socket carries. */
  deliver(value: Record<string, unknown>): void {
    const open = JSON.parse(this.sent[0] ?? '{}') as { streamId?: string }
    this.emit('message', { data: JSON.stringify({ streamId: open.streamId, type: 'item', value }) })
  }
}

const notifications: FakeNotification[] = []
const sockets: FakeSocket[] = []
const quitHandlers: (() => void)[] = []

vi.mock('electron', () => ({
  app: {
    dock: undefined,
    on: () => undefined,
    once: (_event: string, handler: () => void) => { quitHandlers.push(handler) },
  },
  BrowserWindow: { getAllWindows: () => [] },
  Notification: FakeNotification,
}))

vi.stubGlobal('WebSocket', FakeSocket)

const { setupNotifications } = await import('../src/notifications.ts')

/** The `$events/result` payloads the loopback server received, in order. */
const answers: Record<string, unknown>[] = []

/** Every line the shell logged. */
const lines: string[] = []

/** How many times the shell was asked to bring the window back. */
let reveals = 0

const realPlatform = process.platform
let server: Server | undefined

/**
 * Serve the launch-token exchange and the two unary endpoints the notifier
 * calls, recording every `$events/result` payload.
 * @returns the launch-token URL to hand {@link setupNotifications}.
 */
async function serving(): Promise<string> {
  const created = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(303, { location: '/', 'set-cookie': 'dsh.test=value; Path=/; HttpOnly' })
      response.end()
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      const frame = JSON.parse(body) as { method: string; payload: { args: Record<string, unknown> } }
      if (frame.method === '$events/result') answers.push(frame.payload.args)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { ok: true, value: { items: [] } } }))
    })
  })
  await new Promise<void>((resolve) => { created.listen(0, '127.0.0.1', resolve) })
  const address = created.address()
  if (address === null || typeof address === 'string') throw new Error('loopback server did not bind a port')
  server = created
  return `http://127.0.0.1:${String(address.port)}/?token=abc`
}

/**
 * Poll until a condition holds, so a test never depends on how many
 * microtasks a loopback round trip happens to take.
 * @param ready - the condition.
 * @param what - what the failure message says was never reached.
 */
async function until(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) return
    await new Promise<void>((resolve) => { setTimeout(resolve, 5) })
  }
  throw new Error(`${what} never happened`)
}

/**
 * Subscribe, register, and deliver one approval request to an unattended
 * shell on Windows.
 * @returns the toast it raised.
 */
async function announcedApproval(): Promise<FakeNotification> {
  setupNotifications({ log: (line) => { lines.push(line) }, reveal: () => { reveals += 1 } }, await serving())
  await until(() => sockets.length === 1, 'the stream socket')
  const socket = sockets[0]!
  socket.emit('open', {})
  socket.deliver({ type: 'ready', clientId: CLIENT })
  socket.deliver({
    type: 'waterfall', event: 'approval/request', eventId: EVENT, agentId: 'session-1',
    request: { toolName: 'Bash' },
  })
  await until(() => notifications.length === 1, 'the toast')
  return notifications[0]!
}

describe('the approval toast', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: false, enumerable: true, configurable: true })
  })

  afterEach(async () => {
    for (const stop of quitHandlers) stop()
    Object.defineProperty(process, 'platform', { value: realPlatform, writable: false, enumerable: true, configurable: true })
    notifications.length = 0
    sockets.length = 0
    answers.length = 0
    lines.length = 0
    reveals = 0
    const running = server
    server = undefined
    if (running !== undefined) await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
  })

  it('offers the refusal and the look, and no approval at all', async () => {
    const toast = await announcedApproval()
    expect(toast.options.actions).toEqual([
      { type: 'button', text: '拒绝' },
      { type: 'button', text: '去看看' },
    ])
    expect(toast.shown).toBe(1)
  })

  it('answers the delivery with the approval vocabulary\'s refusal when 拒绝 is pressed', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await until(() => answers.length === 1, 'the answer')
    expect(answers[0]).toEqual({
      clientId: CLIENT,
      eventId: EVENT,
      outcome: { kind: 'result', value: 'rejected' },
    })
    // The action centre keeps a shown toast, buttons and all, until it is
    // dismissed; the pressed one has had its say.
    expect(toast.closed).toBe(1)
  })

  it('brings the window back and answers nothing when 去看看 is pressed', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('action')?.({ actionIndex: 1 })
    expect(reveals).toBe(1)
    expect(answers).toEqual([])
  })

  it('still reveals the window when the toast itself is clicked', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('click')?.({ actionIndex: 0 })
    expect(reveals).toBe(1)
    expect(answers).toEqual([])
  })

  it('does nothing when 拒绝 is pressed after the page answered', async () => {
    const toast = await announcedApproval()
    sockets[0]?.deliver({ type: 'cancel', eventId: EVENT })
    toast.handlers.get('action')?.({ actionIndex: 0 })
    expect(answers).toEqual([])
    expect(lines.some(line => line.includes(`approval ${EVENT} was answered already`))).toBe(true)
  })

  it('does nothing when 拒绝 is pressed twice', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await until(() => answers.length === 1, 'the answer')
    toast.handlers.get('action')?.({ actionIndex: 0 })
    expect(answers).toHaveLength(1)
    expect(lines.some(line => line.includes(`approval ${EVENT} was answered already`))).toBe(true)
  })
})
