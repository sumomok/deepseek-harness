/**
 * The vocabulary of a structural page read: what the caller asks for, what it
 * gets back, and the records the collector hands the renderer in between.
 *
 * Public types keep optional members optional because the caller omits them;
 * the internal item records spell every member out, so a walk never has to ask
 * whether a field was set or merely absent.
 * @module @deepseek-ai/dsh-experimental-content-frame/client/access/model
 */
import type { RefTable } from './refs.ts'

/** How much of the page one read renders: every item, or containers only. */
export type SnapshotMode = 'outline' | 'map'

/**
 * The container kinds a row can name. Several ARIA roles share one word,
 * because the reader needs the kind of region rather than the exact role:
 * `form` also covers a search form, `dialog` an alert dialog, `list` a feed,
 * `menu` a menu bar, `menuitem` a checkable or radio menu item, and `section` a
 * region, an article, or a complementary area. `clickable` is the one kind the
 * page does not declare: a run the page makes clickable that holds items of its
 * own is both a thing to click and a region to read.
 */
export type ContainerType =
  | 'main' | 'nav' | 'form' | 'dialog' | 'section' | 'toolbar' | 'list' | 'table' | 'frame'
  | 'tablist' | 'tabpanel' | 'menu' | 'tree' | 'radiogroup' | 'listbox'
  | 'clickable' | 'treeitem' | 'menuitem'

/** What one read asks of the page. */
export interface SnapshotOptions {
  /** The page's element numbering, carried across reads. */
  readonly refs: RefTable
  /** The character budget for the rendered body. */
  readonly budgetChars: number
  /** Defaults to `outline`. */
  readonly mode?: SnapshotMode
  /** A ref: read that element's subtree only. */
  readonly scope?: string
  /** A ref this read's own listing carries: continue after the item it names. */
  readonly after?: string
  /** Case-insensitive text filter: a flat list of the items that match. */
  readonly find?: string
  /** Injected: whether the element is visible. */
  readonly isVisible: (el: Element) => boolean
  /** Injected: whether a role-less element is clickable; defaults to a `cursor: pointer` computed style. */
  readonly isClickable?: (el: Element) => boolean
}

/** What the page is, above the items themselves. */
export interface SnapshotHeader {
  /** The root document's URL. */
  readonly url: string
  /** The root document's title. */
  readonly title: string
  /** The name of the dialog the page currently has open. */
  readonly modal?: string
  /** True when a visible password box sits beside a visible text or email box. */
  readonly signIn: boolean
}

/** One structural read of the page. */
export interface Snapshot {
  /** Which listing came back. */
  readonly kind: SnapshotMode
  /** What the page is. */
  readonly header: SnapshotHeader
  /** The rendered body, without the `Page` line the tool composes. */
  readonly text: string
  /** True when the listing stops short of everything this read would have shown. */
  readonly truncated: boolean
  /** How many rows of the listing the body renders. */
  readonly shown: number
  /** How many rows the listing has in full. */
  readonly total: number
  /** The last rendered item's ref, to pass back as `after`; present only on a listing cut short. */
  readonly cursor?: string
}

/** The naming half of a container, shared by container rows and their suffixes. */
export interface ContainerFace {
  /** The container kind. */
  readonly type: ContainerType
  /** The container's accessible name, empty when it has none. */
  readonly name: string
}

/** A region of the page other items sit inside. */
export interface ContainerItem extends ContainerFace {
  /** Discriminant. */
  readonly kind: 'container'
  /** The element this row names. */
  readonly el: Element
  /** The element's ref. */
  readonly ref: string
  /** The container this one sits in. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this row. */
  readonly depth: number
  /** True for a dialog the page has not opened: it appears on the map and nowhere else. */
  readonly closed: boolean
  /**
   * The tree node or menu item this region was opened over, and undefined for
   * every other region. A room stands in place of the one row the node would
   * have printed, so its row prints what that row would have said and the
   * reader is told the same either way.
   */
  readonly node: ControlFace | undefined
}

/**
 * What a control currently holds and how the page has set it, printed after the
 * control's name wherever a row names it: on its own row, and inside a listed
 * table cell.
 */
export interface ControlState {
  /** The field's current value, or undefined for an element that holds none. */
  readonly value: string | undefined
  /** True for a password box, whose value is reported as withheld and never read. */
  readonly secret: boolean
  /** The checked state, or undefined for an element that has none. */
  readonly checked: boolean | undefined
  /** True when the page says the field must be filled. */
  readonly required: boolean
  /** True when the page takes what the field holds and refuses the reader's typing. */
  readonly readonly: boolean
  /** True when the page has disabled the element. */
  readonly disabled: boolean
}

