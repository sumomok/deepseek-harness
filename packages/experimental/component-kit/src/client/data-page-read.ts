/**
 * What `toy.data-page` reads out of its block and out of the page's own events
 * — the narrowing of a block's properties into the prop record `DataPage`
 * takes, and the reduction of each event's payload to the bounded report the
 * placement package's catalog admits.
 *
 * Pure functions, kept apart from the renderer so each reading is pinned on
 * its own: the properties were already checked by the catalog that admitted
 * the block, but a payload came out of the page, which read it off a backend,
 * and every value of it is judged here before it is reported. Every ceiling
 * and charset a judgement holds to is `data-page-limits.ts`'s, which the
 * placement package pins against its own catalog, value for value.
 *
 * Nothing here decides what the page may do. Which regions it holds, which
 * buttons it keeps and whether it can be written in arrive as properties the
 * catalog already accepted, and are handed to the page as written; whether a
 * press succeeds is the deployment's own answer to the request the page makes
 * with the user's credential.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/data-page-read
 */

import type {
  CrudQuerySuccessPayload,
  CrudTableCellClickPayload,
  DataPageExportTaskPayload,
  DataPageInfoCardOpenPayload,
  DataPageLoadPayload,
  ToyRow,
} from '@sumomok/toy-crud-kit'
import {
  ATTRIBUTE_NAME,
  EXPORT_MODES,
  MAX_ATTRIBUTE_LENGTH,
  MAX_RIGHT_LENGTH,
  MAX_CELL_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_NAMED_ROWS,
  MAX_REPORTED_RIGHTS,
  MAX_REPORTED_CELLS,
  MAX_REPORTED_COLUMNS,
  MAX_REPORTED_NUMBER,
  MAX_SAVED_FIELDS,
  MAX_TICKED_ROWS,
} from './data-page-limits.ts'
import { readBoolean, readList, readNumber, readRecord, readText, type ScalarValue } from './props.ts'
import type { ComponentRendererProps } from './renderer.ts'

/** One hidden condition, as `DataPage` takes it. */
export interface DataPageCondition {
  /** The attribute the condition is about. */
  readonly key: string
  /** The match strategy, as the backend names it. */
  readonly op: string
  /** What the attribute is matched against: one scalar, or a list of text and numbers. */
  readonly value: ScalarValue | readonly (string | number)[]
}

/** One row operation the block adds to the page's own, as `DataPage` takes it. */
export interface DataPageOperation {
  /** The id a press reports. */
  readonly name: string
  /** The row button's own text. */
  readonly label: string
}

/**
 * What `DataPage` receives, as this component builds it.
 *
 * Only `relatedMeta` and `myStyle` are always present: everything else is the
 * block's, and a property the block left out is left out here too, so the
 * page's own default stands rather than a second default written twice. The
 * type is a `type` alias rather than an interface because the bridge's prop
 * record needs the implicit index signature.
 */
export type DataPageVueProps = {
  /** The table, by its name in the backend. */
  readonly relatedMeta: string
  /** The hidden conditions; empty where the block wrote none. */
  readonly conditions: readonly DataPageCondition[]
  /** How the conditions join. */
  readonly matchMode?: 'AND' | 'OR'
  /** The sort. */
  readonly querySort?: { readonly asc?: string; readonly desc?: string }
  /** How rows are ticked. */
  readonly selectMode?: 'checkbox' | 'radio'
  /** Whether the first query runs without a press. */
  readonly isInitQuery?: boolean
  /** The row operations this block adds to the page's own. */
  readonly customOperations?: readonly DataPageOperation[]
  /** Which of the page's regions are drawn. */
  readonly regions?: Readonly<Record<string, boolean>>
  /** Which toolbar buttons the page keeps. */
  readonly toolbarButtons?: readonly string[]
  /** Which row operations the page keeps. */
  readonly rowOperations?: readonly string[]
  /** Whether the query panel opens expanded. */
  readonly queryExpanded?: boolean
  /** Rows on one page to begin with. */
  readonly pageSize?: number
  /** The row counts the pager offers. */
  readonly pageSizes?: readonly number[]
  /** Which sections the side card draws. */
  readonly infoCardTabs?: readonly string[]
  /** Whether the page refuses every write; the page's own default is `true`. */
  readonly readOnly?: boolean
  /** The page fills its box; the box carries the height. */
  readonly myStyle: string
}

