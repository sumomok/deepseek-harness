/**
 * What the browser half decides, as pure functions over the token it found, the
 * cookie it already carries, and the clock. Every rule the gate has lives here,
 * so the decision table is readable in one place and testable without a
 * browser.
 *
 * Signatures are not checked. The token is verified by whatever terminates TLS
 * in front of this deployment, which is also what routes the visitor to their
 * own dsh process; a browser that verified it again would be checking the
 * claims it was handed against the key it was handed.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/gate
 */

import { isJwtShaped } from '../route.ts'

/** A token the gate has accepted, with the claim its schedule is built on. */
export interface UsableToken {
  /** The token itself, exactly as storage held it. */
  token: string
  /** Its `exp` claim, in seconds since the epoch, already known to be ahead. */
  expSeconds: number
}

/** What the gate does with the token present when the page boots. */
export type GateDecision =
  /** No usable token: leave for the login page. */
  | { kind: 'login' }
  /** A usable token the cookie does not carry yet: mirror it, then start over. */
  | { kind: 'mirror'; accepted: UsableToken }
  /** The cookie already carries this token: the page may run. */
  | { kind: 'ready'; accepted: UsableToken }

/** What the gate does when another tab changes the stored token. */
export type ChangeDecision =
  /** The token is gone or no longer usable: leave for the login page. */
  | { kind: 'login' }
  /** A different person signed in: nothing rendered for the previous one may stay. */
  | { kind: 'reload'; accepted: UsableToken }
  /** The same person, a newer token: mirror it and hand it to the host. */
  | { kind: 'sync'; accepted: UsableToken }

/**
 * Decode a JWT's payload without verifying anything.
 * @param token - a JWT-shaped string.
 * @returns the payload object, or `undefined` when the segment is not
 * base64url-encoded JSON describing an object.
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const segment = token.slice(token.indexOf('.') + 1, token.lastIndexOf('.'))
  const base64 = segment.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(segment.length / 4) * 4, '=')
  let decoded: unknown
  try {
    const bytes = Uint8Array.from(atob(base64), character => character.charCodeAt(0))
    decoded = JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch (_payloadIsNotJson) {
    // A token whose payload does not decode is one this gate can read neither a
    // subject nor an expiry out of; every caller treats that as unusable.
    return undefined
  }
  // An array decodes as an object and carries no claims; a payload that is not
  // a claim set is one this gate reads nothing out of.
  return decoded !== null && typeof decoded === 'object' && !Array.isArray(decoded)
    ? decoded as Record<string, unknown>
    : undefined
}

/**
 * A token's `sub` claim — who the gate believes is signed in.
 * @param token - a JWT-shaped string.
 * @returns the subject, or `undefined` when the token carries no string one.
 */
export function tokenSubject(token: string): string | undefined {
  const sub = decodeJwtPayload(token)?.sub
  return typeof sub === 'string' ? sub : undefined
}

/**
 * Whether a stored value is a token this gate can work with: JWT-shaped, with
 * an expiry, and not past it.
 *
 * A token with no `exp` is refused rather than treated as eternal — the gate's
 * whole schedule is built on that claim, and one without it would never be
 * re-checked.
 * @param token - whatever storage held, possibly nothing.
 * @param nowMs - the current time in milliseconds.
 * @returns the token and its expiry when it is usable, `undefined` otherwise.
 */
export function usableToken(token: string | null, nowMs: number): UsableToken | undefined {
  if (!isJwtShaped(token)) return undefined
  const exp = decodeJwtPayload(token)?.exp
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp * 1000 <= nowMs) return undefined
  return { token, expSeconds: exp }
}

/**
 * The gate's boot decision.
 * @param token - whatever storage held, possibly nothing.
 * @param cookieValue - what the mirror cookie currently carries.
 * @param nowMs - the current time in milliseconds.
 * @returns what the page must do before it runs.
 */
export function decideGate(token: string | null, cookieValue: string | undefined, nowMs: number): GateDecision {
  const accepted = usableToken(token, nowMs)
  if (accepted === undefined) return { kind: 'login' }
  return cookieValue === accepted.token ? { kind: 'ready', accepted } : { kind: 'mirror', accepted }
}

/**
 * The gate's decision about a token another tab just wrote.
 *
 * A same-subject replacement does not reload: the page it would throw away
 * belongs to the same person, and the host takes the newer token through the
 * token route. A different subject does, because everything on screen was
 * fetched as somebody else.
 * @param next - whatever storage now holds, possibly nothing.
 * @param current - the token this page has been running on.
 * @param nowMs - the current time in milliseconds.
 * @returns what the running page must do about it.
 */
export function decideChange(next: string | null, current: string, nowMs: number): ChangeDecision {
  const accepted = usableToken(next, nowMs)
  if (accepted === undefined) return { kind: 'login' }
  return tokenSubject(accepted.token) === tokenSubject(current)
    ? { kind: 'sync', accepted }
    : { kind: 'reload', accepted }
}

/**
 * Where an unauthenticated visitor is sent, carrying the page to come back to.
 * @param loginUrl - the configured login destination, which carries no query
 * string of its own.
 * @param currentHref - the page the visitor asked for.
 * @returns the login URL with the return address appended.
 */
export function loginHref(loginUrl: string, currentHref: string): string {
  return `${loginUrl}?redirect=${encodeURIComponent(currentHref)}`
}

/**
 * How long the page may run before the token's expiry has to be dealt with.
 * @param expSeconds - the token's expiry, in seconds since the epoch.
 * @param marginSeconds - how far ahead of expiry to act.
 * @param nowMs - the current time in milliseconds.
 * @returns the delay in milliseconds, never negative — a margin longer than the
 * token's remaining life means acting now.
 */
export function expiryDelayMs(expSeconds: number, marginSeconds: number, nowMs: number): number {
  return Math.max(0, expSeconds * 1000 - marginSeconds * 1000 - nowMs)
}
