/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-content-frame`.
 * @module @deepseek-ai/dsh-experimental-content-frame/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type {} from './types.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-content-frame'

/** Cordis companion plugin name. */
export const name = 'experimental-content-frame-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one recorded column state before it reaches the durable log.
 *
 * Deliberately silent on whether the id names a configured page. The page list
 * is per-deployment configuration that changes under the log, and the
 * projection already resolves an id it no longer knows as `missing`: tying the
 * invariant to the current list would reject history that was valid when it
 * was written.
 */
function validateShown(page: unknown, fail: InvariantFailure): void {
  if (page === null) return
  if (typeof page !== 'string' || page.length === 0 || page.trim() !== page) {
    fail('content/shown page must be null or a non-empty, already-trimmed id')
  }
}

/** Validate the package-owned event fields and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'content/shown') validateShown(event.data.page, fail)
}

/** Install validation for loaded and newly appended column states. */
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
