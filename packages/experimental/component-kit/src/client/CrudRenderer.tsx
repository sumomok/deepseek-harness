/**
 * `toy.crud` — the deployment's own full data page for one table, drawn as it
 * was written and reporting only what the agent needs to talk about it.
 *
 * The component is `Crud.vue`, compiled outside this repository together with
 * the request layer it runs on and vendored as `@sumomok/toy-crud-kit`. Unlike
 * every other block in this row it fetches: its scheme, its table's
 * dictionary, and each query's rows go browser → deployment with the visitor's
 * own token, and nothing on the host reads any of it. `README.md` records what
 * that costs and where the page may navigate.
 *
 * What a call chooses and what it may not. Eight properties are the model's
 * — which table, under which name on the card, narrowed by which hidden
 * conditions, joined how, sorted how, whether rows are ticked, whether the
 * query panel opens expanded, whether the first query runs on its own — and
 * seven of them reach the page, because the name on the card is the placement
 * package's and stops there. The kit's `CRUD_READ_ONLY_PROPS` are spread after
 * them and no call carries them: every write, import and export key hidden,
 * the menu and the card subtree off, `isReadOnly` on, `type` fixed,
 * `urlConfig` null. The kit's own build also compiles the write dialogs to
 * empty stubs, so a dialog cannot be opened by any property at all. What the
 * page still writes is one audit record per answered query, on the deployment's
 * own front-event endpoint and under the visitor's identity; `README.md`
 * carries what it holds.
 *
 * Three things come back, each a `context` gesture of the placement package's
 * catalog and each bounded the way that catalog bounds it — `crud-read.ts`
 * holds the readings and the ceilings: on `load`, the table and the first
 * drawn columns of the page's query scheme; on `query-success`, three counts
 * and never a row; on `table-cell-click`, the clicked column and the clicked
 * row's drawn cells. A load or a query identical to the one this block last
 * reported for the same placing call is not reported again, which is what
 * keeps a tab switch — the column drops and redraws a block, and the page
 * loads and queries afresh — from telling the agent the same thing twice. The
 * page has no selection event of its own, and nothing here polls its instance
 * for one.
 *
 * Before the page is drawn two things happen in order, and the order is the
 * whole point. The base path its requests go under is applied by
 * `crud-settings.ts` once the row's browser half has read it from the node
 * half, and this renderer mounts nothing until that read has settled — so no
 * request leaves under the kit's built-in default. Then `containCrud` marks
 * the box the page is mounted in, so the request layer's progress bar and
 * overlay, and the toasts the page raises, land inside that box rather than on
 * the document body; it runs from an effect declared before the bridge's
 * mount effect, which is what puts it before the page's first request. The
 * release is a second effect declared after the bridge's, because React runs
 * cleanups in declaration order and the page raises its last toasts while Vue
 * destroys it — the box has to outlive the page it contained.
 *
 * The vendored page is imported statically, so it is part of this row's single
 * browser bundle and every console downloads it, including deployments that
 * leave `crud: false`. `README.md` records why deferring it is not available
 * here: a plugin's client bundle is one closure-factory file the loader fetches
 * by name, so there is no second chunk for a dynamic import to land in.
 *
 * element-ui must already be installed on the shared runtime — the row's
 * client plugin does that when it starts, and a test drawing this block on its
 * own calls `installElementUI()` first.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  containCrud,
  Crud,
  type CrudLoadPayload,
  type CrudQuerySuccessPayload,
  type CrudTableCellClickPayload,
} from '@sumomok/toy-crud-kit'
import { loadReport, readCellClick, readCrud, readLoadedColumns, readQuery, type CrudVueProps, type ReportedColumn } from './crud-read.ts'
import { crudBasePathReady } from './crud-settings.ts'
import { useVueComponent, type VueEventHandlers } from './vue2-bridge.tsx'
import css from './CrudRenderer.module.css'
import type { ComponentKitKey } from './locales.ts'
import type { ComponentActionHandler, ComponentRendererProps } from './renderer.ts'

/** The catalog id a block names to get this component. */
const COMPONENT_ID = 'toy.crud'

/** Action id the loaded columns are reported under. */
const LOAD_ACTION_ID = 'load'

/** Action id one answered query's counts are reported under. */
const QUERY_ACTION_ID = 'query'

/** Action id a clicked cell is reported under. */
const CELL_CLICK_ACTION_ID = 'cell-click'

/**
 * What one placing call's block has already told the agent, so a redraw of the
 * same call does not tell it again.
 *
 * Keyed by the block's property record, which the placement package hands over
 * unchanged for the life of one call and replaces for the next — so a later
 * call under the same ids starts with nothing reported, and a block the column
 * dropped and drew again finds what it said before.
 */
interface ReportMemory {
  /** The columns the page last reported, which a clicked row's cells are read through. */
  columns: readonly ReportedColumn[]
  /** The last load report, serialized. */
  load?: string
  /** The last query report, serialized. */
  query?: string
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
  const opened: ReportMemory = { columns: [] }
  MEMORIES.set(props, opened)
  return opened
}

