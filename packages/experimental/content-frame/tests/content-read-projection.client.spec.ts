/**
 * The `contentAccess` fold: which log events open a call of either tool, which
 * close it, and what the browser is handed for each.
 *
 * The events come from a real `Session` rather than hand-built envelopes, so
 * the fold is exercised against the log shapes the harness actually writes —
 * including the Code Mode pair, which is the only shape a model reaching the
 * tool through `run_code` leaves behind.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { contentAccessProjection } from '../src/access/requests-projection.ts'
import { UNPUBLISHABLE_CALL_REFUSAL } from '../src/access/text.ts'
import type { ContentAccessRequest } from '../src/types.ts'

/** The branded call id, derived from the log's own declaration. */
type LoggedCallId = SessionEventMap['tool/call']['callId']

/** Every line this unit logged, in order; each case starts with none. */
let warnings: string[] = []

/** The logger the unit is built over, which only a refused view ever reaches. */
const logger = { warn: (message: string): void => { warnings.push(message) } }

/** Build the unit under test over this case's logger. */
function projection(): ReturnType<typeof contentAccessProjection> {
  return contentAccessProjection(logger)
}

beforeEach(() => { warnings = [] })

let sessions = 0

/** A fresh empty session to append log events into. */
function session(): Session {
  sessions += 1
  return Session.create(SessionId(`content-access-${sessions}`))
}

/** Record one top-level model call, with `arguments` exactly as a model produces them. */
function call(target: Session, callId: string, args: string, name = 'content_read'): void {
  target.append('tool/call', { turn: 1, step: 1, callId: callId as LoggedCallId, name, arguments: args })
}

