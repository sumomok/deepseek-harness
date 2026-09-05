/**
 * The `component` seat of the content column: the blocks the selected call
 * placed, stacked in the order it wrote them.
 *
 * The seat re-reads the payload before drawing it. That is not distrust of the
 * host it shares a repository with: an entry's payload can come from a persisted
 * checkpoint written by another composition, whose catalog and ceilings were not
 * this build's, so the type it arrives with is a claim rather than a guarantee.
 * The check is the same module the tool judged the call with, which is why that
 * module imports nothing.
 *
 * A gesture inside a block does come back: the seat binds which block spoke and
 * hands the report to `action.ts`, which puts it in the session log as one
 * `/component-action` line. Deciding what the agent does with it is the node
 * half's, not this seat's.
 *
 * A block also publishes its own current reading of itself — the rows a table
 * has ticked, the conditions a filter holds — and that goes nowhere near the
 * log. The seat keeps the published values in React state for as long as the
 * call that placed the blocks is on display, and `spec.ts` stands them in for
 * the `$from` references the model wrote in the properties of the blocks beside
 * them. A block whose required property is still waiting on one draws the
 * component row's waiting line in place of the component. Nothing published
 * this way is ever sent anywhere: it is a value one block lends another for as
 * long as both are drawn, which is what lets a record follow a table's
 * selection without every tick becoming model-visible input.
 *
 * Where a block goes is the spec's `layout` — nested rows and columns over the
 * same nodes — and a call that declares none gets the plain column the seat has
 * always drawn.
 *
 * What became of that gesture comes back the same way it went out — through the
 * log. The seat reads the `componentActions` fold off the session's projection
 * values, the way the column itself reads its entry stream, and gives each block
 * the state of the gesture recorded against it. A gesture only counts for the
 * call now on display: the fold's `seq` is the press's own log position and the
 * entry's is its placing call's, so a later call under the same id leaves every
 * earlier press behind it and the blocks it draws start unanswered.
 *
 * Only the gesture a block was placed to receive has a state at all. A
 * selection, a sort, an unsubmitted edit are reported and leave the block as
 * they found it — the fold writes them no cell, and the seat files them no row
 * in the page's waiting table, because there is no settlement coming for them.
 *
 * While another kind holds the column, the column hands the seat no entry and the
 * seat draws nothing; what `visibility` keeps mounted is the column's own wrapper
 * for the kind, not the blocks. Their DOM goes with the draw, so nothing a user
 * typed into a block survives a switch to another kind or to another entry — but
 * a press does, because the press is in the log rather than in the block.
 *
 * The one moment the log cannot cover is the press's own trip to the host, and
 * that is held above the seat rather than inside it: `client/index.ts` owns one
 * table for the page's life (`PendingPresses`), the block writes its row when
 * the press leaves and removes it when the record arrives, and a block that is
 * unmounted and drawn again in between reads its own row back and comes up
 * still waiting. A dispatch that reaches no log at all removes the row itself
 * and leaves the block answerable again, because it has no settlement left to
 * wait for; that answer is the block's own, and the log's replaces it if a
 * record for the press arrives after all. The block's React identity is that
 * same table key — session, entry, placing call, node — so no local waiting is
 * ever carried into another session's stack, and replacing an entry's call
 * remounts every block it draws.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the useSessions seat's own merge, and the branded id its rows are keyed by.
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  COMPONENT_RENDERERS,
  type ComponentActionHandler,
  type ComponentActionState,
  type ComponentKitTranslate,
  type ComponentOutputHandler,
  type ComponentRenderer,
} from '@deepseek-ai/dsh-experimental-component-kit/client'
import {
  answersBlock,
  type CatalogId,
  type ComponentAction,
  type ComponentNode,
} from '../component-call.ts'
import {
  latestComponentAction,
  type ComponentActionRecord,
  type ComponentActionsView,
} from '../action-state.ts'
import { pendingPressKey, type ActionDispatch, type PendingPresses } from './action.ts'
import { NO_OUTPUTS, outputKey, type OutputSink, type OutputValues } from './bindings.ts'
import { acceptSurface, type SurfaceBlock } from './spec.ts'
import { StackLayout } from './StackLayout.tsx'
import css from './ComponentSurface.module.css'

/**
 * Every component this seat can draw.
 *
 * `CatalogId` is derived from `COMPONENT_CATALOG` itself, so this line is where
 * the two tables are tied together: a catalog entry this deployment has no
 * renderer for leaves the union carrying a key the renderer table lacks, and
 * fails to compile here instead of becoming a blank block a user has to report.
 * A renderer no catalog entry names is unreachable rather than wrong, and passes.
 */
