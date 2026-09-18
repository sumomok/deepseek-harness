/**
 * Who has agreed to open which data page from the sidebar, and the one-time
 * values that carry an agreement back.
 *
 * A view that places `toy.crud` opens the deployment's own full page for a
 * table with the visitor's own credential, so a click on it is a question
 * before it is a draw. Asking it on every click of the same row would be a
 * question a person answers a dozen times an afternoon and stops reading;
 * never asking it again would be a grant nobody ever gave.
 *
 * What is remembered is therefore one answer per signed-in person, per view,
 * per table, and only in this process. Nothing here holds a token: a person is
 * named by `ctx.loginIdentity`'s digest, and a composition with no login to
 * name one remembers nothing at all.
 *
 * The agreement itself is a nonce rather than a flag on the line, because the
 * line is a command line: anything a first click could have written, a second
 * click could have written too. A nonce exists only because this row minted it
 * in answer to a card it drew, it is bound to the person it was drawn for, it
 * is spent the first time it is redeemed, and it dies on its own.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/view-consent
 */

import { randomBytes } from 'node:crypto'
import { consentNonce, type ConsentNonce } from './consent-question.ts'

/** How long one answer to the data-page question stands. */
export type CrudViewConsent =
  /** Until the visitor signs out, the token changes, or the process restarts. */
  | 'per-login'
  /** Not at all: every click is asked about again. */
  | 'every-time'

/** Every {@link CrudViewConsent}, for the config schema and its refusals. */
export const CRUD_VIEW_CONSENTS: readonly CrudViewConsent[] = ['per-login', 'every-time']

/**
 * Name one signed-in person for the tables below.
 *
 * Prefixed, because the other namable thing is a session and both are opaque
 * strings: an unprefixed digest and an unprefixed session id share one table
 * and could in principle meet.
 * @param digest - what `ctx.loginIdentity.current()` answered.
 * @returns the name to bind an agreement to.
 */
export function loginBinding(digest: string): string {
  return `login:${digest}`
}

/**
 * Name one session, for a composition with no login to bind to.
 *
 * A deployment with no `auth-gate` row has no signed-in person, so an
 * agreement is bound to the conversation it was given in and is never
 * remembered past the click that carried it.
 * @param sessionId - the session the click was made in.
 * @returns the name to bind an agreement to.
 */
export function sessionBinding(sessionId: string): string {
  return `session:${sessionId}`
}

/**
 * Which page one remembered answer is about: the view that was clicked, and
 * the table that view opens.
 *
 * The table is part of it because a view the deployment edits to open a
 * different table is a different question — the card names the table, and an
 * answer to the old one is not an answer to the new one.
 * @param viewId - the view that was clicked.
 * @param meta - the table its data page opens, by its name in the backend.
 * @returns the key one person's answers are held under.
 */
function pageKey(viewId: string, meta: string): string {
  // A separator no part can contain: a view id is written in the entry-id
  // alphabet and a table name is a backend identifier.
  return `${viewId}\u0000${meta}`
}

/**
 * The answers this process has been given, for as long as it runs.
 *
 * In memory and nowhere else. A restart asks again, which is the correct answer
 * for a grant nobody recorded, and a deployment that wants the question every
 * time sets `crudViewConsent: 'every-time'` rather than relying on how long a
 * process happens to live.
 *
 * One person's answers at a time. A process serves one visitor, so a digest
 * that is not the one this table was last asked about is a different person at
 * the same seat — a renewal, a second sign-in, a sign-out and back — and what
 * the person before them agreed to is dropped rather than kept against a name
 * nothing will ask for again.
 */
export class ViewConsentMemory {
  /** The pages the current person has agreed to, by {@link pageKey}. */
  private granted = new Set<string>()

  /** The person {@link granted} belongs to, or `undefined` before the first question. */
  private held: string | undefined

  /** How long an answer stands, as the deployment configured it. */
  private readonly mode: CrudViewConsent

  /**
   * Open an empty memory.
   * @param mode - how long an answer stands.
   */
  constructor(mode: CrudViewConsent) {
    this.mode = mode
  }

