/**
 * Every sentence `content_read` puts in front of the model: the description it
 * chooses the tool from, the parameter lines, the refusals, and the header the
 * result opens with.
 *
 * One home for all of it, and no imports, because both halves author some of
 * it: the node half turns a settled call into text, and the browser seat
 * composes the `frame` failures, which are the only refusals the host cannot
 * describe. A failure is the only tool text the model reads while deciding what
 * to do next, so each one names the parameter or the call that fixes it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/text
 */

/**
 * The model-facing description. It names the column in the user's own words
 * because the model is told about the page in a conversation, not in English
 * schema terms, and it states the three answers a read can give — a listing, a
 * map, a cursor — so a first call already knows how to continue.
 */
export const CONTENT_READ_DESCRIPTION =
  'Read the page the user is looking at in the content column (内容区 — the column between the sidebar and '
  + 'this conversation; users also say 中间 or 右边) as a numbered structure: containers, controls, headings '
  + 'and text, each control carrying a ref like e12 that later calls can point at. The default mode "outline" '
  + 'lists everything in a scope; when the whole page is too large it answers with the page\'s map — its '
  + 'containers with counts — and names the scope to read next. Tables report their header, size and one '
  + 'sample row: pass scope with the table\'s ref to list its rows, or find with a row\'s text to get that '
  + 'row and its buttons\' refs. A cut listing returns a cursor; pass it as after to continue. Reads only the '
  + 'entry in front — call content_show first to put a page there. Never returns a password box\'s value.'

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
 * @param claimTimeoutMs - the window that passed.
 * @returns the model-facing sentence.
 */
export function unclaimedRefusal(claimTimeoutMs: number): string {
  return `No open console is showing this session's content column (waited ${claimTimeoutMs / 1000}s). `
    + 'Call content_show to put a page there, or ask the user to open the console, then retry.'
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
 * @returns the model-facing sentence.
 */
export function notAPageRefusal(entry: { kind?: string; title?: string }): string {
  const named = entry.kind === undefined || entry.title === undefined
    ? ''
    : ` (the ${entry.kind} "${entry.title}")`
  return `The entry in front is not a page${named}, which content_read cannot read; a chart drawn by `
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

/** The header fields one result line is composed from. */
export interface ReadHeaderText {
  /** The configured page title. */
  page: string
  /** The path the frame is at, origin dropped. */
  url: string
  /** The document's own title. */
  title: string
  /** The visible breadcrumb trail. */
  breadcrumb?: string
  /** The name of the dialog the page has open. */
  modal?: string
  /** Which listing came back. */
  kind: 'outline' | 'map'
  /** True when the listing stops short of everything the read would have shown. */
  truncated: boolean
  /** How many rows the listing has in full. */
  total: number
}

/**
 * The line naming the page, and the one naming its open dialog.
 *
 * The map's suffix is on the first line rather than a line of its own because
 * it qualifies the answer the model just asked for: it says this is not the
 * outline it requested and why.
 * @param header - what the read found above the items themselves.
 * @returns the leading line, plus the dialog line when one is open.
 */
export function readHeaderText(header: ReadHeaderText): string {
  const trail = header.breadcrumb === undefined ? '' : `, breadcrumb ${header.breadcrumb}`
  const outsized = header.truncated && header.kind === 'map'
    ? ` [${header.total} items — too large for one read; this is the map]`
    : ''
  const first = `Page: ${header.page} — the app is at ${header.url}, title "${header.title}"${trail}${outsized}`
  if (header.modal === undefined) return first
  return `${first}\ndialog "${header.modal}" open (modal) — the rest of the page is behind its mask`
}
