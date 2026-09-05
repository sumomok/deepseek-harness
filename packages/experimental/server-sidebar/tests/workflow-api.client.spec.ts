/**
 * `readServerMenu`/`saveServerMenu` in isolation: the response shapes this
 * package's own server-menu route can answer. `browser-plugin.client.spec.ts`
 * and `workflow-route.client.spec.ts` cover the happy paths through the full
 * registration and the real HTTP route respectively; this file covers the
 * client-side failure and filtering paths those never exercise.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readServerMenu, saveServerMenu } from '../src/client/workflow-api.ts'
import type { ServerMenuGroup, ServerMenuWorkflow } from '../src/workflows.ts'

const ROUTE = '/server-menu/workflows'
const WORKFLOW: ServerMenuWorkflow = {
  id: 'w1', name: 'A', order: 0, homeSessionId: 's1',
  navSnapshot: [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }], savedAt: 1,
}
const GROUP: ServerMenuGroup = { id: 'g1', name: '每日', pinned: true, order: 0 }
/** The empty document, spelled out where a read answers one. */
const EMPTY = { workflows: [], groups: [], workbenchSessionId: undefined }

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readServerMenu', () => {
  it('filters out malformed workflow entries and keeps a valid workbenchSessionId', async () => {
    vi.stubGlobal('fetch', vi.fn((input: URL) => {
      expect(input.pathname).toBe(ROUTE)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          workflows: [
            WORKFLOW,
            { id: 'w2', name: 'B' },
            { id: 3, name: 'C', order: 1, homeSessionId: 's2', navSnapshot: [], savedAt: 2 },
            // The pre-view string form, refused here for the reason the node
            // half refuses it at load — see workflow-api.ts's isNavSnapshotItem.
            { ...WORKFLOW, id: 'w3', navSnapshot: ['home'] },
            { ...WORKFLOW, id: 'w4', navSnapshot: [{ kind: 'chart', entryId: 'c1' }] },
            { ...WORKFLOW, id: 'w5', navSnapshot: [{ kind: 'page', entryId: 42 }] },
            { ...WORKFLOW, id: 'w6', navSnapshot: [null] },
            { ...WORKFLOW, id: 'w7', groupId: 42 },
            null,
          ],
          workbenchSessionId: 'home-1',
        }),
      })
    }))
    expect(await readServerMenu()).toEqual({ workflows: [WORKFLOW], groups: [], workbenchSessionId: 'home-1' })
  })

  it('filters out malformed group entries and keeps the usable ones', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({
        workflows: [],
        groups: [
          GROUP,
          { id: 'g2', name: 'B', order: 1 },
          { id: 'g3', name: 'C', pinned: false },
          { id: 4, name: 'D', pinned: false, order: 2 },
          { id: 'g5', name: 5, pinned: false, order: 3 },
          { id: 'g6', name: 'F', pinned: 'yes', order: 4 },
          null,
        ],
      }),
    })))
    expect(await readServerMenu()).toEqual({ workflows: [], groups: [GROUP], workbenchSessionId: undefined })
  })

  it('reads a body with no groups array as no groups', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, json: () => Promise.resolve({ workflows: [WORKFLOW], groups: 'nonsense' }),
    })))
    expect(await readServerMenu()).toEqual({ workflows: [WORKFLOW], groups: [], workbenchSessionId: undefined })
  })

  it('reads an absent workbenchSessionId as undefined', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [] }) })))
    expect(await readServerMenu()).toEqual(EMPTY)
  })

  it('answers the empty document when the route responds non-200', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve({}) })))
    expect(await readServerMenu()).toEqual(EMPTY)
  })

  it('answers the empty document when the body has no workflows array', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
    expect(await readServerMenu()).toEqual(EMPTY)
  })

  it('contains a transport failure to the empty document rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readServerMenu()).toEqual(EMPTY)
  })
})

describe('server-menu requests under a deployment prefix', () => {
  it('sends both the read and the write through the prefix the shell is served under', async () => {
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn((input: URL) => {
      requested.push(input.pathname)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [] }) })
    }))
    await readServerMenu()
    await saveServerMenu({ workflows: [] })
    expect(requested).toEqual(['/console/server-menu/workflows', '/console/server-menu/workflows'])
  })
})

describe('saveServerMenu', () => {
  it('posts the given patch and answers the server\'s authoritative filtered document', async () => {
    vi.stubGlobal('fetch', vi.fn((input: URL, init: RequestInit) => {
      expect(input.pathname).toBe(ROUTE)
      expect(JSON.parse(init.body as string)).toEqual({ workflows: [WORKFLOW] })
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ workflows: [WORKFLOW, { bad: true }], workbenchSessionId: 'home-1' }),
      })
    }))
    expect(await saveServerMenu({ workflows: [WORKFLOW] }))
      .toEqual({ workflows: [WORKFLOW], groups: [], workbenchSessionId: 'home-1' })
  })

  it('posts a groups-only patch without resending the workflow list', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: URL, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ groups: [GROUP] })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [WORKFLOW], groups: [GROUP] }) })
    }))
    expect(await saveServerMenu({ groups: [GROUP] }))
      .toEqual({ workflows: [WORKFLOW], groups: [GROUP], workbenchSessionId: undefined })
  })

  it('posts a workbenchSessionId-only patch', async () => {
    vi.stubGlobal('fetch', vi.fn((_input: URL, init: RequestInit) => {
      expect(JSON.parse(init.body as string)).toEqual({ workbenchSessionId: 'home-1' })
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workflows: [], workbenchSessionId: 'home-1' }) })
    }))
    expect(await saveServerMenu({ workbenchSessionId: 'home-1' }))
      .toEqual({ workflows: [], groups: [], workbenchSessionId: 'home-1' })
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
