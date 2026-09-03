/**
 * The read channel's wire boundary: what the claim and report routes accept
 * from a poster that is not this package's browser half, and what they refuse.
 *
 * Both documents crossed a process, so every field is checked rather than
 * trusted from the type — including the two bounds that keep a forged report
 * from making the host buffer an arbitrary page.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  isActOutcome, MAX_ACT_STEPS, MAX_BUSY_NAMES, MAX_HEADER_CHARS, MAX_NAME_CHARS, MAX_OUTCOME_MESSAGE_CHARS,
  MAX_TEXT_BYTES_PER_CHAR, parseActArgs, parseChannelReport, parseClaimRequest, REPORT_ENVELOPE_BYTES,
  REPORT_SYNTAX_BYTES, sanitize, type ActOutcome, type ReadOutcome,
} from '../src/access/wire.ts'

/** The listing bound these cases are written against. */
const MAX_TEXT = 100

/** One well-formed listing outcome. */
const READ: ReadOutcome = {
  status: 'ok',
  page: { id: 'home', title: 'Home' },
  snapshot: {
    kind: 'outline',
    url: 'http://localhost/content-app/',
    title: 'Fleet',
    signIn: false,
    text: '1 main',
    truncated: false,
    shown: 1,
    total: 1,
    settled: true,
  },
}

/** Wrap one outcome as a whole report body. */
function report(outcome: unknown): unknown {
  return { callId: 'call_1', tabId: 'tab_1', outcome }
}

/**
 * One C0 control a page can hold and JSON cannot carry cheaply: six bytes per
 * unit where the report's byte bound allows four per character.
 */
const CONTROL = String.fromCharCode(1)

/** The other half of the same problem: a surrogate with no partner. */
const LONE_SURROGATE = String.fromCharCode(0xd800)

describe('what a posted string may be made of', () => {
  it('hands back a string it has nothing to drop from, rather than a copy of it', () => {
    // Reference equality, because every posted field runs through this and a
    // page with nothing wrong with it should cost nothing to post.
    for (const clean of ['', 'Fleet', '\u7532\u4e59', String.fromCodePoint(0x1f600), 'a\tb\nc\rd']) {
      expect(sanitize(clean)).toBe(clean)
    }
  })

  it('drops the code points JSON cannot carry cheaply, and keeps the rest of the line', () => {
    expect(sanitize(`Fleet${CONTROL}${String.fromCharCode(127)} status`)).toBe('Fleet status')
    // Every C0 control other than the three whitespace ones, and DEL.
    const codes = [...Array.from({ length: 32 }, (_, code) => code), 127]
    const kept = codes.filter(code => sanitize(`a${String.fromCharCode(code)}b`) !== 'ab')
    expect(kept).toEqual([9, 10, 13])
  })

  it('drops a surrogate half standing alone and keeps a whole pair', () => {
    const emoji = String.fromCodePoint(0x1f600)
    expect(sanitize(`a${LONE_SURROGATE}b${emoji}`)).toBe(`ab${emoji}`)
    expect(sanitize(`a${String.fromCharCode(0xdc00)}b`)).toBe('ab')
    expect(sanitize(`a${LONE_SURROGATE}b`).isWellFormed()).toBe(true)
  })
})

describe('claim wire boundary', () => {
  it('takes a claim naming both ids', () => {
    expect(parseClaimRequest({ callId: 'call_1', tabId: 'tab_1' })).toEqual({ callId: 'call_1', tabId: 'tab_1' })
  })

  it('drops whatever the body carries beyond the two ids', () => {
    expect(parseClaimRequest({ callId: 'call_1', tabId: 'tab_1', force: true }))
      .toEqual({ callId: 'call_1', tabId: 'tab_1' })
  })

  it('refuses a body that is not a claim', () => {
    for (const body of [
      null, 'call_1', 7, [], {},
      { callId: 'call_1' },
      { tabId: 'tab_1' },
      { callId: '', tabId: 'tab_1' },
      { callId: 'call_1', tabId: '' },
      { callId: 1, tabId: 'tab_1' },
      { callId: 'c'.repeat(MAX_NAME_CHARS + 1), tabId: 'tab_1' },
    ]) {
      expect({ body, parsed: parseClaimRequest(body) }).toEqual({ body, parsed: undefined })
    }
  })

  it('takes an id at the bound, so what refuses the one above is its length', () => {
    const at = 'c'.repeat(MAX_NAME_CHARS)
    expect(parseClaimRequest({ callId: at, tabId: at })).toEqual({ callId: at, tabId: at })
  })
})

