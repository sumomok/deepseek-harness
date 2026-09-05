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

/**
 * Exact route a browser seat posts one element's exported pixels to.
 *
 * A route of its own because the bytes are of another order than any listing:
 * the report route's byte bound is computed from the deployment's character
 * budget, and carrying an image through it would raise the bound on every
 * text read as well.
 */
export const CONTENT_IMAGE_ROUTE = '/content-frame/image'

/** Wire name of the structural page read. */
export const CONTENT_READ_TOOL_NAME = 'content_read'

/** Wire name of the read that prints one subtree's markup as the page wrote it. */
export const CONTENT_READ_DOM_TOOL_NAME = 'content_read_dom'

/** Wire name of the read that prints one element's attributes. */
export const CONTENT_READ_ATTRS_TOOL_NAME = 'content_read_attrs'

/** Wire name of the read that prints one element's whole text. */
export const CONTENT_READ_DOM_CONTENT_TOOL_NAME = 'content_read_dom_content'

/** Wire name of the read that answers with one element's own rendered pixels. */
export const CONTENT_READ_IMAGE_TOOL_NAME = 'content_read_image'

/**
 * How long a claim from a tab that is not the session's preferred one waits for
 * the preferred tab to claim first. A protocol constant: it bounds one race
 * between browsers, and no deployment reads a page faster or slower for it.
 */
export const PREFERRED_TAB_WINDOW_MS = 250

/**
 * How long a seat waits before re-claiming a call the host does not know yet.
 * The tool logs its `tool/call` before its body registers the wait, so the
 * first claim of a fresh call legitimately arrives too early.
 */
export const CLAIM_RETRY_MS = 200

/**
 * How many times {@link CLAIM_RETRY_MS} a seat's re-claiming interval grows to
 * while the host still does not know the call.
 *
 * A call the host has not opened yet is not a call arriving late by
 * milliseconds: `content_act` is asked about before its body runs, and the
 * answer is a person's, taken in seconds or minutes. So the interval doubles up
 * to this multiple and stays there — a first bid within one interval for the
 * ordinary case where the log simply beat the body, and one bid a second
 * afterwards for as long as the call is still waiting on somebody.
 */
export const MAX_CLAIM_BACKOFF = 5

/**
 * How long a seat goes on bidding for one call before it lets go, in
 * milliseconds.
 *
 * The bidding is bounded by the call still being on the session's pending list,
 * and that list is a fold over the log: a host that stopped mid-write leaves a
 * call opened and never settled, and a seat with no ceiling would bid at one a
 * second for as long as the tab stayed open. Ten minutes is well past any
 * approval a person is going to answer — a request left that long is one nobody
 * came back to — and well short of a session left open overnight. Past it the
 * seat stops for good on that call id; a host cold-loading the session is what
 * finally closes it, as the unknown outcome its repair writes.
 *
 * It is therefore also the longest approval this channel supports. A call is
 * answered `unknown` for as long as the user is deciding — the wait opens only
 * once they have — so an approval answered later than this reaches a seat that
 * has already let go, and the model is told no console is open with the console
 * in front of the user: the failure this ceiling's own bidding was written to
 * end. Ten minutes is chosen against a person reading one request; a deployment
 * where someone else approves on their behalf would have to raise it.
 */
export const MAX_BID_MS = 600000

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
 * The share of a picture read's report deadline the export itself may spend.
 *
 * Half of the quarter the two waits above leave, so the trip back keeps the
 * other half. It is a deadline rather than a budget because a browser's drawing
 * cannot be cancelled: a `toBlob` or an `image.decode()` that never settles
 * leaves a promise pending for the life of the tab, and without this the seat
 * would post nothing at all — the call would end at the host's own report
 * deadline, and the model would be told the console went quiet rather than that
 * this picture did not come out.
 */
export const EXPORT_WAIT_SHARE = 0.125

/**
 * The share of a set of steps' report deadline the steps themselves may spend.
 *
 * A share of its own rather than the read's, because what the rest pays for is
 * different: not a second wait, but the closing read of the page at the
 * deployment's own budget and the trip back with it. The host starts counting
 * the moment it grants the claim, so steps that spent the whole deadline would
 * be answered as a console that went quiet — with the steps already run, which
 * is the one ending nothing on the host's side can describe. A step that starts
 * past this point fails instead, and the report says which one and that the
 * rest never ran.
 */
export const ACT_RUN_SHARE = 0.75

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
 * open dialog's name — in characters. The reader clips
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
 * to 242 bytes, and the union of that form's keys with a failure's to 286 —
 * with both discriminants empty. The values a real report writes there,
 * `outline` and `not-a-page`, add 17 bytes that no per-field allowance covers,
 * so 303 is what the envelope has to leave room for; a bound covering both
 * forms cannot be read off either one alone. Rounded up from there, with room
 * for counters longer than nine digits.
 */
export const REPORT_SYNTAX_BYTES = 512

/**
 * Bytes of JSON the largest report carries around its listing, allowing
 * {@link MAX_TEXT_BYTES_PER_CHAR} UTF-8 bytes per character: the document's
 * address, the two header fields, the four names (two ids, the page's id and
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
 * A report of steps that ran is held to the same envelope and needs no room of
 * its own. Every report spends two of the four names on the call's id and the
 * tab's; a report of steps spends the other two on the page's id and title, and
 * adds the document's title, its own body against the budget, and one step
 * list. Against a listing it spends nothing on the address, the other header
 * field, or the cursor — 9,120 bytes of allowance left unspent.
 * What the step list costs inside that is the one failing step's message, which
 * is the same 2000 characters the failure arm's message is bounded by and which
 * a report of steps carries in place of it, plus about 35 bytes of punctuation
 * per step. {@link MAX_ACT_STEPS} is what keeps that punctuation inside the
 * unspent allowance.
 *
 * Both halves read it, the way {@link MAX_TEXT_BYTES_PER_CHAR} is read for the
 * listing: the node half adds it to the budget in bytes to size the route's
 * bound, and the seat measures the report it is about to post against that same
 * sum.
 */
