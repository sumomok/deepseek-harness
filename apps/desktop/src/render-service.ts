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
 * Every answer that reached a render — the 200, the 500 a failed render is
 * refused with, and the 504 — carries that record as a [[RenderReport]] on
 * `x-dsh-render-report`, so a caller reads the same structure whichever way the
 * render ended. A request owns its own deadline (`timeoutMs`, under this
 * deployment's ceiling) and says what it wants when that deadline passes
 * (`onTimeout`): `fail` is the 504, `capture` answers 200 with whatever had
 * painted, labelled `outcome: 'timeout'` in the report. A request may also name
 * hosts whose requests are cancelled before they go out (`blockHosts`), which
 * is the remedy the report names for a page held up by a third-party host.
 *
 * The security position is the whole reason the protocol is this narrow. The
 * listener binds `127.0.0.1` on an ephemeral port, so nothing off the machine
 * can reach it. Every request carries a 32-byte token compared in constant
 * time, so another local process cannot use it by finding the port. No CORS
 * header is ever sent and every method other than `POST /render` answers 404,
 * so a page in the user's browser cannot reach it either: the preflight its
 * `authorization` and JSON content type force is refused. Renders are one at a
 * time behind a bounded queue and a hard deadline, so a caller cannot make the
 * shell hold an unbounded number of windows open. A request may carry headers
 * and cookies for the page it names — bounded in count and size, checked
 * against their own grammars — and those go onto the render's own throwaway
 * session, never the user's; the caller supplies them, so this service never
 * holds a credential of its own.
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

/** The two schemes a request may attach headers or cookies to; a `file:` load carries neither. */
const SESSION_SCHEMES = new Set(['http:', 'https:'])

/** RFC 9110 token: every character an HTTP header name and a cookie name may contain. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/**
 * Header field values: visible ASCII, space, and tab. The exclusion that
 * matters is CR and LF — `loadURL` takes its extra headers as one newline-
 * separated string, so a value carrying a newline would append headers of the
 * caller's choosing.
 */
const HEADER_VALUE = /^[\t\x20-\x7e]*$/

/** RFC 6265 cookie-octet: no controls, whitespace, quotes, commas, semicolons, or backslashes. */
const COOKIE_VALUE = /^[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/

/**
 * Response header naming where the main frame ended up, written only when that
 * is not the URL the request asked for. It is what lets a caller say "this is
 * the sign-in page, not the page you asked for" about a render that succeeded;
 * a 504 says the same thing in its line. Percent-encoded outside printable
 * ASCII, because a header value carries no other encoding.
 */
const LANDED_URL_HEADER = 'x-dsh-render-landed-url'

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
 * Response header carrying the whole [[RenderReport]] as percent-encoded JSON.
 *
 * A header rather than a body, because the two answers that need the report
 * most already own their body: a 200 carries PNG bytes and a 504 carries the
 * one line humans and logs read. One place to look on every answer is also what
 * lets a caller write a single reader for success and failure alike.
 */
const REPORT_HEADER = 'x-dsh-render-report'

/**
 * The report schema this service writes. A reader that does not know this
 * number knows nothing about the fields beside it and must ignore the header
 * rather than guess at them.
 */
const REPORT_VERSION = 1

/** How many pending requests, failed requests, and hosts one report lists. */
const REPORT_LISTED = 5

/** How many error-level console messages one report quotes. */
const REPORT_CONSOLE_SAMPLES = 3

/**
 * The bytes {@link REPORT_HEADER} may reach, which every cap below is chosen
 * against: with every list full and every string over its cap, the encoded
 * header measures 4.2 KB, so no page can reach this ceiling and the schema has
 * room to grow. Bounding it by construction rather than by cutting the finished
 * header is the whole point — a header cut to fit is JSON no reader can parse.
 */
export const REPORT_HEADER_BYTES = 6 * 1024

/**
 * The longest a URL, a host, or a page title is reported at, counted in the
 * bytes it contributes to the encoded header rather than in characters: a
 * character outside printable ASCII costs three bytes there, so a cap in
 * characters would bound nothing. An ASCII URL is therefore cut exactly where
 * the timeout line cuts it.
 */
const REPORT_URL_BYTES = TIMEOUT_URL_CHARS

/** The longest a console message or a load-failure description is reported at, in encoded header bytes. */
const REPORT_MESSAGE_BYTES = 160

/** The longest a `net::ERR_…` string is reported at, in encoded header bytes. */
const REPORT_ERROR_BYTES = 64

/** The longest a Chromium resource type or renderer-gone reason is reported at, in encoded header bytes. */
const REPORT_TAG_BYTES = 32

/** What marks a string the report cut, so a reader can tell a cut value from a short one. */
const REPORT_CUT = '…'

/**
 * The shortest deadline a request may ask for. A render opens a window, loads a
 * page, and waits for its load event; a budget under this reaches the capture
 * on no machine, so accepting one would only sell the caller a 504.
 */
const MIN_TIMEOUT_MS = 1_000

/** How many host patterns one request may carry; each is matched against every request the page makes. */
const MAX_BLOCK_HOSTS = 32

/** The longest one host pattern may be: RFC 1035's maximum length for a domain name. */
const MAX_BLOCK_HOST_CHARS = 253

/**
 * A host pattern: an exact host, or `*.` and a suffix that matches that host's
 * subdomains and not the host itself. Lowercase because a host is
 * case-insensitive and both sides are lowered before they meet.
 */
const BLOCK_HOST = /^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * What a render that ended somewhere other than the URL it was pointed at can
 * be retried with, in the words `@haoran/dsh-screenshot` uses when the same
 * redirect ends in a 200, so a caller is told the same thing whichever way the
 * render ends.
 *
 * It is printed before the pending list, not at the end of the line.
 * Everything ahead of it is bounded — the deadline, a status, a landing URL cut
 * at {@link TIMEOUT_URL_CHARS}, and fixed wording, under 250 characters
 * together — while the pending list grows with the page, so a clause printed
 * after that list is what {@link TIMEOUT_LINE_CHARS} drops on exactly the
 * pages whose renders are hardest to explain.
 */
const REDIRECT_HINT = 'pass cookies or headers to capture it with a session'

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
   * How long one accepted request may take when it names no deadline of its
   * own, measured from acceptance rather than from the start of its render: a
   * request that spent the window waiting behind others has taken that long
   * from its caller's side too. Passing it aborts the render and answers 504,
   * or a partial capture when the request asked for one.
   */
  timeoutMs: number
  /**
   * The longest deadline a request may ask for. A render holds a window and the
   * single render slot for its whole deadline, so this is what stops one caller
   * from occupying both for as long as it likes.
   */
  maxTimeoutMs: number
  /**
   * How long a timed-out render's partial capture may take before the render is
   * abandoned anyway. The window is still alive at this point only because the
   * abort is held back for it, and a renderer whose page is wedged may never
   * answer `capturePage` at all.
   */
  captureOnTimeoutMs: number
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
  /**
   * How many extra headers and cookies one request may carry, counted
   * together: they are one budget because they cost the same thing — entries
   * copied onto a page load this service performs on a caller's behalf.
   */
  maxExtraFields: number
  /** The largest those names and values may come to, in UTF-8 bytes, across both maps. */
  maxExtraBytes: number
}

/**
 * What the desktop shell runs with. A render holds a window open, so the
 * deadline is long enough for a slow page and short enough that a stuck one
 * cannot occupy the single render slot for a session.
 */
export const RENDER_LIMITS: RenderLimits = {
  /**
   * What a caller that names no `timeoutMs` gets, which is every caller written
   * against the protocol before the field existed. A caller that does name one
   * owns the number and arms its own abort above it; this default has to stay
   * below `@haoran/dsh-screenshot`'s 30-second fetch budget, because that
   * signal is armed at the fetch call while this deadline starts after
   * admission — behind the connection, the body read, the JSON parse, the
   * validation, and the queue check.
   */
  timeoutMs: 25_000,
  /**
   * Two minutes: long enough for the slowest page anyone has needed a picture
   * of, and short enough that a caller that armed no abort of its own still
   * gets an answer within a session.
   */
  maxTimeoutMs: 120_000,
  captureOnTimeoutMs: 3_000,
  queueLimit: 4,
  maxDelayMs: 10_000,
  minViewport: 16,
  maxViewport: 4096,
  maxBodyBytes: 64 * 1024,
  // Enough for a session cookie set, a CSRF token, an authorization header, and
  // the odd host override; far below what the body cap already allows, so the
  // refusal a caller gets names the field rather than the byte count.
  maxExtraFields: 24,
  maxExtraBytes: 8 * 1024,
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
  /**
   * This request's own deadline, measured from acceptance: what the caller
   * named, or the deployment's {@link RenderLimits.timeoutMs} when it named
   * none.
   */
  timeoutMs: number
  /** What the deadline produces: the 504, or a capture of whatever had painted. */
  onTimeout: TimeoutBehavior
  /**
   * Host patterns whose requests are cancelled before they go out, absent when
   * the request named none. Lowercased, and matched by
   * {@link blockedByPattern}. The main document's own host is refused at
   * validation, so this can never cancel the navigation itself.
   */
  blockHosts?: string[]
  /**
   * Extra headers for the main-frame request, absent when the request named
   * none. They ride the navigation only: subresources the page then loads are
   * ordinary requests, which is why a session belongs in {@link RenderRequest.cookies}.
   */
  headers?: Record<string, string>
  /**
   * Cookies to set on the render's own session before the load, by name,
   * absent when the request named none. Unlike headers these reach every
   * request the page makes, which is what renders a signed-in page complete
   * rather than a signed-in document full of broken images.
   */
  cookies?: Record<string, string>
}

/** What a request asks the service to do when its deadline passes. */
export type TimeoutBehavior = 'fail' | 'capture'

/**
 * How one render ended, as the report labels it. `timeout` is both answers a
 * passed deadline can produce — the 504, and the 200 carrying a partial
 * capture — because the page was in the same state either way; what tells them
 * apart is whether {@link RenderReport.capture} is there.
 */
export type RenderOutcome = 'complete' | 'timeout' | 'failed'

/**
 * How far one render had got. It starts at `queued`; the window half moves it
 * to `navigating` before the load, to `loaded` when the load event fires, and
 * then through whichever of the last four the request actually asks for.
 */
export type RenderPhase = 'queued' | 'navigating' | 'loaded' | 'delaying' | 'measuring' | 'resizing' | 'capturing'

/** Console severities Chromium reports, of which the report counts the last two. */
export type ConsoleLevel = 'debug' | 'info' | 'warning' | 'error'

/** One request the page had started and not finished when the report was taken. */
export interface ReportedRequest {
  /** The URL, cut at {@link REPORT_URL_BYTES}. */
  url: string
  /** Chromium's classification of it — `image`, `script`, `mainFrame`, and the rest. */
  type: string
  /** How long it had been in flight, measured from the moment its headers were sent. */
  ageMs: number
}

/** One request that ended in a network error or an HTTP status of 400 or more. */
export interface ReportedFailure {
  /** The URL, cut at {@link REPORT_URL_BYTES}. */
  url: string
  /** Chromium's classification of it. */
  type: string
  /** Chromium's `net::ERR_…` string, or null for a request that answered a status. */
  error: string | null
  /** The HTTP status, or null for a request that never got one. */
  status: number | null
}

/** What one host cost the render, which is what makes it worth naming in `blockHosts`. */
export interface ReportedHost {
  /** The host, cut at {@link REPORT_URL_BYTES}. */
  host: string
  /** How many of its requests were still in flight. */
  pending: number
  /** How many of its requests failed. */
  failed: number
  /** How many of its requests this render cancelled because `blockHosts` named it. */
  blocked: number
  /** The age of its oldest request still in flight. */
  maxAgeMs: number
}

/** What the render produced, in the CSS pixels the request asked for. */
export interface ReportedCapture {
  /** Whether these are the pixels of a page that had not finished loading. */
  partial: boolean
  /** Width in CSS pixels. */
  width: number
  /** Height in CSS pixels: the viewport, or the document a `fullPage` render measured. */
  height: number
}

/**
 * What one render did, whichever way it ended.
 *
 * It travels on {@link REPORT_HEADER} as percent-encoded JSON, on the 200, on
 * the 500 a failed render is refused with, and on the 504 — never on a refusal
 * that no render was started for. Every list is capped in count and every
 * string in length, so the encoded header stays under
 * {@link REPORT_HEADER_BYTES} whatever the page does.
 *
 * The point of it is that a caller can act: `hosts` names what to put in
 * `blockHosts`, `elapsedMs` against `deadlineMs` says whether `timeoutMs` is
 * worth raising, and `mainDocument` says whether the page it got is the page it
 * asked for.
 */
export interface RenderReport {
  /** {@link REPORT_VERSION}; a reader that does not know it ignores the rest. */
  version: number
  /** How the render ended. */
  outcome: RenderOutcome
  /** The phase it was in when the report was taken. */
  phase: RenderPhase
  /** How long the request had been accepted for. */
  elapsedMs: number
  /** The deadline this request was running under. */
  deadlineMs: number
  /** The URL the request named, cut at {@link REPORT_URL_BYTES}. */
  requestedUrl: string
  /** Where the main frame ended and what it answered, or null when it never reported a navigation. */
  mainDocument: {
    /** The main frame's URL after every redirect it followed, cut at {@link REPORT_URL_BYTES}. */
    url: string
    /** Its HTTP status, or null for a navigation that carried none. */
    status: number | null
    /** Whether the navigation followed a redirect. */
    redirected: boolean
    /** The page title, or null when the page set none, cut at {@link REPORT_URL_BYTES}. */
    title: string | null
  } | null
  /** Whether the load event fired, which is what the render waits for before it captures. */
  loadEventFired: boolean
  /** Whether the window had painted a frame, which is what makes a partial capture worth taking. */
  firstPaint: boolean
  /** What the page asked the network for. `total` counts only requests that reached the wire. */
  requests: {
    /** How many requests sent headers. */
    total: number
    /** How many answered a status below 400. */
    completed: number
    /** How many failed or answered 400 and above. */
    failed: number
    /** How many were still in flight. */
    pending: number
    /** How many `blockHosts` cancelled before they went out. */
    blocked: number
  }
  /** Up to {@link REPORT_LISTED} requests still in flight, oldest first. */
  pending: ReportedRequest[]
  /** Up to {@link REPORT_LISTED} failed requests, in the order they failed. */
  failed: ReportedFailure[]
  /** Up to {@link REPORT_LISTED} hosts, most pending first and then most failed. */
  hosts: ReportedHost[]
  /** What the page logged. */
  console: {
    /** How many error-level messages. */
    errors: number
    /** How many warning-level messages. */
    warnings: number
    /** The first {@link REPORT_CONSOLE_SAMPLES} error-level messages, each cut at {@link REPORT_MESSAGE_BYTES}. */
    samples: string[]
  }
  /** Why the main frame's own load failed, from `did-fail-load`, or null when it did not. */
  mainFrameError: {
    /** Chromium's negative error code. */
    code: number
    /** Its description, cut at {@link REPORT_MESSAGE_BYTES}. */
    description: string
  } | null
  /** What became of the render process. */
  renderer: {
    /** Why it disappeared, from `render-process-gone`, or null while it is alive. */
    gone: string | null
    /** Whether the page stopped answering. */
    unresponsive: boolean
  }
  /** The pixels this answer carries, or null for an answer that carries none. */
  capture: ReportedCapture | null
}

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
  /** When its headers went out, which is what {@link ReportedRequest.ageMs} is measured from. */
  startedAt: number
}