/** One drawn column of the page's query scheme, as a report names it. */
export interface ReportedColumn {
  /** The attribute the column reads its cell out of. */
  readonly attr: string
  /** The header the page draws, where the scheme wrote one this report can carry. */
  readonly alias?: string
}

/** What one load reports: the table, its first drawn columns, how many it draws in all, and the rights it resolved. */
export type LoadReport = {
  /** The table the page was opened on. */
  readonly meta: string
  /** The first {@link MAX_REPORTED_COLUMNS} drawn columns, in the scheme's order. */
  readonly columns: readonly ReportedColumn[]
  /** How many columns the page draws in all. */
  readonly total: number
  /** The rights this deployment answered with for this user on this table, by the page's own key for each. */
  readonly rights: readonly string[]
}

/** What one answered query reports: three counts and never a row. */
export type QueryReport = {
  /** Rows matching the query, as the backend counted them. */
  readonly total: number
  /** Rows the page is showing. */
  readonly rows: number
  /** The page shown, counted from one. */
  readonly page: number
}

/** What one clicked cell reports: the column, its header, and the row's drawn cells. */
export type CellClickReport = {
  /** The attribute of the clicked column. */
  readonly attr: string
  /** The header the page draws over it, or the attribute where it draws none. */
  readonly label: string
  /** The row's drawn cells, at most {@link MAX_REPORTED_CELLS} of them, each cut to {@link MAX_CELL_LENGTH}. */
  readonly row: Readonly<Record<string, ScalarValue>>
}

/** What one change of ticked rows reports: how many are ticked, and what the first few are called. */
export type SelectReport = {
  /** How many rows are ticked. */
  readonly count: number
  /** The first {@link MAX_NAMED_ROWS} of them, each named by its first drawn cell. */
  readonly names: readonly string[]
}

/** What one opened side card reports: the row it was opened on, by name. */
export type CardOpenReport = {
  /** What the page calls the row the card belongs to. */
  readonly name: string
}

/** What one saved record reports: the drawn cells that name it, and no more of the form. */
export type SaveReport = {
  /** The saved row's drawn cells, at most {@link MAX_SAVED_FIELDS} of them, read exactly as a clicked row's are. */
  readonly record: Readonly<Record<string, ScalarValue>>
}

/**
 * What one submitted export reports: which of the two toolbar exports it was,
 * and the file type the press named.
 *
 * Neither the task the backend queued nor anything the export covers: the page
 * hands over a task number this row has no use for, and the rows the export
 * ranges over are the page's current query or its ticked rows, which the agent
 * has already been told about through the query and the selection.
 */
export type ExportReport = {
  /** The export the page submitted, as the page's own event names it. */
  readonly mode: DataPageExportTaskPayload['mode']
  /** The file type the press named, absent where it named none this report may carry. */
  readonly fileType?: string
}

/** What one pressed row operation reports: which operation, and the row it was pressed on. */
export type OperationReport = {
  /** The operation's own id, as the block declared it. */
  readonly opId: string
  /** The row's drawn cells, read exactly as a clicked row's are. */
  readonly row: Readonly<Record<string, ScalarValue>>
}

/**
 * Whether one value is a scalar a hidden condition may carry.
 * @param value - the value.
 * @returns true for text, a finite number, or a yes-or-no.
 */
function isScalar(value: unknown): value is ScalarValue {
  return typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
}

/**
 * Cut one text value to a ceiling, ending it in an ellipsis where it was cut.
 * @param value - the text.
 * @param max - the ceiling, in characters.
 * @returns the text, at most `max` characters.
 */
