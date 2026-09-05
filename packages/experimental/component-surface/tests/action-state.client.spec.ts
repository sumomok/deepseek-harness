/**
 * The per-block gesture fold: what the two command records a press writes make
 * of a block's state, and what they leave alone.
 *
 * The fold is the whole reason a pressed bar still reads as pressed after the
 * column has drawn something else and come back, so what is pinned here is each
 * settlement's outcome, the pairing that keeps one press from settling
 * another's cell, and the replacement that makes a second press on one block
 * one record rather than two.
 */

import { describe, expect, it } from 'vitest'
import { CommandId } from '@deepseek-ai/dsh-commands'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyComponentAction,
  componentActionsView,
  latestComponentAction,
  type ComponentActionCell,
} from '../src/action-state.ts'
import { COMPONENT_ACTION_COMMAND, formatComponentActionLine, type ComponentAction } from '../src/component-call.ts'

/** The gesture this suite folds, and the block it belongs to. */
const PRESS: ComponentAction = {
  entryId: 'budget',
  componentId: 'el.confirm-bar',
  actionId: 'press',
  nodeId: 'ask',
  payload: { buttonId: 'approve' },
}

/** The command line's `args` half, as `command/run` records it: everything after the name. */
function args(action: ComponentAction): string {
  return formatComponentActionLine(action).slice(`/${COMPONENT_ACTION_COMMAND}`.length)
}

/** One `command/run` record. */
function run(seq: number, commandId: string, line: string, name = COMPONENT_ACTION_COMMAND): SessionEvent {
  return {
    type: 'command/run',
    seq: SessionSeq(seq),
    time: 0,
    data: { commandId: CommandId(commandId), name, args: line, source: { kind: 'user' } },
  }
}

/** One `command/done` record. */
function done(seq: number, commandId: string, settlement: { kind: 'success' | 'error'; text?: string }): SessionEvent {
  return {
    type: 'command/done',
    seq: SessionSeq(seq),
    time: 0,
    data: { commandId: CommandId(commandId), ...settlement },
  }
}

/** Fold a whole run of events from the empty table. */
function fold(events: readonly SessionEvent[]): ComponentActionCell[] {
  return events.reduce<ComponentActionCell[]>(applyComponentAction, [])
}

/** What one block's state is after folding a run of events. */
function outcomeOf(events: readonly SessionEvent[], nodeId = PRESS.nodeId): string | undefined {
  return latestComponentAction(componentActionsView(fold(events)), PRESS.entryId, nodeId)?.outcome
}