const RENDERERS = COMPONENT_RENDERERS satisfies Record<CatalogId, ComponentRenderer>

/** The same table, keyed for lookup by the id a validated node names. */
const RENDERER_BY_ID: ReadonlyMap<string, ComponentRenderer> = new Map(Object.entries(RENDERERS))

/** Where one block's gestures go, with the session they happened in already bound. */
type SeatReport = (action: ComponentAction) => Promise<ActionDispatch>

/**
 * Where a gesture goes while no session is current.
 *
 * The column publishes entries per session, so a seat without one has no entry
 * to draw and no block to press; what this keeps out is a report naming a
 * session that is not there. It answers `failed` because that is what happened:
 * nothing was recorded, and the block must not sit waiting for a record.
 */
const REPORT_NOTHING: SeatReport = () => Promise.resolve('failed')

/**
 * The log position a block waits past when nothing it reported is recorded yet.
 * Every event seq is non-negative, so a first press waits for any record at all.
 */
const NOTHING_RECORDED = -1

/** This registration's own injected face, wired in `client/index.ts`. */
export interface ComponentSurfaceInjected {
  /**
   * Report one gesture made inside a block: executes `/component-action`
   * against `sessionId`, which records what the user did in the session log.
   * What became of the gesture arrives with the next fold of that log, not as
   * this call's return; what the return says is only whether there is going to
   * be a record to fold.
   */
  onAction: (sessionId: string, action: ComponentAction) => Promise<ActionDispatch>
  /**
   * The page's in-flight presses, one row per block waiting for its record.
   * Held by the registration rather than by this component, so it outlives
   * every unmount the column performs.
   */
  pending: PendingPresses
}

/** Composed props: the kind-seat runtime share, this registration's injected face, and the component row's locale seat. */
export type ComponentSurfaceProps =
  & PropsRuntime<'content.surface.kind', 'component'>
  & ComponentSurfaceInjected
  & PropsLocale<'componentKit'>

/**
 * What the entry's blocks have published, and which placing call published it.
 *
 * The call is part of the state rather than a reset performed beside it: a
 * later call under the same entry id draws blocks that have published nothing,
 * and a table's rows carried into the record block of a call that never asked
 * for them is worse than an empty one. Reading the owner is what discards the
 * previous call's values without an effect that runs after the wrong render.
 */
interface OutputState {
  /** The entry and placing call whose blocks published these values. */
  readonly owner: string
  /** What they published. */
  readonly values: OutputValues
}

/** Nothing published, by nobody. */
const NO_OUTPUT_STATE: OutputState = { owner: '', values: NO_OUTPUTS }

/** The blocks the previous reading of one payload produced, so an unchanged block keeps its object. */
interface HeldBlocks {
  /** The payload that reading was of. */
  readonly payload: unknown
  /** What it produced. */
  readonly blocks: readonly SurfaceBlock[]
}

/** Nothing read yet. */
const NOTHING_HELD: HeldBlocks = { payload: undefined, blocks: [] }

/** One block's own render inputs. */
interface ComponentBlockProps {
  /** The entry the block belongs to. */
  readonly entryId: string
  /** Log sequence of the call that currently owns the entry. */
  readonly seq: number
  /** The block. */
  readonly node: ComponentNode
  /** Where the block's gestures go. */
  readonly report: SeatReport
  /** The page's in-flight presses. */
  readonly pending: PendingPresses
  /** This block's row in that table, built by the seat so the table's key shape has one author. */
  readonly pendingKey: string
  /** The gesture the log records against this block for the call on display; absent while it has answered none. */
  readonly recorded: ComponentActionRecord | undefined
  /** Where this block's own current reading of itself goes, for the blocks beside it. */
  readonly publish: OutputSink
  /** The component row's translate, for the copy a renderer owns. */
  readonly t: ComponentKitTranslate
}

