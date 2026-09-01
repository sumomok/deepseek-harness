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
  frameDocument, isChecked, isDisabled, isInline, isMarked, isNameable, isPassword, isSkipped,
  looksClickable, nameOf, rectsOverlap, roleOf, visibleText,
} from './dom.ts'
import type {
  ContainerFace, ContainerItem, Item, SnapshotOptions, TableItem, TableRowItem,
} from './model.ts'

/** How many items a `ul` or `ol` needs before it reads as a list of its own. */
const LIST_MIN = 3

/** How many buttons an element needs to read as a toolbar without saying so. */
const TOOLBAR_MIN = 2

/** Roles that make a table cell worth naming rather than reading as text. */
const CELL_CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'link', ...FIELD_ROLES])

/** What separates two controls inside one listed cell. */
const ROW_CONTROL_SEPARATOR = '  '

/** The word pages use to mark the strip that pages through a table. */
const PAGINATION_MARKER = 'pagination'

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
 * The container an element opens, if it opens one.
 * @param el - the element to classify.
 * @param role - the element's role.
 * @param walk - the walk in progress.
 * @returns the container face, or undefined for an element that opens none.
 */
function containerFace(el: Element, role: string | null, walk: Walk): ContainerFace | undefined {
  switch (role) {
    case 'main': return { type: 'main', name: nameOf(el) }
    case 'navigation': return { type: 'nav', name: nameOf(el) }
    case 'form': return { type: 'form', name: nameOf(el) }
    case 'dialog': return { type: 'dialog', name: containerName(el, walk.isVisible) }
    case 'toolbar': return { type: 'toolbar', name: nameOf(el) }
    case 'list': return listFace(el)
    case 'region':
    case 'article':
    case 'complementary':
      return sectionFace(el, walk)
    default: return buttonRowFace(el, role, walk)
  }
}

/** One control a table cell holds. */
interface CellControl {
  /** The control element. */
  readonly el: Element
  /** Its role. */
  readonly role: string
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
    if (role !== null && CELL_CONTROL_ROLES.has(role)) found.push({ el: child, role })
    else cellControls(child, walk, found)
  }
}

/** One cell, in the two forms a table prints it. */
interface Cell {
  /** The cell as a listed row prints it, controls carrying their refs. */
  readonly listed: string
  /** The cell as the one-row sample prints it, controls inside `[ ]`. */
  readonly sampled: string
}

/**
 * Read one cell.
 * @param cell - the cell element.
 * @param walk - the walk in progress.
 * @returns the cell's two printed forms.
 */
function readCell(cell: Element, walk: Walk): Cell {
  const controls: CellControl[] = []
  cellControls(cell, walk, controls)
  if (controls.length === 0) {
    const text = clip(visibleText(cell, walk.isVisible))
    return { listed: text, sampled: text }
  }
  const listed = controls
    .map(control => `${walk.options.refs.ref(control.el)} ${control.role} "${nameOf(control.el)}"`)
    .join(ROW_CONTROL_SEPARATOR)
  return { listed, sampled: `[${controls.map(control => nameOf(control.el)).join(' ')}]` }
}

/**
 * Read one row of cells, dropping cells a pinned column repeats.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @param kept - the table's claimed rectangles.
 * @returns the row's cells, in column order.
 */
function readCells(row: Element, walk: Walk, kept: Map<string, DOMRectReadOnly[]>): Cell[] {
  const cells: Cell[] = []
  for (const cell of row.children) {
    const read = readCell(cell, walk)
    if (!duplicate(kept, walk.options.rectOf, `cell|${read.sampled}`, cell)) cells.push(read)
  }
  return cells
}

/**
 * The pagination control that belongs to a table: the first one inside the same
 * container that is not part of the table itself.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @returns the control's text, or undefined when the table has none.
 */
function paginationText(el: Element, walk: Walk, place: Place): string | undefined {
  for (const candidate of place.root.querySelectorAll('*')) {
    if (el.contains(candidate) || !isMarked(candidate, PAGINATION_MARKER) || isSkipped(candidate, walk.isVisible)) continue
    const text = clip(visibleText(candidate, walk.isVisible))
    if (text !== '') return text
  }
  return undefined
}