export const REPORT_ENVELOPE_BYTES = MAX_TEXT_BYTES_PER_CHAR * (
  MAX_URL_CHARS + 2 * MAX_HEADER_CHARS + MAX_OUTCOME_MESSAGE_CHARS + 4 * MAX_NAME_CHARS + MAX_CURSOR_CHARS
) + REPORT_SYNTAX_BYTES

/**
 * Smallest listing budget a deployment may configure, in characters.
 *
 * The parser holds a posted listing to four times the budget, and the renderer
 * prints a listing's first row however long that row is — so without a floor a
 * small budget refuses listings a real page produces. The longest row the
 * reader prints is a table block: the table's name, cut to the reader's own
 * limit on one text run — the same 200 characters {@link MAX_HEADER_CHARS}
 * restates on this side of the wire, and not that bound applied — the rows
 * hint, and a header row and a sample row whose cells the reader cuts further,
 * to 40 and to 24 characters. That is about 322 characters plus 70 a column,
 * with a closing line of 77 where the block runs past the budget. Four times
 * this floor is 4000 characters, which holds that block for a table of 51
 * columns, and the 48 columns of the console this floor was chosen against with
 * 240 to spare — in any language, because the byte bound the route holds a
 * whole report to does not bind there: 48 columns of three-byte text is 3760
 * characters in a body of 10,550 bytes against 26,528.
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

/**
 * Cut one string to the length the wire takes, so a document with a long title
 * or address is posted rather than refused.
 *
 * A cut falling between the two halves of one character takes the leading half
 * with it: the wire refuses a lone surrogate, so a cut that left one would
 * refuse the report this cut exists to save.
 * @param value - the string, already free of what the wire refuses.
 * @param max - the wire's bound on that field, in characters.
 * @returns the string, ending in an ellipsis when it was too long.
 */
function clipTo(value: string, max: number): string {
  if (value.length <= max) return value
  const kept = value.slice(0, max - 1)
  return `${kept.isWellFormed() ? kept : kept.slice(0, -1)}…`
}

/**
 * Take one string the page supplied to what the wire carries: what a posted
 * document may not hold removed, then cut to that field's own bound.
 *
 * That order is what {@link clipTo} is written against: it looks for a
 * surrogate pair the cut split, which only means anything on a string carrying
 * no stray half of its own.
 *
 * It lives beside the bounds rather than in the seat that posts, because the
 * seat is not the only half that reads a page-supplied string: an export names
 * the element's own tag, and the refusal carrying that tag is composed where
 * the export decides it.
 * @param value - the string as the page had it.
 * @param max - the wire's bound on that field, in characters.
 * @returns the string as the seat posts it.
 */
export function forWire(value: string, max: number): string {
  return clipTo(sanitize(value), max)
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

/** What one markup read asks of the page, after the tool has validated it. */
export interface DomArgs {
  /** A ref: print that element and everything inside it. Required. */
  scope: string
  /** A ref a cut tree returned: continue after the element it names. */
  after?: string
}

/** What one read of a single element asks of the page, after the tool has validated it. */
export interface ElementArgs {
  /** A ref: the one element to read. Required. */
  ref: string
}

/**
 * Read one markup call's arguments from a decoded value.
 *
 * The two places outside the tool body that need a call before it can be
 * published read it through this — the pending projection and the seat that
 * claims it — so the arguments a browser receives are the ones the tool
 * validated, never a second reading of the same JSON.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value names no subtree.
 */
export function parseDomArgs(value: unknown): DomArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof DomArgs, unknown>>
  if (typeof candidate.scope !== 'string') return undefined
  if (candidate.after !== undefined && typeof candidate.after !== 'string') return undefined
  return {
    scope: candidate.scope,
    ...typeof candidate.after === 'string' ? { after: candidate.after } : {},
  }
}

/**
 * Read one single-element call's arguments from a decoded value, for the same
 * two readers {@link parseDomArgs} serves.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value names no element.
 */
export function parseElementArgs(value: unknown): ElementArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof ElementArgs, unknown>>
  return typeof candidate.ref === 'string' ? { ref: candidate.ref } : undefined
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
  /**
   * The entry the column had in front when this call's wait opened — which,
   * for a call that will act, is the entry the user approved the steps for.
   * The claim is where it reaches the seat because it is the first moment the
   * seat and the host speak about this call: the wait opens after the approval
   * is answered, and a person answering takes as long as a person takes.
   *
   * Absent for a refused claim, for a read, and for a call whose column had
   * nothing in front — the seat then has nothing to compare and the ordinary
   * refusals answer for the column.
   */
  page?: ReadPage
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
  /**
   * The column has another page in front than the one the call was approved
   * against, so the steps were not run. Posted by a call that would have
   * acted: a read is defined as the page in front and has nothing to compare.
   */
  | 'front-changed'

/** The page a read found, as the column names it. */
export interface ReadPage {
  /** The entry id, which for this kind is the deployment's page id. */
  id: string
  /** The page's configured title. */
  title: string
}

/**
 * What one posted read answers with: the two listings `content_read` renders,
 * the element tree `content_read_dom` prints, one element's attributes, and one
 * element's whole text.
 *
 * One document carries all five because they cross one route and one claim.
 * What differs is what a row is — an item of the page, an element of the
 * markup, one attribute, one line of text — which is why the counters below say
 * "row" rather than naming any one of them.
 */
export type ReadKind = 'outline' | 'map' | 'dom' | 'attrs' | 'content'

/** Every kind, for the parser and for a tool checking it was answered its own call. */
export const READ_KINDS: readonly ReadKind[] = ['outline', 'map', 'dom', 'attrs', 'content']

