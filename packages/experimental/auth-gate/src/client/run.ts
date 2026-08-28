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
 * @returns the disposer releasing the storage subscription and the expiry timer.
 * @throws {Error} when the mirror cookie cannot be written, which is the one
 * failure a reload would repeat forever.
 */
export function runGate(browser: GateBrowser, settings: AuthGateSettings, push: (token: string) => void): () => void {
  const decision = decideGate(browser.readToken(), browser.readCookie(settings.cookieName), browser.now())
  if (decision.kind === 'login') {
    browser.navigate(loginHref(settings.loginUrl, browser.currentHref()))
    return LEAVING
  }
  if (decision.kind === 'mirror') {
    mirror(browser, settings.cookieName, decision.accepted.token)
    browser.reload()
    return LEAVING
  }
  return watch(browser, settings, push, decision.accepted)
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
 * @param first - the token this page load runs on.
 * @returns the disposer releasing the subscription and the pending timer.
 */
function watch(
  browser: GateBrowser,
  settings: AuthGateSettings,
  push: (token: string) => void,
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
      () => { handleTokenExpiring(browser, settings) },
    )
  }
  arm(first)

  const unsubscribe = browser.onStorageChanged(() => {
    const change = decideChange(browser.readToken(), current.token, browser.now())
    if (change.kind === 'login') {
      browser.navigate(loginHref(settings.loginUrl, browser.currentHref()))
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
 * @param browser - the page's navigation.
 * @param settings - the node half's configuration for this browser.
 */
function handleTokenExpiring(browser: GateBrowser, settings: AuthGateSettings): void {
  browser.navigate(loginHref(settings.loginUrl, browser.currentHref()))
}
