/**
 * The two-phase channel a `content_read` call and the browser seat holding the
 * page speak over: the route paths, the documents that cross them, and the
 * checks each side runs on what it received.
 *
 * Both halves import this module, so it holds types and pure functions only —
 * no node built-ins, no DOM, and nothing either half owns alone. The claim/
 * report split exists because the host cannot address a browser: a call
 * announces itself through the session projection, whichever seat is showing
 * that session claims it, and the same seat posts the read back. The call id is
 * the whole capability — a poster that does not know it can neither claim a
 * read nor answer one.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/wire
 */

/** Exact route a browser seat claims one pending read on. */
export const CONTENT_CLAIM_ROUTE = '/content-frame/claim'

/** Exact route a browser seat posts one read's outcome to. */
export const CONTENT_REPORT_ROUTE = '/content-frame/report'

/** Wire name of the structural page read. */
export const CONTENT_READ_TOOL_NAME = 'content_read'

/**
 * How long a claim from a tab that is not the session's preferred one waits for
 * the preferred tab to claim first. A protocol constant: it bounds one race
 * between browsers, and no deployment reads a page faster or slower for it.
 */
export const PREFERRED_TAB_WINDOW_MS = 250

/**
 * How long a seat waits before re-claiming a read the host does not know yet.
 * The tool logs its `tool/call` before its body registers the wait, so the
 * first claim of a fresh call legitimately arrives too early.
 */
export const CLAIM_RETRY_MS = 200

/**
 * The share of the report deadline a seat may spend waiting for a frame that is
 * still loading.
 *
 * The host's own report deadline starts the moment it grants the claim, while
 * the seat's wait starts after the claim round trip has come back. Spending the
 * whole deadline on the load would leave the walk and the trip back no room at
 * all: the host would answer "the console did not answer" before the seat had
 * even begun to read, and the message about a page that never finished loading
 * could never reach the model.
 */
export const LOAD_WAIT_SHARE = 0.5

/**
 * The share of the report deadline a seat may spend waiting for a page that has
 * loaded to stop changing.
 *
 * A second share of the same deadline, and the reason there are two: a whole
 * document load and an application drawing its next route are different waits,
 * and one read can need both one after the other. Together they leave the walk
 * and the trip back a quarter of the deadline, which is what keeps the "still
 * changing" sentence reachable at all — a wait that spent the deadline would be
 * answered by the host as a console that went quiet instead.
 */
export const SETTLE_WAIT_SHARE = 0.25

/**
 * How many busy elements one listing header names. A page marking a dozen
 * regions `aria-busy` is a page that is loading, and naming the first few says
 * so at a cost the header can carry.
 */
export const MAX_BUSY_NAMES = 3

/** Longest failure message a posted outcome may carry, in characters. */
export const MAX_OUTCOME_MESSAGE_CHARS = 2000

/**
 * Longest `url` a posted snapshot may carry, in characters. It is the
 * document's own address, which the seat cuts to this before posting.
 */
export const MAX_URL_CHARS = 2048

/**
 * Longest header field a posted snapshot may carry — the document title, the
 * breadcrumb trail, the open dialog's name — in characters. The reader clips
 * every text it prints at the same 200, so this is that clip restated where the
 * document crosses the process.
 */
export const MAX_HEADER_CHARS = 200

/**
 * Longest id, page title, or named entry a posted document may carry, in
 * characters. The ids are minted rather than read off a page — a provider's
 * call id, a tab's UUID, a configured page id — and none of them approaches
 * this.
 */
export const MAX_NAME_CHARS = 256

/** Longest cursor a posted snapshot may carry; the reader's refs are `e` and a number. */
export const MAX_CURSOR_CHARS = 32

/**
 * How many times its own render budget a posted listing may be, in characters.
 *
 * The renderer prints a listing's first row however long that row is, so the
 * parser takes a listing past the budget rather than exactly it. Both halves
 * read this: the parser as the bound past which it refuses, the seat as the
 * point where it stops posting and says so instead.
 */
export const MAX_TEXT_BUDGET_MULTIPLE = 4

