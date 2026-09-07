/**
 * The gate as it runs in a page: the boot sequence over a fake browser, the
 * mirror that reloads exactly once and the one that refuses to loop, the
 * account switch, the expiry schedule, the renewal a deployment that offers one
 * gets, the real `window`-backed browser against stubbed globals, and the plugin
 * body that reads its settings before running any of it.
 *
 * The fake browser is what makes the reload count observable at all: a real one
 * would have navigated away before the assertion.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import {
  clearCookieLine,
  mirrorCookieLine,
  readCookieFrom,
  storedToken,
  windowGateBrowser,
  type GateBrowser,
} from '../src/client/browser.ts'
import { runGate } from '../src/client/run.ts'
import {
  ACCESS_TOKEN_STORAGE_KEY,
  ACCESS_TOKEN_TIME_STORAGE_KEY,
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  LOGIN_USER_INFO_STORAGE_KEY,
  MAX_TIMER_DELAY_MS,
  type AuthGateSettings,
} from '../src/route.ts'

const NOW = 1_800_000_000_000
const SETTINGS: AuthGateSettings = { loginUrl: '/toy-login/#/', cookieName: 'accessToken', refreshMarginSeconds: 300 }
/** The path a deployment that renews configures, and how often it is asked. */
const RENEWAL_PATH = '/toy-proxy/ini-server/nrms-auth/api/renewal'
const RENEWAL_INTERVAL_SECONDS = 1800
/** The same deployment, with its renewal endpoint configured. */
const RENEWING: AuthGateSettings = {
  ...SETTINGS,
  renewal: { path: RENEWAL_PATH, intervalSeconds: RENEWAL_INTERVAL_SECONDS },
}
const ORIGIN = 'https://harness.example'
const HREF = `${ORIGIN}/chat`
const LOGIN = `/toy-login/#/?redirect=${encodeURIComponent(HREF)}`

/** Base64url-encode one JSON value the way a JWT carries a segment. */
function segment(value: unknown): string {
  const utf8 = String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value)))
  return btoa(utf8).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** One JWT-shaped token for `sub`, alive for `lifetimeSeconds`. */
function jwt(sub: string, lifetimeSeconds: number): string {
  return `${segment({ alg: 'none' })}.${segment({ sub, exp: NOW / 1000 + lifetimeSeconds })}.c2ln`
}

const LIVE = jwt('u-1', 3600)
const RENEWED = jwt('u-1', 7200)
/** Later still, as the token another tab renewed to while this one was waiting. */
const LATEST = jwt('u-1', 10_800)
const OTHER = jwt('u-2', 3600)
const STALE = jwt('u-1', -1)
/** Inside `refreshMarginSeconds` already, so the margin is armed with no delay. */
const NEAR_MARGIN = jwt('u-1', 60)
/** Later than {@link NEAR_MARGIN} and still inside that margin. */
const NEAR_MARGIN_NEWER = jwt('u-1', 120)

/** One renewal request the gate sent, as the assertions read it. */
interface RenewalRequest {
  path: string
  headers: Record<string, string>
  signal: AbortSignal
}

/** A browser whose every effect is recorded rather than performed. */
class Bench implements GateBrowser {
  readonly storage = new Map<string, string>()
  readonly cookies = new Map<string, string>()
  /** Whether a cookie write is kept, as a browser refusing `Secure` over plain HTTP would not. */
  cookieWritesTake = true
  /** Whether a storage write throws, as one out of quota or in a private window with none does. */
  storageWritesThrow = false
  readonly navigations: string[] = []
  /**
   * Every effect the gate performed, in order, so the sign-out sequence is
   * assertable as a sequence rather than as three independent facts.
   */
  readonly log: string[] = []
  reloads = 0
  readonly timers: { delayMs: number; run: () => void }[] = []
  cancelledTimers = 0
  readonly renewals: RenewalRequest[] = []
  /** What the deployment's renewal endpoint answers; refusing is the default. */
  renewalAnswer: () => Promise<unknown> = () => Promise.reject(new Error('bench: no renewal endpoint'))
  private requestIds = 0
  private listener: (() => void) | undefined

  /** The access token, which most cases set and read as one value. */
  get token(): string | null {
    return this.storage.get(ACCESS_TOKEN_STORAGE_KEY) ?? null
  }

  set token(next: string | null) {
    if (next === null) this.storage.delete(ACCESS_TOKEN_STORAGE_KEY)
    else this.storage.set(ACCESS_TOKEN_STORAGE_KEY, next)
  }

  now(): number {
    return NOW
  }

  currentHref(): string {
    return HREF
  }

  readStorage(key: string): string | null {
    return this.storage.get(key) ?? null
  }

  writeStorage(key: string, value: string): void {
    if (this.storageWritesThrow) throw new Error('bench: this browser stores nothing')
    this.storage.set(key, value)
    this.log.push(`writeStorage:${key}`)
  }

  requestId(): string {
    this.requestIds += 1
    return `r-${String(this.requestIds)}`
  }

  async requestJson(path: string, headers: Record<string, string>, signal: AbortSignal): Promise<unknown> {
    this.renewals.push({ path, headers, signal })
    return await this.renewalAnswer()
  }

  readCookie(name: string): string | undefined {
    return this.cookies.get(name)
  }

  writeCookie(name: string, value: string): void {
    if (this.cookieWritesTake) this.cookies.set(name, value)
  }

  clearCookie(name: string): void {
    this.cookies.delete(name)
    this.log.push(`clearCookie:${name}`)
  }

  navigate(url: string): void {
    this.navigations.push(url)
    this.log.push(`navigate:${url}`)
  }

  reload(): void {
    this.reloads += 1
  }

  onStorageChanged(listener: () => void): () => void {
    this.listener = listener
    return () => { this.listener = undefined }
  }

  schedule(delayMs: number, run: () => void): () => void {
    this.timers.push({ delayMs, run })
    return () => { this.cancelledTimers += 1 }
  }

  /** Whether a storage subscription is currently installed. */
  get subscribed(): boolean {
    return this.listener !== undefined
  }

