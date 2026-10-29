import { describe, expect, it } from 'vitest'
import { createMessage, createSystemMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { estimateDenseMessageTokens, estimateDenseTextTokens, estimateMessage } from '../src/estimate.ts'

describe('dense text pricing', () => {
  it('counts CJK code points as whole tokens instead of a quarter each', () => {
    expect(estimateDenseTextTokens('压'.repeat(10))).toBe(10)
    expect(estimateDenseTextTokens('')).toBe(0)
  })

  it('prices Latin text just under the fixed heuristic density', () => {
    expect(estimateDenseTextTokens('abcd')).toBe(2)
    expect(estimateDenseTextTokens('x'.repeat(35))).toBe(10)
  })

  it('prices a mixed string by both densities', () => {
    expect(estimateDenseTextTokens('压压abcd')).toBe(4)
  })

  it('prices CJK punctuation and full-width forms as dense too', () => {
    expect(estimateDenseTextTokens('「」。')).toBe(3)
  })
})

describe('dense message pricing', () => {
  it('keeps the role and block framing of the fixed heuristic', () => {
    const message = createUserMessage({ content: [{ type: 'text', text: '压压' }], source: { kind: 'user' } })
    expect(estimateDenseMessageTokens(message)).toBe(10)
    expect(estimateMessage(message)).toBe(9)
  })

  it('prices a system message without block framing, and an empty one as zero', () => {
    expect(estimateDenseMessageTokens(createSystemMessage('压压'))).toBe(6)
    expect(estimateDenseMessageTokens(createSystemMessage(''))).toBe(0)
  })

  it('prices a non-text system block by its JSON length', () => {
    const message = createMessage({
      role: 'system',
      content: [{ type: 'image', attachment: { id: 'attachment-1' } } as never],
      source: { kind: 'system-prompt' },
    })
    expect(estimateDenseMessageTokens(message)).toBe(estimateMessage(message))
  })

  it('prices a structural block with the fixed heuristic', () => {
    const message = createMessage({
      role: 'user',
      content: [{ type: 'image', attachment: { id: 'attachment-1' } } as never],
      source: { kind: 'user' },
    })
    expect(estimateDenseMessageTokens(message)).toBe(estimateMessage(message))
  })

  it('keeps the fixed heuristic for tool-call JSON', () => {
    const message = createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: 'call-1' as never, name: 'tool', arguments: '{}' }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    expect(estimateDenseMessageTokens(message)).toBe(10)
  })
})
