import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import { harvestIdentities, projectSession, assertSanitized } from './project.ts'

const FIXTURES = join(import.meta.dirname, 'fixtures')

interface FixtureEvent {
  readonly type: string
  readonly data?: Record<string, unknown>
  readonly surfaceOp?: unknown
  readonly sourceEventSeqs?: readonly number[]
}

function load(name: string): FixtureEvent[] {
  const raw = readFileSync(join(FIXTURES, name, 'session.jsonl'), 'utf8')
  return raw.split('\n').filter(line => line.trim().length > 0).map(line => JSON.parse(line) as FixtureEvent)
}

function lines(name: string): string[] {
  return readFileSync(join(FIXTURES, name, 'session.jsonl'), 'utf8').split('\n').filter(line => line.trim().length > 0)
}

function callsOf(events: readonly FixtureEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type === 'tool/call') ids.add(String(event.data?.['callId']))
  }
  return ids
}

function resultsOf(events: readonly FixtureEvent[]): Set<string> {
  const ids = new Set<string>()
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    const message = event.data?.['message'] as Record<string, unknown> | undefined
    if (message?.['toolCallId'] !== undefined) ids.add(String(message['toolCallId']))
  }
  return ids
}

function compactionBrackets(events: readonly FixtureEvent[]): { id: string; start: number; end?: number; failed: boolean }[] {
  const open = new Map<string, { id: string; start: number; end?: number; failed: boolean }>()
  const ordered: { id: string; start: number; end?: number; failed: boolean }[] = []
  events.forEach((event, index) => {
    const id = String(event.data?.['compactionId'] ?? '')
    if (event.type === 'compaction/start') {
      const bracket = { id, start: index, failed: false }
      open.set(id, bracket)
      ordered.push(bracket)
    }
    if (event.type === 'compaction/end') {
      const bracket = open.get(id)
      if (bracket !== undefined) { bracket.end = index; bracket.failed = event.data?.['error'] !== undefined }
    }
  })
  return ordered
}

/** A raw log with supplier identities and free text, for the negative cases. */
function rawLog(text: string, provider: string, model: string): string {
  const events = [
    { type: 'session', version: 4, isSeeded: false, delegationDepth: 0, agentPreset: 'standard', id: 'raw', cwd: '/work/fixture' },
    { type: 'request/context', seq: 1, data: { provider, model, contextWindow: 128000 } },
    { type: 'user/message', seq: 2, data: { message: { role: 'user', content: [{ type: 'text', text }] } }, surfaceOp: 'append' },
  ]
  return events.map(event => JSON.stringify(event)).join('\n')
}

describe('projector', () => {
  it('keeps the original byte length of redacted text', () => {
    const text = 'x'.repeat(1234)
    const { lines: projected } = projectSession(rawLog(text, 'prov-a', 'model-a'))
    expect(projected.join('\n')).toContain('<redacted:text:1234>')
  })

  it('keeps the byte length of a redacted path and marks it as a path', () => {
    const path = '/Users/example/secret/file.ts'
    const { lines: projected } = projectSession(rawLog(path, 'prov-a', 'model-a'))
    expect(projected.join('\n')).toContain(`<redacted:path:${String(Buffer.byteLength(path))}>`)
    expect(projected.join('\n')).not.toContain('/Users/')
  })

  it('forbids every provider and model identity harvested from the input by default', () => {
    const raw = rawLog('hello', 'supplier-x', 'model-y')
    expect(harvestIdentities(raw)).toEqual(['model-y', 'supplier-x'])
    const { lines: projected } = projectSession(raw)
    const body = projected.join('\n')
    expect(body).not.toContain('supplier-x')
    expect(body).not.toContain('model-y')
    expect(body).toContain('<redacted:provider:10>')
    expect(body).toContain('<redacted:model:7>')
  })

  it('rejects a line that still carries a forbidden identity', () => {
    const leaked = JSON.stringify({ type: 'compaction/summary', data: { model: 'model-y' } })
    expect(() => assertSanitized([leaked], { forbidden: ['model-y'] })).toThrow(/forbidden identity/)
  })

  it('rejects content that was never redacted', () => {
    const leaked = JSON.stringify({ type: 'user/message', data: { message: { content: [{ type: 'text', text: 'plain prose here' }] } } })
    expect(() => assertSanitized([leaked])).toThrow(/neither redacted nor structural/)
  })

  it('rejects an orphan tool call', () => {
    const orphan = JSON.stringify({ type: 'tool/call', data: { callId: 'call-0001', name: 'bash' } })
    expect(() => assertSanitized([orphan])).toThrow(/tool pairing/)
  })
})

