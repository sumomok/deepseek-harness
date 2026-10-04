/**
 * Telling the user that a session wants them back, when the window is not the
 * thing they are looking at.
 *
 * Three moments qualify: a session **finished running**, a session is
 * **waiting for an answer** — a tool approval, or a question the agent asked
 * (plan review is one of those) — and a **reminder was delivered** to a
 * session. Nothing else interrupts.
 *
 * The shell reads all three from the server it already started, as one more
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
 * - `schedule/changed` is emitted, without arguments, after every committed
 *   change to the schedule service's task table, a delivery among them. The
 *   shell then reads `schedule/catalog` and announces, once per message, each
 *   delivered message id (`lastDelivery.messageId`) its baseline does not
 *   hold; the tasks of one recurring batch share one message. The baseline is
 *   read again on every `ready` frame, so a delivery made while the shell was
 *   not listening — before launch, or between a close and the reopen — is
 *   never announced; {@link Generation.deliveries} states the rule. The run a
 *   reminder woke ends without a finished-run message;
 *   {@link announceReminder} states which run that is.
 *
 * A waterfall delivery is owed an answer: the Host holds the request until
 * every client it was delivered to has answered, and settles it as unanswered
 * (`next` — a refused approval, an unanswerable question) only when the last
 * one does. The shell answers `next` for every delivery the user did not
 * answer on its own toast — but WHEN it answers matters, because the browser
 * page that carries the request is not always registered: it is loading,
 * reloading after a rebind or an F5, recovering from a renderer crash, or —
 * on macOS, where closing the window destroys it and the app lives on in the
 * Dock — simply gone. An immediate `next` in any of those moments would
 * settle the request before the user could see it, where a shell-less server
 * would have kept it pending and replayed it to the page when it registered.
 * So the shell answers late: {@link NEXT_GRACE_MS} after the delivery while
 * an app window exists (long enough for a page to load and register, short
 * enough that a request the page declines to handle still falls through),
 * and not at all while there is no window — those answers wait for the next
 * window to be created and then take the same grace. A `cancel` frame
 * (someone answered) drops the pending answer.
 *
 * The one decision the shell does carry is the user's own: an approval toast
 * offers 「拒绝」, and pressing it answers that delivery with {@link REJECTED}.
 * A `result` from any client settles the request for all of them at once, so
 * the page's approval card goes away as the button is pressed. There is no
 * 「批准」 on the toast: it names the tool and nothing else, and an approval is
 * given in front of what is being approved.
 *
 * A toast outlives the window the shell has to answer in — Windows files a
 * shown banner into the action centre within seconds and keeps its buttons
 * live, while the grace answer goes out a minute later — so every toast is
 * closed the moment it has been acted on or the request behind it is over: a
 * button was pressed on it, this shell's own `next` went out, a `cancel` frame
 * arrived, or the generation was stopped. 「去看看」 is on that list without
 * answering anything, and so is a question's toast, which carries no buttons
 * at all. A button pressed on a delivery this shell no longer waits on shows
 * the window instead of answering, because the Host discards a late answer:
 * the approval card is either still in the window to be answered there or
 * already gone, and either way the press lands where the user can see what it
 * did. A refusal whose answer never reached the Host is re-sent when the
 * delivery is replayed, rather than given a fresh grace that would answer
 * `next` in its place; an answer that keeps failing takes the grace again and
 * ends as an abstention, because a delivery this shell stops answering for is
 * one the Host will not settle for anyone else either.
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
 * system toast that raises the window when clicked, with buttons on the ones
 * that want an answer. macOS gets a Dock badge and one bounce, and no
 * notification centre entry at all. The badge counts finished runs and
 * delivered reminders plus the requests still waiting: a request's count is
 * taken off when a `cancel` frame says someone answered it, or when its
 * generation is stopped, and the whole badge is cleared when an app window
 * takes focus.
 * @module @deepseek-ai/dsh-desktop-shell/notifications
 */

import { randomUUID } from 'node:crypto'
import { app, Notification, type NotificationAction } from 'electron'
import { mainWindow } from './main-window.ts'

/** Path of the multiplexed Remote stream WebSocket (`REMOTE_STREAM_MUX_PATH` on the server). */
const MUX_PATH = '/api/remote.mux'

/** The logical stream carrying forwarded Host events (`REMOTE_EVENT_STREAM_ENDPOINT`). */
const EVENTS_ENDPOINT = '$events'

/** The unary endpoint a waterfall delivery is answered through (`REMOTE_EVENT_RESULT_ENDPOINT`). */
const RESULT_ENDPOINT = '$events/result'

/**
 * The unary endpoint listing sessions with their projected titles. Its server
 * method takes one parameter, `_request`, so its `args` record is
 * `{ _request: {} }`.
 */
const LIST_ENDPOINT = 'session/list'

/**
 * The unary endpoint listing every schedule task with its session binding and
 * last delivery (`ScheduleService.catalog` in `dsh-schedule`). Its server
 * method takes no parameter, so its `args` record is `{}`.
 */
const CATALOG_ENDPOINT = 'schedule/catalog'

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
 * How long a waterfall delivery is held before the shell answers `next`. The
 * page registers its event client within seconds of loading (its runtime
 * allows itself 3s per attempt), and the Host replays every pending delivery
 * to a client as it registers, so a minute covers a reload or a rebind; a
 * request the page then declines to handle falls through that much later
 * than it would with no shell, on what is an error path either way.
 */
const NEXT_GRACE_MS = 60_000

