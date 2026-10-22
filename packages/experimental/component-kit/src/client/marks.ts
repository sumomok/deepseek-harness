/**
 * What the kit's blocks mark their controls with, and how those marks are kept
 * on a subtree a vendored Vue component draws.
 *
 * `act_component` addresses an element of a drawn block by the block's own
 * declaration and never by a DOM reference, so every control a block reports
 * from carries the attribute that says what it is: `data-component-action` for
 * the action a control performs, `data-component-key` for the control's own key
 * where one action is performed by several controls (a confirmation bar's
 * buttons, a table row's operation links), `data-component-field` for a
 * field, named as the column or property it is, and `data-component-row` for
 * the record a table row draws, keyed the way its block keys its rows. The renderers write these
 * attributes onto the markup they draw themselves; the controls inside a
 * vendored Vue component are drawn after the React commit and again whenever
 * that component renders on its own state, so this module marks them from the
 * DOM at mount and after every change below the block.
 *
 * The selectors are the vendored builds' own markup, written against the exact
 * tarballs this row vendors (`@sumomok/toy-surface-kit` 0.3.1 and
 * `@sumomok/toy-crud-kit` 0.6.1). A control a build stops drawing is one this
 * module stops marking, which the marker tests fail on rather than a mark that
 * lands on the wrong element; the kit's README states what a rebuild of either
 * tarball has to keep.
 * @module @deepseek-ai/dsh-experimental-component-kit/client/marks
 */
import { useEffect, useRef, type RefObject } from 'react'
import { isTarget } from '@deepseek-ai/dsh-experimental-component-surface/client'

/** The attribute naming the action a control performs. */
const ACTION_MARK = 'data-component-action'

/** The attribute naming a control's own key, where its action is performed by several controls. */
const KEY_MARK = 'data-component-key'

/** The attribute naming the column or property a field writes. */
export const FIELD_MARK = 'data-component-field'

/** The attribute naming the row a control is drawn in, by the key the block gives that row. */
export const ROW_MARK = 'data-component-row'

/** The attribute, carrying no value, marking the cell whose words are its row's name. */
export const ROW_NAME_MARK = 'data-component-row-name'

/** The one action a table's selection controls report. */
const SELECT_ACTION = 'select'

/** The action every per-row operation control reports, whichever key it carries. */
const OPERATION_ACTION = 'operation'

/*
 * Every cell of one table is drawn twice: once in the body wrapper a person
 * scrolls, and once in the fixed-column layer el-table stands over it. Of the
 * two drawings exactly one is where the column stands — the other is
 * el-table's `is-hidden` placeholder, which takes no point a person can click
 * — so each selector below marks the drawn copy in both wrappers and the
 * hidden one in neither. A control `act_component` addresses is then one a
 * person can click wherever the table drew the column fixed or not.
 */

/** The two wrappers one table draws its body in: the one a person scrolls, and the fixed layer's copy. */
const BODY_WRAPPERS = ['.el-table__body-wrapper', '.el-table__fixed-body-wrapper'] as const

/** The two wrappers it draws its headings in, likewise. */
const HEADER_WRAPPERS = ['.el-table__header-wrapper', '.el-table__fixed-header-wrapper'] as const

/**
 * One selector per wrapper, so a trailing descendant applies to each of them.
 * @param wrappers - the wrappers to write the selector under.
 * @param selector - what is drawn under each.
 * @returns the selector list.
 */
function under(wrappers: readonly string[], selector: string): string {
  return wrappers.map(wrapper => `${wrapper} ${selector}`).join(', ')
}

/** Every control a table's selection reports from, in both the drawn modes. */
const SELECT_CONTROLS = [
  under(BODY_WRAPPERS, 'tbody td:not(.is-hidden) .el-checkbox__original'),
  under(BODY_WRAPPERS, 'tbody td:not(.is-hidden) .el-radio__original'),
].join(', ')

/** One table's scrolling body, where every column of a row is drawn. */
const MAIN_BODY = ':scope > .el-table__body-wrapper tbody'

