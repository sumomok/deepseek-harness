/**
 * One walk of the page, in document order, turning elements into the items a
 * listing renders. The walk enters open shadow roots and same-origin frames, so
 * a page built as a frame inside a frame reads as one document.
 *
 * Two rules keep the result a structure rather than a data dump: a table is
 * collected as its shape (header, one sample row, a row count) and never as its
 * rows, and an element that carries a name of its own — a control, a heading, a
 * click target with nothing inside it — ends the descent, because its
 * accessible name already says what is inside it. An element that both offers
 * something and holds something — a card the page makes clickable, a tree node
 * over the nodes under it — prints its row and is read into all the same.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/collect
 */
import {
  CHECKED_ROLES, CLICKABLE_ROLE, FIELD_ROLES, childHost, clip, clipTo, collapse, containerName,
  fieldValue, frameDocument, headingText, isChecked, isDisabled, isInline, isMarked, isNameable,
  isNonContent, isPassword, isSkipped, looksClickable, markedSelector, nameOf, queryInOrder,
  rectsOverlap, roleOf, visibleText,
} from './dom.ts'
import type {
  CellControl, ContainerFace, ContainerItem, ContainerType, Item, RowCell, SnapshotOptions, TableItem,
  TableRowItem,
} from './model.ts'

/** How many items a `ul` or `ol` needs before it reads as a list of its own. */
const LIST_MIN = 3

/** How many buttons an element needs to read as a toolbar without saying so. */
const TOOLBAR_MIN = 2

/** How much of its own text names a click target the page has not labelled. */
const CLICK_NAME_LIMIT = 40

/** Roles that make a table cell worth naming rather than reading as text. */
const CELL_CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'link', ...FIELD_ROLES])

/** The word pages use to mark the strip that pages through a table. */
const PAGINATION_MARKER = 'pagination'

/** Every element that reads as a table. */
const TABLE_SELECTOR = 'table, [role="table"], [role="grid"], [role="treegrid"]'

/** Every element that reads as a dialog. */
const DIALOG_SELECTOR = 'dialog, [role="dialog"], [role="alertdialog"]'

/**
 * Every element that opens a region of the page, which is how far a table looks
 * for the other half of itself: two tables in two regions are two tables,
 * however they are drawn.
 */
const CONTAINER_SELECTOR = [
  'main', 'nav', 'form', 'section', 'article', 'aside', 'dialog', 'ul', 'ol', 'iframe',
  '[role="main"]', '[role="navigation"]', '[role="form"]', '[role="search"]', '[role="dialog"]',
  '[role="alertdialog"]', '[role="region"]', '[role="article"]', '[role="complementary"]',
  '[role="tabpanel"]', '[role="tablist"]', '[role="menu"]', '[role="menubar"]', '[role="tree"]',
  '[role="radiogroup"]', '[role="listbox"]', '[role="toolbar"]', '[role="list"]', '[role="feed"]',
].join(', ')

/** The group a tree node or a menu item holds the nodes under it in. */
const GROUP_SELECTOR = '[role="group"], [role="menu"], [role="tree"], [role="menubar"]'

/** The region each item role opens when it holds a group of nodes under it. */
const ITEM_NODE_TYPES: ReadonlyMap<string, ContainerType> = new Map([
  ['treeitem', 'treeitem'],
  ['menuitem', 'menuitem'],
  ['menuitemcheckbox', 'menuitem'],
  ['menuitemradio', 'menuitem'],
] as const)

/** Every tag that earns a row of its own wherever it appears. */
const ITEM_TAGS = [
  'a[href]', 'button', 'input', 'select', 'textarea', 'summary', 'iframe', 'table', 'dialog',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img[alt]:not([alt=""])', '[contenteditable]',
].join(', ')

/**
 * Everything that could earn a row of its own, which {@link makesRow} confirms
 * one by one. A click target holding one of these is a wrapper around content
 * as well as a thing to click, so the walk prints it and reads on through it.
 */
const ITEM_SELECTOR = `${ITEM_TAGS}, [role]`

/** Roles that say how an element is drawn rather than what it is. */
const UNTYPED_ROLES: ReadonlySet<string> = new Set(['presentation', 'none', 'generic'])

/**
 * The roles that describe how a page is built and still earn a row: the ones
 * that open a region a reader can be sent to, and the tables.
 */
const ROOM_ROLES: ReadonlySet<string> = new Set([
  'main', 'navigation', 'form', 'search', 'dialog', 'alertdialog', 'region', 'article',
  'complementary', 'tabpanel', 'tablist', 'menu', 'menubar', 'tree', 'radiogroup', 'listbox',
  'toolbar', 'list', 'feed', 'table', 'grid', 'treegrid',
])

