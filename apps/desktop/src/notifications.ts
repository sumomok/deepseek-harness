/**
 * Telling the user that a session wants them back, when the window is not the
 * thing they are looking at.
 *
 * Two moments qualify: a session **finished running**, and a session is
 * **waiting for an answer** — a tool approval, or a question the agent asked
 * (plan review is one of those). Nothing else interrupts.
 *
 * The shell reads both from the server it already started, as one more
 * client of the Typert Remote event stream the browser UI itself consumes:
 * the `/api/remote.mux` WebSocket, one logical `$events` stream on it.
 *
 * - `api-session/status` is emitted with `(sessionId, running)`; the bit going
 *   from true to false is the only true "the agent stopped" edge. The durable
 *   `turn/end` log event is not that edge — a turn can be followed straight
 *   away by another one — and the bit stays `running` while a tool waits for
 *   an approval, which is what keeps the two cases from overlapping.
 * - `approval/request` and `user-questions/request` arrive as **waterfall
 *   deliveries**, each with an event id that a later `cancel` frame names once
 *   someone answered. The stream replays every delivery still pending whenever
 *   it is (re)opened, which is why each id is remembered and a repeat is
 *   dropped rather than announced twice.
 *
 * A waterfall delivery is owed an answer: the Host holds the request until
 * every client it was delivered to has answered, and settles it as unanswered
 * (`next`) only when the last one does. The shell never decides anything, so
 * its answer is always `next` — but WHEN it answers matters. While the app
 * window is open the browser is the one deciding, and the shell answers at
 * once so that a request the browser declines to handle falls through the
 * way it would with no shell at all. With no window (macOS keeps the app and
 * its server alive after the window closes), an immediate `next` would settle
 * the request as unanswered before the user could ever see it; the shell holds
 * its answer, and releases every held one a grace period after the next
 * window finished loading — long enough for that window's page to register
 * its own client and receive the same pending deliveries.
 *
 * A Node client sends no `Origin` header, and the server's trust fence accepts
 * an absent one on a loopback `Host` — so no `Origin` is set here, and none may
 * be: an `Origin` that is not exactly the served authority is refused with 403.
 *
 * The stream sits behind the same browser-session gate as every other API
 * request: an upgrade without the authority-bound cookie is refused with 401.
 * The shell holds the process launch token (the `?token=` URL `startServer`
 * reported), so it mints its own cookie the way the browser does — one GET of
 * that URL answers 303 with `Set-Cookie` — and sends the cookie on the upgrade
 * and on the answers. The cookie is minted once per subscription generation
 * and again before a retry whenever the stream closed without ever opening,
 * which is what an expired cookie looks like from here.
 *
 * **The two platforms are told differently, and on purpose.** Windows gets a
 * system toast that raises the window when clicked. macOS gets a Dock badge and
 * one bounce, and no notification centre entry at all.
 * @module @deepseek-ai/dsh-desktop/notifications
 */

import { randomUUID } from 'node:crypto'
import { app, Notification, type BrowserWindow } from 'electron'
import { mainWindow } from './main-window.ts'

/** Path of the multiplexed Remote stream WebSocket (`REMOTE_STREAM_MUX_PATH` on the server). */
const MUX_PATH = '/api/remote.mux'

/** The logical stream carrying forwarded Host events (`REMOTE_EVENT_STREAM_ENDPOINT`). */
const EVENTS_ENDPOINT = '$events'

/** The unary endpoint a waterfall delivery is answered through (`REMOTE_EVENT_RESULT_ENDPOINT`). */
const RESULT_ENDPOINT = '$events/result'

/** The unary endpoint listing sessions with their projected titles. */
const LIST_ENDPOINT = 'session/list'

/**
 * Delay before the first reopen of a stream that closed. The server is this
 * app's own child, so a close means it is restarting or going away rather than
 * that the network is unreliable; retrying slowly costs nothing and stops a
 * closed server from being polled hard while it shuts down.
 */
const RECONNECT_BASE_MS = 3_000

