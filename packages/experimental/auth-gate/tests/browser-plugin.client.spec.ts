/**
 * The gate as it runs in a page: the boot sequence over a fake browser, the
 * mirror that reloads exactly once and the one that refuses to loop, the
 * account switch, the expiry schedule, the real `window`-backed browser against
 * stubbed globals, and the plugin body that reads its settings before running
 * any of it.
 *
 * The fake browser is what makes the reload count observable at all: a real one
 * would have navigated away before the assertion.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
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
import * as AuthGateInvariant from '../src/invariant.ts'
import {
  ACCESS_TOKEN_STORAGE_KEY,
  AUTH_GATE_LOGOUT_ROUTE,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  type AuthGateSettings,
} from '../src/route.ts'

const NOW = 1_800_000_000_000
const SETTINGS: AuthGateSettings = { loginUrl: '/toy-login/#/', cookieName: 'accessToken', refreshMarginSeconds: 300 }
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
const OTHER = jwt('u-2', 3600)
const STALE = jwt('u-1', -1)

/** A browser whose every effect is recorded rather than performed. */
class Bench implements GateBrowser {
  token: string | null = null
  readonly cookies = new Map<string, string>()
  /** Whether a cookie write is kept, as a browser refusing `Secure` over plain HTTP would not. */
  cookieWritesTake = true
  readonly navigations: string[] = []
  /**
   * Every effect the gate performed, in order, so the sign-out sequence is
   * assertable as a sequence rather than as three independent facts.
   */
  readonly log: string[] = []
  reloads = 0
  readonly timers: { delayMs: number; run: () => void }[] = []
  cancelledTimers = 0
  private listener: (() => void) | undefined

  now(): number {
    return NOW
  }

  currentHref(): string {
    return HREF
  }

  readToken(): string | null {
    return this.token
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
function boot(bench: Bench): { dispose: () => void; pushed: string[] } {
  const pushed: string[] = []
  const dispose = runGate(
    bench,
    SETTINGS,
    token => pushed.push(token),
    () => { bench.log.push('revoke') },
  )
  return { dispose, pushed }
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
    vi.unstubAllGlobals()
  })

  /** Stub the globals the real browser reads, and report what it wrote. */
  function stubPage(cookie: string, token: string | null): {
    written: string[]
    navigations: string[]
    reloads: number[]
    listeners: Map<string, (event: StorageEvent) => void>
  } {
    const written: string[] = []
    const navigations: string[] = []
    const reloads: number[] = []
    const listeners = new Map<string, (event: StorageEvent) => void>()
    vi.stubGlobal('document', {
      get cookie() { return cookie },
      set cookie(value: string) { written.push(value) },
    })
    vi.stubGlobal('localStorage', { getItem: (key: string) => (key === ACCESS_TOKEN_STORAGE_KEY ? token : null) })
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
    return { written, navigations, reloads, listeners }
  }

  it('reads the token and the mirror cookie off the page', () => {
    stubPage('accessToken=a.b.c', LIVE)
    const browser = windowGateBrowser()
    expect(browser.readToken()).toBe(LIVE)
    expect(browser.readCookie('accessToken')).toBe('a.b.c')
    expect(browser.currentHref()).toBe(HREF)
    expect(browser.now()).toBeGreaterThan(0)
  })

  it('strips the scheme the login page stored the token under', () => {
    // The one place a stored value enters the gate, and the reason a page whose
    // login wrote "Bearer <jwt>" does not send its visitor back to the login
    // page forever.
    stubPage('', `Bearer ${LIVE}`)
    expect(windowGateBrowser().readToken()).toBe(LIVE)
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
    ] as const) {
      serve(body, ok)
      // The plugin body itself, not a fiber: a rejecting apply is what fails
      // the row, and the fiber only reports it.
      await expect(apply(ctx)).rejects.toThrow(message)
    }
  })
})

describe('auth-gate invariant companion', () => {
  it('reserves package ownership under its declared companion name', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry, { enabled: true })
    const fiber = ctx.plugin(AuthGateInvariant)
    await fiber.await()
    expect(AuthGateInvariant.name).toBe('experimental-auth-gate-invariant')
    expect(AuthGateInvariant.inject).toEqual(['invariants'])
    await fiber.dispose()
  })
})
