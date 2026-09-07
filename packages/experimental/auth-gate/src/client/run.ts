/**
 * The gate itself: the boot sequence, the account-switch watch, the expiry
 * schedule, and the renewal a deployment that offers one gets, driven through
 * one {@link GateBrowser} so the whole thing runs without a DOM.
 *
 * The mirror never loops. A boot that has to mirror writes the cookie, reads it
 * back, and reloads only when the read-back shows the write took; a write that
 * did not take fails the row instead, because the same boot would otherwise
 * decide to mirror again on every reload forever.
 * @module @deepseek-ai/dsh-experimental-auth-gate/src/client/run
 */

import {
  ACCESS_TOKEN_STORAGE_KEY,
  ACCESS_TOKEN_TIME_STORAGE_KEY,
  LOGIN_USER_INFO_STORAGE_KEY,
  type AuthGateRenewalSettings,
  type AuthGateSettings,
} from '../route.ts'
import { storedToken, type GateBrowser } from './browser.ts'
import { decideChange, decideGate, expiryDelayMs, loginHref, usableToken, type UsableToken } from './gate.ts'
import { accessTokenTimestamp, parseRenewalAnswer, renewalHeaders } from './renewal.ts'

/** Nothing to release: the page is leaving, and whatever it held goes with it. */
const LEAVING = (): void => {}

/**
 * The access token this page currently has, as the gate reads it: the stored
 * value with the login page's `Bearer` scheme dropped.
 * @param browser - the page's storage.
 * @returns the bare token, or `null` when nothing is stored.
 */
function heldToken(browser: GateBrowser): string | null {
  return storedToken(browser.readStorage(ACCESS_TOKEN_STORAGE_KEY))
}

/**
 * Run the gate for one page load.
 * @param browser - the page's storage, cookies, clock, and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param push - hands one accepted token to the node half. It must not throw:
 * every call is made from inside a decision this gate is taking — the boot, a
 * storage change, a renewal that landed — so a throw propagates out of this
 * function or out of a timer callback nothing awaits, leaving that decision
 * half-made. The client half posts the token and reports a refusal through
 * `.catch`.
 * @param revoke - tells the node half to drop the token it holds.
 * @returns the disposer releasing the storage subscription, the pending timers,
 * and any renewal in flight.
 * @throws {Error} when the mirror cookie cannot be written, which is the one
 * failure a reload would repeat forever.
 */
