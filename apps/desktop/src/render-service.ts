/**
 * Loopback render service: the desktop shell lends its own Chromium to the
 * embedded server, so a screenshot tool inside the agent does not depend on
 * whether the machine has Chrome or Edge installed.
 *
 * The shell starts this before it spawns the server and passes the address and
 * the bearer token to that child process alone
 * (`DSH_DESKTOP_RENDER_ENDPOINT` / `DSH_DESKTOP_RENDER_TOKEN`); a plugin that
 * finds neither falls back to whatever browser the machine has. This module
 * owns the protocol — authentication, validation, admission, the per-request
 * deadline, and the line a passed deadline is explained with — and nothing
 * about Electron: the window half is [[Renderer]], injected by the caller,
 * which is what lets the protocol be tested without a display. It is also what
 * fills in the [[RenderTrace]] this module hands it, so a 504 can name the
 * request the page was still waiting on rather than only the deadline.
 *
 * The security position is the whole reason the protocol is this narrow. The
 * listener binds `127.0.0.1` on an ephemeral port, so nothing off the machine
 * can reach it. Every request carries a 32-byte token compared in constant
 * time, so another local process cannot use it by finding the port. No CORS
 * header is ever sent and every method other than `POST /render` answers 404,
 * so a page in the user's browser cannot reach it either: the preflight its
 * `authorization` and JSON content type force is refused. Renders are one at a
 * time behind a bounded queue and a hard deadline, so a caller cannot make the
 * shell hold an unbounded number of windows open.
 * @module @deepseek-ai/dsh-desktop/render-service
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

/** The only address the listener binds; there is no configuration that widens it. */
const LOOPBACK_HOST = '127.0.0.1'

/** Token length in bytes, hex-encoded onto the wire (64 characters). */
const TOKEN_BYTES = 32

/** The one route this service answers. Every other path and method is a 404. */
const RENDER_PATH = '/render'

/** URL schemes a page may be loaded from; anything else is refused with 422. */
const RENDERABLE_SCHEMES = new Set(['http:', 'https:', 'file:'])

/** How many still-pending requests a timeout line names before it counts the rest. */
const TIMEOUT_PENDING_LISTED = 3

/** The longest a URL is printed at inside a timeout line, the ellipsis that replaces the tail included. */
const TIMEOUT_URL_CHARS = 96

/**
 * The longest timeout line written. `@haoran/dsh-screenshot` quotes the first
 * 500 characters of an error body into the message the model reads
 * (`MAX_ERROR_DETAIL`), so a longer line is cut there instead — mid-word, with
 * nothing saying so. Cutting it here ends it with an ellipsis.
 */
const TIMEOUT_LINE_CHARS = 500

/**
 * The smallest real HTTP status. `did-navigate` reports -1 for a navigation
 * that carried no HTTP response, so anything below this is the absence of a
 * status rather than a code worth printing.
 */
const MIN_HTTP_STATUS = 100

/**
 * What one deployment of the service bounds. Passed in whole rather than read
 * from module state, so the shell's numbers are visible at the call site that
 * chooses them and a test can choose its own.
 */
export interface RenderLimits {
  /**
   * How long one accepted request may take, measured from acceptance rather
   * than from the start of its render: a request that spent the window waiting
   * behind others has taken that long from its caller's side too. Passing it
   * aborts the render and answers 504.
   */
  timeoutMs: number
  /**
   * How many requests may be accepted at once — one rendering and
   * `queueLimit - 1` waiting for it. The next one is refused with 503 rather
   * than queued, because a caller that is told to come back can, while a
   * request queued behind an unbounded line cannot be told anything.
   */
  queueLimit: number
  /** The largest `delayMs` a request may ask for after the page finished loading. */
  maxDelayMs: number
  /** The smallest viewport edge a request may ask for, in CSS pixels. */
  minViewport: number
  /** The largest viewport edge a request may ask for, in CSS pixels. */
  maxViewport: number
  /** The largest request body that is read; a longer one is refused with 400 instead of buffered. */
  maxBodyBytes: number
}

/**
 * What the desktop shell runs with. A render holds a window open, so the
 * deadline is long enough for a slow page and short enough that a stuck one
 * cannot occupy the single render slot for a session.
 */
