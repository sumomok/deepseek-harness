/**
 * The `componentAccess` fold: which log events open an `act_component` call,
 * which close it, and what the browser is handed for each.
 *
 * The events come from a real `Session` rather than hand-built envelopes, so
 * the fold is exercised against the log shapes the harness actually writes —
 * the top-level call and the Code Mode dispatch pair.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createToolResultMessage } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ACT_COMPONENT_TOOL_NAME, type ActComponentArgs, type ComponentCall } from '../src/act-component-call.ts'
import { READ_COMPONENT_TOOL_NAME, type ReadComponentArgs } from '../src/read-component-call.ts'
import { actComponentProjection } from '../src/act-component-projection.ts'

/** Build the unit under test over the shipped report deadline. */
function projection(): ReturnType<typeof actComponentProjection> {
  return actComponentProjection(15_000)
}

let sessions = 0

/** A fresh empty session to append log events into. */
function session(): Session {
  return Session.create(SessionId(`component-access-${++sessions}`))
}

/** Record one top-level model call, with `arguments` exactly as a model produces them. */
function call(target: Session, callId: string, args: unknown, name = ACT_COMPONENT_TOOL_NAME): void {
  target.append('tool/call', {
    turn: 1,
    step: 1,
    callId: callId as ToolCallId,
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  })
}

/** Record one PTC mode dispatch, whose arguments are already decoded. */
function dispatch(target: Session, subCallId: string, args: unknown, name = ACT_COMPONENT_TOOL_NAME): void {
  target.append('tool/ptc-dispatch-start', {
    rootCallId: 'call_root' as ToolCallId,
    parentCallId: 'call_root' as ToolCallId,
    subCallId: subCallId as ToolCallId,
    name,
    arguments: args,
  })
}

/** Record one top-level result, which carries its call id inside the message. */
function result(target: Session, callId: string): void {
  target.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId: ToolCallId(callId), content: [], isError: false }),
  }, { surfaceOp: 'append' })
}

/** Record one PTC dispatch settling. */
function dispatched(target: Session, subCallId: string): void {
  target.append('tool/ptc-dispatch', {
    rootCallId: 'call_root' as ToolCallId,
    parentCallId: 'call_root' as ToolCallId,
    subCallId: subCallId as ToolCallId,
    name: ACT_COMPONENT_TOOL_NAME,
    arguments: OPENED,
    isError: false,
    content: [],
  })
}

/** The one act call every case here opens. */
const OPENED: ActComponentArgs = { entry: 'demo', steps: [{ action: 'click', key: 'add' }] }

/** The one read call the cases that carry both tools open. */
const READ: ReadComponentArgs = { entry: 'demo', node: 'toolbar' }

describe('the componentAccess unit', () => {
  it('declares its key, its version, and an empty start', () => {
    const unit = projection()
    expect({ key: unit.key, stateVersion: unit.stateVersion }).toEqual({ key: 'componentAccess', stateVersion: 1 })
    const target = session()
    expect(unit.init(target.header, target.inheritedEventCount)).toEqual([])
  })

  it('opened a call of either tool from either log shape and drops it when the result arrives', () => {
    const unit = projection()
    const target = session()
    let state = unit.init(target.header, target.inheritedEventCount)
    const events: SessionEvent[] = []
    call(target, 'call_1', OPENED)
    call(target, 'call_2', OPENED)
    result(target, 'call_1')
    dispatch(target, 'call_3', OPENED)
    dispatched(target, 'call_3')
    call(target, 'call_4', READ, READ_COMPONENT_TOOL_NAME)
    dispatch(target, 'call_5', READ, READ_COMPONENT_TOOL_NAME)
    result(target, 'call_5')
    events.push(...target.snapshotEvents())
    for (const event of events) state = unit.apply(state, event)
    expect(state).toEqual([
      { callId: 'call_2', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED },
      { callId: 'call_4', tool: READ_COMPONENT_TOOL_NAME, args: READ },
    ])
  })

  it('reads each tool\'s arguments with that tool\'s own reading, and opens nothing for the other\'s', () => {
    const unit = projection()
    const target = session()
    let state = unit.init(target.header, target.inheritedEventCount)
    // A read's arguments are not an act's, and the other way round: an event
    // naming one tool with the other's arguments opens no call at all. What the
    // other tool's reading is told to be unreadable is its own required field
    // missing — an act names steps, a read names the entry.
    call(target, 'call_1', READ)
    call(target, 'call_2', { node: 'toolbar' }, READ_COMPONENT_TOOL_NAME)
    call(target, 'call_3', { entry: 'demo', node: 'a b' }, READ_COMPONENT_TOOL_NAME)
    for (const event of target.snapshotEvents()) state = unit.apply(state, event)
    expect(state).toEqual([])
  })

  it('leaves the list alone for events that open or settle nothing', () => {
    const unit = projection()
    const target = session()
    call(target, 'call_1', OPENED)
    let state = unit.init(target.header, target.inheritedEventCount)
    for (const event of target.snapshotEvents()) state = unit.apply(state, event)
    const opened = state
    const noise = session()
    call(noise, 'call_2', OPENED, 'content_read')
    call(noise, 'call_3', 'not json')
    call(noise, 'call_4', { entry: 'demo', steps: [] })
    result(noise, 'call_not_open')
    for (const event of noise.snapshotEvents()) {
      expect(unit.apply(opened, event)).toBe(opened)
    }
  })

  it('publishes the open calls of both tools in order, with the share of the deadline their steps may run for', () => {
    const unit = projection()
    const pending: ComponentCall[] = [
      { callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED },
      { callId: 'call_2', tool: READ_COMPONENT_TOOL_NAME, args: READ },
    ]
    // Three quarters of the report deadline, which is what a claimed set of
    // steps may run for before the trip back.
    const view = unit.wire.view(pending)
    expect(view).toEqual({ pending, stepBudgetMs: 11_250 })
    expect(unit.wire.viewSchema.parse(view)).toEqual(view)
    expect(unit.wire.viewSchema.safeParse({ pending, stepBudgetMs: 11_250.5 }).success).toBe(false)
  })

  it('refuses a call whose arguments the tool\'s own reading cannot read, in the checkpoint and on the wire', () => {
    const unit = projection()
    for (const call of [
      { callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: { entry: '', steps: [] } },
      { callId: 'call_2', tool: READ_COMPONENT_TOOL_NAME, args: { entry: '', node: 'a b' } },
    ]) {
      expect(unit.stateSchema.safeParse([call]).success).toBe(false)
      expect(JSON.stringify(unit.wire.viewSchema.safeParse({ pending: [call], stepBudgetMs: 0 }).error))
        .toContain('not a set of arguments this tool takes')
    }
  })

  it('reads back the state its own schema wrote, so a checkpoint cannot drift from the wire', () => {
    const unit = projection()
    const calls: ComponentCall[] = [
      { callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED },
      { callId: 'call_2', tool: READ_COMPONENT_TOOL_NAME, args: READ },
    ]
    expect(unit.stateSchema.parse(calls)).toEqual(calls)
  })
})
