/**
 * What the log says about the last gesture each drawn block reported.
 *
 * A pressed bar has to keep looking pressed after the seat that drew it is
 * unmounted — the column discards a kind's DOM when the user picks another
 * entry — so the pressed state cannot be the block's own memory. It is folded
 * from the two records the command registry already writes: `command/run`
 * carries the action document verbatim, and the `command/done` paired with it
 * by `commandId` carries what the handler answered. One cell per
 * `(entryId, nodeId)` survives, holding the latest gesture that block reported,
 * which is what makes a second press replace the first rather than accumulate
 * beside it.
 *
 * The fold is the host's because the log is: the browser reads the folded value
 * off the session's projection values, exactly as the content column reads its
 * entry stream, and decides nothing about it beyond whether the gesture belongs
 * to the call currently on display (`seq` against the entry's own).
 *
 * Client-safe by construction: this module imports types and
 * `component-call.ts`, which imports nothing, so the seat reads the same fold
 * vocabulary without pulling a host runtime into the page. The zod schemas and
 * the unit that registers this fold live in `action-projection.ts`.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/action-state
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
// Type-only: pulls the command registry's `command/run` / `command/done` SessionEventMap merge.
import type {} from '@deepseek-ai/dsh-commands/types'
import { COMPONENT_ACTION_COMMAND, parseComponentActionLine } from './component-call.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    componentActions: ComponentActionCell[]
  }
  interface SessionProjectionMap {
    /**
     * The last gesture each drawn block reported, as the command records say
     * it went. The host folds it because the records are the host's; the
     * browser resolves nothing and only decides which gestures belong to the
     * call it is drawing.
     */
    componentActions: ComponentActionsView
  }
}

/**
 * How far one reported gesture got.
 *
 * The four answers a user can be told apart: `sending` while the command's
 * settlement is not in the log yet, `sent` for a gesture the agent was handed
 * in a turn of its own, `queued` for one waiting in the inbox until the user
 * writes again, and `refused` for one that reached nobody. The browser adds
 * `idle` for a block nobody has pressed — the component row's
 * `ComponentActionState` is this union plus that one member, and the seat's
 * assignment is where the compiler holds the two together.
 */
export type ActionOutcome = 'sending' | 'sent' | 'queued' | 'refused'

/** One block's latest gesture as the fold stores it. */
export interface ComponentActionCell {
  /** The content entry the block belongs to. */
  readonly entryId: string
  /** The block within that entry's spec. */
  readonly nodeId: string
  /** Log sequence of the `command/run` that recorded the gesture. */
  readonly seq: number
  /** Pairing id of that command, which is how its settlement finds this cell. */
  readonly commandId: string
  /** How far the gesture got. */
  readonly outcome: ActionOutcome
}

/** One block's latest gesture as the browser receives it. */
export interface ComponentActionRecord {
  /** The content entry the block belongs to. */
  readonly entryId: string
  /** The block within that entry's spec. */
  readonly nodeId: string
  /**
   * Log sequence of the `command/run` that recorded the gesture; compared
   * against the entry's own to tell a stale gesture from a live one.
   */
  readonly seq: number
  /** How far the gesture got. */
  readonly outcome: ActionOutcome
}

/** Whole current value of the `componentActions` projection. */
export interface ComponentActionsView {
  /** One record per block that has ever reported a gesture, in first-appearance order. */
  readonly actions: readonly ComponentActionRecord[]
}

/**
 * Read how far a settled command got, from the settlement alone.
 *
 * The handler's three answers, and the three the user is shown: a refusal is a
 * gesture that reached nobody, a success carrying a sentence is a gesture the
 * agent will only read when the user writes again, and a silent success is one
 * the agent has already been handed.
 *
 * A `silent` action would settle as that same textless success and be read here
 * as `sent`, which is the one wrong thing this table can say: nobody was told,
 * and the block would claim the conversation has it. No catalog action declares
 * `silent` today, and the first one that does decides what its block says at the
 * same time — either its own outcome here, or a settlement the handler makes
 * distinguishable.
 * @param settlement - the `command/done` payload.
 * @returns the outcome the block should show.
 */
function settledOutcome(settlement: { kind: 'success' | 'error'; text?: string }): ActionOutcome {
  if (settlement.kind === 'error') return 'refused'
  return settlement.text === undefined ? 'sent' : 'queued'
}

/**
 * Fold one committed event into the per-block gesture table.
 * @param state - the table covering all prior events.
 * @param event - the next committed session event.
 * @returns the next table, or `state` itself when the event is not this fold's.
 */
export function applyComponentAction(state: ComponentActionCell[], event: SessionEvent): ComponentActionCell[] {
  if (event.type === 'command/run') {
    if (event.data.name !== COMPONENT_ACTION_COMMAND) return state
    // The same reading the handler does, over the same verbatim input, and only
    // that reading: a line that is not an action document leaves no cell. A
    // well-formed one opens a cell whoever wrote it, so a line typed by hand
    // into the slash menu naming a block that was already pressed repaints that
    // block with its own refusal — the fold reads identifiers, and only the
    // handler resolves them against the entry on display.
    const action = parseComponentActionLine((event.data.args ?? '').trim())
    if (action === undefined) return state
    const cell: ComponentActionCell = {
      entryId: action.entryId,
      nodeId: action.nodeId,
      seq: event.seq,
      commandId: event.data.commandId,
      outcome: 'sending',
    }
    const at = state.findIndex(one => one.entryId === cell.entryId && one.nodeId === cell.nodeId)
    return at === -1 ? [...state, cell] : state.map((one, index) => (index === at ? cell : one))
  }
  if (event.type === 'command/done') {
    // By pairing id, not by block: a settlement whose cell has already been
    // replaced by a later press names no cell here and changes nothing.
    const at = state.findIndex(one => one.commandId === event.data.commandId)
    if (at === -1) return state
    const outcome = settledOutcome(event.data)
    return state.map((one, index) => (index === at ? { ...one, outcome } : one))
  }
  return state
}

/**
 * Resolve the whole current value from the folded cells.
 * @param state - the folded cells, one per block that has reported a gesture.
 * @returns the records the browser reads.
 */
export function componentActionsView(state: readonly ComponentActionCell[]): ComponentActionsView {
  return {
    actions: state.map(({ entryId, nodeId, seq, outcome }) => ({ entryId, nodeId, seq, outcome })),
  }
}

/**
 * Find what one block last reported.
 * @param view - the session's folded gestures, or `undefined` where no fold is published.
 * @param entryId - the content entry the block belongs to.
 * @param nodeId - the block within that entry's spec.
 * @returns the block's latest gesture, or `undefined` when it has reported none.
 */
export function latestComponentAction(
  view: ComponentActionsView | undefined,
  entryId: string,
  nodeId: string,
): ComponentActionRecord | undefined {
  return view?.actions.find(action => action.entryId === entryId && action.nodeId === nodeId)
}
