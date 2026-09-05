/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-component-surface`.
 * @module @deepseek-ai/dsh-experimental-component-surface/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: resolves ctx.sessionProjections, which the audit reads the fold through.
import type {} from '@deepseek-ai/dsh-session-projection'
import type { ContentSurfaceRecord } from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { COMPONENT_KIND, SHOW_COMPONENT_TOOL_NAME } from './component-call.ts'
import { readComponentEvent } from './projection.ts'
import { validateComponentCall } from './validate.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-component-surface'

/**
 * The writers other than a `show_component` call that an entry can be
 * authorized by, named in the failure so the reader knows all three were looked
 * for: a user's click on a configured view, and the tool's own record of a call
 * whose rows it read from the data backend.
 */
const APPENDED_EVENTS: readonly string[] = ['content-component/shown', 'content-component/resolved']

/** Cordis companion plugin name. */
export const name = 'experimental-component-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Entry ids one session's log authorizes: one per accepted `show_component`
 * call, one per view the user opened, and one per call whose rows were read
 * from the data backend, counted by the same reader the extractor uses, so the
 * audit's two sides cannot drift by counting different things.
 * @param session - the session whose log is read.
 * @returns the authorized entry ids.
 */
function authorizedEntryIds(session: Session): Set<string> {
  const ids = new Set<string>()
  for (const event of session.events) {
    const args = readComponentEvent(event)
    if (args === undefined) continue
    const result = validateComponentCall(args)
    if (result.ok) ids.add(result.call.id)
  }
  return ids
}

/**
 * Audit one session's folded content-surface records against its own log.
 *
 * The relation holds between mutable derived data and the authoritative event
 * stream, and it breaks in one direction from two causes. The content surface
 * seeds a fold from persisted checkpoints and decides whether one still applies
 * by hashing its extractor table into 31 bits, a collision its own README
 * records as residual risk; and its registry admits two extractors claiming one
 * kind, so a second producer of `component` entries is composable. Either way
 * the column ends up holding a block whose call is nowhere in this log, which
 * the browser seat cannot tell from a real one.
 *
 * The log walk happens only once a component record exists, so a session that
 * never showed one costs a single map lookup per audit.
 * @param ctx - the installer's context, carrying the projection registry.
 * @param session - the session to audit.
 * @param fail - reporter bound to this package.
 */
function auditSession(ctx: Context, session: Session, fail: InvariantFailure): void {
  const records: readonly ContentSurfaceRecord[] | undefined = ctx.sessionProjections.stateOf(session, 'contentSurface')
  const owned = (records ?? []).filter(record => record.kind === COMPONENT_KIND)
  if (owned.length === 0) return
  const authorized = authorizedEntryIds(session)
  for (const record of owned) {
    if (!authorized.has(record.entryId)) {
      fail(`session ${session.id} carries a ${COMPONENT_KIND} content entry ${JSON.stringify(record.entryId)} that nothing in its log recorded: no accepted ${SHOW_COMPONENT_TOOL_NAME} call and no ${APPENDED_EVENTS.join(' or ')} event`)
    }
  }
}

/** Audit every loaded session, then every session a committed event reaches. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) auditSession(ctx, session, fail)
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    auditSession(ctx, (args as [Session])[0], fail)
  }, { global: true })
}, { inject: ['sessions', 'sessionProjections'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
