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
  ContainerFace, ContainerItem, ElementItem, Item, RowCell, SnapshotMode, SnapshotOptions,
  TableItem, TableRowItem, TextItem,
} from './model.ts'
import type { RefTable } from './refs.ts'

/** What separates two cells of the same row. */
const CELL_SEPARATOR = ' | '

/** What separates two controls inside one listed cell. */
const CONTROL_SEPARATOR = '  '

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
  /** True when the listing stops short of everything this read would have shown. */
  readonly truncated: boolean
  /** How many rows of the listing the body renders. */
  readonly shown: number
  /** How many rows the listing has in full. */
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
 * One cell as a listed row prints it: its text, or the controls it holds, each
 * numbered here because a cell nobody lists is a cell nobody needs a ref for.
 * @param cell - the cell.
 * @param refs - the page's numbering.
 * @returns the rendered cell.
 */
function cellText(cell: RowCell, refs: RefTable): string {
  if (cell.controls.length === 0) return cell.sample
  return cell.controls
    .map(control => `${refs.ref(control.el)} ${control.role} "${control.name}"`)
    .join(CONTROL_SEPARATOR)
}

/**
 * One data row of a table.
 * @param item - the row item.
 * @param prefix - the row's indentation.
 * @param suffix - the trailing container note, which a flat listing prints and an indented one does not.
 * @param refs - the page's numbering.
 * @returns the rendered row.
 */
function rowLine(item: TableRowItem, prefix: string, suffix: string, refs: RefTable): string {
  const cells = item.cells.map(cell => cellText(cell, refs))
  return `${prefix}row ${item.index}: ${cells.join(CELL_SEPARATOR)}${suffix}`
}

/**
 * A table's first line: what it is and how big it is.
 * @param item - the table item.
 * @param depth - the nesting depth the block prints at.
 * @returns the rendered row.
 */
function tableHead(item: TableItem, depth: number): string {
  return `${indent(depth)}${item.ref} table${quoted(item.name)} ${item.rows.length} rows × ${item.columns} cols`
}

/**
 * A table's header line, when it has one.
 * @param item - the table item.
 * @param depth - the nesting depth the block prints at.
 * @param refs - the page's numbering.
 * @returns the rendered line, or nothing.
 */
function tableHeader(item: TableItem, depth: number, refs: RefTable): string[] {
  if (item.header.length === 0) return []
  const cells = item.header.map(cell => cellText(cell, refs))
  return [`${indent(depth + 1)}header: ${cells.join(CELL_SEPARATOR)}`]
}

/**
 * The lines a table prints wherever its rows are not listed: its shape, one
 * sample row, and how to reach the rest.
 * @param item - the table item.
 * @param depth - the nesting depth the block prints at.
 * @param refs - the page's numbering.
 * @returns the rendered rows.
 */