/** One structural read, as the seat posts it. */
export interface ReadSnapshot {
  /** Which listing came back. */
  kind: ReadKind
  /** The document's own URL, absolute as the browser reports it. */
  url: string
  /** The document's title. */
  title: string
  /** The name of the dialog the page has open. */
  modal?: string
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
    /**
     * Discriminant: one element's pixels, already stored.
     *
     * The one arm no seat ever constructs. What crosses the wire for an image
     * read is an {@link ImageCapture} carrying bytes, and the host turns it
     * into this arm once the attachment store has committed them — so the
     * settled call carries a durable reference and never a payload.
     */
    status: 'image'
    /** The page that was read. */
    page: ReadPage
    /** The document's own URL, absolute as the browser reported it. */
    url: string
    /** The ref the read named. */
    ref: string
    /** That element's tag, as the document spells it. */
    tag: string
    /** The element's own pixel size, before this export scaled it. */
    natural: ImageSize
    /** False when the page was still changing when the export ran. */
    settled: boolean
    /** The stored image, as the attachment store committed it. */
    image: ImageAnswer
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

/** The arm every ending that produced no listing takes, whichever tool asked. */
export type ReadFailure = Extract<ReadOutcome, { status: 'error' }>

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
  const kind = READ_KINDS.find(known => known === candidate.kind)
  if (kind === undefined) return undefined
  if (!isText(candidate.url, MAX_URL_CHARS) || !isText(candidate.title, MAX_HEADER_CHARS)) return undefined
  if (typeof candidate.truncated !== 'boolean') return undefined
  if (typeof candidate.settled !== 'boolean') return undefined
  if (!isText(candidate.text, maxTextChars)) return undefined
  if (!isCount(candidate.shown) || !isCount(candidate.total)) return undefined
  if (candidate.modal !== undefined && !isText(candidate.modal, MAX_HEADER_CHARS)) return undefined
  if (candidate.cursor !== undefined && !isText(candidate.cursor, MAX_CURSOR_CHARS)) return undefined
  const busy = parseBusy(candidate.busy)
  if (busy === undefined) return undefined
  return {
    kind,
    url: candidate.url,
    title: candidate.title,
    ...typeof candidate.modal === 'string' ? { modal: candidate.modal } : {},
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
const ERROR_CODES: readonly ReadErrorCode[] = ['empty', 'not-a-page', 'engine', 'frame', 'front-changed']

/**
 * Read one posted outcome as a listing or a failure.
 * @param candidate - the decoded `outcome`, already known to be an object.
 * @param maxTextChars - longest accepted listing.
 * @returns the outcome, or `undefined` when the value is not one.
 */
function parseOutcome(
  candidate: { status?: unknown; page?: unknown; snapshot?: unknown } & Partial<
    Record<'code' | 'message' | 'kind' | 'title', unknown>
  >,
  maxTextChars: number,
): ReadOutcome | undefined {
  if (candidate.status === 'ok') {
    const page = candidate.page as { id?: unknown; title?: unknown } | null | undefined
    if (page === null || typeof page !== 'object') return undefined
    if (!isName(page.id) || !isText(page.title, MAX_NAME_CHARS)) return undefined
    const snapshot = parseSnapshot(candidate.snapshot, maxTextChars)
    return snapshot === undefined ? undefined : { status: 'ok', page: { id: page.id, title: page.title }, snapshot }
  }
  return candidate.status === 'error' ? parseFailure(candidate) : undefined
}

/**
 * Read one posted failure, which is the arm every read of this channel shares —
 * the listing routes' and the image route's alike.
 * @param candidate - the decoded failure, already known to carry `status: 'error'`.
 * @returns the failure, or `undefined` when the value is not one.
 */
function parseFailure(
  candidate: Partial<Record<'code' | 'message' | 'kind' | 'title', unknown>>,
): ReadFailure | undefined {
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
 * The one media type an export asks a browser for.
 *
 * A protocol constant rather than a deployment choice, and PNG for three
 * reasons a deployment cannot change: the export is lossless, which is what a
 * QR code or a captcha needs; it keeps the alpha channel an icon is drawn
 * with; and it is the format `HTMLCanvasElement.toBlob` falls back to for any
 * type an engine does not support, so asking for it is the one request no
 * engine answers with something else. What the model finally receives is
 * re-encoded by the attachment layer for the route anyway, so the choice here
 * costs bytes on one same-origin post and on disk, and no fidelity.
 */
export const IMAGE_MEDIA_TYPE = 'image/png'

/**
 * Total pixels one exported image may carry.
 *
 * The provider's own request budget, restated here so the seat posts an image
 * the route can price rather than one the attachment layer will resample:
 * `DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET` in `packages/llm/llm-deepseek/src/
 * request-pricing.ts` is the same 640,000, and the geometry the seat scales by
 * is `requestImageDimensions`'. A protocol constant: a deployment raising it
 * would post bytes the request projection then throws away.
 */
export const IMAGE_PIXEL_BUDGET = 640_000

/**
 * Total pixels one export is enlarged toward and never past.
 *
 * The provider's own vision floor, restated: `MIN_PIXELS` in
 * `packages/llm/llm-deepseek/src/image-tokens.ts` is the same 384 × 384, and
 * the provider scales any image under that area up to exactly it, at its own
 * ratio, before projecting it onto the patch grid. Two images of one ratio
 * whose areas are both at or under the floor therefore land on the same grid
 * and are priced identically, whatever that ratio prices at — which is what
 * makes an enlargement inside the floor free and one past it expensive. A
 * square prices at 117 tokens at or under the floor, 201 at twice its area and
 * 349 at the whole pixel budget, against the provider's 384-token cap; another
 * ratio prices differently at each, because the price is the grid's rather
 * than the area's.
 *
 * Both kinds of source are held to this area and reach it differently. A
 * vector is rasterized to it, at whatever ratio its layout box has. A bitmap
 * is enlarged by the largest whole multiple of itself that still fits inside
 * it, which is 1 — no enlargement — for anything past a quarter of it.
 */
export const RASTER_MIN_PIXELS = 384 * 384

/**
 * Most bytes one exported image may come to.
 *
 * Above the provider's own per-image request budget —
 * `DEFAULT_REQUEST_IMAGE_MAX_BYTES` in `packages/llm/llm-deepseek/src/
 * request-pricing.ts` is 1 MiB — because what crosses this route is a lossless
 * PNG and what reaches the provider is the attachment layer's re-encoding of
 * it, which is smaller. Twice that budget is the headroom losslessness needs
 * inside a bound that still keeps one unauthenticated post finite. A protocol
 * constant: the bytes past it are bytes the model would never have seen.
 */
export const MAX_EXPORT_BYTES = 2 * 1024 * 1024

/**
 * Longest base64 payload a posted capture may carry, in characters. Base64
 * writes four characters per three bytes, and the last group is padded — which
 * is why this is computed from {@link MAX_EXPORT_BYTES} rather than estimated
 * from it.
 */
export const MAX_IMAGE_DATA_CHARS = Math.ceil(MAX_EXPORT_BYTES / 3) * 4

/**
 * Bytes of JSON one posted capture carries around its payload, allowing
 * {@link MAX_TEXT_BYTES_PER_CHAR} UTF-8 bytes per character: the document's
 * address, the four names (the call's id, the tab's, the page's id and its
 * title), the ref and the tag at the cursor's own bound, and a failure
 * message — each at the bound the wire holds it to — plus
 * {@link REPORT_SYNTAX_BYTES} for the punctuation, key names and discriminant
 * values around them. The sum is over both arms, and no capture carries all of
 * them: a failure carries no address, ref or tag.
 */
export const IMAGE_ENVELOPE_BYTES = MAX_TEXT_BYTES_PER_CHAR * (
  MAX_URL_CHARS + 4 * MAX_NAME_CHARS + 2 * MAX_CURSOR_CHARS + MAX_OUTCOME_MESSAGE_CHARS
) + REPORT_SYNTAX_BYTES

/**
 * The byte bound {@link CONTENT_IMAGE_ROUTE} holds a whole body to: one
 * payload at its own bound plus the envelope around it.
 *
 * Both halves read it — the node half as the route's bound, the seat as what
 * it measures a capture against before posting — and it is a protocol constant
 * because every term of it is. The listing routes' own bound is computed from
 * the deployment's character budget and is untouched by this.
 */
export const IMAGE_REPORT_BYTES = MAX_IMAGE_DATA_CHARS + IMAGE_ENVELOPE_BYTES

/** One image's pixel dimensions. */
export interface ImageSize {
  /** Width in pixels. */
  width: number
  /** Height in pixels. */
  height: number
}

/** Every media type a posted capture may name, which is what the attachment store takes. */
export const CAPTURE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/**
 * The media type one export came out as, read back off the exported blob
 * rather than taken from what was asked for.
 *
 * Spelled here rather than imported from the attachment vocabulary, the way
 * every other type of this module is: both halves read this file, and the seat
 * has no attachment service.
 */
export type CaptureMediaType = (typeof CAPTURE_MEDIA_TYPES)[number]

/** The stored image one settled image read carries, as the attachment store committed it. */
export interface ImageAnswer {
  /** The store's own content-addressed id. */
  attachmentId: string
  /** The media type the store verified from the stored bytes. */
  mediaType: CaptureMediaType
  /** The stored image's exact encoded length. */
  bytes: number
  /** The stored image's width in pixels. */
  width: number
  /** The stored image's height in pixels. */
  height: number
  /** The store's display name for it. */
  name?: string
}

/**
 * One element's exported pixels, as the seat posts them.
 *
 * The document that crosses {@link CONTENT_IMAGE_ROUTE}, and the asymmetry the
 * image read is built on: this carries bytes and no reference, while the arm
 * the call settles as ({@link ReadOutcome} `status: 'image'`) carries a
 * reference and no bytes. The seat never constructs that arm and the host
 * never receives one.
 */
export interface ImageCapture {
  /** Discriminant. */
  status: 'captured'
  /** The page the column had in front. */
  page: ReadPage
  /** The document's own URL, absolute as the browser reports it. */
  url: string
  /** The ref the read named. */
  ref: string
  /** That element's tag, as the document spells it. */
  tag: string
  /** The element's own pixel size, before this export scaled it. */
  natural: ImageSize
  /** False when the page was still changing when the export ran. */
  settled: boolean
  /** The media type read back off the exported blob. */
  mediaType: CaptureMediaType
  /** The exported bytes, base64. */
  data: string
}

/** What one claimed image read posts: the pixels, or why there are none. */
export type ImageReport = ImageCapture | ReadFailure

/** One claimed image read's answer as the browser half posts it. */
export interface ImageReportRequest {
  /** The call being answered. */
  readonly callId: string
  /** The claiming tab; a report from any other tab changes nothing. */
  readonly tabId: string
  /** The pixels, or the failure in their place. */
  readonly capture: ImageReport
}

/** What a base64 payload may be written with, padding included. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Whether one decoded value is canonical base64 inside a bound.
 *
 * Checked rather than trusted because the host decodes it: `Buffer.from(…,
 * 'base64')` drops what it does not recognize instead of refusing, so a
 * payload with a stray character would be stored as different bytes than the
 * seat exported and the model would be shown them.
 * @param value - the decoded value.
 * @param max - the longest accepted payload, in characters.
 * @returns whether the value is such a payload.
 */
function isBase64(value: unknown, max: number): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return false
  return value.length % 4 === 0 && BASE64.test(value)
}

/**
 * Whether one decoded value is a pixel dimension a real element can have had.
 * Zero is refused with the negatives: an export of no pixels is not an export.
 */
function isExtent(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0
}

/**
 * Read the pixel size one posted capture carries.
 * @param value - the decoded `natural`, however malformed.
 * @returns the size, or `undefined` when the value is not one.
 */
function parseSize(value: unknown): ImageSize | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as Partial<Record<keyof ImageSize, unknown>>
  if (!isExtent(candidate.width) || !isExtent(candidate.height)) return undefined
  return { width: candidate.width, height: candidate.height }
}

/**
 * Read the page one posted document names.
 * @param value - the decoded `page`, however malformed.
 * @returns the page, or `undefined` when the value is not one.
 */
function parsePage(value: unknown): ReadPage | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { id?: unknown; title?: unknown }
  if (!isName(candidate.id) || !isText(candidate.title, MAX_NAME_CHARS)) return undefined
  return { id: candidate.id, title: candidate.title }
}

