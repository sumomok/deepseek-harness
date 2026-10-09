/**
 * `toy.data-page` — the deployment's own full data page for one table, drawn
 * as it was written and reporting only what the agent needs to talk about it.
 *
 * The component is `DataPage`, the container the vendored
 * `@sumomok/toy-crud-kit` assembles out of `Crud.vue`'s own sub-components in
 * `Crud.vue`'s own arrangement. Unlike every other block in this row it
 * fetches: its scheme, its table's dictionary, and each query's rows go browser
 * → deployment with the visitor's own token, and nothing on the host reads any
 * of it. `README.md` records what that costs and where the page may navigate.
 *
 * What the block carries and where each property came from. The catalog admits
 * two groups: what the page is opened on, which a `show_component` call writes,
 * and how the page is arranged and whether it can be written in, which only a
 * written-down page may set — the placement package refuses the second group in
 * a call. Both arrive here already accepted, and this renderer passes on only
 * the properties the block actually carries, so a page nobody arranged opens
 * with the page's own defaults: every region drawn, every toolbar button kept,
 * and `readOnly` on. Whether the page is arranged to draw a button is the
 * block's, and whether pressing it succeeds is the deployment's own answer to
 * the request the page makes with the user's credential. Between the two sits
 * one host decision no block carries: `abilities`, what this visitor may do on
 * this table, which this renderer fetches from the row's node half — where
 * `ctx.bizBackend` judges the visitor's rights by the deployment's rule table —
 * and passes on last, so no property of the block can stand in for it. It can
 * only remove an entrance the arrangement drew. Until the verdict arrives, and
 * whenever none can be obtained, every one of the five is off; when it arrives
 * the page's entrances change in place, with no remount and no new query. The
 * page still fixes the customer's own `useCloudPermission: false`, because the
 * per-button rights the deployment answers with are null for every account on
 * the flags it does not enforce, and reading them would hide the query button
 * too.
 *
 * Before any of that the page judges one thing on its own: it reads this
 * user's own profile and refuses to fetch anything — no scheme, no dictionary,
 * no query — where the permissions that profile carries name tables at all and
 * none of them is this one, and where those permissions could not be obtained
 * at all. Either way it draws the deployment's own refusal inside the box and
 * raises `access-denied` once, naming which of the two it was. No property of
 * the block reaches that judgement, and nothing here softens it; what this
 * renderer does with it is report it once, so the agent can say why the page is
 * empty. The third answer — this deployment said nothing at all — draws a line
 * inside the box and raises nothing, so nothing is reported for it.
 *
 * A refused sign-in is separate from all of that and arrives from the request
 * layer rather than from the judgement: where this deployment answers any of
 * the page's requests by refusing the visitor's credential, the page sends the
 * person nowhere, draws a line in its own box, and raises `auth-failed` once
 * per mount until a request of its own succeeds. That layer is not told which
 * block asked, so every data page on screen is raised the same one and each
 * reports its own — one note per block rather than one per page load, because
 * the placement package supersedes a block's unclaimed note with that same
 * block's next one.
 *
 * All fourteen `context` gestures the placement package's catalog declares come
 * back, each bounded the way that catalog bounds it — `data-page-read.ts` holds
 * the readings and the ceilings: on `access-denied`, which of the two
 * judgements refused this table, and nothing else; on `auth-failed`, the answer
 * this deployment refused the visitor's credential with; on `load`, the table,
 * the first drawn columns and the rights this deployment answered with for this
 * user; on `query-success`, three counts and never a row; on
 * `table-selection-change`, how many rows are ticked and what the first few are
 * called; on `table-cell-click` and `table-operation-custom`, the one row's
 * drawn cells; on `info-card-open` and `info-card-close`, the record the side
 * card shows and its table, and that it shows none any more; on
 * `add-save-success` and `modify-save-success`, that a record was saved and the
 * fields that name it; on `delete-save-success` and `batch-modify-save-success`,
 * how many records went or changed, what the first few are called, and for a
 * batch edit which fields — never a value; on `export-task-created`, which of
 * the two toolbar exports the page submitted to this deployment's backend and
 * in which file type — the task number the backend answered with goes no
 * further than the page. A load or a query identical to the one this block last
 * reported for the same placing call is not reported again, which is what keeps
 * a tab switch — the column drops and redraws a block, and the page loads and
 * queries afresh — from telling the agent the same thing twice.
 *
 * No row report carries a masked value. A column the table's scheme flags
 * `showAsPass` — in its columns, its add form or its modify form — is still
 * named in the load, because its header is on screen, and every row, saved
 * record and named record is read through the columns that remain. The same
 * columns are handed to the page as the ones it may report a saved record's
 * values from, which is the list the form page beside it trims its own saves to.
 *
 * Two values are published for the blocks a view places beside the page, and
 * neither is a gesture: `editing`, what the last press of the add button or a
 * row's modify button opened, which a form page reads; and `opened`, the record
 * a name or a relation link last opened, which an info card reads. `opened` is
 * withdrawn when the page closes its card, is cleared or turns a page, and each
 * is withdrawn when a delete removes the record it names. A value either output
 * could not carry is not published, and the one standing is withdrawn instead.
 * Whose report an opened card is depends on where the card is drawn: where this
 * page draws its own side card it reports the card's `card-open` and
 * `card-close`; where the view switched that card off, it only publishes and
 * withdraws `opened`, and the info card block beside it reports — so one card
 * is never reported twice.
 *
 * Before the page is drawn it waits on the base path its requests go under and
 * is mounted inside a contained box, both of which `crud-box.ts` records.
 *
 * The box carries a height of its own for the same reason it carries the
 * containment: the page is `height: 100%` over a query panel, a table and a
 * pager, and a percentage with nothing under it collapses the table to one row
 * without an error. The box fills the column it is drawn in and falls back to a
 * fixed height where the column gives it none, so the page is a page either
 * way.
 *
 * The vendored page is imported statically, so it is part of this row's single
 * browser bundle and every console downloads it, including deployments that
 * leave `dataPage: false`. `README.md` records why deferring it is not
 * available here: a plugin's client bundle is one closure-factory file the
 * loader fetches by name, so there is no second chunk for a dynamic import to
 * land in.
 *
 * element-ui must already be installed on the shared runtime — the row's
 * client plugin does that when it starts, and a test drawing this block on its
 * own calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef } from 'react'
import {
  DataPage,
  noteReportedColumns,
  type CrudQuerySuccessPayload,
  type CrudTableCellClickPayload,
  type DataPageAccessDeniedPayload,
  type DataPageAuthFailedPayload,
  type DataPageBatchModifySavedPayload,
  type DataPageDeleteSavedPayload,
  type DataPageExportTaskPayload,
  type DataPageFormOpenPayload,
  type DataPageInfoCardOpenPayload,
  type DataPageLoadPayload,
  type ToyRow,
} from '@sumomok/toy-crud-kit'
import {
  loadReport,
  readAccessDenied,
  readAuthFailed,
  readBatchModified,
  readCardOpen,
  readCellClick,
  readDataPage,
  readDeleted,
  readDeletedIds,
  readEditing,
  readExportTask,
  readGrantedRights,
  readLoadedColumns,
  readOpened,
  readOperation,
  readQuery,
  readSaved,
  readSelection,
  readValueColumns,
  type DataPageVueProps,
  type EditingRecord,
  type OpenedRecord,
  type ReportedColumn,
} from './data-page-read.ts'
import { useBasePathState, useContainedComponent } from './crud-box.ts'
import { useAbilities } from './use-abilities.ts'
import { keepMarked, markDataPage } from './marks.ts'
import type { DataPageAbilityTable } from '../route.ts'
import type { VueEventHandlers } from './vue2-bridge.tsx'
import css from './DataPageRenderer.module.css'
import type { ComponentKitKey } from './locales.ts'
import type { ComponentActionHandler, ComponentOutputHandler, ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.data-page'

/** Action id the loaded columns are reported under. */
const LOAD_ACTION_ID = 'load'

