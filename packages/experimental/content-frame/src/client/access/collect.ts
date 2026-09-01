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
  CHECKED_ROLES, CLICKABLE_ROLE, DIALOG_SELECTOR, FIELD_ROLES, childHost, clip, clipTo, collapse,
  containerName, fieldValue, frameDocument, headingText, isChecked, isDisabled, isDrawing, isInline,
  isMarked, isNameable, isNonContent, isPassword, isSkipped, looksClickable, markedSelector, nameOf,
  queryInOrder, rectsOverlap, roleOf, visibleText,
} from './dom.ts'
import type {
  CellControl, ContainerFace, ContainerItem, ContainerType, ControlState, Item, RowCell,
  SnapshotOptions, TableItem, TableRowItem,
} from './model.ts'

/** How many items a `ul` or `ol` needs before it reads as a list of its own. */
const LIST_MIN = 3

/** How many buttons an element needs to read as a toolbar without saying so. */
const TOOLBAR_MIN = 2

/** How much of its own text names a click target the page has not labelled. */
const CLICK_NAME_LIMIT = 40

/**
 * How much of a cell the one sample row of a table block shows: enough to say
 * what the column holds. The cut is made on the cell's own text, before the
 * controls beside it are added, so a column whose text runs long still says
 * which controls it offers.
 */
const SAMPLE_CELL_LIMIT = 24

/** Roles that make a table cell worth naming rather than reading as text. */
const CELL_CONTROL_ROLES: ReadonlySet<string> = new Set(['button', 'link', ...FIELD_ROLES])

/** The word pages use to mark the strip that pages through a table. */
const PAGINATION_MARKER = 'pagination'

/** Every element that reads as a table. */
const TABLE_SELECTOR = 'table, [role="table"], [role="grid"], [role="treegrid"]'

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

/**
 * Every tag that earns a row of its own wherever it appears. A field the page
 * carries but never shows, and an element it marks as not editable, are neither
 * offered nor read: they are how the page stores what it knows.
 */
const ITEM_TAGS = [
  'a[href]', 'button', 'input:not([type="hidden"])', 'select', 'textarea', 'summary', 'iframe',
  'table', 'dialog', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img[alt]:not([alt=""])',
  '[contenteditable]:not([contenteditable="false"])',
].join(', ')

/**
 * Everything that could earn a row of its own, which {@link makesRow} confirms
 * one by one. A click target holding one of these is a wrapper around content
 * as well as a thing to click, so the walk prints it and reads on through it.
 * The regions come by tag as well as by role: HTML gives `nav` and `main` their
 * roles, and the page writes no attribute for the walk to match.
 */
const ITEM_SELECTOR = `${ITEM_TAGS}, [role], main, nav, form, section, article, aside, ul, ol`

/**
 * The tags a page draws something with rather than writes something in. None of
 * them earns a row, and all of them are the page putting a picture between the
 * two things either side of it.
 */
const DRAWN_TAGS = 'hr, img, svg, canvas, video, audio, picture, embed, object'

/**
 * The regions a page is laid out in, rather than the ones it draws inside a
 * card. A run the page makes clickable that reaches one of these is not a thing
 * to click: the cursor was inherited from something above, and the region
 * inside it is the page itself. A form and a dialog are left out because a card
 * holds either one readily — an inline editor, a confirmation over the card —
 * and the card is still the thing the page offers to click.
 */
const LANDMARK_SELECTOR = [
  'main', 'nav',
  '[role="main"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
].join(', ')

/**
 * The roles of the things a page offers to act on. A click target wrapped
 * tightly around exactly one of them is that control's own hit area, not a
 * second thing to click.
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem',
  ...FIELD_ROLES,
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
 * What a control holds and how the page has set it, read the same way wherever
 * a row prints it.
 * @param el - the control element.
 * @param role - the role it prints.
 * @returns the state.
 */
function controlState(el: Element, role: string): ControlState {
  const secret = isPassword(el)
  // A checked state says everything a checkbox holds; only the fields that
  // carry text report a value.
  const holdsText = FIELD_ROLES.has(role) && !CHECKED_ROLES.has(role)
  return {
    value: secret || !holdsText ? undefined : fieldValue(el),
    secret,
    checked: CHECKED_ROLES.has(role) ? isChecked(el) : undefined,
    disabled: isDisabled(el),
  }
}

/** True for an element a cell names rather than reads as part of its text. */
function isCellControl(el: Element): boolean {
  const role = roleOf(el)
  return role !== null && CELL_CONTROL_ROLES.has(role)
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
    if (role !== null && CELL_CONTROL_ROLES.has(role)) {
      found.push({ el: child, role, name: nameOf(child), ...controlState(child, role) })
    }
    else cellControls(child, walk, found)
  }
}

