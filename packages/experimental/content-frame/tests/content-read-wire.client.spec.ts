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
import { parseClaimRequest, parseReportRequest, type ReadOutcome } from '../src/access/wire.ts'

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
  },
}

/** Wrap one outcome as a whole report body. */
function report(outcome: unknown): unknown {
  return { callId: 'call_1', tabId: 'tab_1', outcome }
}

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
    ]) {
      expect({ body, parsed: parseClaimRequest(body) }).toEqual({ body, parsed: undefined })
    }
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
      .toEqual(['kind', 'shown', 'signIn', 'text', 'title', 'total', 'truncated', 'url'])
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
})