/**
 * Render one block.
 *
 * The reported state is the log's, with one gap the log cannot cover: the moment
 * between the click and the record of it arriving. The block's row in the page's
 * table holds the log position it is waiting past — the recorded gesture's own,
 * or nothing at all for a first press — and it reads `sending` until a later
 * gesture is recorded. That waiting is a question about the log rather than an
 * answer of its own: a refused gesture pressed again reads `sending` because the
 * log still holds only the older press, and settles as soon as the newer one is
 * there.
 *
 * The row is read back at mount and the local mirror of it seeded from what is
 * found, which is what makes the waiting survive the unmount a tab round trip
 * performs. Two things remove the row, and nothing else does: the record
 * arriving, and a dispatch that says no record is coming. The second is the
 * block's only state of its own — a press that reached no log has no settlement
 * to read, so the block says the gesture was not recorded and takes another.
 * Both are held the same way, as the log position the claim is anchored to, and
 * both end where the log passes it: a `command/run` the host wrote before the
 * transport failed is a settlement the block reads like any other, rather than
 * a record the local answer keeps hidden for the rest of the mount.
 *
 * The memo is per block rather than per entry so that the identity of what one
 * renderer receives is a fact about that block alone: a block is rebuilt when
 * its own entry is replaced or its own gesture moves, and a redraw somewhere
 * else in the stack leaves it holding exactly the props it already had.
 * @param props - the block, its entry's identity, its row in the page's table, its recorded gesture, the output sink, and the translate.
 * @returns the component the block names, or the notice for one this build cannot draw.
 */
function ComponentBlock({ entryId, seq, node, report, pending, pendingKey, recorded, publish, t }: ComponentBlockProps) {
  // Seeded from the page's table, so a block drawn afresh while its press is
  // still travelling comes up waiting rather than answerable. The key is fixed
  // for this mount — the seat gives each block the React identity of its own
  // row — so the seed is read once, at the mount it belongs to.
  const [awaiting, setAwaiting] = useState<number | undefined>(() => pending.get(pendingKey))
  // The press this page could not send, held as the log position it was
  // anchored to rather than as a flag: the dispatch reports what the browser
  // saw, and a `command/run` written before the transport failed still settles
  // the block.
  const [lost, setLost] = useState<number | undefined>(undefined)
  const recordedPast = (from: number) => recorded !== undefined && recorded.seq > from
  const inFlight = awaiting !== undefined && !recordedPast(awaiting)
  const state: ComponentActionState = inFlight
    ? 'sending'
    : lost !== undefined && !recordedPast(lost) ? 'refused' : recorded?.outcome ?? 'idle'
  useEffect(() => {
    // The record the press was waiting for is here: the row has nothing left to
    // say, and leaving it would make the next mount of this block wait for a
    // gesture that has already settled.
    if (awaiting !== undefined && !inFlight) {
      pending.delete(pendingKey)
      setAwaiting(undefined)
    }
  }, [awaiting, inFlight, pending, pendingKey])
  return useMemo(() => {
    const Renderer = RENDERER_BY_ID.get(node.component)
    if (Renderer === undefined) {
      return (
        <p className={css.notice} data-component-surface-unsupported={node.component}>
          {t('block.unsupported')}
        </p>
      )
    }
    // Which block spoke is bound here rather than reported by the renderer: the
    // seat holds the node and the entry it belongs to, so a renderer says only
    // what the user did.
    const onAction: ComponentActionHandler = (actionId, payload) => {
      const action = { entryId, componentId: node.component, actionId, nodeId: node.id, payload }
      // A gesture that is not the block's own answer leaves no cell in the fold,
      // so there is no settlement for it to wait on: filing a row for it would
      // pin the block at `sending` for the rest of the session.
      if (!answersBlock(node.component, actionId)) {
        void report(action)
        return
      }
      const from = recorded?.seq ?? NOTHING_RECORDED
      pending.set(pendingKey, from)
      setAwaiting(from)
      setLost(undefined)
      void report(action)
        .then((dispatch) => {
          if (dispatch === 'dispatched') return
          // The browser saw no command run, so nothing it knows of is coming to
          // settle this block: waiting on it would pin the block at `sending`
          // for the rest of the session. As far as the page can tell the
          // gesture was not recorded, which is what `refused` says and why
          // pressing again is allowed — and a record that turns up all the same
          // outranks it, because the log is the answer and this is a guess.
          pending.delete(pendingKey)
          setAwaiting(undefined)
          setLost(from)
        })
    }
    // Bound here for the same reason the action handler is: the seat holds the
    // block's identity, so a renderer says only what it is publishing.
    const onOutput: ComponentOutputHandler = (outputId, value) => { publish(node.id, outputId, value) }
    return <Renderer nodeId={node.id} props={node.props} onAction={onAction} onOutput={onOutput} state={state} t={t} />
  }, [entryId, seq, node, report, pending, pendingKey, recorded, state, publish, t])
}