/**
 * How one control reads inside the one sample row a table block prints: what it
 * is called, or what it is where the page has named it nothing, and whether it
 * is currently on. The sample says what the column holds, so the controls are
 * named and their values are not.
 * @param control - the cell's control.
 * @returns the sample text for that control.
 */
function controlSample(control: CellControl): string {
  return `${control.name === '' ? control.role : control.name}${control.checked === true ? ' x' : ''}`
}

/**
 * Read one cell: what it says, and the controls it offers. A cell that holds
 * both says both — a status beside the button that changes it is what the
 * column is for.
 *
 * The sample is cut here rather than where it is printed, because what the
 * sample is for is saying which controls the column offers: cutting the line
 * afterwards would cut those off the end of a cell whose text runs long, and
 * the reader would take the column for one that offers nothing. The text gives
 * way to the controls, and a control list longer than the whole allowance is
 * printed on its own.
 * @param cell - the cell element.
 * @param walk - the walk in progress.
 * @returns the cell.
 */
function readCell(cell: Element, walk: Walk): RowCell {
  const controls: CellControl[] = []
  cellControls(cell, walk, controls)
  const text = clip(visibleText(cell, walk.isVisible, isCellControl))
  if (controls.length === 0) return { controls, text, sample: clipTo(text, SAMPLE_CELL_LIMIT) }
  const inside = `[${controls.map(controlSample).join(' ')}]`
  const room = SAMPLE_CELL_LIMIT - inside.length - 1
  const shown = room > 0 ? clipTo(text, room) : ''
  return { controls, text, sample: shown === '' ? inside : `${shown} ${inside}` }
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
 * reader can see, nothing that would earn a row, no picture or rule. A header
 * frozen over a body has only wrappers between the two halves; a table under a
 * paragraph has the paragraph, and a table inside another is not beside it at
 * all.
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
        && (el.matches(DRAWN_TAGS) || makesRow(el, walk) || holdsItems(el, walk)
          || visibleText(el, walk.isVisible) !== '')
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
 * them, are two tables. Two names the page wrote and meant differently are two
 * tables as well: the halves of one table are one thing to name, and a page
 * that names both halves at all names them the same.
 *
 * The search runs over the whole document rather than the read's scope, so a
 * read scoped to the body half still finds the header above it.
 * @param el - the table element.
 * @param step - 1 for the table after this one, -1 for the table before it.
 * @param walk - the walk in progress.
 * @returns the neighbouring table, or undefined when the two are not one table.
 */
function splitPartner(el: Element, step: number, walk: Walk): Element | undefined {
  const tables = queryInOrder(el.ownerDocument, TABLE_SELECTOR)
  const other = tables[tables.indexOf(el) + step]
  if (other === undefined || other.closest(CONTAINER_SELECTOR) !== el.closest(CONTAINER_SELECTOR)) return undefined
  const name = nameOf(el)
  const otherName = nameOf(other)
  if (name !== '' && otherName !== '' && name !== otherName) return undefined
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
 * columns are the wider of the header and the first data row, so a table whose
 * header groups columns the rows spell out never reports fewer columns than the
 * sample row beneath it prints. Only that one row is measured: asking every row
 * how wide it is would read the geometry of every cell of a table the read is
 * about to report by its shape alone.
 * @param el - the table element.
 * @param walk - the walk in progress.
 * @param place - the table's position.
 * @param name - the table's accessible name.
 * @param piece - the header half this table is drawn under, if any.
 * @returns the collected table.
 */
function readTable(el: Element, walk: Walk, place: Place, name: string, piece: Element | undefined): TableItem {
  const shape = tableShape(el, walk)
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
    columns: Math.max(header.length, rows[0]?.width ?? 0),
    pagination: paginationText(el, walk, place),
    container: place.container,
    depth: place.depth,
  }
}

/**
 * What a table is called: its own name, or the name of the header half it is
 * drawn under. The halves of a table drawn in two pieces are one table, so a
 * page that named the header and left the body unnamed named the table.
 * @param el - the table element.
 * @param piece - the header half this table is drawn under, if any.
 * @returns the name, empty when neither half carries one.
 */
function tableName(el: Element, piece: Element | undefined): string {
  const name = nameOf(el)
  if (name !== '') return name
  return piece === undefined ? '' : nameOf(piece)
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
  const piece = headerPiece(el, walk, tableShape(el, walk))
  const name = tableName(el, piece)
  if (duplicate(walk.kept, walk.options.rectOf, `table|${name}`, el)) return
  flush(walk, place)
  walk.items.push(readTable(el, walk, place, name, piece))
}

/** True for the group a tree node or a menu item holds its nodes in. */
function isGroup(el: Element): boolean {
  return el.matches(GROUP_SELECTOR)
}

/**
 * True inside a tree node or a menu item, whose group of nodes is part of the
 * node rather than a region beside it.
 * @param container - the container the walk currently stands in.
 * @returns whether that container is a node holding other nodes.
 */
function holdsNodes(container: ContainerItem | undefined): boolean {
  return container?.type === 'treeitem' || container?.type === 'menuitem'
}

/**
 * The name the page wrote for an element, which outranks anything it shows: a
 * menu item drawn as an icon says what it is nowhere else. Only what the label
 * itself carries counts — the text of the label attribute, or the text of every
 * element the page points at, in the order it points at them. An empty label,
 * and one pointing at nothing the page has, name nothing at all and leave the
 * element to be named by what it shows.
 *
 * An element pointed at is read whether or not the reader can see it: a page
 * that names a node by a run of text it draws nowhere still named it, which is
 * how ARIA defines the reference.
 * @param el - the element to name.
 * @returns the written name, empty when the page wrote none.
 */
function declaredName(el: Element): string {
  const label = clip(collapse(el.getAttribute('aria-label') ?? ''))
  if (label !== '') return label
  const ids = collapse(el.getAttribute('aria-labelledby') ?? '')
  if (ids === '') return ''
  const parts = ids.split(' ')
    .map(id => el.ownerDocument.getElementById(id))
    .filter(ref => ref !== null)
    .map(ref => visibleText(ref, () => true))
  return clip(collapse(parts.join(' ')))
}

/**
 * True for a child whose own row prints its text, so the element around it is
 * not named by that text as well.
 * @param el - the child to classify.
 * @returns whether the child prints a row that names itself.
 */
function namesItself(el: Element): boolean {
  const role = roleOf(el)
  return role !== null && isNameable(role)
}

/**
 * The first thing inside a node that prints a row of its own, in document
 * order, which is the node's label where the page drew that label as a link or
 * a heading. The group of nodes under this one is not looked into: what it
 * holds are nodes of its own, never a label for the node above them.
 * @param el - the node to look inside.
 * @param walk - the walk in progress.
 * @returns the element, or undefined when the node holds none.
 */
function firstNamed(el: Element, walk: Walk): Element | undefined {
  for (const child of childHost(el).children) {
    if (isSkipped(child, walk.isVisible) || isGroup(child)) continue
    if (namesItself(child)) return child
    const inside = firstNamed(child, walk)
    if (inside !== undefined) return inside
  }
  return undefined
}

/**
 * What a row calls the element it names: what the page wrote, what a tree node
 * or menu item shows of its own, what a click target shows, and the accessible
 * name of everything else.
 *
 * A node is named by its own label and not by what hangs off it: the nodes in
 * the group under it print rows of their own, and so do the buttons that act on
 * it. A node whose label is itself one of those — a node drawn as a link, or
 * over a heading — is named by that one alone, and not by the row of buttons
 * drawn beside it.
 *
 * A click target holding nothing is named by the whole of what it shows, up to
 * the length of any other row; a target that is a room is named by the start of
 * it, because everything it shows is printed again in the rows under it. See
 * {@link clickableName}, which makes that cut.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function ownName(el: Element, role: string, walk: Walk): string {
  const declared = declaredName(el)
  if (declared !== '') return declared
  if (role === CLICKABLE_ROLE) return clip(visibleText(el, walk.isVisible))
  const own = clip(visibleText(el, walk.isVisible, child => isGroup(child) || namesItself(child)))
  if (own !== '') return own
  const label = firstNamed(el, walk)
  const named = label === undefined ? '' : clip(visibleText(label, walk.isVisible))
  return named === '' ? clip(visibleText(el, walk.isVisible, isGroup)) : named
}

/**
 * What a row calls the element it names.
 * @param el - the element to name.
 * @param role - the role it prints.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function elementName(el: Element, role: string, walk: Walk): string {
  return role === CLICKABLE_ROLE || ITEM_NODE_TYPES.has(role) ? ownName(el, role, walk) : nameOf(el)
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
  walk.items.push({
    kind: 'element',
    el,
    ref: walk.options.refs.ref(el),
    role,
    name,
    ...controlState(el, role),
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
 * region, a table. The question is asked before the walk gets there: an element
 * the page draws between two halves of a table has to count for what it will
 * print, and a click target has to know whether it wraps content or only itself.
 *
 * It is the judgement {@link walkElement} makes on the same element, apart from
 * two cases neither caller needs it to cover. A click target is not asked about
 * here — the walk prints a `clickable` row for one, and the callers ask about
 * what a target holds rather than about the target itself. An element the page
 * marks as decoration and draws with an interactive tag is counted here by that
 * tag, where the walk prints nothing for it.
 * @param el - the element to classify.
 * @param walk - the walk in progress.
 * @returns whether the element would print a row.
 */
function makesRow(el: Element, walk: Walk): boolean {
  if (el.matches(ITEM_TAGS)) return true
  const role = roleOf(el)
  // The order is the walk's own: a row of buttons opens a toolbar whether or
  // not the page gave it a role, and a role reaches a row of its own only where
  // it opens no region.
  if (containerFace(el, role, walk) !== undefined) return true
  if (role === null) return false
  return role === 'table' || role === 'grid' || role === 'treegrid' || isNameable(role)
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
    if (!isSkipped(candidate, walk.isVisible) && makesRow(candidate, walk)) return true
  }
  return false
}

