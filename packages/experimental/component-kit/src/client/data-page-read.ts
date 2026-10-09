/**
 * What `toy.data-page`, and the form page and info card a view places beside
 * it, read out of their blocks and out of the vendored components' own events
 * — the narrowing of a block's properties into the prop record each component
 * takes, the reduction of each event's payload to the bounded report the
 * placement package's catalog admits, and the two values the data page
 * publishes for the blocks beside it.
 *
 * Pure functions, kept apart from the renderers so each reading is pinned on
 * its own: the properties were already checked by the catalog that admitted
 * the block, but a payload came out of a component, which read it off a
 * backend, and every value of it is judged here before it is reported or
 * published. Every ceiling and charset a judgement holds to is
 * `data-page-limits.ts`'s, which the placement package pins against its own
 * catalog, value for value; the one ceiling no report carries — a published
 * record id's — is read from the placement package itself.
 *
 * Nothing here decides what a component may do. Which regions the page holds,
 * which buttons it keeps and whether it can be written in arrive as properties
 * the catalog already accepted, and are handed to the page as written; whether
 * a press succeeds is the deployment's own answer to the request the component
 * makes with the user's credential.
 * @module @deepseek-ai/dsh-experimental-component-kit/src/client/data-page-read
 */

import type {
  CrudQuerySuccessPayload,
  CrudTableCellClickPayload,
  DataPageAccessDeniedPayload,
  DataPageAuthFailedPayload,
  DataPageBatchModifySavedPayload,
  DataPageDeleteSavedPayload,
  DataPageExportTaskPayload,
  DataPageFormOpenPayload,
  DataPageLoadPayload,
  FormPageSavedPayload,
  InfoCardRecord,
  ToyRow,
} from '@sumomok/toy-crud-kit'
import { MAX_RECORD_ID_LENGTH } from '@deepseek-ai/dsh-experimental-component-surface/client'
import {
  ATTRIBUTE_NAME,
  DENIED_REASONS,
  EXPORT_MODES,
  MAX_AUTH_CODE_LENGTH,
  MAX_AUTH_STATUS,
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
  /** Whether a name or a relation link opens a record when the page draws no side card of its own. */
  readonly infoCardLinks?: boolean
  /** Whether the page refuses every write; the page's own default is `true`. */
  readonly readOnly?: boolean
  /** What a delete does with the spatial resources bound to the record, as the backend's delete request names it. */
  readonly deleteGisResource?: number
  /** The page fills its box; the box carries the height. */
  readonly myStyle: string
}

/**
 * What `FormPage` receives, as the form page block builds it.
 *
 * `request` is the data page's `editing`, which the placement package resolved
 * from the binding the view wrote; it is absent until the data page publishes
 * one and again once the data page withdraws it, and the form then draws
 * nothing and requests nothing.
 */
export type FormPageVueProps = {
  /** The table the form saves into, by its name in the backend. */
  readonly relatedMeta: string
  /** What the data page's add or modify button asked the form to edit. */
  readonly request?: Readonly<Record<string, unknown>>
  /** The form fills its box; the box carries the height. */
  readonly myStyle: string
}

/**
 * What `InfoCard` receives, as the info card block builds it.
 *
 * `record` is the data page's `opened`, resolved the same way a form page's
 * `request` is; the card draws nothing and requests nothing while it is absent.
 */
export type InfoCardVueProps = {
  /** The record a name or a relation link on the data page opened. */
  readonly record?: Readonly<Record<string, unknown>>
  /** Which sections the card draws, where the view chose them. */
  readonly infoCardTabs?: readonly string[]
  /** The card fills its box. */
  readonly myStyle: string
}

/**
 * What the data page is editing, as its `editing` output carries it: a new
 * record of the page's table, or one row of it by id and, where the page shows
 * one, by name.
 */
export type EditingRecord = {
  /** Whether the button pressed was the add button or a row's modify button. */
  readonly mode: 'add' | 'modify'
  /** The table the record belongs to. */
  readonly type: string
  /** The row's id, as text; present for a modify and absent for an add. */
  readonly id?: string
  /** The row's name, cut to what a report carries; absent where the page showed none. */
  readonly name?: string
}

/**
 * The record a name or a relation link on the data page opened, as its
 * `opened` output carries it. `type` is the record's own table, which for a
 * relation link is the related one rather than the page's.
 */
