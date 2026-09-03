/**
 * Every sentence the four reading tools put in front of the model: the
 * descriptions they are chosen from, the parameter lines, the refusals, and the
 * headers their results open with — plus the endings every tool of the channel
 * shares, since a column with nothing in it refuses a read and a set of steps
 * alike.
 *
 * One home for all of it, and nothing imported beyond the wire's own
 * vocabulary, because both halves author some of it: the node half turns a
 * settled call into text, and the browser seat composes the `frame` failures,
 * which are the only refusals the host cannot describe. A failure is the only
 * tool text the model reads while deciding what to do next, so each one names
 * the parameter or the call that fixes it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/text
 */

import { CONTENT_READ_TOOL_NAME, type ReadFailure } from './wire.ts'

/**
 * The model-facing description. It names the column in the user's own words
 * because the model is told about the page in a conversation, not in English
 * schema terms, and it states the three answers a read can give — a listing, a
 * map, a cursor — so a first call already knows how to continue.
 *
 * It also says which of the four reads this is. `content_read` is the page as
 * HTML and ARIA describe it and is the read to start from; the three markup
 * reads are the page as it was written, and a model that has not been told the
 * difference reaches for whichever name it saw last.
 */
export const CONTENT_READ_DESCRIPTION =
  'Read the page the user is looking at in the content column (内容区 — the column between the sidebar and '
  + 'this conversation) as a numbered structure: containers, controls, headings '
  + 'and text, each control carrying a ref like e12 that later calls can point at. This is the read to start '
  + 'from: it is the page as HTML and ARIA describe it, and it costs a fraction of the page\'s own markup. '
  + 'The default mode "outline" '
  + 'lists everything in a scope; when the whole page is too large it answers with the page\'s map — its '
  + 'containers with counts — and names the scope to read next. Tables report their header, size and one '
  + 'sample row: pass scope with the table\'s ref to list its rows, or find with a row\'s text to get that '
  + 'row and its buttons\' refs. A control the page names nowhere prints its class tokens as {class: ...} '
  + 'instead of a name: that is the page\'s own markup, unread — what it means is for a skill about this '
  + 'application to say, and where the tokens are not enough content_read_dom prints that row\'s markup and '
  + 'content_read_attrs its attributes. A cut listing returns a cursor; pass it as after to continue. Reads '
  + 'only the entry in front — call content_show first to put a page there. Never returns a password box\'s '
  + 'value.'

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

/**
 * Refusal for a call with no owning session, which has no column to read.
 *
 * The four reading tools spell it in their own names: the model is deciding
 * what to do next about the tool it just called, and a sentence naming another
 * one sends it to the wrong place.
 * @param tool - the tool that was called.
 * @returns the model-facing sentence.
 */
export function noAgentRefusal(tool: string): string {
  return `${tool} requires an owning agent session`
}

/**
 * Failure for a call the agent loop cancelled while it waited, named the same
 * way and for the same reason.
 * @param tool - the tool that was called.
 * @returns the model-facing sentence.
 */
export function cancelledRefusal(tool: string): string {
  return `${tool} was cancelled`
}

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
 * What the model is told when the host folded one of its calls into the
 * session's open calls and then refused its own value for them.
 *
 * The two readings of a call — the tool's own parser and the projection's
 * schemas — are meant to be one, and a call that passes the first and fails the
 * second is a defect here rather than anything the model wrote. The validator's
 * own issue list says `unrecognized_keys` about a field the tool documents,
 * which reads as an argument to change and is not one; what the model can act
 * on is that nothing ran and the call can be sent again.
 */
export const UNPUBLISHABLE_CALL_REFUSAL =
  'The console channel could not publish this call: the host accepted the arguments and then refused its own '
  + 'value for them. Nothing ran. This is a defect in the host rather than in the arguments — send the call '
  + 'again, and tell the user if it repeats; the host\'s log carries what was refused.'

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

/**
 * How one reading tool names itself in the two endings whose wording is the
 * caller's. All four say the same thing about an empty column — there is
 * nothing to read, whichever read was asked for — and each names itself in the
 * other.
 * @param tool - the tool that was called.
 * @returns that tool's voice.
 */