export const RENDER_LIMITS: RenderLimits = {
  /**
   * Below the calling plugin's own budget, and it must stay there.
   * `@haoran/dsh-screenshot` arms `AbortSignal.timeout(timeoutMs)` — 30 s by
   * default — at the fetch call, while this deadline is created after
   * admission, behind the connection, the body read, the JSON parse, the
   * validation, and the queue check. Equal numbers make the plugin's signal
   * fire first every time, and the 504 or 503 line this service writes for the
   * model never reaches it.
   */
  timeoutMs: 25_000,
  queueLimit: 4,
  maxDelayMs: 10_000,
  minViewport: 16,
  maxViewport: 4096,
  maxBodyBytes: 64 * 1024,
}

/** One accepted render, with every optional field of the request resolved. */
export interface RenderRequest {
  /** The page to load; `http`, `https`, or `file` (checked before the renderer sees it). */
  url: string
  /** Viewport width in CSS pixels. */
  width: number
  /** Viewport height in CSS pixels. */
  height: number
  /** Capture the whole scrollable document rather than the viewport. */
  fullPage: boolean
  /** How long to wait after the page finished loading, for work that starts on load. */
  delayMs: number
}

/**
 * How far one render had got. It starts at `queued`; the window half moves it
 * to `navigating` before the load, to `loaded` when the load event fires, and
 * then through whichever of the last four the request actually asks for.
 */
export type RenderPhase = 'queued' | 'navigating' | 'loaded' | 'delaying' | 'measuring' | 'resizing' | 'capturing'

/** What a render is waiting for in each phase after the load event. */
const AFTER_LOAD_WAIT: Record<Exclude<RenderPhase, 'queued' | 'navigating'>, string> = {
  loaded: 'right after the load event',
  delaying: 'while waiting delayMs',
  measuring: 'while measuring the document',
  resizing: 'while resizing the window',
  capturing: 'while capturing',
}

/** One request the page started and has not finished. */
interface PendingRequest {
  /** The URL Chromium asked for. */
  url: string
  /** Chromium's own classification of it — `image`, `script`, `mainFrame`, and the rest. */
  resourceType: string
}

/**
 * Cut a URL to {@link TIMEOUT_URL_CHARS} characters, marking that it was cut.
 * @param url - the URL to print.
 * @returns the URL, or its first characters ending in an ellipsis.
 */
function truncateUrl(url: string): string {
  return url.length <= TIMEOUT_URL_CHARS ? url : `${url.slice(0, TIMEOUT_URL_CHARS - 1)}…`
}

/**
 * The clause naming what the page was still loading.
 * @param pending - the requests still in flight, oldest first.
 * @returns `no requests pending`, or the count and up to {@link TIMEOUT_PENDING_LISTED} of them.
 */
function pendingPhrase(pending: PendingRequest[]): string {
  if (pending.length === 0) return 'no requests pending'
  const listed = pending.slice(0, TIMEOUT_PENDING_LISTED).map(one => `[${one.resourceType}] ${truncateUrl(one.url)}`)
  const unlisted = pending.length - listed.length
  const rest = unlisted === 0 ? '' : ` (+${String(unlisted)} more)`
  return `${String(pending.length)} ${pending.length === 1 ? 'request' : 'requests'} pending: ${listed.join(', ')}${rest}`
}

/**
 * What one render was waiting for when its deadline passed.
 *
 * The service creates one per accepted request and hands it to the renderer,
 * which feeds it from events the page produces anyway. A 504 whose body is
 * only "it took too long" leaves the model unable to tell a hung image from a
 * dead proxy from a wedged renderer; this is what lets that line name the host
 * the page could not reach.
 *
 * Nothing recorded here changes what the render does — the window half feeds
 * it from non-blocking observers only — and the record is read once, from the
 * deadline timer, before the abort that tears the render down.
 */
export class RenderTrace {
  /** The URL the request named, compared against where the main frame ended up. */
  private readonly requestedUrl: string
  private phase: RenderPhase = 'queued'
  private document: { url: string; status: number } | undefined
  /** Insertion-ordered, so the requests printed first are the ones stuck longest. */
  private readonly pending = new Map<number, PendingRequest>()

  constructor(requestedUrl: string) {
    this.requestedUrl = requestedUrl
  }

  /**
   * Record that the render reached a phase.
   * @param phase - the phase it entered.
   */
  enter(phase: RenderPhase): void {
    this.phase = phase
  }

