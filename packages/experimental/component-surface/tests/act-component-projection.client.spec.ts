/**
 * The `componentAccess` fold: which log events open an `act_component` call,
 * which close it, and what the browser is handed for each.
 *
 * The events come from a real `Session` rather than hand-built envelopes, so
 * the fold is exercised against the log shapes the harness actually writes —
 * the top-level call and the Code Mode dispatch pair. The view is checked
 * against its own schema here before it is published, which is the one path
 * that reaches the logger.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { ACT_COMPONENT_TOOL_NAME, type ActComponentArgs, type ActComponentCall } from '../src/act-component-call.ts'
import { actComponentProjection } from '../src/act-component-projection.ts'

/** Every line this unit logged, in order; each case starts with none. */
let warnings: string[] = []

/** The logger the unit is built over, which only a refused view reaches. */
const logger = { warn: (message: string): void => { warnings.push(message) } }

/** Build the unit under test over this case's logger. */
function projection(): ReturnType<typeof actComponentProjection> {
  return actComponentProjection(logger)
}

beforeEach(() => { warnings = [] })

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
    message: {
      id: `msg_${callId}`,
      role: 'user',
      content: [{ type: 'tool_result', callId, content: [], isError: false }],
      source: { kind: 'tool', callId },
    },
  } as unknown as SessionEventMap['tool/result'], { surfaceOp: 'append' })
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

/** The one call every case here opens. */
const OPENED: ActComponentArgs = { entry: 'demo', steps: [{ action: 'click', key: 'add' }] }

describe('the componentAccess unit', () => {
  it('declares its key, its version, and an empty start', () => {
    const unit = projection()
    expect({ key: unit.key, stateVersion: unit.stateVersion }).toEqual({ key: 'componentAccess', stateVersion: 1 })
    const target = session()
    expect(unit.init(target.header, target.inheritedEventCount)).toEqual([])
  })

  it('opened a call from either log shape and drops it when the result arrives', () => {
    const unit = projection()
    const target = session()
    let state = unit.init(target.header, target.inheritedEventCount)
    const events: SessionEvent[] = []
    call(target, 'call_1', OPENED)
    call(target, 'call_2', OPENED)
    result(target, 'call_1')
    dispatch(target, 'call_3', OPENED)
    dispatched(target, 'call_3')
    events.push(...target.snapshotEvents())
    for (const event of events) state = unit.apply(state, event)
    expect(state).toEqual([{ callId: 'call_2', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED }])
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
      expect(unit.apply(opened, event as SessionEvent)).toBe(opened)
    }
  })

  it('publishes the open calls in order, and refuses a view its own schema does not take', () => {
    const unit = projection()
    const pending: ActComponentCall[] = [{ callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED }]
    expect(unit.wire.view(pending)).toEqual({ pending })
    expect(warnings).toEqual([])
    const impossible = [{ callId: 'call_1', tool: 'content_read', args: OPENED }] as never
    expect(() => unit.wire.view(impossible)).toThrow(
      'componentAccess could not publish a call it had folded: this is a defect in the component action channel.',
    )
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('componentAccess refused its own view:')
  })

  it('refuses a view whose arguments the shared reading cannot read', () => {
    const unit = projection()
    const impossible = [{ callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: { entry: '', steps: [] } }] as never
    expect(() => unit.wire.view(impossible)).toThrow()
    expect(warnings[0]).toContain('not a set of arguments this tool takes')
  })

  it('reads back the state its own schema wrote, so a checkpoint cannot drift from the wire', () => {
    const unit = projection()
    const calls: ActComponentCall[] = [{ callId: 'call_1', tool: ACT_COMPONENT_TOOL_NAME, args: OPENED }]
    expect(unit.stateSchema.parse(calls)).toEqual(calls)
  })
})