/** Record one Code Mode dispatch, whose arguments are already decoded. */
function dispatch(target: Session, subCallId: string, args: unknown, name = 'content_read'): void {
  target.append('tool/code-dispatch-start', {
    rootCallId: 'call_root' as LoggedCallId,
    parentCallId: 'call_root' as LoggedCallId,
    subCallId: subCallId as LoggedCallId,
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

/** Record one Code Mode dispatch settling. */
function dispatched(target: Session, subCallId: string): void {
  target.append('tool/code-dispatch', {
    rootCallId: 'call_root' as LoggedCallId,
    parentCallId: 'call_root' as LoggedCallId,
    subCallId: subCallId as LoggedCallId,
    name: 'content_read',
    arguments: {},
    isError: false,
    content: [],
  })
}

/** Fold one session's whole log through the unit under test. */
function fold(target: Session): ContentAccessRequest[] {
  const unit = projection()
  let state = unit.init(target.header, target.inheritedEventCount)
  for (const event of target.snapshotEvents()) state = unit.apply(state, event)
  return state
}

/** Fold one session's log and validate the wire value the browser receives. */
function published(target: Session): unknown {
  const unit = projection()
  return unit.wire.viewSchema.parse(unit.wire.view(fold(target)))
}

describe('the pending-read projection', () => {
  it('declares the key and cache version the registry stores it under', () => {
    const unit = projection()
    const empty = session()
    expect(unit.key).toBe('contentAccess')
    expect(unit.stateVersion).toBe(3)
    expect(unit.init(empty.header, empty.inheritedEventCount)).toEqual([])
  })

  it('publishes every open call in log order, with what each one asked for', () => {
    const target = session()
    call(target, 'call_1', '{}')
    call(target, 'call_2', JSON.stringify({ mode: 'map', scope: 'e4', after: 'e9', find: 'Ada' }))
    expect(published(target)).toEqual({
      pending: [
        { callId: 'call_1', tool: 'content_read', args: {} },
        { callId: 'call_2', tool: 'content_read', args: { mode: 'map', scope: 'e4', after: 'e9', find: 'Ada' } },
      ],
    })
  })

  it('counts a Code Mode dispatch by its own call id', () => {
    const target = session()
    dispatch(target, 'call_sub', { find: 'Ada' })
    expect(fold(target)).toEqual([{ callId: 'call_sub', tool: 'content_read', args: { find: 'Ada' } }])
  })

  it('drops the call once its result reaches the log, in either shape', () => {
    const target = session()
    call(target, 'call_1', '{}')
    dispatch(target, 'call_sub', {})
    expect(fold(target)).toHaveLength(2)
    result(target, 'call_1')
    expect(fold(target)).toEqual([{ callId: 'call_sub', tool: 'content_read', args: {} }])
    dispatched(target, 'call_sub')
    expect(fold(target)).toEqual([])
  })

  it('counts no call for another tool', () => {
    const target = session()
    call(target, 'call_1', JSON.stringify({ page: 'home' }), 'content_show')
    dispatch(target, 'call_sub', { page: 'home' }, 'content_show')
    expect(fold(target)).toEqual([])
  })

  it('counts no call whose arguments the tool would refuse anyway', () => {
    const target = session()
    call(target, 'call_json', 'not json at all')
    call(target, 'call_array', '"a string"')
    call(target, 'call_mode', JSON.stringify({ mode: 'sketch' }))
    call(target, 'call_scope', JSON.stringify({ scope: 12 }))
    call(target, 'call_after', JSON.stringify({ after: null }))
    call(target, 'call_find', JSON.stringify({ find: [] }))
    dispatch(target, 'call_sub', 'not an object')
    expect(fold(target)).toEqual([])
  })

  it('returns the same state for every event it does not own', () => {
    const target = session()
    call(target, 'call_1', '{}')
    result(target, 'call_1')
    // An id the fold does not carry: the removal finds nothing and changes nothing.
    result(target, 'call_absent')
    target.append('content/shown', { page: 'home', by: 'agent' })
    const unit = projection()
    const events = target.snapshotEvents()
    const opened = unit.apply(unit.init(target.header, target.inheritedEventCount), events[0]!)
    let state = opened
    for (const event of events.slice(1)) {
      const next = unit.apply(state, event)
      if (event.type === 'tool/result' && event.data.message.source.callId === 'call_1') {
        expect(next).not.toBe(state)
      } else {
        expect({ type: event.type, same: next === state }).toEqual({ type: event.type, same: true })
      }
      state = next
    }
    expect(state).toEqual([])
  })

  it('publishes a set of steps with everything a seat needs to run it', () => {
    // The seat receives the steps from here and nowhere else: the host reaches
    // no browser, so the projection is the whole of what a claiming tab knows
    // about the call.
    const target = session()
    const args = {
      steps: [
        { action: 'fill', ref: 'e4', label: '名称', text: '东风' },
        { action: 'click', ref: 'e5', label: '查询' },
      ],
      dialogs: 'accept',
    }
    call(target, 'call_act', JSON.stringify(args), 'content_act')
    dispatch(target, 'call_sub', { steps: [{ action: 'wait', text: '保存成功' }] }, 'content_act')
    expect(published(target)).toEqual({
      pending: [
        { callId: 'call_act', tool: 'content_act', args },
        { callId: 'call_sub', tool: 'content_act', args: { steps: [{ action: 'wait', text: '保存成功' }] } },
      ],
    })
  })

  it('drops a set of steps once its result reaches the log', () => {
    const target = session()
    call(target, 'call_act', JSON.stringify({ steps: [{ action: 'click', ref: 'e5', label: '查询' }] }), 'content_act')
    expect(fold(target)).toHaveLength(1)
    result(target, 'call_act')
    expect(fold(target)).toEqual([])
  })

  it('counts no set of steps the tool would refuse anyway', () => {
    const target = session()
    call(target, 'call_json', 'not json at all', 'content_act')
    call(target, 'call_empty', JSON.stringify({ steps: [] }), 'content_act')
    call(target, 'call_action', JSON.stringify({ steps: [{ action: 'scroll', ref: 'e5', label: 'x' }] }), 'content_act')
    call(target, 'call_field', JSON.stringify({ steps: [{ action: 'click', ref: 5, label: 'x' }] }), 'content_act')
    call(target, 'call_dialogs', JSON.stringify({ steps: [{ action: 'click', ref: 'e5', label: 'x' }], dialogs: 'yes' }), 'content_act')
    dispatch(target, 'call_sub', { steps: 'click' }, 'content_act')
    expect(fold(target)).toEqual([])
  })

  it('publishes a step that names a row the read printed with no name', () => {
    // What a console found: the tool took the step, the fold took it, and the
    // projection then refused the value it had just built, so the model was
    // handed `unrecognized_keys` about a field the tool documents. The schemas
    // here are the tool's own parser now, so a step cannot pass one and fail
    // the other.
    const target = session()
    const steps = [{ action: 'click', ref: 'e7', label: '', mark: 'el-icon-delete' }]
    call(target, 'call_act', JSON.stringify({ steps }), 'content_act')
    expect(published(target)).toEqual({ pending: [{ callId: 'call_act', tool: 'content_act', args: { steps } }] })
  })

  it('tells the model what it can do about a call it folded and then refused', () => {
    // The registry parses every view before it leaves, and a failure there
    // reaches the model as the validator's raw issue list — an argument to
    // change, about arguments that are fine. One sentence goes to the model and
    // the issues go to the log.
    const unit = projection()
    expect(() => unit.wire.view([{ callId: 'call_1', tool: 'content_act', args: { steps: [] } }]))
      .toThrow(UNPUBLISHABLE_CALL_REFUSAL)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('contentAccess refused its own view')
  })

  it('publishes a call of each of the three markup reads, in both log shapes', () => {
    const target = session()
    call(target, 'call_dom', JSON.stringify({ scope: 'e12', after: 'e20' }), 'content_read_dom')
    call(target, 'call_attrs', JSON.stringify({ ref: 'e12' }), 'content_read_attrs')
    dispatch(target, 'call_text', { ref: 'e12' }, 'content_read_dom_content')
    expect(fold(target)).toEqual([
      { callId: 'call_dom', tool: 'content_read_dom', args: { scope: 'e12', after: 'e20' } },
      { callId: 'call_attrs', tool: 'content_read_attrs', args: { ref: 'e12' } },
      { callId: 'call_text', tool: 'content_read_dom_content', args: { ref: 'e12' } },
    ])
  })

  it('publishes nothing for a markup call whose arguments no seat could read', () => {
    const target = session()
    call(target, 'call_dom', JSON.stringify({ after: 'e20' }), 'content_read_dom')
    call(target, 'call_attrs', JSON.stringify({ ref: 12 }), 'content_read_attrs')
    call(target, 'call_text', JSON.stringify({}), 'content_read_dom_content')
    expect(fold(target)).toEqual([])
  })

  it('accepts the state it produced back from a persisted checkpoint', () => {
    const target = session()
    call(target, 'call_1', JSON.stringify({ mode: 'outline', find: 'Ada' }))
    call(target, 'call_act', JSON.stringify({
      steps: [{ action: 'press', ref: 'e4', label: '名称', key: 'Enter' }],
      dialogs: 'cancel',
    }), 'content_act')
    call(target, 'call_dom', JSON.stringify({ scope: 'e12' }), 'content_read_dom')
    call(target, 'call_attrs', JSON.stringify({ ref: 'e12' }), 'content_read_attrs')
    call(target, 'call_text', JSON.stringify({ ref: 'e12' }), 'content_read_dom_content')
    const unit = projection()
    expect(unit.stateSchema.parse(fold(target))).toEqual(fold(target))
  })
})
