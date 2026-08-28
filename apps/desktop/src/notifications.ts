/**
 * Telling the user that a session wants them back, when the window is not the
 * thing they are looking at.
 *
 * Two moments qualify: a session **finished running**, and a session is
 * **waiting for an answer** — a tool approval, or a question the agent asked
 * (plan review is one of those). Nothing else interrupts.
 *
 * The shell reads both from the server it already started, over the two
 * downlink WebSockets the browser UI itself consumes, opened against the
 * loopback URL `startServer` reported:
 *
 * - `/api/events.host` carries `host/session-status`, whose `running` bit going
 *   from true to false is the only true "the agent stopped" edge. The durable
 *   `turn/end` log event is not that edge — a turn can be followed straight
 *   away by another one — and the status bit stays `running` while a tool waits
 *   for an approval, which is what keeps the two cases from overlapping.
 * - `/api/events.mux` carries `approval/requested` / `question/requested` and
 *   their `resolved` counterparts, plus every session event, from which only
 *   `session/title` is kept — as the name to put in the message.
 *
 * Both are **downlink only**: a client that sends anything is closed with 1008,
 * so nothing here ever writes to a socket. Both are also all-sessions with no
 * subscribe handshake, and both **replay what is still pending** whenever they
 * are reopened, which is why every request is remembered by id and a repeat is
 * dropped rather than announced twice.
 *
 * A Node client sends no `Origin` header, and the server's trust fence accepts
 * an absent one on a loopback `Host` — so no header is set here, and none may
 * be: an `Origin` that is not exactly the served authority is refused with 403.
 *
 * **The two platforms are told differently, and on purpose.** Windows gets a
 * system toast that raises the window when clicked. macOS gets a Dock badge and
 * one bounce, and no notification centre entry at all.
 * @module @deepseek-ai/dsh-desktop/notifications
 */

import { app, Notification } from 'electron'
import { mainWindow } from './main-window.ts'

/** Path of the all-sessions event stream (`MUX_EVENTS_PATH` on the server). */
const MUX_PATH = '/api/events.mux'

/** Path of the host-level stream (`HOST_EVENTS_PATH` on the server). */
const HOST_PATH = '/api/events.host'

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
 * The reconnect delay before the `attempt`th consecutive attempt (1 for the
 * first attempt after a close), exponential up to {@link RECONNECT_MAX_MS}.
 * Pure so the backoff schedule is unit-testable without a real socket.
 * @param attempt - which consecutive closed-without-opening attempt this is, starting at 1.
 * @returns the delay in ms.
 */
export function reconnectDelayMs(attempt: number): number {
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * RECONNECT_BACKOFF_FACTOR ** (attempt - 1))
}

/** How much of a question is quoted in a notification before it is cut. */
const BODY_LIMIT = 120

/** What the notifier needs from the main process. */
export interface NotifyHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /** Bring the app window back; what clicking a notification does. */
  reveal: () => void
}

/** Latest known title per session, from the `session/title` log events. */
const titles = new Map<string, string>()

/** Sessions last seen running, so only the running → idle edge announces itself. */
const running = new Set<string>()

/** Approval requests already announced, keyed by approval id (replay-safe). */
const announcedApprovals = new Set<string>()

/**
 * Sessions whose pending question was already announced. Keyed by session
 * rather than by question, because `question/resolved` names the answered
 * request by its rpc id and not by the question ids that were asked.
 */
const announcedQuestions = new Set<string>()

/** Unseen attention events, which is what the macOS Dock badge counts. */
let badge = 0

/**
 * One call to {@link setupNotifications}'s worth of open streams and their
 * reconnect loops, torn down together — by the next `setupNotifications` call
 * (retargeting after a server rebind) or by quitting. `stopped` is checked
 * before every reopen, so a retry already in flight when its generation is
 * torn down does not reconnect into the next one's sockets.
 */