function cut(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

/**
 * Read one cell a report may carry out of a row.
 *
 * A number wider than {@link MAX_REPORTED_NUMBER} is left out rather than
 * reported: the catalog admits a record's numbers only inside that range, and
 * a nineteen-digit backend id arrives here already rounded by `JSON.parse`, so
 * carrying it would make the whole report one the agent never receives.
 * @param value - the cell, as the page's row carries it.
 * @returns the cell, cut to {@link MAX_CELL_LENGTH} where it is text, or `undefined` where a report may not carry it.
 */
function readCell(value: unknown): ScalarValue | undefined {
  if (typeof value === 'string') return cut(value, MAX_CELL_LENGTH)
  if (typeof value === 'boolean') return value
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.abs(value) <= MAX_REPORTED_NUMBER ? value : undefined
}

/**
 * Read one attribute name a report may carry.
 * @param value - the candidate.
 * @returns the name, or `undefined` where the catalog would refuse it.
 */
function readAttribute(value: unknown): string | undefined {
  const name = readText(value)
  return name !== undefined && name.length <= MAX_ATTRIBUTE_LENGTH && ATTRIBUTE_NAME.test(name) ? name : undefined
}

/**
 * Read one hidden condition.
 * @param value - one item of the `conditions` property.
 * @returns the condition, or `undefined` when the item names no attribute, no strategy, or no value.
 */
function readCondition(value: unknown): DataPageCondition | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const key = readText(record['key'])
  const op = readText(record['op'])
  if (key === undefined || op === undefined) return undefined
  const matched = record['value']
  if (Array.isArray(matched)) {
    const items = (matched as readonly unknown[]).filter(
      (item): item is string | number => typeof item === 'string' || (typeof item === 'number' && Number.isFinite(item)),
    )
    return { key, op, value: items }
  }
  return isScalar(matched) ? { key, op, value: matched } : undefined
}

/**
 * Read one row operation the block added.
 * @param value - one item of the `customOperations` property.
 * @returns the operation, or `undefined` when the item names no id or no text.
 */
function readOperationItem(value: unknown): DataPageOperation | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const name = readText(record['name'])
  const label = readText(record['label'])
  return name === undefined || label === undefined ? undefined : { name, label }
}

/**
 * Read the sort.
 * @param value - the `querySort` property value.
 * @returns the sort, or `undefined` when the block declares none the page can use.
 */
function readSort(value: unknown): DataPageVueProps['querySort'] {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const asc = readText(record['asc'])
  const desc = readText(record['desc'])
  if (asc === undefined && desc === undefined) return undefined
  return { ...asc === undefined ? {} : { asc }, ...desc === undefined ? {} : { desc } }
}

/**
 * Read one region table: which of the page's regions the block draws.
 * @param value - the `regions` property value.
 * @returns the table, keeping the entries that name a yes-or-no, or `undefined` when the block declares none.
 */
function readRegions(value: unknown): Readonly<Record<string, boolean>> | undefined {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const regions: Record<string, boolean> = {}
  for (const [name, drawn] of Object.entries(record)) {
    const decided = readBoolean(drawn)
    if (decided !== undefined) regions[name] = decided
  }
  return regions
}

/**
 * Narrow a block's properties to what `DataPage` declares.
 *
 * The table is the one property with no usable absence: `relatedMeta` is
 * `required` in the catalog that admitted the block, so a block reaching here
 * without one is a record no call wrote, and mounting the page on an empty
 * table name would open it against nothing and report that as a load. The
 * whole reading is refused instead, and the renderer draws the line saying the
 * block names no table.
 *
 * Every other property is passed on only where the block carries it, so the
 * page's own defaults — an arrangement holding everything, and refusing every
 * write — stand for a block that named none of them.
 * @param props - the block's already-validated properties.
 * @returns the page's prop record, or `undefined` when the block names no table.
 */
