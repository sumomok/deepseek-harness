/** Member assertion verification: the accepted form, every refusal, the expiry boundary, and the deployment proxy's signer. */
import { generateKeyPairSync } from 'node:crypto'
import { ASSERTION_LIFETIME_SECONDS, MEMBER_HEADER, signAssertion } from '@deepseek-ai/dsh-experimental-server-base/deploy/proxy'
import { describe, expect, it } from 'vitest'
import { verifyAssertion, type AssertionCheck } from '../src/assertion.ts'
import { DEPLOYMENT_ID, assertionFor, signPayload, signer } from './fixture.ts'

const ALICE = 'login-uid-alice-5501'
const NOW = 1_900_000_000
const EXP = NOW + 120

const check: AssertionCheck = { header: 'x-dsh-member', key: signer.publicKey, deploymentId: DEPLOYMENT_ID }

/** Verify one value under the default header name in a plain header record. */
function verifyValue(value: string | readonly string[] | undefined, now = NOW): ReturnType<typeof verifyAssertion> {
  return verifyAssertion(value === undefined ? {} : { 'x-dsh-member': value }, check, now)
}

/** Sign a payload given as fields. */
function signFields(fields: Record<string, unknown>): string {
  return signPayload(JSON.stringify(fields))
}

describe('verifyAssertion', () => {
  it('accepts a signed assertion and answers its p as the principal key', () => {
    expect(verifyValue(assertionFor(ALICE, EXP))).toEqual({ principal: ALICE })
  })

  it('reads the header from a Headers object as well as from a header record', () => {
    expect(verifyAssertion(new Headers({ 'X-Dsh-Member': assertionFor(ALICE, EXP) }), check, NOW)).toEqual({ principal: ALICE })
    expect(verifyAssertion(new Headers(), check, NOW)).toEqual({ refusal: 'missing' })
  })

  it('reads a header record by the lower-case name only', () => {
    expect(verifyAssertion({ 'X-Dsh-Member': assertionFor(ALICE, EXP) }, check, NOW)).toEqual({ refusal: 'missing' })
  })

  it('reads the configured header name', () => {
    const custom = { ...check, header: 'x-console-member' }
    expect(verifyAssertion({ 'x-console-member': assertionFor(ALICE, EXP) }, custom, NOW)).toEqual({ principal: ALICE })
    expect(verifyAssertion({ 'x-dsh-member': assertionFor(ALICE, EXP) }, custom, NOW)).toEqual({ refusal: 'missing' })
    expect(verifyAssertion(new Headers({ 'X-Console-Member': assertionFor(ALICE, EXP) }), custom, NOW)).toEqual({ principal: ALICE })
    expect(verifyAssertion(new Headers({ 'X-Dsh-Member': assertionFor(ALICE, EXP) }), custom, NOW)).toEqual({ refusal: 'missing' })
  })

  it('accepts the second before exp and refuses exp itself and every later second', () => {
    const assertion = assertionFor(ALICE, EXP)
    expect(verifyValue(assertion, EXP - 1)).toEqual({ principal: ALICE })
    expect(verifyValue(assertion, EXP)).toEqual({ refusal: 'expired' })
    expect(verifyValue(assertion, EXP + 1)).toEqual({ refusal: 'expired' })
  })

  it('sets no upper bound on exp', () => {
    expect(verifyValue(assertionFor(ALICE, NOW + 10 * 365 * 24 * 3600))).toEqual({ principal: ALICE })
  })

  it.each([
    ['no header', undefined, 'missing'],
    ['a list of values', [assertionFor(ALICE, EXP)], 'repeated'],
    ['two values Node joined with a comma', `${assertionFor(ALICE, EXP)}, ${assertionFor('login-uid-bob-7702', EXP)}`, 'malformed'],
    ['another version', assertionFor(ALICE, EXP).replace(/^v1\./, 'v2.'), 'malformed'],
    ['a padded signature', `${assertionFor(ALICE, EXP)}=`, 'malformed'],
    ['a standard base64 character', `${assertionFor(ALICE, EXP).slice(0, -1)}+`, 'malformed'],
    ['a fourth part', `${assertionFor(ALICE, EXP)}.AAAA`, 'malformed'],
    ['an empty signature', assertionFor(ALICE, EXP).replace(/\.[^.]+$/, '.'), 'malformed'],
    ['surrounding whitespace', ` ${assertionFor(ALICE, EXP)}`, 'malformed'],
    ['an empty value', '', 'malformed'],
  ] as const)('refuses %s', (_name, value, refusal) => {
    expect(verifyValue(value)).toEqual({ refusal })
  })

  it('refuses a signature by another key', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(verifyValue(signPayload(JSON.stringify({ p: ALICE, aud: DEPLOYMENT_ID, exp: EXP }), other))).toEqual({ refusal: 'signature' })
  })

  it('refuses a payload swapped under another assertion\'s signature', () => {
    const [version, , signature] = assertionFor(ALICE, EXP).split('.')
    const [, payload] = assertionFor('login-uid-bob-7702', EXP).split('.')
    expect(verifyValue(`${version}.${payload}.${signature}`)).toEqual({ refusal: 'signature' })
  })

  it('checks the signature before the payload', () => {
    const other = generateKeyPairSync('ed25519').privateKey
    expect(verifyValue(signPayload('not json', other))).toEqual({ refusal: 'signature' })
  })

  it('refuses a signature of the wrong length', () => {
    const [version, payload] = assertionFor(ALICE, EXP).split('.')
    expect(verifyValue(`${version}.${payload}.AAAA`)).toEqual({ refusal: 'signature' })
  })

  it.each([
    ['text that is not JSON', 'not json'],
    ['a JSON array', JSON.stringify([ALICE, DEPLOYMENT_ID, EXP])],
    ['JSON null', 'null'],
    ['a JSON string', JSON.stringify(ALICE)],
  ])('refuses a signed payload that is %s', (_name, payload) => {
    expect(verifyValue(signPayload(payload))).toEqual({ refusal: 'payload' })
  })

  it.each([
    ['one more field', { p: ALICE, aud: DEPLOYMENT_ID, exp: EXP, iat: NOW }],
    ['no p', { aud: DEPLOYMENT_ID, exp: EXP }],
    ['no aud', { p: ALICE, exp: EXP, x: 1 }],
    ['no exp', { p: ALICE, aud: DEPLOYMENT_ID }],
    ['an empty p', { p: '', aud: DEPLOYMENT_ID, exp: EXP }],
    ['a numeric p', { p: 5501, aud: DEPLOYMENT_ID, exp: EXP }],
    ['a string exp', { p: ALICE, aud: DEPLOYMENT_ID, exp: String(EXP) }],
    ['a fractional exp', { p: ALICE, aud: DEPLOYMENT_ID, exp: EXP + 0.5 }],
    ['a __proto__ field', JSON.parse(`{"p":"${ALICE}","aud":"${DEPLOYMENT_ID}","exp":${String(EXP)},"__proto__":{}}`) as Record<string, unknown>],
  ])('refuses a payload with %s', (_name, fields) => {
    expect(verifyValue(signFields(fields))).toEqual({ refusal: 'payload' })
  })

  it('refuses a payload whose __proto__ replaces one of the three fields', () => {
    expect(verifyValue(signPayload(`{"p":"${ALICE}","exp":${String(EXP)},"__proto__":"${DEPLOYMENT_ID}"}`))).toEqual({ refusal: 'payload' })
  })

  it('refuses another deployment\'s assertion', () => {
    expect(verifyValue(signFields({ p: ALICE, aud: 'deployment-other', exp: EXP }))).toEqual({ refusal: 'audience' })
  })

  it('refuses an aud that differs from the deployment id only in letter case', () => {
    expect(verifyValue(signFields({ p: ALICE, aud: DEPLOYMENT_ID.toUpperCase(), exp: EXP }))).toEqual({ refusal: 'audience' })
  })

  it('answers no refusal that carries any part of the header value', () => {
    const values = [
      undefined,
      [assertionFor(ALICE, EXP)],
      `x${assertionFor(ALICE, EXP)}`,
      signFields({ p: ALICE, aud: DEPLOYMENT_ID, exp: EXP, extra: ALICE }),
      signFields({ p: ALICE, aud: 'deployment-other', exp: EXP }),
      assertionFor(ALICE, NOW),
    ]
    for (const value of values) {
      const verdict = verifyValue(value)
      expect(verdict).toHaveProperty('refusal')
      expect(JSON.stringify(verdict)).toMatch(/^\{"refusal":"[a-z]+"\}$/)
    }
  })
})

