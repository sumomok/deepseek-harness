/**
 * Signing out: the five steps in their fixed order, the sweep that stops work
 * in progress, the enumerated storage removal (and everything it leaves
 * alone), the cookie line that must stay byte-for-byte auth-gate's, the
 * return address, and the settings read that decides whether the button can
 * do anything at all.
 *
 * Every step is recorded into one log, so an assertion states the order
 * rather than each step in isolation, and every step is also proved to run
 * after the one before it failed — the visitor is leaving either way,
 * including when the sign-out route never answers at all and when the stop
 * the sequence opens with never answers either.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import {
  readAuthGateSettings, signOut, stopRunningTurns, windowSignOutBrowser, type SignOutBrowser,
} from '../src/client/sign-out.ts'

const SETTINGS = { loginUrl: '/toy-login/#/', cookieName: 'accessToken' }

/** Keys the login page owns, in the order the module removes them. */
const OWNED_KEYS = [
  'accessToken', 'accessTokenTime', 'accessTokenEncrypt', 'accessTokenRenewalTime',
  'userInfo', 'loginUserInfo', 'AP', 'token4a',
  'accessTokenAuth', 'accessTokenTimeAuth', 'accessTokenEncryptAuth', 'accessTokenRenewalTimeAuth',
]

/** A recording {@link SignOutBrowser}: every step lands in one ordered log. */
function benchBrowser(options: { href?: string; stopTurns?: () => Promise<void> } = {}): {
  browser: SignOutBrowser
  log: string[]
} {
  const log: string[] = []
  const browser: SignOutBrowser = {
    stopTurns: options.stopTurns ?? (() => {
      log.push('stop')
      return Promise.resolve()
    }),
    removeStoredKey: (key) => { log.push(`remove:${key}`) },
    writeCookieLine: (line) => { log.push(`cookie:${line}`) },
    currentHref: () => options.href ?? 'https://console.example/app/#/board',
    navigate: (url) => { log.push(`navigate:${url}`) },
  }
  return { browser, log }
}

