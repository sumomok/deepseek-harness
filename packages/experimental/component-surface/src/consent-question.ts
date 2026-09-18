/**
 * The question a click on a data-page view is answered with, and the line the
 * answer comes back on.
 *
 * A view that places `toy.crud` opens the deployment's own full page for one
 * table with the visitor's own credential, so a click on it is a question
 * before it is a draw. The person who clicked is the person being asked and no
 * tool call is pending, so the question is put where the click's own answer is
 * already drawn — the command's chat row — rather than through the agent's
 * approval card, which exists to interrupt a model mid-turn and cannot be
 * raised between turns at all.
 *
 * Both halves read this module. The host builds the question and mints the
 * one-time value that redeems it; the browser row draws the card, and the
 * button that agrees runs the same command again with that value on the line.
 * Neither half parses what the other wrote by hand, and the command's own
 * recorded input stays a line a person could have typed.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/consent-question
 */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'

/**
 * One agreement to open one data page, redeemable once.
 *
 * Opaque outside the row that minted it: the browser carries it back without
 * reading it, and what it stands for is held in the host's own table.
 */
export type ConsentNonce = Branded<'ConsentNonce'>

/**
 * Read a value as a nonce.
 * @param value - the value, as the host minted it or the line carried it.
 * @returns the same string, branded.
 */
export function consentNonce(value: string): ConsentNonce {
  return brandString<ConsentNonce>(value)
}

/** Characters a nonce is written in, which is what a line is read back against. */
const NONCE_CHARSET = /^[0-9a-f]{32}$/

/**
 * What the host answers a click with when the page has not been agreed to.
 *
 * Three values and no sentence of its own: the card is the host's, word for
 * word the one a `show_component` call for the same page is put through, and
 * every word around it — the two buttons, and what a refusal leaves on screen
 * — belongs to the browser's own dictionaries.
 */
export interface ConsentQuestion {
  /** The view that was clicked, which the agreement is bound to. */
  readonly view: string
  /** The card, as `crudApprovalReason` wrote it. */
  readonly card: string
  /** The value the agreeing click carries back. */
  readonly nonce: ConsentNonce
}

/**
 * First line of an encoded question.
 *
 * A marker rather than a bare JSON document: the same field carries this row's
 * ordinary refusal sentences, and a row drawing a sentence that merely happened
 * to parse would be a card built out of whatever a future refusal said.
 */
const CONSENT_QUESTION_TAG = 'content-view-consent'

/**
 * Write one question into the command result's single text field.
 * @param question - the view, the card and the nonce.
 * @returns the text to settle the command with.
 */
export function encodeConsentQuestion(question: ConsentQuestion): string {
  return `${CONSENT_QUESTION_TAG}\n${JSON.stringify(question)}`
}

/**
 * Read a settlement's text back as a question, where that is what it is.
 *
 * Every other settlement — a refusal sentence, a click the host simply took, a
 * `done` whose `run` fell outside the window — answers `undefined`, which is
 * what makes one branch in the row enough for all of them.
 * @param text - the settled command's text, where it carried one.
 * @returns the question, or `undefined` for anything else.
 */
export function readConsentQuestion(text: string | undefined): ConsentQuestion | undefined {
  if (text === undefined || !text.startsWith(`${CONSENT_QUESTION_TAG}\n`)) return undefined
  // The document crossed a process and comes back off a durable log, so every
  // field is a claim: a build that wrote an older shape, and a log hand-edited
  // between the write and the read, both arrive here.
  let parsed: unknown
  try {
    parsed = JSON.parse(text.slice(CONSENT_QUESTION_TAG.length + 1))
  } catch (_notADocument) {
    // Swallowed here and nowhere else: a text carrying this row's own marker
    // and then something that is not a JSON document is a settlement no card
    // can be built from, and the row draws nothing rather than failing.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { view, card, nonce } = parsed as Record<string, unknown>
  if (typeof view !== 'string' || view === '') return undefined
  if (typeof card !== 'string' || card === '') return undefined
  if (typeof nonce !== 'string' || !NONCE_CHARSET.test(nonce)) return undefined
  return { view, card, nonce: consentNonce(nonce) }
}

/** One click's line, as the command reads it: which view, and the agreement it carries. */
export interface ViewCommandInput {
  /** The view id, which is the whole line for a click that agrees to nothing. */
  readonly viewId: string
  /** The agreement, on the second click only. */
  readonly nonce?: ConsentNonce
}

/**
 * Build the line one click runs.
 *
 * Two words at most, in the order a person would read them, because this is
 * the command's own recorded input: a log entry naming the view and the
 * agreement it was opened with rather than a document nobody can read.
 * @param viewId - the view that was clicked.
 * @param nonce - the agreement, on the click that carries one.
 * @returns the text after the command name.
 */
export function formatViewCommandLine(viewId: string, nonce?: ConsentNonce): string {
  return nonce === undefined ? viewId : `${viewId} ${nonce}`
}

/**
 * Read one click's line.
 *
 * A line carrying anything but a well-formed nonce in second place is read as
 * naming a view alone, which is the click that asks: a garbled agreement and no
 * agreement are the same state, and both end at the card.
 * @param rawInput - everything after the command name, separator whitespace included.
 * @returns the view and the agreement the line carried.
 */
export function parseViewCommandInput(rawInput: string): ViewCommandInput {
  const [viewId = '', second] = rawInput.trim().split(/\s+/)
  return second !== undefined && NONCE_CHARSET.test(second)
    ? { viewId, nonce: consentNonce(second) }
    : { viewId }
}
