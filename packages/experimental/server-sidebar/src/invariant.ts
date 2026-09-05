/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-server-sidebar`.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SERVER_SIDEBAR_NAMESPACE, validateServerMenu, type ServerMenuSettings } from './workflows.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-server-sidebar'

/** Cordis companion plugin name. */
export const name = 'experimental-server-sidebar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Run the document's cross-element constraints against a committed value.
 * Separated from the listener so the `fail()` call — which throws — stays
 * outside the `try`, where a caught rethrow would swallow the failure the
 * registry raised.
 * @param value - the committed section.
 * @returns the broken constraint's message, or `undefined` when the document holds.
 */
function brokenConstraint(value: ServerMenuSettings): string | undefined {
  try {
    validateServerMenu(value)
  } catch (error: unknown) {
    // `validateServerMenu` raises `Error` and nothing else (same package, one
    // throw site per constraint), so its message is read without a narrowing
    // branch no committed document can reach.
    return (error as Error).message
  }
  return undefined
}

/**
 * Check the relations this package's durable data must hold: one workflow per
 * id, one group per id, no group claiming the reserved temporary id, no blank
 * or over-long group name, and no workflow filed under a group nothing
 * defines. The registration's own `validate` hook already refuses a write
 * that would break any of them before it persists — this listener re-checks
 * the committed, authoritative value through that same function as the
 * independent proof the mechanism note requires.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== SERVER_SIDEBAR_NAMESPACE) return
    const broken = brokenConstraint(next as ServerMenuSettings)
    if (broken !== undefined) fail(`server-sidebar: committed server-menu document: ${broken}`)
  })
}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