/** One request that ended in a network error or an HTTP status of 400 or more. */
interface FailedRequest {
  /** The URL Chromium asked for. */
  url: string
  /** Chromium's own classification of it. */
  resourceType: string
  /** Chromium's `net::ERR_…` string, or undefined for a request that answered a status. */
  error?: string
  /** The HTTP status, or undefined for a request that never got one. */
  status?: number
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
 * Whether two URLs name the same page after normalization. Chromium reports
 * the URL it actually loaded, so `http://host:30010` comes back as
 * `http://host:30010/`; comparing the raw strings would call that a redirect.
 * @param left - one URL.
 * @param right - the other.
 * @returns true when both parse to the same normalized URL, or are identical.
 */
function sameUrl(left: string, right: string): boolean {
  if (left === right) return true
  if (!URL.canParse(left) || !URL.canParse(right)) return false
  return new URL(left).href === new URL(right).href
}

/**
 * Percent-encode text for a header value: every byte outside printable ASCII
 * escaped, existing escapes left alone. Never throws — a lone surrogate
 * encodes as the replacement character's bytes rather than failing the reply
 * this header is only an annotation on.
 * @param text - the URL or JSON document to put on the wire.
 * @returns the header value.
 */
function headerSafeText(text: string): string {
  let encoded = ''
  for (const byte of Buffer.from(text, 'utf8')) {
    encoded += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return encoded
}

/**
 * The bytes one string costs inside {@link REPORT_HEADER}: what JSON escaping
 * makes of it, and then what {@link headerSafeText} makes of that.
 *
 * An upper bound rather than the exact length — a control character is counted
 * at its longest JSON escape — because what the caps have to hold is the worst
 * case, and a bound proved from the caps alone is what lets the header be
 * built and never measured.
 * @param text - the string that would go into the report.
 * @returns the largest number of header bytes it can come to.
 */
function encodedCost(text: string): number {
  let cost = 0
  for (const byte of Buffer.from(text, 'utf8')) {
    if (byte < 0x20) cost += 6
    else if (byte === 0x22 || byte === 0x5c) cost += 2
    else if (byte <= 0x7e) cost += 1
    else cost += 3
  }
  return cost
}

/**
 * Cut a string to the header bytes it may cost, marking that it was cut.
 *
 * Cutting happens per character, so a multi-byte character is never split into
 * bytes that decode to nothing.
 * @param text - the value to report.
 * @param maxBytes - the largest {@link encodedCost} the result may have, the cut marker included.
 * @returns the string, or its first characters ending in {@link REPORT_CUT}.
 */
function boundedText(text: string, maxBytes: number): string {
  if (encodedCost(text) <= maxBytes) return text
  let kept = ''
  let cost = encodedCost(REPORT_CUT)
  for (const character of text) {
    const next = encodedCost(character)
    if (cost + next > maxBytes) break
    kept += character
    cost += next
  }
  return `${kept}${REPORT_CUT}`
}

/**
 * The host a URL names, lowercased.
 * @param url - the URL to read.
 * @returns the host, or an empty string for a URL that has none (`file:`) or does not parse.
 */
function hostOf(url: string): string {
  if (!URL.canParse(url)) return ''
  return new URL(url).hostname.toLowerCase()
}

/**
 * Whether a request's URL is one the render was told not to make.
 *
 * The grammar is the whole feature: an exact host blocks that host, and
 * `*.suffix` blocks every subdomain of `suffix` and not `suffix` itself, so a
 * caller can block a CDN's shards without blocking the site it is naming.
 * @param patterns - the request's lowercased `blockHosts`.
 * @param url - the URL Chromium is about to request.
 * @returns true when one pattern matches the URL's host.
 */
export function blockedByPattern(patterns: readonly string[], url: string): boolean {
  const host = hostOf(url)
  if (host === '') return false
  return patterns.some(pattern => pattern.startsWith('*.') ? host.endsWith(pattern.slice(1)) : host === pattern)
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
 * What one render did, and what it was waiting for if its deadline passed.
 *
 * The service creates one per accepted request and hands it to the renderer,
 * which feeds it from events the page produces anyway. A 504 whose body is
 * only "it took too long" leaves the model unable to tell a hung image from a
 * dead proxy from a wedged renderer; this is what lets that line name the host
 * the page could not reach, and what {@link RenderTrace.report} turns into the
 * structure every answer carries.
 *
 * Nothing recorded here changes what the render does — the window half feeds
 * it from non-blocking observers only — and the record is read once, from the
 * deadline timer, before the abort that tears the render down.
 */
export class RenderTrace {
  /** The URL the request named, compared against where the main frame ended up. */
  private readonly requestedUrl: string
  /**
   * Whether a retry of this request could carry a session at all, which is what
   * makes {@link REDIRECT_HINT} worth printing: `resolveRequest` answers 422 to
   * headers or cookies on a `file:` URL, so naming them for one would be advice
   * the service refuses.
   */
  private readonly sessionScheme: boolean
  /** When the request was accepted, which `elapsedMs` and every request age are measured from. */
  private readonly acceptedAt = Date.now()
  private phase: RenderPhase = 'queued'
  private document: { url: string; status: number } | undefined
  private documentRedirected = false
  private documentTitle: string | undefined
  private painted = false
  private loadFailure: { code: number; description: string } | undefined
  private processGone: string | undefined
  private unresponsive = false
  private consoleErrors = 0
  private consoleWarnings = 0
  /** The first {@link REPORT_CONSOLE_SAMPLES} error-level messages, already cut to their reported length. */
  private readonly consoleSamples: string[] = []
  /** Insertion-ordered, so the requests printed first are the ones stuck longest. */
  private readonly pending = new Map<number, PendingRequest>()
  /** The first {@link REPORT_LISTED} failures, kept whole; the counts below cover the rest. */
  private readonly failures: FailedRequest[] = []
  private startedCount = 0
  private completedCount = 0
  private failedCount = 0
  private blockedCount = 0
  private readonly failedByHost = new Map<string, number>()
  private readonly blockedByHost = new Map<string, number>()

  /**
   * @param requestedUrl - the absolute URL the request named, as `resolveRequest` accepted it.
   */
  constructor(requestedUrl: string) {
    this.requestedUrl = requestedUrl
    this.sessionScheme = SESSION_SCHEMES.has(new URL(requestedUrl).protocol)
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

  /** Record that the main frame followed a redirect, from `did-redirect-navigation`. */
  mainDocumentRedirected(): void {
    this.documentRedirected = true
  }

  /**
   * Record the page's title, from `page-title-updated` or `getTitle()`.
   *
   * An empty title is the absence of one rather than a title of no characters,
   * so it never replaces one the page had already set.
   * @param title - the title the page carries.
   */
  pageTitle(title: string): void {
    if (title !== '') this.documentTitle = title
  }

  /** Record that the window painted a frame, from `ready-to-show`. */
  firstPaint(): void {
    this.painted = true
  }

  /**
   * Record that the main frame's own load failed, from `did-fail-load`.
   * @param code - Chromium's negative error code.
   * @param description - its `ERR_…` description.
   */
  mainFrameFailed(code: number, description: string): void {
    this.loadFailure = { code, description }
  }

  /**
   * Record one console message, from `console-message`.
   *
   * Errors and warnings are counted and everything below them is dropped: a
   * page that logs on every frame would otherwise be the only thing the report
   * has room for.
   * @param level - the severity Chromium reported.
   * @param message - the message text.
   */
  consoleMessage(level: ConsoleLevel, message: string): void {
    if (level === 'warning') this.consoleWarnings++
    if (level !== 'error') return
    this.consoleErrors++
    if (this.consoleSamples.length < REPORT_CONSOLE_SAMPLES) this.consoleSamples.push(boundedText(message, REPORT_MESSAGE_BYTES))
  }

  /**
   * Record that the render process disappeared, from `render-process-gone`.
   * @param reason - Electron's reason: `crashed`, `killed`, `oom`, and the rest.
   */
  rendererGone(reason: string): void {
    this.processGone = reason
  }

  /** Record that the page stopped answering, from `unresponsive`. */
  rendererUnresponsive(): void {
    this.unresponsive = true
  }

  /**
   * Record a request the page has started.
   * @param id - Chromium's request id, the key {@link RenderTrace.requestCompleted} and {@link RenderTrace.requestFailed} close it with.
   * @param url - the URL being requested.
   * @param resourceType - Chromium's classification of it.
   */
  requestStarted(id: number, url: string, resourceType: string): void {
    this.startedCount++
    this.pending.set(id, { url, resourceType, startedAt: Date.now() })
  }

  /**
   * Record that a request answered.
   *
   * An id that was never started is a no-op rather than an error: a request
   * served from the cache never sends headers and so is never started here,
   * while it does complete, so the two hooks do not see the same set of ids.
   * Counting it would leave `completed` above `total`.
   * @param id - Chromium's request id.
   * @param statusCode - the HTTP status it answered; 400 and above counts as a failure.
   */
  requestCompleted(id: number, statusCode: number): void {
    const started = this.pending.get(id)
    if (started === undefined) return
    this.pending.delete(id)
    if (statusCode < 400) {
      this.completedCount++
      return
    }
    this.recordFailure({ url: started.url, resourceType: started.resourceType, status: statusCode })
  }

  /**
   * Record that a request failed before it answered.
   * @param id - Chromium's request id.
   * @param error - Chromium's `net::ERR_…` string.
   */
  requestFailed(id: number, error: string): void {
    const started = this.pending.get(id)
    if (started === undefined) return
    this.pending.delete(id)
    this.recordFailure({ url: started.url, resourceType: started.resourceType, error })
  }

  /**
   * Record that this render cancelled a request because `blockHosts` named its host.
   *
   * A cancelled request never sends headers, so it is in none of the counts
   * above: it is what the caller asked not to happen rather than something the
   * page is waiting for.
   * @param url - the URL that was not requested.
   */
  requestBlocked(url: string): void {
    this.blockedCount++
    const host = hostOf(url)
    if (host !== '') this.blockedByHost.set(host, (this.blockedByHost.get(host) ?? 0) + 1)
  }

  /**
   * Count one failure, keeping the first {@link REPORT_LISTED} of them whole.
   * @param failure - the request that failed.
   */
  private recordFailure(failure: FailedRequest): void {
    this.failedCount++
    if (this.failures.length < REPORT_LISTED) this.failures.push(failure)
    const host = hostOf(failure.url)
    if (host !== '') this.failedByHost.set(host, (this.failedByHost.get(host) ?? 0) + 1)
  }

  /**
   * Everything this render recorded, in the structure every answer carries.
   *
   * Taken as a snapshot rather than held as one: the deadline path reads it
   * before the abort, because the abort destroys the window and the session
   * then reports every request that was in flight as failed.
   * @param outcome - how the render ended.
   * @param deadlineMs - the deadline this request was running under.
   * @returns the report, every list capped and every string cut to its reported length.
   */
  report(outcome: RenderOutcome, deadlineMs: number): RenderReport {
    const now = Date.now()
    const pending = [...this.pending.values()]
    return {
      version: REPORT_VERSION,
      outcome,
      phase: this.phase,
      elapsedMs: now - this.acceptedAt,
      deadlineMs,
      requestedUrl: boundedText(this.requestedUrl, REPORT_URL_BYTES),
      mainDocument: this.document === undefined
        ? null
        : {
          url: boundedText(this.document.url, REPORT_URL_BYTES),
          status: this.document.status >= MIN_HTTP_STATUS ? this.document.status : null,
          redirected: this.documentRedirected,
          title: this.documentTitle === undefined ? null : boundedText(this.documentTitle, REPORT_URL_BYTES),
        },
      loadEventFired: this.phase !== 'queued' && this.phase !== 'navigating',
      firstPaint: this.painted,
      requests: {
        total: this.startedCount,
        completed: this.completedCount,
        failed: this.failedCount,
        pending: this.pending.size,
        blocked: this.blockedCount,
      },
      pending: pending.slice(0, REPORT_LISTED).map(one => ({
        url: boundedText(one.url, REPORT_URL_BYTES),
        type: boundedText(one.resourceType, REPORT_TAG_BYTES),
        ageMs: now - one.startedAt,
      })),
      failed: this.failures.map(one => ({
        url: boundedText(one.url, REPORT_URL_BYTES),
        type: boundedText(one.resourceType, REPORT_TAG_BYTES),
        error: one.error === undefined ? null : boundedText(one.error, REPORT_ERROR_BYTES),
        status: one.status ?? null,
      })),
      hosts: this.worstHosts(now),
      console: { errors: this.consoleErrors, warnings: this.consoleWarnings, samples: [...this.consoleSamples] },
      mainFrameError: this.loadFailure === undefined
        ? null
        : { code: this.loadFailure.code, description: boundedText(this.loadFailure.description, REPORT_MESSAGE_BYTES) },
      renderer: {
        gone: this.processGone === undefined ? null : boundedText(this.processGone, REPORT_TAG_BYTES),
        unresponsive: this.unresponsive,
      },
      capture: null,
    }
  }

  /**
   * The hosts this render has the most to say about.
   *
   * Ordered by requests still in flight and then by failures, because that is
   * the order a caller would put them into `blockHosts`: a host holding the
   * load event open costs the whole render, while one that failed fast cost it
   * nothing but a missing image.
   * @param now - the moment the report is being taken, which every age is measured against.
   * @returns up to {@link REPORT_LISTED} hosts, worst first.
   */
  private worstHosts(now: number): ReportedHost[] {
    const hosts = new Map<string, ReportedHost>()
    const at = (host: string): ReportedHost => {
      const existing = hosts.get(host)
      if (existing !== undefined) return existing
      const fresh: ReportedHost = { host: boundedText(host, REPORT_URL_BYTES), pending: 0, failed: 0, blocked: 0, maxAgeMs: 0 }
      hosts.set(host, fresh)
      return fresh
    }
    for (const request of this.pending.values()) {
      const host = hostOf(request.url)
      if (host === '') continue
      const entry = at(host)
      entry.pending++
      entry.maxAgeMs = Math.max(entry.maxAgeMs, now - request.startedAt)
    }
    for (const [host, failed] of this.failedByHost) at(host).failed = failed
    for (const [host, blocked] of this.blockedByHost) at(host).blocked = blocked
    return [...hosts.values()]
      .sort((left, right) => right.pending - left.pending
        || right.failed - left.failed
        || right.blocked - left.blocked
        || left.host.localeCompare(right.host))
      .slice(0, REPORT_LISTED)
  }

  /**
   * Where the main frame ended up, when that is not where the request pointed.
   *
   * A render that succeeds needs this as much as one that times out: a
   * screenshot of a sign-in page is a correct render of the wrong page, and
   * nothing in the pixels says which of the two it is.
   * @returns the landing URL, cut to {@link TIMEOUT_URL_CHARS}, or undefined when the frame stayed where it was sent.
   */
  landedElsewhere(): string | undefined {
    const document = this.document
    if (document === undefined || sameUrl(document.url, this.requestedUrl)) return undefined
    return truncateUrl(document.url)
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
    if (phase === 'navigating') return `${this.mainDocumentPhrase()}${this.redirectHint()}, ${pendingPhrase([...this.pending.values()])}`
    return `page loaded${this.landingPhrase()}, timed out ${AFTER_LOAD_WAIT[phase]}${this.redirectHint()}`
  }

  /**
   * What the main frame had answered by the deadline.
   * @returns the clause naming the status and, when it is not where the request pointed, where it landed.
   */
  private mainDocumentPhrase(): string {
    const document = this.document
    if (document === undefined) return 'no response from the main document yet'
    const status = document.status >= MIN_HTTP_STATUS ? String(document.status) : 'with no HTTP status'
    return `main document ${status}${this.landingPhrase()}, load event not fired`
  }

  /**
   * Where the main frame ended, printed after whichever phrase names the render's state.
   * @returns ` at <url>`, or nothing when the frame stayed where it was sent.
   */
  private landingPhrase(): string {
    const elsewhere = this.landedElsewhere()
    return elsewhere === undefined ? '' : ` at ${elsewhere}`
  }

  /**
   * What to do about a render the site sent somewhere else, which is the only
   * thing in this line the caller can act on rather than only report.
   * @returns the {@link REDIRECT_HINT} clause, or nothing when the frame stayed put or the URL takes no session.
   */
  private redirectHint(): string {
    if (!this.sessionScheme || this.landedElsewhere() === undefined) return ''
    return `, ${REDIRECT_HINT}`
  }
}

/** What a render produces: the pixels, and the CSS-pixel size they are at. */
export interface Capture {
  /** The encoded PNG. */
  png: Buffer
  /** Its width in CSS pixels, which is the width the request asked for. */
  width: number
  /** Its height in CSS pixels: the viewport, or the document a `fullPage` render measured. */
  height: number
}

/**
 * Take a capture of whatever the render's window shows right now.
 *
 * A renderer offers one as soon as it owns a window, and the service calls it
 * only at a deadline the request asked to be answered with pixels — before the
 * abort, because the abort destroys the window this reads from.
 * @returns the capture; rejects when the window cannot produce one.
 */
export type CaptureNow = () => Promise<Capture>

/**
 * Lend the service a capture it can take before the render is torn down.
 *
 * Calling it is what a request's `onTimeout: 'capture'` can be honoured
 * through; a renderer that never calls it leaves every deadline answering 504.
 * @param capture - takes a capture of the window as it stands.
 */
export type OfferCapture = (capture: CaptureNow) => void

/**
 * Turns one accepted request into a capture.
 *
 * The service enforces the deadline and aborts `signal` when it passes; an
 * implementation holding an operating-system resource — a window — must
 * release it on that signal, because nothing else will.
 * @param request - the accepted, fully resolved request.
 * @param signal - aborted when the request's deadline passes or the service closes.
 * @param trace - the record this render feeds, which is what a 504 for it says and what every answer carries.
 * @param offerCapture - called with a capture the service may take while the render is still alive.
 * @returns the capture.
 */
export type Renderer = (request: RenderRequest, signal: AbortSignal, trace: RenderTrace, offerCapture: OfferCapture) => Promise<Capture>

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
 * Thrown when an accepted request passes its deadline and answered no pixels;
 * the only thing that answers 504. Its message is the whole 504 body, so it is
 * built from the request's own {@link RenderTrace} rather than from the
 * deadline alone.
 */
class RenderTimeout extends Error {
  /** The record the answer carries on {@link REPORT_HEADER}. */
  readonly report: RenderReport

  /**
   * @param message - the whole 504 body.
   * @param report - the render's report, taken before the abort.
   */
  constructor(message: string, report: RenderReport) {
    super(message)
    this.name = 'RenderTimeout'
    this.report = report
  }
}

/**
 * Thrown when the renderer refused to produce an image; what answers 500 with a
 * report beside the Chromium error the body carries.
 */
class RenderFailure extends Error {
  /** The record the answer carries on {@link REPORT_HEADER}. */
  readonly report: RenderReport

  /**
   * @param message - the renderer's own message, which the 500 body quotes.
   * @param report - the render's report.
   */
  constructor(message: string, report: RenderReport) {
    super(message)
    this.name = 'RenderFailure'
    this.report = report
  }
}

/** What one render answers with: its pixels, where the page turned out to be, and what it did. */
interface Rendered {
  png: Buffer
  /** The main frame's landing, when the render ended somewhere other than the requested URL. */
  landedUrl?: string
  /** The record this answer carries on {@link REPORT_HEADER}. */
  report: RenderReport
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
  timeoutMs?: unknown
  onTimeout?: unknown
  blockHosts?: unknown
  headers?: unknown
  cookies?: unknown
}

/** One validated block list, or the reason it is not one. `undefined` is a list the request did not send. */
type BlockResolution = { ok: true; patterns: string[] | undefined } | Rejection

/** One validated extra map, or the reason it is not one. `undefined` is a map the request did not send. */
type MapResolution = { ok: true; map: Record<string, string> | undefined } | Rejection

/** What the extra maps of one request have spent of their shared bounds so far. */
interface ExtraBudget {
  fields: number
  bytes: number
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
 * Validate one string→string map from the body against the shared extra bounds.
 *
 * An empty object resolves to `undefined`: a request that sent `{}` asked for
 * nothing, and the renderer is told about headers and cookies only when there
 * are some. Names and values are checked against their own grammars rather
 * than merely for being strings, because both end up in a request this service
 * makes on the caller's behalf — a newline in a header value would append a
 * header nobody sent.
 * @param value - the field as the body carried it.
 * @param field - `headers` or `cookies`, named in every refusal.
 * @param valuePattern - the grammar values of this field must match.
 * @param limits - the bounds to enforce.
 * @param budget - the shared count and byte total, advanced by this call.
 * @returns the validated map, undefined for an absent or empty one, or the refusal.
 */
function extraFields(
  value: unknown,
  field: 'headers' | 'cookies',
  valuePattern: RegExp,
  limits: RenderLimits,
  budget: ExtraBudget,
): MapResolution {
  if (value === undefined) return { ok: true, map: undefined }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, status: 400, message: `${field} must be a JSON object of string values` }
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length === 0) return { ok: true, map: undefined }
  const map: Record<string, string> = {}
  for (const [name, item] of entries) {
    budget.fields++
    if (budget.fields > limits.maxExtraFields) {
      return { ok: false, status: 400, message: `a request may carry at most ${String(limits.maxExtraFields)} headers and cookies together` }
    }
    if (!TOKEN.test(name)) {
      return { ok: false, status: 400, message: `${field} name ${JSON.stringify(name)} is not a valid token` }
    }
    // Cookies set through the `cookies` field reach every request the page
    // makes; one smuggled through `headers` would reach only the navigation,
    // which looks like a session that half worked.
    if (field === 'headers' && name.toLowerCase() === 'cookie') {
      return { ok: false, status: 400, message: 'send cookies in the cookies field, which applies them to the whole render, not as a cookie header' }
    }
    if (typeof item !== 'string') {
      return { ok: false, status: 400, message: `${field}.${name} must be a string` }
    }
    if (!valuePattern.test(item)) {
      return { ok: false, status: 400, message: `${field}.${name} carries a character its grammar does not allow` }
    }
    budget.bytes += Buffer.byteLength(name, 'utf8') + Buffer.byteLength(item, 'utf8')
    if (budget.bytes > limits.maxExtraBytes) {
      return { ok: false, status: 400, message: `the headers and cookies of one request may be at most ${String(limits.maxExtraBytes)} bytes together` }
    }
    map[name] = item
  }
  return { ok: true, map }
}

/**
 * Validate the hosts a request wants cancelled.
 *
 * The page's own host is refused rather than ignored: a request that blocks
 * what it asked to render is a mistake the caller can only see if it is told,
 * and cancelling the navigation would produce a load failure that says nothing
 * about why.
 * @param value - the field as the body carried it.
 * @param url - the page being rendered, whose host may not be blocked.
 * @returns the lowercased patterns, undefined for an absent or empty list, or the refusal.
 */
function blockHostPatterns(value: unknown, url: string): BlockResolution {
  if (value === undefined) return { ok: true, patterns: undefined }
  if (!Array.isArray(value)) return { ok: false, status: 400, message: 'blockHosts must be an array of host patterns' }
  if (value.length === 0) return { ok: true, patterns: undefined }
  if (value.length > MAX_BLOCK_HOSTS) {
    return { ok: false, status: 400, message: `blockHosts may name at most ${String(MAX_BLOCK_HOSTS)} host patterns` }
  }
  const host = hostOf(url)
  const patterns: string[] = []
  for (const [index, entry] of (value as unknown[]).entries()) {
    if (typeof entry !== 'string') {
      return { ok: false, status: 400, message: `blockHosts[${String(index)}] must be a string` }
    }
    if (entry.length > MAX_BLOCK_HOST_CHARS) {
      return { ok: false, status: 400, message: `blockHosts[${String(index)}] is longer than ${String(MAX_BLOCK_HOST_CHARS)} characters` }
    }
    const pattern = entry.toLowerCase()
    if (!BLOCK_HOST.test(pattern)) {
      return { ok: false, status: 400, message: `blockHosts pattern ${JSON.stringify(entry)} must be a host or *.suffix` }
    }
    if (host !== '' && blockedByPattern([pattern], url)) {
      return {
        ok: false,
        status: 400,
        message: `blockHosts pattern ${JSON.stringify(entry)} matches ${host}, the host of the page being rendered`,
      }
    }
    patterns.push(pattern)
  }
  return { ok: true, patterns }
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
  // Refused rather than clamped down to the ceiling: a caller that asked for
  // three minutes and silently got two would arm its own abort on the number it
  // sent, and give up before the answer it paid for arrived. The bounds are on
  // what a request may ask for; a deployment that configures a shorter default
  // than the floor is describing its own machine and is not checked against it.
  const asked = body.timeoutMs
  if (asked !== undefined && (typeof asked !== 'number' || !Number.isInteger(asked) || asked < MIN_TIMEOUT_MS || asked > limits.maxTimeoutMs)) {
    return { ok: false, status: 400, message: `timeoutMs must be an integer between ${String(MIN_TIMEOUT_MS)} and ${String(limits.maxTimeoutMs)}` }
  }
  const timeoutMs = asked ?? limits.timeoutMs
  // Only an absent field takes the default, here and for `timeoutMs` and
  // `blockHosts`: these three decide how long the caller waits and what it gets
  // back, so a null where a value was meant is worth a refusal it can read.
  const onTimeout = body.onTimeout === undefined ? 'fail' : body.onTimeout
  if (onTimeout !== 'fail' && onTimeout !== 'capture') {
    return { ok: false, status: 400, message: 'onTimeout must be "fail" or "capture"' }
  }
  const blockHosts = blockHostPatterns(body.blockHosts, body.url)
  if (!blockHosts.ok) return blockHosts
  const budget: ExtraBudget = { fields: 0, bytes: 0 }
  const headers = extraFields(body.headers, 'headers', HEADER_VALUE, limits, budget)
  if (!headers.ok) return headers
  const cookies = extraFields(body.cookies, 'cookies', COOKIE_VALUE, limits, budget)
  if (!cookies.ok) return cookies
  if ((headers.map !== undefined || cookies.map !== undefined) && !SESSION_SCHEMES.has(scheme)) {
    return { ok: false, status: 422, message: `headers and cookies apply to an http or https request; ${scheme} carries neither` }
  }
  return {
    ok: true,
    request: {
      url: body.url,
      width,
      height,
      fullPage,
      delayMs,
      timeoutMs,
      onTimeout,
      ...blockHosts.patterns === undefined ? {} : { blockHosts: blockHosts.patterns },
      ...headers.map === undefined ? {} : { headers: headers.map },
      ...cookies.map === undefined ? {} : { cookies: cookies.map },
    },
  }
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
 * The report header of one answer, or nothing for an answer no render was
 * started for.
 * @param report - the render's report, when there was a render.
 * @returns the header to spread into `writeHead`.
 */
function reportHeader(report: RenderReport | undefined): Record<string, string> {
  return report === undefined ? {} : { [REPORT_HEADER]: headerSafeText(JSON.stringify(report)) }
}

/**
 * Answer with a status and one line of plain text. Every failure this service
 * reports is one sentence, because its caller is a tool that puts it in a
 * message, not a page that formats it.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param message - the single line explaining it.
 * @param report - the render's report, for the two failures a render reached: the 500 and the 504.
 */
function fail(response: ServerResponse, status: number, message: string, report?: RenderReport): void {
  if (response.headersSent) {
    response.end()
    return
  }
  const body = Buffer.from(`${message}\n`, 'utf8')
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(body.byteLength),
    'cache-control': 'no-store',
    ...reportHeader(report),
  })
  response.end(body)
}

/**
 * Answer with the encoded image.
 * @param response - the response to write.
 * @param rendered - the PNG bytes, what the render did, and where the main frame ended when that is not where it was sent.
 */
function sendPng(response: ServerResponse, rendered: Rendered): void {
  response.writeHead(200, {
    'content-type': 'image/png',
    'content-length': String(rendered.png.byteLength),
    'cache-control': 'no-store',
    ...rendered.landedUrl === undefined ? {} : { [LANDED_URL_HEADER]: headerSafeText(rendered.landedUrl) },
    ...reportHeader(rendered.report),
  })
  response.end(rendered.png)
}

/**
 * Take the capture a timed-out render answers with, or nothing.
 *
 * Capped and swallowing every failure, because this runs after the deadline has
 * already passed: a render that cannot produce pixels in
 * {@link RenderLimits.captureOnTimeoutMs} is one whose caller is owed the 504
 * it would otherwise be waiting even longer for.
 * @param capture - what the renderer offered, or undefined when it offered none.
 * @param capMs - how long the capture may take.
 * @returns the capture, or undefined when there was none, it failed, or it ran past the cap.
 */
async function captureAtDeadline(capture: CaptureNow | undefined, capMs: number): Promise<Capture | undefined> {
  if (capture === undefined) return undefined
  let timer: NodeJS.Timeout | undefined
  const capped = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => { resolve(undefined) }, capMs)
  })
  try {
    return await Promise.race([capture().catch(() => undefined), capped])
  } finally {
    clearTimeout(timer)
  }
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

  const runQueued = async (request: RenderRequest): Promise<Rendered> => {
    const controller = new AbortController()
    const trace = new RenderTrace(request.url)
    let capture: CaptureNow | undefined
    // Resolves when this request stops holding the chain, whatever its renderer
    // goes on doing.
    let release = (): void => {}
    const abandoned = new Promise<void>((resolve) => { release = resolve })
    controller.signal.addEventListener('abort', () => { release() }, { once: true })
    const job = tail.then(() => {
      // No window for a request whose deadline passed before the chain reached
      // it. Deadlines are armed at admission and the chain advances no later
      // than the head request's own, so this does not fire under that ordering;
      // what it rules out is a whole render whose result the deadline has
      // already discarded. The trace is still `queued`, which is what its line
      // says.
      if (controller.signal.aborted) {
        throw new RenderTimeout(trace.describeTimeout(request.timeoutMs), trace.report('timeout', request.timeoutMs))
      }
      return renderer(request, controller.signal, trace, (offered) => { capture = offered })
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
    const completed = job.then(
      (produced): Rendered => {
        // Read after the render rather than during it: `did-navigate` fires for
        // every redirect the main frame follows, so the landing is only settled
        // once the load is done.
        const landedUrl = trace.landedElsewhere()
        return {
          png: produced.png,
          ...landedUrl === undefined ? {} : { landedUrl },
          report: { ...trace.report('complete', request.timeoutMs), capture: { partial: false, width: produced.width, height: produced.height } },
        }
      },
      (error: unknown) => {
        if (error instanceof RenderTimeout) throw error
        throw new RenderFailure(error instanceof Error ? error.message : String(error), trace.report('failed', request.timeoutMs))
      },
    )
    /**
     * What a passed deadline answers with.
     *
     * The report is taken first, before anything else runs: the abort destroys
     * the render's window and its session then reports every request that was
     * still in flight as failed, emptying the very list this exists to name.
     * The chain is released next, so a capture that hangs holds nothing but its
     * own window — the queue moves on while it runs, exactly as it does for an
     * abandoned renderer. The abort comes last, because it is what takes the
     * window the capture reads from.
     * @returns the partial capture; throws {@link RenderTimeout} when there is none.
     */
    const atDeadline = async (): Promise<Rendered> => {
      const message = trace.describeTimeout(request.timeoutMs)
      const report = trace.report('timeout', request.timeoutMs)
      release()
      const partial = request.onTimeout === 'capture' ? await captureAtDeadline(capture, limits.captureOnTimeoutMs) : undefined
      controller.abort()
      if (partial === undefined) throw new RenderTimeout(message, report)
      const landedUrl = trace.landedElsewhere()
      return {
        png: partial.png,
        ...landedUrl === undefined ? {} : { landedUrl },
        report: { ...report, capture: { partial: true, width: partial.width, height: partial.height } },
      }
    }
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<Rendered>((resolve, reject) => {
      timer = setTimeout(() => { void atDeadline().then(resolve, reject) }, request.timeoutMs)
    })
    try {
      return await Promise.race([completed, deadline])
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
        fail(response, 504, error.message, error.report)
        return
      }
      if (error instanceof RenderFailure) {
        fail(response, 500, `render failed: ${error.message}`, error.report)
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
