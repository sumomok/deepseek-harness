/**
 * What the kit's blocks mark their controls with, and how those marks are kept
 * on a subtree a vendored Vue component draws.
 *
 * `act_component` addresses an element of a drawn block by the block's own
 * declaration and never by a DOM reference, so every control a block reports
 * from carries the attribute that says what it is: `data-component-action` for
 * the action a control performs, `data-component-key` for the control's own key
 * where one action is performed by several controls (a confirmation bar's
 * buttons, a table row's operation links), and `data-component-field` for a
 * field, named as the column or property it is. The renderers write these
 * attributes onto the markup they draw themselves; the controls inside a
 * vendored Vue component are drawn after the React commit and re-drawn whenever
 * that component renders on its own state — a table registering its columns, a
 * page answering a query — so this module marks them from the DOM: once at
 * mount, and again after every change below the block.
 *
 * The selectors are the vendored builds' own markup, written against the exact
 * tarballs this row vendors (`@sumomok/toy-surface-kit` 0.3.1 and
 * `@sumomok/toy-crud-kit` 0.4.5). A control a build stops drawing is one this
 * module stops marking, which the marker tests fail on rather than a mark that
 * lands on the wrong element; the kit's README states what a rebuild of either
 * tarball has to keep.
 * @module @deepseek-ai/dsh-experimental-component-kit/client/marks
 */

/** The attribute naming the action a control performs. */
export const ACTION_MARK = 'data-component-action'

/** The attribute naming a control's own key, where its action is performed by several controls. */
export const KEY_MARK = 'data-component-key'

/** The attribute naming the column or property a field writes. */
export const FIELD_MARK = 'data-component-field'

/** The one action a table's selection controls report. */
const SELECT_ACTION = 'select'

/** The action every per-row operation control reports, whichever key it carries. */
const OPERATION_ACTION = 'operation'

/** Every control a table's selection reports from, in both the drawn modes. */
const SELECT_CONTROLS = '.el-table__body-wrapper .el-checkbox__original, .el-table__body-wrapper .el-radio__original'

/**
 * A row's own cells, minus the selection column's: the cell a click opens the
 * row from.
 */
const ROW_CELLS = '.el-table__body-wrapper tbody td:not(.el-table-column--selection)'

/** The heading of every column the user may sort. */
const SORT_HEADINGS = '.el-table__header-wrapper th.is-sortable'

/** One row's operation cell, where its per-row buttons are drawn. */
const OPERATION_CELLS = '.el-table__body-wrapper .column-operation'

/** The built-in modify control a data page's operation column draws. */
const BUILTIN_MODIFY = '.operation-modify'

/** One declared custom operation's control, as both builds draw it: the link inside its wrapper. */
const CUSTOM_OPERATION = '.operation-custom a'

/**
 * What one table block reports, in the catalog's own vocabulary.
 *
 * Read off the block's properties by the renderer that draws it, because the
 * catalog is what decides which gestures exist for a table — a sort a table
 * reports none of, an openable row the call did not ask for — and the markup
 * alone cannot tell a cell that reports nothing from one that reports a row.
 */