  /** Another tab wrote `next`; deliver the change the way the browser would. */
  storageWrote(next: string | null): void {
    this.token = next
    this.listener?.()
  }
}

/** Run the gate over a bench prepared with `token` already in the cookie jar. */
function boot(bench: Bench, settings: AuthGateSettings = SETTINGS): { dispose: () => void; pushed: string[] } {
  const pushed: string[] = []
  const dispose = runGate(
    bench,
    settings,
    token => pushed.push(token),
    () => { bench.log.push('revoke') },
  )
  return { dispose, pushed }
}

/**
 * Let every promise the gate is waiting on settle. A macrotask, so the whole
 * microtask queue behind one renewal answer has run by the time it resolves.
 * @returns nothing, once the queue is empty.
 */
function settled(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

/** The sign-out sequence, in the one order it is allowed to happen in. */
const SIGN_OUT = ['revoke', 'clearCookie:accessToken', `navigate:${LOGIN}`]

describe('auth-gate boot', () => {
  it('sends a visitor with no token to the login page, carrying where they were', () => {
    const bench = new Bench()
    const { pushed } = boot(bench)
    expect(bench.navigations).toEqual([LOGIN])
    expect({ reloads: bench.reloads, cookies: bench.cookies.size, pushed }).toEqual({
      reloads: 0, cookies: 0, pushed: [],
    })
    // The order is the contract: the node half stops spending the token first,
    // the mirror stops presenting it to the reverse proxy second, and only then
    // does the page leave.
    expect(bench.log).toEqual(SIGN_OUT)
  })

  it('sends a visitor whose token ran out to the login page', () => {
    const bench = new Bench()
    bench.token = STALE
    boot(bench)
    expect(bench.log).toEqual(SIGN_OUT)
  })

  it('mirrors a token the cookie does not carry, then reloads exactly once', () => {
    const bench = new Bench()
    bench.token = LIVE
    const { pushed } = boot(bench)
    expect(bench.cookies.get('accessToken')).toBe(LIVE)
    // Nothing is handed to the host on this pass: the page is about to restart.
    expect({ reloads: bench.reloads, navigations: bench.navigations, pushed }).toEqual({
      reloads: 1, navigations: [], pushed: [],
    })

    // The reload the browser would now perform, replayed: the cookie agrees, so
    // this pass runs the page instead of mirroring again. That is the whole
    // loop guard.
    const second = boot(bench)
    expect({ reloads: bench.reloads, pushed: second.pushed }).toEqual({ reloads: 1, pushed: [LIVE] })
  })

  it('fails the row rather than reloading forever when the cookie write does not take', () => {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookieWritesTake = false
    expect(() => boot(bench)).toThrow(/did not keep the "accessToken" cookie/)
    // The one thing that must not happen: a reload into a boot that decides to
    // mirror again.
    expect(bench.reloads).toBe(0)
  })

  it('names no token in the cookie-write failure', () => {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookieWritesTake = false
    expect(() => boot(bench)).toThrow(expect.not.stringContaining(LIVE))
  })

  it('hands a token the cookie already carries to the host and never reloads', () => {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookies.set('accessToken', LIVE)
    const { pushed } = boot(bench)
    expect({ reloads: bench.reloads, navigations: bench.navigations, pushed }).toEqual({
      reloads: 0, navigations: [], pushed: [LIVE],
    })
  })

  it('schedules the expiry margin ahead of the token\'s own expiry', () => {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookies.set('accessToken', LIVE)
    boot(bench)
    expect(bench.timers.map(timer => timer.delayMs)).toEqual([(3600 - 300) * 1000])
  })

  it('sends the visitor back to the login page when the margin is reached', () => {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookies.set('accessToken', LIVE)
    boot(bench)
    bench.timers[0]?.run()
    // An expiring token is given up the same way a missing one is: the process
    // must not go on spending a credential that is about to be refused.
    expect(bench.log).toEqual(SIGN_OUT)
    expect(bench.cookies.has('accessToken')).toBe(false)
  })
})

describe('auth-gate while the page runs', () => {
  /** A running gate on `LIVE`, already handed to the host. */
  function running(): { bench: Bench; pushed: string[]; dispose: () => void } {
    const bench = new Bench()
    bench.token = LIVE
    bench.cookies.set('accessToken', LIVE)
    const { pushed, dispose } = boot(bench)
    return { bench, pushed, dispose }
  }

  it('mirrors and hands over a renewed token for the same person, without reloading', () => {
    const { bench, pushed } = running()
    bench.storageWrote(RENEWED)
    expect(bench.cookies.get('accessToken')).toBe(RENEWED)
    expect({ pushed, reloads: bench.reloads }).toEqual({ pushed: [LIVE, RENEWED], reloads: 0 })
    // The old schedule is cancelled and a new one armed against the new expiry.
    expect({ cancelled: bench.cancelledTimers, delays: bench.timers.map(timer => timer.delayMs) })
      .toEqual({ cancelled: 1, delays: [(3600 - 300) * 1000, (7200 - 300) * 1000] })
  })

  it('reloads the whole page when a different person signs in', () => {
    const { bench, pushed } = running()
    bench.storageWrote(OTHER)
    // The cookie is mirrored first, so the reload's own request already
    // identifies the new person.
    expect(bench.cookies.get('accessToken')).toBe(OTHER)
    expect({ pushed, reloads: bench.reloads }).toEqual({ pushed: [LIVE], reloads: 1 })
  })

  it('sends the visitor to the login page when the token is removed elsewhere', () => {
    const { bench } = running()
    bench.storageWrote(null)
    expect({ log: bench.log, reloads: bench.reloads }).toEqual({ log: SIGN_OUT, reloads: 0 })
    // A tab that signed out must not leave the mirror behind for the next
    // request this tab makes.
    expect(bench.cookies.has('accessToken')).toBe(false)
  })

  it('releases the storage subscription and the pending expiry on disposal (HMR safety)', () => {
    const { bench, dispose, pushed } = running()
    dispose()
    expect({ subscribed: bench.subscribed, cancelled: bench.cancelledTimers })
      .toEqual({ subscribed: false, cancelled: 1 })
    expect(pushed).toEqual([LIVE])
  })

  it('installs no subscription at all for a page that is leaving', () => {
    const bench = new Bench()
    const { dispose } = boot(bench)
    dispose()
    expect({ subscribed: bench.subscribed, cancelled: bench.cancelledTimers })
      .toEqual({ subscribed: false, cancelled: 0 })
  })
})

describe('auth-gate renewal', () => {
  /** The stored form of a token, which is what the login page and the endpoint both write. */
  function stored(token: string): string {
    return `Bearer ${token}`
  }

  /** A running gate on `LIVE`, in a deployment that offers a renewal endpoint. */
  function renewing(): { bench: Bench; pushed: string[]; dispose: () => void } {
    const bench = new Bench()
    bench.token = stored(LIVE)
    bench.cookies.set('accessToken', LIVE)
    const { pushed, dispose } = boot(bench, RENEWING)
    return { bench, pushed, dispose }
  }

  /** The renewal timer currently armed, which is always the last one scheduled. */
  function nextRenewal(bench: Bench): { delayMs: number; run: () => void } | undefined {
    return bench.timers.at(-1)
  }

  it('arms the renewal beside the expiry, from the moment the token was accepted', () => {
    const { bench } = renewing()
    expect(bench.timers.map(timer => timer.delayMs))
      .toEqual([(3600 - 300) * 1000, RENEWAL_INTERVAL_SECONDS * 1000])
  })

  it('renews in place: the endpoint is asked as the deployment asks it, and nothing navigates', async () => {
    const { bench, pushed } = renewing()
    bench.storage.set(LOGIN_USER_INFO_STORAGE_KEY, JSON.stringify({ tenant: 'acme' }))
    bench.renewalAnswer = () => Promise.resolve({ code: 0, token: stored(RENEWED) })
    bench.timers[1]?.run()
    await settled()

    // The stored value on both token headers, the deployment's own stored header
    // table under them, and a fresh request id: what its own client sends.
    expect(bench.renewals).toEqual([{
      path: RENEWAL_PATH,
      headers: {
        tenant: 'acme',
        Authorization: stored(LIVE),
        CertificationToken: stored(LIVE),
        'TINY-REQUEST-ID': 'r-1',
      },
      signal: expect.anything() as AbortSignal,
    }])
    // Stored the way the deployment's own `setToken` stores it, so its pages on
    // this origin read the new token and its true age.
    expect({
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      time: bench.storage.get(ACCESS_TOKEN_TIME_STORAGE_KEY),
      cookie: bench.cookies.get('accessToken'),
    }).toEqual({
      token: stored(RENEWED),
      time: new Date(NOW).toISOString(),
      cookie: RENEWED,
    })
    // The page stays where it is, and the node half is handed the new token.
    expect({ pushed, reloads: bench.reloads, navigations: bench.navigations })
      .toEqual({ pushed: [LIVE, RENEWED], reloads: 0, navigations: [] })
    // Both schedules are re-armed against the token now in hand.
    expect(bench.timers.map(timer => timer.delayMs)).toEqual([
      (3600 - 300) * 1000,
      RENEWAL_INTERVAL_SECONDS * 1000,
      (7200 - 300) * 1000,
      RENEWAL_INTERVAL_SECONDS * 1000,
    ])
  })

  it('keeps a failed periodic attempt silent, and asks again on the next tick', async () => {
    const { bench } = renewing()
    bench.timers[1]?.run()
    await settled()
    // Nothing on screen, nothing given up: the token in hand is still usable,
    // and the margin owns the case where it is not.
    expect({ log: bench.log, navigations: bench.navigations, reloads: bench.reloads })
      .toEqual({ log: [], navigations: [], reloads: 0 })
    expect(nextRenewal(bench)?.delayMs).toBe(RENEWAL_INTERVAL_SECONDS * 1000)

    bench.renewalAnswer = () => Promise.resolve({ token: stored(RENEWED) })
    nextRenewal(bench)?.run()
    await settled()
    expect(bench.cookies.get('accessToken')).toBe(RENEWED)
  })

  it('renews at the expiry margin instead of sending the visitor back through the login page', async () => {
    const { bench, pushed } = renewing()
    bench.renewalAnswer = () => Promise.resolve({ token: stored(RENEWED) })
    bench.timers[0]?.run()
    await settled()
    expect({ log: bench.log, navigations: bench.navigations }).toEqual({ log: ['writeStorage:accessToken', 'writeStorage:accessTokenTime'], navigations: [] })
    expect({ cookie: bench.cookies.get('accessToken'), pushed }).toEqual({ cookie: RENEWED, pushed: [LIVE, RENEWED] })
  })

  it('falls back to the login page when the renewal at the margin fails', async () => {
    const { bench } = renewing()
    bench.timers[0]?.run()
    await settled()
    // The one exit every deployment has, taken exactly as it is without a
    // renewal endpoint.
    expect(bench.log).toEqual(SIGN_OUT)
    expect(bench.cookies.has('accessToken')).toBe(false)
  })

  it('never asks with a token that has already run out, or with none at all', async () => {
    const { bench } = renewing()
    bench.token = stored(STALE)
    bench.timers[1]?.run()
    await settled()
    bench.token = null
    nextRenewal(bench)?.run()
    await settled()
    // A dead token buys nothing at the endpoint, and the margin owns that case.
    expect(bench.renewals).toEqual([])
  })

  it('keeps the token it has when the answer carries no usable one', async () => {
    const { bench } = renewing()
    for (const answer of [null, 'not a document', { code: 2, msg: 'refused' }, { token: 7 }, { token: 'not-a-jwt' }, { token: stored(STALE) }]) {
      bench.renewalAnswer = () => Promise.resolve(answer)
      nextRenewal(bench)?.run()
      await settled()
    }
    expect({ token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY), cookie: bench.cookies.get('accessToken') })
      .toEqual({ token: stored(LIVE), cookie: LIVE })
  })

  it('stores nothing when the browser does not keep the renewed mirror', async () => {
    const { bench } = renewing()
    bench.renewalAnswer = () => Promise.resolve({ token: stored(RENEWED) })
    bench.cookieWritesTake = false
    bench.timers[1]?.run()
    await settled()
    // The cookie the reverse proxy reads and the stored token never disagree:
    // the page runs on the token it already had until the margin ends it.
    expect({ token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY), cookie: bench.cookies.get('accessToken') })
      .toEqual({ token: stored(LIVE), cookie: LIVE })
  })

  it('leaves exactly one renewal armed when another tab signs in during a failed attempt', async () => {
    const { bench } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[1]?.run()
    await settled()
    // The same person, a newer token, from another tab: this arms both
    // schedules against it while the attempt is still out.
    bench.storageWrote(stored(RENEWED))
    answer?.({ nothing: 'usable' })
    await settled()
    // Five armed and three cancelled: the failed attempt's retry replaces the
    // renewal that arrival armed rather than running beside it for good.
    expect({ armed: bench.timers.length, cancelled: bench.cancelledTimers })
      .toEqual({ armed: 5, cancelled: 3 })
  })

  it('renews once at a time, and a margin arriving during one waits for its answer', async () => {
    const { bench, pushed } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[1]?.run()
    await settled()
    bench.timers[0]?.run()
    await settled()
    expect(bench.renewals).toHaveLength(1)

    answer?.({ token: stored(RENEWED) })
    await settled()
    // The margin left for nowhere: the renewal it waited for is the one that
    // landed.
    expect({ navigations: bench.navigations, cookie: bench.cookies.get('accessToken'), pushed })
      .toEqual({ navigations: [], cookie: RENEWED, pushed: [LIVE, RENEWED] })
  })

  it('acts on nothing a renewal answers after the gate was released, and aborts the request', async () => {
    const { bench, dispose } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[0]?.run()
    await settled()
    dispose()
    expect(bench.renewals[0]?.signal.aborted).toBe(true)

    answer?.({ token: stored(RENEWED) })
    await settled()
    // Neither the token this page no longer runs on, nor the navigation the
    // margin would otherwise have made.
    expect({ navigations: bench.navigations, token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY) })
      .toEqual({ navigations: [], token: stored(LIVE) })
  })

  it('arms no further attempt once the gate is released mid-attempt', async () => {
    const { bench, dispose } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[1]?.run()
    await settled()
    const armed = bench.timers.length
    dispose()

    answer?.({ token: stored(RENEWED) })
    await settled()
    expect({ timers: bench.timers.length, token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY) })
      .toEqual({ timers: armed, token: stored(LIVE) })
  })

  it('releases the gate before reloading for another person, so a renewal in flight cannot land', async () => {
    const { bench, pushed } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[1]?.run()
    await settled()
    // Somebody else signed in on this origin while this tab's renewal was out.
    bench.storageWrote(OTHER)
    expect({
      reloads: bench.reloads,
      subscribed: bench.subscribed,
      aborted: bench.renewals[0]?.signal.aborted,
      armed: bench.timers.length,
      cancelled: bench.cancelledTimers,
    }).toEqual({ reloads: 1, subscribed: false, aborted: true, armed: 2, cancelled: 2 })

    answer?.({ token: stored(RENEWED) })
    await settled()
    // The reload takes time, and the previous account's renewed token must
    // reach none of the three places the document coming up reads its identity
    // from: storage, the mirror this whole origin carries, and the node half.
    expect({
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      cookie: bench.cookies.get('accessToken'),
      pushed,
      armed: bench.timers.length,
    }).toEqual({ token: OTHER, cookie: OTHER, pushed: [LIVE], armed: 2 })
  })

  it('asks once and leaves when the endpoint answers with the token it was given', async () => {
    const { bench } = renewing()
    bench.renewalAnswer = () => Promise.resolve({ token: stored(LIVE) })
    bench.timers[0]?.run()
    await settled()
    // An answer that does not move the expiry re-arms the margin with no delay,
    // so taking it would ask again in the same tick, without end.
    expect({ asked: bench.renewals.length, log: bench.log }).toEqual({ asked: 1, log: SIGN_OUT })
  })

  it('asks once and leaves when the token it renewed to is itself inside the margin', async () => {
    const bench = new Bench()
    bench.token = stored(NEAR_MARGIN)
    bench.cookies.set('accessToken', NEAR_MARGIN)
    boot(bench, RENEWING)
    bench.renewalAnswer = () => Promise.resolve({ token: stored(NEAR_MARGIN_NEWER) })
    // A token this close to `exp` arms the margin with no delay, and so does the
    // later one the endpoint answers with: a deployment whose renewal does not
    // outrun its own margin renews here for good unless the margin stops.
    expect(bench.timers[0]?.delayMs).toBe(0)
    bench.timers[0]?.run()
    await settled()
    expect({ asked: bench.renewals.length, log: bench.log.slice(-3) }).toEqual({ asked: 1, log: SIGN_OUT })
  })

  it('renews nothing once the margin has given the token up, however the endpoint recovers', async () => {
    const { bench, pushed, dispose } = renewing()
    bench.timers[0]?.run()
    await settled()
    expect(bench.log).toEqual(SIGN_OUT)
    const asked = bench.renewals.length

    // The periodic timer was dequeued before the gate gave the token up, so it
    // still runs; renewing from it would put the cookie, the stored token, and
    // the node half's copy back for a visitor who has just signed out.
    bench.renewalAnswer = () => Promise.resolve({ token: stored(RENEWED) })
    bench.timers[1]?.run()
    await settled()
    expect({
      asked: bench.renewals.length,
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      cookie: bench.cookies.get('accessToken'),
      pushed,
    }).toEqual({ asked, token: stored(LIVE), cookie: undefined, pushed: [LIVE] })

    // And the disposer finds the gate already released, with nothing left to stop.
    const cancelled = bench.cancelledTimers
    dispose()
    expect(bench.cancelledTimers).toBe(cancelled)
  })

  it('signs the visitor out of nothing when a later token arrived while the margin renewal was out', async () => {
    const { bench, pushed } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[0]?.run()
    await settled()
    // Another tab renewed, or an embedded deployment page did, or the visitor
    // signed in again: this tab takes that token and arms a margin of its own.
    bench.storageWrote(stored(LATEST))

    answer?.({ nothing: 'usable' })
    await settled()
    // The margin was answering for the token this page no longer runs on.
    // Leaving here would give up a credential hours from its expiry, revoke it
    // at the node half, and clear the mirror the whole origin reads.
    expect({
      log: bench.log,
      navigations: bench.navigations,
      cookie: bench.cookies.get('accessToken'),
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      pushed,
    }).toEqual({ log: [], navigations: [], cookie: LATEST, token: stored(LATEST), pushed: [LIVE, LATEST] })
  })

  it('stays where it is when a margin answer is older than the token that arrived meanwhile', async () => {
    const { bench, pushed } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[0]?.run()
    await settled()
    bench.storageWrote(stored(LATEST))

    // Later than the token the request was sent with and earlier than the one
    // that arrived meanwhile, so the answer is refused — and the token that
    // refusal would have given up is the newer one.
    answer?.({ token: stored(RENEWED) })
    await settled()
    expect({
      log: bench.log,
      navigations: bench.navigations,
      cookie: bench.cookies.get('accessToken'),
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      pushed,
    }).toEqual({ log: [], navigations: [], cookie: LATEST, token: stored(LATEST), pushed: [LIVE, LATEST] })
  })

  it('takes a storage write the browser refuses as a renewal that produced nothing', async () => {
    const { bench, pushed } = renewing()
    bench.renewalAnswer = () => Promise.resolve({ token: stored(RENEWED) })
    bench.storageWritesThrow = true
    bench.timers[0]?.run()
    await settled()
    // A browser that stores nothing throws on the write. The renewal produced no
    // token the deployment's pages can read, so the margin ends where it ends
    // without an endpoint at all, rather than rejecting a promise nothing awaits
    // and leaving the page with no schedule.
    expect({ log: bench.log, token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY), pushed })
      .toEqual({ log: SIGN_OUT, token: stored(LIVE), pushed: [LIVE] })
  })

  it('keeps the later token another tab stored while this attempt was out', async () => {
    const { bench, pushed } = renewing()
    let answer: ((value: unknown) => void) | undefined
    bench.renewalAnswer = () => new Promise((resolve) => { answer = resolve })
    bench.timers[1]?.run()
    await settled()
    // Another tab's own renewal landed first. Written without the `storage`
    // event, which a browser delivers on its own schedule: the answer below can
    // arrive before this tab has been told.
    bench.storage.set(ACCESS_TOKEN_STORAGE_KEY, stored(LATEST))

    answer?.({ token: stored(RENEWED) })
    await settled()
    expect({
      token: bench.storage.get(ACCESS_TOKEN_STORAGE_KEY),
      cookie: bench.cookies.get('accessToken'),
      pushed,
    }).toEqual({ token: stored(LATEST), cookie: LIVE, pushed: [LIVE] })
  })
})

