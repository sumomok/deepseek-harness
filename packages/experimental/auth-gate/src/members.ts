/**
 * One customer token per console member: the in-memory store, the slot of one
 * member that a route or a data-backend read spends, the reader this package
 * lends the member directory, the resolver `ctx.bizBackend` finds a slot
 * through, and the claim of a posted token that names the member it was issued
 * to.
 *
 * Node-only: the claim is decoded with `Buffer`, and the browser half imports
 * nothing from here.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/members
 */

import type { Context } from '@deepseek-ai/cordis'
import type { BizSubject, CredentialResolver, HeldCredential, PrincipalKey } from '@deepseek-ai/dsh-experimental-biz-backend'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { ConsoleMemberDirectory, CustomerCredentialReader } from '@deepseek-ai/dsh-experimental-console-members/types'

/** One subscriber to the store's changes, as {@link CustomerCredentialReader.onChange} takes it. */
type ChangeListener = (principal: PrincipalKey, kind: 'set' | 'dropped') => void

/** The reader lent to one taker, and the call that takes it back. */
export interface LentReader {
  /** The view the taker reads through. */
  readonly reader: CustomerCredentialReader
  /**
   * Take the reader back: from then on it reads `undefined` for every member,
   * every subscription made through it is ended, and a new one is ignored.
   */
  revoke(): void
}

/** The tokens this process holds, one per member, as the two views anything outside the store gets. */
export interface MemberCredentials {
  /**
   * One member's slot. Its `read`, `set`, and `drop` act on that member's
   * entry and on no other.
   * @param principal - the member.
   * @returns the slot, whether or not a token is held in it.
   */
  slotOf(principal: PrincipalKey): HeldCredential
  /**
   * A new reader over the store, for one taker.
   * @returns the reader and the call that revokes it.
   */
  lend(): LentReader
}

/**
 * Create the store.
 *
 * A change is published only when it changes the store: `set` with the token
 * already held for that member and `drop` of a member holding none notify no
 * subscriber. A subscriber that throws is reported through `report` and does
 * not stop the subscribers after it or fail the change.
 * @param report - where a failing subscriber is reported; it receives a fixed line naming neither the member nor the token.
 * @returns the store's two views.
 */
export function holdMemberCredentials(report: (line: string) => void): MemberCredentials {
  const held = new Map<PrincipalKey, string>()
  const listeners = new Set<ChangeListener>()
  const notify = (principal: PrincipalKey, kind: 'set' | 'dropped'): void => {
    // A copy, so a subscriber that ends its own subscription does not make the
    // loop skip the one after it.
    for (const listener of [...listeners]) {
      try {
        listener(principal, kind)
      } catch (_subscriberFailed) {
        // Neither the member nor the error is repeated: the error is the
        // subscriber's own text, and nothing here knows what it quotes.
        report('a customer credential subscriber threw; the change it was told about is kept')
      }
    }
  }
  return {
    slotOf: principal => ({
      read: () => held.get(principal),
      set: (token) => {
        if (held.get(principal) === token) return
        held.set(principal, token)
        notify(principal, 'set')
      },
      // Both reasons reach the same terminal state, so the store reads neither.
      drop: (_reason) => {
        if (!held.delete(principal)) return
        notify(principal, 'dropped')
      },
    }),
    lend: () => {
      let revoked = false
      const own = new Set<ChangeListener>()
      return {
        reader: {
          read: principal => revoked ? undefined : held.get(principal),
          onChange: (listener) => {
            if (revoked) return () => {}
            // A wrapper per call, so one function subscribed twice holds two
            // subscriptions and each disposer ends its own.
            const subscription: ChangeListener = (principal, kind) => { listener(principal, kind) }
            own.add(subscription)
            listeners.add(subscription)
            return () => {
              own.delete(subscription)
              listeners.delete(subscription)
            }
          },
        },
        revoke: () => {
          revoked = true
          for (const subscription of own) listeners.delete(subscription)
          own.clear()
        },
      }
    },
  }
}

/**
 * The member one data-backend subject names.
 * @param members - the member directory.
 * @param subject - whom a read is for.
 * @returns the member, or `undefined` when the directory places a session with nobody.
 */
function principalOfSubject(members: ConsoleMemberDirectory, subject: BizSubject): PrincipalKey | undefined {
  switch (subject.kind) {
    case 'principal': return subject.principal
    case 'session': return members.principalOfSession(subject.sessionId)
    /* v8 ignore next -- the subject union is closed and typed; the arm keeps a new member loud. */
    default: return assertNever(subject, 'BizSubject')
  }
}

/**
 * Resolve each subject to the slot of the member it names, through the member
 * directory running in this process.
 *
 * While no `consoleMembers` service is running every subject resolves to no
 * slot, and every request names nobody: no other member's slot, and no slot
 * shared by the whole process, is answered in its place.
 * @param ctx - the context the `consoleMembers` service is read from at each call.
 * @param credentials - the store the slots belong to.
 * @returns the resolver `ctx.bizBackend` finds each read's slot through.
 */
export function memberSlotResolver(ctx: Context, credentials: MemberCredentials): CredentialResolver {
  return {
    resolve: (subject) => {
      const members = ctx.get('consoleMembers')
      if (members === undefined) return undefined
      const principal = principalOfSubject(members, subject)
      return principal === undefined ? undefined : credentials.slotOf(principal)
    },
    principalOfRequest: req => ctx.get('consoleMembers')?.principalOfRequest(req),
  }
}

/**
 * `JSON.parse` reviver that keeps every number as its exact source text, so a
 * 19-digit numeric claim is compared digit for digit rather than after
 * rounding to the nearest double. The deployment's signing proxy reads the
 * same claim by the same rule when it names the member in the assertion this
 * process is told about, so the two agree on every id.
 *
 * No load-time check that the runtime passes `context.source`: Node has passed
 * it since 21.0, below this repository's engines floor of 22.19. A runtime that
 * did not would read every numeric claim as `undefined`, which refuses the
 * token rather than accepting it.
 * @param _key - the property name.
 * @param value - the parsed value.
 * @param context - the parser's source text for the value, where the runtime supplies it.
 * @returns the value, with a number replaced by its source digits.
 */
function keepNumberSource(_key: string, value: unknown, context?: { source?: string }): unknown {
  return typeof value === 'number' ? context?.source : value
}

/**
 * A claim value as text, by the signing proxy's rule: a non-empty string, or a
 * number already carried as its digits.
 * @param value - one claim value.
 * @returns the text, or `undefined` for an empty string or any other value.
 */
function claimText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read one claim of a token's payload without verifying its signature.
 * @param token - a JWT-shaped token.
 * @param claim - the claim's name.
 * @returns the claim as text, or `undefined` when the payload is not a JSON
 * object or carries no usable value under that name.
 */
export function tokenClaim(token: string, claim: string): string | undefined {
  const payload = token.split('.')[1]
  if (payload === undefined) return undefined
  let claims: unknown
  try {
    claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'), keepNumberSource)
  } catch (_payloadIsNotJson) {
    // A payload that does not parse names no member; the caller refuses it.
    return undefined
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) return undefined
  return Object.hasOwn(claims, claim) ? claimText(Reflect.get(claims, claim)) : undefined
}
