/**
 * Unit coverage for the per-member store, the reader it lends, the resolver
 * over it, and the claim a posted token is compared on. The served routes and
 * the lending through a real `consoleMembers` row are covered by
 * `per-member.client.spec.ts`; these cases pin what those routes rely on.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { BizSubject, PrincipalKey } from '@deepseek-ai/dsh-experimental-biz-backend'
import { holdMemberCredentials, memberSlotResolver, tokenClaim } from '../src/members.ts'
import type { ConsoleMemberDirectory } from '../src/member-directory.ts'

/** The subject a tool call's reads name. */
type SessionSubject = Extract<BizSubject, { kind: 'session' }>

const MEMBER_A = brandString<PrincipalKey>('1234567890123456789')
const MEMBER_B = brandString<PrincipalKey>('member-b')
const TOKEN_A = 'aGVhZGVy.YQ.c2ln'
const TOKEN_A2 = 'aGVhZGVy.YTI.c2ln'
const TOKEN_B = 'aGVhZGVy.Yg.c2ln'

/**
 * A JWT-shaped token whose payload is the given JSON text, written by hand so
 * a number in it keeps every digit it was written with.
 * @param payload - the payload's JSON text.
 * @returns the token.
 */
function jwt(payload: string): string {
  return `aGVhZGVy.${Buffer.from(payload, 'utf8').toString('base64url')}.c2ln`
}

/** A sessionId as a read names it. */
function session(id: string): SessionSubject {
  return { kind: 'session', sessionId: brandString<SessionSubject['sessionId']>(id) }
}

describe('per-member store', () => {
  it('keeps each member\'s token in that member\'s slot only', () => {
    const store = holdMemberCredentials(() => {})
    store.slotOf(MEMBER_A).set(TOKEN_A)
    store.slotOf(MEMBER_B).set(TOKEN_B)
    expect([store.slotOf(MEMBER_A).read(), store.slotOf(MEMBER_B).read()]).toEqual([TOKEN_A, TOKEN_B])
    store.slotOf(MEMBER_B).drop('refused-by-backend')
    expect([store.slotOf(MEMBER_A).read(), store.slotOf(MEMBER_B).read()]).toEqual([TOKEN_A, undefined])
    store.slotOf(MEMBER_A).drop('sign-out')
    expect(store.slotOf(MEMBER_A).read()).toBeUndefined()
  })

  it('publishes a change only when the store changes', () => {
    const store = holdMemberCredentials(() => {})
    const { reader } = store.lend()
    const seen: string[] = []
    reader.onChange((principal, kind) => { seen.push(`${principal}:${kind}`) })
    const slot = store.slotOf(MEMBER_A)
    slot.set(TOKEN_A)
    // The token already held: nothing changed, so nothing is published.
    slot.set(TOKEN_A)
    slot.set(TOKEN_A2)
    slot.drop('sign-out')
    // A member holding none: nothing to drop.
    slot.drop('sign-out')
    store.slotOf(MEMBER_B).drop('refused-by-backend')
    expect(seen).toEqual([`${MEMBER_A}:set`, `${MEMBER_A}:set`, `${MEMBER_A}:dropped`])
  })

  it('keeps a change and tells the remaining subscribers when one subscriber throws', () => {
    const reported: string[] = []
    const store = holdMemberCredentials((line) => { reported.push(line) })
    const { reader } = store.lend()
    const seen: string[] = []
    reader.onChange((principal) => { throw new Error(`subscriber saw ${principal}`) })
    reader.onChange((principal, kind) => { seen.push(`${principal}:${kind}`) })
    store.slotOf(MEMBER_A).set(TOKEN_A)
    expect(store.slotOf(MEMBER_A).read()).toBe(TOKEN_A)
    expect(seen).toEqual([`${MEMBER_A}:set`])
    expect(reported).toEqual(['a customer credential subscriber threw; the change it was told about is kept'])
    // The report is a fixed line: neither the member, the token, nor the
    // subscriber's own text (which quoted the member) reaches it.
    expect(reported.join('\n')).not.toContain(MEMBER_A)
    expect(reported.join('\n')).not.toContain(TOKEN_A)
  })

  it('tells every subscriber even when one ends its own subscription while being told', () => {
    const store = holdMemberCredentials(() => {})
    const { reader } = store.lend()
    const seen: string[] = []
    const stop = reader.onChange(() => {
      seen.push('first')
      stop()
    })
    reader.onChange(() => { seen.push('second') })
    store.slotOf(MEMBER_A).set(TOKEN_A)
    store.slotOf(MEMBER_A).set(TOKEN_A2)
    expect(seen).toEqual(['first', 'second', 'second'])
  })

  it('holds one subscription per call, each ended by its own disposer', () => {
    const store = holdMemberCredentials(() => {})
    const { reader } = store.lend()
    let calls = 0
    const listener = (): void => { calls += 1 }
    const first = reader.onChange(listener)
    reader.onChange(listener)
    store.slotOf(MEMBER_A).set(TOKEN_A)
    expect(calls).toBe(2)
    first()
    store.slotOf(MEMBER_A).set(TOKEN_A2)
    expect(calls).toBe(3)
  })
})

