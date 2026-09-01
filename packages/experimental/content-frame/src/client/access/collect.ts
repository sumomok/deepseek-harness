/**
 * One walk of the page, in document order, turning elements into the items a
 * listing renders. The walk enters open shadow roots and same-origin frames, so
 * a page built as a frame inside a frame reads as one document.
 *
 * Two rules keep the result a structure rather than a data dump: a table is
 * collected as its shape (header, one sample row, a row count) and never as its
 * rows, and an element that carries a name of its own — a control, a heading, a
 * click target — ends the descent, because its accessible name already says
 * what is inside it.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/collect
 */
import {
  CHECKED_ROLES, CLICKABLE_ROLE, FIELD_ROLES, childHost, clip, collapse, containerName, fieldValue,
  frameDocument, isChecked, isDisabled, isInline, isMarked, isNameable, isNonContent, isPassword,
  isSkipped, looksClickable, markedSelector, nameOf, queryInOrder, rectsOverlap, roleOf, visibleText,
} from './dom.ts'
import type {
  CellControl, ContainerFace, ContainerItem, Item, RowCell, SnapshotOptions, TableItem, TableRowItem,
} from './model.ts'

/** How many items a `ul` or `ol` needs before it reads as a list of its own. */
const LIST_MIN = 3

/** How many buttons an element needs to read as a toolbar without saying so. */
const TOOLBAR_MIN = 2

/** Roles that make a table cell worth naming rather than reading as text. */
const CELL_CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'link', ...FIELD_ROLES])

/** The word pages use to mark the strip that pages through a table. */
const PAGINATION_MARKER = 'pagination'

/** Every element that reads as a table. */
const TABLE_SELECTOR = 'table, [role="table"], [role="grid"], [role="treegrid"]'

/** Every element that reads as a dialog. */
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]'

/**
 * Everything that would earn a row of its own. A click target holding one of
 * these is a wrapper around content rather than a thing to click, so the walk
 * reads through it; the wrapper itself then prints nothing, which is the known
 * cost of not burying its contents.
 */
const ITEM_SELECTOR = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'iframe', 'table',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', '[role]', '[contenteditable]', '[tabindex]',
  'img[alt]:not([alt=""])',
].join(', ')

/** Everything one walk shares from its first element to its last. */
interface Walk {
  /** The read's options. */
  readonly options: SnapshotOptions
  /** Injected visibility. */
  readonly isVisible: (el: Element) => boolean
  /** Injected clickability, defaulted. */
  readonly isClickable: (el: Element) => boolean
  /** The items collected so far, in document order. */
  readonly items: Item[]
  /** Rectangles already claimed, keyed by role and name, for dropping repeats. */
  readonly kept: Map<string, DOMRectReadOnly[]>
}

/** Where the walk currently stands. */
interface Place {
  /** The container the walk is inside. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this position. */
  readonly depth: number
  /** Text seen since the last row, waiting to become one. */
  readonly buffer: string[]
  /** The node whose subtree bounds a search for something beside an item. */
  readonly root: ParentNode
  /**
   * True inside a `label` that names a control: everything it shows is already
   * printed as that control's name, so its text and its click targets are not
   * rows of their own.
   */
  readonly labelled: boolean
}

/**
 * True when this element repeats one already collected — same role, same name,
 * and most of the smaller rectangle in common. A pinned table column draws its
 * cells twice; the reader needs them once.
 * @param kept - rectangles already claimed, keyed by role and name.
 * @param rectOf - injected geometry.
 * @param key - the role and name this element would print.
 * @param el - the element to test.
 * @returns whether the element repeats one already collected.
 */
function duplicate(
  kept: Map<string, DOMRectReadOnly[]>,
  rectOf: (el: Element) => DOMRectReadOnly | undefined,
  key: string,
  el: Element,
): boolean {
  const rect = rectOf(el)
  if (rect === undefined) return false
  const seen = kept.get(key)
  if (seen === undefined) {
    kept.set(key, [rect])
    return false
  }
  if (seen.some(other => rectsOverlap(rect, other))) return true
  seen.push(rect)
  return false
}