/** The body of one table's left fixed layer, where a fixed name column is drawn. */
const LEFT_BODY = ':scope > .el-table__fixed .el-table__fixed-body-wrapper tbody'

/** The body of one table's right fixed layer, where a fixed operation column is drawn. */
const RIGHT_BODY = ':scope > .el-table__fixed-right .el-table__fixed-body-wrapper tbody'

/** One record's row in a table body, without the rows el-table draws for anything else. */
const RECORD_ROW = 'tr.el-table__row'

/** A drawn cell a click may open its row from: not a placeholder, and not the selection column's. */
const OPENABLE_CELL = 'td:not(.is-hidden):not(.el-table-column--selection)'

/** The link a name or a relation column draws, which opens the record it names. */
const RECORD_LINK = 'a.trans'

/** The heading of every column the user may sort, in whichever wrapper draws it. */
const SORT_HEADINGS = under(HEADER_WRAPPERS, 'th.is-sortable:not(.is-hidden)')

/** One row's operation cell, where its per-row buttons are drawn. */
const OPERATION_CELLS = under(BODY_WRAPPERS, 'tbody td:not(.is-hidden) .column-operation')

/** The built-in modify control a data page's operation column draws. */
const BUILTIN_MODIFY = '.operation-modify'

/** The built-in delete control a data page's operation column draws, with the confirmation bubble it opens. */
const BUILTIN_DELETE = under(BODY_WRAPPERS, 'tbody td:not(.is-hidden) .operation-delete')

/**
 * The confirming control inside that bubble: the button that performs the
 * delete once a person has answered it. The bubble is drawn with the row's
 * operation cell and kept in the document while it is closed, so the control
 * is marked from the mount on and the press that answers the bubble is the
 * one a delete reports from.
 */
const DELETE_CONFIRM = under(BODY_WRAPPERS, 'tbody td:not(.is-hidden) .column-operation .el-popover .el-button--primary')

/** One declared custom operation's control, as both builds draw it: the link inside its wrapper. */
const CUSTOM_OPERATION = '.operation-custom a'

/**
 * What one table block reports, in the catalog's own vocabulary, read off the
 * block's properties: the markup alone cannot tell a cell that reports nothing
 * from one that reports a row.
 */
export interface TableMarks {
  /**
   * The table the row marks are written in, as a selector under the block's
   * subtree; the first table drawn there when absent.
   */
  readonly table?: string
  /** The action a click on a row's opening cell reports; absent for a table whose rows do not open. */
  readonly row?: string
  /**
   * The action a record link in a row reports; absent for a table whose links
   * report nothing. Each link carries its column's property as its own key.
   */
  readonly link?: string
  /**
   * How each drawn row is keyed, read at every pass; absent for a table whose
   * rows carry no key and no name mark.
   */
  readonly rowKeys?: RowKeys
  /** The action a sortable heading reports; absent for a table that reports no sort. */
  readonly sort?: string
  /** The per-row operation controls, where the block draws any. */
  readonly operations?: {
    /** The key the built-in modify control carries; absent where the arrangement keeps none. */
    readonly builtin?: string
    /** The keys of the declared custom operations, in the order a row draws them. */
    readonly custom: readonly string[]
  }
}

/**
 * How one table's drawn rows are keyed.
 * @param rows - the scrolling body's record rows, in the order drawn.
 * @returns one key per row, `undefined` for a row that carries none, or
 *   `undefined` altogether where the rows cannot be keyed on this pass, which
 *   leaves every key already written as it is.
 */
export type RowKeys = (rows: readonly Element[]) => readonly (string | undefined)[] | undefined

/**
 * Keep a block's controls marked for as long as it is mounted.
 *
 * A MutationObserver rather than one pass per React commit: a vendored
 * component re-renders on state of its own, and every element it draws afresh
 * — a cell after a query, a dialog after a press — has to be marked again.
 * The pass is idempotent, so a change that adds nothing leaves every mark as
 * it was.
 * @param root - the element the block's controls live under, which Vue draws into.
 * @param apply - marks every control it can find under the root.
 * @returns the release, which stops watching.
 */
