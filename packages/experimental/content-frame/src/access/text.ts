/**
 * Every sentence `content_read` puts in front of the model: the description it
 * chooses the tool from, the parameter lines, the refusals, and the header the
 * result opens with — plus the endings both tools of the channel share, since a
 * column with nothing in it refuses a read and a set of steps alike.
 *
 * One home for all of it, and no imports beyond the wire's own types, because
 * both halves author some of it: the node half turns a settled call into text,
 * and the browser seat composes the `frame` failures, which are the only
 * refusals the host cannot describe. A failure is the only tool text the model reads while deciding what
 * to do next, so each one names the parameter or the call that fixes it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/text
 */

import type { ReadFailure } from './wire.ts'

/**
 * The model-facing description. It names the column in the user's own words
 * because the model is told about the page in a conversation, not in English
 * schema terms, and it states the three answers a read can give — a listing, a
 * map, a cursor — so a first call already knows how to continue.
 */
export const CONTENT_READ_DESCRIPTION =
  'Read the page the user is looking at in the content column (内容区 — the column between the sidebar and '
  + 'this conversation) as a numbered structure: containers, controls, headings '
  + 'and text, each control carrying a ref like e12 that later calls can point at. The default mode "outline" '
  + 'lists everything in a scope; when the whole page is too large it answers with the page\'s map — its '
  + 'containers with counts — and names the scope to read next. Tables report their header, size and one '
  + 'sample row: pass scope with the table\'s ref to list its rows, or find with a row\'s text to get that '
  + 'row and its buttons\' refs. A control the page names nowhere prints its class tokens as {{class: ...}} '
  + 'instead of a name: that is the page\'s own markup, unread — what it means is for a skill about this '
  + 'application to say. A cut listing returns a cursor; pass it as after to continue. Reads only the entry in '
  + 'front — call content_show first to put a page there. Never returns a password box\'s value.'

/** The `mode` parameter line. */
export const MODE_DESCRIPTION =
  '"outline" (default) lists every item in the scope with refs; "map" lists only the page\'s containers with '
  + 'counts — read it first on an unfamiliar page'

/** The `scope` parameter line. */
export const SCOPE_DESCRIPTION =
  'a ref from a previous read; read only that element\'s subtree — a table to list its rows, a dialog, a section'

/** The `after` parameter line. */
export const AFTER_DESCRIPTION = 'the cursor a cut listing returned; continues right after it'

/** The `find` parameter line. */
export const FIND_DESCRIPTION =
  'case-insensitive text filter: a flat list of items whose name or text contains it, table rows included'

/** The entry the column has in front, as the refusal above names it. */
export interface FrontEntry {
  /** The entry's own id, which is what a later comparison is against. */
  readonly entryId: string
  /** The entry's kind, as its extractor names it. */
  readonly kind: string
  /** The entry's title, as the switcher strip shows it. */
  readonly title: string
}

/** Refusal for a `scope` that is not a ref. */
export const SCOPE_REFUSAL = 'scope must be a ref like "e12" from a previous read'

/** Refusal for an `after` that is not a ref. */
export const AFTER_REFUSAL = 'after must be a ref like "e12" from a previous read'

/** Refusal for a `find` outside the accepted length. */
export const FIND_REFUSAL = 'find must be 1–200 characters'

/** Refusal for a call with no owning session, which has no column to read. */
export const NO_AGENT_REFUSAL = 'content_read requires an owning agent session'

/** Failure for a call the agent loop cancelled while it waited. */
export const CANCELLED_REFUSAL = 'content_read was cancelled'

/** Failure for a column that holds nothing at all. */
export const EMPTY_COLUMN_REFUSAL = 'The content column is empty. Call content_show to put a page there, then retry.'

/**
 * Failure for a console that answered a call with the other tool's document,
 * which no seat of this package posts.
 *
 * Both tools wait on one table and one claim, so the check belongs to whichever
 * tool opened the wait: the table hands over what was posted, and only the tool
 * knows what it asked for.
 */
export const MISREPORTED_REFUSAL =
  'The console answered this call with something else; call content_read to see where the page is now.'

/** Failure for a page that is asking the user to sign in; the listing is withheld with it. */
export const SIGN_IN_REFUSAL = 'The page shows a sign-in form; ask the user to sign in, then retry.'

