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
 * which are the only refusals the host cannot describe.
 *
 * Two rules hold over every string here, and
 * [the self-contained-copy Agent Note](../../../../../.agents/notes/implemented/feature/2026-09-04-self-contained-tool-copy.md)
 * owns why: a description describes its own tool or its own parameter and names
 * no other tool, and a failure states why the call was refused and nothing
 * else. A failure may name this tool's own parameter, because that is the
 * reason; it never names a tool to call instead, because which tool comes next
 * is read off the tools' own descriptions.
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
  + 'and text, each control carrying a ref like e12 that later calls can point at. It answers with the page '
  + 'as HTML and ARIA describe it. The default mode "outline" '
  + 'lists everything in a scope; when the whole page is too large it answers with the page\'s map — its '
  + 'containers with counts — and names the scope to read next. Tables report their header, size and one '
  + 'sample row: pass scope with the table\'s ref to list its rows, or find with a row\'s text to get that '
  + 'row and its buttons\' refs. A control the page names nowhere prints its class tokens as {class: ...} '
  + 'instead of a name: that is the page\'s own markup, unread — what it means is for a skill about this '
  + 'application to say. A cut listing returns a cursor; pass it as after to continue. Reads '
  + 'only the entry the content column has in front. Never returns a password box\'s '
  + 'value.'

/** The `mode` parameter line. */
export const MODE_DESCRIPTION =
  '"outline" (default) lists every item in the scope with refs; "map" lists only the page\'s containers with '
  + 'counts'

/**
 * The `scope` parameter line.
 *
 * It says what omitting the parameter does, because a model holding no ref yet
 * invents a value for it: an A/B on a real console watched the first call of
 * both arms pass `scope: ""` and `scope: "__page__"`, which the ref pattern
 * refuses.
 */
export const SCOPE_DESCRIPTION =
  'a ref from a previous read; read only that element\'s subtree — a table to list its rows, a dialog, a '
  + 'section. Omit it to read the whole page'

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
 * Refusal for a call with no owning session, which has no column to read or act
 * on. Every tool of the channel refuses it in the same words, because the
 * reason is the same one and none of them names itself.
 */
export const NO_AGENT_REFUSAL = 'This call has no owning agent session'

/** Failure for a call the agent loop cancelled while it waited. */
export const CANCELLED_REFUSAL = 'This call was cancelled'

/**
 * Failure for a column that holds nothing at all, whether the call was going to
 * read the page or act on it.
 */
export const EMPTY_COLUMN_REFUSAL = 'The content column is empty.'

/**
 * Failure for a console that answered a call with the other tool's document,
 * which no seat of this package posts.
 *
 * Both tools wait on one table and one claim, so the check belongs to whichever
 * tool opened the wait: the table hands over what was posted, and only the tool
 * knows what it asked for.
 */
export const MISREPORTED_REFUSAL = 'The console answered this call with another call\'s document.'

/** Failure for a page that is asking the user to sign in; its reading is withheld with it. */
export const SIGN_IN_REFUSAL = 'The page in the content column shows a sign-in form, which is not read.'

/** Failure the seat posts when the column's frame element or its document is out of reach. */
export const FRAME_UNREACHABLE_MESSAGE = 'The content column\'s frame could not be read from the console.'

/** Failure the seat posts when the page was still loading when the read gave up on it. */
export const FRAME_LOADING_MESSAGE =
  'The page in the content column had not finished loading when this read gave up on it.'

/** Failure the seat posts when the entry in front names a page the deployment no longer configures. */
export const FRAME_RETIRED_MESSAGE =
  'The page in front is no longer in this deployment\'s page list, so there is nothing to read.'

/**
 * Failure the seat posts when the listing's first block alone runs past what a
 * report may carry — the one block the renderer prints whatever the budget is,
 * measured both in characters and in the bytes it costs on the wire.
 *
 * The budget is named because it is the bound that was exceeded, which is the
 * whole reason the read has no answer.
 */
export const FRAME_WIDE_LISTING_MESSAGE =
  'The page\'s first block alone is wider than this deployment\'s read budget (pageAccess.outlineChars).'

/**
 * The failure for a claim window that passed with no browser in it.
 *
 * A tab that is open but not visible does not claim — the seat's scan runs
 * again when the tab comes back — so the sentence says visible rather than
 * open: a real machine spent four reads and an unhelpful `content_show` on this
 * ending while the screen was locked, with the tab in front of a locked display
 * and `document.visibilityState` `hidden`.
 *
 * The entry in front is stated where there is one, because it is the other half
 * of the reason: the column holds something and no seat answered for it. It is
 * named by its own kind word rather than as a page, because the column's key
 * domain is open and a chart can be in front as readily as a page.
 * @param claimTimeoutMs - the window that passed.
 * @param front - the entry the column has in front, when it has one.
 * @returns the model-facing sentence.
 */