export function keepMarked(root: Element, apply: (root: Element) => void): () => void {
  apply(root)
  const observer = new MutationObserver(() => { apply(root) })
  observer.observe(root, { childList: true, subtree: true })
  return () => { observer.disconnect() }
}

/**
 * Keep a mounted block's controls marked from its current properties.
 *
 * Every pass reads the properties the block was last rendered with, so a
 * placing call that changes them within one mount has the controls it redraws
 * marked as it now declares them.
 * @param target - the element the block's controls live under, attached by the first effect.
 * @param props - the block's properties, as this render draws them.
 * @param mark - marks every control under the root from those properties; the mount's instance is the one used.
 */
export function useKeptMarks<Props>(
  target: RefObject<Element>,
  props: Props,
  mark: (root: Element, props: Props) => void,
): void {
  const current = useRef(props)
  useEffect(() => { current.current = props })
  useEffect(() => keepMarked(target.current as Element, (root) => { mark(root, current.current) }), [])
}

/**
 * Write one marker on every element a selector finds.
 * @param root - the subtree to search, itself excluded.
 * @param selector - what the controls of one kind are.
 * @param attribute - the attribute to write.
 * @param value - the value to write.
 */
function markAll(root: Element, selector: string, attribute: string, value: string): void {
  for (const el of root.querySelectorAll(selector)) el.setAttribute(attribute, value)
}

/**
 * The record rows one table body draws, in the order the table draws its records.
 * @param body - the body, or `null` where the table draws none of that kind.
 * @returns the rows.
 */
function recordRows(body: Element | null): Element[] {
  return body === null ? [] : [...body.children].filter(row => row.matches(RECORD_ROW))
}

/**
 * The cells of one drawn row a click could open the row from, in the order
 * drawn: neither a placeholder nor the selection column's, and not the cell
 * holding the row's operations.
 * @param row - the row, or `undefined` where the body draws none at that position.
 * @returns the cells.
 */
function openableCells(row: Element | undefined): Element[] {
  if (row === undefined) return []
  return [...row.children].filter(cell => cell.matches(OPENABLE_CELL) && cell.querySelector('.column-operation') === null)
}

/**
 * The one cell each record is opened from: its name cell, which is the one
 * cell besides the selection column's that the left fixed layer draws for it,
 * and where no fixed layer draws a name column, the first openable cell the
 * scrolling body draws.
 * @param main - the scrolling body's record rows.
 * @param left - the left fixed layer's record rows, empty where the table draws none.
 * @returns the cells, one per record at most.
 */
function openingCells(main: readonly Element[], left: readonly Element[]): Set<Element> {
  const opening = new Set<Element>()
  for (const [at, row] of main.entries()) {
    const named = openableCells(left[at])
    const cell = named.length === 1 ? named[0] : openableCells(row)[0]
    if (cell !== undefined) opening.add(cell)
  }
  return opening
}

/**
 * Mark the one cell each record is opened from with the table's row action,
 * and take the action off every other cell of the table: a pass made before
 * the fixed layer was drawn marked a cell the name cell has since replaced.
 * @param table - the table.
 * @param action - the action a click on a row's opening cell reports.
 * @param opening - the cells to mark.
 */
function markOpening(table: Element, action: string, opening: ReadonlySet<Element>): void {
  for (const cell of table.querySelectorAll('tbody td')) {
    if (opening.has(cell)) cell.setAttribute(ACTION_MARK, action)
    else if (cell.getAttribute(ACTION_MARK) === action) cell.removeAttribute(ACTION_MARK)
  }
}

/** The element-ui table component on its own root, which holds the columns it draws. */
type DrawnTable = Element & {
  /** The component instance Vue writes on its root element. */
  readonly __vue__?: {
    /** The columns, as el-table holds them: each with the id its cells carry as a class. */
    readonly columns?: readonly { readonly id?: unknown; readonly property?: unknown }[]
  }
}

