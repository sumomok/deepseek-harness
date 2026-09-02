/**
 * Turning collected items into the text the model reads, under a character
 * budget that is never spent blindly: a whole page too large for the budget
 * comes back as a skeleton of its containers, and a listing too large for it
 * comes back with a cursor to continue from. Neither ever answers with half a
 * list and no way to reach the rest.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/render
 */
import { CLICKABLE_ROLE, FIELD_ROLES, clipTo } from './dom.ts'
import type {
  ContainerFace, ContainerItem, ControlFace, ControlState, ElementItem, Item, RowCell, SnapshotMode,
  SnapshotOptions, TableItem, TableRowItem, TextItem,
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

/** How much of a cell the header shows, which names a column and is worth more room. */
const HEADER_CELL_LIMIT = 40

/** How much of a cell a listed row shows, which the walk has already cut to. */
const ROW_CELL_LIMIT = 200

/** Roles that read as one of the items a widget offers rather than as text. */
const ITEM_ROLES: ReadonlySet<string> =
  new Set(['tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem'])

/**
 * One row of a listing, rendered when the listing decides to keep it. Rendering
 * a row numbers what it prints, so a listing that stops short never spends refs
 * on rows nobody has seen.
 */
interface Entry {
  /** The element the row names, absent for a row the model cannot name. */
  readonly el: Element | undefined
  /** Render the row, which may run to several lines. */
  readonly line: () => string
}

/**
 * One row of a listing, numbered and rendered on demand. The row's own ref is
 * minted before whatever it prints, so a reader continuing from it reads the
 * numbers in the order the page draws them.
 * @param el - the element the row names, if any.
 * @param refs - the page's numbering.
 * @param render - how the row prints.
 * @returns the entry.
 */
function entry(el: Element | undefined, refs: RefTable, render: () => string): Entry {
  return {
    el,
    line: (): string => {
      if (el !== undefined) refs.ref(el)
      return render()
    },
  }
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
  /** The items a widget offers: tabs, menu items, options, tree nodes. */
  items: number
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
  if (counts.items > 0) parts.push(`${counts.items} items`)
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
  const counts: Counts = { fields: 0, buttons: 0, links: 0, items: 0, rows: 0, texts: 0 }
  for (const item of items) {
    if (item.container !== container) continue
    if (item.kind === 'text') counts.texts += 1
    else if (item.kind === 'element') {
      if (FIELD_ROLES.has(item.role)) counts.fields += 1
      else if (item.role === 'button' || item.role === CLICKABLE_ROLE) counts.buttons += 1
      else if (item.role === 'link') counts.links += 1
      else if (ITEM_ROLES.has(item.role)) counts.items += 1
      else counts.texts += 1
    }
  }
  return countsOf(counts)
}

/**
 * What a row prints after the name of a control: what it holds, whether it is
 * on, and whether the page has switched it off. A row of its own and a row of a
 * table cell say this the same way.
 * @param state - the control's state.
 * @returns the trailing state, or the empty string.
 */
function stateOf(state: ControlState): string {
  const value = state.secret ? ' = (hidden)' : state.value === undefined ? '' : ` = "${state.value}"`
  const checked = state.checked === undefined ? '' : state.checked ? ' [x]' : ' [ ]'
  return `${value}${checked}${state.disabled ? ' (disabled)' : ''}`
}

/**
 * What a row says an element is: the role it carries, what it is called, what
 * the page has set on it, and whether the page has folded it away. A row of its
 * own and the room a tree node or menu item opens print it the same way.
 * @param face - what the element is and how the page has set it.
 * @param name - the element's accessible name.
 * @returns the rendered element, without a ref or an indent.
 */
function controlText(face: ControlFace, name: string): string {
  return `${face.role}${quoted(name)}${stateOf(face)}${face.collapsed ? ' (collapsed)' : ''}`
}

/**
 * What a row says a region is: the node it was opened over, where a tree node
 * or menu item holds it, and the kind of region everywhere else.
 * @param item - the container item.
 * @returns the rendered region, without a ref or an indent.
 */
function containerText(item: ContainerItem): string {
  return item.node === undefined
    ? `${item.type}${quoted(item.name)}`
    : controlText(item.node, item.name)
}

/**
 * One control, heading, or click target.
 * @param item - the element item.
 * @param prefix - the row's indentation.
 * @returns the rendered row.
 */
function elementLine(item: ElementItem, prefix: string): string {
  return `${prefix}${item.ref} ${controlText(item, item.name)}${within(item.container)}`
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
 * One cell as a listed row prints it: what it says, cut to what the line has
 * room for, and the controls it offers, each numbered here because a cell
 * nobody lists is a cell nobody needs a ref for. The controls are printed
 * whole: cutting them would cut a ref in half.
 * @param cell - the cell.
 * @param refs - the page's numbering.
 * @param limit - how much of the cell's text the line prints.
 * @returns the rendered cell.
 */
function cellText(cell: RowCell, refs: RefTable, limit: number): string {
  const text = clipTo(cell.text, limit)
  if (cell.controls.length === 0) return text
  const controls = cell.controls
    .map(control => `${refs.ref(control.el)} ${control.role}${quoted(control.name)}${stateOf(control)}`)
    .join(CONTROL_SEPARATOR)
  return text === '' ? controls : `${text}${CONTROL_SEPARATOR}${controls}`
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
  const cells = item.cells.map(cell => cellText(cell, refs, ROW_CELL_LIMIT))
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
  const cells = item.header.map(cell => cellText(cell, refs, HEADER_CELL_LIMIT))
  return [`${indent(depth + 1)}header: ${cells.join(CELL_SEPARATOR)}`]
}

/**
 * The lines a table prints wherever its rows are not listed: its shape, one
 * sample row, and how to reach the rest. The sample says what a column holds
 * rather than what it says — the data itself is what the read is not for — so
 * each of its cells arrives already cut to a short run.
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
    const cells = first.cells.map(cell => cell.sample)
    lines.push(`${inner}sample: ${cells.join(CELL_SEPARATOR)}`, `${inner}${ROWS_HINT}`)
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
  return `${indent(item.depth)}${item.ref} ${containerText(item)}${tail}`
}

/**
 * True when a listing has somewhere to put an item: a row of its own, or one of
 * the counts on the row above it. A skeleton has somewhere for every item — what
 * it does not print it counts — and a listing of the page leaves out the dialogs
 * the page has not opened, which the model reads on a skeleton and nowhere else.
 * @param item - the collected item.
 * @param mode - which listing is being rendered.
 * @returns whether this listing shows the item.
 */
function printsIn(item: Item, mode: SnapshotMode): boolean {
  return mode === 'map' || item.kind !== 'container' || !item.closed
}

/**
 * The row a room stands in for: the node it was opened over, printed as the row
 * the walk would have printed for that node. A room says everything that row
 * says, so the two differ in the region the row names at its end and in nothing
 * else.
 * @param room - the room to print as one row.
 * @param node - the node the room was opened over.
 * @returns the element row.
 */
function roomRow(room: ContainerItem, node: ControlFace): ElementItem {
  return {
    kind: 'element',
    el: room.el,
    ref: room.ref,
    name: room.name,
    ...node,
    container: room.container,
    depth: room.depth,
  }
}

/**
 * The items one listing prints, with every room that turns out to show nothing
 * printed as the row it stands in for. A room over a tree node or a menu item is
 * opened wherever the node holds anything at all, because what the room will
 * show is what the walk is about to read; whether any of it reaches this listing
 * is known here and nowhere earlier. An empty room would cost its node both the
 * region the node sits in and the count that region reports.
 *
 * The two listings disagree over one thing, so a node can be a room on the
 * skeleton and a row of the listing: a page that keeps a closed dialog inside a
 * tree node has a region to map and nothing to list there.
 * @param items - every collected item.
 * @param mode - which listing is being rendered.
 * @returns the items, rooms resolved.
 */
function printedItems(items: readonly Item[], mode: SnapshotMode): Item[] {
  const filled = new Set<ContainerItem>()
  for (const item of items) {
    if (item.container !== undefined && printsIn(item, mode)) filled.add(item.container)
  }
  return items.map(item => (item.kind === 'container' && item.node !== undefined && !filled.has(item)
    ? roomRow(item, item.node)
    : item))
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
      return `${indent(item.depth)}${item.ref} ${containerText(item)}`
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
 * The element a continuation resumes after, for the rows that name one.
 * @param item - the item to name.
 * @returns the element, or undefined for a row the model cannot name.
 */
function entryElement(item: Item): Element | undefined {
  return item.kind === 'text' || item.kind === 'frame-error' ? undefined : item.el
}

/**
 * A table the read asked for by ref: its shape, then one row per data row.
 * @param item - the table item.
 * @param refs - the page's numbering.
 * @returns the rendered entries.
 */
function scopedTableEntries(item: TableItem, refs: RefTable): Entry[] {
  return [
    entry(item.el, refs, () => [tableHead(item, item.depth), ...tableHeader(item, item.depth, refs)].join('\n')),
    ...item.rows.map(row => entry(row.el, refs, () => rowLine(row, indent(item.depth + 1), '', refs))),
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
    else entries.push(entry(entryElement(item), refs, () => outlineText(item, refs)))
  }
  return entries
}

/**
 * The containers of the page and nothing else, each with what it holds.
 * @param items - every collected item.
 * @param refs - the page's numbering.
 * @returns the rendered entries.
 */
function mapEntries(items: readonly Item[], refs: RefTable): Entry[] {
  const entries: Entry[] = []
  for (const item of items) {
    if (item.kind === 'container') entries.push(entry(item.el, refs, () => containerMapLine(item, items)))
    else if (item.kind === 'table') {
      const counts = countsOf({ fields: 0, buttons: 0, links: 0, items: 0, rows: item.rows.length, texts: 0 })
      entries.push(entry(item.el, refs, () => `${indent(item.depth)}${item.ref} table${quoted(item.name)}${counts}`))
    } else if (item.kind === 'frame-error') {
      entries.push(entry(undefined, refs, () => `${indent(item.depth)}${FRAME_UNREADABLE}`))
    }
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
      if (item.name.toLowerCase().includes(needle)) entries.push(entry(item.el, refs, () => elementLine(item, '')))
    } else if (item.kind === 'text') {
      if (item.text.toLowerCase().includes(needle)) entries.push(entry(undefined, refs, () => textLine(item, '')))
    } else if (item.kind === 'container') {
      if (!item.closed && item.name.toLowerCase().includes(needle)) {
        entries.push(entry(item.el, refs, () => `${item.ref} ${item.type}${quoted(item.name)}${within(item.container)}`))
      }
    } else if (item.kind === 'table') {
      if (item.name.toLowerCase().includes(needle)) entries.push(entry(item.el, refs, () => tableBlock(item, 0, refs)))
      for (const row of item.rows) {
        if (row.text.toLowerCase().includes(needle)) {
          entries.push(entry(row.el, refs, () => rowLine(row, '', within(row.table), refs)))
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
 * @param refs - the page's numbering.
 * @returns the remaining entries.
 * @throws {Error} when `after` names no row of this listing, which means the
 * read changed scope or filter between the two calls and the continuation would
 * silently start over.
 */
function dropBefore(entries: Entry[], after: string | undefined, refs: RefTable): Entry[] {
  if (after === undefined) return entries
  const named = refs.resolve(after)
  const at = entries.findIndex(entry => entry.el !== undefined && entry.el === named)
  if (at === -1) {
    throw new Error(`after: "${after}" is not an item of this read — pass the cursor from the same scope and find, or omit after`)
  }
  return entries.slice(at + 1)
}

/**
 * What a cut skeleton adds to the way on: a continuation carrying `after` alone
 * answers with the items of the page, so continuing a skeleton means asking for
 * a skeleton again.
 */
const MAP_AGAIN = ' and mode: "map"'

/**
 * How a listing cut at a row the model can name says where to continue.
 * @param kind - which listing this is.
 * @param cursor - the ref of the last rendered row.
 * @param remaining - how many rows the listing did not render.
 * @returns the closing line.
 */
function cutAfter(kind: SnapshotMode, cursor: string, remaining: number): string {
  const again = kind === 'map' ? MAP_AGAIN : ''
  return `(cut after ${cursor} — pass after: "${cursor}"${again} to continue; ${remaining} items remain)`
}

/**
 * How a continuation that has already reached the end of its listing says so,
 * which an empty body would leave the model to read as a failed read.
 * @param after - the ref the continuation resumed after.
 * @returns the body.
 */
function nothingAfter(after: string): string {
  return `(nothing after ${after} — the listing ended there)`
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
 * How the one row a listing has says it cost more than the whole budget. The
 * row is printed anyway — a read answers with something — and the reader is
 * told the budget did not cover it.
 */
const OVER_BUDGET = '(this row alone exceeds the budget — read a smaller part with scope or find)'

/** What a skeleton of a page with no region at all to draw says instead. */
const NOTHING_TO_MAP = '(the page has no containers to map — read it without mode)'

/** What a read of a page holding nothing a reader can see says instead. */
const NOTHING_TO_READ = '(the page shows nothing to read)'

/**
 * What a read of a part of the page holding nothing says instead: the part was
 * there when the model read its ref, and is empty or hidden now.
 * @param scope - the ref the read asked for.
 * @returns the body.
 */
function nothingInside(scope: string): string {
  return `(nothing to read inside ${scope} now — read without scope)`
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
 *
 * The width of the widest ref is estimated from the rows still to come, which
 * holds while each row numbers one element. A listed table row also numbers the
 * controls in its cells, so a listing of those can reach a wider ref than this
 * estimate; the reserve is the longest of three lines, and `cutHere` is about
 * eighteen characters longer than `cutAfter`, which covers the extra digits.
 * @param kind - which listing this is.
 * @param entries - the listing.
 * @param hint - the closing line an uncut listing prints, if any.
 * @param refs - the page's numbering.
 * @returns the reserved characters, the closing newline included.
 */
function reserveFor(kind: SnapshotMode, entries: readonly Entry[], hint: string | undefined, refs: RefTable): number {
  const remaining = Number('9'.repeat(String(entries.length).length))
  const widest = refs.widthAfter(entries.length)
  return Math.max(cutHere(remaining).length, cutAfter(kind, 'e'.repeat(widest), remaining).length, hint?.length ?? 0) + 1
}

/**
 * Render as many rows as the budget holds. The first row is always rendered,
 * however long it is, so a read is never answered with nothing at all. A row
 * has to be rendered to be measured, so the one row that turns out not to fit
 * is rendered and then unnumbered again.
 * @param entries - the listing.
 * @param budget - the characters the rows may take.
 * @param refs - the page's numbering.
 * @returns the rendered rows.
 */
function fill(entries: readonly Entry[], budget: number, refs: RefTable): string[] {
  const lines: string[] = []
  let used = 0
  for (const entry of entries) {
    const mark = refs.mark()
    const text = entry.line()
    const cost = text.length + 1
    if (lines.length > 0 && used + cost > budget) {
      refs.rollback(mark)
      break
    }
    lines.push(text)
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
 * still prints both, and says which of the two happened — a listing with more
 * rows to come is cut, while a listing of one over-long row is complete and
 * over budget.
 * @param kind - which listing this is.
 * @param entries - the listing.
 * @param budgetChars - the character budget.
 * @param hint - the closing line an uncut listing prints, if any.
 * @param refs - the page's numbering.
 * @returns the rendered listing.
 */
function assemble(
  kind: SnapshotMode,
  entries: readonly Entry[],
  budgetChars: number,
  hint: string | undefined,
  refs: RefTable,
): Listing {
  const mark = refs.mark()
  const whole = fill(entries, budgetChars, refs)
  const closes = whole.length < entries.length || hint !== undefined
  let lines = whole
  if (closes) {
    // The wider fill numbered rows this one may not keep; the read prints the
    // numbers it renders and no others.
    refs.rollback(mark)
    lines = fill(entries, budgetChars - reserveFor(kind, entries, hint, refs), refs)
  }
  const truncated = lines.length < entries.length
  let shown = lines.length
  if (truncated) {
    let named = shown
    while (named > 0 && entries[named - 1]?.el === undefined) named -= 1
    if (named > 0) shown = named
  }
  const last = entries[shown - 1]?.el
  const cursor = truncated && last !== undefined ? refs.ref(last) : undefined
  const body = lines.slice(0, shown)
  if (truncated) {
    body.push(cursor === undefined ? cutHere(entries.length - shown) : cutAfter(kind, cursor, entries.length - shown))
  }
  else if (hint !== undefined) body.push(hint)
  // A listing of one row longer than the whole budget is complete and still
  // over it; a listing that already closes with a way on has said enough.
  const over = !truncated && hint === undefined && body.join('\n').length > budgetChars
  if (over) body.push(OVER_BUDGET)
  return { kind, text: body.join('\n'), truncated: truncated || over, shown, total: entries.length, cursor }
}

/**
 * One listing, from the row a continuation resumes at. A continuation that
 * names the listing's last row has reached the end and says so; every other
 * read fills the budget as usual.
 * @param kind - which listing this is.
 * @param entries - the whole listing, before the continuation is applied.
 * @param options - the read's options.
 * @returns the rendered listing.
 * @throws {Error} when `after` names no row of this listing.
 */
function resume(kind: SnapshotMode, entries: Entry[], options: SnapshotOptions): Listing {
  const { after, refs } = options
  const rest = dropBefore(entries, after, refs)
  if (after !== undefined && rest.length === 0) {
    return { kind, text: nothingAfter(after), truncated: false, shown: 0, total: 0, cursor: undefined }
  }
  return assemble(kind, rest, options.budgetChars, undefined, refs)
}

/** Where a reader shown only the skeleton should look next, and how much is there. */
interface Largest {
  /** The container's ref. */
  readonly ref: string
  /** How many rows it holds. */
  readonly size: number
}

/**
 * The container holding the most of the page, which is where a reader who has
 * only been shown the skeleton should look next. What a container holds is what
 * sits directly inside it: a wrapper around one section is smaller than the
 * section, however much the section holds.
 * @param items - every collected item.
 * @returns it and its size, or undefined for a page with no containers at all.
 */
function largestContainer(items: readonly Item[]): Largest | undefined {
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
  return best === undefined ? undefined : { ref: best.ref, size: bestSize }
}

/**
 * How many rows of the page sit in no container at all, which a skeleton of the
 * page would not mention anywhere.
 * @param items - every collected item.
 * @returns the count.
 */
function looseCount(items: readonly Item[]): number {
  return items.filter(item => item.container === undefined && item.kind !== 'container').length
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
    const skeleton = mapEntries(printedItems(items, 'map'), refs)
    if (skeleton.length === 0) {
      return { kind: 'map', text: NOTHING_TO_MAP, truncated: false, shown: 0, total: 0, cursor: undefined }
    }
    return resume('map', skeleton, options)
  }
  const listed = printedItems(items, 'outline')
  if (find !== undefined) {
    const found = findEntries(listed, find, refs)
    if (found.length === 0) {
      const text = `No item matches "${find}" — try a shorter word, or read without find.`
      return { kind: 'outline', text, truncated: false, shown: 0, total: 0, cursor: undefined }
    }
    return resume('outline', found, options)
  }
  const entries = outlineEntries(listed, scope, refs)
  if (entries.length === 0) {
    const text = options.scope === undefined ? NOTHING_TO_READ : nothingInside(options.scope)
    return { kind: 'outline', text, truncated: false, shown: 0, total: 0, cursor: undefined }
  }
  const mark = refs.mark()
  const listing = resume('outline', entries, options)
  const wholePage = options.scope === undefined && options.after === undefined
  if (!listing.truncated || !wholePage) return listing
  // A skeleton is only worth answering with when it says where to read next: a
  // page whose regions hold nothing directly has no room to point at, and its
  // rows, cut short, carry more than a map of empty rooms. What the skeleton
  // holds is measured on the skeleton's own items, which resolve one room the
  // listing resolved the other way.
  const mapped = printedItems(items, 'map')
  const largest = largestContainer(mapped)
  // A page with more rows outside its regions than in the largest of them is
  // the same case: the skeleton would leave the reader nowhere to find them.
  if (largest === undefined || looseCount(mapped) > largest.size) return listing
  // The listing the skeleton stands in for reaches nobody, and neither do the
  // numbers it minted.
  refs.rollback(mark)
  // However much of the skeleton fits, it stands in for a listing that did not,
  // so the read is short of what it collected either way.
  return { ...assemble('map', mapEntries(mapped, refs), budgetChars, scopeHint(largest.ref), refs), truncated: true }
}