/** Stub `fetch` for the sign-out route; records each call and answers as told. */
function stubFetch(answer: { ok?: boolean; reject?: boolean } = {}): ReturnType<typeof vi.fn> {
  const fetcher = vi.fn(() => {
    // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- a transport failure with no Error is one case under test.
    if (answer.reject === true) return Promise.reject('offline')
    return Promise.resolve({ ok: answer.ok ?? true, status: answer.ok === false ? 503 : 204 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

/** Let the fire-and-forget sign-out request reach its own reporting. */
function flushMicrotasks(): Promise<void> {
  return Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('signOut', () => {
  it('runs its five steps in order, and posts the sign-out the way the route accepts it', async () => {
    const fetcher = stubFetch()
    const { browser, log } = benchBrowser()
    await signOut(browser, SETTINGS)
    expect(fetcher).toHaveBeenCalledWith('/auth-gate/logout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
    })
    expect(log).toEqual([
      'stop',
      ...OWNED_KEYS.map(key => `remove:${key}`),
      'cookie:accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0',
      'navigate:/toy-login/#/?redirect=https%3A%2F%2Fconsole.example%2Fapp%2F%23%2Fboard',
    ])
  })

  it('removes the login page\'s own keys by name and touches nothing else', async () => {
    stubFetch()
    const { browser, log } = benchBrowser()
    await signOut(browser, SETTINGS)
    const removed = log.filter(entry => entry.startsWith('remove:')).map(entry => entry.slice('remove:'.length))
    expect(removed).toEqual(OWNED_KEYS)
    for (const untouched of ['dsh-theme', 'dsh-locale', 'someOtherApp.session']) {
      expect(removed).not.toContain(untouched)
    }
  })

  it('takes the login page\'s credential parameters out of the return address, from the query and the fragment alike', async () => {
    stubFetch()
    const { browser, log } = benchBrowser({ href: 'https://h/console/?token=S&x=1#/r?y=2&token4a=S2' })
    await signOut(browser, SETTINGS)
    const redirect = decodeURIComponent(String(log.at(-1)).slice('navigate:/toy-login/#/?redirect='.length))
    expect(redirect).not.toContain('S')
    expect(redirect).toContain('x=1')
    expect(redirect).toContain('#/r?y=2')
    expect(redirect).toBe('https://h/console/?x=1#/r?y=2')
  })

  it('drops a query that was nothing but a credential, and keeps a parameter written without a value', async () => {
    stubFetch()
    const { browser, log } = benchBrowser({ href: 'https://h/app/?debug&token=S#/r?token4a=S2' })
    await signOut(browser, SETTINGS)
    expect(log.at(-1)).toBe(`navigate:/toy-login/#/?redirect=${encodeURIComponent('https://h/app/?debug#/r')}`)
  })

  it('leaves an address with no query and no hash exactly as it stands', async () => {
    stubFetch()
    const { browser, log } = benchBrowser({ href: 'https://console.example/app/' })
    await signOut(browser, SETTINGS)
    expect(log.at(-1)).toBe(`navigate:/toy-login/#/?redirect=${encodeURIComponent('https://console.example/app/')}`)
  })

  it('leaves once the bound has passed, when the stop never answers at all', async () => {
    // A cancel the host never answers: the sequence waits the bound out and
    // then does the four steps that actually drop the token.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.useFakeTimers()
    stubFetch()
    const { browser, log } = benchBrowser({ stopTurns: () => new Promise<void>(() => {}) })
    const leaving = signOut(browser, SETTINGS)
    await vi.advanceTimersByTimeAsync(3000)
    await expect(leaving).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      'server-sidebar: could not stop the work in progress',
      expect.objectContaining({ message: 'server-sidebar: the work in progress did not stop within 3000ms' }),
    )
    expect(log).toEqual([
      ...OWNED_KEYS.map(key => `remove:${key}`),
      'cookie:accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0',
      'navigate:/toy-login/#/?redirect=https%3A%2F%2Fconsole.example%2Fapp%2F%23%2Fboard',
    ])
  })

  it('goes on after a stop that failed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch()
    const { browser, log } = benchBrowser({ stopTurns: () => Promise.reject(new Error('scope gone')) })
    await signOut(browser, SETTINGS)
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not stop the work in progress', expect.any(Error))
    expect(log.at(-1)).toContain('navigate:')
    expect(log.filter(entry => entry.startsWith('remove:'))).toHaveLength(OWNED_KEYS.length)
  })

  it('goes on after a sign-out route that refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch({ ok: false })
    const { browser, log } = benchBrowser()
    await signOut(browser, SETTINGS)
    expect(log.at(-1)).toContain('navigate:')
    // The request is sent, not waited on, so its own report lands after the
    // sequence has already finished leaving.
    await flushMicrotasks()
    expect(warn).toHaveBeenCalledWith('server-sidebar: /auth-gate/logout answered 503')
  })

  it('goes on after a sign-out route that could not be reached', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch({ reject: true })
    const { browser, log } = benchBrowser()
    await signOut(browser, SETTINGS)
    expect(log.at(-1)).toContain('navigate:')
    await flushMicrotasks()
    expect(warn).toHaveBeenCalledWith('server-sidebar: /auth-gate/logout could not be reached', 'offline')
  })

  it('leaves without waiting for a sign-out route that never answers', async () => {
    // A proxy holding the request open until its own read timeout: the
    // sequence must not hold the visitor there with it.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<never>(() => {})))
    const { browser, log } = benchBrowser()
    await signOut(browser, SETTINGS)
    expect(log.filter(entry => entry.startsWith('remove:'))).toHaveLength(OWNED_KEYS.length)
    expect(log.at(-1)).toContain('navigate:')
  })

  it('goes on after storage refused to give a key up', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch()
    const { browser, log } = benchBrowser()
    const refusing: SignOutBrowser = {
      ...browser,
      removeStoredKey: (key) => {
        if (key === 'accessTokenTime') throw new Error('site data is blocked')
        log.push(`remove:${key}`)
      },
    }
    await signOut(refusing, SETTINGS)
    expect(warn).toHaveBeenCalledWith(
      'server-sidebar: could not remove the stored key "accessTokenTime"', expect.any(Error),
    )
    expect(log.filter(entry => entry.startsWith('remove:'))).toHaveLength(OWNED_KEYS.length - 1)
    expect(log.at(-1)).toContain('navigate:')
  })

  it('goes on after a cookie jar that refused the removal line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch()
    const { browser, log } = benchBrowser()
    const refusing: SignOutBrowser = {
      ...browser,
      writeCookieLine: () => { throw new Error('site data is blocked') },
    }
    await signOut(refusing, SETTINGS)
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not clear the mirror cookie', expect.any(Error))
    expect(log.at(-1)).toContain('navigate:')
  })

  it('reports a navigation that refused, and settles all the same', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch()
    const { browser, log } = benchBrowser()
    const refusing: SignOutBrowser = { ...browser, navigate: () => { throw new Error('navigation refused') } }
    await expect(signOut(refusing, SETTINGS)).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('server-sidebar: could not leave for the login page', expect.any(Error))
    expect(log.at(-1)).toBe('cookie:accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0')
  })
})

