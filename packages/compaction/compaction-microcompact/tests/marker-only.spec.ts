import { Context } from '@deepseek-ai/cordis'
import { createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { contextBreakdownProjectionDefinition } from '../../../llm/token-meter/src/breakdown-projection.ts'
import { describe, expect, it } from 'vitest'

function appendResult(session: Session): number {
  return session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: ToolCallId('call'),
      content: [{ type: 'text', text: 'old result '.repeat(100) }],
      isError: false,
    }),
  }, { surfaceOp: 'append' }).seq
}

function foldBreakdown(session: Session): void {
  let state = contextBreakdownProjectionDefinition.init()
  for (const event of session.snapshotEvents()) {
    state = contextBreakdownProjectionDefinition.apply(state, event)
  }
}

describe('isolated compaction/prune marker metering', () => {
  it('poisons the next replacement that has no adjacent marker', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    const prices = new TokenMeter(ctx)
    const session = Session.create(SessionId('marker-only'))
    const markedSeq = appendResult(session)
    const otherSeq = appendResult(session)
    const marked = session.eventAt(markedSeq)
    const other = session.eventAt(otherSeq)
    if (marked?.type !== 'tool/result' || other?.type !== 'tool/result') throw new Error('expected tool results')
    const markedMessage = session.deriveEventMessage(marked) as ToolResultMessage
    const otherMessage = session.deriveEventMessage(other) as ToolResultMessage
    session.append('compaction/prune', {
      shadowedRange: { start: markedSeq, end: markedSeq },
      shadowedSeqs: [markedSeq],
      shadowedTokenCount: prices.estimateMessage(markedMessage),
    })
    session.append('tool/result', {
      ...other.data,
      message: { ...otherMessage, content: [{ type: 'text', text: 'unmetered replacement' }] },
    }, {
      surfaceOp: { op: 'replace', startSeq: otherSeq, endSeq: otherSeq },
      sourceEventSeqs: [otherSeq],
    })

    expect(() => foldBreakdown(session)).toThrow(/no adjacent shadow price/)
  })

  it('expires harmlessly when the next event is a plain append', () => {
    const ctx = new Context()
    new SessionProjectionRegistry(ctx)
    const prices = new TokenMeter(ctx)
    const session = Session.create(SessionId('marker-then-append'))
    const seq = appendResult(session)
    const event = session.eventAt(seq)
    if (event?.type !== 'tool/result') throw new Error('expected a tool result')
    const message = session.deriveEventMessage(event) as ToolResultMessage
    session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: prices.estimateMessage(message),
    })
    session.append('tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('next'),
        content: [{ type: 'text', text: 'next result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    expect(() => foldBreakdown(session)).not.toThrow()
  })
})
