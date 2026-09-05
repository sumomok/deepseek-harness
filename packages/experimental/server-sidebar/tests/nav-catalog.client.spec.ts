/**
 * The navigation menu's two catalog reads and the merge over them: the
 * response shapes each owning route can answer, each reduced to what the menu
 * needs or contained to an empty list, and the one case the merge refuses
 * outright. `browser-plugin.client.spec.ts` covers the happy path through the
 * full registration; this file covers the failure, filtering and merge paths
 * that path never exercises.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTENT_SETTINGS_ROUTE } from '@deepseek-ai/dsh-experimental-content-frame/src/route.ts'
import { COMPONENT_VIEWS_ROUTE } from '@deepseek-ai/dsh-experimental-component-surface/src/route.ts'
import { mergeNavCatalogs, readContentPages, readContentViews } from '../src/client/nav-catalog.ts'

const PAGES_ROUTE = '/content-frame/settings'
const VIEWS_ROUTE = '/component-surface/views'

function stubFetch(impl: (input: URL) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): void {
  vi.stubGlobal('fetch', vi.fn(impl))
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the copied route paths', () => {
  it('address the routes the two owning packages actually serve', () => {
    // The literals above are deliberate copies rather than value imports (see
    // nav-catalog.ts's module documentation); a test-only import of each
    // owning constant is what makes the copies mechanically checkable, since a
    // drift would otherwise only show as a silently shorter menu.
    expect(PAGES_ROUTE).toBe(CONTENT_SETTINGS_ROUTE)
    expect(VIEWS_ROUTE).toBe(COMPONENT_VIEWS_ROUTE)
  })
})

describe('readContentPages', () => {
  it('requests its route through the deployment prefix the shell is served under', async () => {
    vi.stubGlobal('__DSH_BASE__', '/console/')
    const requested: string[] = []
    stubFetch(async (input) => {
      requested.push(input.pathname)
      return { ok: true, json: () => Promise.resolve({ pages: [] }) }
    })
    await readContentPages()
    expect(requested).toEqual(['/console/content-frame/settings'])
  })

  it('reduces a well-formed catalog to kind/id/title rows', async () => {
    stubFetch(async (input) => {
      expect(input.pathname).toBe(PAGES_ROUTE)
      return { ok: true, json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home', description: '', url: '/x' }] }) }
    })
    expect(await readContentPages()).toEqual({ items: [{ kind: 'page', entryId: 'home', title: 'Home' }] })
  })

  it('drops entries missing a usable id or title', async () => {
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }, { id: 42, title: 'Bad id' }, { id: 'no-title' }] }),
    }))
    expect(await readContentPages()).toEqual({ items: [{ kind: 'page', entryId: 'home', title: 'Home' }] })
  })

  it('answers empty when the route responds non-200', async () => {
    stubFetch(async () => ({ ok: false, json: () => Promise.resolve({}) }))
    expect(await readContentPages()).toEqual({ items: [] })
  })

  it('answers empty when the document has no pages array', async () => {
    stubFetch(async () => ({ ok: true, json: () => Promise.resolve({ cacheSize: 1 }) }))
    expect(await readContentPages()).toEqual({ items: [] })
  })

  it('contains a transport failure to an empty list rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('network down'))))
    expect(await readContentPages()).toEqual({ items: [] })
  })

  it('carries homePage through when it names a configured page', async () => {
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 'home' }),
    }))
    expect(await readContentPages()).toEqual({
      items: [{ kind: 'page', entryId: 'home', title: 'Home' }],
      home: { kind: 'page', entryId: 'home' },
    })
  })

  it('warns and drops homePage when it is not a string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 42 }),
    }))
    expect(await readContentPages()).toEqual({ items: [{ kind: 'page', entryId: 'home', title: 'Home' }] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('content-frame homePage is not a string'))
    warn.mockRestore()
  })

  it('warns and drops homePage when it names nothing the same response configures', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ pages: [{ id: 'home', title: 'Home' }], homePage: 'reports' }),
    }))
    expect(await readContentPages()).toEqual({ items: [{ kind: 'page', entryId: 'home', title: 'Home' }] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('content-frame homePage "reports" names nothing it configures'))
    warn.mockRestore()
  })
})

describe('readContentViews', () => {
  it('reads the views route and marks every row as a view', async () => {
    stubFetch(async (input) => {
      expect(input.pathname).toBe(VIEWS_ROUTE)
      return { ok: true, json: () => Promise.resolve({ views: [{ id: 'sales', title: '销售看板' }], homeView: 'sales' }) }
    })
    expect(await readContentViews()).toEqual({
      items: [{ kind: 'view', entryId: 'sales', title: '销售看板' }],
      home: { kind: 'view', entryId: 'sales' },
    })
  })

  it('degrades to no rows when component-surface is not composed at all', async () => {
    stubFetch(async () => ({ ok: false, json: () => Promise.resolve({}) }))
    expect(await readContentViews()).toEqual({ items: [] })
  })

  it('names component-surface in its own home warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubFetch(async () => ({
      ok: true,
      json: () => Promise.resolve({ views: [{ id: 'sales', title: '销售看板' }], homeView: 'gone' }),
    }))
    expect(await readContentViews()).toEqual({ items: [{ kind: 'view', entryId: 'sales', title: '销售看板' }] })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('component-surface homeView "gone" names nothing it configures'))
    warn.mockRestore()
  })
})

describe('mergeNavCatalogs', () => {
  const page = { kind: 'page', entryId: 'home', title: 'Home' } as const
  const view = { kind: 'view', entryId: 'sales', title: '销售看板' } as const

  it('lists every page before every view, each in its own declaration order', () => {
    const merged = mergeNavCatalogs(
      { items: [page, { kind: 'page', entryId: 'docs', title: 'Docs' }] },
      { items: [view, { kind: 'view', entryId: 'ops', title: '运维' }] },
    )
    expect(merged.items.map(item => `${item.kind}:${item.entryId}`)).toEqual(['page:home', 'page:docs', 'view:sales', 'view:ops'])
    expect(merged.home).toBeUndefined()
  })

  it('degrades to the page half alone when the views route contributed nothing', () => {
    expect(mergeNavCatalogs({ items: [page], home: { kind: 'page', entryId: 'home' } }, { items: [] })).toEqual({
      items: [page],
      home: { kind: 'page', entryId: 'home' },
    })
  })

  it('carries a lone homeView through as the automatic home', () => {
    expect(mergeNavCatalogs({ items: [] }, { items: [view], home: { kind: 'view', entryId: 'sales' } }).home)
      .toEqual({ kind: 'view', entryId: 'sales' })
  })

  it('refuses a deployment that configures both automatic homes', () => {
    expect(() => mergeNavCatalogs(
      { items: [page], home: { kind: 'page', entryId: 'home' } },
      { items: [view], home: { kind: 'view', entryId: 'sales' } },
    )).toThrow(/homePage "home".*homeView "sales".*one automatic home, not both/s)
  })
})