export interface TableMarks {
  /** The action a click on a row's cell reports; absent for a table whose rows do not open. */
  readonly row?: string
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
 * Keep a block's controls marked for as long as it is mounted.
 *
 * A MutationObserver rather than one pass per React commit: a vendored
 * component re-renders on state of its own, and every element it draws afresh
 * — a cell after a query, a dialog after a press — has to be marked again.
 * The pass itself is idempotent, so a change that adds nothing leaves every
 * mark as it was.
 * @param root - the element the block's controls live under, which Vue draws into.
 * @param apply - marks every control it can find under the root, from the block's current properties.
 * @returns the release, which stops watching.
 */
export function keepMarked(root: Element, apply: (root: Element) => void): () => void {
  apply(root)
  const observer = new MutationObserver(() => { apply(root) })
  observer.observe(root, { childList: true, subtree: true })
  return () => { observer.disconnect() }
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
 * Mark one drawn table's controls.
 *
 * The body wrapper only, on every selector: el-table draws a second copy of
 * each cell and heading under its fixed columns, and the first copy in
 * document order is the one a person's click reaches.
 * @param root - the block's subtree.
 * @param marks - what this table reports.
 */
export function markTable(root: Element, marks: TableMarks): void {
  markAll(root, SELECT_CONTROLS, ACTION_MARK, SELECT_ACTION)
  if (marks.row !== undefined) markAll(root, ROW_CELLS, ACTION_MARK, marks.row)
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
 * Every field input one data page draws: its query panel's and its write
 * dialogs'. One selector per form rather than one form list, because a
 * descendant combinator applies to the last selector of a list alone. The two
 * dialogs' own classes are what tell them apart: both are also drawn with
 * `modify-single-dialog`, which is the dialog component rather than the write
 * either one performs.
 */
const DATA_PAGE_FIELD_INPUTS = [
  '.crud-query input.el-input__inner',
  '.crud-add-dialog input.el-input__inner',
  '.crud-modify-dialog input.el-input__inner',
].join(', ')

/**
 * Name every field one data page draws, by the column it stands for.
 *
 * The field items are drawn from the table's own scheme, and each one's label
 * carries the column's own name in its `for` — the same name the block's
 * properties use, with the alias it shows the user beside it. An input inside
 * those panels that no field item labels, the query panel's own search box,
 * carries no name and is left unmarked rather than named after a guess.
 * @param root - the block's subtree.
 */
export function markPageFields(root: Element): void {
  for (const input of root.querySelectorAll(DATA_PAGE_FIELD_INPUTS)) {
    const field = input.closest('.el-form-item')?.querySelector('label[for]')?.getAttribute('for') ?? ''
    if (field === '') continue
    input.setAttribute(FIELD_MARK, field)
  }
}

/** One control of a data page, with the action and key it is marked by. */
interface PageControl {
  /** What the control is, in the vendored build's own markup. */
  readonly select: string
  /**
   * The catalog action the control performs; absent where pressing it reports
   * nothing on its own — the toolbar's add and clear are what a person uses to
   * open a form and to drop a query, and the page reports what either produced
   * rather than the press.
   */
  readonly action?: string
  /** The control's own key, where the page's arrangement has one for it. */
  readonly key?: string
}

/**
 * Every control one data page draws, as the vendored build marks it.
 *
 * Each selector is one control's own class or place in the toolbar, and every
 * entry carries the action the catalog declares, the key the arrangement names
 * it by, or both. The two export buttons are one action with two keys: what
 * the page reports on either is that an export task was submitted, and which
 * of the two it was is what the key says. The dialog buttons are drawn only
 * while their dialog is open, and the mark pass runs again when it is.
 */
const DATA_PAGE_CONTROLS: readonly PageControl[] = [
  { select: 'button.query-btn', action: 'query', key: 'search' },
  { select: '.crud-add-dialog .dialog-footer .center .el-button:last-child', action: 'added' },
  { select: '.crud-modify-dialog .dialog-footer .center .el-button:last-child', action: 'modified' },
  { select: '.crud-action button.el-button--success', key: 'add' },
  { select: '.crud-action button.el-button--default:not(.query-btn)', key: 'clear' },
  { select: '.crud-action button.action-button', action: 'exported', key: 'exp' },
  { select: '.crud-action .el-button-group .el-button:first-child', action: 'exported', key: 'gridexp' },
]

/**
 * What one data page block reports, in the catalog's own vocabulary.
 *
 * The properties the page is opened on decide the controls: the custom
 * operations it adds are the buttons a row draws beside the page's own, and
 * their keys are what a step names one by.
 */
export interface DataPageMarks {
  /** The keys of the declared custom operations, in the order a row draws them. */
  readonly custom: readonly string[]
}

/**
 * Mark one drawn data page's controls.
 *
 * Its table is marked as the table it is, with the one row action this page
 * reports and the operation keys its arrangement declares; its toolbar and its
 * dialogs are marked with the actions the catalog declares and the keys the
 * arrangement names.
 * @param root - the block's subtree.
 * @param marks - the custom operations the block declared.
 */
export function markDataPage(root: Element, marks: DataPageMarks): void {
  for (const control of DATA_PAGE_CONTROLS) {
    for (const el of root.querySelectorAll(control.select)) {
      if (control.action !== undefined) el.setAttribute(ACTION_MARK, control.action)
      if (control.key !== undefined) el.setAttribute(KEY_MARK, control.key)
    }
  }
  markPageFields(root)
  markTable(root, {
    row: 'cell-click',
    operations: { builtin: 'modify', custom: marks.custom },
  })
}
