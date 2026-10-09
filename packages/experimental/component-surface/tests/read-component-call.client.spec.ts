/**
 * `read_component`'s own reading of its arguments and of a posted reading.
 *
 * Both are wire readings: the tool's schema and the browser that composes a
 * reading judge with the same one, and the host reads a posted outcome here
 * rather than trusting the type. Each bound is walked from both sides — a value
 * at the ceiling and one past it — because a bound that only ever sees the
 * accepting side is a bound nothing holds.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { MAX_TARGET_CHARS, MAX_TITLE_CHARS } from '../src/act-component-call.ts'
import { MAX_ENTRY_ID_LENGTH } from '../src/component-call.ts'
import {
  MAX_READING_CHARS, MAX_READING_LINES, MAX_READING_TEXT_CHARS, READ_COMPONENT_TOOL_NAME,
  parseComponentReport, parseReadComponentArgs, parseReadComponentOutcome, parseReadComponentReport,
  readReadComponentCall,
} from '../src/read-component-call.ts'

/** The entry id every accepted document names. */
const ENTRY = 'demo'

/** A block name exactly as long as a name may be. */
const LONG_TARGET = 'a'.repeat(MAX_TARGET_CHARS)

/** A block name one character past the ceiling. */
const TOO_LONG_TARGET = 'a'.repeat(MAX_TARGET_CHARS + 1)

/** One accepted reading, which the malformed variants below start from. */
const REPORT = {
  callId: 'call_1',
  tabId: 'tab_1',
  outcome: { status: 'read' as const, page: { id: ENTRY, title: 'Demo' }, text: 'Read the component entry "Demo" (demo).' },
}

describe('reading one call\'s arguments', () => {
  it('takes an entry, with or without the block it narrows the reading to', () => {
    expect(parseReadComponentArgs({ entry: ENTRY })).toEqual({ entry: ENTRY })
    expect(parseReadComponentArgs({ entry: ENTRY, node: LONG_TARGET })).toEqual({ entry: ENTRY, node: LONG_TARGET })
  })

  it('holds the entry id and the block name to their own bounds and alphabets', () => {
    expect(parseReadComponentArgs({ entry: 'a'.repeat(MAX_ENTRY_ID_LENGTH) })).toBeDefined()
    expect(parseReadComponentArgs({ entry: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1) })).toBeUndefined()
    // A block is a name in the components' own alphabet: a name that is not one
    // is refused rather than searched for.
    expect(parseReadComponentArgs({ entry: ENTRY, node: '' })).toBeUndefined()
    expect(parseReadComponentArgs({ entry: ENTRY, node: 'a b' })).toBeUndefined()
    expect(parseReadComponentArgs({ entry: ENTRY, node: TOO_LONG_TARGET })).toBeUndefined()
    for (const value of [null, 'x', 3, {}, { entry: '' }, { entry: ENTRY, node: 7 }]) {
      expect(parseReadComponentArgs(value)).toBeUndefined()
    }
  })
})

describe('reading a posted reading', () => {
  it('carries the reading the console composed, with the entry it read', () => {
    expect(parseReadComponentOutcome(REPORT.outcome)).toEqual(REPORT.outcome)
  })

  it('refuses anything that is not a reading, or that is not an object at all', () => {
    for (const value of [null, 'read', 1, undefined, { status: 'done' }, { status: 'ok' }]) {
      expect(parseReadComponentOutcome(value)).toBeUndefined()
    }
    expect(parseReadComponentOutcome({ ...REPORT.outcome, page: undefined })).toBeUndefined()
    expect(parseReadComponentOutcome({ ...REPORT.outcome, page: 'demo' })).toBeUndefined()
  })

  it('holds the entry, the title and the reading text to their own bounds', () => {
    const outcome = REPORT.outcome
    const cases: Record<string, unknown>[] = [
      { ...outcome, page: { id: '', title: 'Demo' } },
      { ...outcome, page: { id: 'a'.repeat(MAX_ENTRY_ID_LENGTH + 1), title: 'Demo' } },
      { ...outcome, page: { id: ENTRY, title: 'a'.repeat(MAX_TITLE_CHARS + 1) } },
      { ...outcome, text: 'a'.repeat(MAX_READING_CHARS + 1) },
      { ...outcome, text: 7 },
    ]
    for (const value of cases) expect(parseReadComponentOutcome(value)).toBeUndefined()
    expect(parseReadComponentOutcome({ ...outcome, text: '' })).toBeDefined()
  })

  it('reads one whole posted report, and refuses a body with no call or no reading', () => {
    expect(parseReadComponentReport(REPORT)).toEqual(REPORT)
    expect(parseReadComponentReport({ ...REPORT, outcome: { status: 'nonsense' } })).toBeUndefined()
    for (const value of [
      null, 'x', {},
      { ...REPORT, callId: '' },
      { ...REPORT, tabId: '' },
      { ...REPORT, callId: 'a'.repeat(257) },
      { ...REPORT, tabId: 'a'.repeat(257) },
    ]) {
      expect(parseReadComponentReport(value)).toBeUndefined()
    }
    // The ids are the host's and both domains read them at the same 256-bound.
    const long = 'a'.repeat(256)
    expect(parseReadComponentReport({ ...REPORT, callId: long, tabId: long }))
      .toEqual({ ...REPORT, callId: long, tabId: long })
  })
})