/** Everything one walk shares from its first element to its last. */
interface Walk {
  /** The read's options. */
  readonly options: SnapshotOptions
  /** Injected visibility. */
  readonly isVisible: (el: Element) => boolean
  /** Injected clickability, defaulted. */
  readonly isClickable: (el: Element) => boolean
  /** The element the read asked for, which tops whatever the page nests it in. */
  readonly scope: Element | undefined
  /** The items collected so far, in document order. */
  readonly items: Item[]
  /** Rectangles already claimed, keyed by role and name, for dropping repeats. */
  readonly kept: Map<string, DOMRectReadOnly[]>
  /** Each table's rows, sorted once however often the walk asks about them. */
  readonly shapes: Map<Element, TableShape>
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
   * True where the text around the walk is already printed as a name — inside a
   * `label` that names a control, and over the label half of a tree node or
   * menu item. That text and the click targets in it are not rows of their own.
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
 * The cells of one row a reader can see, without the ones a pinned column draws
 * again over the top of them. Picking them reads the page's geometry and not
 * the cells themselves, so a table can report how wide it is without being read.
 * @param row - the row element.
 * @param walk - the walk in progress.
 * @param kept - the table's claimed rectangles.
 * @param key - the row's own key into those rectangles: a cell repeats a cell of
 * its own row, never one of the row above.
 * @returns the cell elements, in column order.
 */
function pickCells(row: Element, walk: Walk, kept: Map<string, DOMRectReadOnly[]>, key: string): Element[] {
  const cells: Element[] = []
  for (const cell of row.children) {
    if (isSkipped(cell, walk.isVisible)) continue
    if (!duplicate(kept, walk.options.rectOf, key, cell)) cells.push(cell)
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
 * Sort one table's rows into its header and its data, once per walk however
 * often the walk asks: a table is asked about by the tables either side of it
 * as well as for itself, and sorting four hundred rows is not free.
 *
 * A `thead` of several rows heads the table by its first row alone, so a table
 * that spreads its column names over a grouping row and a leaf row reports the
 * grouping row as its header; the leaf names reach the reader only in the rows
 * themselves.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @returns the table's shape.
 */
function tableShape(el: Element, walk: Walk): TableShape {
  const known = walk.shapes.get(el)
  if (known !== undefined) return known
  const grouped = new Set(el.querySelectorAll(':scope > thead > tr, :scope > tfoot > tr'))
  const rows = queryInOrder(el, 'tr, [role="row"]').filter(row => row.closest(TABLE_SELECTOR) === el)
  const declared = el.querySelector(':scope > thead > tr') ?? undefined
  const first = rows[0]
  const headRow = declared ?? (first !== undefined && headsColumns(first, walk) ? first : undefined)
  const shape: TableShape = {
    headRow,
    dataRows: rows.filter(row => row !== headRow && !grouped.has(row) && !isSkipped(row, walk.isVisible)),
  }
  walk.shapes.set(el, shape)
  return shape
}

/**
 * The next node in document order.
 * @param node - where the walk stands.
 * @param inside - whether the node's own children come next.
 * @returns the next node, or null at the end of the document.
 */
function nextInOrder(node: Node, inside: boolean): Node | null {
  if (inside && node.firstChild !== null) return node.firstChild
  let at: Node | null = node
  while (at !== null) {
    if (at.nextSibling !== null) return at.nextSibling
    at = at.parentNode
  }
  return null
}

/**
 * True when the page draws nothing at all between two elements: no text a
 * reader can see, nothing that would earn a row. A header frozen over a body
 * has only wrappers between the two halves; a table under a paragraph has the
 * paragraph, and a table inside another is not beside it at all.
 * @param first - the earlier element.
 * @param second - the later element.
 * @param walk - the walk in progress.
 * @returns whether the two are drawn against each other.
 */
function nothingBetween(first: Element, second: Element, walk: Walk): boolean {
  let node: Node | null = nextInOrder(first, false)
  while (node !== null && node !== second) {
    if (node.nodeType === node.ELEMENT_NODE) {
      const el = node as Element
      // What holds the later element is around the gap rather than in it.
      if (el.contains(second)) {
        node = nextInOrder(el, true)
        continue
      }
      const shows = !isSkipped(el, walk.isVisible)
        && (makesRow(el) || holdsItems(el, walk) || visibleText(el, walk.isVisible) !== '')
      if (shows) return false
      node = nextInOrder(el, false)
      continue
    }
    if (node.nodeType === node.TEXT_NODE && collapse((node as Text).data) !== '') return false
    node = nextInOrder(node, false)
  }
  return node === second
}

/**
 * The other half of a table drawn in two pieces — a header frozen over a body
 * that scrolls under it. The halves sit in one region of the page with nothing
 * drawn between them; two tables in two regions, or with a paragraph between
 * them, are two tables.
 * @param el - the table element.
 * @param step - 1 for the table after this one, -1 for the table before it.
 * @param walk - the walk in progress.
 * @returns the neighbouring table, or undefined when the two are not one table.
 */
function splitPartner(el: Element, step: number, walk: Walk): Element | undefined {
  const tables = queryInOrder(el.ownerDocument, TABLE_SELECTOR)
  const other = tables[tables.indexOf(el) + step]
  if (other === undefined || other.closest(CONTAINER_SELECTOR) !== el.closest(CONTAINER_SELECTOR)) return undefined
  const ahead = step === 1
  return nothingBetween(ahead ? el : other, ahead ? other : el, walk) ? other : undefined
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
  const previous = splitPartner(el, -1, walk)
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
  const next = splitPartner(el, 1, walk)
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
 * One data row, read from the page only as far as a listing asks. A whole page
 * prints one sample row and counts the rest, so the rest are counted and not
 * read; a read scoped to the table or filtered by `find` reads what it prints.
 * @param el - the row element.
 * @param index - the row's 1-based position among the data rows.
 * @param walk - the walk in progress.
 * @param kept - the table's claimed rectangles.
 * @param table - the table this row belongs to.
 * @returns the row.
 */
function readRow(
  el: Element,
  index: number,
  walk: Walk,
  kept: Map<string, DOMRectReadOnly[]>,
  table: ContainerFace,
): TableRowItem {
  let picked: Element[] | undefined
  let cells: readonly RowCell[] | undefined
  let text: string | undefined
  const pick = (): Element[] => picked ??= pickCells(el, walk, kept, `cell|${index}`)
  return {
    kind: 'row',
    el,
    index,
    table,
    get width(): number {
      return pick().length
    },
    get cells(): readonly RowCell[] {
      return cells ??= pick().map(cell => readCell(cell, walk))
    },
    get text(): string {
      return text ??= clip(visibleText(el, walk.isVisible))
    },
  }
}

/**
 * Read a table as its shape: the header, the rows, and what sits beside it. The
 * columns are the wider of the header and the widest row, so a table whose
 * header groups columns the rows spell out never reports fewer columns than the
 * sample row beneath it prints.
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
  const header = headRow === undefined
    ? []
    : pickCells(headRow, walk, kept, 'cell|header').map(cell => readCell(cell, walk))
  const face: { readonly type: 'table'; readonly name: string } = { type: 'table', name }
  const rows = shape.dataRows.map((row, index) => readRow(row, index + 1, walk, kept, face))
  return {
    ...face,
    kind: 'table',
    el,
    ref,
    header,
    rows,
    columns: Math.max(header.length, ...rows.map(row => row.width)),
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

/** True for the group a tree node or a menu item holds its nodes in. */
function isGroup(el: Element): boolean {
  return el.matches(GROUP_SELECTOR)
}

/**
 * What a row calls the element it names: what a click target shows, what a tree
 * node or menu item shows outside the group under it, and the accessible name
 * of everything else. A tree node named by everything inside it would carry the
 * text of every node under it.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function elementName(el: Element, role: string, walk: Walk): string {
  if (role === CLICKABLE_ROLE) return clip(visibleText(el, walk.isVisible))
  if (ITEM_NODE_TYPES.has(role)) return clip(visibleText(el, walk.isVisible, isGroup))
  return nameOf(el)
}

/**
 * Collect one element that carries a name of its own, and stop there.
 * @param el - the element to collect.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 */
function pushElement(el: Element, role: string, walk: Walk, place: Place): void {
  const name = elementName(el, role, walk)
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
    // A node the page has closed says so: what it holds is not missing from the
    // read, it is folded away until something opens it.
    collapsed: ITEM_NODE_TYPES.has(role) && el.getAttribute('aria-expanded') === 'false',
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
 * True for an element that earns a row of its own — a control, a heading, a
 * region, a table. A role the page wrote counts unless it says the element is
 * decoration; a role that only says how the page is built counts when it opens
 * a room a reader can be sent to.
 * @param el - the element to classify.
 * @returns whether the element would print a row.
 */
function makesRow(el: Element): boolean {
  if (el.matches(ITEM_TAGS)) return true
  if (!el.hasAttribute('role')) return false
  const role = roleOf(el)
  if (role === null || UNTYPED_ROLES.has(role)) return false
  return isNameable(role) || ROOM_ROLES.has(role)
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
 * @param labelled - whether the text inside is already printed as this
 * container's name, which is true of the label half of a tree node or menu item
 * and of nothing else: a region reached from inside a label starts a name of
 * its own.
 */
function openContainer(
  el: Element,
  face: ContainerFace,
  host: ParentNode,
  walk: Walk,
  place: Place,
  labelled: boolean,
): void {
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
  const inside: Place = { container: item, depth: place.depth + 1, buffer: [], root: host, labelled }
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
  openContainer(el, { type: 'frame', name: nameOf(el) }, host, walk, place, false)
}

/**
 * True when an element holds something that would earn a row of its own, so it
 * is a wrapper around content as well as whatever else it is.
 * @param host - the node holding what the element shows.
 * @param walk - the walk in progress.
 * @returns whether the subtree holds an item.
 */
function holdsItems(host: ParentNode, walk: Walk): boolean {
  for (const candidate of host.querySelectorAll(ITEM_SELECTOR)) {
    if (!isSkipped(candidate, walk.isVisible) && makesRow(candidate)) return true
  }
  return false
}

/**
 * True when a tree node or menu item holds a group of nodes the reader can see,
 * which makes it a region to read into rather than one row.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element holds a group.
 */
function holdsGroup(el: Element, walk: Walk): boolean {
  for (const group of el.querySelectorAll(GROUP_SELECTOR)) {
    if (!isSkipped(group, walk.isVisible)) return true
  }
  return false
}

/**
 * True for the outermost element of a run the page makes clickable. A pointer
 * cursor is inherited, so a wrapper the page marks makes every structural
 * element under it look clickable too; only the top of the run is the thing
 * offered. A read that names an element by ref tops the run at that element:
 * the model asked for it, so it is what this read shows.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element tops a clickable run.
 */
function topClickable(el: Element, walk: Walk): boolean {
  if (!walk.isClickable(el)) return false
  // An element a shadow root renders has no parent element and tops its run.
  const parent = el.parentElement
  return el === walk.scope || parent === null || !walk.isClickable(parent)
}

/**
 * True for a `label` naming a control the reader can see, whose text that
 * control's row prints. A label for a control the page hides prints nothing of
 * its own, so its text is all the reader has of it.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element labels a control this read shows.
 */
function namesControl(el: Element, walk: Walk): boolean {
  if (el.localName !== 'label') return false
  const control = (el as HTMLLabelElement).control
  return control !== null && !isSkipped(control, walk.isVisible)
}

/**
 * What a click target the page has not labelled is called: what it says it is,
 * the title it shows, or the start of the text it shows.
 * @param el - the click target.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function clickableName(el: Element, walk: Walk): string {
  const label = collapse(el.getAttribute('aria-label') ?? '')
  if (label !== '') return clip(label)
  const heading = headingText(el, walk.isVisible)
  return heading === '' ? clipTo(visibleText(el, walk.isVisible), CLICK_NAME_LIMIT) : heading
}

/**
 * Where the walk stands inside an element, which turns the suppression of text
 * already printed as a name on at a `label` and off again inside the group a
 * tree node holds its nodes in.
 * @param el - the element being descended into.
 * @param walk - the walk in progress.
 * @param place - the element's position.
 * @returns the position to read the element's children at.
 */
function labelPlace(el: Element, walk: Walk, place: Place): Place {
  const labelled = namesControl(el, walk) || (place.labelled && !isGroup(el))
  return labelled === place.labelled ? place : { ...place, labelled }
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
    openContainer(el, face, childHost(el), walk, place, false)
    return
  }
  if (role !== null) {
    const node = ITEM_NODE_TYPES.get(role)
    if (node !== undefined && holdsGroup(el, walk)) {
      // The node's own text names it, and the group under it holds the rows.
      openContainer(el, { type: node, name: elementName(el, role, walk) }, childHost(el), walk, place, true)
      return
    }
    if (isNameable(role)) {
      pushElement(el, role, walk, place)
      return
    }
  }
  const host = childHost(el)
  if (!place.labelled && !namesControl(el, walk) && topClickable(el, walk)) {
    // A click target holding items is both: the row says what clicking it does,
    // and the rows under it say what it holds.
    if (holdsItems(host, walk)) openContainer(el, { type: 'clickable', name: clickableName(el, walk) }, host, walk, place, false)
    else pushElement(el, CLICKABLE_ROLE, walk, place)
    return
  }
  walkNodes(host, walk, labelPlace(el, walk, place))
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
    scope,
    items: [],
    kept: new Map(),
    shapes: new Map(),
  }
  const place: Place = { container: undefined, depth: 0, buffer: [], root: scope ?? root.body, labelled: false }
  if (scope === undefined) walkNodes(root.body, walk, place)
  else walkElement(scope, walk, place)
  flush(walk, place)
  return walk.items
}