describe('the per-block gesture fold', () => {
  it('reads a reported gesture as on its way until its settlement is recorded', () => {
    expect(outcomeOf([run(10, 'cmd-1', args(PRESS))])).toBe('sending')
  })

  it('reads a refused settlement as a gesture that reached nobody', () => {
    expect(outcomeOf([
      run(10, 'cmd-1', args(PRESS)),
      done(11, 'cmd-1', { kind: 'error', text: '这个动作没能记下来。' }),
    ])).toBe('refused')
  })

  it('reads a settlement carrying a sentence as a gesture waiting for the user', () => {
    // The handler answers with a sentence exactly when the notice only reached
    // the inbox, so the sentence is the signal — the fold reads no grade.
    expect(outcomeOf([
      run(10, 'cmd-1', args(PRESS)),
      done(11, 'cmd-1', { kind: 'success', text: '已记下，你下次发消息时对话会看到。' }),
    ])).toBe('queued')
  })

  it('reads a silent settlement as a gesture the agent already has', () => {
    expect(outcomeOf([
      run(10, 'cmd-1', args(PRESS)),
      done(11, 'cmd-1', { kind: 'success' }),
    ])).toBe('sent')
  })

  it('keeps one cell per block, holding the latest gesture reported from it', () => {
    const state = fold([
      run(10, 'cmd-1', args(PRESS)),
      done(11, 'cmd-1', { kind: 'error', text: '这个动作没能记下来。' }),
      run(20, 'cmd-2', args(PRESS)),
      done(21, 'cmd-2', { kind: 'success' }),
    ])
    expect(state).toHaveLength(1)
    expect(state[0]).toMatchObject({ entryId: 'budget', nodeId: 'ask', seq: 20, outcome: 'sent' })
  })

  it('settles the cell its own command minted, never a later press\'s', () => {
    // A settlement whose cell has already been replaced names nothing here, so
    // a late `done` cannot repaint the gesture that superseded it.
    const state = fold([
      run(10, 'cmd-1', args(PRESS)),
      run(20, 'cmd-2', args(PRESS)),
      done(21, 'cmd-1', { kind: 'error', text: '这个动作没能记下来。' }),
    ])
    expect(state).toEqual([{ entryId: 'budget', nodeId: 'ask', seq: 20, commandId: 'cmd-2', outcome: 'sending' }])
  })

  it('keeps one cell per block rather than per entry', () => {
    const other = { ...PRESS, nodeId: 'confirm' }
    const events = [run(10, 'cmd-1', args(PRESS)), run(20, 'cmd-2', args(other))]
    expect(outcomeOf(events)).toBe('sending')
    expect(outcomeOf(events, 'confirm')).toBe('sending')
    expect(fold(events)).toHaveLength(2)
  })

  it('records nothing for a command that is not a reported gesture', () => {
    expect(fold([run(10, 'cmd-1', ' sales', 'show-content-page')])).toEqual([])
  })

  it('records nothing for a gesture that is not the block\'s own answer', () => {
    // A table reports four gestures and holds one cell. If a tick claimed it,
    // the block would read as answered by a selection and the row button under
    // it would be refused for the rest of the entry.
    const ticked = { ...PRESS, componentId: 'toy.table', actionId: 'select', nodeId: 'devices', payload: { rowIndexes: [0] } }
    const sorted = { ...ticked, actionId: 'sort', payload: { prop: 'state', order: 'asc' } }
    const typed = { ...PRESS, componentId: 'el.filter-bar', actionId: 'change', nodeId: 'query', payload: { count: 1 } }
    expect(fold([run(10, 'cmd-1', args(ticked)), run(11, 'cmd-2', args(sorted)), run(12, 'cmd-3', args(typed))])).toEqual([])
  })

  it('records the gesture a block was placed to receive', () => {
    const pressed = { ...PRESS, componentId: 'toy.table', actionId: 'operation', nodeId: 'devices', payload: { opId: 'export', rowIndex: 0 } }
    const submitted = { ...PRESS, componentId: 'el.filter-bar', actionId: 'submit', nodeId: 'query', payload: { conditions: [] } }
    expect(fold([run(10, 'cmd-1', args(pressed))]).map(cell => cell.nodeId)).toEqual(['devices'])
    expect(fold([run(10, 'cmd-1', args(submitted))]).map(cell => cell.nodeId)).toEqual(['query'])
  })

  it('records nothing for a document naming a component or an action the catalog does not declare', () => {
    const unknownComponent = { ...PRESS, componentId: 'toy.chart' }
    const unknownAction = { ...PRESS, actionId: 'double-press' }
    expect(fold([run(10, 'cmd-1', args(unknownComponent))])).toEqual([])
    expect(fold([run(10, 'cmd-1', args(unknownAction))])).toEqual([])
  })

  it('records nothing for a line naming no action document', () => {
    // The path a hand-typed line takes: it is refused by the handler and leaves
    // no cell, so it cannot repaint a block the user really did press.
    expect(fold([run(10, 'cmd-1', ' {"entryId":"budget"}')])).toEqual([])
    expect(fold([run(10, 'cmd-1', '')])).toEqual([])
  })

  it('records nothing for a run carrying no input at all', () => {
    const bare = {
      type: 'command/run',
      seq: 10,
      time: 0,
      data: { commandId: CommandId('cmd-1'), name: COMPONENT_ACTION_COMMAND, source: { kind: 'user' } },
    } as SessionEvent
    expect(fold([bare])).toEqual([])
  })

  it('settles nothing for a command this fold never minted a cell for', () => {
    const state = fold([done(11, 'cmd-9', { kind: 'success' })])
    expect(state).toEqual([])
  })

  it('leaves every other event alone, by reference', () => {
    const before = fold([run(10, 'cmd-1', args(PRESS))])
    const after = applyComponentAction(before, { type: 'turn/start', seq: SessionSeq(12), time: 0, data: { turn: 1 } })
    expect(after).toBe(before)
  })

  it('publishes the cells without the pairing id, which is the fold\'s business alone', () => {
    const view = componentActionsView(fold([run(10, 'cmd-1', args(PRESS)), done(11, 'cmd-1', { kind: 'success' })]))
    expect(view).toEqual({ actions: [{ entryId: 'budget', nodeId: 'ask', seq: 10, outcome: 'sent' }] })
  })

  it('finds nothing for a block that has reported nothing, and nothing at all with no fold published', () => {
    const view = componentActionsView(fold([run(10, 'cmd-1', args(PRESS))]))
    expect(latestComponentAction(view, 'budget', 'other')).toBeUndefined()
    expect(latestComponentAction(view, 'cleanup', 'ask')).toBeUndefined()
    expect(latestComponentAction(undefined, 'budget', 'ask')).toBeUndefined()
  })
})