describe('auth-gate cookie handling', () => {
  it('finds one cookie among the others a page carries', () => {
    const jar = 'other=1; accessToken=a.b.c; trailing=2'
    expect(readCookieFrom(jar, 'accessToken')).toBe('a.b.c')
    expect(readCookieFrom(jar, 'absent')).toBeUndefined()
  })

  it('reads back a value the write encoded', () => {
    expect(readCookieFrom('accessToken=a%20b', 'accessToken')).toBe('a b')
  })

  it('ignores a jar entry that is not a name=value pair', () => {
    expect(readCookieFrom('novalue; accessToken=x', 'accessToken')).toBe('x')
  })

  it('mirrors for the deployment path, over TLS, and not on cross-site subrequests', () => {
    expect(mirrorCookieLine('accessToken', 'a.b.c', '/')).toBe('accessToken=a.b.c; Path=/; Secure; SameSite=Lax')
    // Behind a path-prefixed reverse proxy the mirror narrows to that prefix,
    // which is still on every request this page makes.
    expect(mirrorCookieLine('accessToken', 'a.b.c', '/console/'))
      .toBe('accessToken=a.b.c; Path=/console/; Secure; SameSite=Lax')
  })

  it('removes the mirror with the attributes it was written under', () => {
    // A browser matches a removal by name, path, and domain: an attribute that
    // differs from the mirror's writes a second, empty cookie and leaves the
    // token in place.
    expect(clearCookieLine('accessToken', '/')).toBe('accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0')
    const [mirrored, cleared] = [
      mirrorCookieLine('accessToken', 'a.b.c', '/console/'),
      clearCookieLine('accessToken', '/console/'),
    ]
    expect(cleared.startsWith(`accessToken=; ${mirrored.slice('accessToken=a.b.c; '.length)}`)).toBe(true)
  })
})