/**
 * Every row an element holds at the top of what it holds: the rows inside one
 * of these belong to it and not to the element around them.
 * @param host - the node holding what the element shows.
 * @param walk - the walk in progress.
 * @returns the outermost elements that would each print a row, in document order.
 */
function topItems(host: ParentNode, walk: Walk): Element[] {
  const found: Element[] = []
  for (const candidate of host.querySelectorAll(ITEM_SELECTOR)) {
    if (isSkipped(candidate, walk.isVisible) || !makesRow(candidate, walk)) continue
    if (!found.some(other => other.contains(candidate))) found.push(candidate)
  }
  return found
}

/**
 * True for a click target the walk reads straight through, printing no row of
 * its own: one wrapped around a single control and saying exactly what that
 * control says, and one that reaches a region the page is laid out in. The
 * first is the control's own hit area — a list item drawn around a link — and
 * printing it twice would have the model choosing between two rows for one
 * thing. The second is a pointer cursor inherited over half the page.
 *
 * A target the page labelled is read as itself either way: a page that wrote a
 * name for it said it is a thing of its own, whatever it wraps.
 * @param el - the click target.
 * @param items - the rows it holds, from {@link topItems}.
 * @param walk - the walk in progress.
 * @returns whether the target is the page's own wrapping rather than a thing to click.
 */