/** Action id a table this user's account is not granted is reported under. */
const DENIED_ACTION_ID = 'denied'

/** Action id a sign-in this deployment refused is reported under. */
const AUTH_FAILED_ACTION_ID = 'auth-failed'

/** Action id one answered query's counts are reported under. */
const QUERY_ACTION_ID = 'query'

/** Action id a clicked cell is reported under. */
const CELL_CLICK_ACTION_ID = 'cell-click'

/** Action id a change of ticked rows is reported under. */
const SELECT_ACTION_ID = 'select'

/** Action id an opened side card is reported under. */
const CARD_OPEN_ACTION_ID = 'card-open'

/** Action id a side card that no longer shows a record is reported under. */
const CARD_CLOSE_ACTION_ID = 'card-close'

/** Action id a saved new record is reported under. */
const ADDED_ACTION_ID = 'added'

/** Action id a saved edit is reported under. */
const MODIFIED_ACTION_ID = 'modified'

/** Action id a pressed row operation is reported under. */
const OPERATION_ACTION_ID = 'operation'

/** Action id a submitted export task is reported under. */
const EXPORTED_ACTION_ID = 'exported'

/** Action id deleted records are reported under. */
const DELETED_ACTION_ID = 'deleted'

/** Action id records changed at once are reported under. */
const BATCH_MODIFIED_ACTION_ID = 'batch-modified'