describe('auth-gate stored token', () => {
  it('drops the scheme the deployment\'s login page stores with the token', () => {
    // That page writes what its own HTTP client puts into the `Authorization`
    // header verbatim; everything downstream of the gate carries the bare JWT.
    for (const raw of ['Bearer a.b.c', 'bearer a.b.c', 'BEARER a.b.c', 'Bearer    a.b.c']) {
      expect(storedToken(raw)).toBe('a.b.c')
    }
  })

  it('tolerates whitespace around the scheme rather than the login page\'s exact spacing', () => {
    for (const raw of ['Bearer\ta.b.c', ' Bearer a.b.c', '\n Bearer \t a.b.c']) {
      expect(storedToken(raw)).toBe('a.b.c')
    }
  })

  it('returns a bare token and an empty store unchanged', () => {
    expect(storedToken('a.b.c')).toBe('a.b.c')
    expect(storedToken(null)).toBeNull()
    // Only the scheme at the front, and only when whitespace follows it.
    expect(storedToken('Bearera.b.c')).toBe('Bearera.b.c')
    expect(storedToken('a.b.Bearer c')).toBe('a.b.Bearer c')
  })

  it('leaves a repeated scheme in place, so the gate refuses it rather than spending it', () => {
    // A JWT carries no whitespace, so what survives here fails `isJwtShaped` and
    // sends the visitor to the login page.
    expect(storedToken('Bearer Bearer a.b.c')).toBe('Bearer a.b.c')
  })

  it('is idempotent, so a value already stripped survives a second pass', () => {
    for (const raw of ['Bearer a.b.c', 'a.b.c', null]) {
      expect(storedToken(storedToken(raw))).toBe(storedToken(raw))
    }
  })
})

