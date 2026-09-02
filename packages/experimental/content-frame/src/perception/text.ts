/**
 * Everything the perception layer puts in front of the model: the notice the
 * agent reads when the user opens a page, and the content-column context that
 * travels with every request.
 *
 * One home for all of it, and no imports beyond the types it renders, because
 * this is the whole of what a model learns about the column without calling a
 * tool. The column is named in the user's own words rather than in slot or
 * projection vocabulary — a conversation about the screen is where this text is
 * read, and the user says 内容区, never `contentSurface`.
 * @module @deepseek-ai/dsh-experimental-content-frame/perception/text
 */

/**
 * How the column is named wherever the model is told about it: the product's
 * own Chinese name, and where on the screen it is.
 *
 * Where it is, is what a model finds it by. Asked about "the table on the
 * right" with no prompt naming that phrase, a model reached this column in
 * every one of ten runs — off the position in this line and the entries the
 * context lists under it. Colloquial aliases for the direction bought nothing
 * on top of that and are not offered.
 */
const COLUMN = 'The content column (内容区 — the column between the sidebar and this conversation)'

/** What the context says when the session has produced nothing at all. */
export const EMPTY_COLUMN_CONTEXT = `${COLUMN} is empty. content_show puts a page there.`

/**
 * What one deployment spends on the content-column context, which is rebuilt
 * for every request: how many entries it lists, and how much of a name it
 * carries. Both are `content-frame` `Config` fields, validated at load.
 */
export interface ColumnContextBounds {
  /** Entries listed, newest first; past it the context says how many it did not list. */
  readonly entries: number
  /** Longest page title, address, or document title one line carries. */
  readonly fieldChars: number
}

/**
 * Cut one field to what a context line carries.
 * @param value - the title or address, of any length.
 * @param fieldChars - the deployment's field width.
 * @returns the value, ending in an ellipsis when it was too long.
 */
function clip(value: string, fieldChars: number): string {
  return value.length <= fieldChars ? value : `${value.slice(0, fieldChars - 1)}…`
}

/**
 * The sentence the agent reads when the user opens a page from the sidebar.
 * @param title - the page's configured title.
 * @returns the model-facing sentence.
 */
export function openedPageNotice(title: string): string {
  return `The user opened the page "${title}" in the content column (内容区); it is in front now.`
}

/** One live entry, as the content-column context names it. */
export interface ContextEntry {
  /** The entry's kind, as its extractor names it. */
  readonly kind: string
  /** The entry's title, as the switcher strip shows it. */
  readonly title: string
  /** Whether this is the entry in front. */
  readonly front: boolean
  /** Who put the page there; absent for every kind but `page`. */
  readonly by?: 'agent' | 'user'
  /**
   * Where the page's frame is now, when the browser has reported it moving
   * away from the page's own configured address. Absent for every other kind,
   * and for a page still sitting where it was opened.
   */
  readonly location?: { readonly url: string; readonly title: string }
}

/**
 * The parenthesis after an entry's title: which kind it is, and for a page who
 * put it there.
 *
 * Only `page` is named that way, because only `page` has a writer this package
 * knows about. Another kind's entry says what kind it is and nothing more —
 * the column's key domain is open, and guessing who drew a chart would be an
 * invention.
 * @param entry - the entry being listed.
 * @returns the parenthesized text, brackets included.
 */
function kindText(entry: ContextEntry): string {
  if (entry.by === undefined) return `(${entry.kind})`
  return `(${entry.kind}, opened by ${entry.by === 'user' ? 'the user' : 'you'})`
}

/**
 * One entry's lines: the entry itself, plus where its frame has gone.
 * @param entry - the entry being listed.
 * @returns the lines, newline-joined.
 */
function entryText(entry: ContextEntry, fieldChars: number): string {
  const front = entry.front ? '  ← in front' : ''
  const first = `- "${clip(entry.title, fieldChars)}" ${kindText(entry)}${front}`
  if (entry.location === undefined) return first
  const title = entry.location.title === '' ? '' : `, title "${clip(entry.location.title, fieldChars)}"`
  return `${first}\n    the app inside is now at ${clip(entry.location.url, fieldChars)}${title}`
}

/**
 * The rule keeping the model's own handles out of what it says to the user.
 *
 * It lives here rather than in `content_read`'s description because it governs
 * the answer rather than the call: a model choosing the tool has already read
 * the description, while the sentence it writes afterwards is composed against
 * whatever the request carried. Recorded recordings had the model quoting `e9`
 * back to a user who has no way to see one.
 */
const REF_RULE = 'Refs like e12 are your handles for content_read\'s scope and after; '
  + 'when you answer the user, name what the page shows, never a ref.'

/**
 * The whole content-column context for one request.
 * @param entries - the session's live entries, newest first.
 * @param canRead - whether this deployment offers `content_read`.
 * @param bounds - what this deployment spends on the context.
 * @returns the block, or {@link EMPTY_COLUMN_CONTEXT} when there are no entries.
 */
export function columnContextText(
  entries: readonly ContextEntry[],
  canRead: boolean,
  bounds: ColumnContextBounds,
): string {
  if (entries.length === 0) return EMPTY_COLUMN_CONTEXT
  const listed = entries.slice(0, bounds.entries).map(entry => entryText(entry, bounds.fieldChars))
  const hidden = entries.length - listed.length
  const rest = hidden === 0 ? [] : [`- … and ${hidden} older ${hidden === 1 ? 'entry' : 'entries'} not listed.`]
  const closing = canRead
    ? ['content_read reads the entry in front; content_show puts a page in front.', REF_RULE]
    : ['content_show puts a page in front.']
  return [`${COLUMN} holds, newest first:`, ...listed, ...rest, ...closing].join('\n')
}