/** Output id the record a name or a relation link opened is published under. */
const OPENED_OUTPUT_ID = 'opened'

/** Output id what the add or a modify button opened for editing is published under. */
const EDITING_OUTPUT_ID = 'editing'

/** The values this block last published, by output. */
interface PublishedValues {
  /** What the last press of the add or a modify button opened, while it stands. */
  editing?: EditingRecord | undefined
  /** The record a name or a relation link last opened, while it stands. */
  opened?: OpenedRecord | undefined
}

/**
 * What one placing call's block has already told the agent, and published for
 * the blocks beside it, so a redraw of the same call does not tell it again.
 *
 * Keyed by the block's property record, which the placement package hands over
 * unchanged for the life of one call and replaces for the next — so a later
 * call under the same ids starts with nothing reported, and a block the column
 * dropped and drew again finds what it said before. The published values live
 * here for the same reason: the placement package keeps them for the call, not
 * for one mount, so a delete after a redraw still finds the value it withdraws.
 */
interface ReportMemory {
  /** The columns whose values a row report may carry: the page's last reported columns, less the masked ones. */
  columns: readonly ReportedColumn[]
  /** The last load report, serialized. */
  load?: string
  /** The last query report, serialized. */
  query?: string
  /** The last refusal report, serialized. */
  denied?: string
  /** The last refused-sign-in report, serialized. */
  authFailed?: string
  /** What this block has published and not withdrawn. */
  readonly published: PublishedValues
}

/** Every placing call's memory, released with its property record. */
const MEMORIES = new WeakMap<Readonly<Record<string, unknown>>, ReportMemory>()

/**
 * Find or open the memory for one placing call.
 * @param props - the block's property record, as the placement package holds it.
 * @returns the memory.
 */
function memoryOf(props: Readonly<Record<string, unknown>>): ReportMemory {
  const held = MEMORIES.get(props)
  if (held !== undefined) return held
  const opened: ReportMemory = { columns: [], published: {} }
  MEMORIES.set(props, opened)
  return opened
}

/** What the listener map reads at the moment an event arrives. */
interface DataPageEventContext {
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
  /** Where a value the blocks beside this one read goes. */
  readonly onOutput: ComponentOutputHandler
  /** The table the block was opened on, which every load names. */
  readonly meta: string
  /** Whether the page draws its own side card, which decides whose report an opened card is. */
  readonly cardInPage: boolean
  /** What this placing call's block has already reported and published. */
  readonly memory: ReportMemory
}

/**
 * Report one gesture unless this placing call's block has reported the same one.
 * @param context - the block's event context.
 * @param field - which memory the report is held in.
 * @param actionId - the action to report.
 * @param payload - what to report.
 */
function reportOnce(
  context: DataPageEventContext,
  field: 'load' | 'query' | 'denied' | 'authFailed',
  actionId: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  const signature = JSON.stringify(payload)
  if (context.memory[field] === signature) return
  context.memory[field] = signature
  context.onAction(actionId, payload)
}

/**
 * Publish what the add or a modify button opened, or withdraw it with `undefined`.
 * @param context - the block's event context.
 * @param value - the value, or `undefined` to withdraw the one standing.
 */
function publishEditing(context: DataPageEventContext, value: EditingRecord | undefined): void {
  context.memory.published.editing = value
  context.onOutput(EDITING_OUTPUT_ID, value)
}

/**
 * Publish the record a name or a relation link opened, or withdraw it with `undefined`.
 * @param context - the block's event context.
 * @param value - the value, or `undefined` to withdraw the one standing.
 */
function publishOpened(context: DataPageEventContext, value: OpenedRecord | undefined): void {
  context.memory.published.opened = value
  context.onOutput(OPENED_OUTPUT_ID, value)
}

