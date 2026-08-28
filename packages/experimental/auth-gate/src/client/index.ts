/**
 * auth-gate browser half: the first thing a page does about who is looking at
 * it. No slot, no component, no copy — it reads the access token the
 * deployment's login page left in `localStorage`, sends a visitor without one
 * to that login page, mirrors the one it finds into a cookie, and hands it to
 * the node half.
 *
 * Its configuration is host configuration, and a browser half receives no
 * cordis config — the boot manifest carries plugin names, not their `config`
 * blocks — so apply reads it from the node half's settings route before running
 * the gate. A failed read fails the row: a gate that silently used some other
 * login address or margin would be indistinguishable from one that honored the
 * deployment's.
 * @module @deepseek-ai/dsh-experimental-auth-gate/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, type AuthGateSettings } from '../route.ts'
import { windowGateBrowser } from './browser.ts'
import { runGate } from './run.ts'

/**
 * Read the browser-facing half of this plugin's configuration from its node half.
 * @returns the settings the node half serves.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a
 * document the gate cannot run on.
 */
async function readSettings(): Promise<AuthGateSettings> {
  const response = await fetch(AUTH_GATE_SETTINGS_ROUTE, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`auth-gate: ${AUTH_GATE_SETTINGS_ROUTE} answered ${response.status}`)
  }
  const settings = await response.json() as Partial<AuthGateSettings>
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  const { loginUrl, cookieName, refreshMarginSeconds } = settings
  if (typeof loginUrl !== 'string' || loginUrl.length === 0) {
    throw new Error(`auth-gate: ${AUTH_GATE_SETTINGS_ROUTE} answered an unusable loginUrl: ${JSON.stringify(loginUrl)}`)
  }
  if (typeof cookieName !== 'string' || cookieName.length === 0) {
    throw new Error(`auth-gate: ${AUTH_GATE_SETTINGS_ROUTE} answered an unusable cookieName: ${JSON.stringify(cookieName)}`)
  }
  if (typeof refreshMarginSeconds !== 'number' || !Number.isInteger(refreshMarginSeconds) || refreshMarginSeconds < 0) {
    throw new Error(
      `auth-gate: ${AUTH_GATE_SETTINGS_ROUTE} answered an unusable refreshMarginSeconds: ${JSON.stringify(refreshMarginSeconds)}`,
    )
  }
  return { loginUrl, cookieName, refreshMarginSeconds }
}

/**
 * Hand one accepted token to the node half.
 * @param token - the token this page is running on.
 * @returns nothing, once the node half has taken it.
 * @throws {Error} when the route refuses it. The token is never named in the
 * message.
 */
async function postToken(token: string): Promise<void> {
  const response = await fetch(AUTH_GATE_TOKEN_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (!response.ok) {
    throw new Error(`auth-gate: ${AUTH_GATE_TOKEN_ROUTE} answered ${response.status}`)
  }
}

/**
 * Client plugin body: read the gate's settings, then run it for this page load.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const settings = await readSettings()
  ctx.effect(() => runGate(windowGateBrowser(), settings, (token) => {
    // A refused push leaves the node half without a token, which its own
    // forwarding routes report as 503. The page itself stays usable, so this
    // is a warning rather than a failed row.
    postToken(token).catch((error: unknown) => { ctx.logger.warn(error) })
  }), 'auth-gate: browser boot gate')
}
