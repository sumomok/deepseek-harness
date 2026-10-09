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
 * `@sumomok/toy-crud-kit` 0.5.0). A control a build stops drawing is one this
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
const HEADING_WRAPPERS = ['.el-table__header-wrapper', '.el-table__fixed-header-wrapper'] as const

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

/**
 * A row's own cells, minus the selection column's: the cell a click opens the
 * row from.
 */
const ROW_CELLS = under(BODY_WRAPPERS, 'tbody td:not(.el-table-column--selection):not(.is-hidden)')

/** The heading of every column the user may sort, in whichever wrapper draws it. */
const SORT_HEADINGS = under(HEADING_WRAPPERS, 'th.is-sortable:not(.is-hidden)')

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
 * Every field input one data page draws: its query panel's and its three write
 * dialogs'. One selector per form rather than one form list, because a
 * descendant combinator applies to the last selector of a list alone. The
 * dialogs' own classes are what tell them apart: each is also drawn with
 * `modify-single-dialog`, which is the dialog component rather than the write
 * it performs.
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
 * Name every field input a selector list finds, by the column its field item
 * labels it with.
 *
 * The field items are drawn from the table's own scheme, and each one's label
 * carries the column's own name in its `for` — the same name the block's
 * properties use, with the alias it shows the user beside it. An input inside
 * those panels that no field item labels, the query panel's own search box,
 * carries no name and is left unmarked rather than named after a guess.
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

/**
 * Name every field one data page draws, by the column it stands for.
 * @param root - the block's subtree.
 */
export function markPageFields(root: Element): void {
  markFields(root, DATA_PAGE_FIELD_INPUTS)
}

/** The save control one form page draws at the centre of its footer. */
const FORM_PAGE_SAVE = '.toy-form-page .dialog-footer .center button.el-button--primary'

/** What one form page block reports, in the catalog's own vocabulary. */
export interface FormPageMarks {
  /**
   * The action the form's save control reports; absent while the form has
   * nothing to save — the form's mode is what decides whether saving adds a
   * record or edits one, and this block reports that mode's action.
   */
  readonly save?: string
}

/**
 * Mark one drawn form page's controls.
 *
 * The form draws its own save control at the centre of its footer, and that
 * button is the one a saved record is reported from; the form's fields are
 * named by the columns their labels carry, as a data page's are. Both are
 * drawn by the vendored component, so the mark pass runs again whenever it
 * renders.
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
 * while their dialog is open, and the mark pass runs again when it is. The
 * clear button is looked for inside the toolbar's right half, where the page
 * draws it: the batch menu's trigger is a plain button too, and a selector
 * taking the first of both would mark the menu with the clear key.
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
 * The key each item of a data page's batch menu carries, by the icon the
 * vendored build draws on it.
 *
 * The items are `el-dropdown-item`s whose only own markup is their text and
 * one icon, so the icon is what tells which operation an item starts; the
 * page's own names for the two — its `batchUpdate` and `batchDelete` toolbar
 * states — are what the keys spell.
 */
const BATCH_MENU_KEYS: readonly { readonly icon: string; readonly key: string }[] = [
  { icon: 'i.el-icon-edit', key: 'batch-update' },
  { icon: 'i.el-icon-delete', key: 'batch-delete' },
]

/** One item of the toolbar dropdown a data page's batch button opens. */
const BATCH_MENU_ITEM = '.crud-action .el-dropdown-menu__item'

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
 * arrangement names; and the menu the batch button opens is marked item by
 * item, because what a batch edit is performed by is the dialog's own confirm
 * rather than the item that opened it.
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
  for (const item of root.querySelectorAll(BATCH_MENU_ITEM)) {
    const key = BATCH_MENU_KEYS.find(entry => item.querySelector(entry.icon) !== null)?.key
    if (key !== undefined) item.setAttribute(KEY_MARK, key)
  }
  markPageFields(root)
  markTable(root, {
    row: 'cell-click',
    operations: { builtin: 'modify', custom: marks.custom },
  })
}