export function readDataPage(props: ComponentRendererProps['props']): DataPageVueProps | undefined {
  const relatedMeta = readText(props['relatedMeta'])
  if (relatedMeta === undefined) return undefined
  const matchMode = props['matchMode']
  const querySort = readSort(props['querySort'])
  const selectMode = props['selectMode']
  const isInitQuery = readBoolean(props['isInitQuery'])
  const customOperations = props['customOperations'] === undefined
    ? undefined
    : readList(props['customOperations'], readOperationItem)
  const regions = readRegions(props['regions'])
  const toolbarButtons = props['toolbarButtons'] === undefined ? undefined : readList(props['toolbarButtons'], readText)
  const rowOperations = props['rowOperations'] === undefined ? undefined : readList(props['rowOperations'], readText)
  const queryExpanded = readBoolean(props['queryExpanded'])
  const pageSize = readNumber(props['pageSize'])
  const pageSizes = props['pageSizes'] === undefined ? undefined : readList(props['pageSizes'], readNumber)
  const infoCardTabs = props['infoCardTabs'] === undefined ? undefined : readList(props['infoCardTabs'], readText)
  const readOnly = readBoolean(props['readOnly'])
  return {
    relatedMeta,
    conditions: readList(props['conditions'], readCondition),
    ...(matchMode === 'AND' || matchMode === 'OR' ? { matchMode } : {}),
    ...(querySort === undefined ? {} : { querySort }),
    ...(selectMode === 'checkbox' || selectMode === 'radio' ? { selectMode } : {}),
    ...(isInitQuery === undefined ? {} : { isInitQuery }),
    ...(customOperations === undefined ? {} : { customOperations }),
    ...(regions === undefined ? {} : { regions }),
    ...(toolbarButtons === undefined ? {} : { toolbarButtons }),
    ...(rowOperations === undefined ? {} : { rowOperations }),
    ...(queryExpanded === undefined ? {} : { queryExpanded }),
    ...(pageSize === undefined ? {} : { pageSize }),
    ...(pageSizes === undefined ? {} : { pageSizes }),
    ...(infoCardTabs === undefined ? {} : { infoCardTabs }),
    ...(readOnly === undefined ? {} : { readOnly }),
    myStyle: 'width:100%;height:100%',
  }
}

/**
 * Read the drawn columns out of one loaded scheme.
 *
 * `isShow` is read the way the page reads it — `String(isShow) !== '0'` — so a
 * column the scheme leaves unflagged is drawn and reported. A header longer
 * than the catalog carries is cut; a column whose attribute the catalog would
 * refuse is left out, and a scheme drawing one attribute twice is reported
 * once, under the first header it draws — because the catalog admits one entry
 * per attribute, and one refused column would make the whole report one the
 * agent never receives.
 * @param payload - the `load` event's payload.
 * @returns the drawn columns, one per attribute, in the scheme's order.
 */
export function readLoadedColumns(payload: DataPageLoadPayload): readonly ReportedColumn[] {
  const items = payload.schemaConfig.query?.grid?.gridItems ?? []
  const columns: ReportedColumn[] = []
  const reported = new Set<string>()
  for (const item of items) {
    if (String(item.isShow ?? '1') === '0') continue
    const attr = readAttribute(item.relatedMetaAttr)
    if (attr === undefined || reported.has(attr)) continue
    reported.add(attr)
    const alias = readText(item.alias)
    columns.push(alias === undefined ? { attr } : { attr, alias: cut(alias, MAX_HEADER_LENGTH) })
  }
  return columns
}

/**
 * Read the rights this deployment answered with for this user on this table.
 *
 * The page resolves them before it raises the event, so what arrives is one
 * record of right keys — the deployment's own row for a page that may be
 * written in, and the page's own read-only record otherwise. They are what the
 * deployment granted rather than what the page drew: a read-only page reports
 * the read rights it has and every write it draws no button for. The backend
 * writes `1` and `0` rather than booleans and puts columns of its own beside
 * them, so a key is kept when its value is one of the three spellings of yes
 * and left out otherwise — a reading of a payload rather than a rule about
 * which rights exist.
 * @param payload - the `load` event's payload.
 * @returns the granted keys, at most {@link MAX_REPORTED_RIGHTS} of them and none longer than
 * {@link MAX_RIGHT_LENGTH}, in the record's own order.
 */