function tableBlock(item: TableItem, depth: number, refs: RefTable): string {
  const inner = indent(depth + 1)
  const lines = [tableHead(item, depth), ...tableHeader(item, depth, refs)]
  const first = item.rows[0]
  if (first !== undefined) {
    lines.push(`${inner}sample: ${first.cells.map(cell => cell.sample).join(CELL_SEPARATOR)}`, `${inner}${ROWS_HINT}`)
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
 * @param refs - the page's numbering.
 * @returns the rendered row.
 */
function outlineText(item: Item, refs: RefTable): string {
  switch (item.kind) {
    case 'container':
      return `${indent(item.depth)}${item.ref} ${item.type}${quoted(item.name)}`
    case 'element':
      return elementLine(item, indent(item.depth))
    case 'text':
      return textLine(item, indent(item.depth))
    case 'table':
      return tableBlock(item, item.depth, refs)
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
 * @param refs - the page's numbering.
 * @returns the rendered entries.
 */
function scopedTableEntries(item: TableItem, refs: RefTable): Entry[] {
  const head = [tableHead(item, item.depth), ...tableHeader(item, item.depth, refs)].join('\n')
  return [
    { ref: item.ref, text: head },
    ...item.rows.map((row): Entry => ({ ref: refs.ref(row.el), text: rowLine(row, indent(item.depth + 1), '', refs) })),
  ]
}

/**
 * Every item, nested under the containers it sits in.
 * @param items - every collected item.
 * @param scope - the element the read asked for, if any.
 * @param refs - the page's numbering.
 * @returns the rendered entries.
 */
function outlineEntries(items: readonly Item[], scope: Element | undefined, refs: RefTable): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'container' && item.closed) continue
    if (item.kind === 'table' && item.el === scope) entries.push(...scopedTableEntries(item, refs))
    else entries.push({ ref: entryRef(item), text: outlineText(item, refs) })
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
 * the one way a read reaches a single row without listing the whole table. A
 * container matches by its own name and prints that row alone, without the
 * items inside it — the read that follows can scope to it.
 * @param items - every collected item.
 * @param find - the string to look for.
 * @param refs - the page's numbering.
 * @returns the rendered entries.
 */
function findEntries(items: readonly Item[], find: string, refs: RefTable): Entry[] {
  const needle = find.toLowerCase()
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'element') {
      if (item.name.toLowerCase().includes(needle)) entries.push({ ref: item.ref, text: elementLine(item, '') })
    } else if (item.kind === 'text') {
      if (item.text.toLowerCase().includes(needle)) entries.push({ ref: undefined, text: textLine(item, '') })
    } else if (item.kind === 'container') {
      if (!item.closed && item.name.toLowerCase().includes(needle)) {
        entries.push({ ref: item.ref, text: `${item.ref} ${item.type}${quoted(item.name)}${within(item.container)}` })
      }
    } else if (item.kind === 'table') {
      if (item.name.toLowerCase().includes(needle)) entries.push({ ref: item.ref, text: tableBlock(item, 0, refs) })
      for (const row of item.rows) {
        if (row.text.toLowerCase().includes(needle)) {
          entries.push({ ref: refs.ref(row.el), text: rowLine(row, '', within(row.table), refs) })
        }
      }
    }
  }
  return entries
}

/**
 * Drop everything up to and including the entry a continuation resumes after.
 * @param entries - the listing.
 * @param after - the ref to resume after, if any.
 * @returns the remaining entries.
 * @throws {Error} when `after` names no row of this listing, which means the
 * read changed scope or filter between the two calls and the continuation would
 * silently start over.
 */
function dropBefore(entries: Entry[], after: string | undefined): Entry[] {
  if (after === undefined) return entries
  const at = entries.findIndex(entry => entry.ref === after)
  if (at === -1) {
    throw new Error(`after: "${after}" is not an item of this read — pass the cursor from the same scope and find, or omit after`)
  }
  return entries.slice(at + 1)
}

/**
 * How a listing cut at a row the model can name says where to continue.
 * @param cursor - the ref of the last rendered row.
 * @param remaining - how many rows the listing did not render.
 * @returns the closing line.
 */
function cutAfter(cursor: string, remaining: number): string {
  return `(cut after ${cursor} — pass after: "${cursor}" to continue; ${remaining} items remain)`
}

/**
 * How a listing cut at rows the model cannot name says to narrow the read.
 * @param remaining - how many rows the listing did not render.
 * @returns the closing line.
 */
function cutHere(remaining: number): string {
  return `(cut here; ${remaining} items remain — narrow the read with find, or read a part with scope)`
}

/**
 * How a skeleton says where to read next.
 * @param ref - the ref of the container holding the most of the page.
 * @returns the closing line.
 */
function scopeHint(ref: string): string {
  return `Read a part with scope, e.g. content_read({ scope: "${ref}" }).`
}

/**
 * How much of the budget the closing line needs, measured against the longest
 * one this listing could possibly print rather than the one it turns out to
 * print, because which line closes a listing is only known once it is filled.
 * @param entries - the listing.
 * @param hint - the closing line an uncut listing prints, if any.
 * @returns the reserved characters, the closing newline included.
 */
function reserveFor(entries: readonly Entry[], hint: string | undefined): number {
  const remaining = Number('9'.repeat(String(entries.length).length))
  const widest = entries.reduce((longest, entry) => Math.max(longest, entry.ref?.length ?? 0), 0)
  return Math.max(cutHere(remaining).length, cutAfter('e'.repeat(widest), remaining).length, hint?.length ?? 0) + 1
}

/**
 * Render as many rows as the budget holds. The first row is always rendered,
 * however long it is, so a read is never answered with nothing at all.
 * @param entries - the listing.
 * @param budget - the characters the rows may take.
 * @returns the rendered rows.
 */
function fill(entries: readonly Entry[], budget: number): string[] {
  const lines: string[] = []
  let used = 0
  for (const entry of entries) {
    const cost = entry.text.length + 1
    if (lines.length > 0 && used + cost > budget) break
    lines.push(entry.text)
    used += cost
  }
  return lines
}

/**
 * Fill the budget, then say how to reach the rest. A listing cut short backs
 * off any trailing rows the model cannot name, so the cursor names the last row
 * rendered and a continuation covers the listing exactly once; a listing whose
 * rows are all page text has nothing to continue from, and says so rather than
 * leaving the model to guess.
 *
 * The closing line is part of the budget: the body is at most `budgetChars`,
 * except that a read whose first row and closing line alone exceed the budget
 * still prints both.
 * @param kind - which listing this is.
 * @param entries - the listing.
 * @param budgetChars - the character budget.
 * @param hint - the closing line an uncut listing prints, if any.
 * @returns the rendered listing.
 */
function assemble(kind: SnapshotMode, entries: readonly Entry[], budgetChars: number, hint: string | undefined): Listing {
  const whole = fill(entries, budgetChars)
  const closes = whole.length < entries.length || hint !== undefined
  const lines = closes ? fill(entries, budgetChars - reserveFor(entries, hint)) : whole
  const truncated = lines.length < entries.length
  let shown = lines.length
  if (truncated) {
    let named = shown
    while (named > 0 && entries[named - 1]?.ref === undefined) named -= 1
    if (named > 0) shown = named
  }
  const cursor = truncated ? entries[shown - 1]?.ref : undefined
  const body = lines.slice(0, shown)
  if (truncated) body.push(cursor === undefined ? cutHere(entries.length - shown) : cutAfter(cursor, entries.length - shown))
  else if (hint !== undefined) body.push(hint)
  return { kind, text: body.join('\n'), truncated, shown, total: entries.length, cursor }
}

/**
 * The container holding the most of the page, which is where a reader who has
 * only been shown the skeleton should look next. What a container holds is what
 * sits directly inside it: a wrapper around one section is smaller than the
 * section, however much the section holds.
 * @param items - every collected item.
 * @returns its ref, or undefined for a page with no containers at all.
 */
function largestContainer(items: readonly Item[]): string | undefined {
  const sizes = new Map<ContainerItem, number>()
  let best: ContainerItem | TableItem | undefined
  let bestSize = 0
  for (const item of items) {
    const owner = item.container
    if (owner !== undefined) {
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
 * Render one read.
 * @param items - every collected item.
 * @param options - the read's options.
 * @param scope - the element the read asked for, if any.
 * @returns the rendered listing.
 * @throws {Error} when `find` is combined with the skeleton, or when `after`
 * names no row of this read's listing.
 */
export function render(items: readonly Item[], options: SnapshotOptions, scope: Element | undefined): Listing {
  const { budgetChars, find, refs } = options
  if (options.mode === 'map') {
    if (find !== undefined) {
      throw new Error('find cannot be combined with mode "map" — read the map first, then find within a scope')
    }
    return assemble('map', dropBefore(mapEntries(items), options.after), budgetChars, undefined)
  }
  if (find !== undefined) {
    const found = findEntries(items, find, refs)
    if (found.length === 0) {
      const text = `No item matches "${find}" — try a shorter word, or read without find.`
      return { kind: 'outline', text, truncated: false, shown: 0, total: 0, cursor: undefined }
    }
    return assemble('outline', dropBefore(found, options.after), budgetChars, undefined)
  }
  const entries = dropBefore(outlineEntries(items, scope, refs), options.after)
  const listing = assemble('outline', entries, budgetChars, undefined)
  const wholePage = options.scope === undefined && options.after === undefined
  if (!listing.truncated || !wholePage) return listing
  // A page with no containers has no skeleton to answer with; the rows it does
  // have, cut short, say more than an empty answer.
  const skeleton = mapEntries(items)
  if (skeleton.length === 0) return listing
  const largest = largestContainer(items)
  // However much of the skeleton fits, it stands in for a listing that did not,
  // so the read is short of what it collected either way.
  return { ...assemble('map', skeleton, budgetChars, largest === undefined ? undefined : scopeHint(largest)), truncated: true }
}