/**
 * How many UTF-8 bytes of JSON one character of a posted report is allowed,
 * which is what the byte bound on a whole body is computed from.
 *
 * Both halves read this, the way {@link MAX_TEXT_BUDGET_MULTIPLE} is read for
 * characters: the node half sizes the route's bound with it, and the seat
 * measures a listing against the same allowance before posting, so a listing
 * the route would refuse for its size is one the seat says a sentence about
 * instead. In a body the seat sanitized, no UTF-16 unit costs more than this —
 * two bytes for a short escape, three for the widest character, two per unit
 * for a supplementary one.
 */
export const MAX_TEXT_BYTES_PER_CHAR = 4

/**
 * Bytes of JSON punctuation, key names and discriminant values one report is
 * written with.
 *
 * A listing report with every string empty and nine-digit counters serializes
 * to 273 bytes, and the union of that form's keys with a failure's to 317 —
 * with both discriminants empty. The values a real report writes there,
 * `outline` and `not-a-page`, add 17 bytes that no per-field allowance covers,
 * so 334 is what the envelope has to leave room for; a bound covering both
 * forms cannot be read off either one alone. Rounded up from there, with room
 * for counters longer than nine digits.
 */
export const REPORT_SYNTAX_BYTES = 512

/**
 * Bytes of JSON the largest report carries around its listing, allowing
 * {@link MAX_TEXT_BYTES_PER_CHAR} UTF-8 bytes per character: the document's
 * address, the three header fields, the four names (two ids, the page's id and
 * its title, or a failure's kind and title), the cursor, and a failure message
 * — each at the bound the wire holds it to — plus {@link REPORT_SYNTAX_BYTES}
 * for the punctuation, key names and discriminant values around them.
 *
 * The sum is over both arms' fields, and no report carries all of them: a
 * listing carries no failure message, and a failure carries no address, header
 * or cursor. That slack is what covers the {@link MAX_BUSY_NAMES} busy names a
 * listing may carry, which are held to {@link MAX_NAME_CHARS} each and cost at
 * most 768 characters against the 2000 a listing never spends on a message.
 *
 * Both halves read it, the way {@link MAX_TEXT_BYTES_PER_CHAR} is read for the
 * listing: the node half adds it to the budget in bytes to size the route's
 * bound, and the seat measures the report it is about to post against that same
 * sum.
 */
export const REPORT_ENVELOPE_BYTES = MAX_TEXT_BYTES_PER_CHAR * (
  MAX_URL_CHARS + 3 * MAX_HEADER_CHARS + MAX_OUTCOME_MESSAGE_CHARS + 4 * MAX_NAME_CHARS + MAX_CURSOR_CHARS
) + REPORT_SYNTAX_BYTES

/**
 * Smallest listing budget a deployment may configure, in characters.
 *
 * The parser holds a posted listing to four times the budget, and the renderer
 * prints a listing's first row however long that row is — so without a floor a
 * small budget refuses listings a real page produces. The longest row the
 * reader prints is a table block: the table's name and the pagination line,
 * each cut to the reader's own limit on one text run — the same 200 characters
 * {@link MAX_HEADER_CHARS} restates on this side of the wire, and not that
 * bound applied — the rows hint, and a header row and a sample row whose cells
 * the reader cuts further, to 40 and to 24 characters. That is about 535
 * characters plus 70 a column, with a closing line of 77 where the block runs
 * past the budget. Four times this floor is 4000 characters, which holds that
 * block for a table of 48 columns — in any language, because the byte bound
 * the route holds a whole report to does not bind there: 48 columns of
 * three-byte text is 3973 characters in a body of 11,175 bytes against 27,328.
 *
 * All three cuts are the reader's own, recorded with the rules they belong to
 * in .agents/notes/implemented/feature/2026-09-02-content-snapshot-engine.md;
 * a change to the text run's limit, to the header cell's or to the sample
 * cell's moves the column count this floor is chosen for.
 */
export const MIN_OUTLINE_CHARS = 1000

/**
 * Every status the two read routes answer a document they will not take with:
 * the shape refusal, the same-site and content-type fences, the method gate,
 * and the byte bound.
 *
 * A seat that collects one of these has been told about the document it sent,
 * and posting that same document again would reach the same check. Every other
 * non-2xx answer came from something between the seat and the route — a proxy
 * refreshing a token, a rate limiter, a gateway — and says nothing about the
 * document, so it is worth another try.
 */