interface Generation {
  stopped: boolean
  sockets: Set<WebSocket>
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
    // No notification centre entry: an agent that finishes a dozen turns would
    // leave a dozen banners to dismiss. The Dock says how many and where.
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
 * What a message calls the session it is about.
 * @param sessionId - the session the message is about.
 * @returns its title in corner brackets, or the plain word for a session.
 * Titles arrive as `session/title` events on the mux stream, so a session named
 * before this shell connected — one resumed from disk — has none, and the
 * message says 「会话」 rather than waiting on a lookup to say more.
 */
function subject(sessionId: string): string {
  const title = titles.get(sessionId)
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

/** Handle one frame of the host stream: the running → idle edge. */
function onHostFrame(host: NotifyHost, frame: Record<string, unknown>): void {
  if (frame['type'] !== 'host/session-status') return
  const sessionId = text(frame, 'sessionId')
  if (sessionId === undefined) return
  if (frame['running'] === true) {
    running.add(sessionId)
    return
  }
  // A session that this shell never saw running is one that was already idle
  // when the stream opened: reporting it finished would announce history.
  if (!running.delete(sessionId)) return
  announce(host, '任务已完成', `${subject(sessionId)}已经跑完,可以回来看结果了。`)
}

/** Handle one frame of the mux stream: titles, approvals, and questions. */
function onMuxFrame(host: NotifyHost, frame: Record<string, unknown>): void {
  const sessionId = text(frame, 'sessionId')
  switch (frame['type']) {
    case 'session/event': {
      const event = nested(frame, 'event')
      if (sessionId === undefined || event?.['type'] !== 'session/title') return
      const title = text(nested(event, 'data') ?? {}, 'title')
      if (title !== undefined) titles.set(sessionId, title)
      return
    }
    case 'approval/requested': {
      const approvalId = text(frame, 'approvalId')
      if (sessionId === undefined || approvalId === undefined) return
      // Reopening the stream replays every approval still waiting, so an id
      // that was already announced is the same request arriving twice.
      if (announcedApprovals.has(approvalId)) return
      announcedApprovals.add(approvalId)
      const tool = text(frame, 'toolName') ?? '工具'
      announce(host, '需要你的确认', `${subject(sessionId)}请求执行 ${tool},正在等你批准。`)
      return
    }
    case 'approval/resolved': {
      const approvalId = text(frame, 'approvalId')
      if (approvalId !== undefined) announcedApprovals.delete(approvalId)
      return
    }
    case 'question/requested': {
      if (sessionId === undefined || announcedQuestions.has(sessionId)) return
      announcedQuestions.add(sessionId)
      announce(host, '等待你的回答', questionBody(sessionId, frame))
      return
    }
    case 'question/resolved': {
      if (sessionId !== undefined) announcedQuestions.delete(sessionId)
      return
    }
    default:
      // The frame union grows upstream (queue snapshots, projections, job
      // baselines); a frame this shell has no message for is not an error.
      return
  }
}

/**
 * The line describing what is being asked.
 * @param sessionId - the asking session.
 * @param frame - the `question/requested` frame.
 * @returns a plan review named as such, otherwise the first question's own
 * text — which the model wrote in whatever language the session is conducted
 * in, and is therefore more use than any fixed sentence.
 */
function questionBody(sessionId: string, frame: Record<string, unknown>): string {
  const questions = frame['questions']
  const first = Array.isArray(questions) ? questions[0] as unknown : undefined
  const item = typeof first === 'object' && first !== null ? first as Record<string, unknown> : undefined
  if (item === undefined) return `${subject(sessionId)}有一个问题等你回答。`
  if (nested(item, 'intent')?.['kind'] === 'plan-review') return `${subject(sessionId)}有一份计划等待你的审阅。`
  const question = text(item, 'question')
  if (question === undefined) return `${subject(sessionId)}有一个问题等你回答。`
  return `${subject(sessionId)}想问:${clip(question)}`
}

/**
 * Keep one downlink stream open, reopening it after it closes with backoff.
 * @param generation - the subscription generation this stream belongs to.
 * @param url - the `ws://` address of the stream.
 * @param host - logging for the main process.
 * @param onFrame - receives each decoded frame payload.
 * @param attempt - which consecutive closed-without-opening attempt this
 * connection is, starting at 1 for the very first (never a reconnect).
 */
function subscribe(
  generation: Generation, url: string, host: NotifyHost, onFrame: (frame: Record<string, unknown>) => void, attempt = 1,
): void {
  if (generation.stopped) return
  const socket = new WebSocket(url)
  generation.sockets.add(socket)
  let opened = false
  socket.addEventListener('open', () => { opened = true })
  socket.addEventListener('message', (event: MessageEvent) => {
    // Wire boundary: the server sends one JSON text frame per event, wrapped in
    // the same `server-request` envelope the browser client unwraps.
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
    const payload = nested(envelope as Record<string, unknown>, 'payload')
    if (payload !== undefined) onFrame(payload)
  })
  socket.addEventListener('close', () => {
    generation.sockets.delete(socket)
    if (generation.stopped) return
    // A connection that did open and later closed is not a failure to
    // connect — the retry after it starts the backoff over, at attempt 1.
    const nextAttempt = opened ? 1 : attempt + 1
    const delayMs = reconnectDelayMs(nextAttempt)
    if (nextAttempt === 1 || nextAttempt % RECONNECT_LOG_EVERY === 0) {
      host.log(`[desktop] ${url} closed; reopening in ${String(delayMs / 1000)}s (attempt ${String(nextAttempt)})\n`)
    }
    // Unreferenced: a pending retry must never be the reason the app is still
    // alive after its last window closed.
    setTimeout(() => { subscribe(generation, url, host, onFrame, nextAttempt) }, delayMs).unref()
  })
  socket.addEventListener('error', () => {
    // Every error is followed by a close event, which owns the retry. Logging
    // here as well would double every failed reconnect in the log.
  })
}

/**
 * Start watching the running server for the two moments worth interrupting
 * for. Safe to call again after a server rebind: the previous call's streams
 * are closed and its reconnect loops stopped before the new ones open, and the
 * app-level hooks (badge clearing, quit teardown) are bound only once ever.
 * @param host - logging and the window the notifications lead back to.
 * @param serverUrl - the loopback URL `startServer` (or a rebind) reported.
 */
export function setupNotifications(host: NotifyHost, serverUrl: string): void {
  stopCurrentGeneration()
  const generation: Generation = { stopped: false, sockets: new Set() }
  current = generation
  const base = serverUrl.replace(/^http/, 'ws')
  subscribe(generation, `${base}${HOST_PATH}`, host, (frame) => { onHostFrame(host, frame) })
  subscribe(generation, `${base}${MUX_PATH}`, host, (frame) => { onMuxFrame(host, frame) })
  if (!appHooksBound) {
    appHooksBound = true
    app.on('browser-window-focus', () => { clearBadge() })
    app.once('before-quit', () => { stopCurrentGeneration() })
  }
}

/**
 * Close the active generation's sockets and stop its reconnect loops.
 * Idempotent, and a no-op before the first `setupNotifications` call.
 */
function stopCurrentGeneration(): void {
  if (current === undefined || current.stopped) return
  current.stopped = true
  for (const socket of current.sockets) socket.close()
  current.sockets.clear()
}
