/**
 * The two tables behind the data-page question: what this process remembers of
 * an answer, and the one-time values a drawn card carries.
 *
 * What these cases pin is what only the tables decide — that an answer belongs
 * to one person and one table, that a value is spent the first time it is
 * offered, and that neither table keeps anything nobody will ask for again. The
 * flow they serve is pinned in the real composition beside them.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { consentNonce } from '../src/consent-question.ts'
import { ConsentTickets, loginBinding, sessionBinding, ViewConsentMemory } from '../src/view-consent.ts'

/** Two people at the same seat, one after the other. */
const ONE = loginBinding('a'.repeat(64))
const TWO = loginBinding('b'.repeat(64))

describe('what this process remembers of an answer', () => {
  it('holds one person\'s answer to one view\'s table', () => {
    const memory = new ViewConsentMemory('per-login')
    expect(memory.holds(ONE, 'layers', 'SpaceLayer')).toBe(false)
    memory.remember(ONE, 'layers', 'SpaceLayer')
    expect(memory.holds(ONE, 'layers', 'SpaceLayer')).toBe(true)
  })

  it('does not carry it to another view, or to the same view opening another table', () => {
    // The card names the table, so an answer to the old one is not an answer to
    // a view the deployment has since pointed somewhere else.
    const memory = new ViewConsentMemory('per-login')
    memory.remember(ONE, 'layers', 'SpaceLayer')
    expect(memory.holds(ONE, 'alerts', 'SpaceLayer')).toBe(false)
    expect(memory.holds(ONE, 'layers', 'SpaceSite')).toBe(false)
  })

  it('drops the previous person\'s answers when a different one is first seen', () => {
    const memory = new ViewConsentMemory('per-login')
    memory.remember(ONE, 'layers', 'SpaceLayer')
    expect(memory.holds(TWO, 'layers', 'SpaceLayer')).toBe(false)
    // And the person before them is gone rather than kept against a name
    // nothing will ask for again: a renewal or a second sign-in asks afresh.
    expect(memory.holds(ONE, 'layers', 'SpaceLayer')).toBe(false)
  })

  it('remembers nothing at all where the deployment asks every time', () => {
    const memory = new ViewConsentMemory('every-time')
    memory.remember(ONE, 'layers', 'SpaceLayer')
    expect(memory.holds(ONE, 'layers', 'SpaceLayer')).toBe(false)
  })
})

describe('the values a drawn card carries', () => {
  it('redeems once, for the person and the page it was drawn for', () => {
    const tickets = new ConsentTickets(120_000)
    const nonce = tickets.mint(ONE, 'layers', 'SpaceLayer')
    expect(tickets.redeem(nonce, ONE, 'layers', 'SpaceLayer')).toBe(true)
    // Spent: a value offered twice is a value somebody kept.
    expect(tickets.redeem(nonce, ONE, 'layers', 'SpaceLayer')).toBe(false)
  })

  it('mints a different value for every card', () => {
    const tickets = new ConsentTickets(120_000)
    const first = tickets.mint(ONE, 'layers', 'SpaceLayer')
    expect(tickets.mint(ONE, 'layers', 'SpaceLayer')).not.toBe(first)
  })

  it('refuses one drawn for another person, another view, or another table — and spends it either way', () => {
    const tickets = new ConsentTickets(120_000)
    const forOne = tickets.mint(ONE, 'layers', 'SpaceLayer')
    expect(tickets.redeem(forOne, TWO, 'layers', 'SpaceLayer')).toBe(false)
    // A value offered once and refused is a value somebody is guessing with, so
    // the second guess starts from nothing.
    expect(tickets.redeem(forOne, ONE, 'layers', 'SpaceLayer')).toBe(false)

    const tickets2 = new ConsentTickets(120_000)
    expect(tickets2.redeem(tickets2.mint(ONE, 'layers', 'SpaceLayer'), ONE, 'alerts', 'SpaceLayer')).toBe(false)
    const tickets3 = new ConsentTickets(120_000)
    expect(tickets3.redeem(tickets3.mint(ONE, 'layers', 'SpaceLayer'), ONE, 'layers', 'SpaceSite')).toBe(false)
  })

  it('refuses one nobody minted', () => {
    const tickets = new ConsentTickets(120_000)
    expect(tickets.redeem(consentNonce('0'.repeat(32)), ONE, 'layers', 'SpaceLayer')).toBe(false)
  })

  it('refuses one whose deadline has passed, and does not keep it', () => {
    // A deadline of nothing is a card dead as it is drawn, which is what makes
    // the expiry observable without waiting for one.
    const tickets = new ConsentTickets(0)
    const nonce = tickets.mint(ONE, 'layers', 'SpaceLayer')
    expect(tickets.redeem(nonce, ONE, 'layers', 'SpaceLayer')).toBe(false)
    // Swept rather than left behind: a card nobody answered dies on its own, so
    // a process serving one person all day holds one entry per unanswered card
    // and no more.
    expect(tickets.redeem(nonce, ONE, 'layers', 'SpaceLayer')).toBe(false)
  })

  it('binds a session where there is no person to bind to', () => {
    const tickets = new ConsentTickets(120_000)
    const first = sessionBinding('session-1')
    const nonce = tickets.mint(first, 'layers', 'SpaceLayer')
    expect(tickets.redeem(nonce, sessionBinding('session-2'), 'layers', 'SpaceLayer')).toBe(false)
  })
})