/**
 * Withdraw each published value that names a record one delete removed.
 *
 * A value names a deleted record when its id is among the deleted ones and its
 * table is this page's: both outputs can name a related table's record — a
 * relation link opens one, and the side card's own modify entrance edits one —
 * and a record of another table under the same id is not the one deleted.
 * @param context - the block's event context.
 * @param ids - the ids the delete removed.
 */
function withdrawDeleted(context: DataPageEventContext, ids: readonly string[]): void {
  const { editing, opened } = context.memory.published
  const names = (value: EditingRecord | OpenedRecord | undefined): boolean =>
    value?.id !== undefined && value.type === context.meta && ids.includes(value.id)
  if (names(editing)) publishEditing(context, undefined)
  if (names(opened)) publishOpened(context, undefined)
}

/** What `DataPage` is mounted with: the block's properties, then the host's verdict on this visitor. */
type DataPageMountProps = DataPageVueProps & {
  /** What this visitor may do on this table; only ever removes an entrance. */
  readonly abilities: DataPageAbilityTable
}

/** What one drawn page needs beyond the block's own identity. */
interface DataPageProps extends Pick<ComponentRendererProps, 'props' | 'onAction' | 'onOutput'> {
  /** The block's properties and the host's verdict, as `DataPage` takes them. */
  readonly vueProps: DataPageMountProps
}

/** The page itself, drawn once the base path its requests go under is in force. */
function DataPageBlock({ props, vueProps, onAction, onOutput }: DataPageProps) {
  const memory = memoryOf(props)
  const eventContext = (): DataPageEventContext => ({
    onAction,
    onOutput,
    meta: vueProps.relatedMeta,
    cardInPage: vueProps.regions?.['infoCard'] !== false,
    memory,
  })
  const context = useRef<DataPageEventContext>(eventContext())
  useEffect(() => {
    context.current = eventContext()
  })
  const on = useMemo<VueEventHandlers>(() => ({
    'access-denied': (payload: DataPageAccessDeniedPayload) => {
      const current = context.current
      const report = readAccessDenied(payload, current.meta)
      if (report !== undefined) reportOnce(current, 'denied', DENIED_ACTION_ID, report)
    },
    'auth-failed': (payload: DataPageAuthFailedPayload) => {
      const current = context.current
      const report = readAuthFailed(payload)
      if (report !== undefined) reportOnce(current, 'authFailed', AUTH_FAILED_ACTION_ID, report)
    },
    load: (payload: DataPageLoadPayload) => {
      const current = context.current
      const columns = readLoadedColumns(payload)
      current.memory.columns = readValueColumns(payload, columns)
      // The page registered its own columns before raising this, so this
      // narrower list is the one it trims what it saves to.
      noteReportedColumns(current.meta, current.memory.columns.map(column => column.attr))
      reportOnce(current, 'load', LOAD_ACTION_ID, loadReport(current.meta, columns, readGrantedRights(payload)))
    },
    'query-success': (payload: CrudQuerySuccessPayload) => {
      const report = readQuery(payload)
      if (report !== undefined) reportOnce(context.current, 'query', QUERY_ACTION_ID, report)
    },
    'table-cell-click': (payload: CrudTableCellClickPayload) => {
      const current = context.current
      const report = readCellClick(payload, current.memory.columns)
      if (report !== undefined) current.onAction(CELL_CLICK_ACTION_ID, report)
    },
    'table-selection-change': (rows: readonly ToyRow[]) => {
      const current = context.current
      const report = readSelection(rows, current.memory.columns)
      if (report !== undefined) current.onAction(SELECT_ACTION_ID, report)
    },
    'form-open': (payload: DataPageFormOpenPayload) => { publishEditing(context.current, readEditing(payload)) },
    'info-card-open': (payload: DataPageInfoCardOpenPayload) => {
      const current = context.current
      publishOpened(current, readOpened(payload))
      if (!current.cardInPage) return
      const report = readCardOpen(payload)
      if (report !== undefined) current.onAction(CARD_OPEN_ACTION_ID, report)
    },
    'info-card-close': () => {
      const current = context.current
      publishOpened(current, undefined)
      if (current.cardInPage) current.onAction(CARD_CLOSE_ACTION_ID, {})
    },
    'add-save-success': (answer: unknown) => {
      const current = context.current
      current.onAction(ADDED_ACTION_ID, readSaved(answer, current.memory.columns))
    },
    'modify-save-success': (answer: unknown) => {
      const current = context.current
      current.onAction(MODIFIED_ACTION_ID, readSaved(answer, current.memory.columns))
    },
    'delete-save-success': (payload: DataPageDeleteSavedPayload) => {
      const current = context.current
      const report = readDeleted(payload, current.memory.columns)
      if (report !== undefined) current.onAction(DELETED_ACTION_ID, report)
      withdrawDeleted(current, readDeletedIds(payload))
    },
    'batch-modify-save-success': (payload: DataPageBatchModifySavedPayload) => {
      const current = context.current
      const report = readBatchModified(payload, current.memory.columns)
      if (report !== undefined) current.onAction(BATCH_MODIFIED_ACTION_ID, report)
    },
    'table-operation-custom': (scope: { readonly row?: ToyRow }, item: unknown) => {
      const current = context.current
      const report = readOperation(item, scope.row, current.memory.columns)
      if (report !== undefined) current.onAction(OPERATION_ACTION_ID, report)
    },
    'export-task-created': (payload: DataPageExportTaskPayload) => {
      const current = context.current
      const report = readExportTask(payload)
      if (report !== undefined) current.onAction(EXPORTED_ACTION_ID, report)
    },
  }), [])
  const { box, host } = useContainedComponent({ component: DataPage, props: vueProps, on })
  // Every control the page draws is marked with the action or key it carries,
  // and every field input with the column its own label names. Kept on the
  // contained box through a MutationObserver rather than one pass per commit,
  // because the page draws on state of its own: a cell after a query and a
  // dialog after a press are drawn afresh and have to be marked again. What is
  // marked reads the block's current properties through a ref, the way every
  // other effect that outlives its commit does: a placing call that changes
  // the operations within one mount redraws the row's controls, and the pass
  // that marks them must name them as the call now declares them.
  const marking = useRef({ props: vueProps })
  useEffect(() => { marking.current = { props: vueProps } })
  useEffect(() => keepMarked(box.current as HTMLDivElement, (root) => {
    const current = marking.current.props
    markDataPage(root, { custom: (current.customOperations ?? []).map(operation => operation.name) })
  }), [])
  return (
    <div ref={box} className={css.box}>
      <div ref={host} className={css.host} />
    </div>
  )
}