export const ROUTE_REFUSAL_STATUSES: readonly number[] = [400, 403, 405, 413, 415]

/**
 * The code points a posted string may not carry: the C0 controls other than
 * tab, newline and carriage return, and DEL.
 *
 * `JSON.stringify` writes each of the C0 controls named here as a six-byte
 * `\uXXXX` escape, and a surrogate half standing alone the same way, while the
 * byte bound a report is held to allows {@link MAX_TEXT_BYTES_PER_CHAR} per
 * character — so a listing rendered inside the budget could still be refused
 * for its size. DEL costs one byte and is dropped for the reason that covers
 * all of them anyway: none of this is text a model transcript has any use for.
 * What the model needs from a page printing raw log bytes is the text around
 * them.
 */
const UNPRINTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/

/**
 * Whether one string carries only what a posted document may.
 *
 * Read by the parser on every field of a document that crossed the process, and
 * by the node half at load on the one configured string a seat posts unchanged.
 * @param value - the string, of any length.
 * @returns whether it is well-formed UTF-16 and free of {@link UNPRINTABLE}.
 */
export function isPrintable(value: string): boolean {
  return value.isWellFormed() && !UNPRINTABLE.test(value)
}

/**
 * Drop from one page-supplied string what {@link UNPRINTABLE} and a lone
 * surrogate name, so the seat posts a listing the parser takes rather than one
 * the route refuses.
 *
 * Tab, newline and carriage return stay: `JSON.stringify` writes them as
 * two-byte escapes, which the byte bound covers, and the listing the reader
 * renders is built out of newlines.
 * @param value - the string as the page had it.
 * @returns that same string when it carries none of them, and one without them
 * otherwise.
 */
export function sanitize(value: string): string {
  if (isPrintable(value)) return value
  let kept = ''
  // Walked by code point rather than by unit, so a surrogate pair is tested
  // whole and only a half standing alone is dropped.
  for (const point of value) {
    if (isPrintable(point)) kept += point
  }
  return kept
}

/** What one read asks of the page, after the tool has validated it. */
export interface ReadArgs {
  /** Which listing the read wants; the tool's own default applies when absent. */
  mode?: 'outline' | 'map'
  /** A ref: read that element's subtree only. */
  scope?: string
  /** A ref a cut listing returned: continue after the item it names. */
  after?: string
  /** Case-insensitive text filter. */
  find?: string
}

/** One seat's bid to answer one pending read. */
export interface ClaimRequest {
  /** The pending call the seat is bidding for. */
  callId: string
  /** The bidding tab's own id, minted once per page load. */
  tabId: string
}

/** Why a claim did not win, for a seat deciding whether to try again. */
export type ClaimRefusal =
  /** The host does not know this call yet; the seat retries shortly. */
  | 'unknown'
  /** Another tab is answering it. */
  | 'taken'
  /** The call already ended — reported, timed out, or cancelled. */
  | 'settled'

/** What {@link CONTENT_CLAIM_ROUTE} answers a well-formed claim with. */
export interface ClaimAck {
  /** Whether this tab now owns the read; only the owner's report is taken. */
  claimed: boolean
  /** Present exactly when `claimed` is false. */
  reason?: ClaimRefusal
}

/** Why a claimed read produced no page instead of a listing. */
export type ReadErrorCode =
  /** The session's content column holds nothing at all. */
  | 'empty'
  /** The entry in front belongs to another kind, which this tool cannot read. */
  | 'not-a-page'
  /** The reader refused the request — a stale ref, or a combination it does not serve. */
  | 'engine'
  /** The frame's document could not be reached or did not finish loading. */
  | 'frame'

/** The page a read found, as the column names it. */
export interface ReadPage {
  /** The entry id, which for this kind is the deployment's page id. */
  id: string
  /** The page's configured title. */
  title: string
}