describe('the deployment proxy\'s signer', () => {
  const issued = NOW

  it('signs under the header name this row reads by default', () => {
    expect(MEMBER_HEADER).toBe('x-dsh-member')
    const verdict = verifyAssertion({ [MEMBER_HEADER]: signAssertion(ALICE, DEPLOYMENT_ID, signer.privateKey, issued) }, check, issued)
    expect(verdict).toEqual({ principal: ALICE })
  })

  it('produces assertions this row accepts until ASSERTION_LIFETIME_SECONDS after signing', () => {
    const assertion = signAssertion(ALICE, DEPLOYMENT_ID, signer.privateKey, issued)
    expect(verifyValue(assertion, issued + ASSERTION_LIFETIME_SECONDS - 1)).toEqual({ principal: ALICE })
    expect(verifyValue(assertion, issued + ASSERTION_LIFETIME_SECONDS)).toEqual({ refusal: 'expired' })
  })

  it('produces assertions another deployment refuses', () => {
    expect(verifyValue(signAssertion(ALICE, 'deployment-other', signer.privateKey, issued))).toEqual({ refusal: 'audience' })
  })

  it('produces assertions whose payload cannot be altered', () => {
    const [version, , signature] = signAssertion(ALICE, DEPLOYMENT_ID, signer.privateKey, issued).split('.')
    const altered = Buffer.from(JSON.stringify({ p: 'login-uid-bob-7702', aud: DEPLOYMENT_ID, exp: issued + ASSERTION_LIFETIME_SECONDS })).toString('base64url')
    expect(verifyValue(`${version}.${altered}.${signature}`)).toEqual({ refusal: 'signature' })
  })
})
