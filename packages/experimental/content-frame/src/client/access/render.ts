/**
 * Turning collected items into the text the model reads, under a character
 * budget that is never spent blindly: a whole page too large for the budget
 * comes back as a skeleton of its containers, and a listing too large for it
 * comes back with a cursor to continue from. Neither ever answers with half a
 * list and no way to reach the rest.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/render
 */
import { CLICKABLE_ROLE, FIELD_ROLES } from './dom.ts'
import type {
  ContainerFace, ContainerItem, ElementItem, Item, SnapshotMode, SnapshotOptions, TableItem, TableRowItem, TextItem,
} from './model.ts'

/** What separates two cells of the same row. */
const CELL_SEPARATOR = ' | '

/** What one nesting level of indentation looks like. */
const INDENT = '  '

/** The row a frame of another origin leaves behind. */
const FRAME_UNREADABLE = 'frame (not readable)'

/** How a table says its rows are available but not listed. */
const ROWS_HINT = "rows: pass scope with this table's ref to list rows, or find a row by its text"

/** One rendered row, and the ref a continuation would resume after. */
interface Entry {
  /** The row's ref, absent for a row the model cannot name. */
  readonly ref: string | undefined
  /** The row's text, which may run to several lines. */
  readonly text: string
}

/** One rendered listing, before the header is attached. */
export interface Listing {
  /** Which listing this is. */
  readonly kind: SnapshotMode
  /** The rendered body. */
  readonly text: string
  /** True when the listing stops short of everything collected. */
  readonly truncated: boolean
  /** How many items the body renders. */
  readonly shown: number
  /** How many items this read collected. */
  readonly total: number
  /** The ref to resume after, on a listing cut short by the budget. */
  readonly cursor: string | undefined
}

/**
 * The indentation one nesting depth prints.
 * @param depth - how many containers enclose the row.
 * @returns the leading spaces.
 */
function indent(depth: number): string {
  return INDENT.repeat(depth)
}

/**
 * The quoted name a row prints, omitted when there is none.
 * @param name - the accessible name.
 * @returns the name in quotes, or the empty string.
 */
function quoted(name: string): string {
  return name === '' ? '' : ` "${name}"`
}

/**
 * Which container a row sits in, printed at the end of the row so a flat
 * listing still says where each item lives.
 * @param face - the enclosing container, if any.
 * @returns the trailing container note, or the empty string.
 */
function within(face: ContainerFace | undefined): string {
  if (face === undefined) return ''
  return face.name === '' ? ` (${face.type})` : ` (in ${face.type} "${face.name}")`
}

/** How much of each kind one container holds. */
interface Counts {
  /** Fields the user fills in. */
  fields: number
  /** Buttons and other click targets. */
  buttons: number
  /** Links. */
  links: number
  /** Table data rows. */
  rows: number
  /** Runs of text, and anything else that only reads. */
  texts: number
}

/**
 * The counts a skeleton row prints, leaving out whatever the container has
 * none of.
 * @param counts - how many of each kind the container holds.
 * @returns the trailing counts, or the empty string.
 */
function countsOf(counts: Counts): string {
  const parts: string[] = []
  if (counts.fields > 0) parts.push(`${counts.fields} fields`)
  if (counts.buttons > 0) parts.push(`${counts.buttons} buttons`)
  if (counts.links > 0) parts.push(`${counts.links} links`)
  if (counts.rows > 0) parts.push(`${counts.rows} rows`)
  if (counts.texts > 0) parts.push(`${counts.texts} texts`)
  return parts.length === 0 ? '' : `${INDENT}${parts.join(', ')}`
}

/**
 * What one container directly holds, not counting what its nested containers
 * hold in turn — those carry rows and counts of their own.
 * @param container - the container to summarize.
 * @param items - every collected item.
 * @returns the trailing counts.
 */
function containerCounts(container: ContainerItem, items: readonly Item[]): string {
  const counts: Counts = { fields: 0, buttons: 0, links: 0, rows: 0, texts: 0 }
  for (const item of items) {
    if (item.container !== container) continue
    if (item.kind === 'text') counts.texts += 1
    else if (item.kind === 'element') {
      if (FIELD_ROLES.has(item.role)) counts.fields += 1
      else if (item.role === 'button' || item.role === CLICKABLE_ROLE) counts.buttons += 1
      else if (item.role === 'link') counts.links += 1
      else counts.texts += 1
    }
  }
  return countsOf(counts)
}

/**
 * One control, heading, or click target.
 * @param item - the element item.
 * @param prefix - the row's indentation.
 * @returns the rendered row.
 */
function elementLine(item: ElementItem, prefix: string): string {
  const value = item.secret ? ' = (hidden)' : item.value === undefined ? '' : ` = "${item.value}"`
  const checked = item.checked === undefined ? '' : item.checked ? ' [x]' : ' [ ]'
  const disabled = item.disabled ? ' (disabled)' : ''
  return `${prefix}${item.ref} ${item.role}${quoted(item.name)}${value}${checked}${disabled}${within(item.container)}`
}