/**
 * The approval vocabulary's word for a refusal (`ApprovalOutcome` in
 * `dsh-user-approval`). A word outside that vocabulary is normalized to
 * `unavailable`, which refuses the tool call too — so a shell that sent the
 * wrong one could only over-refuse, never approve.
 */
const REJECTED = 'rejected'

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

/** The constructor overload Node's (undici) `WebSocket` adds: an init carrying `headers`. */
type NodeWebSocketConstructor = typeof WebSocket & (new (url: string, init: { headers: Record<string, string> }) => WebSocket)

/**
 * Whether `ctor` is Node's (undici) `WebSocket`, which is the global in any
 * process with a Node runtime, such as this main process.
 * @param ctor - the global `WebSocket` constructor.
 * @returns true when a Node runtime is present.
 */
function isNodeWebSocket(ctor: typeof WebSocket): ctor is NodeWebSocketConstructor {
  return typeof process.versions.node === 'string' && typeof ctor === 'function'
}

/** How much of a question, or of a reminder's names or instruction, is quoted in a notification before it is cut. */
const BODY_LIMIT = 120

/**
 * How far from a reminder's `deliveredAt`, on either side, the shell can have
 * received the running frame of the run it woke. The schedule service sets the
 * session running, waits for the session log to persist the reminder, and only
 * then samples `deliveredAt`; this covers that persist before the delivery, and
 * the running frame's way to the shell after it. A woken run outside this
 * window is left unmarked, so its finished-run message is raised as well; a run
 * the user starts within it is taken for the woken one and loses its
 * finished-run message.
 */
const WAKE_FLUSH_MS = 5_000

/** What the notifier needs from the main process. */
export interface NotifyHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /** Bring the app window back; what clicking a notification does. */
  reveal: () => void
}

/** One button on a toast: what it says, and what pressing it does. */
export interface ToastAction {
  /** The button's label. */
  readonly text: string
  /** What pressing the button does. */
  readonly press: () => void
}

/**
 * The `actions` a toast carrying these buttons is constructed with. Windows
 * draws them. Electron also declares `actions` for macOS, which never reaches
 * a `Notification` here — {@link announce} answers a macOS attention event
 * with a Dock badge — and Linux's implementation ignores them, so off Windows
 * they are dropped rather than promised. Pure, so the platform rule is
 * unit-tested without Electron.
 * @param actions - the buttons the caller wants, in the order they are drawn.
 * @param platform - `process.platform` of the running main process.
 * @returns the action list to construct the notification with, empty off Windows.
 */
export function toastButtons(actions: readonly ToastAction[], platform: string): NotificationAction[] {
  if (platform !== 'win32') return []
  return actions.map(action => ({ type: 'button', text: action.text }))
}

/**
 * The buttons an approval toast carries, in the order they are drawn: the one
 * answer that is safe to give without reading the request, and a way to go and
 * read it.
 * @param reject - answers the delivery with {@link REJECTED}.
 * @param reveal - brings the window back, as clicking the toast itself does.
 * @returns the two buttons.
 */
export function approvalActions(reject: () => void, reveal: () => void): ToastAction[] {
  return [{ text: '拒绝', press: reject }, { text: '去看看', press: reveal }]
}

/**
 * Finished runs and delivered reminders announced since an app window last
 * had focus. The macOS Dock badge shows this plus {@link Generation.badged}'s
 * size.
 */
let notices = 0

/**
 * What {@link announce} raised: a toast to hold until the request behind it is
 * over, or one more count on the macOS Dock badge for the caller to own.
 */
type Announcement = { readonly kind: 'toast'; readonly toast: Notification } | { readonly kind: 'badge' }

/**
 * One run of a session, from the running frame that started it. Every
 * running frame makes a new object, and the object is the run's identity.
 */
