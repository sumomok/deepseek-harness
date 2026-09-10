/**
 * What `toy.crud` reads out of its block and out of the page's own events —
 * the narrowing of a call's properties into the prop record `Crud` takes, and
 * the reduction of each event's payload to the bounded report the placement
 * package's catalog admits.
 *
 * Pure functions, kept apart from the renderer so each reading is pinned on
 * its own: the properties were already checked by the catalog that admitted
 * the block, but a payload came out of the page, which read it off a backend,
 * and every value of it is judged here before it is reported. Every ceiling
 * and charset a judgement holds to is `crud-limits.ts`'s, which the placement
 * package pins against its own catalog, value for value.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/crud-read
 */

import {
  CRUD_READ_ONLY_PROPS,
  type CrudHostFixedProps,
  type CrudLoadPayload,
  type CrudQuerySuccessPayload,
  type CrudTableCellClickPayload,
} from '@sumomok/toy-crud-kit'
import {
  ATTRIBUTE_NAME,
  MAX_ATTRIBUTE_LENGTH,
  MAX_CELL_LENGTH,
  MAX_HEADER_LENGTH,
  MAX_REPORTED_CELLS,
  MAX_REPORTED_COLUMNS,
  MAX_REPORTED_NUMBER,
} from './crud-limits.ts'
import { readBoolean, readList, readRecord, readText, type ScalarValue } from './props.ts'
import type { ComponentRendererProps } from './renderer.ts'

/** One hidden condition, as `Crud` takes it. */
export interface CrudCondition {
  /** The attribute the condition is about. */
  readonly key: string
  /** The match strategy, as the backend names it. */
  readonly op: string
  /** What the attribute is matched against: one scalar, or a list of text and numbers. */
  readonly value: ScalarValue | readonly (string | number)[]
}

/**
 * What `Crud` receives, as this component builds it. `Pick`ed rather than
 * intersected with the kit's interface, so the record stays assignable to the
 * bridge's plain prop record.
 */
export type CrudVueProps = Pick<CrudHostFixedProps, keyof CrudHostFixedProps> & {
  /** The table, by its name in the backend. */
  readonly relatedMeta: string
  /** The hidden conditions; empty where the call wrote none. */
  readonly conditions: readonly CrudCondition[]
  /** How the conditions join; the component's own default applies when absent. */
  readonly matchMode?: 'AND' | 'OR'
  /** The sort; the component's own default applies when absent. */
  readonly querySort?: { readonly asc?: string; readonly desc?: string }
  /** How rows are ticked, or `null` for a page nothing is ticked in. */
  readonly selectMode: 'checkbox' | 'radio' | null
  /** Whether the query panel opens expanded; the component's own default applies when absent. */
  readonly isExpandQuery?: boolean
  /** Whether the first query runs without a press; the component's own default applies when absent. */
  readonly isInitQuery?: boolean
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

/** What one load reports: the table, its first drawn columns, and how many it draws in all. */
export type LoadReport = {
  /** The table the page was opened on. */
  readonly meta: string
  /** The first {@link MAX_REPORTED_COLUMNS} drawn columns, in the scheme's order. */
  readonly columns: readonly ReportedColumn[]
  /** How many columns the page draws in all. */
  readonly total: number
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
 * carrying it would make the whole click report one the agent never receives.
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
function readCondition(value: unknown): CrudCondition | undefined {
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
 * Read the sort.
 * @param value - the `querySort` property value.
 * @returns the sort, or `undefined` when the block declares none the component can use.
 */
function readSort(value: unknown): CrudVueProps['querySort'] {
  const record = readRecord(value)
  if (record === undefined) return undefined
  const asc = readText(record['asc'])
  const desc = readText(record['desc'])
  if (asc === undefined && desc === undefined) return undefined
  return { ...asc === undefined ? {} : { asc }, ...desc === undefined ? {} : { desc } }
}

/**
 * Narrow a block's properties to what `Crud` declares, with the host-fixed
 * properties written over whatever the call carried.
 *
 * The table is the one property with no usable absence: `relatedMeta` is
 * `required` in the catalog that admitted the block, so a block reaching here
 * without one is a record no call wrote, and mounting the page on an empty
 * table name would open it against nothing and report that as a load. The
 * whole reading is refused instead, and the renderer draws the line saying the
 * block names no table.
 * @param props - the block's already-validated properties.
 * @returns the component's prop record, or `undefined` when the block names no table.
 */
export function readCrud(props: ComponentRendererProps['props']): CrudVueProps | undefined {
  const relatedMeta = readText(props['relatedMeta'])
  if (relatedMeta === undefined) return undefined
  const matchMode = props['matchMode']
  const querySort = readSort(props['querySort'])
  const selectMode = props['selectMode']
  const isExpandQuery = readBoolean(props['isExpandQuery'])
  const isInitQuery = readBoolean(props['isInitQuery'])
  return {
    relatedMeta,
    conditions: readList(props['conditions'], readCondition),
    ...(matchMode === 'AND' || matchMode === 'OR' ? { matchMode } : {}),
    ...(querySort === undefined ? {} : { querySort }),
    selectMode: selectMode === 'checkbox' || selectMode === 'radio' ? selectMode : null,
    ...(isExpandQuery === undefined ? {} : { isExpandQuery }),
    ...(isInitQuery === undefined ? {} : { isInitQuery }),
    myStyle: 'width:100%;height:100%',
    ...CRUD_READ_ONLY_PROPS,
  }
}

/**
 * Read the drawn columns out of one loaded scheme.
 *
 * `isShow` is read the way the component reads it — `String(isShow) !== '0'`
 * — so a column the scheme leaves unflagged is drawn and reported. A header
 * longer than the catalog carries is cut; a column whose attribute the catalog
 * would refuse is left out, and a scheme drawing one attribute twice is
 * reported once, under the first header it draws — because the catalog admits
 * one entry per attribute, and one refused column would make the whole report
 * one the agent never receives.
 * @param payload - the `load` event's payload.
 * @returns the drawn columns, one per attribute, in the scheme's order.
 */
export function readLoadedColumns(payload: CrudLoadPayload): readonly ReportedColumn[] {
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
 * Build the load report: the table, the first columns, and the count of all.
 * @param meta - the table the block was opened on.
 * @param columns - the drawn columns, as {@link readLoadedColumns} read them.
 * @returns the report.
 */
export function loadReport(meta: string, columns: readonly ReportedColumn[]): LoadReport {
  return { meta, columns: columns.slice(0, MAX_REPORTED_COLUMNS), total: columns.length }
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
 * Reduce one clicked cell to the column and the row's drawn cells.
 *
 * The cells are read through the columns the page last reported, in that
 * order and never past the first {@link MAX_REPORTED_CELLS}; a cell a report
 * may not carry is left out, and text is cut to what a report carries.
 * @param payload - the `table-cell-click` event's payload.
 * @param columns - the drawn columns, as the page last reported them.
 * @returns the report, or `undefined` when the clicked column is one the catalog would refuse.
 */
export function readCellClick(payload: CrudTableCellClickPayload, columns: readonly ReportedColumn[]): CellClickReport | undefined {
  const attr = readAttribute(payload.column.property)
  if (attr === undefined) return undefined
  const label = cut(readText(payload.column.label) ?? attr, MAX_HEADER_LENGTH)
  const row: Record<string, ScalarValue> = {}
  for (const drawn of columns.slice(0, MAX_REPORTED_CELLS)) {
    const value = readCell(payload.row[drawn.attr])
    if (value === undefined) continue
    row[drawn.attr] = value
  }
  return { attr, label, row }
}