export function readVoice(tool: string): ToolVoice {
  return { emptyColumn: EMPTY_COLUMN_REFUSAL, cannot: `${tool} cannot read` }
}

/** How `content_read` names itself in the two endings whose wording is the caller's. */
export const READ_VOICE: ToolVoice = readVoice(CONTENT_READ_TOOL_NAME)

/**
 * The model-facing sentence for a call the seat could not run at all.
 *
 * Both tools reach it: a column with nothing in it, an entry that is not a
 * page, an unreachable frame and a reader that threw are the same four endings
 * whether the call was going to read the page or act on it. Two of the four
 * name the tool the model should reach for next, so those two are the caller's
 * to word; the frame's own message and the reader's are neither tool's. A
 * sign-in page and a column showing another page than the call was approved
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

/**
 * The model-facing description of the element tree.
 *
 * It refuses the one mistake this tool invites: a model that has just been
 * offered a way to see the page's real markup will reach for it first, and a
 * whole page of markup is an order of magnitude larger than the listing it
 * would have got. So the description says outright that this is not the read to
 * start with, and `scope` is required, which makes a prior read the only way to
 * call it at all.
 */
export const CONTENT_READ_DOM_DESCRIPTION =
  'Print the page\'s own markup under one ref: every element inside it, one per line and indented by nesting, '
  + 'each with its tag, its #id, its class tokens as {class: ...}, a ref of its own, and the start of the text '
  + 'it holds directly. Nothing is interpreted — this is what the document says, verbatim. Do not use it as the '
  + 'ordinary way to read a page: content_read is that, it costs a fraction as much, and scope is required '
  + 'here, so a ref has to come from a read first. Reach for this one when content_read printed a row it could '
  + 'name nothing, or printed nothing where the user can see something, and a skill about this application '
  + 'needs the tokens or the tag to say what that row is. Every element printed keeps a ref content_act can act '
  + 'on and the other reads can point at. A long text is cut on its line and says so; content_read_dom_content '
  + 'prints one element\'s whole text and content_read_attrs prints its attributes. A cut tree returns a '
  + 'cursor: pass it as after, with the same scope. Never prints a password box\'s value.'

/** The model-facing description of the attribute read. */
export const CONTENT_READ_ATTRS_DESCRIPTION =
  'Print every attribute of one element, name and value exactly as the page wrote them — data-*, href, type, '
  + 'style, whatever it carries — and nothing else. The ref comes from a previous content_read or '
  + 'content_read_dom. Reach for it when a row\'s class tokens do not say enough and what identifies the row is '
  + 'written in an attribute; what any of it means is for a skill about this application to say and never for '
  + 'this tool. A password box\'s value is withheld.'

/** The model-facing description of the whole-text read. */
export const CONTENT_READ_DOM_CONTENT_DESCRIPTION =
  'Print the whole visible text of one element as the page renders it: a line break wherever the page breaks '
  + 'the line, and nothing the page hides. Nothing is cut. The ref comes from a previous content_read or '
  + 'content_read_dom — reach for it when a listing or a tree line cut a text short and the rest of it is what '
  + 'you need. A text larger than one result can carry is refused, with its size, rather than shortened.'

/** The `scope` parameter line of the element tree. */
export const DOM_SCOPE_DESCRIPTION =
  'a ref from a previous content_read or content_read_dom: the element whose markup to print, and everything '
  + 'inside it'

/** The `after` parameter line of the element tree. */
export const DOM_AFTER_DESCRIPTION =
  'the cursor a cut tree returned; continues right after it — pass the same scope with it'

/** The `ref` parameter line of the two single-element reads. */
export const ELEMENT_REF_DESCRIPTION =
  'a ref from a previous content_read or content_read_dom: the one element to read'

/** Refusal for a `scope` that is not a ref. */
export const DOM_SCOPE_REFUSAL = 'scope must be a ref like "e12" from a previous content_read or content_read_dom'

/** Refusal for an `after` that is not a ref. */
export const DOM_AFTER_REFUSAL = 'after must be a ref like "e12" that a cut content_read_dom returned'