interface Run {
  /** The shell's clock reading when the run's running frame arrived. */
  readonly startedAt: number
}

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
  /**
   * Waterfall deliveries not yet answered, each with its grace timer, or
   * `undefined` while there is no window to wait for. Cleared when the socket
   * closes: the Host drops this client's deliveries with it and replays what
   * is still pending on the next registration.
   */
  pending: Map<string, NodeJS.Timeout | undefined>
  /**
   * Deliveries already announced, keyed by event id. Replay after a reopen
   * repeats every delivery still pending, and an id seen before is the same
   * request. Ids of requests settled while the shell was disconnected stay
   * until the generation ends — a rebind starts a server with fresh ids.
   */
  announced: Set<string>
  /**
   * The toast raised for each announced delivery, until it is closed. Held so
   * that a delivery this shell stops waiting on takes its toast with it: a
   * shown toast survives in the action centre with its buttons live, long past
   * the minute the shell is entitled to answer in.
   */
  toasts: Map<string, Notification>
  /**
   * Deliveries counted on the macOS Dock badge. An id leaves when a `cancel`
   * frame arrives for it, when an app window takes focus, or when this
   * generation is stopped. The shell's own grace answer does not remove it:
   * the page still holds the request after the shell abstains, and the Host
   * sends no `cancel` to a client that already answered, so the count stays
   * until the window takes focus.
   */
  badged: Set<string>
  /**
   * Deliveries the user refused on a toast, kept for as long as a replay can
   * ask again. The refusal's POST can fail, or the socket can close before the
   * Host records it; the Host then replays a delivery this shell has already
   * decided. Giving that replay the ordinary grace would answer `next` a
   * minute later and drop the refusal in silence, because the id is in
   * {@link Generation.announced} and no second toast would ask again.
   */
  rejected: Set<string>
  /**
   * The run each session is in, as last seen, so only the running → idle edge
   * announces itself and a reminder can tell the run it woke from one already
   * going.
   */
  running: Map<string, Run>
  /**
   * The shell's clock reading when the current stream's `ready` frame
   * arrived; infinite before the first one. The server registers this client
   * for forwarding before it sends `ready`, so a delivery whose `deliveredAt`
   * is not earlier than this was committed, and its `schedule/changed` sent,
   * while the shell was listening.
   */
  listeningSince: number
  /**
   * The delivered message ids a `schedule/catalog` read is compared with; a
   * message id outside the set is a new delivery. Read on every `ready`
   * frame, leaving out the deliveries made at or after
   * {@link Generation.listeningSince}, whose own `schedule/changed` announces
   * them. Undefined while that read has failed; the next read that succeeds
   * then derives it the same way before comparing. Every later read that
   * succeeds replaces it, and one that fails leaves it as it was, so the next
   * read that succeeds announces what the failed one would have, as late as
   * the next `schedule/changed`. A task's catalog entry holds only its last
   * delivery, so a delivery its own next delivery replaced before a read
   * succeeded is never announced.
   */
  deliveries: Set<string> | undefined
  /**
   * Runs a reminder woke and announced, whose finished-run message is
   * dropped. A mark matches that one run and no later run of its session,
   * across a reconnect too.
   */
  reminderRuns: WeakSet<Run>
  /**
   * For each run that was going when a `schedule/changed` frame arrived, the
   * reminder queue's tail as it stood once the latest such frame's comparison
   * was queued. That comparison may mark the run, so the run's finished-run
   * message waits for it; a run absent here is decided at once.
   */
  comparing: WeakMap<Run, Promise<void>>
  /**
   * Every catalog read and comparison of this generation, in frame order. It
   * never rejects.
   */
  reminders: Promise<void>
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
 * @param actions - buttons to offer, in the order they are drawn; empty for a
 * message that asks for nothing. Each `press` is responsible for closing the
 * toast it was pressed on, which is what {@link closeToast} does for the
 * approval buttons.
 * @returns the toast that was raised, `badge` when macOS bounced the Dock and
 * the caller is to add one count to the badge, or undefined when nothing was
 * raised: the window is attended, or the platform posts no notifications.
 */
function announce(host: NotifyHost, title: string, body: string, actions: readonly ToastAction[] = []): Announcement | undefined {
  if (!unattended()) return undefined
  host.log(`[desktop] notify: ${title} — ${body}\n`)
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
    return { kind: 'badge' }
  }
  if (!Notification.isSupported()) return undefined
  const notification = new Notification({ title, body, actions: toastButtons(actions, process.platform) })
  notification.on('click', () => { host.reveal() })
  notification.on('action', ({ actionIndex }) => { actions[actionIndex]?.press() })
  notification.show()
  return { kind: 'toast', toast: notification }
}

/**
 * Dismiss the toast raised for one delivery, if it is still up. Windows
 * removes a visible toast from the screen and the action centre, and tries to
 * remove one that already left the screen; a toast this generation has already
 * closed is not closed twice.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the delivery whose toast is done.
 */
function closeToast(generation: Generation, eventId: string): void {
  const toast = generation.toasts.get(eventId)
  if (toast === undefined) return
  generation.toasts.delete(eventId)
  toast.close()
}

/** Show the current count on the Dock badge, or no badge at zero. */
function renderBadge(): void {
  const count = notices + (current?.badged.size ?? 0)
  app.dock?.setBadge(count > 0 ? String(count) : '')
}

/**
 * Take one delivery's count off the Dock badge, if it carries one.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the delivery that is over.
 */
function unbadge(generation: Generation, eventId: string): void {
  if (generation.badged.delete(eventId)) renderBadge()
}

/** Drop the Dock badge; the user is looking at the window. */
function clearBadge(): void {
  notices = 0
  current?.badged.clear()
  renderBadge()
}

/**
 * What a message calls the session it is about: its projected title in
 * corner brackets, or the plain word for a session when it has none yet or
 * the lookup fails. Looked up per message rather than cached — a title is
 * assigned after the first turn and can change later. A failed lookup writes
 * one log line with its reason.
 * @param generation - the generation whose cookie authenticates the lookup and whose host logs a failure.
 * @param sessionId - the session the message is about.
 * @returns the subject phrase.
 */
async function subject(generation: Generation, sessionId: string): Promise<string> {
  let title: string | undefined
  try {
    const items = record(await rpc(generation, LIST_ENDPOINT, { _request: {} }))?.['items']
    const list = Array.isArray(items) ? items as unknown[] : []
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue
      const summary = item as Record<string, unknown>
      if (summary['sessionId'] !== sessionId) continue
      const values = nested(nested(summary, 'projections') ?? {}, 'values')
      title = values === undefined ? undefined : text(values, 'title')
    }
  } catch (error) {
    // The message is still worth sending without the name. `rpc` rejects for
    // a failed cookie mint, a carrier failure, and a refusal by the endpoint
    // or the gateway in front of it; the logged reason is what tells a lookup
    // that failed from a session that has no title yet.
    const message = error instanceof Error ? error.message : String(error)
    generation.host.log(`[desktop] session ${sessionId} could not be named: ${message}\n`)
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
  return record(frame[key])
}

/**
 * Read a decoded wire value as an object.
 * @param value - the decoded value.
 * @returns the value, or undefined when it is not an object.
 */