/** Failure the seat posts when the column's frame element or its document is out of reach. */
export const FRAME_UNREACHABLE_MESSAGE =
  'The content column\'s frame could not be read from the console; ask the user to reload the console, then retry.'

/** Failure the seat posts when the page was still loading when the read gave up on it. */
export const FRAME_LOADING_MESSAGE = 'The page in the content column had not finished loading; retry once.'

/** Failure the seat posts when the entry in front names a page the deployment no longer configures. */
export const FRAME_RETIRED_MESSAGE =
  'The page in front is no longer in this deployment\'s page list, so there is nothing to read. '
  + 'Call content_show to put a page in front.'

/**
 * Failure the seat posts when the listing's first block alone runs past what a
 * report may carry — the one block the renderer prints whatever the budget is,
 * measured both in characters and in the bytes it costs on the wire.
 *
 * `find` is named first because this failure most often ends a page's first
 * read, where the model holds no ref for `scope` to point at; `scope` carries
 * that condition with it. The budget comes last because raising it is the
 * deployment's to do, while the first two are the model's.
 */
export const FRAME_WIDE_LISTING_MESSAGE =
  'The page\'s first block alone is wider than this deployment\'s read budget. '
  + 'Call content_read with find, or with scope and a ref from a previous read, '
  + 'to read a smaller part of the page, or ask the user to raise pageAccess.outlineChars.'

/**
 * The failure for a claim window that passed with no browser in it.
 *
 * What the model should do next depends on what the column already holds, and
 * getting that wrong costs a real conversation: a session whose column was
 * already showing a page was told to call `content_show`, which appends
 * another `content/shown` and answers `Now showing …` without a console being
 * any more open than before — and a recorded run spent ten calls and eighty
 * seconds in that loop before asking the user anything. So a column with
 * something in front says the one thing that can end it, and says outright
 * that the tool the model would otherwise reach for cannot.
 *
 * The entry is named by its own kind word rather than as a page, because the
 * column's key domain is open and a chart in front is as unhelped by
 * `content_show` as a page is.
 * @param claimTimeoutMs - the window that passed.
 * @param front - the entry the column has in front, when it has one.
 * @returns the model-facing sentence.
 */
export function unclaimedRefusal(claimTimeoutMs: number, front: FrontEntry | undefined): string {
  const waited = `No open console is showing this session's content column (waited ${claimTimeoutMs / 1000}s)`
  if (front === undefined) {
    return `${waited}. Call content_show to put a page there, or ask the user to open the console, then retry.`
  }
  return `${waited}; the ${front.kind} "${front.title}" is already in front. `
    + 'Ask the user whether they have the console open on this session, then retry. '
    + 'content_show cannot help here.'
}

/**
 * The failure for a console that claimed a read and then went quiet.
 * @param readTimeoutMs - the deadline that passed.
 * @returns the model-facing sentence.
 */
export function unansweredRefusal(readTimeoutMs: number): string {
  return `The console claimed this read but did not answer within ${readTimeoutMs / 1000}s; `
    + 'retry once, and if it repeats ask the user to reload the console.'
}

/**
 * The failure for an entry in front that belongs to another content kind.
 * @param entry - the entry's kind and title, when the seat could name them.
 * @param cannot - what the calling tool cannot do to it, as {@link ToolVoice} carries it.
 * @returns the model-facing sentence.
 */
export function notAPageRefusal(entry: { kind?: string; title?: string }, cannot: string): string {
  const named = entry.kind === undefined || entry.title === undefined
    ? ''
    : ` (the ${entry.kind} "${entry.title}")`
  return `The entry in front is not a page${named}, which ${cannot}; a chart drawn by `
    + 'show_chart keeps its data in that call\'s arguments. Call content_show to put a page in front.'
}

/**
 * The failure for a request the reader itself refused.
 * @param message - the reader's own message, passed through unchanged.
 * @returns the model-facing sentence.
 */
export function engineRefusal(message: string): string {
  return `${message} Call content_read without scope or after for fresh refs.`
}

/**
 * The line a listing carries when the page never stopped changing.
 *
 * It states the fact and the one thing that follows from it. The listing under
 * this line is a real read — it is what the page held at that instant — and
 * reading again is what turns it into a listing of the page as the user has it.
 */