describe('the one reader the component domain reads its reports with', () => {
  it('takes either tool\'s arm and refuses a body neither posts', () => {
    const act = {
      ...REPORT,
      outcome: {
        status: 'done' as const,
        page: { id: ENTRY, title: 'Demo' },
        title: 'Demo',
        steps: [{ index: 1, status: 'ok' as const }],
        text: 'Acted.',
        truncated: false,
      },
    }
    expect(parseComponentReport(act)).toEqual(act)
    expect(parseComponentReport(REPORT)).toEqual(REPORT)
    // The refusal arm is shared, and is read whichever tool the call belonged
    // to: it says the same three things to either.
    const refused = { ...REPORT, outcome: { status: 'error' as const, code: 'front-changed' as const, message: 'why' } }
    expect(parseComponentReport(refused)).toEqual(refused)
    // A page read's document is no arm of this domain's, whichever tool it is
    // posted for.
    expect(parseComponentReport({
      ...REPORT,
      outcome: {
        status: 'ok',
        page: { id: ENTRY, title: 'Demo' },
        snapshot: { kind: 'outline', url: 'u', title: 't', text: '', truncated: false, shown: 0, total: 0, settled: true },
      },
    })).toBeUndefined()
    expect(parseComponentReport({ ...REPORT, outcome: { status: 'read' } })).toBeUndefined()
  })

  it('hands each tool its own arm: an act body is no reading and a reading is no act body', () => {
    const act = {
      ...REPORT,
      outcome: {
        status: 'done',
        page: { id: ENTRY, title: 'Demo' },
        title: 'Demo',
        steps: [{ index: 1, status: 'ok' }],
        text: 'Acted.',
        truncated: false,
      },
    }
    // The two parsers are disjoint on the discriminant, which is what lets one
    // member read both domains' bodies without either being misread.
    expect(parseReadComponentReport(act)).toBeUndefined()
    expect(parseReadComponentReport(REPORT)).toBeDefined()
  })
})

describe('reading the calls out of a session log', () => {
  /** One session to append the shapes into. */
  function session(): Session {
    return Session.create(SessionId('read-component-call'))
  }

  /** The call id a shape is expected to carry. */
  const CALL = 'call_1'

  it('reads a top-level tool call whose arguments are raw JSON', () => {
    const target = session()
    target.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CALL as ToolCallId,
      name: READ_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ entry: ENTRY, node: 'toolbar' }),
    })
    const [event] = target.snapshotEvents()
    expect(readReadComponentCall(event as SessionEvent)).toEqual({
      callId: CALL,
      tool: READ_COMPONENT_TOOL_NAME,
      args: { entry: ENTRY, node: 'toolbar' },
    })
  })

  it('reads a Code Mode dispatch whose arguments are already decoded', () => {
    const target = session()
    target.append('tool/ptc-dispatch-start', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: CALL as ToolCallId,
      name: READ_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY },
    })
    const [event] = target.snapshotEvents()
    expect(readReadComponentCall(event as SessionEvent)).toEqual({
      callId: CALL,
      tool: READ_COMPONENT_TOOL_NAME,
      args: { entry: ENTRY },
    })
  })

  it('reads no call out of another tool, unreadable arguments, or an event that opens none', () => {
    const other = session()
    other.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: 'content_read', arguments: '{}',
    })
    const noEntry = session()
    noEntry.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: READ_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ node: 'toolbar' }),
    })
    const broken = session()
    broken.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: READ_COMPONENT_TOOL_NAME, arguments: 'not json',
    })
    const unreadable = session()
    unreadable.append('tool/call', {
      turn: 1, step: 1, callId: CALL as ToolCallId, name: READ_COMPONENT_TOOL_NAME, arguments: '{"entry":"demo","node":"a b"}',
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
      name: READ_COMPONENT_TOOL_NAME,
      arguments: { entry: '' },
    })
    const settled = session()
    // A result event settles a call (the fold's other reader takes it) and
    // opens none, whichever tool the call belonged to.
    settled.append('tool/ptc-dispatch', {
      rootCallId: 'call_root' as ToolCallId,
      parentCallId: 'call_root' as ToolCallId,
      subCallId: CALL as ToolCallId,
      name: READ_COMPONENT_TOOL_NAME,
      arguments: { entry: ENTRY },
      isError: false,
      content: [],
    })
    for (const target of [other, noEntry, broken, unreadable, dispatchedOther, dispatchedUnreadable, settled]) {
      const [event] = target.snapshotEvents()
      expect(readReadComponentCall(event as SessionEvent)).toBeUndefined()
    }
  })
})

describe('the bounds a reading is written under', () => {
  it('states the three ceilings the console and this module share', () => {
    // The console composes inside these, and this parser takes what it posts:
    // the two are one number each, so a reading can never be refused for a size
    // its own composer already held it to.
    expect(MAX_READING_LINES).toBe(200)
    expect(MAX_READING_CHARS).toBe(10_000)
    expect(MAX_READING_TEXT_CHARS).toBe(120)
  })
})