function record(value: unknown): Record<string, unknown> | undefined {
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
  const first: unknown = Array.isArray(questions) ? questions[0] : undefined
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
 * @param args - the endpoint's `args` record; for a service method, one field
 * per parameter under its wire name. The gateway refuses an extra field, and
 * a missing one unless that parameter accepts undefined; `session/list`'s
 * `_request` is a required parameter.
 * @returns the endpoint's decoded value, or undefined for a void endpoint.
 * @throws when the carrier or the endpoint reports a failure.
 */
async function rpc(generation: Generation, endpoint: string, args: unknown): Promise<unknown> {
  const origin = new URL(generation.authenticatedUrl).origin
  const post = async (): Promise<Response> => fetch(`${origin}/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: await mintCookie(generation) },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  let response = await post()
  if (response.status === 401) {
    // The cookie has a lifetime and the stream socket outlives it; a refused
    // call is the one place an expiry shows, so mint again and retry once.
    generation.cookie = undefined
    response = await post()
  }
  if (!response.ok) throw new Error(`${endpoint} answered HTTP ${String(response.status)}`)
  const body: unknown = await response.json()
  const result = typeof body === 'object' && body !== null ? nested(body as Record<string, unknown>, 'result') : undefined
  if (result === undefined) throw new Error(`${endpoint} answered without a result`)
  if (result['ok'] !== true) {
    const error = nested(result, 'error')
    throw new Error(`${endpoint} failed: ${error === undefined ? 'unknown' : `${text(error, 'code') ?? '?'}: ${text(error, 'message') ?? ''}`}`)
  }
  return result['value']
}

/** How one waterfall delivery is answered on {@link RESULT_ENDPOINT}. */
type DeliveryOutcome = { readonly kind: 'next' } | { readonly kind: 'result'; readonly value: string }

/**
 * Answer one waterfall delivery and stop being a client the Host is waiting
 * on.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the delivery to answer.
 * @param outcome - `next` to abstain, or a `result` that settles the request
 * for every client at once.
 */
function answer(generation: Generation, eventId: string, outcome: DeliveryOutcome): void {
  const timer = generation.pending.get(eventId)
  if (timer !== undefined) clearTimeout(timer)
  generation.pending.delete(eventId)
  closeToast(generation, eventId)
  // Unreachable while the invariant below holds, and a guard rather than an
  // assertion because an answer sent without a registration is refused.
  if (generation.stopped || generation.clientId === undefined) return
  const clientId = generation.clientId
  void rpc(generation, RESULT_ENDPOINT, { clientId, eventId, outcome }).then(() => {
    // The Host takes the answering client out of the delivery before it
    // settles, so this shell never receives the `cancel` for an answer it gave
    // itself. A refusal that landed has to forget itself here, or its id would
    // outlive the request and re-answer an unrelated replay.
    if (outcome.kind === 'result') generation.rejected.delete(eventId)
  }, (error: unknown) => {
    // A delivery that was already settled (answered elsewhere, or cancelled)
    // is a no-op on the Host; what fails here is the carrier or the client
    // registration. The Host still counts this shell among the delivery's
    // clients and will not settle anyone else's `next` while it does, so the
    // answer takes the grace again rather than leaving the request held open
    // by a client that has stopped talking. A refusal that fails twice ends as
    // the abstention it was competing with, which is the losing half of the
    // one trade here: a request that hangs helps nobody.
    const message = error instanceof Error ? error.message : String(error)
    generation.host.log(`[desktop] event answer ${eventId} not accepted: ${message}\n`)
    // Re-arming without a registration would invent a delivery: the Host
    // dropped this client's deliveries with its socket and replays them, with
    // a fresh grace, to whatever registers next.
    if (!generation.stopped && generation.clientId !== undefined) scheduleNext(generation, eventId)
  })
}

/**
 * Answer one approval delivery with the user's refusal, from its toast. A
 * delivery this shell no longer waits on — the page answered it, another
 * client did, its own grace answer went out, or the stream is between
 * reconnects — cannot be answered from here, so the press brings the window
 * back instead: the approval card is either still there to be answered or
 * already gone, and both are an answer to what the button did.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the approval delivery the toast announced.
 */
function answerRejected(generation: Generation, eventId: string): void {
  closeToast(generation, eventId)
  // A delivery in `pending` is one the Host still counts this shell among the
  // clients of, and that is the whole test: everything that ends the standing
  // — the grace `next`, a `cancel` frame, a socket close, this generation
  // being stopped, an earlier press — empties `pending` for the id as it
  // happens, so registration and liveness need no separate check.
  if (!generation.pending.has(eventId)) {
    generation.host.log(`[desktop] approval ${eventId}: this shell no longer waits on it; showing the window instead\n`)
    generation.host.reveal()
    return
  }
  generation.rejected.add(eventId)
  answer(generation, eventId, { kind: 'result', value: REJECTED })
}

/**
 * Start (or restart) the grace before a delivery is answered, or leave it
 * waiting when there is no window to give the page a chance first.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the delivery.
 */
function scheduleNext(generation: Generation, eventId: string): void {
  const previous = generation.pending.get(eventId)
  if (previous !== undefined) clearTimeout(previous)
  if (mainWindow() === undefined) {
    generation.pending.set(eventId, undefined)
    return
  }
  // Unreferenced: a pending answer must never be the reason the app is still
  // alive after quitting began.
  generation.pending.set(eventId, setTimeout(() => { answer(generation, eventId, { kind: 'next' }) }, NEXT_GRACE_MS).unref())
}

/**
 * Forget one delivery without answering it: it was settled elsewhere, or
 * the socket carrying it closed.
 * @param generation - the generation the delivery belongs to.
 * @param eventId - the delivery.
 */
function dropPending(generation: Generation, eventId: string): void {
  const timer = generation.pending.get(eventId)
  if (timer !== undefined) clearTimeout(timer)
  generation.pending.delete(eventId)
}

/** Close every toast one generation raised, in whatever state it left them. */
function closeAllToasts(generation: Generation): void {
  for (const eventId of [...generation.toasts.keys()]) closeToast(generation, eventId)
}

/** Forget every pending delivery of one generation. */
function dropAllPending(generation: Generation): void {
  for (const eventId of [...generation.pending.keys()]) dropPending(generation, eventId)
}

/**
 * A window was created: every answer that waited for one now takes the
 * ordinary grace, during which the window's page loads and registers.
 */
function onWindowCreated(): void {
  const generation = current
  if (generation === undefined || generation.stopped) return
  for (const [eventId, timer] of [...generation.pending]) {
    if (timer === undefined) scheduleNext(generation, eventId)
  }
}

/**
 * Name the session a waterfall delivery came from, then raise its message and
 * hold the toast — unless this shell stopped waiting on the delivery while the
 * name was being looked up. The lookup is a round trip: a message for a
 * request that is already gone is noise, and a toast for one carries buttons
 * the request will not outlive. The delivery is un-announced as that happens,
 * because losing the standing is not the same as the request being over: a
 * socket that closed takes every delivery with it and the Host replays them,
 * and a replay that finds the id already announced would say nothing at all.
 * @param generation - the generation the delivery belongs to.
 * @param sessionId - the session to name.
 * @param eventId - the delivery the message is about.
 * @param post - raises the message, given the subject phrase for the session;
 * returns what {@link announce} raised.
 */
function announceDelivery(
  generation: Generation, sessionId: string, eventId: string, post: (who: string) => Announcement | undefined,
): void {
  void subject(generation, sessionId).then((who) => {
    if (!generation.pending.has(eventId)) {
      generation.announced.delete(eventId)
      // The one line that explains a message the user was owed and never saw.
      generation.host.log(`[desktop] delivery ${eventId} was settled while its session was being named; nothing announced\n`)
      return
    }
    const announced = post(who)
    if (announced?.kind === 'toast') generation.toasts.set(eventId, announced.toast)
    if (announced?.kind === 'badge') {
      generation.badged.add(eventId)
      renderBadge()
    }
  })
}

/** One task's last delivery, read off a `schedule/catalog` entry. */
interface ReminderDelivery {
  /** The session it was delivered to (`sessionId`). */
  readonly sessionId: string
  /** The delivered message (`lastDelivery.messageId`), which the tasks of one recurring batch share. */
  readonly messageId: string
  /** When the delivered occurrence fell due (`lastDelivery.scheduledAt`), in ms since the epoch, or undefined when unreadable. */
  readonly dueAt: number | undefined
  /** When the session log acknowledged the delivery (`lastDelivery.deliveredAt`), in ms since the epoch, or undefined when unreadable. */
  readonly deliveredAt: number | undefined
  /** The reminder's name (`title`), or else its instruction (`prompt`); undefined when both are blank. */
  readonly label: string | undefined
}

/** The deliveries of one message, in catalog order: one task's, or every task's of one recurring batch. */
type DeliveredMessage = readonly [ReminderDelivery, ...ReminderDelivery[]]

/**
 * Read one timestamp field off a wire frame.
 * @param frame - the decoded frame.
 * @param key - the field to read.
 * @returns ms since the epoch, or undefined when the field is absent or not a parseable time.
 */
function instant(frame: Record<string, unknown>, key: string): number | undefined {
  const at = Date.parse(text(frame, key) ?? '')
  return Number.isNaN(at) ? undefined : at
}

/**
 * The last delivery one `schedule/catalog` entry reports.
 * @param entry - one decoded catalog item.
 * @returns the delivery, or undefined for a task never delivered or an entry
 * without its session id or delivered message id.
 */
function deliveryOf(entry: unknown): ReminderDelivery | undefined {
  const task = record(entry)
  const last = task === undefined ? undefined : nested(task, 'lastDelivery')
  if (task === undefined || last === undefined) return undefined
  const sessionId = text(task, 'sessionId')
  const messageId = text(last, 'messageId')
  if (sessionId === undefined || messageId === undefined) return undefined
  const label = [text(task, 'title'), text(task, 'prompt')].find(value => value !== undefined && value.trim() !== '')
  return { sessionId, messageId, dueAt: instant(last, 'scheduledAt'), deliveredAt: instant(last, 'deliveredAt'), label }
}

/**
 * The body of a reminder message.
 * @param who - the subject phrase for the session.
 * @param message - the deliveries the message announces.
 * @returns one line naming the session and every reminder that has a name.
 */
function reminderBody(who: string, message: DeliveredMessage): string {
  const labels = message.flatMap(delivery => delivery.label ?? [])
  return labels.length === 0 ? `${who}有一条提醒到了。` : `${who}：${clip(labels.join('、'))}`
}

/** When, by the machine clock, the run a message woke can have started; both ends inclusive, in ms since the epoch. */
interface WakeWindow {
  /** The latest due time among the message's deliveries, or {@link WAKE_FLUSH_MS} before its latest `deliveredAt` when that is later. */
  readonly from: number
  /** {@link WAKE_FLUSH_MS} after the message's latest `deliveredAt`. */
  readonly until: number
}

/**
 * The window in which the run a message woke can have started.
 * @param message - the deliveries of one message.
 * @returns the window, or undefined when a due or delivery time is unreadable.
 */
function wakeWindow(message: DeliveredMessage): WakeWindow | undefined {
  let dueAt = Number.NEGATIVE_INFINITY
  let deliveredAt = Number.NEGATIVE_INFINITY
  for (const delivery of message) {
    if (delivery.dueAt === undefined || delivery.deliveredAt === undefined) return undefined
    dueAt = Math.max(dueAt, delivery.dueAt)
    deliveredAt = Math.max(deliveredAt, delivery.deliveredAt)
  }
  return { from: Math.max(dueAt, deliveredAt - WAKE_FLUSH_MS), until: deliveredAt + WAKE_FLUSH_MS }
}

/**
 * Read every task's last delivery off {@link CATALOG_ENDPOINT}. A failed read
 * writes one log line with its reason.
 * @param generation - the generation whose cookie authenticates the read and whose host logs a failure.
 * @returns the deliveries, or undefined when the read failed.
 */
async function readDeliveries(generation: Generation): Promise<ReminderDelivery[] | undefined> {
  let value: unknown
  try {
    value = await rpc(generation, CATALOG_ENDPOINT, {})
  } catch (error) {
    // Caught so the reminder queue keeps going; the line carries the reason.
    const message = error instanceof Error ? error.message : String(error)
    generation.host.log(`[desktop] reminder deliveries could not be read: ${message}\n`)
    return undefined
  }
  if (!Array.isArray(value)) {
    generation.host.log(`[desktop] reminder deliveries could not be read: ${CATALOG_ENDPOINT} answered without a list\n`)
    return undefined
  }
  return value.flatMap((entry: unknown) => deliveryOf(entry) ?? [])
}

/**
 * The baseline of a stream that became ready at `since`: every delivered
 * message id one read reports, except those delivered at or after `since`,
 * and those whose delivery time is unreadable.
 * @param deliveries - one read's deliveries.
 * @param since - {@link Generation.listeningSince} of that stream.
 * @returns the message ids already accounted for.
 */
function baselineSince(deliveries: readonly ReminderDelivery[], since: number): Set<string> {
  return new Set(deliveries.filter(delivery => delivery.deliveredAt === undefined || delivery.deliveredAt < since)
    .map(delivery => delivery.messageId))
}

/**
 * Group the deliveries of every message a baseline does not hold.
 * @param deliveries - one read's deliveries.
 * @param baseline - the message ids already accounted for.
 * @returns one entry per new message, in catalog order.
 */
function newMessages(deliveries: readonly ReminderDelivery[], baseline: ReadonlySet<string>): DeliveredMessage[] {
  const messages = new Map<string, [ReminderDelivery, ...ReminderDelivery[]]>()
  for (const delivery of deliveries) {
    if (baseline.has(delivery.messageId)) continue
    const message = messages.get(delivery.messageId)
    if (message === undefined) messages.set(delivery.messageId, [delivery])
    else message.push(delivery)
  }
  return [...messages.values()]
}

/**
 * Append one step to the generation's reminder queue. A step that throws is
 * logged and the queue goes on: a rejected tail would never release the
 * finished-run decisions waiting on it. The steps catch their own expected
 * failures, so this holds the queue's never-rejects invariant against the
 * unexpected ones.
 * @param generation - the generation the queue belongs to.
 * @param step - the read or comparison to run after every step queued before it.
 */
function queueReminders(generation: Generation, step: () => Promise<void>): void {
  generation.reminders = generation.reminders.then(step).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    generation.host.log(`[desktop] reminder step failed: ${message}\n`)
  })
}

/**
 * Read the baseline the next `schedule/changed` is compared with, on a
 * stream that just became ready.
 * @param generation - the generation whose stream became ready.
 * @param since - the stream's {@link Generation.listeningSince}.
 */
async function seedReminders(generation: Generation, since: number): Promise<void> {
  const deliveries = await readDeliveries(generation)
  generation.deliveries = deliveries === undefined ? undefined : baselineSince(deliveries, since)
}

/**
 * Announce every message delivered since the baseline, and keep this read as
 * the next baseline. A message whose announcement throws writes one log line
 * with its reason, and the messages after it are still announced.
 * @param generation - the generation that received `schedule/changed`.
 * @param since - {@link Generation.listeningSince} of the stream the frame arrived on.
 * @param runningAtChange - {@link Generation.running} as it stood when the
 * `schedule/changed` frame arrived.
 */
async function compareReminders(generation: Generation, since: number, runningAtChange: ReadonlyMap<string, Run>): Promise<void> {
  const deliveries = await readDeliveries(generation)
  if (deliveries === undefined || generation.stopped) return
  const baseline = generation.deliveries ?? baselineSince(deliveries, since)
  generation.deliveries = new Set(deliveries.map(delivery => delivery.messageId))
  for (const message of newMessages(deliveries, baseline)) {
    try {
      await announceReminder(generation, message, runningAtChange)
    } catch (error) {
      // The baseline already holds every message of this read, so one that
      // cannot be raised must not take the messages after it along.
      const reason = error instanceof Error ? error.message : String(error)
      generation.host.log(`[desktop] reminder ${message[0].messageId} could not be announced: ${reason}\n`)
    }
  }
}

/**
 * Raise the message for one delivered message, and mark the run it woke.
 *
 * A reminder delivered to an idle session wakes it: the schedule service's
 * `followup` sets the session running, the session log persists the
 * reminder, `deliveredAt` is sampled, and the delivery is committed and
 * `schedule/changed` emitted, so the woken run's `api-session/status` running
 * frame arrives before the `schedule/changed` frame. The reminder's message
 * already says what that run is for, so the run's finished-run message is
 * dropped. The run marked is the session's run that was going when
 * `schedule/changed` arrived and that started — by the shell's clock, when
 * its running frame arrived — within {@link wakeWindow}: no earlier than the
 * latest due time among the message's tasks, nor than {@link WAKE_FLUSH_MS}
 * before the latest `deliveredAt`, and no later than {@link WAKE_FLUSH_MS}
 * after it. The server and the shell read the same machine clock; the server
 * delivers only once every due time has passed, and sets the session running
 * a single persist before it samples `deliveredAt`, so the woken run
 * qualifies. A run the user started before the due time, or more than
 * {@link WAKE_FLUSH_MS} before the delivery, receives the reminder as its next
 * turn and keeps its finished-run message. A run the user started more than
 * {@link WAKE_FLUSH_MS} after the delivery keeps it too, which matters when a
 * failed read leaves the reminder to be announced by a later
 * `schedule/changed`. Only a reminder message that was raised marks a run,
 * and that run's own running → idle edge consumes the mark.
 *
 * Both messages are raised for a woken run that ended before
 * `schedule/changed` arrived (one that failed within the persist and the
 * commit), for a wake held behind maintenance that starts only after the
 * frame, and for a woken run whose persist, or whose running frame's way to
 * the shell, outlasted {@link WAKE_FLUSH_MS}; the reminder's message is never
 * the one dropped. A run the user started after the due time and within
 * {@link WAKE_FLUSH_MS} of the delivery is taken for the woken run, and its
 * finished-run message gives way to the reminder's.
 * @param generation - the generation that received `schedule/changed`.
 * @param message - the deliveries of a message made since the baseline.
 * @param runningAtChange - {@link Generation.running} as it stood when the
 * `schedule/changed` frame arrived.
 */
async function announceReminder(
  generation: Generation, message: DeliveredMessage, runningAtChange: ReadonlyMap<string, Run>,
): Promise<void> {
  // The title lookup lists every session; not worth it for a delivery the
  // user is watching arrive.
  if (!unattended()) return
  const { sessionId } = message[0]
  const who = await subject(generation, sessionId)
  if (generation.stopped) return
  const raised = announce(generation.host, '提醒', reminderBody(who, message))
  if (raised === undefined) return
  if (raised.kind === 'badge') {
    notices += 1
    renderBadge()
  }
  const run = runningAtChange.get(sessionId)
  const wake = wakeWindow(message)
  if (run !== undefined && wake !== undefined && wake.from <= run.startedAt && run.startedAt <= wake.until) {
    generation.reminderRuns.add(run)
  }
}

/**
 * Announce that one session finished running, unless a reminder announced
 * the run already ({@link announceReminder}). A run that was going when a
 * `schedule/changed` frame arrived is decided once that frame's comparison
 * has run, so a reminder read still in flight when the woken run ends marks
 * that run in time; any other run is decided at once.
 * @param generation - the generation the edge arrived on.
 * @param sessionId - the session that went idle.
 * @param run - the run that ended, or undefined for a run this shell never
 * saw start, which is not announced.
 */
function finishRun(generation: Generation, sessionId: string, run: Run | undefined): void {
  if (run === undefined) return
  const decide = (): void => {
    if (generation.reminderRuns.delete(run)) {
      generation.host.log(`[desktop] session ${sessionId} finished the run a reminder woke; the reminder's message stands for it\n`)
      return
    }
    // The title lookup lists every session; not worth it for an edge the
    // user is watching happen.
    if (generation.stopped || !unattended()) return
    void subject(generation, sessionId).then((who) => {
      if (generation.stopped) return
      if (announce(generation.host, '任务已完成', `${who}已经跑完,可以回来看结果了。`)?.kind !== 'badge') return
      notices += 1
      renderBadge()
    })
  }
  const comparison = generation.comparing.get(run)
  if (comparison === undefined) decide()
  else void comparison.then(decide)
}

