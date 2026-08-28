/**
 * The gate's decision table, as pure functions: what a boot does with the token
 * it found, what a running page does with a token another tab wrote, and the
 * two values the rest of the gate is built on — the login address and the
 * expiry delay.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import {
  decideChange,
  decideGate,
  decodeJwtPayload,
  expiryDelayMs,
  loginHref,
  tokenSubject,
  usableToken,
} from '../src/client/gate.ts'

/** Base64url-encode one JSON value the way a JWT carries a segment. */
function segment(value: unknown): string {
  const utf8 = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))
  return btoa(utf8).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** One JWT-shaped token carrying the given claims; the signature is never read. */
function jwt(claims: Record<string, unknown>): string {
  return `${segment({ alg: 'HS256', typ: 'JWT' })}.${segment(claims)}.c2ln`
}

const NOW = 1_800_000_000_000
/** A token that outlives the clock by an hour. */
const LIVE = jwt({ sub: 'u-1', exp: NOW / 1000 + 3600 })
/** The same person, a token issued later. */
const RENEWED = jwt({ sub: 'u-1', exp: NOW / 1000 + 7200 })
/** Somebody else. */
const OTHER = jwt({ sub: 'u-2', exp: NOW / 1000 + 3600 })
/** Ran out a second ago. */
const STALE = jwt({ sub: 'u-1', exp: NOW / 1000 - 1 })

describe('auth-gate token reading', () => {
  it('reads the claims a real token carries', () => {
    expect(decodeJwtPayload(LIVE)).toEqual({ sub: 'u-1', exp: NOW / 1000 + 3600 })
    expect(tokenSubject(LIVE)).toBe('u-1')
  })

  it('reads a payload whose length needs base64 padding back', () => {
    // A one-character subject makes the payload segment length 4n+2, the case
    // an unpadded decode drops the last byte of.
    const token = jwt({ sub: 'a', exp: NOW / 1000 + 1 })
    expect(tokenSubject(token)).toBe('a')
  })

  it('reads a payload carrying characters outside latin-1', () => {
    expect(tokenSubject(jwt({ sub: '郝然', exp: NOW / 1000 + 1 }))).toBe('郝然')
  })

  it('reads nothing out of a payload that is not an object of claims', () => {
    for (const payload of ['%%%%', segment(['a']), btoa('not json'), btoa('null')]) {
      expect(decodeJwtPayload(`h.${payload}.s`)).toBeUndefined()
    }
  })

  it('reports no subject when the token names none as a string', () => {
    expect(tokenSubject(jwt({ exp: 1 }))).toBeUndefined()
    expect(tokenSubject(jwt({ sub: 7, exp: 1 }))).toBeUndefined()
  })

  it('accepts only a JWT-shaped token that has an expiry still ahead', () => {
    expect(usableToken(LIVE, NOW)).toEqual({ token: LIVE, expSeconds: NOW / 1000 + 3600 })
    for (const stored of [
      null,
      '',
      'not-a-jwt',
      'two.segments',
      jwt({ sub: 'u-1' }),
      jwt({ sub: 'u-1', exp: 'soon' }),
      jwt({ sub: 'u-1', exp: Number.POSITIVE_INFINITY }),
      STALE,
    ]) {
      expect(usableToken(stored, NOW)).toBeUndefined()
    }
  })

  it('treats the expiry instant itself as past', () => {
    expect(usableToken(jwt({ sub: 'u-1', exp: NOW / 1000 }), NOW)).toBeUndefined()
  })
})

describe('auth-gate boot decision', () => {
  it('sends a visitor with no usable token to the login page', () => {
    for (const stored of [null, '', 'not-a-jwt', STALE]) {
      expect(decideGate(stored, undefined, NOW)).toEqual({ kind: 'login' })
    }
  })

  it('mirrors a usable token the cookie does not carry', () => {
    for (const cookie of [undefined, 'stale-cookie', OTHER]) {
      expect(decideGate(LIVE, cookie, NOW)).toEqual({ kind: 'mirror', accepted: { token: LIVE, expSeconds: NOW / 1000 + 3600 } })
    }
  })

  it('runs the page when the cookie already carries exactly this token', () => {
    expect(decideGate(LIVE, LIVE, NOW)).toEqual({ kind: 'ready', accepted: { token: LIVE, expSeconds: NOW / 1000 + 3600 } })
  })

  it('sends a visitor to the login page even when a stale cookie matches the stale token', () => {
    // The cookie is in step and the token is still unusable: agreement is not
    // the same as validity, and only the token decides.
    expect(decideGate(STALE, STALE, NOW)).toEqual({ kind: 'login' })
  })
})

describe('auth-gate change decision', () => {
  it('leaves for the login page when the token is removed or runs out', () => {
    for (const next of [null, '', STALE]) {
      expect(decideChange(next, LIVE, NOW)).toEqual({ kind: 'login' })
    }
  })

  it('reloads the whole page when a different person signed in', () => {
    expect(decideChange(OTHER, LIVE, NOW)).toEqual({ kind: 'reload', accepted: { token: OTHER, expSeconds: NOW / 1000 + 3600 } })
  })

  it('syncs a newer token for the same person without reloading', () => {
    expect(decideChange(RENEWED, LIVE, NOW))
      .toEqual({ kind: 'sync', accepted: { token: RENEWED, expSeconds: NOW / 1000 + 7200 } })
  })

  it('syncs rather than reloads when neither token names a subject', () => {
    // Two anonymous tokens are the same anonymous session, not an account switch.
    const first = jwt({ exp: NOW / 1000 + 60 })
    const second = jwt({ exp: NOW / 1000 + 120 })
    expect(decideChange(second, first, NOW).kind).toBe('sync')
  })
})

describe('auth-gate login address', () => {
  it('appends the return address to a hash-routed login page', () => {
    expect(loginHref('/toy-proxy/toy-login/#/', 'https://harness.example/chat?session=a b'))
      .toBe('/toy-proxy/toy-login/#/?redirect=https%3A%2F%2Fharness.example%2Fchat%3Fsession%3Da%20b')
  })
})

describe('auth-gate expiry schedule', () => {
  it('waits until the margin before expiry', () => {
    expect(expiryDelayMs(NOW / 1000 + 3600, 300, NOW)).toBe(3_300_000)
  })

  it('acts now when the margin is already inside the token\'s remaining life', () => {
    expect(expiryDelayMs(NOW / 1000 + 60, 300, NOW)).toBe(0)
  })

  it('acts at the expiry instant when the deployment set no margin', () => {
    expect(expiryDelayMs(NOW / 1000 + 60, 0, NOW)).toBe(60_000)
  })
})
