/**
 * What the approval toast's buttons do: the frame a pressed 「拒绝」 sends back
 * on `$events/result`, the window a pressed 「去看看」 brings back, the window a
 * press brings back instead when this shell can no longer answer, and when a
 * toast is taken off the screen.
 *
 * `notifications.ts` opens a real `WebSocket` and constructs a real
 * `Notification`. Both are replaced here — the socket by the stand-in
 * installed as the global before the module is imported, `electron` by the
 * mock below — while the answers themselves travel over `fetch` to a loopback
 * server, which is where the sent frame is read. `fetch` is wrapped rather
 * than replaced, so a test can assert that no answer was *issued* without
 * waiting on a round trip that is never going to arrive.
 * @module
 */

import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The Host's id for the shell's event client, as its `ready` frame reports it. */
const CLIENT = 'client-1'

/** The waterfall delivery every test in this file answers. */
const EVENT = 'event-1'

/** The path an answer is POSTed to; `RESULT_ENDPOINT` under the `/api` prefix. */
const RESULT_PATH = '/api/$events/result'

/** `NEXT_GRACE_MS`: how long the shell holds a delivery before answering `next`. */
const GRACE_MS = 60_000

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

/** A window the shell can find but the user is not looking at. */
const hiddenWindow = {
  isResizable: () => true,
  isVisible: () => false,
  isMinimized: () => false,
  isFocused: () => false,
}

const notifications: FakeNotification[] = []
const sockets: FakeSocket[] = []
const quitHandlers: (() => void)[] = []
const windows: (typeof hiddenWindow)[] = []

/**
 * The app-level hooks, which bind on the first `setupNotifications` call ever
 * and stay bound for the module's life; they read the current generation, so
 * every later test's generation is reached through the same handlers.
 */
const appHandlers = new Map<string, () => void>()

vi.mock('electron', () => ({
  app: {
    dock: undefined,
    on: (event: string, handler: () => void) => { appHandlers.set(event, handler) },
    once: (_event: string, handler: () => void) => { quitHandlers.push(handler) },
  },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: FakeNotification,
}))

vi.stubGlobal('WebSocket', FakeSocket)

/** Every `/api` path the module POSTed, recorded as the request was issued. */
const posted: string[] = []

const realFetch = globalThis.fetch
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (init?.method === 'POST') posted.push(new URL(href).pathname)
  return realFetch(input, init)
})

const { setupNotifications } = await import('../src/notifications.ts')

/** The `$events/result` payloads the loopback server received, in order. */
const answers: Record<string, unknown>[] = []

/** Every line the shell logged. */
const lines: string[] = []

/** How many times the shell was asked to bring the window back. */
let reveals = 0

/** Whether the next `$events/result` is answered with a server failure. */
let failNextResult = false

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
      const failing = frame.method === '$events/result' && failNextResult
      if (frame.method === '$events/result') {
        answers.push(frame.payload.args)
        failNextResult = false
      }
      if (failing) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('nope')
        return
      }
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
 * Let every microtask a press queued run, and the event loop turn once. The
 * module issues its answer POST from a promise chain over an already-minted
 * cookie, so a press that answered anything has reached `fetch` — and so is in
 * {@link posted} — by the time this resolves.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

/** How many answers the module has issued, whatever became of them. */
function issuedAnswers(): number {
  return posted.filter(path => path === RESULT_PATH).length
}

/**
 * Subscribe an unattended shell on Windows and register its event client.
 * @returns the stream socket the module opened.
 */
async function subscribed(): Promise<FakeSocket> {
  setupNotifications({ log: (line) => { lines.push(line) }, reveal: () => { reveals += 1 } }, await serving())
  await until(() => sockets.length === 1, 'the stream socket')
  const socket = sockets[0]!
  socket.emit('open', {})
  socket.deliver({ type: 'ready', clientId: CLIENT })
  return socket
}

/**
 * Deliver one `approval/request` waterfall frame.
 * @param socket - the stream socket to deliver it on.
 * @param eventId - the delivery's id.
 */
function deliverApproval(socket: FakeSocket, eventId = EVENT): void {
  socket.deliver({
    type: 'waterfall', event: 'approval/request', eventId, agentId: 'session-1',
    request: { toolName: 'Bash' },
  })
}

