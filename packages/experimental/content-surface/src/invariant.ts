/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-content-surface`.
 * @module @deepseek-ai/dsh-experimental-content-surface/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-content-surface'

/** Cordis companion plugin name. */
export const name = 'experimental-content-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one recorded dismissal before it reaches the durable log.
 *
 * Deliberately silent on whether `(kind, entryId)` names a live entry: the
 * router keeps no catalogue to check it against, and a dismissal naming a
 * pair that is already gone is an ordinary no-op fold, not an incoherent
 * record (see `command.ts`'s own module doc).
 */
function validateDismissed(data: { kind: string; entryId: string; by: string }, fail: InvariantFailure): void {
  if (typeof data.kind !== 'string' || data.kind.length === 0) {
    fail('content-surface/dismissed kind must be a non-empty string')
  }
  if (typeof data.entryId !== 'string' || data.entryId.length === 0) {
    fail('content-surface/dismissed entryId must be a non-empty string')
  }
  if (data.by !== 'user') {
    fail('content-surface/dismissed by must be "user"')
  }
}

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'content-surface/dismissed') validateDismissed(event.data, fail)
}

/** Install validation for loaded and newly appended dismissal events. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) {
    for (const event of session.events) validateEvent(event, fail)
  }
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const event = (args as [Session, SessionEvent])[1]
    validateEvent(event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
