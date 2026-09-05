/**
 * `toy.table` — rows in columns, with what the user picked, opened, sorted, or
 * pressed reported back.
 *
 * The component is `TableDetail`, compiled outside this repository and vendored
 * as `@sumomok/toy-surface-kit`. It is the one table in those libraries that
 * takes plain props, emits events, and fetches nothing, which is what makes it
 * placeable here at all; everything it draws is the caller's data.
 *
 * Four of its seven events are reported on, and three properties of it are
 * written dead rather than offered to the model, because they decide what the
 * block *is* rather than what it shows:
 *
 * - `rightOperationVisiable: null` removes the component's own modify and
 *   delete buttons. They emit `table-operation`, which no action here carries,
 *   so a user pressing one would be pressing a button that reports to nobody.
 *   A call that wants a per-row action declares it in `customOperations`.
 * - `isTransClick: false` turns off the component's translated-value links. A
 *   translated cell resolves through `refValueList`, which no block supplies,
 *   and leaving it on makes the name column a link whatever the call asked for.
 *   With it off, `isNameClick` is the only thing that makes a row openable.
 * - `selectMode` defaults to `null` — no selection column — rather than to the
 *   component's own `checkbox`, so a table offers selection only where the call
 *   asked for it.
 *
 * A row opens only where the call asked for openable rows. The component draws
 * its name link from `isNameClick` and reports a click on any cell through one
 * event of its own, so the cell click is reported as an opened row only while
 * that property is on — and then from a click anywhere in the row rather than
 * on the link alone, which is the one thing this renderer cannot narrow: the
 * component gives it no event for the rest of the row.
 *
 * Identity is by position in `displayValueList`, and the list the renderer
 * built is the one el-table holds: `TableDetail` passes it through
 * `Object.freeze` and hands the same row objects back on a cell click. What a
 * gesture reports is therefore an index, never a row — nothing about the data
 * travels back out of the block, and the placement package reads the row it
 * names out of the call the model itself wrote.
 *
 * element-ui must already be installed on the shared runtime — the row's client
 * plugin does that when it starts, and a test drawing this block on its own
 * calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef } from 'react'
import { TableDetail, type TableDetailInstance } from '@sumomok/toy-surface-kit'
import { ActionStateLine, PRESSABLE } from './action-state.tsx'
import { readBoolean, readNumber, readRecord, readList, readText, type ScalarValue } from './props.ts'
import { useVueComponent } from './vue2-bridge.tsx'
import css from './TableDetailRenderer.module.css'
import type { ComponentActionHandler, ComponentRendererProps } from './renderer.ts'
import type { VueEventHandlers } from './vue2-bridge.tsx'
import type { VueInstance } from './vue-shim.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.table'

/** Action id the selected rows are reported under. */
const SELECT_ACTION_ID = 'select'

/** Action id one opened row is reported under. */
const ROW_CLICK_ACTION_ID = 'row-click'

/** Action id a column-header sort is reported under. */
const SORT_ACTION_ID = 'sort'

/** Action id a pressed per-row button is reported under. */
const OPERATION_ACTION_ID = 'operation'

/**
 * The sort directions this block reports, keyed by what the component's own
 * event calls them. A direction outside the table — which is what el-table
 * emits for a column the user cycled back to its original order — is reported
 * as {@link UNSORTED}.
 */
const SORT_ORDERS: Readonly<Record<string, string>> = { ascending: 'asc', descending: 'desc' }

/** Sort direction reported for a column the user sorted back to its original order. */
const UNSORTED = 'none'

/** One row, as the component draws it: a value per column, already formatted. */
type TableRow = Readonly<Record<string, ScalarValue>>

/** One column, as `TableDetail` wants it. */
type TableColumn = {
  /** The row property this column takes its value from. */
  readonly relatedMetaAttr: string
  /** The column heading. */
  readonly alias?: string
  /** Whether the column is drawn; the component reads `String(isShow) !== '0'`. */
  readonly isShow?: '0' | '1'
  /** Whether the heading sorts; the component reads `String(isSortable) === '1'`. */
  readonly isSortable?: '0' | '1'
  /** Which cell component draws the value; plain text when absent. */
  readonly relatedComponent?: string
  /** That cell component's own configuration. */
  readonly relatedComponentObj?: Readonly<Record<string, unknown>>
}

/** One per-row button. */
type TableOperation = {
  /** The id reported when the user presses it. */
  readonly key: string
  /** The text on it. */
  readonly label: string
}