/**
 * Read one posted capture.
 * @param candidate - the decoded `capture`, already known to carry `status: 'captured'`.
 * @returns the capture, or `undefined` when the value is not one.
 */
function parseCapture(candidate: Partial<Record<keyof ImageCapture, unknown>>): ImageCapture | undefined {
  const page = parsePage(candidate.page)
  const natural = parseSize(candidate.natural)
  if (page === undefined || natural === undefined) return undefined
  if (!isText(candidate.url, MAX_URL_CHARS)) return undefined
  if (typeof candidate.ref !== 'string' || !REF_PATTERN.test(candidate.ref)) return undefined
  if (!isText(candidate.tag, MAX_CURSOR_CHARS) || candidate.tag.length === 0) return undefined
  if (typeof candidate.settled !== 'boolean') return undefined
  const mediaType = CAPTURE_MEDIA_TYPES.find(known => known === candidate.mediaType)
  if (mediaType === undefined) return undefined
  if (!isBase64(candidate.data, MAX_IMAGE_DATA_CHARS)) return undefined
  return {
    status: 'captured',
    page,
    url: candidate.url,
    ref: candidate.ref,
    tag: candidate.tag,
    natural,
    settled: candidate.settled,
    mediaType,
    data: candidate.data,
  }
}

/**
 * Read one posted image report.
 *
 * A wire boundary: the document crossed a process, so its own contract is
 * checked here rather than trusted from the type. Every field carries a bound
 * of its own — the payload's is {@link MAX_IMAGE_DATA_CHARS}, which is what
 * {@link IMAGE_REPORT_BYTES} is computed from — so a forged report cannot make
 * the host buffer an arbitrary body, through the payload or around it.
 * @param body - the decoded request body, however malformed.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseImageReport(body: unknown): ImageReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; capture?: unknown }
  if (!isName(candidate.callId) || !isName(candidate.tabId)) return undefined
  const posted = candidate.capture
  if (posted === null || typeof posted !== 'object') return undefined
  const capture = posted as Partial<Record<keyof ImageCapture, unknown>> & { code?: unknown; message?: unknown }
  const parsed = parseImageOutcome(capture)
  return parsed === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, capture: parsed }
}

/**
 * Read the two arms one posted image report can carry.
 * @param capture - the decoded `capture`, already known to be an object.
 * @returns the pixels or the failure, or `undefined` when the value is neither.
 */