/**
 * Growth applied to the reconnect delay after each consecutive attempt that
 * closed without ever opening; a server that is down for minutes, not
 * seconds, does not need to be polled at the same 3s pace the whole time.
 */
const RECONNECT_BACKOFF_FACTOR = 2

/**
 * Upper bound on the reconnect delay. A server that comes back must still be
 * noticed in reasonable time, so the backoff is capped rather than left to
 * grow for as long as the server stays down.
 */
const RECONNECT_MAX_MS = 60_000

/**
 * Log only the first reconnect attempt after a close and then every Nth one.
 * A server that stays dead closes this stream again every few seconds for as
 * long as it is dead, and none of those closes says anything the previous one
 * did not — logging every one is exactly the noise a dead server must not
 * fill the log with (the field case this exists for: 1318 lines from one
 * downed server over half an hour).
 */
const RECONNECT_LOG_EVERY = 10

/**
 * How long after a window finished loading its held answers are released.
 * The page registers its own event client shortly after load (the client
 * runtime allows itself 3s to establish a generation); releasing before that
 * would settle a held request as unanswered with nobody there to answer it.
 */
const WINDOW_READY_GRACE_MS = 5_000

/**
 * The reconnect delay before the `attempt`th consecutive attempt (1 for the
 * first attempt after a close), exponential up to {@link RECONNECT_MAX_MS}.
 * Pure so the backoff schedule is unit-testable without a real socket.
 * @param attempt - which consecutive closed-without-opening attempt this is, starting at 1.
 * @returns the delay in ms.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_BACKOFF_FACTOR ** (attempt - 1))
}

/**
 * The main process's `WebSocket` is Node's (undici), whose constructor takes
 * an init with `headers`; this program compiles against the DOM declaration,
 * which admits protocols only, so the constructor is re-typed for the one
 * call that needs the header.
 */
const NodeWebSocket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket

/** How much of a question is quoted in a notification before it is cut. */
const BODY_LIMIT = 120

/** What the notifier needs from the main process. */
export interface NotifyHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /** Bring the app window back; what clicking a notification does. */
  reveal: () => void
}

/** Sessions last seen running, so only the running → idle edge announces itself. */
const running = new Set<string>()

/** Waterfall deliveries already announced, keyed by event id (replay-safe). */
const announced = new Set<string>()

/** Unseen attention events, which is what the macOS Dock badge counts. */
let badge = 0

/**
 * One call to {@link setupNotifications}'s worth of stream and reconnect
 * loop, torn down together — by the next `setupNotifications` call
 * (retargeting after a server rebind) or by quitting. `stopped` is checked
 * before every reopen, so a retry already in flight when its generation is
 * torn down does not reconnect into the next one's socket.
 */
interface Generation {
  stopped: boolean
  socket: WebSocket | undefined
  /** The launch-token URL the cookie is minted from. */
  authenticatedUrl: string
  /** The minted `name=value` cookie pair, or undefined until the next mint. */
  cookie: string | undefined
  /** The Host's id for this event client, from the stream's `ready` frame. */
  clientId: string | undefined
  /** Waterfall deliveries whose `next` is held until a window is ready. */
  held: Set<string>
  /** Logging and reveal for this generation's messages. */
  host: NotifyHost
}

/** The generation currently subscribed, or undefined before the first {@link setupNotifications} call. */
let current: Generation | undefined

/**
 * Whether the app-level hooks below are already bound. They must exist
 * exactly once for the app's whole life: `setupNotifications` may be called
 * again to retarget after a server rebind, and re-registering `app.on` on
 * every call would fire `clearBadge` and the stream teardown once per past
 * generation instead of once.
 */
let appHooksBound = false

/**
 * Whether the user would miss something happening in the window right now.
 * @returns true when the window is absent, hidden, minimized, or simply not
 * the focused window.
 */
function unattended(): boolean {
  const window = mainWindow()
  if (window === undefined) return true
  return !window.isVisible() || window.isMinimized() || !window.isFocused()
}

/**
 * Announce one thing worth coming back for, on the platform's own terms.
 * @param host - logging, and the window a clicked notification leads back to.
 * @param title - the headline; the notification title on Windows.
 * @param body - one line of detail.
 */