/**
 * One run of page text.
 * @param item - the text item.
 * @param prefix - the row's indentation.
 * @returns the rendered row.
 */
function textLine(item: TextItem, prefix: string): string {
  return `${prefix}text "${item.text}"${within(item.container)}`
}

/**
 * One data row of a table.
 * @param item - the row item.
 * @param prefix - the row's indentation.
 * @param suffix - the trailing container note, which a flat listing prints and an indented one does not.
 * @returns the rendered row.
 */
function rowLine(item: TableRowItem, prefix: string, suffix: string): string {
  return `${prefix}row ${item.index}: ${item.cells.join(CELL_SEPARATOR)}${suffix}`
}

/**
 * A table's first line: what it is and how big it is.
 * @param item - the table item.
 * @returns the rendered row.
 */
function tableHead(item: TableItem): string {
  return `${indent(item.depth)}${item.ref} table${quoted(item.name)} ${item.rows.length} rows × ${item.columns} cols`
}

/**
 * A table's header line, when it has one.
 * @param item - the table item.
 * @returns the rendered line, or nothing.
 */
function tableHeader(item: TableItem): string[] {
  return item.header.length === 0 ? [] : [`${indent(item.depth + 1)}header: ${item.header.join(CELL_SEPARATOR)}`]
}

/**
 * The lines a table prints wherever its rows are not listed: its shape, one
 * sample row, and how to reach the rest.
 * @param item - the table item.
 * @returns the rendered rows.
 */
function tableBlock(item: TableItem): string {
  const inner = indent(item.depth + 1)
  const lines = [tableHead(item), ...tableHeader(item)]
  const first = item.rows[0]
  if (first !== undefined) {
    lines.push(`${inner}sample: ${first.sample.join(CELL_SEPARATOR)}`, `${inner}${ROWS_HINT}`)
  }
  if (item.pagination !== undefined) lines.push(`${inner}pagination: ${item.pagination}`)
  return lines.join('\n')
}

/**
 * One row of a page skeleton.
 * @param item - the container item.
 * @param items - every collected item.
 * @returns the rendered row.
 */
function containerMapLine(item: ContainerItem, items: readonly Item[]): string {
  const tail = item.closed ? `${INDENT}hidden` : containerCounts(item, items)
  return `${indent(item.depth)}${item.ref} ${item.type}${quoted(item.name)}${tail}`
}

/**
 * One item as an outline prints it.
 * @param item - the item to render.
 * @returns the rendered row.
 */
function outlineText(item: Item): string {
  switch (item.kind) {
    case 'container':
      return `${indent(item.depth)}${item.ref} ${item.type}${quoted(item.name)}`
    case 'element':
      return elementLine(item, indent(item.depth))
    case 'text':
      return textLine(item, indent(item.depth))
    case 'table':
      return tableBlock(item)
    case 'frame-error':
      return `${indent(item.depth)}${FRAME_UNREADABLE}`
    /* v8 ignore next 2 -- Item is a closed union and every member is handled above. */
    default:
      return ''
  }
}

/**
 * The ref a continuation resumes after, for the rows that carry one.
 * @param item - the item to name.
 * @returns the ref, or undefined for a row the model cannot name.
 */
function entryRef(item: Item): string | undefined {
  return item.kind === 'text' || item.kind === 'frame-error' ? undefined : item.ref
}

/**
 * A table the read asked for by ref: its shape, then one row per data row.
 * @param item - the table item.
 * @returns the rendered entries.
 */
function scopedTableEntries(item: TableItem): Entry[] {
  const head = [tableHead(item), ...tableHeader(item)].join('\n')
  return [
    { ref: item.ref, text: head },
    ...item.rows.map((row): Entry => ({ ref: row.ref, text: rowLine(row, indent(item.depth + 1), '') })),
  ]
}

/**
 * Every item, nested under the containers it sits in.
 * @param items - every collected item.
 * @param scope - the element the read asked for, if any.
 * @returns the rendered entries.
 */
function outlineEntries(items: readonly Item[], scope: Element | undefined): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'container' && item.closed) continue
    if (item.kind === 'table' && item.el === scope) entries.push(...scopedTableEntries(item))
    else entries.push({ ref: entryRef(item), text: outlineText(item) })
  }
  return entries
}

/**
 * The containers of the page and nothing else, each with what it holds.
 * @param items - every collected item.
 * @returns the rendered entries.
 */
function mapEntries(items: readonly Item[]): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'container') entries.push({ ref: item.ref, text: containerMapLine(item, items) })
    else if (item.kind === 'table') {
      const counts = countsOf({ fields: 0, buttons: 0, links: 0, rows: item.rows.length, texts: 0 })
      entries.push({ ref: item.ref, text: `${indent(item.depth)}${item.ref} table${quoted(item.name)}${counts}` })
    } else if (item.kind === 'frame-error') entries.push({ ref: undefined, text: `${indent(item.depth)}${FRAME_UNREADABLE}` })
  }
  return entries
}

