/**
 * What one renewal exchange puts on the wire and reads back: the header table
 * the deployment's own client sends, the answer its `tokenRenewal` reads a token
 * out of, the request id, and the timestamp stored beside a renewed token.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  accessTokenTimestamp,
  parseRenewalAnswer,
  renewalHeaders,
  requestIdFrom,
  REQUEST_ID_LENGTH,
} from '../src/client/renewal.ts'

const STORED = 'Bearer a.b.c'

describe('auth-gate renewal headers', () => {
  it('carries the stored token on both header names the deployment sends it under', () => {
    // The stored value verbatim, scheme included: that is what the deployment's
    // own client puts there, and the endpoint reads what that client sends.
    expect(renewalHeaders(STORED, null, 'r1')).toEqual({
      Authorization: STORED,
      CertificationToken: STORED,
      'TINY-REQUEST-ID': 'r1',
    })
  })

  it('carries the headers the login page stored under them', () => {
    expect(renewalHeaders(STORED, JSON.stringify({ tenant: 'acme', 'X-User': 'u-1' }), 'r1')).toEqual({
      tenant: 'acme',
      'X-User': 'u-1',
      Authorization: STORED,
      CertificationToken: STORED,
      'TINY-REQUEST-ID': 'r1',
    })
  })

  it('renders a stored header value that is a number or a boolean, and drops the rest', () => {
    // What axios does with the same table: a number or a boolean goes on the
    // wire as its own rendering, and a null header is no header. A stored object
    // is dropped rather than sent as its own default rendering.
    expect(renewalHeaders(STORED, JSON.stringify({ count: 7, flag: true, gone: null, nested: { a: 1 } }), 'r1')).toEqual({
      count: '7',
      flag: 'true',
      Authorization: STORED,
      CertificationToken: STORED,
      'TINY-REQUEST-ID': 'r1',
    })
  })

  it('lets the token and the request id win over a stored header of the same name', () => {
    const headers = renewalHeaders(STORED, JSON.stringify({ Authorization: 'stale', 'TINY-REQUEST-ID': 'stale' }), 'r1')
    expect({ authorization: headers.Authorization, requestId: headers['TINY-REQUEST-ID'] })
      .toEqual({ authorization: STORED, requestId: 'r1' })
  })

  it('replaces a stored entry of the same name whatever its casing', () => {
    // `fetch` matches a header name case-insensitively and combines two that
    // match, so a stale `authorization` left in place would ride beside the
    // current token on the same header rather than under it.
    expect(renewalHeaders(
      STORED,
      JSON.stringify({ authorization: 'stale', certificationtoken: 'stale', 'tiny-request-id': 'stale' }),
      'r1',
    )).toEqual({
      Authorization: STORED,
      CertificationToken: STORED,
      'TINY-REQUEST-ID': 'r1',
    })
  })

  it('drops a stored entry no header can carry, rather than failing every renewal this tab makes', () => {
    // `fetch` throws on a name or a value like these, and the throw would cost
    // the tab every renewal for as long as it stays open.
    const unusable = { 'bad name': 'x', 'Bad:Name': 'x', '': 'x', 'X-Feed': 'a\nb', 'X-Return': 'a\rb', 'X-Nul': 'a\u0000b' }
    expect(renewalHeaders(STORED, JSON.stringify({ ...unusable, 'X-Kept': 'fine' }), 'r1')).toEqual({
      'X-Kept': 'fine',
      Authorization: STORED,
      CertificationToken: STORED,
      'TINY-REQUEST-ID': 'r1',
    })
  })

  it('sends the request without them rather than not at all when the stored table is unreadable', () => {
    // A durable value another program wrote: absent, not JSON, or JSON that is
    // not an object of headers. The deployment's own client throws on the middle
    // one, which costs it the request; this one still renews.
    for (const stored of [null, 'not json', 'null', '7', '"text"', '[1,2]']) {
      expect(renewalHeaders(STORED, stored, 'r1')).toEqual({
        Authorization: STORED,
        CertificationToken: STORED,
        'TINY-REQUEST-ID': 'r1',
      })
    }
  })
})

describe('auth-gate renewal answer', () => {
  it('reads the token exactly as the answer carried it', () => {
    // Scheme included: what is stored is what the deployment's pages put into
    // their own `Authorization` header.
    expect(parseRenewalAnswer({ token: STORED })).toBe(STORED)
    expect(parseRenewalAnswer({ code: 0, msg: 'success', token: 'a.b.c' })).toBe('a.b.c')
  })

  it('reads nothing out of an answer that carries no string token', () => {
    for (const body of [null, undefined, 7, 'a.b.c', [], {}, { token: null }, { token: 7 }, { code: 2, msg: 'no' }]) {
      expect(parseRenewalAnswer(body)).toBeUndefined()
    }
  })
})

describe('auth-gate renewal request id', () => {
  it('draws one character of the deployment\'s own alphabet per byte', () => {
    expect(requestIdFrom(Uint8Array.from([0, 1, 50, 51]))).toBe('AB9A')
    expect(requestIdFrom(new Uint8Array(REQUEST_ID_LENGTH))).toHaveLength(REQUEST_ID_LENGTH)
  })

  it('draws nothing from no bytes', () => {
    expect(requestIdFrom(new Uint8Array(0))).toBe('')
  })
})

describe('auth-gate stored token time', () => {
  it('writes the instant the token was stored, in the form the deployment parses', () => {
    expect(accessTokenTimestamp(1_800_000_000_000)).toBe('2027-01-15T08:00:00.000Z')
    // The value a deployment page reads back is the same instant it was given.
    expect(Date.parse(accessTokenTimestamp(1_800_000_000_000))).toBe(1_800_000_000_000)
  })
})
