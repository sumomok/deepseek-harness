/**
 * `readFavorites`/`saveFavorites` in isolation: the response shapes this
 * package's own favorites route can answer. `browser-plugin.client.spec.ts`
 * and `favorites-route.client.spec.ts` cover the happy paths through the
 * full registration and the real HTTP route respectively; this file covers
 * the client-side failure and filtering paths those never exercise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFavorites, saveFavorites } from '../src/client/favorites-api.ts'

const ROUTE = '/server-menu/favorites'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readFavorites', () => {
  it('filters out malformed entries', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      expect(input).toBe(ROUTE)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          favorites: [
            { sessionId: 's1', label: 'A', order: 0 },
            { sessionId: 's2', label: 'B' },
            { sessionId: 3, label: 'C', order: 1 },
            null,
          ],
        }),
      })
    }))
    expect(await readFavorites()).toEqual([{ sessionId: 's1', label: 'A', order: 0 }])
  })

  it('answers empty when the route responds non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })))
    expect(await readFavorites()).toEqual([])
  })

  it('answers empty when the document has no favorites array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    expect(await readFavorites()).toEqual([])
  })

  it('contains a transport failure to an empty list rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readFavorites()).toEqual([])
  })
})

describe('saveFavorites', () => {
  it('answers the server\'s authoritative filtered list on success', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
      expect(input).toBe(ROUTE)
      expect(JSON.parse(init.body as string)).toEqual({ favorites: [{ sessionId: 's1', label: 'A', order: 0 }] })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ favorites: [{ sessionId: 's1', label: 'A', order: 0 }, { bad: true }] }),
      })
    }))
    expect(await saveFavorites([{ sessionId: 's1', label: 'A', order: 0 }]))
      .toEqual([{ sessionId: 's1', label: 'A', order: 0 }])
  })

  it('throws the server\'s own error text on refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 400, json: () => Promise.resolve({ error: 'server-sidebar: duplicate favorite for session "s1"' }),
    })))
    await expect(saveFavorites([])).rejects.toThrow('server-sidebar: duplicate favorite for session "s1"')
  })

  it('falls back to the HTTP status when the refusal body carries no usable error text', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 503, json: () => Promise.reject(new Error('not json')),
    })))
    await expect(saveFavorites([])).rejects.toThrow('favorites save failed: HTTP 503')
  })

  it('throws when a 200 answers no usable favorites array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    await expect(saveFavorites([])).rejects.toThrow('favorites save answered no usable favorites list')
  })
})