/** Refusal for a `ref` that is not a ref. */
export const ELEMENT_REF_REFUSAL = 'ref must be a ref like "e12" from a previous content_read or content_read_dom'

/** What the attribute read prints for an element the page wrote no attribute on. */
export const NO_ATTRIBUTES_LINE = '(this element carries no attributes)'

/** What the whole-text read prints for an element that shows no text at all. */
export const NO_TEXT_LINE = '(this element shows no text)'

/**
 * What every read prints in place of what a password control holds: the
 * attribute read for its `value`, and the tree and whole-text reads for the
 * text a `textarea` keeps its value in.
 *
 * The token names the credential rather than the withholding, because a read
 * that only said it was hidden would read as a statement about the page's own
 * styling, next to the two lines that report exactly that.
 */
export const WITHHELD = '(password withheld)'

/**
 * How one tree line says the text it printed is the start of what the element
 * holds rather than all of it, and which call prints the rest.
 *
 * The ref is named in the marker because the line the model is reading names
 * several elements' refs by the time it reaches this one, and the remedy is
 * useless if it has to be guessed at.
 * @param ref - the element whose text was cut.
 * @returns the marker, led by one space.
 */
export function moreTextMarker(ref: string): string {
  return ` (text cut — content_read_dom_content with ref "${ref}" prints all of it)`
}

/**
 * Failure the seat posts when one element of a tree is wider on its own than
 * a report may carry, which is the one way a budgeted, cursored listing can
 * still be too large.
 */
export const WIDE_DOM_MESSAGE =
  'One element of this subtree is wider on its own than this deployment\'s read budget. Call content_read_dom '
  + 'with scope and a ref further down the tree, or ask the user to raise pageAccess.outlineChars.'

/**
 * Failure the seat posts when one element's attributes run past what a report
 * may carry.
 *
 * There is no narrower read of one element's attributes — the tool answers all
 * of them or none — so the only remedy is the deployment's, and the message
 * says so instead of offering the model a call that cannot help.
 * @param chars - how long the answer would have been.
 * @param ref - the element the read asked for.
 * @param budget - the deployment's configured listing budget.
 * @returns the model-facing sentence.
 */
export function wideAttrsMessage(chars: number, ref: string, budget: number): string {
  return `The attributes of ${ref} come to ${chars} characters, past what this deployment's report route `
    + `carries (pageAccess.outlineChars is ${budget}). One element's attributes have no narrower read: ask the `
    + 'user to raise pageAccess.outlineChars.'
}

/**
 * Failure the seat posts when one element's text runs past what a report may
 * carry. The text is refused whole rather than cut, because a tool that
 * promises the whole text and quietly returns part of it is worse than one that
 * says it cannot.
 * @param chars - how long the text is.
 * @param ref - the element the read asked for.
 * @param budget - the deployment's configured listing budget.
 * @returns the model-facing sentence.
 */
export function wideTextMessage(chars: number, ref: string, budget: number): string {
  return `The text of ${ref} comes to ${chars} characters, past what this deployment's report route carries `
    + `(pageAccess.outlineChars is ${budget}). Call content_read_dom with scope "${ref}" to find a smaller `
    + 'element to read, or ask the user to raise pageAccess.outlineChars.'
}

/** The header fields one markup result opens with. */
export interface MarkupHeaderText {
  /** The configured page title. */
  page: string
  /** The path the frame is at, origin dropped. */
  url: string
  /** False when the page was still changing when the read ran. */
  settled: boolean
}

/**
 * The line naming the page a markup read ran on, and the one qualification such
 * a read can carry.
 *
 * Shorter than the listing's own header by the three facts a markup read does
 * not answer: what the document calls itself, what dialog it has open, and what
 * it marks as still loading are questions about the page, and `content_read` is
 * the read that answers them.
 * @param header - what the read found above the markup itself.
 * @returns the leading line, plus the still-changing line where it applies.
 */
export function markupHeaderText(header: MarkupHeaderText): string {
  return [
    `Page: ${header.page} — the app is at ${header.url}`,
    ...header.settled ? [] : [STILL_CHANGING_LINE],
  ].join('\n')
}