/**
 * The property of the column one drawn cell belongs to, read from the table's
 * own column list by the column id the cell carries as a class.
 * @param table - the table.
 * @param cell - the cell.
 * @returns the property, or `undefined` where the table names none a step could carry.
 */
function columnOf(table: DrawnTable, cell: Element): string | undefined {
  const column = table.__vue__?.columns?.find(one => typeof one.id === 'string' && cell.classList.contains(one.id))
  const property = column?.property
  return isTarget(property) ? property : undefined
}

/**
 * Mark every drawn record link of a table's rows with the action it reports
 * and its column's property as its own key, which tells a row's name link
 * from its relation links.
 * @param table - the table.
 * @param action - the action a record link reports.
 */
function markLinks(table: Element, action: string): void {
  for (const cell of table.querySelectorAll(`tbody ${OPENABLE_CELL}`)) {
    const links = cell.querySelectorAll(RECORD_LINK)
    if (links.length === 0) continue
    const property = columnOf(table, cell)
    for (const link of links) {
      link.setAttribute(ACTION_MARK, action)
      if (property === undefined) link.removeAttribute(KEY_MARK)
      else link.setAttribute(KEY_MARK, property)
    }
  }
}

/**
 * Write each record's row key on every row that draws it — the scrolling
 * body's and each fixed layer's — or leave every key as it stands.
 *
 * A pass whose keys do not line up with the drawn rows writes nothing: a row
 * el-table has not redrawn yet still shows the record it was keyed for, and a
 * pass that took the key off would leave it unkeyed until the next change
 * below the block. Where they line up, a key a step could not carry is taken
 * off the row rather than written.
 * @param bodies - the record rows of every body the table draws, the scrolling one first.
 * @param keys - one key per record, or `undefined` where this pass cannot key the rows.
 * @returns whether this pass wrote the keys.
 */
function markRowKeys(bodies: readonly (readonly Element[])[], keys: readonly (string | undefined)[] | undefined): boolean {
  if (keys === undefined || bodies.some(rows => rows.length !== keys.length)) return false
  for (const rows of bodies) {
    for (const [at, row] of rows.entries()) {
      const key = keys[at]
      if (isTarget(key)) row.setAttribute(ROW_MARK, key)
      else row.removeAttribute(ROW_MARK)
    }
  }
  return true
}

/**
 * Mark the cell each record is named by — the cell its row opens from, which
 * is its name cell where the table draws one — and take the mark off every
 * other cell, so a reading calls the row by the record's own name rather than
 * by a relation cell drawing another record's.
 * @param table - the table.
 * @param named - the cells to mark.
 */
function markRowNames(table: Element, named: ReadonlySet<Element>): void {
  for (const cell of table.querySelectorAll('tbody td')) {
    if (named.has(cell)) cell.setAttribute(ROW_NAME_MARK, '')
    else cell.removeAttribute(ROW_NAME_MARK)
  }
}

/**
 * Mark one table's rows: the cell each record is opened from, its record
 * links, and the key every row of it carries with the cell it is named by.
 * The names are written in the pass that writes the keys and left as they
 * stand by a pass that leaves the keys, so a row's name and its key are of
 * one record.
 * @param table - the table.
 * @param marks - what this table reports.
 */
function markRows(table: Element, marks: TableMarks): void {
  const main = recordRows(table.querySelector(MAIN_BODY))
  const fixed = [table.querySelector(LEFT_BODY), table.querySelector(RIGHT_BODY)]
  const opening = openingCells(main, recordRows(fixed[0] ?? null))
  if (marks.row !== undefined) markOpening(table, marks.row, opening)
  if (marks.link !== undefined) markLinks(table, marks.link)
  if (marks.rowKeys === undefined) return
  const drawn = fixed.filter((body): body is Element => body !== null).map(recordRows)
  if (markRowKeys([main, ...drawn], marks.rowKeys(main))) markRowNames(table, opening)
}

