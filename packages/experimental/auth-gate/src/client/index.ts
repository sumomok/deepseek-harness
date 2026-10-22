/**
 * auth-gate browser half: the first thing a page does about who is looking at
 * it. It reads the access token the deployment's login page left in
 * `localStorage`, sends a visitor without one to that login page, mirrors the
 * one it finds into a cookie, hands it to the node half, and — where the
 * deployment offers a renewal endpoint — replaces it with a fresh one before it
 * runs out, in place and without a navigation. A token the site's own login
 * check refuses sends the visitor to the login page once; one the login page
 * hands back still refused stops the gate, and the one thing this half draws,
 * a `shell.overlay` notice, says so.
 *
 * The gate itself waits for no other service, so a page whose UI never comes
 * up is still sent to the login page; the notice waits separately for the slot
 * and locale services.
 *
 * Its configuration is host configuration, and a browser half receives no
 * cordis config — the boot manifest carries plugin names, not their `config`
 * blocks — so apply reads it from the node half's settings route before running
 * the gate. A failed read fails the row: a gate that silently used some other
 * login address or margin would be indistinguishable from one that honored the
 * deployment's.
 *
 * The node half registers its routes at the server root; a reverse proxy
 * serving this shell under a path prefix strips that prefix before the request
 * arrives, so every route this file requests is resolved document-relative,
 * against the `<base href="./">` the served index carries, and keeps the
 * prefix the page was loaded under. Each diagnostic names the resolved URL
 * rather than the route constant, which is what tells a misconfigured
 * deployment prefix apart from an unreachable route.
 * @module @deepseek-ai/dsh-experimental-auth-gate/client
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import {
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  isOwnOriginPath,
  MAX_RENEWAL_INTERVAL_SECONDS,
  type AuthGateRenewalSettings,
  type AuthGateSettings,
} from '../route.ts'
// Type-only: the `locale` service merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `shell.overlay` slot the notice registers into.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `slots` service merge.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { windowGateBrowser } from './browser.ts'
import { en, NS, zh, type AuthGateKey } from './locales.ts'
import { RefusedNotice, type RefusedNoticeFace } from './RefusedNotice.tsx'
import { REFUSED_STATUS, runGate, type PushOutcome } from './run.ts'

export type { AuthGateKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The refusal notice's copy. */
    authGate: AuthGateKey
  }
}

/**
 * Read the browser-facing half of this plugin's configuration from its node half.
 * @returns the settings the node half serves.
 * @throws {Error} when the route is unreachable, answers non-200, or answers a
 * document the gate cannot run on.
 */
async function readSettings(): Promise<AuthGateSettings> {
  const url = new URL(AUTH_GATE_SETTINGS_ROUTE.slice(1), document.baseURI)
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`auth-gate: ${url.href} answered ${response.status}`)
  }
  const settings = await response.json() as Partial<AuthGateSettings>
  // A wire boundary: the document crossed a process, so its own contract is
  // checked here rather than trusted from the type.
  const { loginUrl, cookieName, refreshMarginSeconds } = settings
  if (typeof loginUrl !== 'string' || loginUrl.length === 0) {
    throw new Error(`auth-gate: ${url.href} answered an unusable loginUrl: ${JSON.stringify(loginUrl)}`)
  }
  if (typeof cookieName !== 'string' || cookieName.length === 0) {
    throw new Error(`auth-gate: ${url.href} answered an unusable cookieName: ${JSON.stringify(cookieName)}`)
  }
  if (typeof refreshMarginSeconds !== 'number' || !Number.isInteger(refreshMarginSeconds) || refreshMarginSeconds < 0) {
    throw new Error(
      `auth-gate: ${url.href} answered an unusable refreshMarginSeconds: ${JSON.stringify(refreshMarginSeconds)}`,
    )
  }
  const renewal = readRenewal(url, settings.renewal)
  return { loginUrl, cookieName, refreshMarginSeconds, ...renewal === undefined ? {} : { renewal } }
}

