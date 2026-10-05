/**
 * `readServerMenu`/`saveServerMenu` in isolation: the response shapes this
 * package's own server-menu route can answer. `browser-plugin.client.spec.ts`
 * and `workflow-route.client.spec.ts` cover the happy paths through the full
 * registration and the real HTTP route respectively; this file covers the
 * client-side failure and filtering paths those never exercise.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readServerMenu, saveServerMenu, ServerMenuUnplacedError } from '../src/client/workflow-api.ts'
import type { ServerMenuGroup, ServerMenuWorkflow } from '../src/workflows.ts'

const ROUTE = '/server-menu/workflows'
const WORKFLOW: ServerMenuWorkflow = {
  id: 'w1', name: 'A', order: 0, homeSessionId: 's1',
  navSnapshot: [{ kind: 'page', entryId: 'home' }, { kind: 'view', entryId: 'sales' }], savedAt: 1,
}
const GROUP: ServerMenuGroup = { id: 'g1', name: '每日', pinned: true, order: 0 }
/** The empty document, spelled out where a read answers one. */
const EMPTY = { workflows: [], groups: [], workbenchSessionId: undefined }

// A node carrier has no document; the routes resolve against this stand-in base.
beforeEach(() => {
  vi.stubGlobal('document', { baseURI: 'https://harness.example/' })
})

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

  it('answers the empty document where nothing serves the route', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) })))
    expect(await readServerMenu()).toEqual(EMPTY)
  })

  it('answers no document for a route that refuses, and reports the status to the browser console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const status of [401, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status, json: () => Promise.resolve({ error: 'refused' }) })))
      expect(await readServerMenu()).toBeUndefined()
      expect(warn).toHaveBeenLastCalledWith(`server-sidebar: the menu could not be read: HTTP ${String(status)}`)
    }
    warn.mockRestore()
  })

  it('answers the empty document when the body has no workflows array, or is no JSON object', async () => {
    for (const json of [() => Promise.resolve({}), () => Promise.resolve(null), () => Promise.resolve(7), () => Promise.reject(new SyntaxError('not JSON'))]) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json })))
      expect(await readServerMenu()).toEqual(EMPTY)
    }
  })

  it('answers no document for a request that never reached the route, and reports it to the browser console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failure = new Error('network down')
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(failure)))
    expect(await readServerMenu()).toBeUndefined()
    expect(warn).toHaveBeenCalledWith('server-sidebar: the menu could not be read:', failure)
    warn.mockRestore()
  })
})

describe('server-menu requests under a deployment prefix', () => {
  it('sends both the read and the write through the prefix the shell is served under', async () => {
    vi.stubGlobal('document', { baseURI: 'https://harness.example/console/' })
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

  it('throws a refusal that reached no member\'s menu as its own error, carrying the status and the text', async () => {
    for (const [status, body, message] of [
      [401, { error: 'server-sidebar: the server-menu route could not tell which member sent this request' }, 'server-sidebar: the server-menu route could not tell which member sent this request'],
      [503, {}, 'server-menu save failed: HTTP 503'],
    ] as const) {
      vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status, json: () => Promise.resolve(body) })))
      const refusal: unknown = await saveServerMenu({ workflows: [] }).catch((error: unknown) => error)
      expect(refusal).toBeInstanceOf(ServerMenuUnplacedError)
      expect(refusal).toMatchObject({ name: 'ServerMenuUnplacedError', status, message })
    }
    // Any other refusal stays a plain error.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({}) })))
    const other: unknown = await saveServerMenu({ workflows: [] }).catch((error: unknown) => error)
    expect(other).not.toBeInstanceOf(ServerMenuUnplacedError)
  })

  it('throws when a 200 answers a body that cannot be parsed as JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('not json')) })))
    await expect(saveServerMenu({ workflows: [] })).rejects.toThrow('server-menu save answered no usable document')
  })
})