describe('lent reader', () => {
  it('reads one member\'s token at a time', () => {
    const store = holdMemberCredentials(() => {})
    const { reader } = store.lend()
    store.slotOf(MEMBER_A).set(TOKEN_A)
    expect([reader.read(MEMBER_A), reader.read(MEMBER_B)]).toEqual([TOKEN_A, undefined])
    // The reader names reading and subscribing, and nothing that lists members.
    expect(Object.keys(reader).sort()).toEqual(['onChange', 'read'])
  })

  it('reads nothing and tells nobody once revoked, while the store keeps every token', () => {
    const store = holdMemberCredentials(() => {})
    const lent = store.lend()
    const other = store.lend()
    const seen: string[] = []
    lent.reader.onChange((_principal, kind) => { seen.push(kind) })
    store.slotOf(MEMBER_A).set(TOKEN_A)
    lent.revoke()
    store.slotOf(MEMBER_A).set(TOKEN_A2)
    const late = lent.reader.onChange((_principal, kind) => { seen.push(`late:${kind}`) })
    store.slotOf(MEMBER_A).drop('sign-out')
    late()
    expect(seen).toEqual(['set'])
    store.slotOf(MEMBER_B).set(TOKEN_B)
    expect(lent.reader.read(MEMBER_B)).toBeUndefined()
    // A revoked reader says nothing about another taker's.
    expect(other.reader.read(MEMBER_B)).toBe(TOKEN_B)
  })
})