/**
 * Turn the text seen since the last row into a row of its own.
 * @param walk - the walk in progress.
 * @param place - the position whose buffered text is flushed.
 */
function flush(walk: Walk, place: Place): void {
  if (place.buffer.length === 0) return
  const text = clip(collapse(place.buffer.join(' ')))
  place.buffer.length = 0
  if (text !== '') walk.items.push({ kind: 'text', text, container: place.container, depth: place.depth })
}

/**
 * A list long enough to read as one.
 * @param el - the element to classify.
 * @returns the container face, or undefined for a short or non-list element.
 */
function listFace(el: Element): ContainerFace | undefined {
  const tag = el.localName
  if (tag !== 'ul' && tag !== 'ol') return undefined
  const items = [...el.children].filter(child => child.localName === 'li')
  return items.length >= LIST_MIN ? { type: 'list', name: nameOf(el) } : undefined
}

/**
 * A region the page titled, which is what makes it worth naming.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for an untitled region.
 */
function sectionFace(el: Element, walk: Walk): ContainerFace | undefined {
  const name = containerName(el, walk.isVisible)
  return name === '' ? undefined : { type: 'section', name }
}

/**
 * A row of buttons, which reads as a toolbar whether or not it says so.
 * @param el - the element to classify.
 * @param role - the element's role.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for anything else.
 */
function buttonRowFace(el: Element, role: string | null, walk: Walk): ContainerFace | undefined {
  if (role !== null) return undefined
  const children = [...el.children].filter(child => !isSkipped(child, walk.isVisible))
  return children.length >= TOOLBAR_MIN && children.every(child => roleOf(child) === 'button')
    ? { type: 'toolbar', name: '' }
    : undefined
}

/**
 * The container an element opens, if it opens one. A composite widget — a strip
 * of tabs, a menu, a group of radios — is a container and not a leaf: what the
 * model needs is inside it.
 * @param el - the element to classify.
 * @param role - the element's role.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for an element that opens none.
 */
function containerFace(el: Element, role: string | null, walk: Walk): ContainerFace | undefined {
  switch (role) {
    case 'main': return { type: 'main', name: nameOf(el) }
    case 'navigation': return { type: 'nav', name: nameOf(el) }
    case 'form':
    case 'search': return { type: 'form', name: nameOf(el) }
    case 'dialog':
    case 'alertdialog': return { type: 'dialog', name: containerName(el, walk.isVisible) }
    case 'toolbar': return { type: 'toolbar', name: nameOf(el) }
    case 'tablist': return { type: 'tablist', name: nameOf(el) }
    case 'tabpanel': return { type: 'tabpanel', name: nameOf(el) }
    case 'menu':
    case 'menubar': return { type: 'menu', name: nameOf(el) }
    case 'tree': return { type: 'tree', name: nameOf(el) }
    case 'radiogroup': return { type: 'radiogroup', name: nameOf(el) }
    // A select carries this role too, and is a field the model reads and fills
    // rather than a region it looks inside.
    case 'listbox': return el.localName === 'select' ? undefined : { type: 'listbox', name: nameOf(el) }
    case 'list':
    case 'feed': return listFace(el)
    case 'region':
    case 'article':
    case 'complementary':
      return sectionFace(el, walk)
    default: return buttonRowFace(el, role, walk)
  }
}

/**
 * Every control inside one table cell, in document order.
 * @param el - the cell, or an element inside it.
 * @param walk - the walk in progress.
 * @param found - the controls collected so far, appended in place.
 */
function cellControls(el: Element, walk: Walk, found: CellControl[]): void {
  for (const child of childHost(el).children) {
    if (isSkipped(child, walk.isVisible)) continue
    const role = roleOf(child)
    if (role !== null && CELL_CONTROL_ROLES.has(role)) found.push({ el: child, role, name: nameOf(child) })
    else cellControls(child, walk, found)
  }
}

/**
 * Read one cell.
 * @param cell - the cell element.
 * @param walk - the walk in progress.
 * @returns the cell.
 */
