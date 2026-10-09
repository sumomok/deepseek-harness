/**
 * `act_component`'s own reading of its arguments and of a posted report.
 *
 * Both are wire readings: the tool's schema and the browser that runs a step
 * judge with the same one, and the host reads a posted outcome here rather than
 * trusting the type. Each bound is walked from both sides — a value at the
 * ceiling and one past it — because a bound that only ever sees the accepting
 * side is a bound nothing holds.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session/types'
import {
  ACT_COMPONENT_TOOL_NAME, MAX_ACT_COMPONENT_STEPS, MAX_MESSAGE_CHARS,
  MAX_REPORT_TEXT_CHARS, MAX_SET_VALUE_CHARS, MAX_TARGET_CHARS, MAX_TITLE_CHARS, MAX_WAIT_MS,
  isActComponentReport, parseActComponentArgs, parseActComponentOutcome, parseActComponentReport,
  readActComponentCall, readActComponentStep, settledComponentCall,
} from '../src/act-component-call.ts'
import { MAX_ENTRY_ID_LENGTH } from '../src/component-call.ts'

/** The entry id every accepted document names. */
const ENTRY = 'demo'

/** A target name exactly as long as a name may be. */
const LONG_TARGET = 'a'.repeat(MAX_TARGET_CHARS)

/** A target name one character past the ceiling. */
const TOO_LONG_TARGET = 'a'.repeat(MAX_TARGET_CHARS + 1)

/** One accepted step result, which a report's `steps` list carries. */
const STEP_OK = { index: 1, status: 'ok' as const }

/** One accepted report body, which the malformed variants below start from. */
const REPORT = {
  callId: 'call_1',
  tabId: 'tab_1',
  outcome: {
    status: 'done' as const,
    page: { id: ENTRY, title: 'Demo' },
    title: 'Demo',
    steps: [STEP_OK],
    text: 'Acted.',
    truncated: false,
  },
}

describe('reading one step', () => {
  it('accepts each action with the fields it needs, and omits the ones it does not', () => {
    expect(readActComponentStep({ action: 'click', key: 'add' }))
      .toEqual({ action: 'click', key: 'add' })
    expect(readActComponentStep({ action: 'click', node: 'toolbar', key: 'add' }))
      .toEqual({ action: 'click', node: 'toolbar', key: 'add' })
    expect(readActComponentStep({ action: 'set', name: 'title', value: '' }))
      .toEqual({ action: 'set', name: 'title', value: '' })
    expect(readActComponentStep({ action: 'set', node: 'grid', name: 'title', value: 'X' }))
      .toEqual({ action: 'set', node: 'grid', name: 'title', value: 'X' })
    expect(readActComponentStep({ action: 'wait', node: 'grid' })).toEqual({ action: 'wait', node: 'grid' })
    expect(readActComponentStep({ action: 'wait', key: 'add' })).toEqual({ action: 'wait', key: 'add' })
    expect(readActComponentStep({ action: 'wait', node: 'grid', key: 'add', timeoutMs: 1 }))
      .toEqual({ action: 'wait', node: 'grid', key: 'add', timeoutMs: 1 })
    expect(readActComponentStep({ action: 'wait', key: 'add', timeoutMs: MAX_WAIT_MS }))
      .toEqual({ action: 'wait', key: 'add', timeoutMs: MAX_WAIT_MS })
  })

  it('refuses a value that is not a step, and a step whose target is not a component name', () => {
    for (const value of [null, 'click', 7, undefined]) {
      expect(readActComponentStep(value)).toBeUndefined()
    }
    // A block is a name in the components' own alphabet: a name that is not one
    // is refused rather than searched for.
    expect(readActComponentStep({ action: 'click', key: 'add', node: TOO_LONG_TARGET })).toBeUndefined()
    expect(readActComponentStep({ action: 'click', key: 'add', node: '' })).toBeUndefined()
    expect(readActComponentStep({ action: 'click', key: 'add', node: 'a b' })).toBeUndefined()
    expect(readActComponentStep({ action: 'click', key: TOO_LONG_TARGET })).toBeUndefined()
    expect(readActComponentStep({ action: 'click' })).toBeUndefined()
    expect(readActComponentStep({ action: 'press', key: 'add' })).toBeUndefined()
    expect(readActComponentStep({})).toBeUndefined()
  })

  it('refuses a set whose name is not one or whose value is past the write ceiling', () => {
    expect(readActComponentStep({ action: 'set', name: LONG_TARGET, value: 'a'.repeat(MAX_SET_VALUE_CHARS) }))
      .toEqual({ action: 'set', name: LONG_TARGET, value: 'a'.repeat(MAX_SET_VALUE_CHARS) })
    expect(readActComponentStep({ action: 'set', name: 'title', value: 'a'.repeat(MAX_SET_VALUE_CHARS + 1) }))
      .toBeUndefined()
    expect(readActComponentStep({ action: 'set', name: 'title', value: 7 })).toBeUndefined()
    expect(readActComponentStep({ action: 'set', value: 'X' })).toBeUndefined()
  })

  it('refuses a wait with no target at all, or with a timeout outside the protocol ceiling', () => {
    expect(readActComponentStep({ action: 'wait' })).toBeUndefined()
    expect(readActComponentStep({ action: 'wait', key: TOO_LONG_TARGET })).toBeUndefined()
    for (const timeoutMs of [0, MAX_WAIT_MS + 1, 1.5, '1000', Number.NaN]) {
      expect(readActComponentStep({ action: 'wait', key: 'add', timeoutMs })).toBeUndefined()
    }
  })
})