function wrapsOnly(el: Element, items: readonly Element[], walk: Walk): boolean {
  if (items.length === 0) return false
  for (const landmark of childHost(el).querySelectorAll(LANDMARK_SELECTOR)) {
    if (!isSkipped(landmark, walk.isVisible)) return true
  }
  const only = items.length === 1 ? items[0] : undefined
  if (only === undefined || declaredName(el) !== '') return false
  const role = roleOf(only)
  return role !== null && INTERACTIVE_ROLES.has(role)
    && visibleText(el, walk.isVisible) === visibleText(only, walk.isVisible)
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
 * What a click target holding rows is called: what the page says it is, the
 * title it shows, or the start of the text it shows. Only the start, unlike the
 * name of a target holding nothing: a target with nothing inside it is its own
 * text, while everything a room shows is printed again in the rows under it.
 * @param el - the click target.
 * @param walk - the walk in progress.
 * @returns the name.
 */
function clickableName(el: Element, walk: Walk): string {
  const declared = declaredName(el)
  if (declared !== '') return declared
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
  if (isDrawing(el)) {
    // A drawing is one thing however many shapes it is built from: reading into
    // it would break the run of text around an icon at every path in it, and
    // print the tooltip it carries as text of the page. A drawing the page named
    // is a picture with a row of its own; an unnamed one is decoration, and
    // decoration ends no run.
    const drawn = roleOf(el)
    if (drawn !== null && isNameable(drawn)) pushElement(el, drawn, walk, place)
    return
  }
  const role = roleOf(el)
  if (role === 'table' || role === 'grid' || role === 'treegrid') {
    pushTable(el, walk, place)
    return
  }
  if (isGroup(el) && holdsNodes(place.container)) {
    // The group under a node is the node's own: a room of its own between them
    // would carry no name, and would tell the rows under it they live in it
    // rather than in the node the reader is looking at.
    flush(walk, place)
    walkNodes(childHost(el), walk, { ...place, labelled: false })
    flush(walk, place)
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
    const items = topItems(host, walk)
    if (!wrapsOnly(el, items, walk)) {
      // A click target holding items is both: the row says what clicking it
      // does, and the rows under it say what it holds.
      if (items.length > 0) openContainer(el, { type: 'clickable', name: clickableName(el, walk) }, host, walk, place, false)
      else pushElement(el, CLICKABLE_ROLE, walk, place)
      return
    }
  }
  // Text either side of an element that flows inside a line is one run; text
  // either side of a block is two, whichever side of the block it is on.
  if (!isInline(el)) flush(walk, place)
  walkNodes(host, walk, labelPlace(el, walk, place))
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