function readCell(cell: Element, walk: Walk): RowCell {
  const controls: CellControl[] = []
  cellControls(cell, walk, controls)
  return controls.length === 0
    ? { controls, sample: clip(visibleText(cell, walk.isVisible)) }
    : { controls, sample: `[${controls.map(control => control.name).join(' ')}]` }
}

/**
 * Read one row of cells, dropping the cells a pinned column repeats and the
 * cells of a column the page hides.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @param kept - the table's claimed rectangles.
 * @returns the row's cells, in column order.
 */
function readCells(row: Element, walk: Walk, kept: Map<string, DOMRectReadOnly[]>): RowCell[] {
  const cells: RowCell[] = []
  for (const cell of row.children) {
    if (isSkipped(cell, walk.isVisible)) continue
    const read = readCell(cell, walk)
    if (!duplicate(kept, walk.options.rectOf, `cell|${read.sample}`, cell)) cells.push(read)
  }
  return cells
}

/**
 * True for a cell that heads a column or a row rather than holding data.
 * @param cell - the cell element.
 * @returns whether the cell is a header cell.
 */
function headsCells(cell: Element): boolean {
  const role = roleOf(cell)
  return role === 'columnheader' || role === 'rowheader'
}

/**
 * True for a row that is a header the table did not declare as one: every cell
 * a reader can see heads a column. A row of data cells is data, however the
 * page styles it.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @returns whether the row heads the table's columns.
 */
function headsColumns(row: Element, walk: Walk): boolean {
  const cells = [...row.children].filter(cell => !isSkipped(cell, walk.isVisible))
  return cells.length > 0 && cells.every(headsCells)
}

/** Which rows of one table head its columns and which hold its data. */
interface TableShape {
  /** The row heading the columns, absent for a table that heads none. */
  readonly headRow: Element | undefined
  /** Every row holding data, without the header, the foot, and the hidden ones. */
  readonly dataRows: readonly Element[]
}

/**
 * Sort one table's rows into its header and its data. A `thead` of several rows
 * heads the table by its first row alone, so a table that spreads its column
 * names over a grouping row and a leaf row reports the grouping row as its
 * header and counts that row's cells as its columns; the leaf names reach the
 * reader only in the rows themselves.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the table's shape.
 */
function tableShape(el: Element, walk: Walk): TableShape {
  const grouped = new Set(el.querySelectorAll(':scope > thead > tr, :scope > tfoot > tr'))
  const rows = queryInOrder(el, 'tr, [role="row"]').filter(row => row.closest(TABLE_SELECTOR) === el)
  const declared = el.querySelector(':scope > thead > tr') ?? undefined
  const first = rows[0]
  const headRow = declared ?? (first !== undefined && headsColumns(first, walk) ? first : undefined)
  return {
    headRow,
    dataRows: rows.filter(row => row !== headRow && !grouped.has(row) && !isSkipped(row, walk.isVisible)),
  }
}

/**
 * The table drawn beside this one, for a page that draws one table in two
 * pieces — a header frozen above a body that scrolls under it.
 * @param el - the table element.
 * @param step - 1 for the table after this one, -1 for the table before it.
 * @returns the neighbouring table, or undefined when there is none.
 */
function neighbourTable(el: Element, step: number): Element | undefined {
  const tables = queryInOrder(el.ownerDocument, TABLE_SELECTOR)
  return tables[tables.indexOf(el) + step]
}

/**
 * The piece this table borrows its header from: the table before it that heads
 * columns it has no rows for. The two are one table, so the header reaches the
 * reader whether the read arrives at the whole page or at the body by ref.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param shape - this table's own shape.
 * @returns the header piece, or undefined for a table that heads its own columns.
 */
function headerPiece(el: Element, walk: Walk, shape: TableShape): Element | undefined {
  if (shape.headRow !== undefined) return undefined
  const previous = neighbourTable(el, -1)
  if (previous === undefined) return undefined
  const piece = tableShape(previous, walk)
  return piece.headRow !== undefined && piece.dataRows.length === 0 ? previous : undefined
}