describe('reading one call', () => {
  it('reads a whole set of steps, and refuses the set when any one of them is unreadable', () => {
    expect(parseActComponentArgs({
      entry: ENTRY,
      steps: [
        { action: 'click', key: 'add' },
        { action: 'set', name: 'title', value: 'X' },
        { action: 'wait', node: 'grid' },
      ],
    })).toEqual({
      entry: ENTRY,
      steps: [
        { action: 'click', key: 'add' },
        { action: 'set', name: 'title', value: 'X' },
        { action: 'wait', node: 'grid' },
      ],
    })
    expect(parseActComponentArgs({
      entry: ENTRY,
      steps: [{ action: 'click', key: 'add' }, { action: 'wait' }],
    })).toBeUndefined()
  })

  it('holds the entry id and the step count to their own bounds', () => {
    const steps = Array.from({ length: MAX_ACT_COMPONENT_STEPS }, () => ({ action: 'click', key: 'add' }))
    expect(parseActComponentArgs({ entry: ENTRY, steps })).toBeDefined()
    expect(parseActComponentArgs({ entry: ENTRY, steps: [...steps, { action: 'click', key: 'add' }] })).toBeUndefined()
    expect(parseActComponentArgs({ entry: 'a'.repeat(MAX_ENTRY_ID_LENGTH), steps })).toBeDefined()
    expect(parseActComponentArgs({ entry: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1), steps })).toBeUndefined()
    for (const value of [null, 'x', 3, {}, { entry: '', steps }, { entry: ENTRY, steps: [] }, { entry: ENTRY, steps: 'x' }]) {
      expect(parseActComponentArgs(value)).toBeUndefined()
    }
  })
})