/**
 * Read the renewal half of that same document, which a deployment offering no
 * renewal endpoint leaves out entirely.
 * @param url - the settings route, named in every diagnostic.
 * @param served - whatever the document carried under `renewal`, however
 * malformed.
 * @returns the renewal settings, or `undefined` where the document carries none.
 * @throws {Error} when the document carries a renewal the gate cannot spend a
 * token on. A path naming another origin is refused here as it is at the node
 * half, by the same {@link isOwnOriginPath} resolution: the value decides where
 * this visitor's credential is sent. An interval longer than a browser timer
 * waits is refused here as well — the timer would fire on the next tick instead,
 * and every tick carries that credential.
 */
function readRenewal(url: URL, served: unknown): AuthGateRenewalSettings | undefined {
  if (served === undefined) return undefined
  if (served === null || typeof served !== 'object') {
    throw new Error(`auth-gate: ${url.href} answered an unusable renewal: ${JSON.stringify(served)}`)
  }
  const { path, intervalSeconds } = served as { path?: unknown; intervalSeconds?: unknown }
  if (typeof path !== 'string' || !isOwnOriginPath(path)) {
    throw new Error(`auth-gate: ${url.href} answered an unusable renewal path: ${JSON.stringify(path)}`)
  }
  if (
    typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds)
    || intervalSeconds <= 0 || intervalSeconds > MAX_RENEWAL_INTERVAL_SECONDS
  ) {
    throw new Error(
      `auth-gate: ${url.href} answered an unusable renewal intervalSeconds: ${JSON.stringify(intervalSeconds)}`,
    )
  }
  return { path, intervalSeconds }
}

/**
 * Hand one accepted token to the node half.
 * @param token - the token this page is running on.
 * @returns `taken` once the node half has taken it, or `refused` when the
 * site's own login check in front of the route refused it.
 * @throws {Error} when the route fails it any other way. The token is never
 * named in the message.
 */
async function postToken(token: string): Promise<'taken' | 'refused'> {
  const url = new URL(AUTH_GATE_TOKEN_ROUTE.slice(1), document.baseURI)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  })
  if (response.ok) return 'taken'
  if (response.status === REFUSED_STATUS) return 'refused'
  throw new Error(`auth-gate: ${url.href} answered ${response.status}`)
}

/**
 * Tell the node half to drop the token it holds.
 * @returns nothing, once the node half has dropped it.
 * @throws {Error} when the route refuses the request.
 */
async function postLogout(): Promise<void> {
  // `keepalive`: every caller is about to navigate to the login page, and a
  // request the document owns is cancelled the moment it does.
  //
  // The request declares `application/json` and carries no body, and the route
  // reads none either. The declaration is there to withdraw the route from the
  // CORS-simple set, so a cross-origin page cannot post it without a preflight.
  const url = new URL(AUTH_GATE_LOGOUT_ROUTE.slice(1), document.baseURI)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    keepalive: true,
  })
  if (!response.ok) {
    throw new Error(`auth-gate: ${url.href} answered ${response.status}`)
  }
}

/**
 * Client plugin body: read the gate's settings, then run it for this page load.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  const settings = await readSettings()
  const refusal = createSnapshotStore(false)
  ctx.inject(['slots', 'locale'], (ui) => {
    ui.effect(() => ui.locale.register(NS, { zh, en }), 'auth-gate: dictionaries')
    ui.slots.inject('shell.overlay', () => ui.slots.register({
      name: 'shell.overlay',
      id: 'auth-gate.refused-notice',
      locale: NS,
      inject: (): RefusedNoticeFace => ({ hooks: { authGateRefusal: refusal } }),
    }, RefusedNotice))
  })
  ctx.effect(() => runGate(windowGateBrowser(), settings, async (token): Promise<PushOutcome> => {
    try {
      return await postToken(token)
    } catch (error) {
      // A post failed for any other reason leaves the node half without a
      // token, which its own forwarding routes report as 503. The page itself
      // stays usable, so this is a warning rather than a failed row.
      ctx.logger.warn(error)
      return 'unsettled'
    }
  }, () => {
    // A refused revoke leaves the node half holding a token the visitor has
    // given up. The page is leaving for the login page either way, so this is a
    // warning rather than something to hold the navigation for.
    postLogout().catch((error: unknown) => { ctx.logger.warn(error) })
  }, () => { refusal.set(true) }), 'auth-gate: browser boot gate')
}
