/**
 * What the approval toast's buttons do: the frame a pressed 「拒绝」 sends back
 * on `$events/result`, the window a pressed 「去看看」 brings back, the window a
 * press brings back instead when this shell can no longer answer, and when a
 * toast is taken off the screen. What a toast calls its session: the title
 * `session/list` reports, or 「会话」 with a log line when the lookup fails.
 * What a delivered reminder announces, which deliveries count as new against
 * the `schedule/catalog` baseline, and which finished-run message the
 * reminder's replaces. On macOS, what the Dock badge counts and when a count
 * comes off it.
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

/** The projected title `session/list` reports for `session-1`, the session every delivery here comes from. */
const TITLE = '周报整理'

/**
 * The sessions `session/list` reports, in its order: `session-1` between two
 * other sessions whose titles differ from {@link TITLE}, so a message that
 * takes its title from any record but `session-1`'s reads another title.
 */
const LISTED_SESSIONS = [
  { sessionId: 'session-0', projections: { values: { title: '月度预算' } } },
  { sessionId: 'session-1', projections: { values: { title: TITLE } } },
  { sessionId: 'session-2', projections: { values: { title: '旅行计划' } } },
]

/** The message of the `session/list` refusal a case asks for through {@link listFailures}. */
const UNAVAILABLE = 'sessionController is not available'

/** The name of the reminder {@link reminder} reports. */
const REMINDER = '交周报'

/** The instruction of the reminder {@link reminder} reports. */
const INSTRUCTION = '把本周的周报整理好发给我'

/** When the reminder {@link reminder} reports fell due: long before any run a test starts. */
const DUE = '2000-01-01T00:00:00.000Z'

/**
 * One `schedule/catalog` entry: a one-shot reminder bound to `session-1`,
 * delivered once as `messageId`.
 * @param messageId - the delivered message; a new id is a new delivery of the task.
 * @param fields - entry fields to replace.
 * @returns the entry.
 */
function reminder(messageId: string, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'schedule-1', kind: 'at', title: REMINDER, prompt: INSTRUCTION, scheduledAt: DUE,
    sessionId: 'session-1', status: 'inactive', lastDelivery: { scheduledAt: DUE, deliveredAt: DUE, messageId },
    ...fields,
  }
}

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

/** A window the user is looking at. */
const focusedWindow = {
  isResizable: () => true,
  isVisible: () => true,
  isMinimized: () => false,
  isFocused: () => true,
}

const notifications: FakeNotification[] = []

/** Every value the module set on the Dock badge, in order; the last one is what the Dock shows. */
const dockBadges: string[] = []

/** The Dock, recording what the badge was set to. */
const fakeDock = {
  setBadge: (text: string) => { dockBadges.push(text) },
  bounce: () => 0,
}
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
    dock: fakeDock,
    on: (event: string, handler: () => void) => { appHandlers.set(event, handler) },
    once: (_event: string, handler: () => void) => { quitHandlers.push(handler) },
  },
  BrowserWindow: { getAllWindows: () => windows },
  Notification: FakeNotification,
}))

vi.stubGlobal('WebSocket', FakeSocket)

/** Every `/api` path the module POSTed, recorded as the request was issued. */
const posted: string[] = []

/**
 * How many `$events/result` responses have reached the module and been read
 * as far as it reads them: the status of a failure, the body of a success.
 * The loopback server records an answer when the request arrives, before the
 * module has seen the response, so `answers` alone does not say that the
 * module's own handling of that response has run.
 */
let answersRead = 0

const realFetch = globalThis.fetch
vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = new URL(href).pathname
  if (init?.method === 'POST') posted.push(path)
  const response = await realFetch(input, init)
  if (path !== RESULT_PATH) return response
  if (!response.ok) {
    answersRead += 1
    return response
  }
  const json: () => Promise<unknown> = response.json.bind(response)
  response.json = async (): Promise<unknown> => {
    try {
      return await json()
    } finally {
      answersRead += 1
    }
  }
  return response
})

const { setupNotifications } = await import('../src/notifications.ts')

/** The `$events/result` payloads the loopback server received, in order. */
const answers: Record<string, unknown>[] = []