describe('reading a posted outcome', () => {
  it('carries a report of steps that ran, with each step as it ended', () => {
    expect(parseActComponentOutcome({
      ...REPORT.outcome,
      steps: [{ index: 1, status: 'failed', message: 'no' }, { index: 2, status: 'skipped' }],
    })).toEqual({
      status: 'done',
      page: { id: ENTRY, title: 'Demo' },
      title: 'Demo',
      steps: [{ index: 1, status: 'failed', message: 'no' }, { index: 2, status: 'skipped' }],
      text: 'Acted.',
      truncated: false,
    })
  })

  it('carries the three refusals this domain posts, and no other code', () => {
    for (const code of ['empty', 'front-changed', 'engine'] as const) {
      expect(parseActComponentOutcome({ status: 'error', code, message: 'why' }))
        .toEqual({ status: 'error', code, message: 'why' })
    }
    for (const code of ['refused', 'unknown', undefined]) {
      expect(parseActComponentOutcome({ status: 'error', code, message: 'why' })).toBeUndefined()
    }
    expect(parseActComponentOutcome({ status: 'error', code: 'empty' })).toBeUndefined()
    expect(parseActComponentOutcome({ status: 'error', code: 'empty', message: 'a'.repeat(MAX_MESSAGE_CHARS + 1) }))
      .toBeUndefined()
  })

  it('refuses anything that is not one of its two statuses, or that is not an object at all', () => {
    for (const value of [null, 'done', 1, undefined]) expect(parseActComponentOutcome(value)).toBeUndefined()
    expect(parseActComponentOutcome({ status: 'unverified' })).toBeUndefined()
  })

  it('holds the entry, the titles, the steps and the text to their own bounds', () => {
    const outcome = REPORT.outcome
    const cases: Record<string, unknown>[] = [
      { ...outcome, page: undefined },
      { ...outcome, page: 'demo' },
      { ...outcome, page: { id: '', title: 'Demo' } },
      { ...outcome, page: { id: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1), title: 'Demo' } },
      { ...outcome, page: { id: ENTRY, title: 'a'.repeat(MAX_TITLE_CHARS + 1) } },
      { ...outcome, title: 'a'.repeat(MAX_TITLE_CHARS + 1) },
      { ...outcome, truncated: 'no' },
      { ...outcome, steps: 'none' },
      { ...outcome, steps: Array.from({ length: MAX_ACT_COMPONENT_STEPS + 1 }, (_, at) => ({ index: at + 1, status: 'ok' })) },
      { ...outcome, steps: [{ index: 0, status: 'ok' }] },
      { ...outcome, steps: [{ index: 1, status: 'done' }] },
      { ...outcome, steps: [{ index: 1, status: 'failed' }] },
      { ...outcome, steps: [{ index: 1, status: 'ok', message: 'why' }] },
      { ...outcome, steps: [null] },
      { ...outcome, steps: [{ index: 1, status: 'failed', message: 'a'.repeat(MAX_MESSAGE_CHARS + 1) }] },
      { ...outcome, text: 'a'.repeat(MAX_REPORT_TEXT_CHARS + 1) },
      { ...outcome, text: 7 },
    ]
    for (const value of cases) expect(parseActComponentOutcome(value)).toBeUndefined()
    // A step the call never asked for is not a step result this host carries.
    expect(parseActComponentOutcome({ ...outcome, steps: [{ index: 2, status: 'ok' }] })).toBeDefined()
  })

  it('reads one whole posted report, and refuses a body with no call or no readable outcome', () => {
    expect(parseActComponentReport(REPORT)).toEqual(REPORT)
    expect(parseActComponentReport({ ...REPORT, outcome: { status: 'nonsense' } })).toBeUndefined()
    for (const value of [
      null, 'x', {},
      { ...REPORT, callId: '' },
      { ...REPORT, tabId: '' },
      { ...REPORT, callId: 'a'.repeat(257) },
      { ...REPORT, tabId: 'a'.repeat(257) },
    ]) {
      expect(parseActComponentReport(value)).toBeUndefined()
    }
  })

  it("takes the channel's own ids at the bound the page domain takes them at", () => {
    // The call and tab ids are the host's, not this domain's, and both domains
    // read the same two off the same channel: a bound narrower here would
    // refuse a report the page domain takes, and the call would be answered as
    // a console that went quiet. 256 is that bound written out rather than
    // read from this package's own constant, so a bound that moves here fails
    // against the number the two domains have to agree on.
    const long = 'a'.repeat(256)
    expect(parseActComponentReport({ ...REPORT, callId: long, tabId: long }))
      .toEqual({ ...REPORT, callId: long, tabId: long })
    expect(parseActComponentReport({ ...REPORT, callId: 'a'.repeat(257) })).toBeUndefined()
  })
})

describe('which settled outcome answers this tool', () => {
  it('is one that reports steps, and not one a page read answers with', () => {
    expect(isActComponentReport({
      status: 'done', page: { id: ENTRY, title: 'Demo' }, title: 'Demo', steps: [STEP_OK], text: '', truncated: false,
    })).toBe(true)
    expect(isActComponentReport({
      status: 'failed', page: { id: ENTRY, title: 'Demo' }, title: 'Demo', steps: [STEP_OK], text: '', truncated: false,
    })).toBe(true)
    expect(isActComponentReport({ status: 'error', code: 'empty', message: 'why' })).toBe(false)
    expect(isActComponentReport({
      status: 'ok', page: { id: ENTRY, title: 'Demo' },
      snapshot: { kind: 'outline', url: 'u', title: 't', text: '', truncated: false, shown: 0, total: 0, settled: true },
    })).toBe(false)
  })
})

