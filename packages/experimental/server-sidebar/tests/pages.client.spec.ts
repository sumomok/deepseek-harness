/**
 * `readContentPages` in isolation: the response shapes content-frame's
 * settings route can answer, each reduced to what the menu needs or
 * contained to an empty list. `browser-plugin.client.spec.ts` covers the
 * happy path through the full registration; this file covers the failure
 * and filtering paths that path never exercises.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readContentPages } from '../src/client/pages.ts'

const ROUTE = '/content-frame/settings'

function stubFetch(impl: (input: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readContentPages', () => {
  it('reduces a well-formed catalog to id/title pairs', async () => {
    stubFetch(async (input) => {
      expect(input).toBe(ROUTE)
      return { ok: true, json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home', description: '', url: '/x' }] }) }
    })
    expect(await readContentPages()).toEqual([{ id: 'home', title: 'Home' }])
  })

  it('drops entries missing a usable id or title', async () => {
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }, { id: 42, title: 'Bad id' }, { id: 'no-title' }] }),
    }))
    expect(await readContentPages()).toEqual([{ id: 'home', title: 'Home' }])
  })

  it('answers empty when the route responds non-200', async () => {
    stubFetch(async () => ({ ok: false, json: () => Promise.resolve({}) }))
    expect(await readContentPages()).toEqual([])
  })

  it('answers empty when the document has no pages array', async () => {
    stubFetch(async () => ({ ok: true, json: () => Promise.resolve({ cacheSize: 1 }) }))
    expect(await readContentPages()).toEqual([])
  })

  it('contains a transport failure to an empty list rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readContentPages()).toEqual([])
  })
})
