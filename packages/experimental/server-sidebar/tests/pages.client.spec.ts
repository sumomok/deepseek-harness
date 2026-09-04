/**
 * `readContentPages` in isolation: the response shapes content-frame's
 * settings route can answer, each reduced to what the menu needs or
 * contained to an empty list. `browser-plugin.client.spec.ts` covers the
 * happy path through the full registration; this file covers the failure
 * and filtering paths that path never exercises.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_SETTINGS_ROUTE } from '@deepseek-ai/dsh-experimental-content-frame/src/route.ts'
import { readContentPages } from '../src/client/pages.ts'

const ROUTE = '/content-frame/settings'

function stubFetch(impl: (input: URL) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readContentPages', () => {
  it('addresses the route content-frame actually serves', () => {
    // The literal above is a deliberate copy rather than a value import (see
    // the module documentation); a test-only import of the owning constant is
    // what makes the copy mechanically checkable, since a drift would
    // otherwise only show as an empty navigation menu.
    expect(ROUTE).toBe(CONTENT_SETTINGS_ROUTE)
  })

  it('requests it through the deployment prefix the shell is served under', async () => {
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const requested: string[] = []
    stubFetch(async (input) => {
      requested.push(input.pathname)
      return { ok: true, json: () => Promise.resolve({ pages: [] }) }
    })
    await readContentPages()
    expect(requested).toEqual(['/console/content-frame/settings'])
  })

  it('reduces a well-formed catalog to id/title pairs', async () => {
    stubFetch(async (input) => {
      expect(input.pathname).toBe(ROUTE)
      return { ok: true, json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home', description: '', url: '/x' }] }) }
    })
    expect(await readContentPages()).toEqual({ pages: [{ id: 'home', title: 'Home' }] })
  })

  it('drops entries missing a usable id or title', async () => {
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }, { id: 42, title: 'Bad id' }, { id: 'no-title' }] }),
    }))
    expect(await readContentPages()).toEqual({ pages: [{ id: 'home', title: 'Home' }] })
  })

  it('answers empty when the route responds non-200', async () => {
    stubFetch(async () => ({ ok: false, json: () => Promise.resolve({}) }))
    expect(await readContentPages()).toEqual({ pages: [] })
  })

  it('answers empty when the document has no pages array', async () => {
    stubFetch(async () => ({ ok: true, json: () => Promise.resolve({ cacheSize: 1 }) }))
    expect(await readContentPages()).toEqual({ pages: [] })
  })

  it('contains a transport failure to an empty list rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readContentPages()).toEqual({ pages: [] })
  })

  it('carries homePage through when it names a configured page', async () => {
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 'home' }),
    }))
    expect(await readContentPages()).toEqual({ pages: [{ id: 'home', title: 'Home' }], homePage: 'home' })
  })

  it('warns and drops homePage when it is not a string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 42 }),
    }))
    expect(await readContentPages()).toEqual({ pages: [{ id: 'home', title: 'Home' }] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('homePage is not a string'))
  })

  it('warns and drops homePage when it names no configured page', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 'reports' }),
    }))
    expect(await readContentPages()).toEqual({ pages: [{ id: 'home', title: 'Home' }] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('homePage "reports" names no configured page'))
  })
})