/** Why a block is drawing a line instead of its page. */
type DataPageStall = 'preparing' | 'address' | 'table'

/** The line each stall draws, so one cause cannot be reported as another's. */
const STALL_LINE: Readonly<Record<DataPageStall, ComponentKitKey>> = {
  preparing: 'dataPage.preparing',
  address: 'dataPage.unavailable',
  table: 'dataPage.noTable',
}

/**
 * Render one data page block.
 * @param rendererProps - the block's identity, its properties, the action and output sinks, and this row's translate.
 * The page answers no question, so the action state goes unread.
 * @returns the page inside its contained box, or the line saying why it is not drawn yet.
 */
export function DataPageRenderer({ nodeId, props, onAction, onOutput, t }: ComponentRendererProps) {
  const basePath = useBasePathState()
  // Keyed on the block's property record: the placement package hands over the
  // same object until the call behind the block changes, so an unrelated React
  // commit reaches Vue as nothing at all.
  const vueProps = useMemo(() => readDataPage(props), [props])
  const abilities = useAbilities(vueProps?.relatedMeta)
  // Spread last, so the host's verdict is what the page receives whatever the
  // block's record carried.
  const pageProps = useMemo(
    () => (vueProps === undefined ? undefined : { ...vueProps, abilities }),
    [vueProps, abilities],
  )
  const drawable = pageProps !== undefined && basePath === 'ready' ? pageProps : undefined
  // Each cause draws its own line: a block naming no table cannot open whatever
  // the base path says, and telling that person their address is misconfigured
  // would name a cause that is not theirs.
  const stalled: DataPageStall = vueProps === undefined ? 'table' : basePath === 'failed' ? 'address' : 'preparing'
  return (
    <section className={css.section} data-component-block={COMPONENT_ID} data-component-node={nodeId}>
      {drawable === undefined
        ? <p className={css.notice} data-page-stalled={stalled}>{t(STALL_LINE[stalled])}</p>
        : <DataPageBlock props={props} vueProps={drawable} onAction={onAction} onOutput={onOutput} />}
    </section>
  )
}