/** What `TableDetail` receives, as this renderer builds it. */
type TableDetailVueProps = {
  /** The columns, in order. */
  readonly tableConfig: { readonly gridItems: readonly TableColumn[] }
  /** The rows the table draws, and the list every reported index counts into. */
  readonly displayValueList: readonly TableRow[]
  /** The values behind the drawn ones; the drawn rows themselves when the block declares none. */
  readonly rawValueList: readonly TableRow[]
  /** How rows are selected, or `null` for a table nothing is selected in. */
  readonly selectMode: 'checkbox' | 'radio' | null
  /** Written dead: the component's own modify and delete buttons report to nobody here. */
  readonly rightOperationVisiable: null
  /** Written dead: no block supplies the translated values these links resolve through. */
  readonly isTransClick: false
  /** Whether the name column opens a row. */
  readonly isNameClick?: boolean
  /** Whether a column may sort at all; the component's own default applies when absent. */
  readonly tableSortable?: boolean
  /** The per-row buttons, or `null` for a table with no operation column. */
  readonly customOperations: readonly TableOperation[] | null
  /** Width of the operation column in pixels; the component sizes it from the buttons when absent. */
  readonly operationColumnWidth?: number
}

/**
 * What the listener map reads at the moment an event arrives.
 *
 * The map itself is built once and never replaced, because its identity is what
 * decides whether a React commit re-renders the Vue tree below the bridge. The
 * values it needs do change, so they are read out of a ref the renderer
 * refreshes on every commit instead of being closed over.
 */
interface TableEventContext {
  /** The rows now drawn; every reported index counts into this list. */
  readonly rows: readonly TableRow[]
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
  /** Whether a further operation may still be reported. */
  readonly pressable: boolean
  /** Whether the call made rows openable, which is what decides that a click on one is a gesture. */
  readonly openable: boolean
}

/**
 * Read one row.
 * @param value - one item of the `displayValueList` or `rawValueList` property.
 * @returns the row with the values the component can draw, or `undefined` when the item is not a record.
 */
function readRow(value: unknown): TableRow | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const row: Record<string, ScalarValue> = {}
  for (const [key, cell] of Object.entries(record)) {
    if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') row[key] = cell
  }
  return row
}

/**
 * Read one column.
 *
 * `isShow` and `isSortable` are booleans in the catalog and strings to the
 * component, which reads them as `String(isShow) !== '0'` and
 * `String(isSortable) === '1'`. The translation is here, for the same reason
 * the record's pixel width becomes a CSS length here: what a call carries is
 * the meaning, and the spelling belongs to the code that knows which component
 * wants it.
 * @param value - one item of the `tableConfig.gridItems` property.
 * @returns the column, or `undefined` when the item names no row property.
 */
function readColumn(value: unknown): TableColumn | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const relatedMetaAttr = readText(record['relatedMetaAttr'])
  if (relatedMetaAttr === undefined) return undefined
  const alias = readText(record['alias'])
  const isShow = readBoolean(record['isShow'])
  const isSortable = readBoolean(record['isSortable'])
  const relatedComponent = readText(record['relatedComponent'])
  const relatedComponentObj = readRecord(record['relatedComponentObj'])
  return {
    relatedMetaAttr,
    ...(alias === undefined ? {} : { alias }),
    ...(isShow === undefined ? {} : { isShow: isShow ? '1' : '0' } as const),
    ...(isSortable === undefined ? {} : { isSortable: isSortable ? '1' : '0' } as const),
    ...(relatedComponent === undefined ? {} : { relatedComponent }),
    ...(relatedComponentObj === undefined ? {} : { relatedComponentObj }),
  }
}

/**
 * Read one per-row button.
 * @param value - one item of the `customOperations` property.
 * @returns the button, or `undefined` when it carries no id or no text.
 */
function readOperation(value: unknown): TableOperation | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const key = readText(record['key'])
  const label = readText(record['label'])
  if (key === undefined || label === undefined) return undefined
  return { key, label }
}

/**
 * Read how rows are selected.
 * @param value - the `selectMode` property value.
 * @returns the mode, or `null` for a table nothing is selected in.
 */
function readSelectMode(value: unknown): 'checkbox' | 'radio' | null {
  return value === 'checkbox' || value === 'radio' ? value : null
}

/**
 * Read the direction of one column sort.
 * @param value - the `order` field of the component's sort event.
 * @returns the direction as this block reports it, or {@link UNSORTED} for a column the user cycled back to its original order.
 */
function readSortOrder(value: unknown): string {
  return SORT_ORDERS[value as string] ?? UNSORTED
}

/**
 * Narrow a block's properties to what `TableDetail` declares.
 * @param props - the block's already-validated properties.
 * @returns the component's prop record, with the three properties this renderer writes dead already in it.
 */