describe('stopRunningTurns', () => {
  /** A session tree whose scopes answer a recording cancel face. */
  function benchSessions(
    options: {
      ids: string[]
      running: string[]
      current?: string
      noScope?: string
      noConversation?: string
      failing?: string
    },
  ): { ctx: ClientContext; cancelled: string[] } {
    const cancelled: string[] = []
    const ctx = {
      sessions: {
        list: {
          getSnapshot: () => ({
            ids: options.ids,
            byId: Object.fromEntries(options.ids.map(id => [id, { running: options.running.includes(id) }])),
            current: options.current,
          }),
        },
        scope: (id: string) => (id === options.noScope ? undefined : {
          get: (service: string) => (id === options.noConversation ? undefined : {
            cancel: () => {
              cancelled.push(`${service}:${id}`)
              return id === options.failing ? Promise.reject(new Error('refused')) : Promise.resolve()
            },
          }),
        }),
      },
    } as unknown as ClientContext
    return { ctx, cancelled }
  }

  it('stops every running conversation and the current one, each exactly once', async () => {
    const { ctx, cancelled } = benchSessions({ ids: ['a', 'b', 'c'], running: ['a', 'c'], current: 'a' })
    await stopRunningTurns(ctx)
    expect(cancelled).toEqual(['conversation:a', 'conversation:c'])
  })

  it('stops the current conversation even when the list reports no work in it', async () => {
    const { ctx, cancelled } = benchSessions({ ids: ['a', 'b'], running: [], current: 'b' })
    await stopRunningTurns(ctx)
    expect(cancelled).toEqual(['conversation:b'])
  })

  it('stops nothing when nothing is running and nothing is open', async () => {
    const { ctx, cancelled } = benchSessions({ ids: ['a'], running: [] })
    await stopRunningTurns(ctx)
    expect(cancelled).toEqual([])
  })

  it('reports a conversation it could not resolve or stop, and finishes the sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, cancelled } = benchSessions({
      ids: ['a', 'b', 'c'], running: ['a', 'b', 'c'], noScope: 'a', noConversation: 'b',
    })
    await stopRunningTurns(ctx)
    expect(cancelled).toEqual(['conversation:c'])
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn).toHaveBeenCalledWith(
      'server-sidebar: could not stop the work in progress in "a"',
      expect.objectContaining({ message: 'server-sidebar: "a" resolved no scope' }),
    )
  })

  it('reports a refused stop and goes on to the next conversation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, cancelled } = benchSessions({ ids: ['a', 'b'], running: ['a', 'b'], failing: 'a' })
    await stopRunningTurns(ctx)
    expect(cancelled).toEqual(['conversation:a', 'conversation:b'])
    expect(warn).toHaveBeenCalledWith(
      'server-sidebar: could not stop the work in progress in "a"', expect.any(Error),
    )
  })
})

describe('readAuthGateSettings', () => {
  /** Stub one answer from auth-gate's settings route. */
  function stubSettings(answer: { ok?: boolean; body?: unknown }): ReturnType<typeof vi.fn> {
    const fetcher = vi.fn(() => Promise.resolve({
      ok: answer.ok ?? true,
      status: answer.ok === false ? 404 : 200,
      json: () => Promise.resolve(answer.body),
    }))
    vi.stubGlobal('fetch', fetcher)
    return fetcher
  }

  it('reads the login address and the mirror cookie name, uncached', async () => {
    const fetcher = stubSettings({ body: { ...SETTINGS, refreshMarginSeconds: 60 } })
    await expect(readAuthGateSettings()).resolves.toEqual(SETTINGS)
    expect(fetcher).toHaveBeenCalledWith('/auth-gate/settings', { cache: 'no-store' })
  })

  it('refuses a composition whose settings route is not there', async () => {
    stubSettings({ ok: false })
    await expect(readAuthGateSettings()).rejects.toThrow('/auth-gate/settings answered 404')
  })

  it('refuses a document with no usable login address', async () => {
    stubSettings({ body: { loginUrl: '', cookieName: 'accessToken' } })
    await expect(readAuthGateSettings()).rejects.toThrow('unusable loginUrl')
  })

  it('refuses a document with no usable cookie name', async () => {
    stubSettings({ body: { loginUrl: '/toy-login/#/', cookieName: 42 } })
    await expect(readAuthGateSettings()).rejects.toThrow('unusable cookieName')
  })
})

describe('windowSignOutBrowser', () => {
  it('binds the page\'s own storage, cookie jar, address, and navigation', async () => {
    const removed: string[] = []
    const written: string[] = []
    const navigations: string[] = []
    vi.stubGlobal('localStorage', { removeItem: (key: string) => removed.push(key) })
    vi.stubGlobal('document', { set cookie(value: string) { written.push(value) } })
    vi.stubGlobal('location', { href: 'https://console.example/app/' })
    // `location.href = url` writes the stub's own property; record it instead.
    const target = globalThis as unknown as { location: { href: string } }
    Object.defineProperty(target.location, 'href', {
      get: () => 'https://console.example/app/',
      set: (value: string) => { navigations.push(value) },
    })
    const ctx = {
      sessions: { list: { getSnapshot: () => ({ ids: [], byId: {}, current: undefined }) } },
    } as unknown as ClientContext

    const browser = windowSignOutBrowser(ctx)
    await browser.stopTurns()
    browser.removeStoredKey('accessToken')
    browser.writeCookieLine('accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0')
    expect(browser.currentHref()).toBe('https://console.example/app/')
    browser.navigate('/toy-login/#/?redirect=x')

    expect(removed).toEqual(['accessToken'])
    expect(written).toEqual(['accessToken=; Path=/; Secure; SameSite=Lax; Max-Age=0'])
    expect(navigations).toEqual(['/toy-login/#/?redirect=x'])
  })
})