export function unclaimedRefusal(claimTimeoutMs: number, front: FrontEntry | undefined): string {
  const waited = 'No open, visible console tab is showing this session\'s content column '
    + `(waited ${claimTimeoutMs / 1000}s)`
  if (front === undefined) return `${waited}.`
  return `${waited}; the ${front.kind} "${front.title}" is already in front.`
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
  + 'value for them. Nothing ran. This is a defect in the host rather than in the arguments; the host\'s log '
  + 'carries what was refused.'

/**
 * The failure for a console that claimed a read and then went quiet.
 * @param readTimeoutMs - the deadline that passed.
 * @returns the model-facing sentence.
 */
export function unansweredRefusal(readTimeoutMs: number): string {
  return `The console claimed this read but did not answer within ${readTimeoutMs / 1000}s.`
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
  return `The entry the content column has in front is not a page${named}.`
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
 * The model-facing sentence for a call the seat could not run at all.
 *
 * Every tool of the channel reaches it and every tool says it the same way: a
 * column with nothing in it, an entry that is not a page, an unreachable frame
 * and a reader that threw are the same endings whether the call was going to
 * read the page or act on it, and the reason each of them refused does not
 * change with which tool asked. A sign-in page and a column showing another
 * page than the call was approved against are two more endings only a call that
 * would have acted posts, and the seat words both, so they pass through with
 * the frame's and the reader's.
 * @param outcome - the failure the seat posted.
 * @returns the sentence to reject with.
 */
export function failureRefusal(outcome: ReadFailure): string {
  switch (outcome.code) {
    case 'empty': return EMPTY_COLUMN_REFUSAL
    case 'not-a-page': return notAPageRefusal(outcome)
    case 'engine': case 'frame': case 'sign-in': case 'front-changed': return outcome.message
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
 * What holds a model back from spending a page's whole budget here is the
 * required `scope`, which makes a prior read the only way to call it at all —
 * the description states that as its own fact rather than by comparing this
 * read to a sibling.
 */
export const CONTENT_READ_DOM_DESCRIPTION =
  'Print the page\'s own markup under one ref: every element inside it, one per line and indented by nesting, '
  + 'each with its tag, its #id, its class tokens as {class: ...}, a ref of its own, and the start of the text '
  + 'it holds directly. Nothing is interpreted — this is what the document says, verbatim. It answers what a '
  + 'row of the page is built from — the tag, the id and the class tokens — which is what a skill about this '
  + 'application reads to say what a row the page names nowhere is. scope is required, so the markup is always '
  + 'printed under one element. Every element printed keeps a ref that later calls can point at and act on. '
  + 'A long text is cut on its line and says so. A cut tree returns a cursor: pass it as after, with the '
  + 'same scope. Never prints a password box\'s value.'

/** The model-facing description of the attribute read. */
export const CONTENT_READ_ATTRS_DESCRIPTION =
  'Print every attribute of one element, name and value exactly as the page wrote them — data-*, href, type, '
  + 'style, whatever it carries — and nothing else. The ref comes from an earlier read of this page. It '
  + 'answers what identifies a row where that is written in an attribute rather than in its class tokens; '
  + 'what any of it means is for a skill about this application to say and never for this tool. '
  + 'A password box\'s value is withheld.'

/** The model-facing description of the whole-text read. */
export const CONTENT_READ_DOM_CONTENT_DESCRIPTION =
  'Print the whole visible text of one element as the page renders it: a line break wherever the page breaks '
  + 'the line, and nothing the page hides. Nothing is cut, so a long text — a paragraph, a cell, a message — '
  + 'arrives entire. The ref comes from an earlier read of this page. A text larger than one result can '
  + 'carry is refused, with its size, rather than shortened.'

/** The `scope` parameter line of the element tree. */
export const DOM_SCOPE_DESCRIPTION =
  'a ref (like e12) printed by an earlier read of this page: the element whose markup to print, and everything '
  + 'inside it'

/** The `after` parameter line of the element tree. */
export const DOM_AFTER_DESCRIPTION =
  'the cursor a cut tree returned; continues right after it — pass the same scope with it'

/** The `ref` parameter line of the two single-element reads. */
export const ELEMENT_REF_DESCRIPTION =
  'a ref (like e12) printed by an earlier read of this page: the one element to read'

/** Refusal for a `scope` that is not a ref. */
export const DOM_SCOPE_REFUSAL = 'scope must be a ref like "e12" printed by an earlier read of this page'

/** Refusal for an `after` that is not a ref. */
export const DOM_AFTER_REFUSAL = 'after must be a ref like "e12" that a cut tree returned'

/** Refusal for a `ref` that is not a ref. */
export const ELEMENT_REF_REFUSAL = 'ref must be a ref like "e12" printed by an earlier read of this page'

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
 * holds rather than all of it. The element is already named by the ref its own
 * line opens with, so the marker states the fact and nothing more.
 */
export const MORE_TEXT_MARKER = ' (text cut)'

/**
 * Failure the seat posts when one element of a tree is wider on its own than
 * a report may carry, which is the one way a budgeted, cursored listing can
 * still be too large.
 */
export const WIDE_DOM_MESSAGE =
  'One element of this subtree is wider on its own than this deployment\'s read budget '
  + '(pageAccess.outlineChars).'

/**
 * Failure the seat posts when one element's attributes run past what a report
 * may carry.
 * @param chars - how long the answer would have been.
 * @param ref - the element the read asked for.
 * @param budget - the deployment's configured listing budget.
 * @returns the model-facing sentence.
 */
export function wideAttrsMessage(chars: number, ref: string, budget: number): string {
  return `The attributes of ${ref} come to ${chars} characters, past what this deployment's report route `
    + `carries (pageAccess.outlineChars is ${budget}).`
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
    + `(pageAccess.outlineChars is ${budget}).`
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