/**
 * Read a table as its shape: the header, the rows, and what sits beside it.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @returns the collected table.
 */
function readTable(el: Element, walk: Walk, place: Place): TableItem {
  const rows = [...el.querySelectorAll('tr, [role="row"]')]
    .filter(row => row.closest('table, [role="table"], [role="grid"]') === el)
  const headRow = el.querySelector(':scope > thead > tr') ?? rows[0]
  const dataRows = el.querySelector(':scope > tbody') === null
    ? rows.filter(row => row !== headRow)
    : rows.filter(row => row.closest('tbody') !== null)
  const kept = new Map<string, DOMRectReadOnly[]>()
  // Numbered before its contents, so the ref that names the table reads lower
  // than the refs of the controls inside it.
  const ref = walk.options.refs.ref(el)
  const header = headRow === undefined ? [] : readCells(headRow, walk, kept).map(cell => cell.listed)
  const face: { readonly type: 'table'; readonly name: string } = { type: 'table', name: nameOf(el) }
  const collected = dataRows.map((row, index): TableRowItem => {
    const rowRef = walk.options.refs.ref(row)
    const cells = readCells(row, walk, kept)
    return {
      kind: 'row',
      el: row,
      ref: rowRef,
      index: index + 1,
      cells: cells.map(cell => cell.listed),
      sample: cells.map(cell => cell.sampled),
      text: clip(visibleText(row, walk.isVisible)),
      table: face,
    }
  })
  return {
    ...face,
    kind: 'table',
    el,
    ref,
    header,
    rows: collected,
    columns: header.length,
    pagination: paginationText(el, walk, place),
    container: place.container,
    depth: place.depth,
  }
}

/**
 * Collect a table, unless a pinned copy of it is already collected.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 */
function pushTable(el: Element, walk: Walk, place: Place): void {
  if (duplicate(walk.kept, walk.options.rectOf, `table|${nameOf(el)}`, el)) return
  flush(walk, place)
  walk.items.push(readTable(el, walk, place))
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
  const inside: Place = { container: item, depth: place.depth + 1, buffer: [], root: host }
  walkNodes(host, walk, inside)
  flush(walk, inside)
}

/**
 * Collect a frame's document as a container, or say that it cannot be read.
 * @param el - the frame element.
 * @param walk - the walk in progress.
 * @param place - the frame's position.
 */
function enterFrame(el: Element, walk: Walk, place: Place): void {
  const doc = frameDocument(el)
  if (doc === undefined) {
    flush(walk, place)
    walk.items.push({ kind: 'frame-error', container: place.container, depth: place.depth })
    return
  }
  openContainer(el, { type: 'frame', name: nameOf(el) }, doc.body, walk, place)
}

/**
 * Collect one element.
 * @param el - the element to collect.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function walkElement(el: Element, walk: Walk, place: Place): void {
  if (isSkipped(el, walk.isVisible)) {
    if (roleOf(el) === 'dialog') pushClosedDialog(el, walk, place)
    return
  }
  if (el.localName === 'iframe') {
    enterFrame(el, walk, place)
    return
  }
  const role = roleOf(el)
  if (role === 'table' || role === 'grid') {
    pushTable(el, walk, place)
    return
  }
  const face = containerFace(el, role, walk)
  if (face !== undefined) {
    openContainer(el, face, childHost(el), walk, place)
    return
  }
  if (role === null && walk.isClickable(el)) {
    pushElement(el, CLICKABLE_ROLE, walk, place)
    return
  }
  if (role !== null && isNameable(role)) {
    pushElement(el, role, walk, place)
    return
  }
  walkNodes(childHost(el), walk, place)
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
    if (node.nodeType === node.TEXT_NODE) place.buffer.push((node as Text).data)
    else if (node.nodeType === node.ELEMENT_NODE) walkElement(node as Element, walk, place)
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
  const place: Place = { container: undefined, depth: 0, buffer: [], root: scope ?? root.body }
  if (scope === undefined) walkNodes(root.body, walk, place)
  else walkElement(scope, walk, place)
  flush(walk, place)
  return walk.items
}