/**
 * Subscribe, register, and deliver one approval request to an unattended
 * shell on Windows.
 * @returns the toast it raised.
 */
async function announcedApproval(): Promise<FakeNotification> {
  deliverApproval(await subscribed())
  await until(() => notifications.length === 1, 'the toast')
  return notifications[0]!
}

describe('the approval toast', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32', writable: false, enumerable: true, configurable: true })
    windows.push(hiddenWindow)
  })

  afterEach(async () => {
    for (const stop of quitHandlers) stop()
    Object.defineProperty(process, 'platform', { value: realPlatform, writable: false, enumerable: true, configurable: true })
    notifications.length = 0
    sockets.length = 0
    answers.length = 0
    lines.length = 0
    posted.length = 0
    windows.length = 0
    reveals = 0
    failNextResult = false
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
    await settle()
    expect(reveals).toBe(1)
    expect(issuedAnswers()).toBe(0)
    expect(toast.closed).toBe(1)
  })

  it('still reveals the window when the toast itself is clicked', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('click')?.({ actionIndex: 0 })
    await settle()
    expect(reveals).toBe(1)
    expect(issuedAnswers()).toBe(0)
  })

  it('shows the window instead of answering when 拒绝 is pressed after the page answered', async () => {
    const toast = await announcedApproval()
    sockets[0]?.deliver({ type: 'cancel', eventId: EVENT })
    // The request is settled: the toast asks for a decision already made.
    expect(toast.closed).toBe(1)
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await settle()
    expect(issuedAnswers()).toBe(0)
    expect(reveals).toBe(1)
    expect(lines.some(line => line.includes(`approval ${EVENT}: this shell no longer waits on it`))).toBe(true)
  })

  it('shows the window instead of answering when 拒绝 is pressed twice', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await until(() => answers.length === 1, 'the answer')
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await settle()
    expect(issuedAnswers()).toBe(1)
    expect(reveals).toBe(1)
    expect(lines.some(line => line.includes(`approval ${EVENT}: this shell no longer waits on it`))).toBe(true)
  })

  it('shows the window instead of answering while the stream is between reconnects', async () => {
    const toast = await announcedApproval()
    // A closed socket takes this shell's registration and its deliveries with
    // it; the Host replays what is still pending to the next registration.
    sockets[0]?.emit('close', {})
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await settle()
    expect(issuedAnswers()).toBe(0)
    expect(reveals).toBe(1)
    expect(lines.some(line => line.includes(`approval ${EVENT}: this shell no longer waits on it`))).toBe(true)
  })

  it('raises no toast for a delivery cancelled while its session was being named', async () => {
    const socket = await subscribed()
    deliverApproval(socket)
    socket.deliver({ type: 'cancel', eventId: EVENT })
    await until(
      () => lines.some(line => line.includes(`delivery ${EVENT} was settled while its session was being named`)),
      'the suppressed announcement',
    )
    expect(notifications).toHaveLength(0)
  })

  it('closes the toast when its own grace answer goes out', async () => {
    // No window yet: the grace does not start, so it can be armed on the fake
    // clock below rather than on the real one this setup runs against.
    windows.length = 0
    const toast = await announcedApproval()
    expect(toast.closed).toBe(0)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      windows.push(hiddenWindow)
      appHandlers.get('browser-window-created')?.()
      vi.advanceTimersByTime(GRACE_MS)
    } finally {
      vi.useRealTimers()
    }
    await until(() => answers.length === 1, 'the grace answer')
    expect(answers[0]).toEqual({ clientId: CLIENT, eventId: EVENT, outcome: { kind: 'next' } })
    expect(toast.closed).toBe(1)
  })

  it('sends the refusal again when a delivery it failed on is replayed', async () => {
    const toast = await announcedApproval()
    failNextResult = true
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await until(() => lines.some(line => line.includes(`event answer ${EVENT} not accepted`)), 'the failed answer')
    // The Host never recorded the refusal, so it replays the delivery. A fresh
    // grace would answer `next` in its place, and no second toast would ask.
    deliverApproval(sockets[0]!)
    await until(() => answers.length === 2, 'the resent answer')
    expect(answers[1]).toEqual({
      clientId: CLIENT,
      eventId: EVENT,
      outcome: { kind: 'result', value: 'rejected' },
    })
    expect(notifications).toHaveLength(1)
  })
})