/** One structural read, as the seat posts it. */
export interface ReadSnapshot {
  /** Which listing came back. */
  kind: 'outline' | 'map'
  /** The document's own URL, absolute as the browser reports it. */
  url: string
  /** The document's title. */
  title: string
  /** The visible breadcrumb trail. */
  breadcrumb?: string
  /** The name of the dialog the page has open. */
  modal?: string
  /** True when the page is asking the user to sign in. */
  signIn: boolean
  /** The rendered listing. */
  text: string
  /** True when the listing stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the listing renders. */
  shown: number
  /** How many rows the listing has in full. */
  total: number
  /** The ref to pass back as `after`; present only on a listing cut short. */
  cursor?: string
  /** False when the page was still changing when the seat stopped waiting for it. */
  settled: boolean
  /**
   * Names of the visible elements the page marks `aria-busy` at read time, at
   * most {@link MAX_BUSY_NAMES}; absent when the page marks none.
   */
  busy?: string[]
}

/** What one claimed read ended as. */
export type ReadOutcome =
  | {
    /** Discriminant. */
    status: 'ok'
    /** The page that was read. */
    page: ReadPage
    /** The structural read itself. */
    snapshot: ReadSnapshot
  }
  | {
    /** Discriminant. */
    status: 'error'
    /** Which of the four refusals this is. */
    code: ReadErrorCode
    /** The model-facing sentence, composed by whichever half knows the reason. */
    message: string
    /** The kind of entry in front, for `not-a-page` when the seat can name it. */
    kind?: string
    /** That entry's title, for `not-a-page` when the seat can name it. */
    title?: string
  }

/** One claimed read's answer as the browser half posts it. */
export interface ReportRequest {
  /** The call being answered. */
  callId: string
  /** The claiming tab; a report from any other tab changes nothing. */
  tabId: string
  /** What the read ended as. */
  outcome: ReadOutcome
}

/** What {@link CONTENT_REPORT_ROUTE} answers a well-formed report with. */
export interface ReportAck {
  /**
   * Whether a waiting call took this report. `false` means the pair names no
   * claimed call — a late answer, a second report, or a tab that never claimed
   * it — and nothing changed.
   */
  accepted: boolean
}

/**
 * Whether one decoded value is a string inside a bound and made of what a
 * posted document may carry.
 *
 * The length bound alone does not hold the byte bound the route computes from
 * it: the C0 controls {@link UNPRINTABLE} names, and a surrogate half standing
 * alone, cost six JSON bytes per UTF-16 unit where that computation allows
 * {@link MAX_TEXT_BYTES_PER_CHAR} per character. DEL costs one byte and is
 * refused with them for the reason {@link UNPRINTABLE} states. A string
 * carrying any of them is refused as a shape rather than for its size, because
 * the seat removes them before posting and a document that still has them is
 * not one this package's browser half wrote.
 * @param value - the decoded value.
 * @param max - the longest accepted length, in characters.
 * @returns whether the value is such a string no longer than the bound.
 */
function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && isPrintable(value)
}

/** Whether one decoded value is a non-empty name inside {@link MAX_NAME_CHARS}. */
function isName(value: unknown): value is string {
  return isText(value, MAX_NAME_CHARS) && value.length > 0
}

/**
 * Whether one decoded value is a row count a listing can have had. Negative is
 * refused rather than carried: the counters are printed to the model, and a
 * forged `-1` would tell it the page has fewer than no items.
 */
function isCount(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0
}

/**
 * Read one posted claim. A wire boundary: the document crossed a process, so
 * its own contract is checked here rather than trusted from the type.
 * @param body - the decoded request body, however malformed.
 * @returns the claim, or `undefined` when the body is not one.
 */
export function parseClaimRequest(body: unknown): ClaimRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown }
  if (!isName(candidate.callId) || !isName(candidate.tabId)) return undefined
  return { callId: candidate.callId, tabId: candidate.tabId }
}

/**
 * Read one posted snapshot. Every field a page supplied carries a length bound
 * of its own, because the byte bound the route holds a whole report to is
 * computed from those lengths.
 * @param value - the decoded `outcome.snapshot`, however malformed.
 * @param maxTextChars - longest accepted listing.
 * @returns the snapshot, or `undefined` when the value is not one.
 */