function readTableDetail(props: ComponentRendererProps['props']): TableDetailVueProps {
  const displayValueList = readList(props['displayValueList'], readRow)
  const rawValueList = readList(props['rawValueList'], readRow)
  const isNameClick = readBoolean(props['isNameClick'])
  const tableSortable = readBoolean(props['tableSortable'])
  const operations = readList(props['customOperations'], readOperation)
  const operationColumnWidth = readNumber(props['operationColumnWidth'])
  return {
    tableConfig: { gridItems: readList(readRecord(props['tableConfig'])?.['gridItems'], readColumn) },
    displayValueList,
    // Every column reads a raw value by row index, so a shorter list would take
    // the component past the end of it; the drawn rows are the honest stand-in.
    rawValueList: rawValueList.length === displayValueList.length ? rawValueList : displayValueList,
    selectMode: readSelectMode(props['selectMode']),
    rightOperationVisiable: null,
    isTransClick: false,
    customOperations: operations.length === 0 ? null : operations,
    ...(isNameClick === undefined ? {} : { isNameClick }),
    ...(tableSortable === undefined ? {} : { tableSortable }),
    ...(operationColumnWidth === undefined ? {} : { operationColumnWidth }),
  }
}

/**
 * Render one table block.
 * @param rendererProps - the block's identity, its properties, the action sink, how far its last gesture got, and this row's translate.
 * @returns the host element the Vue component is mounted into, over the line saying where the last gesture went.
 */
export function TableDetailRenderer({ nodeId, props, onAction, state, t }: ComponentRendererProps) {
  // Keyed on the block's property record: the placement package hands over the
  // same object until the call behind the block changes, so an unrelated React
  // commit reaches Vue as nothing at all — and a new call hands el-table a new
  // `data` array, which is what makes it drop a selection made against the
  // rows that are gone.
  const vueProps = useMemo(() => readTableDetail(props), [props])
  const instanceRef = useRef<VueInstance | null>(null)
  const pressable = PRESSABLE.includes(state)
  // The component's own default is `false`, so a call that wrote no
  // `isNameClick` drew a table with nothing to open — which is why the absent
  // property reads the same as a declared `false` here.
  const openable = vueProps.isNameClick === true
  const context = useRef<TableEventContext>({ rows: vueProps.displayValueList, onAction, pressable, openable })
  useEffect(() => {
    context.current = { rows: vueProps.displayValueList, onAction, pressable, openable }
  })
  // A click on the name link or on a row button reaches el-table's own cell
  // click on the way up — both sit inside the cell that handler is bound to —
  // so the component emits two events for one gesture, its own first. The cell
  // click that follows is dropped rather than reported as a further row click,
  // which is also why a press refused for the block's state still sets this:
  // what the user did was press a button, not open a row.
  const cellClickHandled = useRef(false)
  // el-table reports a click on any cell, and the component draws the openable
  // name link only where the call asked for one. Reporting the cell click
  // regardless would make every table's every click an opened row — including
  // the tables the call left with nothing to open, where the user clicked a
  // cell and the block offers no way to know anything left it.
  const on = useMemo<VueEventHandlers>(() => ({
    // Deep-cloned in the event's own arguments, so the rows the user picked are
    // read back off the instance, where they are still the ones handed over.
    'table-selection-change': () => {
      const instance = instanceRef.current as TableDetailInstance
      const { rows, onAction: report } = context.current
      const selected = instance.doGetSelection().selection as readonly unknown[]
      report(SELECT_ACTION_ID, { rowIndexes: selected.map(row => rows.indexOf(row as TableRow)) })
    },
    'table-cell-click': ({ row }: { readonly row: unknown }) => {
      if (cellClickHandled.current) {
        cellClickHandled.current = false
        return
      }
      const { rows, onAction: report, openable: opens } = context.current
      if (!opens) return
      report(ROW_CLICK_ACTION_ID, { rowIndex: rows.indexOf(row as TableRow) })
    },
    'name-cell-click': ({ dataBase }: { readonly dataBase: { readonly resultData: { readonly displayValue: unknown } } }) => {
      cellClickHandled.current = true
      const { rows, onAction: report } = context.current
      report(ROW_CLICK_ACTION_ID, { rowIndex: rows.indexOf(dataBase.resultData.displayValue as TableRow) })
    },
    // `prop` is the column property this renderer itself supplied and `key` is
    // one of its own buttons' ids, so both are read as the strings they are.
    'table-sort-change': ({ prop, order }: { readonly prop: string; readonly order: unknown }) => {
      context.current.onAction(SORT_ACTION_ID, { prop, order: readSortOrder(order) })
    },
    'table-operation-custom': (scope: { readonly row: unknown }, operation: TableOperation) => {
      cellClickHandled.current = true
      const { rows, onAction: report, pressable: open } = context.current
      if (!open) return
      report(OPERATION_ACTION_ID, { opId: operation.key, rowIndex: rows.indexOf(scope.row as TableRow) })
    },
  }), [])
  const host = useVueComponent<HTMLDivElement>({ component: TableDetail, props: vueProps, on, instanceRef })
  return (
    <section
      className={pressable ? undefined : css.busy}
      data-component-block={COMPONENT_ID}
      data-component-node={nodeId}
    >
      <div ref={host} className={css.table} />
      <ActionStateLine state={state} t={t} />
    </section>
  )
}