/**
 * Every item whose name or text carries the string the read is looking for, as
 * one flat list. Table rows join this listing: matching a row by its text is
 * the one way a read reaches a single row without listing the whole table.
 * @param items - every collected item.
 * @param find - the string to look for.
 * @returns the rendered entries.
 */
function findEntries(items: readonly Item[], find: string): Entry[] {
  const needle = find.toLowerCase()
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'element') {
      if (item.name.toLowerCase().includes(needle)) entries.push({ ref: item.ref, text: elementLine(item, '') })
    } else if (item.kind === 'text') {
      if (item.text.toLowerCase().includes(needle)) entries.push({ ref: undefined, text: textLine(item, '') })
    } else if (item.kind === 'table') {
      for (const row of item.rows) {
        if (row.text.toLowerCase().includes(needle)) entries.push({ ref: row.ref, text: rowLine(row, '', within(row.table)) })
      }
    }
  }
  return entries
}

/**
 * Drop everything up to and including the entry a continuation resumes after.
 * An `after` that names nothing in this listing starts it from the top.
 * @param entries - the listing.
 * @param after - the ref to resume after, if any.
 * @returns the remaining entries.
 */
function dropBefore(entries: Entry[], after: string | undefined): Entry[] {
  if (after === undefined) return entries
  return entries.slice(entries.findIndex(entry => entry.ref === after) + 1)
}

/**
 * Fill the budget, then say how to reach the rest. A listing whose last row
 * carries a ref continues from that ref; one whose rows are all page text has
 * nothing to continue from, and says so rather than leaving the model to guess.
 * The first row is always rendered, however long it is, so a read is never
 * answered with nothing at all.
 * @param entries - the listing.
 * @param budgetChars - the character budget.
 * @returns the rendered listing.
 */
function assemble(entries: Entry[], budgetChars: number): Listing {
  const lines: string[] = []
  // The empty string reads as "no row rendered so far carries a ref".
  let cursor = ''
  let used = 0
  for (const entry of entries) {
    const cost = entry.text.length + 1
    if (lines.length > 0 && used + cost > budgetChars) break
    lines.push(entry.text)
    used += cost
    if (entry.ref !== undefined) cursor = entry.ref
  }
  const shown = lines.length
  const truncated = shown < entries.length
  const remaining = entries.length - shown
  if (truncated) {
    lines.push(cursor === ''
      ? `(cut here; ${remaining} items remain — narrow the read with find, or read a part with scope)`
      : `(cut after ${cursor} — pass after: "${cursor}" to continue; ${remaining} items remain)`)
  }
  return {
    kind: 'outline',
    text: lines.join('\n'),
    truncated,
    shown,
    total: entries.length,
    cursor: truncated && cursor !== '' ? cursor : undefined,
  }
}

/**
 * The container holding the most of the page, which is where a reader who has
 * only been shown the skeleton should look next.
 * @param items - every collected item.
 * @returns its ref, or undefined for a page with no containers at all.
 */
function largestContainer(items: readonly Item[]): string | undefined {
  const sizes = new Map<ContainerItem, number>()
  let best: ContainerItem | TableItem | undefined
  let bestSize = 0
  for (const item of items) {
    for (let owner = item.container; owner !== undefined; owner = owner.container) {
      const size = (sizes.get(owner) ?? 0) + 1
      sizes.set(owner, size)
      if (size > bestSize) {
        best = owner
        bestSize = size
      }
    }
    if (item.kind === 'table' && item.rows.length > bestSize) {
      best = item
      bestSize = item.rows.length
    }
  }
  return best?.ref
}

/**
 * The page as its containers, for a read whose outline would not fit.
 * @param items - every collected item.
 * @param total - how many items the outline collected.
 * @param truncated - whether this skeleton stands in for a listing that did not fit.
 * @returns the rendered listing.
 */
function mapListing(items: readonly Item[], total: number, truncated: boolean): Listing {
  const entries = mapEntries(items)
  const lines = entries.map(entry => entry.text)
  const largest = largestContainer(items)
  if (truncated && largest !== undefined) {
    lines.push(`Read a part with scope, e.g. content_read({ scope: "${largest}" }).`)
  }
  return { kind: 'map', text: lines.join('\n'), truncated, shown: entries.length, total, cursor: undefined }
}

/**
 * Render one read.
 * @param items - every collected item.
 * @param options - the read's options.
 * @param scope - the element the read asked for, if any.
 * @returns the rendered listing.
 */
export function render(items: readonly Item[], options: SnapshotOptions, scope: Element | undefined): Listing {
  const selected = options.find === undefined ? outlineEntries(items, scope) : findEntries(items, options.find)
  const entries = dropBefore(selected, options.after)
  if (options.mode === 'map') return mapListing(items, entries.length, false)
  const listing = assemble(entries, options.budgetChars)
  const wholePage = options.scope === undefined && options.find === undefined && options.after === undefined
  if (!listing.truncated || !wholePage) return listing
  // A page with no containers has no skeleton to answer with; the rows it does
  // have, cut short, say more than an empty answer.
  const skeleton = mapListing(items, entries.length, true)
  return skeleton.shown === 0 ? listing : skeleton
}