/**
 * True for the header half of a table drawn in two pieces, which prints nothing
 * of its own: the body half prints the header it gives away.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns whether the table is a header another table prints.
 */
function isHeaderPiece(el: Element, walk: Walk): boolean {
  const shape = tableShape(el, walk)
  if (shape.headRow === undefined || shape.dataRows.length > 0) return false
  const next = neighbourTable(el, 1)
  return next !== undefined && tableShape(next, walk).headRow === undefined
}

/**
 * The text of a pagination strip, when the candidate really is one that shows
 * something.
 * @param el - the candidate element.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when it is not one or shows nothing.
 */
function stripText(el: Element, walk: Walk): string | undefined {
  if (!isMarked(el, PAGINATION_MARKER) || isSkipped(el, walk.isVisible)) return undefined
  const text = clip(visibleText(el, walk.isVisible))
  return text === '' ? undefined : text
}

/**
 * The first pagination strip among the elements between one table and the next,
 * scanning away from the table.
 * @param nodes - the tables and candidates on one side of the table, nearest first.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when another table comes first.
 */
function nearestStrip(nodes: readonly Element[], walk: Walk): string | undefined {
  for (const node of nodes) {
    if (node.matches(TABLE_SELECTOR)) return undefined
    const text = stripText(node, walk)
    if (text !== undefined) return text
  }
  return undefined
}

/**
 * The strip drawn above a table, which pages that table only when no table at
 * all sits above the strip: a strip between two tables pages the one it is
 * drawn under, and belongs to no other.
 * @param above - the tables and candidates before the table, in document order.
 * @param walk - the walk in progress.
 * @returns the strip's text, or undefined when a table comes before it.
 */
function stripAbove(above: readonly Element[], walk: Walk): string | undefined {
  if (above.some(node => node.matches(TABLE_SELECTOR))) return undefined
  return nearestStrip([...above].reverse(), walk)
}

/**
 * The pagination strip that belongs to a table: the one under it, or failing
 * that the one over it, never one that belongs to the table next to it. Each
 * strip pages one table, so a strip already under a table is not also over the
 * next one. A strip drawn inside any table belongs to that table's rows, not
 * beside it.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @returns the strip's text, or undefined when the table has none.
 */
function paginationText(el: Element, walk: Walk, place: Place): string | undefined {
  const nodes = queryInOrder(place.root, `${TABLE_SELECTOR}, ${markedSelector(PAGINATION_MARKER)}`)
    .filter(node => node.matches(TABLE_SELECTOR) || node.closest(TABLE_SELECTOR) === null)
  const at = nodes.indexOf(el)
  if (at === -1) return undefined
  return nearestStrip(nodes.slice(at + 1), walk) ?? stripAbove(nodes.slice(0, at), walk)
}

/**
 * Read a table as its shape: the header, the rows, and what sits beside it.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @param name - the table's accessible name.
 * @returns the collected table.
 */
function readTable(el: Element, walk: Walk, place: Place, name: string): TableItem {
  const shape = tableShape(el, walk)
  const piece = headerPiece(el, walk, shape)
  const headRow = shape.headRow ?? (piece === undefined ? undefined : tableShape(piece, walk).headRow)
  const kept = new Map<string, DOMRectReadOnly[]>()
  // Numbered before its contents, so the ref that names the table reads lower
  // than the refs of the controls inside it.
  const ref = walk.options.refs.ref(el)
  const header = headRow === undefined ? [] : readCells(headRow, walk, kept)
  const face: { readonly type: 'table'; readonly name: string } = { type: 'table', name }
  const rows = shape.dataRows.map((row, index): TableRowItem => ({
    kind: 'row',
    el: row,
    index: index + 1,
    cells: readCells(row, walk, kept),
    text: clip(visibleText(row, walk.isVisible)),
    table: face,
  }))
  return {
    ...face,
    kind: 'table',
    el,
    ref,
    header,
    rows,
    columns: header.length === 0 ? Math.max(0, ...rows.map(row => row.cells.length)) : header.length,
    pagination: paginationText(el, walk, place),
    container: place.container,
    depth: place.depth,
  }
}