export function readGrantedRights(payload: DataPageLoadPayload): readonly string[] {
  const rights = readRecord(payload.authButton)
  if (rights === undefined) return []
  const granted: string[] = []
  for (const [key, value] of Object.entries(rights)) {
    if (value !== true && value !== 1 && value !== '1') continue
    const name = readAttribute(key)
    if (name === undefined || name.length > MAX_RIGHT_LENGTH) continue
    granted.push(name)
    if (granted.length === MAX_REPORTED_RIGHTS) break
  }
  return granted
}

/**
 * Build the load report: the table, the first columns, the count of all, and the granted rights.
 * @param meta - the table the block was opened on.
 * @param columns - the drawn columns, as {@link readLoadedColumns} read them.
 * @param rights - the granted rights, as {@link readGrantedRights} read them.
 * @returns the report.
 */
export function loadReport(meta: string, columns: readonly ReportedColumn[], rights: readonly string[]): LoadReport {
  return { meta, columns: columns.slice(0, MAX_REPORTED_COLUMNS), total: columns.length, rights }
}

/**
 * Read one count out of an answered query.
 * @param value - the value.
 * @returns the count, or `undefined` when it is not a whole number between zero and {@link MAX_REPORTED_NUMBER}.
 */
function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REPORTED_NUMBER
    ? value
    : undefined
}

/**
 * Reduce one answered query to its three counts.
 *
 * A page counts from one; an answer carrying anything else, or no row list,
 * is not a query the agent can be told about.
 * @param payload - the `query-success` event's payload.
 * @returns the report, or `undefined` when the answer carries no counts a report may state.
 */
export function readQuery(payload: CrudQuerySuccessPayload): QueryReport | undefined {
  // Read through the record reader rather than off the declared type: the
  // page's declarations are hand-written against a JavaScript build, so what
  // arrives here can be narrower than they say.
  const counts = readRecord(payload.page)
  const total = readCount(counts?.['total'])
  const page = readCount(counts?.['currentPage'])
  if (total === undefined || page === undefined || page < 1 || !Array.isArray(payload.displayValue)) return undefined
  return { total, rows: payload.displayValue.length, page }
}

/**
 * Read one row's drawn cells, through the columns the page last reported.
 *
 * In the page's own column order and never past the caller's ceiling; a cell a
 * report may not carry is left out, and text is cut to what a report carries.
 * The columns are the gate as well as the order: an attribute the page draws no
 * column for cannot reach a report through here, whoever handed the record
 * over.
 * @param row - the row, as the page's event carries it.
 * @param columns - the drawn columns, as the page last reported them.
 * @param limit - the most cells this report carries.
 * @returns the cells a report may carry.
 */
function readRow(row: ToyRow, columns: readonly ReportedColumn[], limit: number): Readonly<Record<string, ScalarValue>> {
  const cells: Record<string, ScalarValue> = {}
  for (const drawn of columns.slice(0, limit)) {
    const value = readCell(row[drawn.attr])
    if (value === undefined) continue
    cells[drawn.attr] = value
  }
  return cells
}

/**
 * Name one row the way the page draws it: by its first drawn cell.
 * @param row - the row, as the page's event carries it.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the name, or `undefined` when no drawn column holds text or a number for this row.
 */
