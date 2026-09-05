/**
 * The gate itself: the boot sequence, the account-switch watch, and the expiry
 * schedule, driven through one {@link GateBrowser} so the whole thing runs
 * without a DOM.
 *
 * The mirror never loops. A boot that has to mirror writes the cookie, reads it
 * back, and reloads only when the read-back shows the write took; a write that
 * did not take fails the row instead, because the same boot would otherwise
 * decide to mirror again on every reload forever.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/run
 */

import type { AuthGateSettings } from '../route.ts'
import type { GateBrowser } from './browser.ts'
import { decideChange, decideGate, expiryDelayMs, loginHref, type UsableToken } from './gate.ts'

/** Nothing to release: the page is leaving, and whatever it held goes with it. */
const LEAVING = (): void => {}

/**
 * Run the gate for one page load.
 * @param browser - the page's storage, cookies, clock, and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param push - hands one accepted token to the node half.
 * @param revoke - tells the node half to drop the token it holds.
 * @returns the disposer releasing the storage subscription and the expiry timer.
 * @throws {Error} when the mirror cookie cannot be written, which is the one
 * failure a reload would repeat forever.
 */
export function runGate(
  browser: GateBrowser,
  settings: AuthGateSettings,
  push: (token: string) => void,
  revoke: () => void,
): () => void {
  const decision = decideGate(browser.readToken(), browser.readCookie(settings.cookieName), browser.now())
  if (decision.kind === 'login') {
    leaveForLogin(browser, settings, revoke)
    return LEAVING
  }
  if (decision.kind === 'mirror') {
    mirror(browser, settings.cookieName, decision.accepted.token)
    browser.reload()
    return LEAVING
  }
  return watch(browser, settings, push, revoke, decision.accepted)
}

/**
 * Give up the token this page was running on and send the visitor to the login
 * page. The gate's one exit, taken on a boot that found no usable token, on a
 * token another tab removed or let expire, and on the expiry margin.
 *
 * The order is the whole point. The node half drops the token first, so the
 * process stops spending a credential its visitor no longer has. The mirror
 * cookie goes next, so the navigation that follows — and every request the login
 * page itself makes — no longer presents a dead token to the reverse proxy that
 * routes this origin; a proxy handed one answers 401, which is exactly the trip
 * back to the login page the visitor is already making.
 *
 * That order rests on when the browser attaches cookies. `revoke()` sends a
 * `keepalive` request that the reverse proxy in front of this process routes by
 * the very mirror cookie the next line removes, and the sequence holds because a
 * browser attaches cookies when a fetch is initiated, which is what Chromium
 * does. One that read them at send time instead would present none, the proxy
 * would refuse the sign-out, and the only trace would be a warning while the
 * node half went on holding the token until the process ends.
 * @param browser - the page's cookies and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param revoke - tells the node half to drop the token it holds.
 */
function leaveForLogin(browser: GateBrowser, settings: AuthGateSettings, revoke: () => void): void {
  revoke()
  browser.clearCookie(settings.cookieName)
  browser.navigate(loginHref(settings.loginUrl, browser.currentHref()))
}

/**
 * Write the mirror cookie and confirm the browser kept it.
 * @param browser - the page's cookies.
 * @param cookieName - the cookie to write.
 * @param token - the token to mirror.
 * @throws {Error} when the read-back does not show the token. The token is
 * never named in the message.
 */
function mirror(browser: GateBrowser, cookieName: string, token: string): void {
  browser.writeCookie(cookieName, token)
  if (browser.readCookie(cookieName) === token) return
  throw new Error(
    `auth-gate: the browser did not keep the "${cookieName}" cookie`
    + ' — the page is served over plain HTTP, or cookies are blocked for this origin',
  )
}

/**
 * Hand the token to the node half, then keep watching for the two things that
 * can change under a running page.
 * @param browser - the page's storage, clock, and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param push - hands one accepted token to the node half.
 * @param revoke - tells the node half to drop the token it holds.
 * @param first - the token this page load runs on.
 * @returns the disposer releasing the subscription and the pending timer.
 */
function watch(
  browser: GateBrowser,
  settings: AuthGateSettings,
  push: (token: string) => void,
  revoke: () => void,
  first: UsableToken,
): () => void {
  let current = first
  let cancelExpiry: () => void = LEAVING

  const arm = (accepted: UsableToken): void => {
    current = accepted
    push(accepted.token)
    cancelExpiry()
    cancelExpiry = browser.schedule(
      expiryDelayMs(accepted.expSeconds, settings.refreshMarginSeconds, browser.now()),
      () => { handleTokenExpiring(browser, settings, revoke) },
    )
  }
  arm(first)

  const unsubscribe = browser.onStorageChanged(() => {
    const change = decideChange(browser.readToken(), current.token, browser.now())
    if (change.kind === 'login') {
      leaveForLogin(browser, settings, revoke)
      return
    }
    mirror(browser, settings.cookieName, change.accepted.token)
    if (change.kind === 'reload') {
      browser.reload()
      return
    }
    arm(change.accepted)
  })

  return () => {
    unsubscribe()
    cancelExpiry()
  }
}

/**
 * What the gate does when the token is about to expire: the single place that
 * decision is made, and the only reader of `refreshMarginSeconds`.
 *
 * It sends the visitor back through the login page, which is the one renewal
 * route every deployment has. A deployment whose sign-on offers a renewal
 * endpoint replaces this function's body with a call to it; nothing else in the
 * gate depends on how the token is renewed.
 * @param browser - the page's cookies and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param revoke - tells the node half to drop the token it holds.
 */
function handleTokenExpiring(browser: GateBrowser, settings: AuthGateSettings, revoke: () => void): void {
  leaveForLogin(browser, settings, revoke)
}