describe('auth-gate window browser', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /** Stub the globals the real browser reads, and report what it wrote. */
  function stubPage(cookie: string, token: string | null): {
    written: string[]
    navigations: string[]
    reloads: number[]
    listeners: Map<string, (event: StorageEvent) => void>
    stored: Map<string, string>
  } {
    const written: string[] = []
    const navigations: string[] = []
    const reloads: number[] = []
    const listeners = new Map<string, (event: StorageEvent) => void>()
    const stored = new Map<string, string>()
    if (token !== null) stored.set(ACCESS_TOKEN_STORAGE_KEY, token)
    vi.stubGlobal('document', {
      get cookie() { return cookie },
      set cookie(value: string) { written.push(value) },
    })
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    })
    vi.stubGlobal('location', {
      href: HREF,
      origin: ORIGIN,
      reload: () => { reloads.push(1) },
    })
    vi.stubGlobal('addEventListener', (type: string, listener: (event: StorageEvent) => void) => {
      listeners.set(type, listener)
    })
    vi.stubGlobal('removeEventListener', (type: string) => { listeners.delete(type) })
    // `location.href = url` writes the stub's own property; record it instead.
    const target = globalThis as unknown as { location: { href: string } }
    Object.defineProperty(target.location, 'href', {
      get: () => HREF,
      set: (value: string) => { navigations.push(value) },
    })
    return { written, navigations, reloads, listeners, stored }
  }

  it('reads the token and the mirror cookie off the page', () => {
    stubPage('accessToken=a.b.c', LIVE)
    const browser = windowGateBrowser()
    expect(browser.readStorage(ACCESS_TOKEN_STORAGE_KEY)).toBe(LIVE)
    expect(browser.readCookie('accessToken')).toBe('a.b.c')
    expect(browser.currentHref()).toBe(HREF)
    expect(browser.now()).toBeGreaterThan(0)
  })

  it('reads every stored value the deployment shares with this page, and writes one back', () => {
    // One storage seam: the token, the time it was stored, and the header table
    // the deployment's own client sends are all values its pages wrote.
    const page = stubPage('', `Bearer ${LIVE}`)
    const browser = windowGateBrowser()
    // The scheme the login page stored the token under is dropped above this
    // seam, which is why the raw value comes back here.
    expect(storedToken(browser.readStorage(ACCESS_TOKEN_STORAGE_KEY))).toBe(LIVE)
    expect(browser.readStorage(LOGIN_USER_INFO_STORAGE_KEY)).toBeNull()
    browser.writeStorage(ACCESS_TOKEN_TIME_STORAGE_KEY, '2027-01-15T08:00:00.000Z')
    expect(page.stored.get(ACCESS_TOKEN_TIME_STORAGE_KEY)).toBe('2027-01-15T08:00:00.000Z')
  })

  it('writes and removes the mirror cookie, navigates, and reloads through the page itself', () => {
    const page = stubPage('', null)
    const browser = windowGateBrowser()
    browser.writeCookie('accessToken', 'a.b.c')
    browser.clearCookie('accessToken')
    browser.navigate('/toy-login/#/?redirect=x')
    browser.reload()
    expect(page.written).toEqual([
      'accessToken=a.b.c; Path=/; Secure; SameSite=Lax',
      'accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0',
    ])
    expect(page.navigations).toEqual(['/toy-login/#/?redirect=x'])
    expect(page.reloads).toEqual([1])
  })

  it('scopes the mirror to the deployment prefix the shell is served under', () => {
    const page = stubPage('', null)
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const browser = windowGateBrowser()
    browser.writeCookie('accessToken', 'a.b.c')
    browser.clearCookie('accessToken')
    expect(page.written).toEqual([
      'accessToken=a.b.c; Path=/console/; Secure; SameSite=Lax',
      'accessToken=; Path=/console/; Secure; SameSite=Lax; Max-Age=0',
    ])
  })

  it('reacts to the token key and to a cleared store, and to nothing else', () => {
    const page = stubPage('', null)
    const browser = windowGateBrowser()
    const seen: number[] = []
    const unsubscribe = browser.onStorageChanged(() => seen.push(1))
    const deliver = (key: string | null): void => { page.listeners.get('storage')?.({ key } as StorageEvent) }
    deliver(ACCESS_TOKEN_STORAGE_KEY)
    deliver(null)
    deliver('unrelated')
    expect(seen).toEqual([1, 1])

    unsubscribe()
    expect(page.listeners.has('storage')).toBe(false)
  })

  it('runs a scheduled callback and cancels a pending one', async () => {
    stubPage('', null)
    const browser = windowGateBrowser()
    const ran: string[] = []
    browser.schedule(0, () => ran.push('kept'))
    browser.schedule(0, () => ran.push('cancelled'))()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(ran).toEqual(['kept'])
  })

  it('sleeps a delay longer than one browser timer holds in links of that length', () => {
    stubPage('', null)
    vi.useFakeTimers()
    const armed = vi.spyOn(globalThis, 'setTimeout')
    const browser = windowGateBrowser()
    const ran: string[] = []
    // The expiry margin of a token a month from `exp`. Handed to one timer, a
    // browser fires it on the next tick and the visitor is signed out at boot.
    browser.schedule(MAX_TIMER_DELAY_MS + 5_000, () => ran.push('kept'))
    expect(armed.mock.calls.map(call => call[1])).toEqual([MAX_TIMER_DELAY_MS])

    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    expect({ delays: armed.mock.calls.map(call => call[1]), ran })
      .toEqual({ delays: [MAX_TIMER_DELAY_MS, 5_000], ran: [] })

    vi.advanceTimersByTime(5_000)
    expect(ran).toEqual(['kept'])
  })

  it('cancels the link a chained delay currently has armed', () => {
    stubPage('', null)
    vi.useFakeTimers()
    const browser = windowGateBrowser()
    const ran: string[] = []
    const cancel = browser.schedule(MAX_TIMER_DELAY_MS + 5_000, () => ran.push('cancelled'))
    // The first link has already handed over to the second, so cancelling has
    // to reach the one armed now rather than the one it started with.
    vi.advanceTimersByTime(MAX_TIMER_DELAY_MS)
    cancel()

    vi.advanceTimersByTime(5_000)
    expect({ ran, pending: vi.getTimerCount() }).toEqual({ ran: [], pending: 0 })
  })

  it('draws a fresh request id of the deployment\'s own length', () => {
    stubPage('', null)
    const browser = windowGateBrowser()
    const id = browser.requestId()
    // Which characters those are is the alphabet `requestIdFrom` draws from;
    // what this pins is that the real browser draws sixteen of them, freshly,
    // so the deployment reads each request as its own trace.
    expect(id).toMatch(/^[A-Za-z0-9]{16}$/)
    expect(browser.requestId()).not.toBe(id)
  })

  it('asks the deployment on this page\'s own origin, with its cookies and no cache', async () => {
    stubPage('', null)
    const seen: { url: URL; init: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn((url: URL, init: RequestInit) => {
      seen.push({ url, init })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ token: 'a.b.c' }) })
    }))
    const controller = new AbortController()
    const answer = await windowGateBrowser().requestJson('/api/renewal', { Authorization: 'Bearer a.b.c' }, controller.signal)
    expect(answer).toEqual({ token: 'a.b.c' })
    expect(seen[0]?.url.href).toBe(`${ORIGIN}/api/renewal`)
    expect({
      method: seen[0]?.init.method,
      cache: seen[0]?.init.cache,
      headers: seen[0]?.init.headers,
      signal: seen[0]?.init.signal === controller.signal,
    }).toEqual({
      method: 'GET',
      cache: 'no-store',
      headers: { Authorization: 'Bearer a.b.c' },
      signal: true,
    })
  })

  it('refuses an answer that is not a 2xx, naming the path and the status and nothing it sent', async () => {
    stubPage('', null)
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 401 })))
    const request = windowGateBrowser()
      .requestJson('/api/renewal', { Authorization: 'Bearer a.b.c' }, new AbortController().signal)
    // The headers of that request are two copies of a credential, so the
    // diagnostic carries neither.
    await expect(request).rejects.toThrow('auth-gate: /api/renewal answered 401')
    await expect(request).rejects.toThrow(expect.not.stringContaining('a.b.c'))
  })
})