function nameRow(row: ToyRow, columns: readonly ReportedColumn[]): string | undefined {
  for (const drawn of columns) {
    const value = readCell(row[drawn.attr])
    if (typeof value === 'number') return String(value)
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Reduce one clicked cell to the column and the row's drawn cells.
 * @param payload - the `table-cell-click` event's payload.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the report, or `undefined` when the clicked column is one the catalog would refuse.
 */
export function readCellClick(payload: CrudTableCellClickPayload, columns: readonly ReportedColumn[]): CellClickReport | undefined {
  const attr = readAttribute(payload.column.property)
  if (attr === undefined) return undefined
  const label = cut(readText(payload.column.label) ?? attr, MAX_HEADER_LENGTH)
  return { attr, label, row: readRow(payload.row, columns, MAX_REPORTED_CELLS) }
}

/**
 * Reduce one change of ticked rows to a count and a few names.
 *
 * A selection past {@link MAX_TICKED_ROWS} is not reported at all: the catalog
 * bounds the count, and a page whose backend answered with more rows than a
 * table may draw is one this block has nothing true to say about.
 * @param rows - the ticked rows, as the page's event carries them.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the report, or `undefined` when more rows are ticked than a report may count.
 */
export function readSelection(rows: readonly ToyRow[], columns: readonly ReportedColumn[]): SelectReport | undefined {
  if (rows.length > MAX_TICKED_ROWS) return undefined
  const names: string[] = []
  for (const row of rows.slice(0, MAX_NAMED_ROWS)) {
    const name = nameRow(row, columns)
    if (name !== undefined) names.push(name)
  }
  return { count: rows.length, names }
}

/**
 * Reduce one opened side card to the name of the row it belongs to.
 * @param payload - the `info-card-open` event's payload.
 * @returns the report, or `undefined` when the page named no row.
 */
export function readCardOpen(payload: DataPageInfoCardOpenPayload): CardOpenReport | undefined {
  const named = readText(payload.name) ?? readText(payload.id)
  return named === undefined ? undefined : { name: cut(named, MAX_CELL_LENGTH) }
}

/**
 * Reduce one saved record to the drawn cells that name it.
 *
 * What the page hands over is whatever this deployment's own save endpoint
 * answered with, which is the record and not the table: it carries the row's
 * key, and every attribute the scheme hides from the table as readily as the
 * ones it draws. The reading is therefore taken through the same drawn columns
 * a clicked row is, in the page's own order, and stops at
 * {@link MAX_SAVED_FIELDS} — so an attribute nobody on screen can see does not
 * reach the agent because a save echoed it. An answer holding no drawn cell at
 * all, and one that is not a record, both still report the save, with nothing
 * named.
 * @param answer - the `add-save-success` or `modify-save-success` payload.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the report.
 */
export function readSaved(answer: unknown, columns: readonly ReportedColumn[]): SaveReport {
  const record = readRecord(answer)
  return { record: record === undefined ? {} : readRow(record, columns, MAX_SAVED_FIELDS) }
}

/**
 * Reduce one pressed row operation to the operation and the row it was pressed on.
 * @param operation - the operation, as the page hands the block's own item back.
 * @param row - the row the button sits on, as the page's event carries it.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the report, or `undefined` when the operation's id is one the catalog would refuse.
 */
export function readOperation(
  operation: unknown,
  row: unknown,
  columns: readonly ReportedColumn[],
): OperationReport | undefined {
  const item = readRecord(operation)
  const opId = readAttribute(item?.['name'])
  const pressed = readRecord(row)
  if (opId === undefined || pressed === undefined) return undefined
  return { opId, row: readRow(pressed, columns, MAX_REPORTED_CELLS) }
}

/**
 * Reduce one submitted export to which export it was and the file type it named.
 *
 * The file type is read the way an attribute is, and a press that named none —
 * the button's own body rather than an entry in its list — reports the export
 * alone, exactly as a save whose answer held no drawn cell still reports the
 * save. The mode is the whole gesture, so a payload naming an export neither
 * this row nor the catalog knows is not reported at all.
 * @param payload - the `export-task-created` event's payload.
 * @returns the report, or `undefined` when the payload names no export a report may state.
 */
export function readExportTask(payload: DataPageExportTaskPayload): ExportReport | undefined {
  if (!EXPORT_MODES.includes(payload.mode)) return undefined
  const fileType = readAttribute(payload.fileType)
  return fileType === undefined ? { mode: payload.mode } : { mode: payload.mode, fileType }
}