/**
 * Mark one drawn table's controls: in both of the wrappers el-table draws a
 * table in, and never on its `is-hidden` placeholder copy, as the selectors
 * above are written; and one table's rows, as {@link TableMarks} names it —
 * one opening cell per record, its record links, and its row keys.
 * @param root - the block's subtree.
 * @param marks - what this table reports.
 */
export function markTable(root: Element, marks: TableMarks): void {
  markAll(root, SELECT_CONTROLS, ACTION_MARK, SELECT_ACTION)
  const table = root.querySelector(marks.table ?? '.el-table')
  if (table !== null) markRows(table, marks)
  if (marks.sort !== undefined) markAll(root, SORT_HEADINGS, ACTION_MARK, marks.sort)
  const operations = marks.operations
  if (operations === undefined) return
  for (const cell of root.querySelectorAll(OPERATION_CELLS)) {
    const builtin = cell.querySelector(BUILTIN_MODIFY)
    if (builtin !== null && operations.builtin !== undefined) {
      builtin.setAttribute(ACTION_MARK, OPERATION_ACTION)
      builtin.setAttribute(KEY_MARK, operations.builtin)
    }
    const drawn = [...cell.querySelectorAll(CUSTOM_OPERATION)]
    for (const [at, key] of operations.custom.entries()) {
      const control = drawn[at]
      // A key the row draws no control for writes nothing: the keys are the
      // block's declaration and the controls are the page's, and a mark on the
      // next row's control would name an operation that was not pressed.
      if (control === undefined) continue
      control.setAttribute(ACTION_MARK, OPERATION_ACTION)
      control.setAttribute(KEY_MARK, key)
    }
  }
}

/**
 * Every field input one data page draws: its query panel's and its three write
 * dialogs', told apart by each dialog's own class rather than the
 * `modify-single-dialog` class all three share.
 */
const DATA_PAGE_FIELD_INPUTS = [
  '.crud-query input.el-input__inner',
  '.crud-add-dialog input.el-input__inner',
  '.crud-modify-dialog input.el-input__inner',
  '.crud-modify-batch-dialog input.el-input__inner',
].join(', ')

/** The field inputs one form page's own form draws: the vendored page's form, without its dialogs. */
const FORM_PAGE_FIELD_INPUTS = '.toy-form-page input.el-input__inner'

/**
 * Name every field input a selector list finds by the column its field item's
 * label carries in its `for`, which is the name the block's properties use. An
 * input no field item labels, the query panel's own search box, is left
 * unmarked.
 * @param root - the block's subtree.
 * @param inputs - the inputs one block's fields are drawn as.
 */
function markFields(root: Element, inputs: string): void {
  for (const input of root.querySelectorAll(inputs)) {
    const field = input.closest('.el-form-item')?.querySelector('label[for]')?.getAttribute('for') ?? ''
    if (field === '') continue
    input.setAttribute(FIELD_MARK, field)
  }
}

/** The save control one form page draws at the centre of its footer. */
const FORM_PAGE_SAVE = '.toy-form-page .dialog-footer .center button.el-button--primary'

/** What one form page block reports, in the catalog's own vocabulary. */
export interface FormPageMarks {
  /** The action the form's save control reports for the form's mode; absent while the form has nothing to save. */
  readonly save?: string
}

/**
 * Mark one drawn form page's controls: the save control at the centre of its
 * footer, which a saved record is reported from, and its fields by column.
 * @param root - the block's subtree.
 * @param marks - the action saving reports right now.
 */
export function markFormPage(root: Element, marks: FormPageMarks): void {
  const { save } = marks
  if (save !== undefined) {
    const control = root.querySelector(FORM_PAGE_SAVE)
    if (control !== null) control.setAttribute(ACTION_MARK, save)
  }
  markFields(root, FORM_PAGE_FIELD_INPUTS)
}

/** One control of a data page, with the action and key it is marked by. */
interface PageControl {
  /** What the control is, in the vendored build's own markup. */
  readonly select: string
  /**
   * The catalog action the control performs; absent where the page reports
   * what pressing it produced rather than the press, as for add and clear.
   */
  readonly action?: string
  /** The control's own key, where the page's arrangement has one for it. */
  readonly key?: string
}