/** What the listener map reads at the moment an event arrives. */
interface CrudEventContext {
  /** Where a gesture goes. */
  readonly onAction: ComponentActionHandler
  /** The table the block was opened on, which every load names. */
  readonly meta: string
  /** What this placing call's block has already reported. */
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
  context: CrudEventContext,
  field: 'load' | 'query',
  actionId: string,
  payload: Readonly<Record<string, unknown>>,
): void {
  const signature = JSON.stringify(payload)
  if (context.memory[field] === signature) return
  context.memory[field] = signature
  context.onAction(actionId, payload)
}

/** What one drawn page needs beyond the block's own identity. */
interface CrudPageProps extends Pick<ComponentRendererProps, 'props' | 'onAction'> {
  /** The block's properties, as `Crud` takes them. */
  readonly vueProps: CrudVueProps
}

/** The page itself, drawn once the base path its requests go under is in force. */
function CrudPage({ props, vueProps, onAction }: CrudPageProps) {
  const memory = memoryOf(props)
  const context = useRef<CrudEventContext>({ onAction, meta: vueProps.relatedMeta, memory })
  useEffect(() => {
    context.current = { onAction, meta: vueProps.relatedMeta, memory }
  })
  const box = useRef<HTMLDivElement>(null)
  const release = useRef<() => void>()
  // Declared before the bridge's mount effect, so the box is contained before
  // the page is mounted and makes its first request.
  useEffect(() => { release.current = containCrud(box.current as HTMLDivElement) }, [])
  const on = useMemo<VueEventHandlers>(() => ({
    load: (payload: CrudLoadPayload) => {
      const current = context.current
      const columns = readLoadedColumns(payload)
      current.memory.columns = columns
      reportOnce(current, 'load', LOAD_ACTION_ID, loadReport(current.meta, columns))
    },
    'query-success': (payload: CrudQuerySuccessPayload) => {
      const report = readQuery(payload)
      if (report !== undefined) reportOnce(context.current, 'query', QUERY_ACTION_ID, report)
    },
    'table-cell-click': (payload: CrudTableCellClickPayload) => {
      const report = readCellClick(payload, context.current.memory.columns)
      if (report !== undefined) context.current.onAction(CELL_CLICK_ACTION_ID, report)
    },
  }), [])
  const host = useVueComponent<HTMLDivElement>({ component: Crud, props: vueProps, on })
  // Declared after the bridge's mount effect, so this cleanup runs after the
  // bridge's: React releases effects in the order they were declared, and the
  // page raises its last toasts while Vue is tearing it down. Released in the
  // effect that contained the box, the box would stop being a box first and
  // those toasts would land on the document body with nothing to adopt them.
  // The release is set by the effect declared before this one, which is why it
  // is there by the time this cleanup runs.
  useEffect(() => () => { (release.current as () => void)() }, [])
  return (
    <div ref={box} className={css.box}>
      <div ref={host} className={css.host} />
    </div>
  )
}

/** Whether the base path the page's requests go under has been applied. */
type BasePathState = 'waiting' | 'ready' | 'failed'

/** Why a block is drawing a line instead of its page. */
type CrudStall = 'preparing' | 'address' | 'table'

/** The line each stall draws, so one cause cannot be reported as another's. */
const STALL_LINE: Readonly<Record<CrudStall, ComponentKitKey>> = {
  preparing: 'crud.preparing',
  address: 'crud.unavailable',
  table: 'crud.noTable',
}

/**
 * Render one data page block.
 * @param rendererProps - the block's identity, its properties, the action sink, and this row's translate. The page
 * publishes nothing and answers no question, so the output sink and the action state go unread.
 * @returns the page inside its contained box, or the line saying why it is not drawn yet.
 */
export function CrudRenderer({ nodeId, props, onAction, t }: ComponentRendererProps) {
  const [basePath, setBasePath] = useState<BasePathState>('waiting')
  // Keyed on the block's property record: the placement package hands over the
  // same object until the call behind the block changes, so an unrelated React
  // commit reaches Vue as nothing at all.
  const vueProps = useMemo(() => readCrud(props), [props])
  useEffect(() => {
    let mounted = true
    crudBasePathReady().then(
      () => { if (mounted) setBasePath('ready') },
      () => { if (mounted) setBasePath('failed') },
    )
    return () => { mounted = false }
  }, [])
  const drawable = vueProps !== undefined && basePath === 'ready' ? vueProps : undefined
  // Each cause draws its own line: a block naming no table cannot open whatever
  // the base path says, and telling that person their address is misconfigured
  // would name a cause that is not theirs.
  const stalled: CrudStall = vueProps === undefined ? 'table' : basePath === 'failed' ? 'address' : 'preparing'
  return (
    <section data-component-block={COMPONENT_ID} data-component-node={nodeId}>
      {drawable === undefined
        ? <p className={css.notice} data-crud-stalled={stalled}>{t(STALL_LINE[stalled])}</p>
        : <CrudPage props={props} vueProps={drawable} onAction={onAction} />}
    </section>
  )
}