describe('fixture A: parallel and delayed tool results', () => {
  // Authored: the recorded session never produced a delayed result.
  const events: FixtureEvent[] = [
    { type: 'session', data: { version: 4, id: 'session-fixture', cwd: '/work/fixture' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'step/start', data: { turn: 1, step: 1 } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-0001', name: 'bash', arguments: '<redacted:arguments:2>' } },
    { type: 'tool/call', data: { turn: 1, step: 1, callId: 'call-0002', name: 'read', arguments: '<redacted:arguments:2>' } },
    { type: 'tool/result', data: { turn: 1, step: 1, message: { role: 'tool', toolCallId: 'call-0002' } } },
    { type: 'step/end', data: { turn: 1, step: 1 } },
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { type: 'tool/result', data: { turn: 1, step: 2, message: { role: 'tool', toolCallId: 'call-0001' } } },
    { type: 'step/end', data: { turn: 1, step: 2 } },
    { type: 'turn/end', data: { turn: 1 } },
  ]

  it('pairs every call with a result even when one arrives a step late', () => {
    expect([...callsOf(events)].sort()).toEqual([...resultsOf(events)].sort())
  })

  it('shows that a cut between an open call and its late result is not balanced', () => {
    const beforeLateResult = events.slice(0, 7)
    expect([...callsOf(beforeLateResult)].filter(id => !resultsOf(beforeLateResult).has(id))).toEqual(['call-0001'])
  })

  it('closes both pairs once the delayed result lands', () => {
    const open = [...callsOf(events)].filter(id => !resultsOf(events).has(id))
    expect(open).toEqual([])
  })
})

describe('fixture B: consecutive compactions', () => {
  const events = load('boundary-b-consecutive')

  it('contains a completed compaction immediately followed by a failed one', () => {
    const brackets = compactionBrackets(events)
    expect(brackets).toHaveLength(2)
    expect(brackets[0]).toMatchObject({ failed: false })
    expect(brackets[1]).toMatchObject({ failed: true })
    expect(brackets[0].end! + 1).toBe(brackets[1].start)
  })

  it('keeps the failed attempt from replacing the surface', () => {
    const failedStart = compactionBrackets(events)[1].start
    const replacementsAfterFailure = events
      .slice(failedStart)
      .filter(event => event.type === 'user/message' && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
        && (event.surfaceOp as { op?: string }).op === 'replace')
    expect(replacementsAfterFailure).toEqual([])
  })

  it('does not retry a failed attempt on every following step', () => {
    const brackets = compactionBrackets(events)
    const failedStarts = brackets.filter(bracket => bracket.failed).map(bracket => bracket.start)
    expect(failedStarts).toHaveLength(1)
  })

  it('keeps tool pairing intact across both attempts', () => {
    expect([...callsOf(events)].sort()).toEqual([...resultsOf(events)].sort())
  })

  it('closes every bracket it opened', () => {
    for (const bracket of compactionBrackets(events)) expect(bracket.end).toBeTypeOf('number')
  })
})

describe('fixture C: process exit during compaction', () => {
  const events = load('boundary-c-midexit')

  it('leaves exactly one compaction open at the truncation point', () => {
    const brackets = compactionBrackets(events)
    expect(brackets).toHaveLength(1)
    expect(brackets[0].end).toBeUndefined()
  })

  it('carries a restart boundary after the open compaction', () => {
    const openStart = events.findIndex(event => event.type === 'compaction/start')
    const seed = events.findIndex(event => event.type === 'session/end-seed')
    expect(seed).toBeGreaterThan(openStart)
  })

  it('never applies a replacement for the abandoned attempt', () => {
    const replacements = events.filter(event => event.type === 'user/message'
      && typeof event.surfaceOp === 'object' && event.surfaceOp !== null
      && (event.surfaceOp as { op?: string }).op === 'replace')
    expect(replacements).toEqual([])
  })

  it('resumes the conversation after the restart boundary', () => {
    const seed = events.findIndex(event => event.type === 'session/end-seed')
    const after = events.slice(seed + 1).map(event => event.type)
    expect(after).toContain('turn/start')
    expect(after).toContain('turn/end')
  })
})

describe('recorded fixtures', () => {
  for (const name of ['sample-small', 'control-healthy'] as const) {
    it(`${name} passes every sanitization rule`, () => {
      const report = assertSanitized(lines(name))
      expect(report).toMatchObject({ pathHits: 0, longLines: 0, forbiddenHits: 0, unredactedContent: 0 })
    })

    it(`${name} keeps tool calls and results paired`, () => {
      const events = load(name)
      expect([...callsOf(events)].sort()).toEqual([...resultsOf(events)].sort())
    })
  }

  it('the control window contains a successful compaction and no failed one', () => {
    const brackets = compactionBrackets(load('control-healthy'))
    expect(brackets.length).toBeGreaterThan(0)
    expect(brackets.filter(bracket => bracket.failed)).toEqual([])
  })
})
