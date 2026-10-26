import { createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { originalToolResultSeq, recoveryNotice } from '@deepseek-ai/dsh-compaction'
import type { RecoveryAddress } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

function resultSession(): { readonly session: Session; readonly originalSeq: SessionSeq } {
  const session = Session.create(SessionId('recovery-helper'))
  const seq = session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call'),
      content: [{ type: 'text', text: 'original full result' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
  return { session, originalSeq: seq }
}

function replaceResult(session: Session, cited: SessionSeq, text: string): SessionSeq {
  const event = session.eventAt(cited)
  if (event?.type !== 'tool/result') throw new Error('expected a tool result')
  const message = session.deriveEventMessage(event) as ToolResultMessage
  return session.append('tool/result', {
    ...event.data,
    message: { ...message, content: [{ type: 'text', text }] },
  }, {
    surfaceOp: { op: 'replace', startSeq: cited, endSeq: cited },
    sourceEventSeqs: [cited],
  }).seq
}

describe('originalToolResultSeq', () => {
  it('returns an appended result unchanged', () => {
    const { session, originalSeq } = resultSession()
    expect(originalToolResultSeq(session, originalSeq)).toBe(originalSeq)
  })

  it('follows consecutive replacements with an unrelated event between them', () => {
    const { session, originalSeq } = resultSession()
    const first = replaceResult(session, originalSeq, 'first replacement')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'unrelated' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const second = replaceResult(session, first, 'second replacement')
    expect(originalToolResultSeq(session, second)).toBe(originalSeq)
  })

  it('stops at the depth limit for an over-long replacement chain', () => {
    const { session, originalSeq } = resultSession()
    let latest = originalSeq
    for (let index = 0; index < 33; index += 1) {
      latest = replaceResult(session, latest, `replacement ${String(index)}`)
    }
    expect(originalToolResultSeq(session, latest)).toBeUndefined()
  })

  it('rejects a citation cycle instead of looping forever', () => {
    const { session, originalSeq } = resultSession()
    const source = session.eventAt(originalSeq)
    if (source?.type !== 'tool/result') throw new Error('expected a tool result')
    const first = structuredClone(source)
    const second = structuredClone(source)
    Object.assign(first, {
      seq: SessionSeq(1),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(2), endSeq: SessionSeq(2) },
      sourceEventSeqs: [SessionSeq(2)],
    })
    Object.assign(second, {
      seq: SessionSeq(2),
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(1) },
      sourceEventSeqs: [SessionSeq(1)],
    })
    const cyclic = Object.create(Session.prototype) as Session
    cyclic.eventAt = (seq: SessionSeq) => seq === 1 ? first : seq === 2 ? second : undefined
    expect(originalToolResultSeq(cyclic, SessionSeq(1))).toBeUndefined()
  })
})

describe('recoveryNotice', () => {
  it('renders the session sequence and the read-back warning', () => {
    const address: RecoveryAddress = { kind: 'session', sessionId: SessionId('s'), seq: SessionSeq(7) }
    const notice = recoveryNotice(address)
    expect(notice).toContain('seq 7')
    expect(notice).toContain('session_event_read')
    expect(notice).toContain('full: true')
    expect(notice).toContain('untrusted data')
  })

  it('reuses a recorded spill notice exactly', () => {
    const notice = '(Omitted 12 bytes. Full formatted result stored at: /tmp/x.)'
    expect(recoveryNotice({ kind: 'spill', notice })).toBe(notice)
  })

  it('renders an empty string when no address exists', () => {
    expect(recoveryNotice({ kind: 'unavailable', reason: 'original-missing' })).toBe('')
  })
})