describe('auth-gate browser plugin', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** Answer the node half's three routes; record what the token and sign-out routes received. */
  function serve(settings: unknown, ok = true, tokenOk = true, logoutOk = true): {
    posted: string[]
    revoked: { keepalive: boolean; contentType: string | undefined }[]
    requested: string[]
  } {
    const posted: string[] = []
    const revoked: { keepalive: boolean; contentType: string | undefined }[] = []
    const requested: string[] = []
    type Init = { body?: string; keepalive?: boolean; headers?: Record<string, string> }
    // The browser half asks for absolute URLs resolved against the deployment
    // base, so the routes are matched by their tail rather than compared whole.
    vi.stubGlobal('fetch', vi.fn((input: URL, init?: Init) => {
      requested.push(input.href)
      if (input.pathname.endsWith(AUTH_GATE_SETTINGS_ROUTE)) {
        return Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(settings) })
      }
      if (input.pathname.endsWith(AUTH_GATE_LOGOUT_ROUTE)) {
        revoked.push({ keepalive: init?.keepalive === true, contentType: init?.headers?.['content-type'] })
        return Promise.resolve({ ok: logoutOk, status: logoutOk ? 204 : 405 })
      }
      if (!input.pathname.endsWith(AUTH_GATE_TOKEN_ROUTE)) throw new Error(`unexpected fetch: ${input.href}`)
      posted.push(init?.body ?? '')
      return Promise.resolve({ ok: tokenOk, status: tokenOk ? 204 : 400 })
    }))
    return { posted, revoked, requested }
  }

  /**
   * A page already carrying one signed-in token in both storage and the mirror
   * cookie. The expiry is measured against the real clock, because these cases
   * run the real `windowGateBrowser` and its schedule.
   * @returns the token the page carries.
   */
  function stubSignedInPage(): string {
    const token = `${segment({ alg: 'none' })}.${segment({ sub: 'u-1', exp: Date.now() / 1000 + 3600 })}.c2ln`
    vi.stubGlobal('document', { get cookie() { return `accessToken=${token}` }, set cookie(_value: string) {} })
    vi.stubGlobal('localStorage', { getItem: () => token })
    vi.stubGlobal('location', { href: HREF, origin: ORIGIN, reload: () => {} })
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', () => {})
    return token
  }

  /**
   * A page carrying no token at all, which is the boot that signs the visitor
   * out and leaves.
   * @returns what the gate did to the page.
   */
  function stubSignedOutPage(): { navigations: string[]; cookieWrites: string[] } {
    const navigations: string[] = []
    const cookieWrites: string[] = []
    vi.stubGlobal('document', { get cookie() { return '' }, set cookie(value: string) { cookieWrites.push(value) } })
    vi.stubGlobal('localStorage', { getItem: () => null })
    vi.stubGlobal('location', { href: HREF, origin: ORIGIN, reload: () => {} })
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', () => {})
    const target = globalThis as unknown as { location: { href: string } }
    Object.defineProperty(target.location, 'href', {
      get: () => HREF,
      set: (value: string) => { navigations.push(value) },
    })
    return { navigations, cookieWrites }
  }

  it('runs the gate on the settings its node half served, and hands the token over', async () => {
    const served = serve(SETTINGS)
    const token = stubSignedInPage()
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    expect(served.posted).toEqual([JSON.stringify({ token })])
    await fiber.dispose()
  })

  it('warns rather than failing the page when the node half refuses the token', async () => {
    const token = stubSignedInPage()
    serve(SETTINGS, true, false)
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    await new Promise(resolve => setTimeout(resolve, 5))
    const reported = String(warn.mock.calls[0]?.[0])
    expect(reported).toContain(`${AUTH_GATE_TOKEN_ROUTE} answered 400`)
    // Whatever reads the warning must not learn the credential from it.
    expect(reported).not.toContain(token)
    await fiber.dispose()
  })

  it('tells the node half to drop the token before it clears the mirror and leaves', async () => {
    const served = serve(SETTINGS)
    const page = stubSignedOutPage()
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    // `keepalive`, because the navigation on the next line would otherwise
    // cancel the request with the document; `application/json`, because that is
    // what keeps the route out of the set a cross-origin page can post to
    // without a preflight.
    expect(served.revoked).toEqual([{ keepalive: true, contentType: 'application/json' }])
    expect(page.cookieWrites).toEqual(['accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0'])
    expect(page.navigations).toEqual([LOGIN])
    await fiber.dispose()
  })

  it('warns rather than holding the page when the node half refuses the sign-out', async () => {
    serve(SETTINGS, true, true, false)
    stubSignedOutPage()
    const ctx = new Context()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(String(warn.mock.calls[0]?.[0])).toContain(`${AUTH_GATE_LOGOUT_ROUTE} answered 405`)
    await fiber.dispose()
  })

  it('asks the node half through the deployment prefix the shell is served under', async () => {
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const ctx = new Context()

    const signedIn = serve(SETTINGS)
    stubSignedInPage()
    const armed = ctx.plugin({ apply })
    await armed.await()
    expect(signedIn.requested).toEqual([
      'https://harness.example/console/auth-gate/settings',
      'https://harness.example/console/auth-gate/token',
    ])
    await armed.dispose()

    const signedOut = serve(SETTINGS)
    stubSignedOutPage()
    const leaving = ctx.plugin({ apply })
    await leaving.await()
    expect(signedOut.requested).toEqual([
      'https://harness.example/console/auth-gate/settings',
      'https://harness.example/console/auth-gate/logout',
    ])
    await leaving.dispose()
  })

  it('fails the row rather than guessing when the settings route is unusable', async () => {
    const ctx = new Context()
    for (const [body, ok, message] of [
      [SETTINGS, false, /answered 503/],
      [{ ...SETTINGS, loginUrl: '' }, true, /unusable loginUrl: ""/],
      [{ ...SETTINGS, loginUrl: 7 }, true, /unusable loginUrl: 7/],
      [{ ...SETTINGS, cookieName: undefined }, true, /unusable cookieName: undefined/],
      [{ ...SETTINGS, refreshMarginSeconds: -1 }, true, /unusable refreshMarginSeconds: -1/],
      [{ ...SETTINGS, refreshMarginSeconds: 1.5 }, true, /unusable refreshMarginSeconds: 1.5/],
      [{ ...SETTINGS, refreshMarginSeconds: 'soon' }, true, /unusable refreshMarginSeconds: "soon"/],
      [{ ...SETTINGS, renewal: null }, true, /unusable renewal: null/],
      [{ ...SETTINGS, renewal: 7 }, true, /unusable renewal: 7/],
      // A renewal path is where this visitor's credential is sent, so one
      // naming another origin — or naming one without looking like it — fails
      // the row here as well as at the node half.
      [{ ...SETTINGS, renewal: { path: 'https://elsewhere.example/renew', intervalSeconds: 60 } }, true, /unusable renewal path: "https:/],
      [{ ...SETTINGS, renewal: { path: '//elsewhere.example/renew', intervalSeconds: 60 } }, true, /unusable renewal path: "\/\//],
      // `\` is `/` to the parser that resolves this value against the page, so
      // one leading slash and no second one is no proof of the origin it names.
      [
        { ...SETTINGS, renewal: { path: '/\\elsewhere.example/renew', intervalSeconds: 60 } },
        true,
        'unusable renewal path: "/\\\\elsewhere.example/renew"',
      ],
      [
        { ...SETTINGS, renewal: { path: '/\\/elsewhere.example/renew', intervalSeconds: 60 } },
        true,
        'unusable renewal path: "/\\\\/elsewhere.example/renew"',
      ],
      [{ ...SETTINGS, renewal: { path: '', intervalSeconds: 60 } }, true, /unusable renewal path: ""/],
      [{ ...SETTINGS, renewal: { path: RENEWAL_PATH } }, true, /unusable renewal intervalSeconds: undefined/],
      [{ ...SETTINGS, renewal: { path: RENEWAL_PATH, intervalSeconds: 0 } }, true, /unusable renewal intervalSeconds: 0/],
      [{ ...SETTINGS, renewal: { path: RENEWAL_PATH, intervalSeconds: 1.5 } }, true, /unusable renewal intervalSeconds: 1.5/],
      // Longer than a browser timer holds: the delay would be clamped to the
      // next tick, and every tick carries this visitor's credential.
      [{ ...SETTINGS, renewal: { path: RENEWAL_PATH, intervalSeconds: 2_147_484 } }, true, /unusable renewal intervalSeconds: 2147484/],
    ] as const) {
      serve(body, ok)
      // The plugin body itself, not a fiber: a rejecting apply is what fails
      // the row, and the fiber only reports it.
      await expect(apply(ctx)).rejects.toThrow(message)
    }
  })

  it('runs the gate on a settings document that carries a renewal endpoint', async () => {
    const served = serve(RENEWING)
    const token = stubSignedInPage()
    const ctx = new Context()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    // The renewal itself is a timer away; what this pins is that a document
    // carrying one is accepted and the gate runs on it.
    expect(served.posted).toEqual([JSON.stringify({ token })])
    await fiber.dispose()
  })
})
