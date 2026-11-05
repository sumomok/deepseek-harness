import { describe, expect, it } from 'vitest'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { scanCompactionSession } from '../src/scan.ts'

const MODEL = 'scan-model'

function sessionWithTurn(id: string): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'first user' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createMessage({
      role: 'assistant', content: [{ type: 'text', text: 'answer' }],
      source: { kind: 'model', provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

function appendSelection(session: Session, provider: string, model: string): void {
  const append = session.append.bind(session) as (type: string, data: object) => unknown
  append('model/selection', { provider, model })
}

function appendFailure(session: Session, id: string): void {
  const compactionId = CompactionId(id)
  session.append('compaction/start', { compactionId, turn: 1 })
  session.append('compaction/end', { compactionId, turn: 1, error: 'Connection error.' })
}

describe('scanCompactionSession counterexamples', () => {
  it('takes the newest pending model selection after the header, not the header route', () => {
    const session = sessionWithTurn('scan-selection')
    appendSelection(session, 'selected', 'selected')
    const scan = scanCompactionSession(session)
    expect(scan.durable).toEqual({ provider: MODEL, model: MODEL })
    expect(scan.pending).toEqual({ provider: 'selected', model: 'selected' })
    expect(scan.latestRoute).toEqual({ provider: 'selected', model: 'selected' })
  })

  it('keeps a trailing failure across a restart marker and ignores an unmatched start', () => {
    const failed = sessionWithTurn('scan-end-seed')
    appendFailure(failed, 'failed')
    failed.append('session/end-seed', {})
    const scan = scanCompactionSession(failed)
    expect(scan.seededFailure).toEqual({ count: 1, errorClass: 'connection' })

    const missingEnd = sessionWithTurn('scan-missing-end')
    missingEnd.append('compaction/start', { compactionId: CompactionId('missing'), turn: 1 })
    expect(scanCompactionSession(missingEnd).seededFailure).toBeUndefined()
  })

  it('recomputes boundaries from the current surface after a replacement', () => {
    const session = sessionWithTurn('scan-shadowed-boundary')
    session.append('turn/start', { turn: 2 })
    const shadowed = session.surface.nodes.find(seq => session.eventAt(seq)?.type === 'user/message')
    if (shadowed === undefined) throw new Error('expected a surface user message')
    // A second user message in the same turn becomes the first surface user
    // only when the earlier one is shadowed.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'second user' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const second = session.surface.nodes.at(-1)!
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'replacement' }], source: { kind: 'user' },
    }), { surfaceOp: { op: 'replace', startSeq: shadowed, endSeq: shadowed }, sourceEventSeqs: [shadowed] })
    const scan = scanCompactionSession(session)
    expect(scan.boundaries.userTurnStarts).toContain(second)
    expect(scan.boundaries.userTurnStarts).not.toContain(shadowed)
  })

  it('derives the same route and boundaries from a seeded/forked session', () => {
    const source = sessionWithTurn('scan-fork-source')
    appendSelection(source, 'forked', 'forked')
    const seeded = Session.create(SessionId('scan-forked'), source.snapshotEvents())
    const scan = scanCompactionSession(seeded)
    expect(scan.pending).toEqual({ provider: 'forked', model: 'forked' })
    expect(scan.boundaries.userTurnStarts).toEqual([SessionSeq(2)])
    expect(scan.boundaries.stepStarts).toEqual([SessionSeq(4)])
  })
})