function parseImageOutcome(
  capture: Partial<Record<keyof ImageCapture, unknown>> & { code?: unknown; message?: unknown },
): ImageReport | undefined {
  if (capture.status === 'captured') return parseCapture(capture)
  if (capture.status === 'error') return parseFailure(capture)
  return undefined
}


/** Wire name of the page-acting tool. */
export const CONTENT_ACT_TOOL_NAME = 'content_act'

/**
 * Longest text one step types or waits for, in characters. A protocol bound,
 * not a deployment choice: it is what a person types into one field, and a
 * page that needs more than this in one box is not a page a synthetic
 * keystroke sequence should be filling.
 */
export const MAX_ACT_TEXT_CHARS = 1000

/**
 * Longest key name one `press` step may carry. The names come from the DOM's
 * own `KeyboardEvent.key` vocabulary, whose longest member is well inside this.
 */
export const MAX_ACT_KEY_CHARS = 32

/**
 * Most steps one call may run, whatever a deployment configures.
 *
 * A protocol bound rather than a deployment choice: each step costs about 35
 * bytes of punctuation in the report, and the envelope leaves 9,920 bytes of
 * a listing's allowance unspent for a report of steps ({@link
 * REPORT_ENVELOPE_BYTES} states the sum), so a hundred steps spend 3500 of it
 * and the bound holds with room to spare. A plan needing more than a hundred
 * steps in one approval is not one a user can read before approving it either.
 */
export const MAX_ACT_STEPS = 100

/** The five things one step can do. */
export type ActAction = 'click' | 'fill' | 'select' | 'press' | 'wait'

/** Every action, in the order the tool description offers them. */
export const ACT_ACTIONS: readonly ActAction[] = ['click', 'fill', 'select', 'press', 'wait']

/** How the seat answers a native dialog the page opens while a call runs. */
export type DialogAnswer = 'cancel' | 'accept'

/** Both answers, for the schema and the parser. */
export const DIALOG_ANSWERS: readonly DialogAnswer[] = ['cancel', 'accept']