/**
 * Render the component seat.
 * @param props - the column's selection, the session feed, the action sink, and the locale seat.
 * @returns the caption and the blocks, or nothing while another kind is selected.
 */
export function ComponentSurface({ sessionId, entry, useSessions, onAction, pending, t }: ComponentSurfaceProps) {
  const payload = entry?.payload
  // The entry and the call that placed it, which is what the published values
  // belong to: a later call under the same id starts with nothing published.
  const owner = entry === undefined ? '' : `${entry.entryId} ${entry.seq}`
  const [outputs, setOutputs] = useState<OutputState>(NO_OUTPUT_STATE)
  const values = outputs.owner === owner ? outputs.values : NO_OUTPUTS
  const publish = useCallback<OutputSink>((nodeId, outputId, value) => {
    setOutputs(prev => ({
      owner,
      values: new Map(prev.owner === owner ? prev.values : NO_OUTPUTS).set(outputKey(nodeId, outputId), value),
    }))
  }, [owner])
  // The previous reading of this same payload, so re-reading it because one
  // block published something hands every other block the object it already
  // had. Written where the reading happens rather than in an effect, because a
  // block's identity is decided by the render that draws it.
  const held = useRef<HeldBlocks>(NOTHING_HELD)
  // Memoized on the payload and on what the blocks have published: the
  // validated node list is what every block's props identity hangs from, and a
  // fresh list every render would rebuild the stack.
  const view = useMemo(() => {
    const read = payload === undefined
      ? undefined
      : acceptSurface(payload, values, held.current.payload === payload ? held.current.blocks : [])
    held.current = { payload, blocks: read?.blocks ?? [] }
    return read
  }, [payload, values])
  // The gestures this session's log records, read where the column reads its own
  // entries. Per session by construction: another session's presses sit under
  // another session's row and are never in reach here.
  const actions: ComponentActionsView | undefined = useSessions(state => (
    // The column publishes the framework's own current session id; the brand is
    // erased crossing the kind slot's plain-data owner share (`action.ts`
    // restores it the same way for the command it dispatches).
    sessionId === undefined ? undefined : state.byId[sessionId as SessionId]?.projectionValues?.componentActions))
  // One sink per session, memoized for the same reason the nodes are: it is a
  // dependency of every block's props identity.
  const report = useMemo<SeatReport>(
    () => (sessionId === undefined ? REPORT_NOTHING : action => onAction(sessionId, action)),
    [sessionId, onAction],
  )

  if (entry === undefined) return null
  if (view === undefined) {
    return (
      <div className={css.seat} data-component-surface>
        <p className={css.notice} data-component-surface-error>{t('block.unreadable')}</p>
      </div>
    )
  }
  /**
   * Draw one block of this entry where the arrangement puts it.
   * @param block - the block.
   * @returns the component, or the line saying it is waiting on the block that feeds it.
   */
  const drawBlock = (block: SurfaceBlock) => {
    if (block.node === undefined) {
      return (
        <p className={css.notice} data-component-surface-awaiting={block.id}>{t('block.awaiting')}</p>
      )
    }
    // A gesture recorded before the call that placed this block answered an
    // earlier call under the same entry id: the agent asking again is asking
    // afresh, and the block it drew starts unanswered.
    const latest = latestComponentAction(actions, entry.entryId, block.id)
    // One key for both identities: what React reuses a block for and what the
    // page files that block's in-flight press under are the same four parts, so
    // no block is ever handed the local waiting of a different session, entry,
    // placing call, or node. The column keeps this seat mounted through a
    // session switch — it hides seats rather than dropping them — which is what
    // makes the session part load-bearing; the sequence part is what remounts a
    // block when a later call replaces the entry, rather than handing the new
    // spec to the components the old one left mounted.
    const key = pendingPressKey(sessionId, entry.entryId, entry.seq, block.id)
    return (
      <ComponentBlock
        key={key}
        entryId={entry.entryId}
        seq={entry.seq}
        node={block.node}
        report={report}
        pending={pending}
        pendingKey={key}
        recorded={latest !== undefined && latest.seq > entry.seq ? latest : undefined}
        publish={publish}
        t={t}
      />
    )
  }
  return (
    <div className={css.seat} data-component-surface>
      <p className={css.caption}>{entry.title}</p>
      <div className={css.stack} data-component-surface-stack>
        <StackLayout layout={view.layout} renderBlock={drawBlock} />
      </div>
    </div>
  )
}