/**
 * Every control one data page draws, with the action the catalog declares,
 * the key the arrangement names it by, or both. The two export buttons are one
 * action told apart by key. The clear button is looked for inside the
 * toolbar's right half, because the batch menu's trigger is a plain button too.
 */
const DATA_PAGE_CONTROLS: readonly PageControl[] = [
  { select: 'button.query-btn', action: 'query', key: 'search' },
  { select: '.crud-add-dialog .dialog-footer .center .el-button:last-child', action: 'added' },
  { select: '.crud-modify-dialog .dialog-footer .center .el-button:last-child', action: 'modified' },
  { select: '.crud-modify-batch-dialog .dialog-footer .center .el-button:last-child', action: 'batch-modified' },
  { select: '.crud-action button.el-button--success', key: 'add' },
  { select: '.crud-action .right button.el-button--default:not(.query-btn)', key: 'clear' },
  { select: '.crud-action button.more-button', key: 'batch' },
  { select: '.crud-action button.action-button', action: 'exported', key: 'exp' },
  { select: '.crud-action .el-button-group .el-button:first-child', action: 'exported', key: 'gridexp' },
  { select: BUILTIN_DELETE, key: 'delete' },
  { select: DELETE_CONFIRM, action: 'deleted' },
  { select: '.crud-delete-dialog button.confirm-button', key: 'batch-delete-confirm' },
  { select: '.crud-small-card .close-btn .icon-close', action: 'card-close' },
]

/**
 * The key each item of a data page's batch menu carries, by the one icon that
 * is an item's only markup besides its text; the keys spell the page's own
 * `batchUpdate` and `batchDelete` toolbar states.
 */
const BATCH_MENU_KEYS: readonly { readonly icon: string; readonly key: string }[] = [
  { icon: 'i.el-icon-edit', key: 'batch-update' },
  { icon: 'i.el-icon-delete', key: 'batch-delete' },
]

/** One item of the toolbar dropdown a data page's batch button opens. */
const BATCH_MENU_ITEM = '.crud-action .el-dropdown-menu__item'

/** The table a data page draws its query's records in, as against the tables its dialogs and card draw. */
const DATA_PAGE_TABLE = '.crud-table .el-table'

/**
 * What one data page block reports beyond its fixed controls: the custom
 * operations a row draws, and how its rows are keyed.
 */
export interface DataPageMarks {
  /** The keys of the declared custom operations, in the order a row draws them. */
  readonly custom: readonly string[]
  /** How the page's rows are keyed on this pass; it keys none where the page's records cannot be read. */
  readonly rowKeys: RowKeys
}

/**
 * Mark one drawn data page's controls: its toolbar and dialogs, the batch
 * menu's items by key, its fields by column, and its table with the one cell
 * each record opens from, its record links, its operation keys and its row
 * keys.
 * @param root - the block's subtree.
 * @param marks - the custom operations the block declared, and how its rows are keyed.
 */
export function markDataPage(root: Element, marks: DataPageMarks): void {
  for (const control of DATA_PAGE_CONTROLS) {
    for (const el of root.querySelectorAll(control.select)) {
      if (control.action !== undefined) el.setAttribute(ACTION_MARK, control.action)
      if (control.key !== undefined) el.setAttribute(KEY_MARK, control.key)
    }
  }
  for (const item of root.querySelectorAll(BATCH_MENU_ITEM)) {
    const key = BATCH_MENU_KEYS.find(entry => item.querySelector(entry.icon) !== null)?.key
    if (key !== undefined) item.setAttribute(KEY_MARK, key)
  }
  markFields(root, DATA_PAGE_FIELD_INPUTS)
  markTable(root, {
    table: DATA_PAGE_TABLE,
    row: 'cell-click',
    link: 'card-open',
    operations: { builtin: 'modify', custom: marks.custom },
    rowKeys: marks.rowKeys,
  })
}