function announce(host: NotifyHost, title: string, body: string): void {
  if (!unattended()) return
  host.log(`[desktop] notify: ${title} — ${body}\n`)
  if (process.platform === 'darwin') {
    badge += 1
    app.dock?.setBadge(String(badge))
    app.dock?.bounce('informational')
    return
  }
  if (!Notification.isSupported()) return
  const notification = new Notification({ title, body })
  notification.on('click', () => { host.reveal() })
  notification.show()
}

/** Drop the Dock badge; the user is looking at the window. */
function clearBadge(): void {
  badge = 0
  app.dock?.setBadge('')
}

/**
 * What a message calls the session it is about: its projected title in
 * corner brackets, or the plain word for a session when it has none yet or
 * the lookup fails. Looked up per message rather than cached — a title is
 * assigned after the first turn and can change later.
 * @param generation - the generation whose cookie authenticates the lookup.
 * @param sessionId - the session the message is about.
 * @returns the subject phrase.
 */
async function subject(generation: Generation, sessionId: string): Promise<string> {
  let title: string | undefined
  try {
    const value = await rpc(generation, LIST_ENDPOINT, {})
    const items = value?.['items']
    const list = Array.isArray(items) ? items as unknown[] : []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const summary = item as Record<string, unknown>
      if (summary['sessionId'] !== sessionId) continue
      const values = nested(nested(summary, 'projections') ?? {}, 'values')
      title = values === undefined ? undefined : text(values, 'title')
    }
  } catch {
    // The message is still worth sending without the name: the lookup is
    // decoration, and nothing else can fail here — `rpc` wraps every carrier
    // and endpoint failure into the one rejection this swallows.
  }
  return title === undefined ? '会话' : `「${title}」`
}

/** One line of text cut to [[BODY_LIMIT]], with an ellipsis when it was cut. */
function clip(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length <= BODY_LIMIT ? line : `${line.slice(0, BODY_LIMIT)}…`
}

/**
 * Read one string field off a wire frame.
 * @param frame - the decoded frame.
 * @param key - the field to read.
 * @returns the value, or undefined when the field is absent or not a string.
 */