/**
 * Handle one item of the `$events` stream.
 * @param generation - the generation the stream belongs to.
 * @param host - logging and the window the notifications lead back to.
 * @param frame - the decoded downlink frame.
 * @param onReady - called once the stream's `ready` frame arrived.
 */
function onEventFrame(generation: Generation, host: NotifyHost, frame: Record<string, unknown>, onReady: () => void): void {
  switch (frame['type']) {
    case 'ready': {
      generation.clientId = text(frame, 'clientId')
      onReady()
      // The one success line the field log carries for this stream: its
      // absence after the server's URL line is the diagnostic.
      host.log(`[desktop] attention stream ready (client ${generation.clientId ?? '?'})\n`)
      const since = Date.now()
      generation.listeningSince = since
      queueReminders(generation, () => seedReminders(generation, since))
      return
    }
    case 'emit': {
      if (frame['event'] === 'schedule/changed') {
        // Sampled now, not when the read lands: the run a reminder woke can
        // end while the read is in flight.
        const runningAtChange = new Map(generation.running)
        const since = generation.listeningSince
        queueReminders(generation, () => compareReminders(generation, since, runningAtChange))
        for (const run of runningAtChange.values()) generation.comparing.set(run, generation.reminders)
        return
      }
      const args = frame['args']
      if (!Array.isArray(args)) return
      const [sessionId, isRunning] = args as unknown[]
      if (typeof sessionId !== 'string') return
      if (frame['event'] === 'api-session/removed') {
        generation.running.delete(sessionId)
        return
      }
      if (frame['event'] !== 'api-session/status') return
      if (isRunning === true) {
        generation.running.set(sessionId, { startedAt: Date.now() })
        return
      }
      const run = generation.running.get(sessionId)
      generation.running.delete(sessionId)
      finishRun(generation, sessionId, run)
      return
    }
    case 'waterfall': {
      const eventId = text(frame, 'eventId')
      const sessionId = text(frame, 'agentId')
      const request = nested(frame, 'request') ?? {}
      if (eventId === undefined || sessionId === undefined) return
      if (generation.rejected.has(eventId)) {
        // The Host is asking again for a delivery the user already refused,
        // which means the refusal never reached it. Sending it again is the
        // only thing that keeps the user's answer: the ordinary grace would
        // answer `next` in its place, and the id is already announced.
        answer(generation, eventId, { kind: 'result', value: REJECTED })
        return
      }
      scheduleNext(generation, eventId)
      // Reopening the stream replays every delivery still pending, so an id
      // that was already announced is the same request arriving twice.
      if (generation.announced.has(eventId)) return
      generation.announced.add(eventId)
      if (!unattended()) return
      if (frame['event'] === 'approval/request') {
        const tool = text(request, 'toolName') ?? '工具'
        announceDelivery(generation, sessionId, eventId, who => announce(
          host, '需要你的确认', `${who}请求执行 ${tool},正在等你批准。`, approvalActions(
            () => { answerRejected(generation, eventId) },
            () => { closeToast(generation, eventId); host.reveal() },
          ),
        ))
      } else if (frame['event'] === 'user-questions/request') {
        announceDelivery(generation, sessionId, eventId, who => announce(host, '等待你的回答', questionBody(who, request)))
      }
      return
    }
    case 'cancel': {
      const eventId = text(frame, 'eventId')
      if (eventId === undefined) return
      generation.announced.delete(eventId)
      generation.rejected.delete(eventId)
      // Someone answered: the toast is asking for a decision that has been
      // made, and Windows would keep it in the action centre until dismissed.
      closeToast(generation, eventId)
      unbadge(generation, eventId)
      dropPending(generation, eventId)
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
  let socket: WebSocket
  try {
    if (!isNodeWebSocket(WebSocket)) throw new Error('WebSocket is not the Node runtime implementation')
    socket = new WebSocket(url, { headers: { cookie } })
  } catch (error) {
    // A constructor that throws (a runtime without the `headers` init, say)
    // would otherwise end the notifier for good with nothing in the log.
    const message = error instanceof Error ? error.message : String(error)
    const nextAttempt = attempt + 1
    const delayMs = reconnectDelayMs(nextAttempt)
    host.log(`[desktop] ${url} could not be opened (${message}); retrying in ${String(delayMs / 1000)}s (attempt ${String(nextAttempt)})\n`)
    setTimeout(() => { subscribe(generation, host, nextAttempt) }, delayMs).unref()
    return
  }
  generation.socket = socket
  generation.clientId = undefined
  const streamId = randomUUID()
  // Success is the `$events` stream's `ready` frame, not the socket opening:
  // a socket that opens and then has its stream refused every time must back
  // off like one that never connects, or it reconnects every 3s forever.
  let ready = false
  socket.addEventListener('open', () => {
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
      if (value !== undefined) onEventFrame(generation, host, value, () => { ready = true })
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
    dropAllPending(generation)
    if (generation.stopped) return
    // A stream that did become ready and later closed is not a failure to
    // connect — the retry after it starts the backoff over, at attempt 1.
    const nextAttempt = ready ? 1 : attempt + 1
    // A refused upgrade is what an expired or stale cookie looks like from
    // here; the retry mints a fresh one rather than presenting the same again.
    if (!ready) generation.cookie = undefined
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
 * Start watching the running server for the moments worth interrupting for.
 * Safe to call again after a server rebind: the previous call's stream
 * is closed and its reconnect loop stopped before the new one opens, and the
 * app-level hooks (badge clearing, window-created release, quit teardown) are
 * bound only once ever.
 * @param host - logging and the window the notifications lead back to.
 * @param authenticatedUrl - the launch-token URL `startServer` (or a rebind)
 * reported; its origin is where the stream lives and its token mints the cookie.
 */
export function setupNotifications(host: NotifyHost, authenticatedUrl: string): void {
  stopCurrentGeneration()
  const generation: Generation = {
    stopped: false, socket: undefined, authenticatedUrl, cookie: undefined, clientId: undefined,
    pending: new Map(), announced: new Set(), toasts: new Map(), badged: new Set(), rejected: new Set(), running: new Map(),
    listeningSince: Number.POSITIVE_INFINITY, deliveries: undefined, reminderRuns: new WeakSet(), comparing: new WeakMap(),
    reminders: Promise.resolve(), host,
  }
  current = generation
  subscribe(generation, host)
  if (!appHooksBound) {
    appHooksBound = true
    app.on('browser-window-focus', () => { clearBadge() })
    app.on('browser-window-created', () => { onWindowCreated() })
    app.once('before-quit', () => { stopCurrentGeneration() })
  }
}

/**
 * Stop watching the server: close the stream, end its reconnect loop and its
 * cookie exchanges, and close every toast and badge count it raised. The
 * shell calls it when the server exits unexpectedly, before the recovery
 * ladder: a stream left running would keep presenting its cookie to the dead
 * server's port, and mint a new one from the old launch token, for as long as
 * no rebind replaces it. Idempotent; the next {@link setupNotifications} call
 * starts a new stream.
 */
export function stopNotifications(): void {
  stopCurrentGeneration()
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
  dropAllPending(current)
  // Every button on them answers a delivery of a server this shell is done
  // with — quitting, or a server that exited, whose successor's ids are fresh.
  closeAllToasts(current)
  // The same holds for the requests the badge counts.
  current.badged.clear()
  renderBadge()
}