export const STILL_CHANGING_LINE =
  'The page was still changing when this read ran; read again for the settled page.'

/**
 * The line naming what the page says it is still loading.
 * @param busy - the names the seat read off the page's own `aria-busy` marks.
 * @returns the model-facing line.
 */
export function stillLoadingLine(busy: readonly string[]): string {
  return `The page marks these as still loading: ${busy.map(name => `"${name}"`).join(', ')}`
}

/**
 * The two sentences one tool speaks in its own name when a call could not run.
 *
 * The endings are shared and the wording is not: a model told that the entry in
 * front is something `content_read cannot read` has been told about the wrong
 * call when what it asked for was steps, and it is the tool it was told about
 * that it will reach for next.
 */
export interface ToolVoice {
  /** What this tool tells the model to do about a column with nothing in it. */
  readonly emptyColumn: string
  /** What this tool cannot do to an entry of another kind: `content_read cannot read`. */
  readonly cannot: string
}

/** How `content_read` names itself in the two endings whose wording is the caller's. */
export const READ_VOICE: ToolVoice = {
  emptyColumn: EMPTY_COLUMN_REFUSAL,
  cannot: 'content_read cannot read',
}

/**
 * The model-facing sentence for a call the seat could not run at all.
 *
 * Both tools reach it: a column with nothing in it, an entry that is not a
 * page, an unreachable frame and a reader that threw are the same four endings
 * whether the call was going to read the page or act on it. Two of the four
 * name the tool the model should reach for next, so those two are the caller's
 * to word; the frame's own message and the reader's are neither tool's. A
 * A sign-in page and a column showing another page than the call was approved
 * against are two more endings only a call that would have acted posts, and the
 * seat words both, so they pass through with the frame's.
 * @param outcome - the failure the seat posted.
 * @param voice - the calling tool's own two sentences.
 * @returns the sentence to reject with.
 */
export function failureRefusal(outcome: ReadFailure, voice: ToolVoice): string {
  switch (outcome.code) {
    case 'empty': return voice.emptyColumn
    case 'not-a-page': return notAPageRefusal(outcome, voice.cannot)
    case 'engine': return engineRefusal(outcome.message)
    case 'frame': case 'sign-in': case 'front-changed': return outcome.message
    /* v8 ignore next 2 -- the code union is closed and the wire parser rejects every other value; the arm keeps a new member loud. */
    default: return `content-frame: unknown outcome ${JSON.stringify(outcome)}`
  }
}

/** The header fields one result line is composed from. */
export interface ReadHeaderText {
  /** The configured page title. */
  page: string
  /** The path the frame is at, origin dropped. */
  url: string
  /** The document's own title. */
  title: string
  /** The name of the dialog the page has open. */
  modal?: string
  /** Which listing came back. */
  kind: 'outline' | 'map'
  /** True when the listing stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the listing has in full. */
  total: number
  /** False when the page was still changing when the read ran. */
  settled: boolean
  /** Names of the elements the page marks as still loading; empty when it marks none. */
  busy: readonly string[]
}

/**
 * The line naming the page, and one line per qualification on what was read.
 *
 * The map's suffix is on the first line rather than a line of its own because
 * it qualifies the answer the model just asked for: it says this is not the
 * outline it requested and why. The open dialog, the busy marks and a page that
 * never settled each get a line, because each is a separate fact about the same
 * listing and any of them can be true on its own.
 * @param header - what the read found above the items themselves.
 * @returns the leading line, plus a line for each qualification that applies.
 */
export function readHeaderText(header: ReadHeaderText): string {
  const outsized = header.truncated && header.kind === 'map'
    ? ` [${header.total} items — too large for one read; this is the map]`
    : ''
  return [
    `Page: ${header.page} — the app is at ${header.url}, title "${header.title}"${outsized}`,
    ...header.modal === undefined
      ? []
      : [`dialog "${header.modal}" open (modal) — the rest of the page is behind its mask`],
    ...header.busy.length === 0 ? [] : [stillLoadingLine(header.busy)],
    ...header.settled ? [] : [STILL_CHANGING_LINE],
  ].join('\n')
}