describe('report wire boundary', () => {
  it('takes a listing report whole', () => {
    expect(parseChannelReport(report(READ), MAX_TEXT, MAX_ACT_STEPS))
      .toEqual({ callId: 'call_1', tabId: 'tab_1', outcome: READ })
  })

  it('keeps the optional header fields a page supplied', () => {
    const outcome: ReadOutcome = {
      ...READ,
      snapshot: { ...READ.snapshot, modal: 'Confirm', cursor: 'e12' },
    }
    expect(parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS)?.outcome).toEqual(outcome)
  })

  it('drops optional header fields the page did not supply rather than carrying undefined', () => {
    const parsed = parseChannelReport(report(READ), MAX_TEXT, MAX_ACT_STEPS)
    expect(parsed?.outcome.status === 'ok' && Object.keys(parsed.outcome.snapshot).sort())
      .toEqual(['kind', 'settled', 'shown', 'signIn', 'text', 'title', 'total', 'truncated', 'url'])
  })

  it('takes each failure code, with the entry naming only where one is carried', () => {
    for (const code of ['empty', 'not-a-page', 'engine', 'frame'] as const) {
      expect(parseChannelReport(report({ status: 'error', code, message: 'why' }), MAX_TEXT, MAX_ACT_STEPS)?.outcome)
        .toEqual({ status: 'error', code, message: 'why' })
    }
    expect(parseChannelReport(report({ status: 'error', code: 'not-a-page', message: 'why', kind: 'chart', title: 'Sales' }), MAX_TEXT, MAX_ACT_STEPS)?.outcome)
      .toEqual({ status: 'error', code: 'not-a-page', message: 'why', kind: 'chart', title: 'Sales' })
  })

  it('takes a listing that found nothing at all', () => {
    const nothing: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, text: '', shown: 0, total: 0 } }
    expect(parseChannelReport(report(nothing), MAX_TEXT, MAX_ACT_STEPS)?.outcome).toEqual(nothing)
  })

  it('refuses a listing past the bound instead of taking it', () => {
    const outcome = { ...READ, snapshot: { ...READ.snapshot, text: 'x'.repeat(MAX_TEXT + 1) } }
    expect(parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    expect(parseChannelReport(report({ ...READ, snapshot: { ...READ.snapshot, text: 'x'.repeat(MAX_TEXT) } }), MAX_TEXT, MAX_ACT_STEPS))
      .not.toBeUndefined()
  })

  it('keeps the busy names a page supplied, up to the count the envelope allows', () => {
    const busy = Array.from({ length: MAX_BUSY_NAMES }, (_unused, at) => `region ${String(at)}`)
    const outcome: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, busy } }
    expect(parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS)?.outcome).toEqual(outcome)
  })

  it('refuses a busy list longer than the envelope allows, or one holding something other than names', () => {
    const tooMany = Array.from({ length: MAX_BUSY_NAMES + 1 }, () => 'region')
    for (const busy of [tooMany, 'region', [1], ['x'.repeat(MAX_NAME_CHARS + 1)]]) {
      expect(parseChannelReport(report({ ...READ, snapshot: { ...READ.snapshot, busy } }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    }
  })

  it('refuses a listing that does not say whether the page had settled', () => {
    const { settled: _dropped, ...without } = READ.snapshot
    expect(parseChannelReport(report({ ...READ, snapshot: without }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    expect(parseChannelReport(report({ ...READ, snapshot: { ...without, settled: 'yes' } }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
  })

  it('refuses a failure message past its own bound', () => {
    const long = { status: 'error', code: 'frame', message: 'x'.repeat(2001) }
    expect(parseChannelReport(report(long), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    expect(parseChannelReport(report({ ...long, message: 'x'.repeat(2000) }), MAX_TEXT, MAX_ACT_STEPS)).not.toBeUndefined()
  })

  it('refuses a body that is not a report', () => {
    for (const body of [
      null, 'report', [],
      { tabId: 'tab_1', outcome: READ },
      { callId: 'call_1', outcome: READ },
      { callId: 'call_1', tabId: '', outcome: READ },
      { callId: 'call_1', tabId: 'tab_1' },
      report(null),
      report('ok'),
      report({ status: 'maybe' }),
    ]) {
      expect({ body, parsed: parseChannelReport(body, MAX_TEXT, MAX_ACT_STEPS) }).toEqual({ body, parsed: undefined })
    }
  })

  it('refuses a listing whose fields are not the ones a read produces', () => {
    for (const snapshot of [
      null,
      'a listing',
      { ...READ.snapshot, kind: 'sketch' },
      { ...READ.snapshot, url: 7 },
      { ...READ.snapshot, title: null },
      { ...READ.snapshot, signIn: 'no' },
      { ...READ.snapshot, truncated: 'no' },
      { ...READ.snapshot, text: 7 },
      { ...READ.snapshot, shown: 1.5 },
      { ...READ.snapshot, total: 'many' },
      // A count below none would print to the model as a page with fewer than
      // no items in it.
      { ...READ.snapshot, shown: -1 },
      { ...READ.snapshot, total: -1 },
      { ...READ.snapshot, modal: 7 },
      { ...READ.snapshot, cursor: 7 },
    ]) {
      expect({ snapshot, parsed: parseChannelReport(report({ ...READ, snapshot }), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ snapshot, parsed: undefined })
    }
  })

  it('refuses a listing report that does not name the page it read', () => {
    for (const page of [null, 'home', {}, { id: 'home' }, { id: '', title: 'Home' }, { id: 'home', title: 7 }]) {
      expect({ page, parsed: parseChannelReport(report({ ...READ, page }), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ page, parsed: undefined })
    }
  })

  it('refuses an id or a name past its bound, and takes the same body at it', () => {
    // Every one of these ends up in the envelope the route's byte bound is
    // computed from, so none of them may be unbounded.
    const long = 'n'.repeat(MAX_NAME_CHARS + 1)
    for (const [field, body] of [
      ['callId', { callId: long, tabId: 'tab_1', outcome: READ }],
      ['tabId', { callId: 'call_1', tabId: long, outcome: READ }],
      ['page.id', report({ ...READ, page: { id: long, title: 'Home' } })],
      ['page.title', report({ ...READ, page: { id: 'home', title: long } })],
      ['kind', report({ status: 'error', code: 'not-a-page', message: 'why', kind: long })],
      ['title', report({ status: 'error', code: 'not-a-page', message: 'why', title: long })],
    ] as const) {
      expect({ field, parsed: parseChannelReport(body, MAX_TEXT, MAX_ACT_STEPS) }).toEqual({ field, parsed: undefined })
    }
    const at = 'n'.repeat(MAX_NAME_CHARS)
    const outcome: ReadOutcome = { ...READ, page: { id: at, title: at } }
    expect(parseChannelReport({ callId: at, tabId: at, outcome }, MAX_TEXT, MAX_ACT_STEPS)).not.toBeUndefined()
  })

  it('refuses a failure that names no code this reader produces', () => {
    for (const outcome of [
      { status: 'error', message: 'why' },
      { status: 'error', code: 'exploded', message: 'why' },
      { status: 'error', code: 'frame' },
      { status: 'error', code: 'frame', message: 7 },
      { status: 'error', code: 'not-a-page', message: 'why', kind: 7 },
      { status: 'error', code: 'not-a-page', message: 'why', title: 7 },
    ]) {
      expect({ outcome, parsed: parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ outcome, parsed: undefined })
    }
  })

  it('refuses a field carrying what the seat would have removed', () => {
    // The byte bound is computed at four bytes per character while each of
    // these costs six per unit, so a listing inside the budget could still be
    // refused for its size; a body still carrying them is not one the seat
    // wrote. The refusal is a shape rather than a size, because the document
    // arrived in full and is not the one this route takes.
    for (const [field, outcome] of [
      ['text', { ...READ, snapshot: { ...READ.snapshot, text: `1 main${CONTROL}` } }],
      ['url', { ...READ, snapshot: { ...READ.snapshot, url: `http://x/${CONTROL}` } }],
      ['title', { ...READ, snapshot: { ...READ.snapshot, title: `Fleet${LONE_SURROGATE}` } }],
      ['modal', { ...READ, snapshot: { ...READ.snapshot, modal: `Confirm${LONE_SURROGATE}` } }],
      ['cursor', { ...READ, snapshot: { ...READ.snapshot, cursor: `e1${CONTROL}` } }],
      ['page.title', { ...READ, page: { id: 'home', title: `Home${CONTROL}` } }],
      ['message', { status: 'error', code: 'frame', message: `why${CONTROL}` }],
      ['kind', { status: 'error', code: 'not-a-page', message: 'why', kind: `chart${CONTROL}` }],
      ['outcome.title', { status: 'error', code: 'not-a-page', message: 'why', title: `Sales${LONE_SURROGATE}` }],
    ] as const) {
      expect({ field, parsed: parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS) }).toEqual({ field, parsed: undefined })
    }
    // Both ids are held to the same rule, on a report and on a claim.
    expect(parseChannelReport({ callId: `call_1${CONTROL}`, tabId: 'tab_1', outcome: READ }, MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    expect(parseClaimRequest({ callId: 'call_1', tabId: `tab_1${LONE_SURROGATE}` })).toBeUndefined()
  })

  it('keeps the whitespace a listing is built out of', () => {
    // Tab, newline and carriage return cost two JSON bytes, which the byte
    // bound covers, and the listing itself is lines.
    const outcome: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, text: '1 main\n  2 button\tGo\r' } }
    expect(parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS)?.outcome).toEqual(outcome)
  })
})

describe('what a posted report of steps must carry', () => {
  /** One well-formed report of two steps that ran. */
  const ACT: ActOutcome = {
    status: 'done',
    page: { id: 'home', title: 'Home' },
    title: 'Fleet',
    steps: [{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }],
    text: 'Done 2/2 on Home: click "Go" (settled after 0.1s).',
    truncated: false,
  }

  it('takes both endings a call that ran steps can have', () => {
    for (const status of ['done', 'failed'] as const) {
      const outcome: ActOutcome = { ...ACT, status }
      expect(parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS)?.outcome).toEqual(outcome)
    }
  })

  it('numbers the steps as the call asked for them', () => {
    // A report naming a step the call never had describes something else, so
    // the indices are the positions themselves rather than whatever was sent.
    for (const steps of [
      [{ index: 2, status: 'ok' }],
      [{ index: 1, status: 'ok' }, { index: 3, status: 'ok' }],
      [{ index: 0, status: 'ok' }],
      [{ index: '1', status: 'ok' }],
      [null],
      ['ok'],
    ]) {
      expect({ steps, parsed: parseChannelReport(report({ ...ACT, steps }), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ steps, parsed: undefined })
    }
  })

  it('carries at most one message, because execution stops at the first failure', () => {
    // Also what keeps a report of steps inside the envelope a listing is sized
    // against: one message is the same 2000 characters a failure carries.
    const one = [{ index: 1, status: 'ok' }, { index: 2, status: 'failed', message: 'e5 is gone' }]
    expect(parseChannelReport(report({ ...ACT, steps: one }), MAX_TEXT, MAX_ACT_STEPS)?.outcome)
      .toEqual({ ...ACT, steps: one })
    const two = [{ index: 1, status: 'failed', message: 'e4 is gone' }, { index: 2, status: 'failed', message: 'e5 is gone' }]
    expect(parseChannelReport(report({ ...ACT, steps: two }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
  })

  it('refuses a step list that is empty, over the bound, or not a list', () => {
    for (const steps of [[], undefined, 'two', Array.from({ length: 3 }, (_, at) => ({ index: at + 1, status: 'ok' }))]) {
      expect({ steps, parsed: parseChannelReport(report({ ...ACT, steps }), MAX_TEXT, 2) })
        .toEqual({ steps, parsed: undefined })
    }
  })

  it('refuses a status no step can end with, and a message past the bound', () => {
    expect(parseChannelReport(report({ ...ACT, steps: [{ index: 1, status: 'ran' }] }), MAX_TEXT, MAX_ACT_STEPS))
      .toBeUndefined()
    const long = [{ index: 1, status: 'failed', message: 'x'.repeat(2001) }]
    expect(parseChannelReport(report({ ...ACT, steps: long }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
  })

  it('pairs the message with the failure and with nothing else', () => {
    // A failure with no reason is the one report the model can do nothing with,
    // and a message on a step that ran describes something that did not happen.
    for (const steps of [
      [{ index: 1, status: 'failed' }],
      [{ index: 1, status: 'ok', message: 'went fine' }],
      [{ index: 1, status: 'ok' }, { index: 2, status: 'skipped', message: 'never ran' }],
    ]) {
      expect({ steps, parsed: parseChannelReport(report({ ...ACT, steps }), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ steps, parsed: undefined })
    }
    const skipped = [{ index: 1, status: 'failed', message: 'e5 is gone' }, { index: 2, status: 'skipped' }]
    expect(parseChannelReport(report({ ...ACT, status: 'failed', steps: skipped }), MAX_TEXT, MAX_ACT_STEPS)?.outcome)
      .toEqual({ ...ACT, status: 'failed', steps: skipped })
  })

  it('refuses a report missing the page, the title, the body, or the cut flag', () => {
    for (const [field, outcome] of [
      ['page', { ...ACT, page: undefined }],
      ['page.id', { ...ACT, page: { id: `home${CONTROL}`, title: 'Home' } }],
      ['title', { ...ACT, title: undefined }],
      ['title', { ...ACT, title: 'x'.repeat(201) }],
      ['text', { ...ACT, text: undefined }],
      ['text', { ...ACT, text: 'x'.repeat(MAX_TEXT + 1) }],
      ['truncated', { ...ACT, truncated: 'no' }],
    ] as const) {
      expect({ field, parsed: parseChannelReport(report(outcome), MAX_TEXT, MAX_ACT_STEPS) })
        .toEqual({ field, parsed: undefined })
    }
  })

  it('tells a report of steps from a listing by its own discriminant', () => {
    // One route, two documents: `done` and `failed` are the steps' own arms,
    // and everything else is read as the listing channel's.
    expect(parseChannelReport(report({ ...ACT, status: 'ok' }), MAX_TEXT, MAX_ACT_STEPS)).toBeUndefined()
    expect(isActOutcome(ACT)).toBe(true)
    expect(isActOutcome(READ)).toBe(false)
    expect(isActOutcome({ status: 'error', code: 'frame', message: 'why' })).toBe(false)
  })
})

describe('what the envelope leaves a report of steps', () => {
  it('leaves 9,120 bytes unspent, which a hundred steps of punctuation fit inside', () => {
    // The figure the two constants' own prose states, computed from them
    // rather than quoted: every report spends two of the four names on the
    // call's id and the tab's, and a report of steps spends the other two on
    // the page's id and title, one header field on the document's title, and
    // the message allowance on its one failing step.
    const spent = 4 * MAX_NAME_CHARS + MAX_HEADER_CHARS + MAX_OUTCOME_MESSAGE_CHARS
    const unspent = REPORT_ENVELOPE_BYTES - REPORT_SYNTAX_BYTES - spent * MAX_TEXT_BYTES_PER_CHAR
    expect(unspent).toBe(9120)
    // And what {@link MAX_ACT_STEPS} is chosen against: about 35 bytes of
    // punctuation a step.
    expect(MAX_ACT_STEPS * 35).toBeLessThan(unspent)
  })
})

describe('what a browser half may be asked to run', () => {
  it('reads the steps a call opened, dropping the fields it did not carry', () => {
    const steps = [
      { action: 'fill', ref: 'e4', label: '名称', text: '东风' },
      { action: 'select', ref: 'e6', label: '站点', value: '东风' },
      { action: 'press', ref: 'e4', label: '名称', key: 'Enter' },
      { action: 'click', ref: 'e5', label: '查询' },
      { action: 'wait', text: '保存成功' },
    ]
    expect(parseActArgs({ steps, dialogs: 'accept' })).toEqual({ steps, dialogs: 'accept' })
    expect(parseActArgs({ steps: [{ action: 'click', ref: 'e5', label: 'Go' }] }))
      .toEqual({ steps: [{ action: 'click', ref: 'e5', label: 'Go' }] })
  })

  it('refuses arguments no seat could run', () => {
    for (const args of [
      undefined,
      'steps',
      { steps: [] },
      { steps: 'click' },
      { steps: [{ action: 'scroll', ref: 'e5', label: 'Go' }] },
      { steps: [{ action: 'click', ref: 12, label: 'Go' }] },
      { steps: [null] },
      { steps: [{ action: 'click', ref: 'e5', label: 'Go' }], dialogs: 'confirm' },
      { steps: [{ action: 'press', ref: 'e4', label: '名称', key: '' }] },
      // Every page's visible text contains the empty string, so a wait for it
      // is a step that reports itself satisfied having waited for nothing.
      { steps: [{ action: 'wait', text: '' }] },
      { steps: Array.from({ length: MAX_ACT_STEPS + 1 }, () => ({ action: 'click', ref: 'e5', label: 'Go' })) },
    ]) {
      expect({ args, parsed: parseActArgs(args) }).toEqual({ args, parsed: undefined })
    }
  })
})