  /**
   * Record where the main frame ended up and what it answered, from `did-navigate`.
   *
   * A later navigation replaces an earlier one, so a page that redirects is
   * described by where it landed.
   * @param url - the main frame's URL after every redirect it followed.
   * @param status - the HTTP status, or anything below {@link MIN_HTTP_STATUS} for a navigation that had none.
   */
  mainDocument(url: string, status: number): void {
    this.document = { url, status }
  }

  /**
   * Record a request the page has started.
   * @param id - Chromium's request id, the key {@link RenderTrace.requestSettled} closes it with.
   * @param url - the URL being requested.
   * @param resourceType - Chromium's classification of it.
   */
  requestStarted(id: number, url: string, resourceType: string): void {
    this.pending.set(id, { url, resourceType })
  }

  /**
   * Record that a request finished, whether it succeeded or failed.
   *
   * An id that was never started is a no-op rather than an error: a request
   * served from the cache never sends headers and so is never started here,
   * while it does complete, so the two hooks do not see the same set of ids.
   * @param id - Chromium's request id.
   */
  requestSettled(id: number): void {
    this.pending.delete(id)
  }

  /**
   * The one line a 504 answers with.
   * @param timeoutMs - the deadline that passed.
   * @returns one line with no newline in it, at most {@link TIMEOUT_LINE_CHARS} characters long.
   */
  describeTimeout(timeoutMs: number): string {
    const line = `render timed out after ${String(timeoutMs)}ms: ${this.waitingFor()}`
    return line.length <= TIMEOUT_LINE_CHARS ? line : `${line.slice(0, TIMEOUT_LINE_CHARS - 1)}…`
  }

  /**
   * What the render was waiting for, from the phase it was in.
   * @returns the clause after the deadline, without the leading phrase.
   */
  private waitingFor(): string {
    const phase = this.phase
    if (phase === 'queued') return 'the render had not started (queued behind earlier renders)'
    if (phase === 'navigating') return `${this.mainDocumentPhrase()}, ${pendingPhrase([...this.pending.values()])}`
    return `page loaded, timed out ${AFTER_LOAD_WAIT[phase]}`
  }

  /**
   * What the main frame had answered by the deadline.
   * @returns the clause naming the status and, when it is not where the request pointed, where it landed.
   */
  private mainDocumentPhrase(): string {
    const document = this.document
    if (document === undefined) return 'no response from the main document yet'
    const status = document.status >= MIN_HTTP_STATUS ? String(document.status) : 'with no HTTP status'
    const landed = document.url === this.requestedUrl ? '' : ` at ${truncateUrl(document.url)}`
    return `main document ${status}${landed}, load event not fired`
  }
}

/**
 * Turns one accepted request into PNG bytes.
 *
 * The service enforces the deadline and aborts `signal` when it passes; an
 * implementation holding an operating-system resource — a window — must
 * release it on that signal, because nothing else will.
 * @param request - the accepted, fully resolved request.
 * @param signal - aborted when the request's deadline passes or the service closes.
 * @param trace - the record this render feeds, which is what a 504 for it says.
 * @returns the encoded PNG.
 */
export type Renderer = (request: RenderRequest, signal: AbortSignal, trace: RenderTrace) => Promise<Buffer>

/** How to run one render service. */
export interface RenderServiceSpec {
  /** The window half that produces the pixels. */
  renderer: Renderer
  /** The bounds this deployment enforces. */
  limits: RenderLimits
}

/** A listening render service: where it is, what opens it, and how it stops. */
export interface RenderServiceHandle {
  /** Origin the server child is told to POST to, always on the loopback address. */
  endpoint: string
  /** The bearer token this service accepts, generated fresh for every launch. */
  token: string
  /** Stop listening and drop open connections; resolves once the listener is closed. */
  close: () => Promise<void>
}

/**
 * Thrown when an accepted request passes its deadline; the only thing that
 * answers 504. Its message is the whole 504 body, so it is built from the
 * request's own {@link RenderTrace} rather than from the deadline alone.
 */
class RenderTimeout extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderTimeout'
  }
}

/** A rejected request: the status to answer and the one line explaining it. */
interface Rejection {
  ok: false
  /** 400 for a malformed request, 422 for a well-formed one naming an unrenderable scheme. */
  status: 400 | 422
  message: string
}

/** The parse result: an accepted request or the reason it is not one. */
type Resolution = { ok: true; request: RenderRequest } | Rejection

/** The request fields this service reads, all still unknown before validation. */
interface RenderBody {
  url?: unknown
  width?: unknown
  height?: unknown
  fullPage?: unknown
  delayMs?: unknown
}