/**
 * Collect a table, unless it is the header half of one already collected or a
 * pinned copy of one.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 */
function pushTable(el: Element, walk: Walk, place: Place): void {
  if (isHeaderPiece(el, walk)) return
  const name = nameOf(el)
  if (duplicate(walk.kept, walk.options.rectOf, `table|${name}`, el)) return
  flush(walk, place)
  walk.items.push(readTable(el, walk, place, name))
}

/**
 * Collect one element that carries a name of its own, and stop there.
 * @param el - the element to collect.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function pushElement(el: Element, role: string, walk: Walk, place: Place): void {
  const name = role === CLICKABLE_ROLE ? clip(visibleText(el, walk.isVisible)) : nameOf(el)
  if (duplicate(walk.kept, walk.options.rectOf, `${role}|${name}`, el)) return
  flush(walk, place)
  const secret = isPassword(el)
  // A checked state says everything a checkbox holds; only the fields that
  // carry text report a value.
  const holdsText = FIELD_ROLES.has(role) && !CHECKED_ROLES.has(role)
  walk.items.push({
    kind: 'element',
    el,
    ref: walk.options.refs.ref(el),
    role,
    name,
    value: secret || !holdsText ? undefined : fieldValue(el),
    secret,
    checked: CHECKED_ROLES.has(role) ? isChecked(el) : undefined,
    disabled: isDisabled(el),
    container: place.container,
    depth: place.depth,
  })
}

/**
 * Collect a dialog the page has not opened. It is the one hidden thing worth a
 * row: the model cannot ask for a dialog it has never been told exists.
 * @param el - the dialog element.
 * @param walk - the walk in progress.
 * @param place - the dialog's position.
 */
function pushClosedDialog(el: Element, walk: Walk, place: Place): void {
  flush(walk, place)
  walk.items.push({
    kind: 'container',
    el,
    ref: walk.options.refs.ref(el),
    type: 'dialog',
    name: containerName(el, () => true),
    container: place.container,
    depth: place.depth,
    closed: true,
  })
}

/**
 * Collect every dialog a subtree the reader cannot see holds, the subtree's own
 * element included. A page that keeps a closed dialog inside a wrapper it hides
 * hides the dialog with it, and the model still needs to know the dialog is
 * there.
 * @param el - the hidden element.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function pushHiddenDialogs(el: Element, walk: Walk, place: Place): void {
  const role = roleOf(el)
  if (role === 'dialog' || role === 'alertdialog') {
    pushClosedDialog(el, walk, place)
    return
  }
  for (const dialog of queryInOrder(el, DIALOG_SELECTOR)) pushClosedDialog(dialog, walk, place)
}

/**
 * Collect a container and everything inside it.
 * @param el - the container element.
 * @param face - what the container prints.
 * @param host - the node holding what the container shows: its own children, an
 * open shadow root's, or a frame document's.
 * @param walk - the walk in progress.
 * @param place - the container's position.
 */
function openContainer(el: Element, face: ContainerFace, host: ParentNode, walk: Walk, place: Place): void {
  if (duplicate(walk.kept, walk.options.rectOf, `${face.type}|${face.name}`, el)) return
  flush(walk, place)
  const item: ContainerItem = {
    ...face,
    kind: 'container',
    el,
    ref: walk.options.refs.ref(el),
    container: place.container,
    depth: place.depth,
    closed: false,
  }
  walk.items.push(item)
  const inside: Place = { container: item, depth: place.depth + 1, buffer: [], root: host, labelled: place.labelled }
  walkNodes(host, walk, inside)
  flush(walk, inside)
}

/**
 * Collect a frame's document as a container, or say that it cannot be read. A
 * frame still loading, and one holding a document that is not HTML, have no
 * body; whatever the document does have is what the walk reads.
 * @param el - the frame element.
 * @param walk - the walk in progress.
 * @param place - the frame's position.
 */