function text(frame: Record<string, unknown>, key: string): string | undefined {
  const value = frame[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Read one nested object off a wire frame.
 * @param frame - the decoded frame.
 * @param key - the field to read.
 * @returns the object, or undefined when the field is absent or not one.
 */
function nested(frame: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = frame[key]
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

/**
 * The body of a "waiting for your answer" message for one question request.
 * @param who - the subject phrase for the session.
 * @param request - the projected `user-questions/request` record.
 * @returns one line naming the session and quoting what it asks.
 */
function questionBody(who: string, request: Record<string, unknown>): string {
  const questions = request['questions']
  const first = Array.isArray(questions) ? questions[0] as unknown : undefined
  if (typeof first !== 'object' || first === null) return `${who}有一个问题等你回答。`
  const item = first as Record<string, unknown>
  if (nested(item, 'intent')?.['kind'] === 'plan-review') return `${who}有一份计划等待你的审阅。`
  const question = text(item, 'question')
  if (question === undefined) return `${who}有一个问题等你回答。`
  return `${who}想问:${clip(question)}`
}

/**
 * Exchange the process launch token for the authority-bound browser cookie,
 * exactly as the browser's first page load does: one GET of the token URL,
 * answered with 303 and `Set-Cookie`. Pure over `fetch`, so it is unit-tested
 * against a local HTTP server without Electron.
 * @param authenticatedUrl - the root URL carrying `?token=`.
 * @returns the cookie's `name=value` pair, without its attributes.
 * @throws when the response is not the 303 + `Set-Cookie` exchange.
 */
export async function exchangeLaunchToken(authenticatedUrl: string): Promise<string> {
  const exchange = await fetch(authenticatedUrl, { redirect: 'manual' })
  const setCookie = exchange.headers.get('set-cookie')
  const pair = setCookie?.split(';', 1)[0]
  if (exchange.status !== 303 || pair === undefined || pair === '') {
    throw new Error(`launch token exchange answered ${String(exchange.status)} without a session cookie`)
  }
  return pair
}

/**
 * The browser-session cookie for this generation, minting it from the launch
 * token on first use. A mint that fails leaves the generation without a
 * cookie, so the next call tries again.
 * @param generation - the generation the cookie belongs to.
 * @returns the `name=value` pair to send as the `cookie` header.
 */
async function mintCookie(generation: Generation): Promise<string> {
  if (generation.cookie !== undefined) return generation.cookie
  const cookie = await exchangeLaunchToken(generation.authenticatedUrl)
  generation.cookie = cookie
  return cookie
}

/**
 * Call one unary Remote endpoint over the HTTP carrier, authenticated with
 * the generation's cookie.
 * @param generation - the generation whose cookie and origin are used.
 * @param endpoint - the Remote endpoint, e.g. `session/list`.
 * @param args - the endpoint's request record.
 * @returns the endpoint's value, or undefined for a void endpoint.
 * @throws when the carrier or the endpoint reports a failure.
 */
async function rpc(generation: Generation, endpoint: string, args: unknown): Promise<Record<string, unknown> | undefined> {
  const cookie = await mintCookie(generation)
  const origin = new URL(generation.authenticatedUrl).origin
  const response = await fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  if (!response.ok) throw new Error(`${endpoint} answered HTTP ${String(response.status)}`)
  const body = await response.json() as unknown
  const result = typeof body === 'object' && body !== null ? nested(body as Record<string, unknown>, 'result') : undefined
  if (result === undefined) throw new Error(`${endpoint} answered without a result`)
  if (result['ok'] !== true) {
    const error = nested(result, 'error')
    throw new Error(`${endpoint} failed: ${error === undefined ? 'unknown' : `${text(error, 'code') ?? '?'}: ${text(error, 'message') ?? ''}`}`)
  }
  return nested(result, 'value')
}

/**
 * Answer one waterfall delivery with `next`: the shell decides nothing, it
 * only stops being the client the Host is waiting on.
 * @param generation - the generation the delivery belongs to.
 * @param host - logging for the main process.
 * @param eventId - the delivery to answer.
 */
function answerNext(generation: Generation, host: NotifyHost, eventId: string): void {
  generation.held.delete(eventId)
  if (generation.clientId === undefined) return
  const clientId = generation.clientId
  void rpc(generation, RESULT_ENDPOINT, { clientId, eventId, outcome: { kind: 'next' } }).catch((error: unknown) => {
    // A delivery that was already settled (answered elsewhere, or cancelled)
    // is refused as unknown; nothing is owed for it any more.
    const message = error instanceof Error ? error.message : String(error)
    host.log(`[desktop] event answer ${eventId} not accepted: ${message}\n`)
  })
}

/**
 * Answer a waterfall delivery now when a window is there to decide it, else
 * hold the answer for {@link releaseHeld}.
 * @param generation - the generation the delivery belongs to.
 * @param host - logging for the main process.
 * @param eventId - the delivery.
 */
function answerOrHold(generation: Generation, host: NotifyHost, eventId: string): void {
  if (mainWindow() === undefined) {
    generation.held.add(eventId)
    return
  }
  answerNext(generation, host, eventId)
}

/**
 * Release every held answer of the current generation. Called a grace period
 * after a window finished loading, when that window's own client has had time
 * to register and receive the same pending deliveries.
 */
function releaseHeld(): void {
  const generation = current
  if (generation === undefined || generation.stopped) return
  for (const eventId of [...generation.held]) answerNext(generation, generation.host, eventId)
}

/**
 * Handle one item of the `$events` stream.
 * @param generation - the generation the stream belongs to.
 * @param host - logging and the window the notifications lead back to.
 * @param frame - the decoded downlink frame.
 */
function onEventFrame(generation: Generation, host: NotifyHost, frame: Record<string, unknown>): void {
  switch (frame['type']) {
    case 'ready': {
      generation.clientId = text(frame, 'clientId')
      // The one success line the field log carries for this stream: its
      // absence after the server's URL line is the diagnostic.
      host.log(`[desktop] attention stream ready (client ${generation.clientId ?? '?'})\n`)
      return
    }
    case 'emit': {
      const args = frame['args']
      if (frame['event'] !== 'api-session/status' || !Array.isArray(args)) return
      const [sessionId, isRunning] = args as unknown[]
      if (typeof sessionId !== 'string') return
      if (isRunning === true) {
        running.add(sessionId)
        return
      }
      if (!running.delete(sessionId)) return
      void subject(generation, sessionId).then((who) => {
        announce(host, '任务已完成', `${who}已经跑完,可以回来看结果了。`)
      })
      return
    }
    case 'waterfall': {
      const eventId = text(frame, 'eventId')
      const sessionId = text(frame, 'agentId')
      const request = nested(frame, 'request') ?? {}
      if (eventId === undefined || sessionId === undefined) return
      answerOrHold(generation, host, eventId)
      // Reopening the stream replays every delivery still pending, so an id
      // that was already announced is the same request arriving twice.
      if (announced.has(eventId)) return
      announced.add(eventId)
      if (frame['event'] === 'approval/request') {
        const tool = text(request, 'toolName') ?? '工具'
        void subject(generation, sessionId).then((who) => {
          announce(host, '需要你的确认', `${who}请求执行 ${tool},正在等你批准。`)
        })
      } else if (frame['event'] === 'user-questions/request') {
        void subject(generation, sessionId).then((who) => {
          announce(host, '等待你的回答', questionBody(who, request))
        })
      }
      return
    }
    case 'cancel': {
      const eventId = text(frame, 'eventId')
      if (eventId === undefined) return
      announced.delete(eventId)
      generation.held.delete(eventId)
      return
    }
    default:
      // The frame union grows upstream; a frame this shell has no message
      // for is not an error.
  }
}

/**
 * Keep the event stream open, reopening it after it closes with backoff.
 * @param generation - the subscription generation this stream belongs to.
 * @param host - logging for the main process.
 * @param attempt - which consecutive closed-without-opening attempt this
 * connection is, starting at 1 for the very first (never a reconnect).
 */
function subscribe(generation: Generation, host: NotifyHost, attempt = 1): void {
  if (generation.stopped) return
  const url = `${new URL(generation.authenticatedUrl).origin.replace(/^http/, 'ws')}${MUX_PATH}`
  void mintCookie(generation).then((cookie) => {
    if (generation.stopped) return
    open(generation, url, host, attempt, cookie)
  }, (error: unknown) => {
    if (generation.stopped) return
    // The server answered, but not with a cookie (or not at all): retry on the
    // same schedule a refused upgrade would, so a server mid-restart is polled
    // no harder than a dead stream.
    const message = error instanceof Error ? error.message : String(error)
    const nextAttempt = attempt + 1
    const delayMs = reconnectDelayMs(nextAttempt)
    if (nextAttempt === 2 || nextAttempt % RECONNECT_LOG_EVERY === 0) {
      host.log(`[desktop] ${url} cookie exchange failed (${message}); retrying in ${String(delayMs / 1000)}s (attempt ${String(nextAttempt)})\n`)
    }
    setTimeout(() => { subscribe(generation, host, nextAttempt) }, delayMs).unref()
  })
}

/**
 * Open the stream socket with the minted cookie, request the `$events`
 * stream on it, and arm its reconnect.
 * @param generation - the subscription generation this stream belongs to.
 * @param url - the `ws://` address of the multiplexed stream.
 * @param host - logging for the main process.
 * @param attempt - see {@link subscribe}.
 * @param cookie - the `name=value` pair the upgrade authenticates with.
 */
function open(generation: Generation, url: string, host: NotifyHost, attempt: number, cookie: string): void {
  const socket = new NodeWebSocket(url, { headers: { cookie } })
  generation.socket = socket
  generation.clientId = undefined
  const streamId = randomUUID()
  let opened = false
  socket.addEventListener('open', () => {
    opened = true
    socket.send(JSON.stringify({ type: 'open', streamId, endpoint: EVENTS_ENDPOINT, payload: { args: {} } }))
  })
  socket.addEventListener('message', (event: MessageEvent) => {
    // Wire boundary: the server sends one JSON text frame per stream message.
    if (typeof event.data !== 'string') return
    let envelope: unknown
    try {
      envelope = JSON.parse(event.data)
    } catch {
      // A frame that is not JSON cannot be acted on and cannot be repaired;
      // the stream stays open because the next frame is independent of it.
      return
    }
    if (typeof envelope !== 'object' || envelope === null) return
    const message = envelope as Record<string, unknown>
    if (message['streamId'] !== streamId) return
    if (message['type'] === 'item') {
      const value = nested(message, 'value')
      if (value !== undefined) onEventFrame(generation, host, value)
      return
    }
    // `end` or `error`: the logical stream is over although the socket is
    // not; closing the socket hands the retry to the close handler.
    const kind = message['type']
    if (kind === 'end' || kind === 'error') {
      const failure = nested(message, 'error')
      host.log(`[desktop] ${url} ${EVENTS_ENDPOINT} stream ${kind}${failure === undefined ? '' : `: ${text(failure, 'message') ?? ''}`}\n`)
      socket.close()
    }
  })
  socket.addEventListener('close', () => {
    if (generation.socket === socket) generation.socket = undefined
    generation.clientId = undefined
    generation.held.clear()
    if (generation.stopped) return
    // A connection that did open and later closed is not a failure to
    // connect — the retry after it starts the backoff over, at attempt 1.
    const nextAttempt = opened ? 1 : attempt + 1
    // A refused upgrade is what an expired or stale cookie looks like from
    // here; the retry mints a fresh one rather than presenting the same again.
    if (!opened) generation.cookie = undefined
    const delayMs = reconnectDelayMs(nextAttempt)
    if (nextAttempt === 1 || nextAttempt % RECONNECT_LOG_EVERY === 0) {
      host.log(`[desktop] ${url} closed; reopening in ${String(delayMs / 1000)}s (attempt ${String(nextAttempt)})\n`)
    }
    // Unreferenced: a pending retry must never be the reason the app is still
    // alive after its last window closed.
    setTimeout(() => { subscribe(generation, host, nextAttempt) }, delayMs).unref()
  })
  socket.addEventListener('error', () => {
    // Every error is followed by a close event, which owns the retry. Logging
    // here as well would double every failed reconnect in the log.
  })
}

/**
 * Start watching the running server for the two moments worth interrupting
 * for. Safe to call again after a server rebind: the previous call's stream
 * is closed and its reconnect loop stopped before the new one opens, and the
 * app-level hooks (badge clearing, held-answer release, quit teardown) are
 * bound only once ever.
 * @param host - logging and the window the notifications lead back to.
 * @param authenticatedUrl - the launch-token URL `startServer` (or a rebind)
 * reported; its origin is where the stream lives and its token mints the cookie.
 */
export function setupNotifications(host: NotifyHost, authenticatedUrl: string): void {
  stopCurrentGeneration()
  const generation: Generation = {
    stopped: false, socket: undefined, authenticatedUrl, cookie: undefined, clientId: undefined, held: new Set(), host,
  }
  current = generation
  subscribe(generation, host)
  if (!appHooksBound) {
    appHooksBound = true
    app.on('browser-window-focus', () => { clearBadge() })
    app.on('browser-window-created', (_event, window: BrowserWindow) => {
      window.webContents.once('did-finish-load', () => {
        setTimeout(() => { releaseHeld() }, WINDOW_READY_GRACE_MS).unref()
      })
    })
    app.once('before-quit', () => { stopCurrentGeneration() })
  }
}

/**
 * Close the active generation's socket and stop its reconnect loop.
 * Idempotent, and a no-op before the first `setupNotifications` call.
 */
function stopCurrentGeneration(): void {
  if (current === undefined || current.stopped) return
  current.stopped = true
  current.socket?.close()
  current.socket = undefined
  current.held.clear()
}
