/**
 * The question both halves read: what the host writes into the command's one
 * text field, what the row reads back out of it, and the line the agreeing
 * click runs.
 *
 * Every value here crosses a process and comes back off a durable log, so the
 * cases that matter are the ones where what arrives is not what was written: an
 * older build's document, a hand-edited log, and a settlement that is an
 * ordinary sentence.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  consentNonce,
  encodeConsentQuestion,
  formatViewCommandLine,
  parseViewCommandInput,
  readConsentQuestion,
} from '../src/consent-question.ts'

/** One well-formed nonce, in the alphabet the host mints them in. */
const NONCE = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'

/** One question, as the host settles the command with it. */
const QUESTION = { view: 'layers', card: '打开「图层配置」的数据页。\n数据表：SpaceLayer', nonce: consentNonce(NONCE) }

describe('one drawn question', () => {
  it('comes back the way it went in', () => {
    expect(readConsentQuestion(encodeConsentQuestion(QUESTION))).toEqual(QUESTION)
  })

  it('is not read out of an ordinary settlement', () => {
    // The same field carries this row's refusal sentences; a row drawing
    // whatever happened to parse would be a card built out of a future refusal.
    expect(readConsentQuestion('没有这个视图。')).toBeUndefined()
    expect(readConsentQuestion(JSON.stringify(QUESTION))).toBeUndefined()
    expect(readConsentQuestion(undefined)).toBeUndefined()
  })

  it('is not read out of this row\'s own marker followed by nothing readable', () => {
    expect(readConsentQuestion('content-view-consent\n')).toBeUndefined()
    expect(readConsentQuestion('content-view-consent\n{')).toBeUndefined()
    expect(readConsentQuestion('content-view-consent\n"a string"')).toBeUndefined()
    expect(readConsentQuestion('content-view-consent\nnull')).toBeUndefined()
  })

  it('is not read out of a document missing a field, or carrying one of the wrong kind', () => {
    const encode = (fields: Record<string, unknown>): string => `content-view-consent\n${JSON.stringify(fields)}`
    expect(readConsentQuestion(encode({ card: QUESTION.card, nonce: NONCE }))).toBeUndefined()
    expect(readConsentQuestion(encode({ view: '', card: QUESTION.card, nonce: NONCE }))).toBeUndefined()
    expect(readConsentQuestion(encode({ view: 'layers', nonce: NONCE }))).toBeUndefined()
    expect(readConsentQuestion(encode({ view: 'layers', card: '', nonce: NONCE }))).toBeUndefined()
    expect(readConsentQuestion(encode({ view: 'layers', card: QUESTION.card }))).toBeUndefined()
    expect(readConsentQuestion(encode({ view: 'layers', card: QUESTION.card, nonce: 42 }))).toBeUndefined()
    // Nothing outside the alphabet the host mints in: a value the tables could
    // never hold is a value the row must not carry back as an agreement.
    expect(readConsentQuestion(encode({ view: 'layers', card: QUESTION.card, nonce: 'not-a-nonce' }))).toBeUndefined()
  })
})

describe('one click\'s line', () => {
  it('names the view alone, or the view and the agreement', () => {
    expect(formatViewCommandLine('layers')).toBe('layers')
    expect(formatViewCommandLine('layers', consentNonce(NONCE))).toBe(`layers ${NONCE}`)
  })

  it('reads both back, the way the sidebar and the chat row write them', () => {
    expect(parseViewCommandInput(' layers')).toEqual({ viewId: 'layers' })
    expect(parseViewCommandInput(` layers ${NONCE}`)).toEqual({ viewId: 'layers', nonce: NONCE })
  })

  it('reads a garbled agreement as no agreement, because both end at the card', () => {
    expect(parseViewCommandInput('layers nonsense')).toEqual({ viewId: 'layers' })
    expect(parseViewCommandInput(`layers ${NONCE.slice(1)}`)).toEqual({ viewId: 'layers' })
    expect(parseViewCommandInput('   ')).toEqual({ viewId: '' })
  })
})
