/**
 * `readServerMenu`/`saveServerMenu` in isolation: the response shapes this
 * package's own server-menu route can answer. `browser-plugin.client.spec.ts`
 * and `workflow-route.client.spec.ts` cover the happy paths through the full
 * registration and the real HTTP route respectively; this file covers the
 * client-side failure and filtering paths those never exercise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readServerMenu, saveServerMenu } from '../src/client/workflow-api.ts'

const ROUTE = '/server-menu/workflows'
const WORKFLOW = { id: 'w1', name: 'A', order: 0, homeSessionId: 's1', navSnapshot: ['home'], savedAt: 1 }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readServerMenu', () => {
  it('filters out malformed workflow entries and keeps a valid workbenchSessionId', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string) => {
      expect(input).toBe(ROUTE)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          workflows: [
            WORKFLOW,
            { id: 'w2', name: 'B' },
            { id: 3, name: 'C', order: 1, homeSessionId: 's2', navSnapshot: [], savedAt: 2 },
            { ...WORKFLOW, id: 'w3', navSnapshot: ['home', 1] },
            null,
          ],
          workbenchSessionId: 'home-1',
        }),
      })
    }))
    expect(await readServerMenu()).toEqual({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' })
  })

  it('reads an absent workbenchSessionId as undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [] }) })))
    expect(await readServerMenu()).toEqual({ workflows: [], workbenchSessionId: undefined })
  })

  it('answers the empty document when the route responds non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })))
    expect(await readServerMenu()).toEqual({ workflows: [], workbenchSessionId: undefined })
  })

  it('answers the empty document when the body has no workflows array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    expect(await readServerMenu()).toEqual({ workflows: [], workbenchSessionId: undefined })
  })

  it('contains a transport failure to the empty document rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readServerMenu()).toEqual({ workflows: [], workbenchSessionId: undefined })
  })
})

describe('saveServerMenu', () => {
  it('posts the given patch and answers the server\'s authoritative filtered document', async () => {
    vi.stubGlobal('fetch', vi.fn((input: string, init: RequestInit) => {
      expect(input).toBe(ROUTE)
      expect(JSON.parse(init.body as string)).toEqual({ workflows: [WORKFLOW] })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ workflows: [WORKFLOW, { bad: true }], workbenchSessionId: 'home-1' }),
      })
    }))
    expect(await saveServerMenu({ workflows: [WORKFLOW] })).toEqual({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' })
  })

  it('posts a workbenchSessionId-only patch', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: string, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ workbenchSessionId: 'home-1' })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [], workbenchSessionId: 'home-1' }) })
    }))
    expect(await saveServerMenu({ workbenchSessionId: 'home-1' })).toEqual({ workflows: [], workbenchSessionId: 'home-1' })
  })

  it('throws the server\'s own error text on refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 400, json: () => Promise.resolve({ error: 'server-sidebar: duplicate workflow id "w1"' }),
    })))
    await expect(saveServerMenu({ workflows: [] })).rejects.toThrow('server-sidebar: duplicate workflow id "w1"')
  })

  it('falls back to the HTTP status when the refusal body carries no usable error text', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: false, status: 503, json: () => Promise.reject(new Error('not json')),
    })))
    await expect(saveServerMenu({ workflows: [] })).rejects.toThrow('server-menu save failed: HTTP 503')
  })

  it('throws when a 200 answers a body that cannot be parsed as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('not json')) })))
    await expect(saveServerMenu({ workflows: [] })).rejects.toThrow('server-menu save answered no usable document')
  })
})