/**
 * What a row prints of an element beyond its ref and its name: what the element
 * is, what the page has set on it, and whether the page has folded away what it
 * holds. A row of its own and the room a node opens print this the same way.
 */
export interface ControlFace extends ControlState {
  /** The element's ARIA role, or `clickable` for a role-less click target. */
  readonly role: string
  /** True for a tree node or menu item the page has closed over what it holds. */
  readonly collapsed: boolean
}

/** One control, heading, or other element the model can name on its own. */
export interface ElementItem extends ControlFace {
  /** Discriminant. */
  readonly kind: 'element'
  /** The element this row names. */
  readonly el: Element
  /** The element's ref. */
  readonly ref: string
  /** The element's accessible name. */
  readonly name: string
  /**
   * The ref of the click target the page draws inside this field to open what
   * it offers — the arrow of a picker the reader cannot type into — and
   * undefined for every other row. The target prints no row of its own: it is
   * one field the page drew in two halves, and two rows would have the model
   * choosing which half to click.
   */
  readonly opens: string | undefined
  /** The container this row sits in. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this row. */
  readonly depth: number
}

/** A run of page text with no control of its own. */
export interface TextItem {
  /** Discriminant. */
  readonly kind: 'text'
  /** The collapsed, length-capped text. */
  readonly text: string
  /** The container this row sits in. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this row. */
  readonly depth: number
}

/** One control a table cell holds, numbered only when a read prints its row. */
export interface CellControl extends ControlState {
  /** The control element. */
  readonly el: Element
  /** Its role. */
  readonly role: string
  /** Its accessible name. */
  readonly name: string
}

/** One cell of a table row, in the forms a listing prints it. */
export interface RowCell {
  /** The controls the cell holds, in document order. */
  readonly controls: readonly CellControl[]
  /** What the cell shows apart from its controls, which name themselves. */
  readonly text: string
  /**
   * The cell as the one-row sample renders it: its text, and its controls
   * inside `[ ]`, the whole of it already cut to the room the sample line gives
   * a cell. The text gives way first, and a list of controls that fills the
   * room on its own is cut inside its brackets.
   */
  readonly sample: string
}

/**
 * One data row of a table, rendered only when the read asks for rows. The row
 * and the controls in it are numbered when a read prints them, not when the
 * walk finds them: a listing that reports a two-hundred-row table by its shape
 * alone must not spend two hundred refs on rows nobody has asked to see.
 *
 * `width`, `cells`, and `text` are read from the page when a listing asks for
 * them, so a whole page reads only the row it samples while a read scoped to
 * the table or filtered by `find` reads what it prints.
 */
export interface TableRowItem {
  /** Discriminant. */
  readonly kind: 'row'
  /** The row element. */
  readonly el: Element
  /** The row's 1-based position among the table's data rows. */
  readonly index: number
  /** How many columns the row shows. */
  readonly width: number
  /** Each column, in order. */
  readonly cells: readonly RowCell[]
  /** What the row draws, for `find`. */
  readonly text: string
  /** The table this row belongs to, for the suffix a flat listing prints. */
  readonly table: ContainerFace
}

/** A table, reported by its shape rather than by its contents. */
export interface TableItem extends ContainerFace {
  /** Discriminant. */
  readonly kind: 'table'
  /** Always `table`. */
  readonly type: 'table'
  /** The table element. */
  readonly el: Element
  /** The element's ref. */
  readonly ref: string
  /** The header cells, empty for a table that heads no columns. */
  readonly header: readonly RowCell[]
  /** The table's data rows. */
  readonly rows: readonly TableRowItem[]
  /**
   * How many columns the table has: the wider of its header and its first data
   * row, which is the row the sample prints. Counting every row would read
   * every cell of the table to answer how wide the table is.
   */
  readonly columns: number
  /** The container this row sits in. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this row. */
  readonly depth: number
}

/** A frame whose document this page may not read. */
export interface UnreadableFrameItem {
  /** Discriminant. */
  readonly kind: 'frame-error'
  /** The container this row sits in. */
  readonly container: ContainerItem | undefined
  /** How many containers enclose this row. */
  readonly depth: number
}

/** Everything one walk of the page collects, in document order. */
export type Item = ContainerItem | ElementItem | TextItem | TableItem | UnreadableFrameItem
