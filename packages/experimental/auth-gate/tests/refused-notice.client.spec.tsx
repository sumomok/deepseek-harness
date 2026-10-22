// @vitest-environment jsdom
/**
 * The refusal notice as a visitor reads it, and as the browser half wires it:
 * nothing while the gate runs, one sentence in either language once the gate
 * has stopped over a sign-in the site no longer accepts, registered into the
 * frame-wide `shell.overlay` seat once the slot and locale services are there,
 * shown by the plugin body when the login page handed back a token the site
 * had refused, and gone with the plugin's fiber (HMR safety).
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { makeTranslate, SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply } from '../src/client/index.ts'
import { en, zh } from '../src/client/locales.ts'
import { RefusedNotice } from '../src/client/RefusedNotice.tsx'
import { AUTH_GATE_SETTINGS_ROUTE, AUTH_GATE_TOKEN_ROUTE, REFUSED_TOKEN_SESSION_KEY, type AuthGateSettings } from '../src/route.ts'

usePinnedBrowserLanguages('zh-CN')

const SETTINGS: AuthGateSettings = { loginUrl: '/toy-login/#/', cookieName: 'accessToken', refreshMarginSeconds: 300 }

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  cleanup()
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
  sessionStorage.clear()
  localStorage.clear()
})

/** Test-local selector hook over the refusal state. */
function hookOf(source: ObservableSnapshot<boolean>) {
  const subscribe = (listener: () => void) => source.subscribe(listener)
  const getSnapshot = () => source.getSnapshot()
  return function useSelector<S>(select: (state: boolean) => S): S {
    return select(useSyncExternalStore(subscribe, getSnapshot))
  }
}

describe('the notice', () => {
  it('draws nothing while the gate runs, and the sentence once it has stopped', () => {
    const refusal = createSnapshotStore(false)
    const view = render(<RefusedNotice useAuthGateRefusal={hookOf(refusal)} t={makeTranslate(zh)} />)
    expect(view.container.innerHTML).toBe('')
    act(() => { refusal.set(true) })
    const notice = screen.getByRole('alert')
    expect(notice.textContent).toBe('登录已失效，请在原系统重新登录后刷新本页。')
    expect(notice.hasAttribute('data-auth-gate-refused')).toBe(true)
    expect(screen.queryAllByRole('button')).toHaveLength(0)
  })

  it('speaks English from the English dictionary', () => {
    render(<RefusedNotice useAuthGateRefusal={hookOf(createSnapshotStore(true))} t={makeTranslate(en)} />)
    expect(screen.getByRole('alert').textContent)
      .toBe('Your sign-in is no longer accepted. Sign in again in the original system, then refresh this page.')
  })
})

/** Base64url-encode one JSON value the way a JWT carries a segment. */
function segment(value: unknown): string {
  return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/**
 * A page signed in on one token, whose node half serves {@link SETTINGS} and
 * answers the token route with `tokenStatus`.
 * @param tokenStatus - the token route's status.
 * @returns the token and every navigation the page attempted.
 */
function signedInPage(tokenStatus: number): { token: string; exp: number; navigations: string[] } {
  const exp = Math.floor(Date.now() / 1000) + 3600
  const token = `${segment({ alg: 'none' })}.${segment({ sub: 'u-1', exp })}.c2ln`
  localStorage.setItem('accessToken', `Bearer ${token}`)
  document.cookie = `accessToken=${token}; Path=/`
  vi.stubGlobal('fetch', vi.fn((input: URL) => {
    if (input.pathname.endsWith(AUTH_GATE_SETTINGS_ROUTE)) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SETTINGS) })
    }
    if (input.pathname.endsWith(AUTH_GATE_TOKEN_ROUTE)) return Promise.resolve({ ok: tokenStatus < 300, status: tokenStatus })
    return Promise.resolve({ ok: true, status: 204 })
  }))
  const navigations: string[] = []
  const here = new URL(window.location.href)
  const page: Location = {
    ancestorOrigins: window.location.ancestorOrigins,
    hash: here.hash,
    host: here.host,
    hostname: here.hostname,
    origin: here.origin,
    pathname: here.pathname,
    port: here.port,
    protocol: here.protocol,
    search: here.search,
    get href() { return here.href },
    set href(value: string) { navigations.push(value) },
    assign: (url: string | URL) => { navigations.push(String(url)) },
    replace: (url: string | URL) => { navigations.push(String(url)) },
    reload: () => {},
    toString: () => here.href,
  }
  vi.spyOn(window, 'location', 'get').mockReturnValue(page)
  return { token, exp, navigations }
}

/** A slot tree with the overlay seat declared and the locale runtime, running the plugin body. */
async function bench() {
  const runtime = await SlotTestRuntime.create()
  disposers.push(() => runtime.dispose())
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.declare({ 'shell.overlay': { kind: 'list', scope: 'root' } })
  const fiber = runtime.ctx.plugin({ apply })
  await fiber.await()
  return { runtime, fiber }
}

describe('the plugin body', () => {
  it('registers the notice into the frame-wide overlay seat, drawing nothing while the gate runs', async () => {
    signedInPage(204)
    const { runtime } = await bench()
    expect(runtime.slots.entries('shell.overlay').map(entry => entry.options.id)).toEqual(['auth-gate.refused-notice'])
    const view = runtime.renderSlot('shell.overlay', {})
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(view.container.textContent).toBe('')
  })

  it('shows the notice and stays when the login page handed back a token the site had refused', async () => {
    const page = signedInPage(401)
    sessionStorage.setItem(REFUSED_TOKEN_SESSION_KEY, `exp:${String(page.exp)}`)
    const { runtime } = await bench()
    const view = runtime.renderSlot('shell.overlay', {})
    await vi.waitFor(() => {
      expect(view.container.textContent).toContain('登录已失效，请在原系统重新登录后刷新本页。')
    })
    expect(page.navigations).toEqual([])
  })

  it('leaves the seat when its fiber is disposed (HMR safety)', async () => {
    signedInPage(204)
    const { runtime, fiber } = await bench()
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(1)
    await fiber.dispose()
    expect(runtime.slots.entries('shell.overlay')).toHaveLength(0)
  })
})