describe('per-member resolver', () => {
  /**
   * A context carrying a directory that places sessions from a table.
   * @param sessions - session id to member.
   * @returns the context, and the requests the directory was asked about.
   */
  function withDirectory(sessions: Record<string, PrincipalKey>): { ctx: Context; asked: IncomingMessage[] } {
    const asked: IncomingMessage[] = []
    const directory: ConsoleMemberDirectory = {
      principalOfRequest: (req) => {
        asked.push(req)
        return MEMBER_B
      },
      principalOfSession: id => Object.hasOwn(sessions, id) ? sessions[id] : undefined,
      attachCustomerCredentials: () => () => {},
    }
    const ctx = new Context()
    ctx.provide('consoleMembers', directory)
    return { ctx, asked }
  }

  it('resolves a principal subject to that member\'s slot and a session to its owner\'s', () => {
    const store = holdMemberCredentials(() => {})
    store.slotOf(MEMBER_A).set(TOKEN_A)
    store.slotOf(MEMBER_B).set(TOKEN_B)
    const resolver = memberSlotResolver(withDirectory({ 'session-a': MEMBER_A }).ctx, store)
    expect(resolver.resolve({ kind: 'principal', principal: MEMBER_B })?.read()).toBe(TOKEN_B)
    expect(resolver.resolve(session('session-a'))?.read()).toBe(TOKEN_A)
    // A session the directory places with nobody resolves to no slot at all —
    // not to another member's, and not to an empty one a refusal could drop.
    expect(resolver.resolve(session('session-nobody'))).toBeUndefined()
  })

  it('drops only the resolved member\'s token through the slot it hands out', () => {
    const store = holdMemberCredentials(() => {})
    store.slotOf(MEMBER_A).set(TOKEN_A)
    store.slotOf(MEMBER_B).set(TOKEN_B)
    const resolver = memberSlotResolver(withDirectory({ 'session-b': MEMBER_B }).ctx, store)
    resolver.resolve(session('session-b'))?.drop('refused-by-backend')
    expect([store.slotOf(MEMBER_A).read(), store.slotOf(MEMBER_B).read()]).toEqual([TOKEN_A, undefined])
  })

  it('places a request by asking the directory and nothing else', () => {
    const { ctx, asked } = withDirectory({})
    const req = new IncomingMessage(new Socket())
    expect(memberSlotResolver(ctx, holdMemberCredentials(() => {})).principalOfRequest(req)).toBe(MEMBER_B)
    expect(asked).toEqual([req])
  })

  it('resolves nothing and places nobody while no directory is running', () => {
    const store = holdMemberCredentials(() => {})
    store.slotOf(MEMBER_A).set(TOKEN_A)
    const resolver = memberSlotResolver(new Context(), store)
    expect(resolver.resolve({ kind: 'principal', principal: MEMBER_A })).toBeUndefined()
    expect(resolver.resolve(session('session-a'))).toBeUndefined()
    expect(resolver.principalOfRequest(new IncomingMessage(new Socket()))).toBeUndefined()
  })
})

describe('token claim', () => {
  it('reads a 19-digit numeric claim by the digits it was written with', () => {
    // 1234567890123456789 is past 2^53: as a double it reads 1234567890123456800.
    expect(tokenClaim(jwt('{"login_uid":1234567890123456789}'), 'login_uid')).toBe('1234567890123456789')
    expect(tokenClaim(jwt('{"login_uid":1234567890123456800}'), 'login_uid')).toBe('1234567890123456800')
    expect(tokenClaim(jwt('{"n":1e3}'), 'n')).toBe('1e3')
  })

  it('reads a string claim as it stands, and an empty one as no claim', () => {
    expect(tokenClaim(jwt('{"login_uid":"1234567890123456789"}'), 'login_uid')).toBe('1234567890123456789')
    expect(tokenClaim(jwt('{"login_uid":""}'), 'login_uid')).toBeUndefined()
  })

  it('reads no claim out of anything else', () => {
    for (const payload of [
      '{}',
      '{"login_uid":true}',
      '{"login_uid":null}',
      '{"login_uid":{"id":"a"}}',
      '{"login_uid":["a"]}',
      '["login_uid"]',
      'null',
      '"login_uid"',
      'not json',
    ]) {
      expect({ payload, claim: tokenClaim(jwt(payload), 'login_uid') }).toEqual({ payload, claim: undefined })
    }
    // Inherited names are not claims the token carries, a string-valued one
    // included: a non-enumerable string on the prototype every parsed payload
    // inherits from, removed again before anything else runs.
    const inherited = 'auth_gate_inherited_claim'
    Object.defineProperty(Object.prototype, inherited, { value: 'member-x', configurable: true })
    try {
      expect(tokenClaim(jwt('{}'), inherited)).toBeUndefined()
    } finally {
      Reflect.deleteProperty(Object.prototype, inherited)
    }
    expect(tokenClaim('no-dots-at-all', 'login_uid')).toBeUndefined()
  })
})
