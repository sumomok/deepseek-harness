/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-experimental-server-sidebar`.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ServerMenuSettings } from './workflows.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-server-sidebar'
/**
 * This package's settings namespace, recomputed rather than imported from
 * `workflows.ts` (`settingsNamespace` is a pure value transform, so the two
 * calls produce an equal, comparable string either way): sharing the runtime
 * value across this module and `index.ts` would give tsdown's two entry
 * bundles a common chunk to split out, which the built-package-invariant
 * gate's file allowlist (this package's `package.json#files`) cannot name
 * (its hash is content-addressed) — see the package README.
 */
const SERVER_SIDEBAR_NAMESPACE = settingsNamespace('server-sidebar')

/** Cordis companion plugin name. */
export const name = 'experimental-server-sidebar-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Check the one relation this package's durable data must hold: every commit
 * to its settings namespace carries at most one workflow per id. The
 * registration's own `validate` hook already refuses a write that would
 * break this before it persists — this listener re-checks the committed,
 * authoritative value as the independent proof the mechanism note requires.
 */
const install: InvariantInstaller = (ctx: Context, fail: InvariantFailure) => {
  ctx.on('settings/updated', (ns, next) => {
    if (ns !== SERVER_SIDEBAR_NAMESPACE) return
    const seen = new Set<string>()
    for (const workflow of (next as ServerMenuSettings).workflows) {
      if (seen.has(workflow.id)) {
        fail(`server-sidebar: committed workflows carry a duplicate id "${workflow.id}"`)
      }
      seen.add(workflow.id)
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