/** What every step but `wait` names: which element, and what it was called when the model chose it. */
export interface ActTarget {
  /** The element's ref from a previous read. */
  readonly ref: string
  /**
   * The element's name, copied from that read. The seat checks it against the
   * page before it acts, so a page that changed since the read stops the call
   * instead of acting on whatever now holds that position.
   *
   * Empty for a row the listing printed with no name, which carries a
   * {@link ActTarget.mark} instead.
   */
  readonly label: string
  /**
   * The class tokens the listing printed for a row it named nothing, copied
   * from that read, and absent for every named row. One row has one identity:
   * a named row is checked by its name and an unnamed one by its mark, and a
   * step carrying both is refused rather than checked against whichever the
   * seat prefers.
   *
   * It is bounded by {@link MAX_ACT_TEXT_CHARS} rather than by
   * {@link MAX_NAME_CHARS}: a mark is a page's own markup, which runs longer
   * than a name and is printed whole because the seat compares it whole.
   */
  readonly mark?: string
}

/**
 * One step of one call, as the tool validated it.
 *
 * One arm per action, each carrying exactly the fields that action needs: a
 * step the seat could not run is not a value this type can hold, so neither
 * half has an absent field to answer for.
 */
export type ActStep =
  | (ActTarget & {
    /** Discriminant: press the control. */
    readonly action: 'click'
  })
  | (ActTarget & {
    /** Discriminant: replace a box's whole value. */
    readonly action: 'fill'
    /** What to type. */
    readonly text: string
  })
  | (ActTarget & {
    /** Discriminant: choose from a list. */
    readonly action: 'select'
    /** The option to choose, by its visible text. */
    readonly value: string
  })
  | (ActTarget & {
    /** Discriminant: send one key to the element. */
    readonly action: 'press'
    /** The `KeyboardEvent.key` to send. */
    readonly key: string
  })
  | {
    /** Discriminant: wait for text to appear anywhere on the page. */
    readonly action: 'wait'
    /** The text to wait for. */
    readonly text: string
  }

/** Which field of one step the seat could not use, as the sentences are keyed. */
export type ActStepRefusal =
  /** The action is not one of the five. */
  | 'action'
  /** The ref is absent or is not a ref. */
  | 'ref'
  /** The label is absent. */
  | 'label'
  /** A row the listing named nothing carries no mark to check it by. */
  | 'mark'
  /** The mark carries the listing's own punctuation rather than the tokens inside it. */
  | 'mark-printed'
  /** A named row carries a mark as well as its name. */
  | 'mark-on-named'
  /** A `fill` carries nothing to type. */
  | 'fill-text'
  /** A `wait` carries nothing to wait for. */
  | 'wait-text'
  /** A `select` names no option. */
  | 'value'
  /** A `press` names no key. */
  | 'key'
  /** The label is longer than the wire carries. */
  | 'label-length'
  /** The text is longer than the wire carries. */
  | 'text-length'
  /** The option text is longer than the wire carries. */
  | 'value-length'
  /** The key name is longer than the wire carries. */
  | 'key-length'
  /** The mark is longer than the wire carries. */
  | 'mark-length'

/** One step as it arrived, before this module has checked it. */
interface RawStep {
  /** What this step does, whatever the model sent. */
  readonly action?: unknown
  /** The element's ref. */
  readonly ref?: unknown
  /** The element's name. */
  readonly label?: unknown
  /** The class tokens the listing printed for a row it named nothing. */
  readonly mark?: unknown
  /** What `fill` types, and what `wait` waits to see. */
  readonly text?: unknown
  /** The option `select` chooses. */
  readonly value?: unknown
  /** The key `press` sends. */
  readonly key?: unknown
}

/** What reading one step ended as. */
export type ActStepRead =
  /** The step is runnable. */
  | { readonly kind: 'step'; readonly step: ActStep }
  /** It is not, and this is the field to say so about. */
  | { readonly kind: 'refusal'; readonly refusal: ActStepRefusal }

/**
 * The form every ref takes, which is also the form the refusals quote. One
 * home: the tools that validate a ref, the step reader, and the seat's own
 * numbering all mean the same string, and a second spelling would take refs one
 * of them mints and another refuses.
 */
export const REF_PATTERN = /^e\d+$/

/**
 * What a listing puts around a mark: the braces the row prints it in, and the
 * `class:` in front of the tokens. Either one in a mark means the printed row
 * was copied whole into the field.
 *
 * The cost is exact rather than a delay: an element whose own class attribute
 * holds a brace, or whose first token begins `class:`, is unactable for good.
 * The listing prints its mark, every step carrying that mark is refused here,
 * and the refusal tells the model to drop punctuation the page put there.
 * Nothing that draws a page writes such a class, and the rule catches a mistake
 * a model makes on rows it meets constantly, so the trade stands.
 */
const PRINTED_MARK = /[{}]|^class:/i

/**
 * One mark as the seat computes it: the element's class tokens joined by single
 * spaces.
 *
 * The seat compares a step's mark against that string character for character,
 * so the same tokens written with a leading space or a doubled one are the same
 * mark spelled differently. Reading them as that is what keeps the comparison a
 * literal one; without it such a step reaches the page and fails there, a round
 * trip later, saying the page changed when it did not.
 * @param mark - the mark as it arrived.
 * @returns the tokens, single-spaced, with nothing around them.
 */
function normalizedMark(mark: string): string {
  return mark.trim().replace(/\s+/g, ' ')
}

/**
 * Whether one field arrived as text the wire carries at that length.
 * @param value - the field as it arrived.
 * @param max - the longest value it takes, in characters.
 * @returns whether it is a string inside the bound.
 */
function isField(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max
}

/**
 * Read one step, or name the field that makes it unrunnable.
 *
 * The check is per action, so what comes out carries exactly the fields its own
 * action needs and neither half has an absent field to answer for. Length is
 * checked before anything else, because a field past the wire's bound is the
 * same problem whichever action carried it.
 * @param raw - the step as it arrived.
 * @returns the step, or the field to refuse it over.
 */