/**
 * Whether an `authorization` header carries exactly this service's token.
 *
 * The comparison is length-checked first and then constant-time, so the reply
 * timing says nothing about how much of a guessed token was right.
 * @param header - the request's `authorization` header, if it sent one.
 * @param token - the token this service accepts.
 * @returns true when the header is `Bearer <token>` for that exact token.
 */
function authorized(header: string | undefined, token: string): boolean {
  if (header === undefined) return false
  const offered = /^Bearer[ ]+(\S+)$/i.exec(header.trim())?.[1]
  if (offered === undefined) return false
  const left = Buffer.from(offered, 'utf8')
  const right = Buffer.from(token, 'utf8')
  return left.byteLength === right.byteLength && timingSafeEqual(left, right)
}

/**
 * One integer viewport edge inside the configured bounds.
 * @param value - the JSON value the request carried.
 * @param limits - the bounds to apply.
 * @returns the dimension, or undefined when the value is not one.
 */
function viewportEdge(value: unknown, limits: RenderLimits): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  if (value < limits.minViewport || value > limits.maxViewport) return undefined
  return value
}

/**
 * Turn a parsed JSON body into an accepted request, or say why it is not one.
 * @param raw - the parsed body.
 * @param limits - the bounds to validate against.
 * @returns the resolved request, or the status and message to answer with.
 */
function resolveRequest(raw: unknown, limits: RenderLimits): Resolution {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, status: 400, message: 'body must be a JSON object' }
  }
  const body: RenderBody = raw
  if (typeof body.url !== 'string' || body.url === '') {
    return { ok: false, status: 400, message: 'url must be a non-empty string' }
  }
  if (!URL.canParse(body.url)) {
    return { ok: false, status: 400, message: 'url must be an absolute URL' }
  }
  const scheme = new URL(body.url).protocol
  if (!RENDERABLE_SCHEMES.has(scheme)) {
    return { ok: false, status: 422, message: `url scheme ${scheme} is not renderable; use http, https, or file` }
  }
  const bounds = `an integer between ${String(limits.minViewport)} and ${String(limits.maxViewport)}`
  const width = viewportEdge(body.width, limits)
  if (width === undefined) return { ok: false, status: 400, message: `width must be ${bounds}` }
  const height = viewportEdge(body.height, limits)
  if (height === undefined) return { ok: false, status: 400, message: `height must be ${bounds}` }
  const fullPage = body.fullPage ?? false
  if (typeof fullPage !== 'boolean') return { ok: false, status: 400, message: 'fullPage must be a boolean' }
  const delayMs = body.delayMs ?? 0
  if (typeof delayMs !== 'number' || !Number.isInteger(delayMs) || delayMs < 0 || delayMs > limits.maxDelayMs) {
    return { ok: false, status: 400, message: `delayMs must be an integer between 0 and ${String(limits.maxDelayMs)}` }
  }
  return { ok: true, request: { url: body.url, width, height, fullPage, delayMs } }
}

/**
 * Read a request body, keeping at most `maxBodyBytes` of it.
 *
 * An oversized upload is read to its end and discarded rather than cut off:
 * memory stays bounded either way, and destroying the request mid-upload would
 * take the socket down with it, so the caller would get a dropped connection
 * where it should get the sentence saying what was wrong.
 * @param request - the incoming request.
 * @param maxBodyBytes - the largest body to accept.
 * @returns the body text, or undefined when the request sent more than the cap.
 */
async function readBody(request: IncomingMessage, maxBodyBytes: number): Promise<string | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = chunk as Buffer
    size += bytes.byteLength
    if (size <= maxBodyBytes) chunks.push(bytes)
  }
  if (size > maxBodyBytes) return undefined
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Answer with a status and one line of plain text. Every failure this service
 * reports is one sentence, because its caller is a tool that puts it in a
 * message, not a page that formats it.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param message - the single line explaining it.
 */
function fail(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
  })
  response.end(body)
}

/**
 * Answer with the encoded image.
 * @param response - the response to write.
 * @param png - the PNG bytes the renderer produced.
 */
function sendPng(response: ServerResponse, png: Buffer): void {
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': String(png.byteLength),
    'cache-control': 'no-store',
  })
  response.end(png)
}