function enterFrame(el: Element, walk: Walk, place: Place): void {
  const doc = frameDocument(el)
  const host = doc?.body ?? doc?.documentElement ?? null
  if (host === null) {
    flush(walk, place)
    walk.items.push({ kind: 'frame-error', container: place.container, depth: place.depth })
    return
  }
  openContainer(el, { type: 'frame', name: nameOf(el) }, host, walk, place)
}

/**
 * True when an element holds something that would earn a row of its own, so it
 * is a wrapper rather than a thing to click.
 * @param host - the node holding what the element shows.
 * @param walk - the walk in progress.
 * @returns whether the subtree holds an item.
 */
function holdsItems(host: ParentNode, walk: Walk): boolean {
  for (const candidate of host.querySelectorAll(ITEM_SELECTOR)) {
    if (!isSkipped(candidate, walk.isVisible)) return true
  }
  return false
}

/**
 * True for the outermost element of a run the page makes clickable. A pointer
 * cursor is inherited, so a wrapper the page marks makes every structural
 * element under it look clickable too; only the top of the run is the thing
 * offered. The cost is that a role-less click target the page nests inside such
 * a wrapper reaches the reader as text rather than as a target of its own.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element tops a clickable run.
 */
function topClickable(el: Element, walk: Walk): boolean {
  if (!walk.isClickable(el)) return false
  // An element a shadow root renders has no parent element and tops its run.
  const parent = el.parentElement
  return parent === null || !walk.isClickable(parent)
}

/**
 * True for a `label` that names a control, whose text the control's row prints.
 * @param el - the element to classify.
 * @returns whether the element labels a control.
 */
function namesControl(el: Element): boolean {
  return el.localName === 'label' && (el as HTMLLabelElement).control !== null
}

/**
 * Collect one element.
 * @param el - the element to collect.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function walkElement(el: Element, walk: Walk, place: Place): void {
  if (isSkipped(el, walk.isVisible)) {
    if (!isNonContent(el)) pushHiddenDialogs(el, walk, place)
    return
  }
  if (el.localName === 'iframe') {
    enterFrame(el, walk, place)
    return
  }
  const role = roleOf(el)
  if (role === 'table' || role === 'grid' || role === 'treegrid') {
    pushTable(el, walk, place)
    return
  }
  const face = containerFace(el, role, walk)
  if (face !== undefined) {
    openContainer(el, face, childHost(el), walk, place)
    return
  }
  if (role !== null && isNameable(role)) {
    pushElement(el, role, walk, place)
    return
  }
  const host = childHost(el)
  if (!place.labelled && topClickable(el, walk) && !holdsItems(host, walk)) {
    pushElement(el, CLICKABLE_ROLE, walk, place)
    return
  }
  walkNodes(host, walk, namesControl(el) ? { ...place, labelled: true } : place)
  // Text either side of an element that flows inside a line is one run; text
  // either side of a block is two.
  if (!isInline(el)) flush(walk, place)
}

/**
 * Collect every child node of one host, text included.
 * @param host - the element, shadow root, or document body to read.
 * @param walk - the walk in progress.
 * @param place - the host's position.
 */
function walkNodes(host: ParentNode, walk: Walk, place: Place): void {
  for (const node of host.childNodes) {
    if (node.nodeType === node.TEXT_NODE) {
      if (!place.labelled) place.buffer.push((node as Text).data)
    } else if (node.nodeType === node.ELEMENT_NODE) walkElement(node as Element, walk, place)
  }
}

/**
 * Walk the page once.
 * @param root - the root document.
 * @param options - the read's options.
 * @param scope - the element to read, or undefined for the whole page.
 * @returns every collected item, in document order.
 */
export function collect(root: Document, options: SnapshotOptions, scope: Element | undefined): Item[] {
  const walk: Walk = {
    options,
    isVisible: options.isVisible,
    isClickable: options.isClickable ?? looksClickable,
    items: [],
    kept: new Map(),
  }
  const place: Place = { container: undefined, depth: 0, buffer: [], root: scope ?? root.body, labelled: false }
  if (scope === undefined) walkNodes(root.body, walk, place)
  else walkElement(scope, walk, place)
  flush(walk, place)
  return walk.items
}