/** Every line the shell logged. */
const lines: string[] = []

/** How many times the shell was asked to bring the window back. */
let reveals = 0

/** How many more `$events/result` requests are answered with a failure. */
let resultFailures = 0

/** How many more well-formed `session/list` requests the gateway refuses. */
let listFailures = 0

/** The entries `schedule/catalog` reports, read as each request arrives. */
let catalog: Record<string, unknown>[] = []

/** How many more well-formed `schedule/catalog` requests the gateway refuses. */
let catalogFailures = 0

/**
 * How many `schedule/catalog` requests the loopback server answered. The
 * notifier sends each read only after the previous one was handled, so the
 * count passing N says the (N-1)th read's handling is over.
 */
let catalogReads = 0

afterEach(() => {
  catalog = []
  catalogFailures = 0
  catalogReads = 0
})

const realPlatform = process.platform
let server: Server | undefined

/**
 * What the gateway answers a `session/list` request with. Its server method
 * takes one parameter, `_request`, and the gateway refuses an `args` record
 * whose fields are not exactly that one, in an `ok: false` result sent with
 * HTTP 200. A well-formed request is refused while {@link listFailures} is
 * above zero, and otherwise answered with {@link LISTED_SESSIONS}.
 * @param args - the request's `args` record.
 * @returns the `result` the response carries.
 */
function listResult(args: Record<string, unknown>): Record<string, unknown> {
  const missing = Object.hasOwn(args, '_request') ? [] : ['_request']
  const extra = Object.keys(args).filter(key => key !== '_request')
  if (missing.length > 0 || extra.length > 0) {
    const clauses: string[] = []
    if (missing.length > 0) clauses.push(`missing ${missing.map(key => JSON.stringify(key)).join(', ')}`)
    if (extra.length > 0) clauses.push(`unexpected ${extra.map(key => JSON.stringify(key)).join(', ')}`)
    return { ok: false, error: { code: 'gateway/arguments-invalid', message: `args fields do not match the descriptor: ${clauses.join('; ')}` } }
  }
  if (listFailures > 0) {
    listFailures -= 1
    return { ok: false, error: { code: 'gateway/service-unavailable', message: UNAVAILABLE } }
  }
  return { ok: true, value: { items: LISTED_SESSIONS } }
}

/**
 * What the gateway answers a `schedule/catalog` request with. Its server
 * method takes no parameter, and the gateway refuses an `args` record with
 * any field. A well-formed request is refused while {@link catalogFailures}
 * is above zero, and otherwise answered with {@link catalog}.
 * @param args - the request's `args` record.
 * @returns the `result` the response carries.
 */
function catalogResult(args: Record<string, unknown>): Record<string, unknown> {
  catalogReads += 1
  const extra = Object.keys(args)
  if (extra.length > 0) {
    const fields = extra.map(key => JSON.stringify(key)).join(', ')
    return { ok: false, error: { code: 'gateway/arguments-invalid', message: `args fields do not match the descriptor: unexpected ${fields}` } }
  }
  if (catalogFailures > 0) {
    catalogFailures -= 1
    return { ok: false, error: { code: 'gateway/service-unavailable', message: 'schedule is not available' } }
  }
  return { ok: true, value: catalog }
}

/**
 * Serve the launch-token exchange and the three unary endpoints the notifier
 * calls, recording every `$events/result` payload and answering
 * `session/list` and `schedule/catalog` as {@link listResult} and
 * {@link catalogResult} say.
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
      if (frame.method === 'session/list') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: listResult(frame.payload.args) }))
        return
      }
      if (frame.method === 'schedule/catalog') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ result: catalogResult(frame.payload.args) }))
        return
      }
      const failing = frame.method === '$events/result' && resultFailures > 0
      if (frame.method === '$events/result') {
        answers.push(frame.payload.args)
        resultFailures = Math.max(0, resultFailures - 1)
      }
      if (failing) {
        response.writeHead(500, { 'content-type': 'text/plain' })
        response.end('nope')
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ result: { ok: true } }))
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

/**
 * Wait until the module has handled the Host's response to its `count`th
 * answer: the response was read, and every microtask the module's handler
 * queued has run.
 * @param count - how many answers must have been handled.
 * @param what - what the failure message says was never reached.
 */