function parseSnapshot(value: unknown, maxTextChars: number): ReadSnapshot | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof ReadSnapshot, unknown>>
  if (candidate.kind !== 'outline' && candidate.kind !== 'map') return undefined
  if (!isText(candidate.url, MAX_URL_CHARS) || !isText(candidate.title, MAX_HEADER_CHARS)) return undefined
  if (typeof candidate.signIn !== 'boolean' || typeof candidate.truncated !== 'boolean') return undefined
  if (typeof candidate.settled !== 'boolean') return undefined
  if (!isText(candidate.text, maxTextChars)) return undefined
  if (!isCount(candidate.shown) || !isCount(candidate.total)) return undefined
  for (const optional of [candidate.breadcrumb, candidate.modal]) {
    if (optional !== undefined && !isText(optional, MAX_HEADER_CHARS)) return undefined
  }
  if (candidate.cursor !== undefined && !isText(candidate.cursor, MAX_CURSOR_CHARS)) return undefined
  const busy = parseBusy(candidate.busy)
  if (busy === undefined) return undefined
  return {
    kind: candidate.kind,
    url: candidate.url,
    title: candidate.title,
    ...typeof candidate.breadcrumb === 'string' ? { breadcrumb: candidate.breadcrumb } : {},
    ...typeof candidate.modal === 'string' ? { modal: candidate.modal } : {},
    signIn: candidate.signIn,
    text: candidate.text,
    truncated: candidate.truncated,
    shown: candidate.shown,
    total: candidate.total,
    ...typeof candidate.cursor === 'string' ? { cursor: candidate.cursor } : {},
    settled: candidate.settled,
    ...busy.length === 0 ? {} : { busy },
  }
}

/**
 * Read the busy names one posted snapshot carries.
 *
 * The names come off a page, so each carries the same length and printability
 * bound every other page-supplied name does, and the list carries a count
 * bound of its own: the envelope the route sizes its byte bound from allows
 * {@link MAX_BUSY_NAMES} of them.
 * @param value - the decoded `busy` field, however malformed.
 * @returns the names, empty when the field was absent, or `undefined` when the
 * value is not a list of them.
 */
function parseBusy(value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_BUSY_NAMES) return undefined
  return value.every(name => isText(name, MAX_NAME_CHARS)) ? value : undefined
}

/** Every code a posted failure may name. */
const ERROR_CODES: readonly ReadErrorCode[] = ['empty', 'not-a-page', 'engine', 'frame']

/**
 * Read one posted outcome.
 * @param value - the decoded `outcome`, however malformed.
 * @param maxTextChars - longest accepted listing.
 * @returns the outcome, or `undefined` when the value is not one.
 */
function parseOutcome(value: unknown, maxTextChars: number): ReadOutcome | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { status?: unknown; page?: unknown; snapshot?: unknown } & Partial<
    Record<'code' | 'message' | 'kind' | 'title', unknown>
  >
  if (candidate.status === 'ok') {
    const page = candidate.page as { id?: unknown; title?: unknown } | null | undefined
    if (page === null || typeof page !== 'object') return undefined
    if (!isName(page.id) || !isText(page.title, MAX_NAME_CHARS)) return undefined
    const snapshot = parseSnapshot(candidate.snapshot, maxTextChars)
    return snapshot === undefined ? undefined : { status: 'ok', page: { id: page.id, title: page.title }, snapshot }
  }
  if (candidate.status !== 'error') return undefined
  const code = ERROR_CODES.find(known => known === candidate.code)
  if (code === undefined) return undefined
  if (!isText(candidate.message, MAX_OUTCOME_MESSAGE_CHARS)) return undefined
  for (const optional of [candidate.kind, candidate.title]) {
    if (optional !== undefined && !isText(optional, MAX_NAME_CHARS)) return undefined
  }
  return {
    status: 'error',
    code,
    message: candidate.message,
    ...typeof candidate.kind === 'string' ? { kind: candidate.kind } : {},
    ...typeof candidate.title === 'string' ? { title: candidate.title } : {},
  }
}

/**
 * Read one posted report. A wire boundary: the document crossed a process, so
 * its own contract is checked here rather than trusted from the type. The
 * listing bound is the deployment's own character budget with room to spare,
 * and every other field carries a bound of its own, so a forged body cannot
 * make the host buffer an arbitrary page — through the listing or around it.
 * @param body - the decoded request body, however malformed.
 * @param maxTextChars - longest accepted listing.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseReportRequest(body: unknown, maxTextChars: number): ReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; outcome?: unknown }
  if (!isName(candidate.callId) || !isName(candidate.tabId)) return undefined
  const outcome = parseOutcome(candidate.outcome, maxTextChars)
  return outcome === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, outcome }
}