  /**
   * Whether this person has already agreed to this view's page.
   * @param binding - the person, from {@link loginBinding}.
   * @param viewId - the view that was clicked.
   * @param meta - the table its data page opens.
   * @returns true only where the deployment remembers answers and this one was given.
   */
  holds(binding: string, viewId: string, meta: string): boolean {
    if (this.mode !== 'per-login') return false
    this.rebind(binding)
    return this.granted.has(pageKey(viewId, meta))
  }

  /**
   * Remember one answer.
   * @param binding - the person, from {@link loginBinding}.
   * @param viewId - the view that was clicked.
   * @param meta - the table its data page opens.
   */
  remember(binding: string, viewId: string, meta: string): void {
    if (this.mode !== 'per-login') return
    this.rebind(binding)
    this.granted.add(pageKey(viewId, meta))
  }

  /**
   * Point the table at one person, dropping the previous one's answers.
   * @param binding - the person this question is about.
   */
  private rebind(binding: string): void {
    if (this.held === binding) return
    this.held = binding
    this.granted = new Set()
  }
}

/** One minted agreement: who it was drawn for, what it opens, and when it dies. */
interface ConsentTicket {
  /** The person, from {@link loginBinding} or {@link sessionBinding}. */
  readonly binding: string
  /** The view the card was drawn for. */
  readonly viewId: string
  /** The table that view's page opens. */
  readonly meta: string
  /** Epoch milliseconds from which this agreement is no longer redeemable. */
  readonly expiresAt: number
}

/**
 * The agreements this row has drawn a card for and not yet seen come back.
 *
 * Bounded three ways, none of which needs anybody to remember to clean up:
 * every ticket carries its own death, every read sweeps the dead ones, and a
 * redeemed ticket is removed as it is read. What remains is one entry per card
 * a person has been shown and not answered within the deadline.
 */
export class ConsentTickets {
  /** Every live ticket, by the value that redeems it. */
  private readonly tickets = new Map<string, ConsentTicket>()

  /** How long a drawn card stays answerable, in milliseconds. */
  private readonly ttlMs: number

  /**
   * Open an empty table.
   * @param ttlMs - how long a drawn card stays answerable.
   */
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs
  }

  /**
   * Mint the agreement one drawn card carries.
   * @param binding - the person the card is drawn for.
   * @param viewId - the view that was clicked.
   * @param meta - the table its data page opens.
   * @returns the value the agreeing click carries back.
   */
  mint(binding: string, viewId: string, meta: string): ConsentNonce {
    this.sweep()
    // 128 bits from the platform's own source: the value is the whole
    // authority to open one page, so it has to be one nobody can arrive at
    // except by being shown the card it was minted for.
    const nonce = randomBytes(16).toString('hex')
    this.tickets.set(nonce, { binding, viewId, meta, expiresAt: Date.now() + this.ttlMs })
    return consentNonce(nonce)
  }

  /**
   * Spend one agreement, if it is this person's and it is about this page.
   *
   * Every way it can fail is one answer — there is no such ticket, it died, it
   * was already spent, it was drawn for somebody else, it was drawn for
   * another view or another table — because all of them end in the same place:
   * the card is drawn again, with an agreement that is good.
   * @param nonce - the value the click carried back.
   * @param binding - the person who clicked.
   * @param viewId - the view they clicked.
   * @param meta - the table its data page opens.
   * @returns whether the page may be drawn.
   */
  redeem(nonce: ConsentNonce, binding: string, viewId: string, meta: string): boolean {
    this.sweep()
    const ticket = this.tickets.get(nonce)
    if (ticket === undefined) return false
    // Spent whether or not it matches: a value offered once and refused is a
    // value somebody is guessing with, and a second guess starts from nothing.
    this.tickets.delete(nonce)
    return ticket.binding === binding && ticket.viewId === viewId && ticket.meta === meta
  }

  /** Drop every ticket whose deadline has passed. */
  private sweep(): void {
    const now = Date.now()
    for (const [nonce, ticket] of this.tickets) {
      if (now >= ticket.expiresAt) this.tickets.delete(nonce)
    }
  }
}
