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
import { mirrorCookieLine, readCookieFrom, windowGateBrowser, type GateBrowser } from '../src/client/browser.ts'
import { runGate } from '../src/client/run.ts'
import * as AuthGateInvariant from '../src/invariant.ts'
import {
  ACCESS_TOKEN_STORAGE_KEY,
  AUTH_GATE_SETTINGS_ROUTE,
  AUTH_GATE_TOKEN_ROUTE,
  type AuthGateSettings,
} from '../src/route.ts'

const NOW = 1_800_000_000_000
const SETTINGS: AuthGateSettings = { loginUrl: '/toy-login/#/', cookieName: 'accessToken', refreshMarginSeconds: 300 }
const HREF = 'https://harness.example/chat'
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

  navigate(url: string): void {
    this.navigations.push(url)
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
  const dispose = runGate(bench, SETTINGS, token => pushed.push(token))
  return { dispose, pushed }
}

describe('auth-gate boot', () => {
  it('sends a visitor with no token to the login page, carrying where they were', () => {
    const bench = new Bench()
    const { pushed } = boot(bench)
    expect(bench.navigations).toEqual([LOGIN])
    expect({ reloads: bench.reloads, cookies: bench.cookies.size, pushed }).toEqual({
      reloads: 0, cookies: 0, pushed: [],
    })
  })

  it('sends a visitor whose token ran out to the login page', () => {
    const bench = new Bench()
    bench.token = STALE
    boot(bench)
    expect(bench.navigations).toEqual([LOGIN])
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
    expect(bench.navigations).toEqual([LOGIN])
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
    expect({ navigations: bench.navigations, reloads: bench.reloads }).toEqual({ navigations: [LOGIN], reloads: 0 })
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

  it('mirrors for the whole origin, over TLS, and not on cross-site subrequests', () => {
    expect(mirrorCookieLine('accessToken', 'a.b.c')).toBe('accessToken=a.b.c; Path=/; Secure; SameSite=Lax')
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

  it('writes the mirror cookie, navigates, and reloads through the page itself', () => {
    const page = stubPage('', null)
    const browser = windowGateBrowser()
    browser.writeCookie('accessToken', 'a.b.c')
    browser.navigate('/toy-login/#/?redirect=x')
    browser.reload()
    expect(page.written).toEqual(['accessToken=a.b.c; Path=/; Secure; SameSite=Lax'])
    expect(page.navigations).toEqual(['/toy-login/#/?redirect=x'])
    expect(page.reloads).toEqual([1])
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

  /** Answer the node half's two routes; record what the token route received. */
  function serve(settings: unknown, ok = true, tokenOk = true): { posted: string[] } {
    const posted: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: string, init?: { body?: string }) => {
      if (input === AUTH_GATE_SETTINGS_ROUTE) {
        return Promise.resolve({ ok, status: ok ? 200 : 503, json: () => Promise.resolve(settings) })
      }
      if (input !== AUTH_GATE_TOKEN_ROUTE) throw new Error(`unexpected fetch: ${input}`)
      posted.push(init?.body ?? '')
      return Promise.resolve({ ok: tokenOk, status: tokenOk ? 204 : 400 })
    }))
    return { posted }
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
    vi.stubGlobal('location', { href: HREF, reload: () => {} })
    vi.stubGlobal('addEventListener', () => {})
    vi.stubGlobal('removeEventListener', () => {})
    return token
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
