/**
 * The `contentAccess` fold: which log events open a read, which close it, and
 * what the browser is handed for each.
 *
 * The events come from a real `Session` rather than hand-built envelopes, so
 * the fold is exercised against the log shapes the harness actually writes —
 * including the Code Mode pair, which is the only shape a model reaching the
 * tool through `run_code` leaves behind.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEventMap } from '@deepseek-ai/dsh-session/types'
import { contentAccessProjection } from '../src/access/requests-projection.ts'
import type { ContentReadRequest } from '../src/types.ts'

/** The branded call id, derived from the log's own declaration. */
type LoggedCallId = SessionEventMap['tool/call']['callId']

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
function fold(target: Session): ContentReadRequest[] {
  const unit = contentAccessProjection()
  let state = unit.init()
  for (const event of target.events) state = unit.apply(state, event)
  return state
}

/** Fold one session's log and validate the wire value the browser receives. */
function published(target: Session): unknown {
  const unit = contentAccessProjection()
  return unit.wire.viewSchema.parse(unit.wire.view(fold(target)))
}

describe('the pending-read projection', () => {
  it('declares the key and cache version the registry stores it under', () => {
    const unit = contentAccessProjection()
    expect(unit.key).toBe('contentAccess')
    expect(unit.stateVersion).toBe(1)
    expect(unit.init()).toEqual([])
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
    const unit = contentAccessProjection()
    const opened = unit.apply(unit.init(), target.events[0]!)
    let state = opened
    for (const event of target.events.slice(1)) {
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

  it('accepts the state it produced back from a persisted checkpoint', () => {
    const target = session()
    call(target, 'call_1', JSON.stringify({ mode: 'outline', find: 'Ada' }))
    const unit = contentAccessProjection()
    expect(unit.stateSchema.parse(fold(target))).toEqual(fold(target))
  })
})