export function runGate(
  browser: GateBrowser,
  settings: AuthGateSettings,
  push: (token: string) => void,
  revoke: () => void,
): () => void {
  const decision = decideGate(heldToken(browser), browser.readCookie(settings.cookieName), browser.now())
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
 * token another tab removed or let expire, and on an expiry margin no renewal
 * answered.
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
 * Write the mirror cookie and report whether the browser kept it.
 * @param browser - the page's cookies.
 * @param cookieName - the cookie to write.
 * @param token - the token to mirror.
 * @returns true when the read-back shows the token.
 */
function mirrored(browser: GateBrowser, cookieName: string, token: string): boolean {
  browser.writeCookie(cookieName, token)
  return browser.readCookie(cookieName) === token
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
  if (mirrored(browser, cookieName, token)) return
  throw new Error(
    `auth-gate: the browser did not keep the "${cookieName}" cookie`
    + ' — the page is served over plain HTTP, or cookies are blocked for this origin',
  )
}

/**
 * Store one renewed token the way the deployment's own `setToken` stores it:
 * the value exactly as the answer carried it, and the time it was stored beside
 * it, so every deployment page on this origin reads the new token and its true
 * age.
 * @param browser - the page's storage and clock.
 * @param next - the token exactly as the answer carried it.
 */
function writeRenewal(browser: GateBrowser, next: string): void {
  browser.writeStorage(ACCESS_TOKEN_STORAGE_KEY, next)
  browser.writeStorage(ACCESS_TOKEN_TIME_STORAGE_KEY, accessTokenTimestamp(browser.now()))
}

/**
 * Write that pair and report whether the browser took it.
 *
 * A browser that stores nothing — a private window given no quota, a quota
 * already full — throws on the write, and a renewal that could not be stored is a
 * renewal that produced none: the page runs on the token it already had, a
 * periodic attempt asks again on its next tick, and the margin ends at the login
 * page. Raising instead would reject a promise nothing awaits and leave the page
 * with no margin armed at all. The mirror cookie already carries the new token
 * when this fails, so the cookie the reverse proxy reads is ahead of storage
 * until one of those two settles it; both name the same visitor.
 * @param browser - the page's storage and clock.
 * @param next - the token exactly as the answer carried it.
 * @returns true when the pair was stored.
 */
function storedRenewal(browser: GateBrowser, next: string): boolean {
  try {
    writeRenewal(browser, next)
  } catch (_storageRefusedTheWrite) {
    return false
  }
  return true
}

/**
 * Hand the token to the node half, then keep watching for the three things that
 * can change under a running page: another tab's token, this token's expiry,
 * and — where the deployment offers a renewal endpoint — this token's age.
 * @param browser - the page's storage, clock, and navigation.
 * @param settings - the node half's configuration for this browser.
 * @param push - hands one accepted token to the node half.
 * @param revoke - tells the node half to drop the token it holds.
 * @param first - the token this page load runs on.
 * @returns the disposer releasing the subscription, the pending timers, and any
 * renewal in flight.
 */
function watch(
  browser: GateBrowser,
  settings: AuthGateSettings,
  push: (token: string) => void,
  revoke: () => void,
  first: UsableToken,
): () => void {
  const { renewal } = settings
  let current = first
  let cancelExpiry: () => void = LEAVING
  let cancelRenewal: () => void = LEAVING
  let unsubscribe: () => void = LEAVING
  /** Whether this gate has been released, after which nothing it started may act. */
  let released = false
  /**
   * The renewal exchange in progress. One at a time, and shared: a margin that
   * arrives while a periodic attempt is out waits for that attempt's answer
   * rather than starting a second one, or leaving while an answer to the first
   * is still coming.
   */
  let flight: Promise<boolean> | undefined
  // Released with the gate, so a renewal the page no longer needs stops
  // occupying a connection.
  const abort = new AbortController()

  /**
   * Stop everything this gate started: the storage subscription, both timers,
   * and any renewal still out. Idempotent, because the disposer, the sign-out
   * path, and the account switch all call it.
   */
  const release = (): void => {
    if (released) return
    released = true
    unsubscribe()
    cancelExpiry()
    cancelRenewal()
    abort.abort()
  }

  /**
   * Give the token up, release this gate, and send the visitor to the login
   * page.
   *
   * Releasing is what keeps the periodic renewal from undoing the sign-out: the
   * timer would otherwise go on ticking while the navigation is under way, and
   * a tick that renewed would write a token back into storage and the mirror
   * cookie and post it to the node half, for a visitor who has just given one
   * up.
   */
  const giveUp = (): void => {
    release()
    leaveForLogin(browser, settings, revoke)
  }

  /**
   * How long a token may still be run on before its expiry has to be dealt
   * with; zero for one already inside the margin.
   * @param accepted - the token to measure.
   * @returns the delay in milliseconds.
   */
  const marginDelayMs = (accepted: UsableToken): number =>
    expiryDelayMs(accepted.expSeconds, settings.refreshMarginSeconds, browser.now())

  const arm = (accepted: UsableToken): void => {
    current = accepted
    push(accepted.token)
    cancelExpiry()
    // Scheduled with the token it is answering for, so a margin that comes back
    // from a failed renewal can tell whether the page is still running on it.
    cancelExpiry = browser.schedule(marginDelayMs(accepted), () => { void onMargin(accepted) })
    cancelRenewal()
    // Armed from the moment this token was accepted, which is the deployment's
    // own rule — renew once the token it holds is older than the interval —
    // kept as a timer rather than as a check on the next request.
    cancelRenewal = renewal === undefined
      ? LEAVING
      : browser.schedule(renewal.intervalSeconds * 1000, () => { void onPeriodicRenewal(renewal) })
  }

  /**
   * One renewal exchange: ask the deployment for a token, and take the answer
   * as this page's own.
   *
   * An answer is taken only where its `exp` is later than two others: the one
   * the request was sent with, and the one storage holds when the answer
   * arrives. The first rule is what keeps an endpoint that answers with the
   * token it was given from renewing forever — the margin re-arms with no delay
   * on such an answer and asks again immediately. The second is what keeps a
   * slow answer in one tab from replacing a newer token another tab has already
   * stored.
   * @param endpoint - where to ask, and how often this page asks.
   * @returns whether a new token was accepted and armed.
   */
  const renewOnce = async (endpoint: AuthGateRenewalSettings): Promise<boolean> => {
    // Read at the moment of the request rather than taken from `current`: the
    // headers carry the stored value scheme and all, and what is stored now is
    // what this deployment's other pages on this origin are using.
    const raw = browser.readStorage(ACCESS_TOKEN_STORAGE_KEY)
    if (raw === null) return false
    // Never renew a token that is already gone or already dead. The endpoint
    // refuses a dead one, and the margin timer is where that case ends, at the
    // login page.
    const held = usableToken(storedToken(raw), browser.now())
    if (held === undefined) return false
    let answer: unknown
    try {
      answer = await browser.requestJson(
        endpoint.path,
        renewalHeaders(raw, browser.readStorage(LOGIN_USER_INFO_STORAGE_KEY), browser.requestId()),
        abort.signal,
      )
    } catch (_renewalDidNotAnswer) {
      // Every way the exchange can fail is the same fact to the caller: this
      // attempt produced no token. A refusal, a body that is not JSON, a dropped
      // connection, and the abort this gate's own disposal sends all land here.
      // The error itself is not reported: a `fetch` that refuses a header value
      // names that value, and two of these headers are the credential.
      return false
    }
    if (released) return false
    const next = parseRenewalAnswer(answer)
    if (next === undefined) return false
    const accepted = usableToken(storedToken(next), browser.now())
    if (accepted === undefined) return false
    // An answer that does not move the expiry is no renewal, whatever the
    // endpoint meant by it.
    if (accepted.expSeconds <= held.expSeconds) return false
    // Every tab renews on its own schedule, so an answer can arrive after
    // another tab has stored a later one; that one stays.
    const stored = usableToken(heldToken(browser), browser.now())
    if (stored !== undefined && stored.expSeconds > accepted.expSeconds) return false
    // The cookie first, so nothing is stored until the mirror the reverse proxy
    // reads carries the same token. A write that did not take leaves this page
    // on the token it already had, which the margin still ends.
    if (!mirrored(browser, settings.cookieName, accepted.token)) return false
    if (!storedRenewal(browser, next)) return false
    arm(accepted)
    return true
  }

  /**
   * The one renewal in flight, started where there is none.
   * @param endpoint - where to ask, and how often this page asks.
   * @returns whether that exchange accepted a new token.
   */
  const renew = async (endpoint: AuthGateRenewalSettings): Promise<boolean> => {
    // A timer dequeued before this gate was released still runs after it; a
    // tick that arrives here stops before it puts a request on the wire.
    if (released) return false
    flight ??= renewOnce(endpoint)
    try {
      return await flight
    } finally {
      flight = undefined
    }
  }

  /**
   * What the gate does when the token is about to expire: renew it where the
   * deployment offers a way to, and otherwise — or when that fails — send the
   * visitor back through the login page, which is the one renewal route every
   * deployment has.
   *
   * A renewed token that is itself already inside the margin ends the same way.
   * Its own margin timer is armed with no delay, so renewing from the margin a
   * second time would ask again in the same tick and go on doing so for as long
   * as the endpoint kept answering. The login page is this gate's answer to a
   * deployment whose renewal does not outrun its own `refreshMarginSeconds`.
   *
   * Each margin answers for the token it was armed with, and only for that one.
   * A renewal takes time, and a token that arrived while one was out — another
   * tab's, an embedded deployment page's, this visitor signing in again — armed
   * a margin of its own, so a failure here says nothing about the token the page
   * is now running on. Giving that one up would sign a visitor out over a
   * credential hours from expiry.
   * @param armedFor - the token this margin was scheduled against.
   * @returns nothing, once the token has been renewed or given up.
   */
  const onMargin = async (armedFor: UsableToken): Promise<void> => {
    if (renewal !== undefined && await renew(renewal) && marginDelayMs(current) > 0) return
    // A gate released while the renewal was out has no page to send anywhere.
    if (released) return
    // The token in hand is another one, and it is not itself inside the margin:
    // its own timer owns the expiry from here.
    if (current !== armedFor && marginDelayMs(current) > 0) return
    giveUp()
  }

  /**
   * What the gate does when the token it holds reaches the renewal interval:
   * ask for a new one, silently.
   * @param endpoint - where to ask, and how often this page asks.
   * @returns nothing, once the token has been renewed or the next attempt armed.
   */
  const onPeriodicRenewal = async (endpoint: AuthGateRenewalSettings): Promise<void> => {
    // A success re-arms both timers through `arm`.
    if (await renew(endpoint)) return
    if (released) return
    // Silent: the token this page holds is still usable — the margin timer is
    // where the case it is not ends — so the page goes on and the next tick
    // asks again. Cancelling first, because a storage change during the attempt
    // can have armed one already, and two of these would double the rate for
    // good.
    cancelRenewal()
    cancelRenewal = browser.schedule(
      endpoint.intervalSeconds * 1000,
      () => { void onPeriodicRenewal(endpoint) },
    )
  }

  arm(first)

  unsubscribe = browser.onStorageChanged(() => {
    const change = decideChange(heldToken(browser), current.token, browser.now())
    if (change.kind === 'login') {
      giveUp()
      return
    }
    mirror(browser, settings.cookieName, change.accepted.token)
    if (change.kind === 'reload') {
      // Released before the reload for the reason the sign-out path releases
      // before the navigation: a renewal still out for the previous account
      // would otherwise land while the browser is tearing this document down
      // and write that account's token into storage, into the mirror the whole
      // origin reads, and into the node half, so the document coming up would
      // boot as the person who just left.
      release()
      browser.reload()
      return
    }
    arm(change.accepted)
  })

  return release
}