describe('reading the calls out of a session log', () => {
  /** One session to append the shapes into. */
  function session(): Session {
    return Session.create(SessionId('act-component-call'))
  }

  /** The call id a shape is expected to carry. */
  const CALL = 'call_1'

  it('reads a top-level tool call whose arguments are raw JSON', () => {
    const target = session()
    target.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CALL as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ entry: ENTRY, steps: [{ action: 'click', key: 'add' }] }),
    })
    const [event] = target.snapshotEvents()
    expect(readActComponentCall(event as SessionEvent)).toEqual({
      callId: CALL,
      tool: ACT_COMPONENT_TOOL_NAME,
      args: { entry: ENTRY, steps: [{ action: 'click', key: 'add' }] },
    })
  })

  it('reads a Code Mode dispatch whose arguments are already decoded', () => {
    const target = session()
    target.append('tool/ptc-dispatch-start', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: CALL as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY, steps: [{ action: 'wait', key: 'add' }] },
    })
    const [event] = target.snapshotEvents()
    expect(readActComponentCall(event as SessionEvent)).toEqual({
      callId: CALL,
      tool: ACT_COMPONENT_TOOL_NAME,
      args: { entry: ENTRY, steps: [{ action: 'wait', key: 'add' }] },
    })
  })

  it('reads no call out of another tool, unreadable arguments, or an event that opens none', () => {
    const other = session()
    other.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: 'content_read', arguments: '{}',
    })
    const broken = session()
    broken.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: ACT_COMPONENT_TOOL_NAME, arguments: 'not json',
    })
    const unreadable = session()
    unreadable.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: ACT_COMPONENT_TOOL_NAME, arguments: '{"entry":"demo","steps":[]}',
    })
    const dispatchedOther = session()
    dispatchedOther.append('tool/ptc-dispatch-start', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: CALL as ToolCallId,
      name: 'content_read',
      arguments: {},
    })
    const dispatchedUnreadable = session()
    dispatchedUnreadable.append('tool/ptc-dispatch-start', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: CALL as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY, steps: [] },
    })
    const [otherEvent] = other.snapshotEvents()
    const [brokenEvent] = broken.snapshotEvents()
    const [unreadableEvent] = unreadable.snapshotEvents()
    const [dispatchedOtherEvent] = dispatchedOther.snapshotEvents()
    const [dispatchedUnreadableEvent] = dispatchedUnreadable.snapshotEvents()
    for (const event of [
      otherEvent, brokenEvent, unreadableEvent, dispatchedOtherEvent, dispatchedUnreadableEvent,
    ]) {
      expect(readActComponentCall(event as SessionEvent)).toBeUndefined()
    }
  })

  it('reads the call id a result or a dispatch settles, and none from anything else', () => {
    const target = session()
    target.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'msg_1',
        role: 'user',
        content: [{ type: 'tool_result', callId: CALL, content: [], isError: false }],
        source: { kind: 'tool', callId: CALL },
      },
    } as unknown as SessionEventMap['tool/result'], { surfaceOp: 'append' })
    target.append('tool/ptc-dispatch', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: 'call_2' as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY, steps: [{ action: 'wait', key: 'add' }] },
      isError: false,
      content: [],
    })
    target.append('tool/ptc-dispatch-start', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: 'call_3' as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY, steps: [{ action: 'wait', key: 'add' }] },
    })
    const [result, dispatch, start] = target.snapshotEvents()
    expect(settledComponentCall(result as SessionEvent)).toBe(CALL)
    expect(settledComponentCall(dispatch as SessionEvent)).toBe('call_2')
    // A dispatch *start* opens a call; it settles none.
    expect(settledComponentCall(start as SessionEvent)).toBeUndefined()
  })
})