export function readActStep(raw: RawStep): ActStepRead {
  const refuse = (refusal: ActStepRefusal): ActStepRead => ({ kind: 'refusal', refusal })
  if (raw.label !== undefined && !isField(raw.label, MAX_NAME_CHARS)) return refuse('label-length')
  if (raw.mark !== undefined && !isField(raw.mark, MAX_ACT_TEXT_CHARS)) return refuse('mark-length')
  const mark = typeof raw.mark === 'string' ? normalizedMark(raw.mark) : undefined
  // The listing prints a mark inside `{class: ...}`, and a model that copies
  // the row rather than the tokens sends a mark that matches no element on any
  // page. Refusing it says which part of the row to copy; taking it would fail
  // the seat's check instead, one round trip later and with no remedy in it.
  if (mark !== undefined && PRINTED_MARK.test(mark)) return refuse('mark-printed')
  if (raw.text !== undefined && !isField(raw.text, MAX_ACT_TEXT_CHARS)) return refuse('text-length')
  if (raw.value !== undefined && !isField(raw.value, MAX_ACT_TEXT_CHARS)) return refuse('value-length')
  if (raw.key !== undefined && !isField(raw.key, MAX_ACT_KEY_CHARS)) return refuse('key-length')
  const action = ACT_ACTIONS.find(known => known === raw.action)
  if (action === undefined) return refuse('action')
  if (action === 'wait') {
    // Empty is refused: every page's visible text contains the empty string, so
    // the step would report itself satisfied without the page having done
    // anything.
    return typeof raw.text === 'string' && raw.text !== ''
      ? { kind: 'step', step: { action, text: raw.text } }
      : refuse('wait-text')
  }
  if (typeof raw.ref !== 'string' || !REF_PATTERN.test(raw.ref)) return refuse('ref')
  // The empty string is a label: a listing prints a row for what a page offers
  // and names nowhere. A step with no label at all is the model not having read
  // the page.
  if (typeof raw.label !== 'string') return refuse('label')
  // One row, one identity. An unnamed row is checked by the mark the listing
  // printed for it, so a step naming one carries that mark and a step naming a
  // named row carries none.
  if (raw.label === '' && (mark === undefined || mark === '')) return refuse('mark')
  if (raw.label !== '' && mark !== undefined) return refuse('mark-on-named')
  const target: ActTarget = {
    ref: raw.ref,
    label: raw.label,
    ...mark === undefined ? {} : { mark },
  }
  switch (action) {
    case 'click': return { kind: 'step', step: { ...target, action } }
    case 'fill':
      return typeof raw.text === 'string' ? { kind: 'step', step: { ...target, action, text: raw.text } } : refuse('fill-text')
    case 'select':
      return typeof raw.value === 'string' ? { kind: 'step', step: { ...target, action, value: raw.value } } : refuse('value')
    case 'press':
      return typeof raw.key === 'string' && raw.key !== ''
        ? { kind: 'step', step: { ...target, action, key: raw.key } }
        : refuse('key')
    /* v8 ignore next 2 -- `wait` returned above and the other four are handled; the arm keeps a new action loud. */
    default: return refuse('action')
  }
}

/** What one call asks of the page, after the tool has validated it. */
export interface ActArgs {
  /** The steps, in the order they run. */
  readonly steps: readonly ActStep[]
  /** How a native dialog is answered while these steps run; `cancel` by default. */
  readonly dialogs?: DialogAnswer
}

/** How one step ended. */
export type ActStepStatus =
  /** It ran. */
  | 'ok'
  /** It did not, and the call stopped here. */
  | 'failed'
  /** An earlier step failed, so this one never ran. */
  | 'skipped'

/** One step's ending, as the seat reports it. */
export type ActStepResult =
  | {
    /** Which step this is, counting from 1. */
    readonly index: number
    /** It ran, or an earlier failure meant it never did. */
    readonly status: 'ok' | 'skipped'
  }
  | {
    /** Which step this is, counting from 1. */
    readonly index: number
    /** Discriminant: it stopped the call. */
    readonly status: 'failed'
    /** Why, in the sentence the model reads to decide its next step. */
    readonly message: string
  }

/** What the seat did, as it posts it back. */
export interface ActOutcome {
  /** Discriminant, and whether every step ran. */
  readonly status: 'done' | 'failed'
  /** The page the steps ran on. */
  readonly page: ReadPage
  /** The frame document's own title after the steps, as the closing snapshot read it. */
  readonly title: string
  /** One entry per requested step, in order. */
  readonly steps: readonly ActStepResult[]
  /** The whole model-facing body: the steps, what the page did, and the page now. */
  readonly text: string
  /** True when the closing snapshot stops short of everything it would have shown. */
  readonly truncated: boolean
}

/**
 * Read one posted step result.
 * @param value - the decoded entry, however malformed.
 * @param at - the index this entry must carry, counting from 1.
 * @returns the result, or `undefined` when the value is not one.
 */
function parseStepResult(value: unknown, at: number): ActStepResult | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { index?: unknown; status?: unknown; message?: unknown }
  if (candidate.index !== at) return undefined
  if (candidate.status === 'failed') {
    // A failure with no reason is the one report the model can do nothing with,
    // so it is not a document this channel carries.
    return isText(candidate.message, MAX_OUTCOME_MESSAGE_CHARS)
      ? { index: at, status: 'failed', message: candidate.message }
      : undefined
  }
  if (candidate.status !== 'ok' && candidate.status !== 'skipped') return undefined
  return candidate.message === undefined ? { index: at, status: candidate.status } : undefined
}

/**
 * Read the step results one posted outcome carries.
 *
 * Two contracts hold here rather than being trusted from the seat that wrote
 * them. The indices are the positions of the steps the call asked for, so a
 * report naming a step the call never had describes something else. And at most
 * one step failed, because execution stops at the first failure — which, with
 * the message being the failing step's alone, is what keeps the results inside
 * the envelope's own allowance (see {@link REPORT_ENVELOPE_BYTES}).
 * @param value - the decoded `steps`, however malformed.
 * @param maxSteps - the deployment's bound on how many steps one call has.
 * @returns the results, or `undefined` when the value is not a list of them.
 */