async function answerHandled(count: number, what: string): Promise<void> {
  await until(() => answersRead >= count, what)
  await settle()
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
 * Deliver one `user-questions/request` waterfall frame.
 * @param socket - the stream socket to deliver it on.
 */
function deliverQuestion(socket: FakeSocket): void {
  socket.deliver({
    type: 'waterfall', event: 'user-questions/request', eventId: EVENT, agentId: 'session-1',
    request: { questions: [{ question: '要继续吗?' }] },
  })
}

/**
 * Arm one delivery's grace on a fake clock and let it fire. The shell parks an
 * answer with no window to wait for and starts its grace when one appears, so
 * a test that raises its toast without a window can put the whole minute on a
 * clock it controls.
 */
function graceElapses(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    windows.push(hiddenWindow)
    appHandlers.get('browser-window-created')?.()
    vi.advanceTimersByTime(GRACE_MS)
  } finally {
    vi.useRealTimers()
  }
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
    resultFailures = 0
    listFailures = 0
    answersRead = 0
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

  it('names the session by its title in the toast and in the log', async () => {
    const toast = await announcedApproval()
    expect(toast.options.body).toBe(`「${TITLE}」请求执行 Bash,正在等你批准。`)
    expect(lines).toContain(`[desktop] notify: 需要你的确认 — 「${TITLE}」请求执行 Bash,正在等你批准。\n`)
  })

  it('calls the session 会话 and logs the reason when its title cannot be looked up', async () => {
    listFailures = 1
    const toast = await announcedApproval()
    expect(toast.options.body).toBe('会话请求执行 Bash,正在等你批准。')
    expect(lines).toContain(`[desktop] session session-1 could not be named: session/list failed: gateway/service-unavailable: ${UNAVAILABLE}\n`)
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
    graceElapses()
    await until(() => answers.length === 1, 'the grace answer')
    expect(answers[0]).toEqual({ clientId: CLIENT, eventId: EVENT, outcome: { kind: 'next' } })
    expect(toast.closed).toBe(1)
  })

  it('closes a question toast too when its request is cancelled', async () => {
    const socket = await subscribed()
    deliverQuestion(socket)
    await until(() => notifications.length === 1, 'the toast')
    const toast = notifications[0]!
    expect(toast.options.actions).toEqual([])
    socket.deliver({ type: 'cancel', eventId: EVENT })
    expect(toast.closed).toBe(1)
  })

  it('announces a delivery whose stream closed while its session was being named', async () => {
    const socket = await subscribed()
    deliverApproval(socket)
    // The socket takes this shell's deliveries with it; the request itself is
    // untouched, and the Host replays it to the next registration.
    socket.emit('close', {})
    await until(
      () => lines.some(line => line.includes(`delivery ${EVENT} was settled while its session was being named`)),
      'the suppressed announcement',
    )
    expect(notifications).toHaveLength(0)
    socket.deliver({ type: 'ready', clientId: CLIENT })
    deliverApproval(socket)
    await until(() => notifications.length === 1, 'the replayed toast')
    expect(notifications[0]?.options.title).toBe('需要你的确认')
  })

  it('forgets a refusal the Host accepted, so a later replay is not answered again', async () => {
    const toast = await announcedApproval()
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await answerHandled(1, 'the accepted answer')
    // The Host removes an answering client from the delivery before settling,
    // so no `cancel` comes back for this shell's own refusal to clean up after.
    deliverApproval(sockets[0]!)
    await settle()
    expect(issuedAnswers()).toBe(1)
  })

  it('abstains once its refusal has failed twice, rather than holding the request open', async () => {
    windows.length = 0
    const toast = await announcedApproval()
    resultFailures = 2
    toast.handlers.get('action')?.({ actionIndex: 0 })
    await answerHandled(1, 'the failed answer')
    deliverApproval(sockets[0]!)
    // The second failure re-arms the grace from the module's response handler;
    // the grace below can only elapse once that handler has armed it.
    await answerHandled(2, 'the failed resend')
    graceElapses()
    await until(() => answers.length === 3, 'the abstention')
    expect(answers[2]).toEqual({ clientId: CLIENT, eventId: EVENT, outcome: { kind: 'next' } })
  })

  it('closes every toast it raised when its generation is stopped', async () => {
    const toast = await announcedApproval()
    // A rebind stops this generation and starts one against a new server,
    // whose delivery ids have nothing to do with the buttons still on screen.
    for (const stop of quitHandlers) stop()
    expect(toast.closed).toBe(1)
  })

  it('sends the refusal again when a delivery it failed on is replayed', async () => {
    const toast = await announcedApproval()
    resultFailures = 1
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

/**
 * Report a change of the schedule service's task table, as it does after
 * committing a delivery.
 * @param socket - the stream socket to deliver it on.
 */
function scheduleChanged(socket: FakeSocket): void {
  socket.deliver({ type: 'emit', event: 'schedule/changed', args: [] })
}

/**
 * Report `session-1`'s running bit.
 * @param socket - the stream socket to deliver it on.
 * @param running - whether the session is running now.
 */
function sessionRunning(socket: FakeSocket, running: boolean): void {
  socket.deliver({ type: 'emit', event: 'api-session/status', args: ['session-1', running] })
}

/**
 * Subscribe and register, and wait until the baseline read on `ready` has
 * been answered from {@link catalog}.
 * @returns the stream socket the module opened.
 */
async function seeded(): Promise<FakeSocket> {
  const socket = await subscribed()
  await until(() => catalogReads >= 1, 'the baseline read')
  return socket
}

/**
 * Whether the shell logged the line that drops the finished-run message of
 * the run a reminder woke.
 * @returns true once that line was written.
 */
function wokenRunEnded(): boolean {
  return lines.some(line => line.includes('session session-1 finished the run a reminder woke'))
}

describe('the reminder message', () => {
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
    listFailures = 0
    answersRead = 0
    const running = server
    server = undefined
    if (running !== undefined) await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
  })

  it('announces a delivery made since the baseline, naming the session and the reminder', async () => {
    const socket = await seeded()
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    expect(notifications[0]?.options).toEqual({ title: '提醒', body: `「${TITLE}」：${REMINDER}`, actions: [] })
    expect(notifications[0]?.shown).toBe(1)
    expect(lines).toContain(`[desktop] notify: 提醒 — 「${TITLE}」：${REMINDER}\n`)
    notifications[0]?.handlers.get('click')?.({ actionIndex: 0 })
    expect(reveals).toBe(1)
  })

  it('announces nothing for a delivery the baseline read on ready already holds', async () => {
    catalog = [reminder('message-1')]
    const socket = await seeded()
    catalog = [reminder('message-1'), reminder('message-2', { id: 'schedule-2', title: '交房租' })]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    await settle()
    expect(notifications.map(notification => notification.options.body)).toEqual([`「${TITLE}」：交房租`])
  })

  it('announces nothing while the window is attended, and does not announce that delivery afterwards', async () => {
    windows.length = 0
    windows.push(focusedWindow)
    const socket = await seeded()
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    scheduleChanged(socket)
    // The third read goes out once the first comparison has been decided.
    await until(() => catalogReads >= 3, 'the read after the attended comparison')
    windows.length = 0
    windows.push(hiddenWindow)
    catalog = [reminder('message-1'), reminder('message-2', { id: 'schedule-2', title: '交房租' })]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    await settle()
    expect(notifications.map(notification => notification.options.body)).toEqual([`「${TITLE}」：交房租`])
  })

  it('reads the baseline again when the stream reopens, so a delivery made while it was closed is not announced', async () => {
    const socket = await seeded()
    socket.emit('close', {})
    catalog = [reminder('message-1')]
    socket.deliver({ type: 'ready', clientId: CLIENT })
    await until(() => catalogReads >= 2, 'the second baseline read')
    catalog = [reminder('message-1'), reminder('message-2', { id: 'schedule-2', title: '交房租' })]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    await settle()
    expect(notifications.map(notification => notification.options.body)).toEqual([`「${TITLE}」：交房租`])
  })

  it('drops the finished-run message of the run the reminder woke, and of no later run', async () => {
    const socket = await seeded()
    sessionRunning(socket, true)
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    // The woken run ends while the catalog read is still in flight.
    sessionRunning(socket, false)
    await until(wokenRunEnded, 'the dropped finished-run message')
    expect(notifications.map(notification => notification.options.title)).toEqual(['提醒'])
    sessionRunning(socket, true)
    sessionRunning(socket, false)
    await until(() => notifications.length === 2, 'the next run\'s message')
    expect(notifications[1]?.options.title).toBe('任务已完成')
    expect(notifications[1]?.options.body).toBe(`「${TITLE}」已经跑完,可以回来看结果了。`)
  })

  it('forgets the woken run when the stream reopens, whose end the closed stream never carried', async () => {
    const socket = await seeded()
    sessionRunning(socket, true)
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    // The woken run ends while the stream is closed; a later run then starts.
    socket.emit('close', {})
    socket.deliver({ type: 'ready', clientId: CLIENT })
    sessionRunning(socket, true)
    sessionRunning(socket, false)
    await until(() => notifications.length === 2, 'the later run\'s message')
    expect(notifications[1]?.options.title).toBe('任务已完成')
    expect(wokenRunEnded()).toBe(false)
  })

  it('keeps the finished-run message of a run that started before the reminder fell due', async () => {
    const socket = await seeded()
    sessionRunning(socket, true)
    await new Promise<void>((resolve) => { setTimeout(resolve, 20) })
    const due = new Date().toISOString()
    catalog = [reminder('message-1', { scheduledAt: due, lastDelivery: { scheduledAt: due, deliveredAt: due, messageId: 'message-1' } })]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    sessionRunning(socket, false)
    await until(() => notifications.length === 2, 'the finished-run message')
    expect(notifications.map(notification => notification.options.title)).toEqual(['提醒', '任务已完成'])
    expect(wokenRunEnded()).toBe(false)
  })

  it('calls the session 会话 when its title cannot be looked up', async () => {
    const socket = await seeded()
    listFailures = 1
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the reminder toast')
    expect(notifications[0]?.options.body).toBe(`会话：${REMINDER}`)
  })

  it('quotes the instruction of a reminder without a name, and says only that one arrived when it has neither', async () => {
    const socket = await seeded()
    catalog = [
      reminder('message-1', { title: ' ' }),
      reminder('message-2', { id: 'schedule-2', title: '', prompt: '' }),
    ]
    scheduleChanged(socket)
    await until(() => notifications.length === 2, 'both reminder toasts')
    expect(notifications.map(notification => notification.options.body)).toEqual([
      `「${TITLE}」：${INSTRUCTION}`,
      `「${TITLE}」有一条提醒到了。`,
    ])
  })

  it('logs a failed read, announces nothing, and takes the next read as the baseline', async () => {
    const socket = await seeded()
    catalogFailures = 1
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    await until(
      () => lines.includes('[desktop] reminder deliveries could not be read: schedule/catalog failed: gateway/service-unavailable: schedule is not available\n'),
      'the failed read',
    )
    scheduleChanged(socket)
    await until(() => lines.includes('[desktop] reminder deliveries read as a new baseline; nothing announced\n'), 'the new baseline')
    expect(notifications).toHaveLength(0)
    catalog = [reminder('message-2')]
    scheduleChanged(socket)
    await until(() => notifications.length === 1, 'the next delivery\'s toast')
    expect(notifications[0]?.options.body).toBe(`「${TITLE}」：${REMINDER}`)
  })
})

/** What the Dock badge shows now; an empty string is no badge. */
function shownBadge(): string {
  return dockBadges.at(-1) ?? ''
}

describe('the macOS Dock badge', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin', writable: false, enumerable: true, configurable: true })
    windows.push(hiddenWindow)
  })

  afterEach(async () => {
    for (const stop of quitHandlers) stop()
    // The finished-run count outlives a generation; focus is what clears it.
    appHandlers.get('browser-window-focus')?.()
    Object.defineProperty(process, 'platform', { value: realPlatform, writable: false, enumerable: true, configurable: true })
    notifications.length = 0
    sockets.length = 0
    answers.length = 0
    lines.length = 0
    posted.length = 0
    windows.length = 0
    dockBadges.length = 0
    answersRead = 0
    const running = server
    server = undefined
    if (running !== undefined) await new Promise<void>((resolve) => { running.close(() => { resolve() }) })
  })

  /**
   * Deliver approvals and wait until the badge counts all of them.
   * @param socket - the stream socket to deliver them on.
   * @param eventIds - the deliveries.
   */
  async function badgedApprovals(socket: FakeSocket, ...eventIds: string[]): Promise<void> {
    for (const eventId of eventIds) deliverApproval(socket, eventId)
    await until(() => shownBadge() === String(eventIds.length), 'the badge count')
  }

  it('counts each waiting request and raises no toast', async () => {
    await badgedApprovals(await subscribed(), 'event-a', 'event-b')
    expect(shownBadge()).toBe('2')
    expect(notifications).toHaveLength(0)
  })

  it('takes a request off the badge when someone else answered it', async () => {
    const socket = await subscribed()
    await badgedApprovals(socket, 'event-a', 'event-b')
    socket.deliver({ type: 'cancel', eventId: 'event-a' })
    expect(shownBadge()).toBe('1')
    socket.deliver({ type: 'cancel', eventId: 'event-b' })
    expect(shownBadge()).toBe('')
  })

  it('takes a request off once, however many cancels name it', async () => {
    const socket = await subscribed()
    await badgedApprovals(socket, 'event-a', 'event-b')
    socket.deliver({ type: 'cancel', eventId: 'event-a' })
    socket.deliver({ type: 'cancel', eventId: 'event-a' })
    socket.deliver({ type: 'cancel', eventId: 'event-unknown' })
    expect(shownBadge()).toBe('1')
  })

  it('clears on focus, stays clear when a counted request is cancelled after that, and counts afresh', async () => {
    const socket = await subscribed()
    await badgedApprovals(socket, 'event-a')
    appHandlers.get('browser-window-focus')?.()
    expect(shownBadge()).toBe('')
    socket.deliver({ type: 'cancel', eventId: 'event-a' })
    expect(shownBadge()).toBe('')
    deliverApproval(socket, 'event-b')
    await until(() => shownBadge() === '1', 'the fresh count')
  })

  it('does not count a replay of a request it already counts', async () => {
    const socket = await subscribed()
    await badgedApprovals(socket, 'event-a')
    deliverApproval(socket, 'event-a')
    await settle()
    expect(shownBadge()).toBe('1')
  })

  it('keeps a finished run on the badge when a request is cancelled', async () => {
    const socket = await subscribed()
    socket.deliver({ type: 'emit', event: 'api-session/status', args: ['session-1', true] })
    socket.deliver({ type: 'emit', event: 'api-session/status', args: ['session-1', false] })
    await until(() => shownBadge() === '1', 'the finished run')
    deliverApproval(socket, 'event-a')
    await until(() => shownBadge() === '2', 'the request')
    socket.deliver({ type: 'cancel', eventId: 'event-a' })
    expect(shownBadge()).toBe('1')
  })

  it('counts a reminder once, together with the run it woke', async () => {
    const socket = await seeded()
    sessionRunning(socket, true)
    catalog = [reminder('message-1')]
    scheduleChanged(socket)
    sessionRunning(socket, false)
    await until(wokenRunEnded, 'the dropped finished-run message')
    expect(shownBadge()).toBe('1')
    expect(notifications).toHaveLength(0)
  })

  it('drops the requests of a generation that was stopped', async () => {
    await badgedApprovals(await subscribed(), 'event-a')
    for (const stop of quitHandlers) stop()
    expect(shownBadge()).toBe('')
  })

  it('keeps counting a request after its own grace answer, which the page still holds', async () => {
    windows.length = 0
    await badgedApprovals(await subscribed(), EVENT)
    graceElapses()
    await until(() => answers.length === 1, 'the grace answer')
    expect(answers[0]).toEqual({ clientId: CLIENT, eventId: EVENT, outcome: { kind: 'next' } })
    expect(shownBadge()).toBe('1')
  })
})