export type OpenedRecord = {
  /** The record's id, as text. */
  readonly id: string
  /** The record's name, cut to what a report carries; absent where the page showed none. */
  readonly name?: string
  /** The table the record belongs to. */
  readonly type: string
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

/** What one opened card reports: the record it shows, by name, and that record's table. */
export type CardOpenReport = {
  /** What the page calls the record the card shows, or its id where the page names it nothing. */
  readonly name: string
  /** The table the record belongs to, which for a relation link is the related one. */
  readonly type: string
}

/**
 * What one delete reports: how many records went, how many did not, and what
 * the first few that went were called.
 *
 * Never a field of a deleted record beyond its name, and never the ids the
 * page deleted by: a record that is gone is nothing the agent can act on, and
 * an id is the backend's key rather than anything the user reads.
 */
export type DeleteReport = {
  /** Records deleted. */
  readonly succeeded: number
  /** Records the backend refused to delete. */
  readonly failed: number
  /** The first {@link MAX_NAMED_ROWS} deleted records, each named by its first readable reported cell. */
  readonly names: readonly string[]
}

/**
 * What one batch edit reports: how many records changed, what the first few
 * are called, and which fields the user changed — never the value written into
 * them.
 */
export type BatchModifyReport = {
  /** Records changed. */
  readonly succeeded: number
  /** Records that could not be changed; the page reports a batch edit only when every record changed. */
  readonly failed: number
  /** The first {@link MAX_NAMED_ROWS} changed records, each named by its first readable reported cell. */
  readonly names: readonly string[]
  /** The fields the user changed, at most {@link MAX_SAVED_FIELDS} of them. */
  readonly fields: readonly string[]
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

/** Why one page-level refusal was decided, as the page's own event spells it. */
export type DeniedReason = DataPageAccessDeniedPayload['reason']

/**
 * What one page-level refusal reports: why the page did not open, and nothing
 * else.
 *
 * The gesture is about one table, and the host is the side that named it: it
 * is the `relatedMeta` the placing call wrote, which the catalog's account
 * reads back off that same node. The page hands that name straight back, so it
 * is read here to tell this block's own refusal from an event about another
 * table, and the name is not carried. What is carried is the reason alone —
 * which of the two judgements the page made — because the two are different
 * things to tell the person: one is about this table, the other is about their
 * account. The profile the page judged against and the permissions in it stay
 * where they were read.
 */
export type DeniedReport = {
  /** Which judgement refused the page, absent where the page named one neither this row nor the catalog knows. */
  readonly reason?: DeniedReason
}

/**
 * What one refused sign-in reports: the answer that refused it, and the
 * deployment's own code for it.
 *
 * Nothing of the sign-in itself: the page presents the credential this visitor
 * already had, and what comes back here is this deployment's verdict on it.
 */
export type AuthFailedReport = {
  /** The refusing answer's own code, and zero where the page had no sign-in to present and sent nothing. */
  readonly status: number
  /**
   * The deployment's own business code, spelled as digits where it answered
   * with a number; absent where it answered with none this report may state.
   */
  readonly code?: string
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
  const infoCardTabs = readInfoCardTabs(props['infoCardTabs'])
  const infoCardLinks = readBoolean(props['infoCardLinks'])
  const readOnly = readBoolean(props['readOnly'])
  const deleteGisResource = readNumber(props['deleteGisResource'])
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
    ...(infoCardLinks === undefined ? {} : { infoCardLinks }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(deleteGisResource === undefined ? {} : { deleteGisResource }),
    myStyle: FILL_BOX,
  }
}

/** The inline style every component here is mounted with: it fills its box, and the box carries the size. */
const FILL_BOX = 'width:100%;height:100%'

/**
 * Read which sections a card draws.
 * @param value - the `infoCardTabs` property value.
 * @returns the sections, or `undefined` when the block chose none, so the component's own default stands.
 */
function readInfoCardTabs(value: unknown): readonly string[] | undefined {
  return value === undefined ? undefined : readList(value, readText)
}

/**
 * Narrow a form page block's properties to what `FormPage` declares.
 *
 * Refused as a whole where the block names no table, for the reason the data
 * page's reading is: `relatedMeta` is required, so such a block is a record no
 * view wrote. The request is passed on as the placement package resolved it —
 * the component judges it again itself, and refuses one naming another table.
 * @param props - the block's already-validated properties.
 * @returns the form's prop record, or `undefined` when the block names no table.
 */
export function readFormPage(props: ComponentRendererProps['props']): FormPageVueProps | undefined {
  const relatedMeta = readText(props['relatedMeta'])
  if (relatedMeta === undefined) return undefined
  const request = readRecord(props['request'])
  return { relatedMeta, ...(request === undefined ? {} : { request }), myStyle: FILL_BOX }
}

/**
 * Narrow an info card block's properties to what `InfoCard` declares.
 * @param props - the block's already-validated properties.
 * @returns the card's prop record; `record` is absent until the data page beside it opens one.
 */
export function readInfoCard(props: ComponentRendererProps['props']): InfoCardVueProps {
  const record = readRecord(props['record'])
  const infoCardTabs = readInfoCardTabs(props['infoCardTabs'])
  return {
    ...(record === undefined ? {} : { record }),
    ...(infoCardTabs === undefined ? {} : { infoCardTabs }),
    myStyle: FILL_BOX,
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
 * The form items of one of the scheme's two forms, as the page's own
 * `add.form[0].formItems` and `modify.form[0].formItems` hold them.
 * @param scheme - the `add` or `modify` part of the loaded scheme.
 * @returns the items, empty where the scheme carries no such form.
 */
function formItemsOf(scheme: unknown): readonly Readonly<Record<string, unknown>>[] {
  const form = readList(readRecord(scheme)?.['form'], readRecord)[0]
  return readList(form?.['formItems'], readRecord)
}

/**
 * Leave out of the loaded columns every attribute the table's scheme masks.
 *
 * An attribute is masked where any of the three schemes the load carries — the
 * table's columns, the add form, the modify form — flags it `showAsPass`, read
 * the way the vendored page reads the flag: any value that is not falsy. The
 * flag is the scheme's own, not whether this user's screen draws the value
 * hidden right now, because a report outlives the screen in the session's
 * record. The masked column is still reported by its name in the load — the
 * header is on screen — and no row report carries its value: every row, saved
 * record and named record is read through what this returns.
 * @param payload - the `load` event's payload.
 * @param columns - the drawn columns, as {@link readLoadedColumns} read them.
 * @returns the columns whose values a report may carry, in the same order.
 */
export function readValueColumns(payload: DataPageLoadPayload, columns: readonly ReportedColumn[]): readonly ReportedColumn[] {
  const scheme = payload.schemaConfig
  const items: readonly Readonly<Record<string, unknown>>[] = [
    ...readList(scheme.query?.grid?.gridItems, readRecord),
    ...formItemsOf(scheme.add),
    ...formItemsOf(scheme.modify),
  ]
  const masked = new Set(items.filter(item => Boolean(item['showAsPass'])).map(item => item['relatedMetaAttr']))
  return columns.filter(column => !masked.has(column.attr))
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
  return { count: rows.length, names: nameRows(rows, columns) }
}

/**
 * Name the first few of a list of rows, each by its first drawn cell, skipping
 * one no drawn column names.
 * @param rows - the rows, as an event carries them; an item that is not a record names nothing.
 * @param columns - the columns whose values a report may carry.
 * @returns at most {@link MAX_NAMED_ROWS} names, taken from the first {@link MAX_NAMED_ROWS} rows.
 */
function nameRows(rows: readonly unknown[], columns: readonly ReportedColumn[]): readonly string[] {
  const names: string[] = []
  for (const row of rows.slice(0, MAX_NAMED_ROWS)) {
    const record = readRecord(row)
    const name = record === undefined ? undefined : nameRow(record, columns)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * Spell one record id as the text the outputs carry it as.
 * @param value - the id, as an event carries it.
 * @returns the id as text, or `undefined` where it is neither non-empty text nor a finite number.
 */
function spellId(value: unknown): string | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : readText(value)
}

/**
 * Read one record id an output may carry.
 * @param value - the id, as an event carries it.
 * @returns the id as text, or `undefined` where it is none or longer than {@link MAX_RECORD_ID_LENGTH}.
 */
function readRecordId(value: unknown): string | undefined {
  const id = spellId(value)
  return id !== undefined && id.length <= MAX_RECORD_ID_LENGTH ? id : undefined
}

/**
 * Read one record name an output may carry.
 * @param value - the name, as an event carries it.
 * @returns the name, cut to {@link MAX_CELL_LENGTH}, or `undefined` where it is not non-empty text.
 */
function readRecordName(value: unknown): string | undefined {
  const name = readText(value)
  return name === undefined ? undefined : cut(name, MAX_CELL_LENGTH)
}

/**
 * Reduce one opened card to the record it shows and that record's table.
 *
 * The data page raises this for its own side card and for a name or relation
 * link whose card a block beside it draws; the info card block raises it when
 * it is handed a new record. Both hand over the same record, whose `type` is
 * the related table where a relation link opened it, so both report the
 * table. A record the page shows no name for is named by its id.
 * @param payload - the `info-card-open` event's payload.
 * @returns the report, or `undefined` when the record names no table a report may carry, or neither a name nor an id.
 */
export function readCardOpen(payload: InfoCardRecord): CardOpenReport | undefined {
  const record = readRecord(payload)
  const type = readAttribute(record?.['type'])
  const name = readText(record?.['name']) ?? spellId(record?.['id'])
  return type === undefined || name === undefined ? undefined : { name: cut(name, MAX_CELL_LENGTH), type }
}

/**
 * Read the record one name or relation link opened, as the data page's
 * `opened` output carries it.
 *
 * The id is published as text whatever the backend typed it as. A record the
 * catalog's `opened` would refuse — no id, one longer than
 * {@link MAX_RECORD_ID_LENGTH}, a table name it would not admit — is not
 * published at all, and the renderer withdraws the previous one instead: the
 * placement package judges a bound property after resolving it, so a value it
 * would refuse would turn the card into the seat's waiting line.
 * @param payload - the `info-card-open` event's payload.
 * @returns the record, or `undefined` when it is not one the output may carry.
 */
export function readOpened(payload: InfoCardRecord): OpenedRecord | undefined {
  const record = readRecord(payload)
  const id = readRecordId(record?.['id'])
  const type = readAttribute(record?.['type'])
  if (id === undefined || type === undefined) return undefined
  const name = readRecordName(record?.['name'])
  return name === undefined ? { id, type } : { id, name, type }
}

/**
 * Read what one press of the add button or of a row's modify button opened
 * for editing, as the data page's `editing` output carries it.
 *
 * An add carries the table and nothing else, whatever the payload holds beside
 * it. A modify carries the row's id as text and, where the page shows one, its
 * name; one without an id names no row and is not published, nor is a value
 * the catalog's `editing` would refuse, for the reason {@link readOpened} gives.
 * @param payload - the `form-open` event's payload.
 * @returns the value, or `undefined` when it is not one the output may carry.
 */
export function readEditing(payload: DataPageFormOpenPayload): EditingRecord | undefined {
  const record = readRecord(payload)
  const mode = record?.['mode']
  const type = readAttribute(record?.['type'])
  if ((mode !== 'add' && mode !== 'modify') || type === undefined) return undefined
  if (mode === 'add') return { mode, type }
  const id = readRecordId(record?.['id'])
  if (id === undefined) return undefined
  const name = readRecordName(record?.['name'])
  return name === undefined ? { mode, type, id } : { mode, type, id, name }
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
 * Reduce one record the form page saved to the fields that name it.
 *
 * The form page hands over a record it already trimmed: only the fields of the
 * form that the table's data page last reported as columns, with every
 * attribute any scheme of the table masks left out, and `{}` where no data page
 * has reported the table's columns. What is left is held to what a report
 * carries — an attribute name the catalog admits, a cell a report may carry,
 * at most {@link MAX_SAVED_FIELDS} of them in the order the form page gave —
 * and a record with nothing left still reports the save.
 * @param payload - the `form-saved` event's payload.
 * @returns the report, or `undefined` when the save names neither of the form's two modes.
 */
export function readFormSaved(payload: FormPageSavedPayload): SaveReport | undefined {
  const saved = readRecord(payload)
  const mode = saved?.['mode']
  if (mode !== 'add' && mode !== 'modify') return undefined
  const fields = readRecord(saved?.['record'])
  const record: Record<string, ScalarValue> = {}
  for (const [key, value] of Object.entries(fields ?? {})) {
    const attr = readAttribute(key)
    const cell = readCell(value)
    if (attr === undefined || cell === undefined) continue
    record[attr] = cell
    if (Object.keys(record).length === MAX_SAVED_FIELDS) break
  }
  return { record }
}

/**
 * Reduce one delete to how many records went, how many did not, and the names
 * of the first few that went.
 *
 * The page raises this only where at least one record was deleted, for a
 * row's own delete and for a batch delete alike, and hands over each deleted
 * record already trimmed to the table's reported, unmasked columns. Each is
 * named here through `columns` all the same, the way a ticked row is, so a
 * name is never read out of a masked cell whoever trimmed the record.
 * @param payload - the `delete-save-success` event's payload.
 * @param columns - the columns whose values a report may carry.
 * @returns the report, or `undefined` when the payload states no count a report may carry.
 */
export function readDeleted(payload: DataPageDeleteSavedPayload, columns: readonly ReportedColumn[]): DeleteReport | undefined {
  const record = readRecord(payload)
  const deleted = record?.['deleted']
  const failed = readCount(record?.['failed'])
  if (!Array.isArray(deleted) || failed === undefined) return undefined
  return { succeeded: deleted.length, failed, names: nameRows(deleted, columns) }
}

/**
 * Read the ids of the records one delete removed, which is what decides
 * whether a value the data page published still names a record.
 * @param payload - the `delete-save-success` event's payload.
 * @returns the ids, as text; empty when the payload carries none.
 */
export function readDeletedIds(payload: DataPageDeleteSavedPayload): readonly string[] {
  return readList(readRecord(payload)?.['ids'], readText)
}

/**
 * Reduce one batch edit to how many records changed, the names of the first
 * few, and which fields the user changed.
 *
 * The page raises this only where every record changed, handing over each
 * already trimmed the way a deleted one is, and the names of the attributes
 * the user ticked without the value written into them. The names are read
 * through `columns` as a delete's are; a field name the catalog would refuse is
 * left out, each is named once, and at most {@link MAX_SAVED_FIELDS} are kept.
 * @param payload - the `batch-modify-save-success` event's payload.
 * @param columns - the columns whose values a report may carry.
 * @returns the report, or `undefined` when the payload carries no list of changed records.
 */
export function readBatchModified(
  payload: DataPageBatchModifySavedPayload,
  columns: readonly ReportedColumn[],
): BatchModifyReport | undefined {
  const record = readRecord(payload)
  const modified = record?.['modified']
  if (!Array.isArray(modified)) return undefined
  const fields = [...new Set(readList(record?.['attrs'], readAttribute))].slice(0, MAX_SAVED_FIELDS)
  return { succeeded: modified.length, failed: 0, names: nameRows(modified, columns), fields }
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

/**
 * Judge one page-level refusal, and reduce it to why it was refused.
 *
 * The page raises this instead of loading: it read this user's own profile and
 * fetched nothing — no scheme, no dictionary, no query. What it hands over is
 * the table's own name and one of two reasons. The name is read only to tell
 * this block's own refusal from an event about another table: a payload naming
 * another one, or naming none, is not this block's refusal and is not reported.
 * The reason is reported when it is one of the two this row and the catalog
 * both know, and left out otherwise, so a page that starts naming a third
 * refuses to open here exactly as it does on screen rather than making the
 * whole report one the agent never receives.
 * @param payload - the `access-denied` event's payload.
 * @param meta - the table the block was opened on.
 * @returns the report, or `undefined` when the payload does not name that table.
 */
export function readAccessDenied(payload: DataPageAccessDeniedPayload, meta: string): DeniedReport | undefined {
  const record = readRecord(payload)
  if (record === undefined || readText(record['meta']) !== meta) return undefined
  const reason: DeniedReason | undefined = DENIED_REASONS.find(known => known === record['reason'])
  return reason === undefined ? {} : { reason }
}

/**
 * Read one business code a refused sign-in may carry.
 *
 * The deployment answers it as a number as readily as it answers it as text,
 * and it is an identifier its own messages print rather than a quantity: it is
 * reported as one text value, a whole number spelled as its digits. A code
 * past {@link MAX_AUTH_CODE_LENGTH} is left out rather than cut.
 * @param value - the code, as the page's event carries it.
 * @returns the code, or `undefined` where the answer carried none a report may state.
 */
function readAuthCode(value: unknown): string | undefined {
  const spelled = typeof value === 'number' && Number.isInteger(value) ? String(value) : readText(value)
  return spelled !== undefined && spelled.length <= MAX_AUTH_CODE_LENGTH ? spelled : undefined
}

/**
 * Reduce one refused sign-in to the answer that refused it.
 *
 * The page raises this where this deployment answered a request by refusing
 * the visitor's credential rather than by answering the request: it sends the
 * person nowhere, draws a line inside its own box, and raises this once per
 * mount until a request of its own succeeds. Every data page on screen is
 * raised the same one, because the layer that judged it is not told which page
 * asked.
 *
 * The answer code is the whole gesture, so a payload carrying none, or one
 * that is not a whole answer code, is not reported at all.
 * @param payload - the `auth-failed` event's payload.
 * @returns the report, or `undefined` when the payload names no answer a report may state.
 */
export function readAuthFailed(payload: DataPageAuthFailedPayload): AuthFailedReport | undefined {
  const record = readRecord(payload)
  if (record === undefined) return undefined
  const status = record['status']
  if (typeof status !== 'number' || !Number.isInteger(status) || status < 0 || status > MAX_AUTH_STATUS) return undefined
  const code = readAuthCode(record['code'])
  return code === undefined ? { status } : { status, code }
}
