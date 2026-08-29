/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-server-sidebar`.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SERVER_SIDEBAR_NAMESPACE } from './favorites.ts'
import type { ServerMenuSettings } from './favorites.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-server-sidebar'

/** Cordis companion plugin name. */
export const name = 'experimental-server-sidebar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check the one relation this package's durable data must hold: every commit
 * to its settings namespace carries at most one favorite per session id. The
 * registration's own `validate` hook already refuses a write that would
 * break this before it persists — this listener re-checks the committed,
 * authoritative value as the independent proof the mechanism note requires.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== SERVER_SIDEBAR_NAMESPACE) return
    const seen = new Set<string>()
    for (const favorite of (next as ServerMenuSettings).favorites) {
      if (seen.has(favorite.sessionId)) {
        fail(`server-sidebar: committed favorites carry a duplicate session "${favorite.sessionId}"`)
      }
      seen.add(favorite.sessionId)
    }
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
