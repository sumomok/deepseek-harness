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
  MAX_BUSY_NAMES, MAX_NAME_CHARS, parseClaimRequest, parseReportRequest, sanitize, type ReadOutcome,
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
    expect(parseReportRequest(report(READ), MAX_TEXT))
      .toEqual({ callId: 'call_1', tabId: 'tab_1', outcome: READ })
  })

  it('keeps the optional header fields a page supplied', () => {
    const outcome: ReadOutcome = {
      ...READ,
      snapshot: { ...READ.snapshot, breadcrumb: 'Home › Fleet', modal: 'Confirm', cursor: 'e12' },
    }
    expect(parseReportRequest(report(outcome), MAX_TEXT)?.outcome).toEqual(outcome)
  })

  it('drops optional header fields the page did not supply rather than carrying undefined', () => {
    const parsed = parseReportRequest(report(READ), MAX_TEXT)
    expect(parsed?.outcome.status === 'ok' && Object.keys(parsed.outcome.snapshot).sort())
      .toEqual(['kind', 'settled', 'shown', 'signIn', 'text', 'title', 'total', 'truncated', 'url'])
  })

  it('takes each failure code, with the entry naming only where one is carried', () => {
    for (const code of ['empty', 'not-a-page', 'engine', 'frame'] as const) {
      expect(parseReportRequest(report({ status: 'error', code, message: 'why' }), MAX_TEXT)?.outcome)
        .toEqual({ status: 'error', code, message: 'why' })
    }
    expect(parseReportRequest(report({ status: 'error', code: 'not-a-page', message: 'why', kind: 'chart', title: 'Sales' }), MAX_TEXT)?.outcome)
      .toEqual({ status: 'error', code: 'not-a-page', message: 'why', kind: 'chart', title: 'Sales' })
  })

  it('takes a listing that found nothing at all', () => {
    const nothing: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, text: '', shown: 0, total: 0 } }
    expect(parseReportRequest(report(nothing), MAX_TEXT)?.outcome).toEqual(nothing)
  })

  it('refuses a listing past the bound instead of taking it', () => {
    const outcome = { ...READ, snapshot: { ...READ.snapshot, text: 'x'.repeat(MAX_TEXT + 1) } }
    expect(parseReportRequest(report(outcome), MAX_TEXT)).toBeUndefined()
    expect(parseReportRequest(report({ ...READ, snapshot: { ...READ.snapshot, text: 'x'.repeat(MAX_TEXT) } }), MAX_TEXT))
      .not.toBeUndefined()
  })

  it('keeps the busy names a page supplied, up to the count the envelope allows', () => {
    const busy = Array.from({ length: MAX_BUSY_NAMES }, (_unused, at) => `region ${String(at)}`)
    const outcome: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, busy } }
    expect(parseReportRequest(report(outcome), MAX_TEXT)?.outcome).toEqual(outcome)
  })

  it('refuses a busy list longer than the envelope allows, or one holding something other than names', () => {
    const tooMany = Array.from({ length: MAX_BUSY_NAMES + 1 }, () => 'region')
    for (const busy of [tooMany, 'region', [1], ['x'.repeat(MAX_NAME_CHARS + 1)]]) {
      expect(parseReportRequest(report({ ...READ, snapshot: { ...READ.snapshot, busy } }), MAX_TEXT)).toBeUndefined()
    }
  })

  it('refuses a listing that does not say whether the page had settled', () => {
    const { settled: _dropped, ...without } = READ.snapshot
    expect(parseReportRequest(report({ ...READ, snapshot: without }), MAX_TEXT)).toBeUndefined()
    expect(parseReportRequest(report({ ...READ, snapshot: { ...without, settled: 'yes' } }), MAX_TEXT)).toBeUndefined()
  })

  it('refuses a failure message past its own bound', () => {
    const long = { status: 'error', code: 'frame', message: 'x'.repeat(2001) }
    expect(parseReportRequest(report(long), MAX_TEXT)).toBeUndefined()
    expect(parseReportRequest(report({ ...long, message: 'x'.repeat(2000) }), MAX_TEXT)).not.toBeUndefined()
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
      expect({ body, parsed: parseReportRequest(body, MAX_TEXT) }).toEqual({ body, parsed: undefined })
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
      { ...READ.snapshot, breadcrumb: 7 },
      { ...READ.snapshot, modal: 7 },
      { ...READ.snapshot, cursor: 7 },
    ]) {
      expect({ snapshot, parsed: parseReportRequest(report({ ...READ, snapshot }), MAX_TEXT) })
        .toEqual({ snapshot, parsed: undefined })
    }
  })

  it('refuses a listing report that does not name the page it read', () => {
    for (const page of [null, 'home', {}, { id: 'home' }, { id: '', title: 'Home' }, { id: 'home', title: 7 }]) {
      expect({ page, parsed: parseReportRequest(report({ ...READ, page }), MAX_TEXT) })
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
      expect({ field, parsed: parseReportRequest(body, MAX_TEXT) }).toEqual({ field, parsed: undefined })
    }
    const at = 'n'.repeat(MAX_NAME_CHARS)
    const outcome: ReadOutcome = { ...READ, page: { id: at, title: at } }
    expect(parseReportRequest({ callId: at, tabId: at, outcome }, MAX_TEXT)).not.toBeUndefined()
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
      expect({ outcome, parsed: parseReportRequest(report(outcome), MAX_TEXT) })
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
      ['breadcrumb', { ...READ, snapshot: { ...READ.snapshot, breadcrumb: `Home${CONTROL}` } }],
      ['modal', { ...READ, snapshot: { ...READ.snapshot, modal: `Confirm${LONE_SURROGATE}` } }],
      ['cursor', { ...READ, snapshot: { ...READ.snapshot, cursor: `e1${CONTROL}` } }],
      ['page.title', { ...READ, page: { id: 'home', title: `Home${CONTROL}` } }],
      ['message', { status: 'error', code: 'frame', message: `why${CONTROL}` }],
      ['kind', { status: 'error', code: 'not-a-page', message: 'why', kind: `chart${CONTROL}` }],
      ['outcome.title', { status: 'error', code: 'not-a-page', message: 'why', title: `Sales${LONE_SURROGATE}` }],
    ] as const) {
      expect({ field, parsed: parseReportRequest(report(outcome), MAX_TEXT) }).toEqual({ field, parsed: undefined })
    }
    // Both ids are held to the same rule, on a report and on a claim.
    expect(parseReportRequest({ callId: `call_1${CONTROL}`, tabId: 'tab_1', outcome: READ }, MAX_TEXT)).toBeUndefined()
    expect(parseClaimRequest({ callId: 'call_1', tabId: `tab_1${LONE_SURROGATE}` })).toBeUndefined()
  })

  it('keeps the whitespace a listing is built out of', () => {
    // Tab, newline and carriage return cost two JSON bytes, which the byte
    // bound covers, and the listing itself is lines.
    const outcome: ReadOutcome = { ...READ, snapshot: { ...READ.snapshot, text: '1 main\n  2 button\tGo\r' } }
    expect(parseReportRequest(report(outcome), MAX_TEXT)?.outcome).toEqual(outcome)
  })
})