/**
 * Start the loopback render service and listen on an ephemeral port.
 *
 * The token is generated here rather than accepted from the caller, so there
 * is no way to run this service with a value that came from anywhere but
 * `randomBytes`.
 * @param spec - the renderer to drive and the bounds to enforce.
 * @returns the listening service: its endpoint, its token, and its stop.
 * @throws when the loopback listener cannot be opened.
 */
export async function startRenderService(spec: RenderServiceSpec): Promise<RenderServiceHandle> {
  const { limits, renderer } = spec
  const token = randomBytes(TOKEN_BYTES).toString('hex')
  /** Requests accepted right now: at most one rendering, the rest waiting. */
  let admitted = 0
  /** The serialization chain; every accepted render runs after the previous one is settled or abandoned. */
  let tail: Promise<void> = Promise.resolve()

  const runQueued = async (request: RenderRequest): Promise<Buffer> => {
    const controller = new AbortController()
    const trace = new RenderTrace(request.url)
    const job = tail.then(() => {
      // No window for a request whose deadline passed before the chain reached
      // it. Deadlines are armed at admission and the chain advances no later
      // than the head request's own, so this does not fire under that ordering;
      // what it rules out is a whole render whose result the deadline has
      // already discarded. The trace is still `queued`, which is what its line
      // says.
      if (controller.signal.aborted) throw new RenderTimeout(trace.describeTimeout(limits.timeoutMs))
      return renderer(request, controller.signal, trace)
    })
    // Resolves when this request is abandoned, whatever its renderer goes on
    // doing.
    const abandoned = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    // The chain advances when a request is abandoned, not only when its
    // renderer settles: `webContents.executeJavaScript` never settles once its
    // window is destroyed, so a chain that waited for the renderer would leave
    // every later request queued behind a link that never moves, for the life
    // of the process. Swallowing keeps one rejection from settling everything
    // queued behind it. An abandoned render may still be running beside the
    // next one; that is safe because `renderInHiddenWindow` destroys the window
    // unconditionally on both the abort listener and its `finally`, so the
    // window and its renderer process are already released.
    tail = Promise.race([job, abandoned]).then(() => undefined, () => undefined)
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        // Read before the abort, not after: the abort destroys the render's
        // window, and its session then reports every request that was still in
        // flight as failed — emptying the very list this line exists to name.
        const message = trace.describeTimeout(limits.timeoutMs)
        controller.abort()
        reject(new RenderTimeout(message))
      }, limits.timeoutMs)
    })
    try {
      return await Promise.race([job, deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const path = new URL(request.url ?? '/', `http://${LOOPBACK_HOST}`).pathname
      if (request.method !== 'POST' || path !== RENDER_PATH) {
        fail(response, 404, `no route for ${request.method ?? 'unknown'} ${path}`)
        return
      }
      if (!authorized(request.headers.authorization, token)) {
        fail(response, 401, 'authorization must be Bearer <token> carrying this service\'s token')
        return
      }
      if (!(request.headers['content-type'] ?? '').startsWith('application/json')) {
        fail(response, 400, 'content-type must be application/json')
        return
      }
      const body = await readBody(request, limits.maxBodyBytes)
      if (body === undefined) {
        fail(response, 400, `body must be at most ${String(limits.maxBodyBytes)} bytes`)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(body)
      } catch (error) {
        fail(response, 400, `body must be JSON: ${error instanceof Error ? error.message : String(error)}`)
        return
      }
      const resolution = resolveRequest(parsed, limits)
      if (!resolution.ok) {
        fail(response, resolution.status, resolution.message)
        return
      }
      if (admitted >= limits.queueLimit) {
        fail(response, 503, `busy: ${String(limits.queueLimit)} renders are already accepted`)
        return
      }
      admitted++
      try {
        sendPng(response, await runQueued(resolution.request))
      } finally {
        admitted--
      }
    } catch (error) {
      if (error instanceof RenderTimeout) {
        fail(response, 504, error.message)
        return
      }
      fail(response, 500, `render failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const server = createServer((request, response) => {
    // `handle` answers every failure itself, so nothing here can reject.
    void handle(request, response)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') {
    throw new Error('render service: the loopback listener reported no TCP address')
  }
  return {
    endpoint: `http://${LOOPBACK_HOST}:${String(address.port)}`,
    token,
    close: async () => {
      // Sockets an agent left open would otherwise hold the listener open past
      // the quit that asked for it to close.
      server.closeAllConnections()
      await new Promise<void>((resolve) => {
        server.close(() => { resolve() })
      })
    },
  }
}