function parseStepResults(value: unknown, maxSteps: number): ActStepResult[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxSteps) return undefined
  const results: ActStepResult[] = []
  for (const [at, entry] of value.entries()) {
    const result = parseStepResult(entry, at + 1)
    if (result === undefined) return undefined
    results.push(result)
  }
  return results.filter(result => result.status === 'failed').length > 1 ? undefined : results
}

/**
 * Read one posted act outcome.
 * @param candidate - the decoded `outcome`, already known to be an object.
 * @param maxTextChars - longest accepted body.
 * @param maxSteps - the deployment's bound on how many steps one call has.
 * @returns the outcome, or `undefined` when the value is not one.
 */
function parseActOutcome(
  candidate: Partial<Record<keyof ActOutcome, unknown>>,
  maxTextChars: number,
  maxSteps: number,
): ActOutcome | undefined {
  const page = candidate.page as { id?: unknown; title?: unknown } | null | undefined
  if (page === null || typeof page !== 'object') return undefined
  if (!isName(page.id) || !isText(page.title, MAX_NAME_CHARS)) return undefined
  if (!isText(candidate.title, MAX_HEADER_CHARS)) return undefined
  if (!isText(candidate.text, maxTextChars) || typeof candidate.truncated !== 'boolean') return undefined
  const steps = parseStepResults(candidate.steps, maxSteps)
  if (steps === undefined) return undefined
  return {
    status: candidate.status as 'done' | 'failed',
    page: { id: page.id, title: page.title },
    title: candidate.title,
    steps,
    text: candidate.text,
    truncated: candidate.truncated,
  }
}

/**
 * Read one act call's steps from a decoded value.
 *
 * The tool's own validation is the authority on what a seat can run, and it
 * runs against the deployment's own `maxSteps` and says which field of which
 * step is wrong; this reads what the two places outside that body need before
 * they can use a call at all — the pending projection that publishes it to a
 * seat, and the approval request that describes it to a user. Both take the
 * protocol's bound rather than the deployment's, because a call past the
 * deployment's is one the tool refuses before it opens the wait a seat answers.
 * @param value - the decoded arguments, however malformed.
 * @returns the arguments, or `undefined` when the value is not a runnable set.
 */
export function parseActArgs(value: unknown): ActArgs | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const candidate = value as { steps?: unknown; dialogs?: unknown }
  if (!Array.isArray(candidate.steps) || candidate.steps.length === 0) return undefined
  if (candidate.steps.length > MAX_ACT_STEPS) return undefined
  const steps: ActStep[] = []
  for (const entry of candidate.steps) {
    if (entry === null || typeof entry !== 'object') return undefined
    const read = readActStep(entry as RawStep)
    if (read.kind === 'refusal') return undefined
    steps.push(read.step)
  }
  const dialogs = DIALOG_ANSWERS.find(known => known === candidate.dialogs)
  if (candidate.dialogs !== undefined && dialogs === undefined) return undefined
  return { steps, ...dialogs === undefined ? {} : { dialogs } }
}

/** What one claimed call ends as, whichever tool opened it. */
export type ChannelOutcome = ReadOutcome | ActOutcome

/** One claimed call's answer as the browser half posts it. */
export interface ChannelReportRequest {
  /** The call being answered. */
  readonly callId: string
  /** The claiming tab; a report from any other tab changes nothing. */
  readonly tabId: string
  /** What the call ended as. */
  readonly outcome: ChannelOutcome
}

/**
 * Whether one settled call's outcome is a report of steps that ran.
 *
 * Stated as what it is: a read settles as a listing, a failure, or one stored
 * image, so naming the two step statuses is the only test that stays true as
 * the read side gains arms.
 * @param outcome - what the call settled as.
 * @returns whether it reports steps rather than anything a read answers with.
 */
export function isActOutcome(outcome: ChannelOutcome): outcome is ActOutcome {
  return outcome.status === 'done' || outcome.status === 'failed'
}

/**
 * Read one posted report of either tool.
 *
 * A wire boundary: the document crossed a process, so its own contract is
 * checked here rather than trusted from the type. Every field carries a bound
 * of its own — the listing bound is the deployment's own character budget with
 * room to spare — so a forged report cannot make the host buffer an arbitrary
 * page, through the listing or around it.
 *
 * The two tools share one route because they share one pending table and one
 * claim: what differs is the document the seat posts, discriminated by
 * `outcome.status`. A read answers `ok` or `error`; a call that ran steps
 * answers `done` or `failed`, and reaches for the same `error` arm when there
 * was no page to act on at all.
 * @param body - the decoded request body, however malformed.
 * @param maxTextChars - longest accepted listing or body.
 * @param maxSteps - the deployment's bound on how many steps one call has.
 * @returns the report, or `undefined` when the body is not one.
 */
export function parseChannelReport(
  body: unknown,
  maxTextChars: number,
  maxSteps: number,
): ChannelReportRequest | undefined {
  if (body === null || typeof body !== 'object') return undefined
  const candidate = body as { callId?: unknown; tabId?: unknown; outcome?: unknown }
  if (!isName(candidate.callId) || !isName(candidate.tabId)) return undefined
  const outcome = candidate.outcome
  if (outcome === null || typeof outcome !== 'object') return undefined
  const candidateOutcome = outcome as Partial<Record<keyof ActOutcome, unknown>>
  const parsed = candidateOutcome.status === 'done' || candidateOutcome.status === 'failed'
    ? parseActOutcome(candidateOutcome, maxTextChars, maxSteps)
    : parseOutcome(candidateOutcome, maxTextChars)
  return parsed === undefined ? undefined : { callId: candidate.callId, tabId: candidate.tabId, outcome: parsed }
}
