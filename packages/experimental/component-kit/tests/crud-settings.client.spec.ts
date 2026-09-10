// @vitest-environment jsdom
/**
 * How the base path reaches the data page's request layer: read once from the
 * node half, applied through the kit, and held on one promise the renderer
 * waits on — with the failure kept on that promise rather than raised at the
 * row.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getBizBasePath } from '@sumomok/toy-crud-kit'
import { COMPONENT_KIT_SETTINGS_ROUTE } from '../src/route.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetModules()
})

/** Answer the settings route with one document, or one status, and count the reads. */
function serve(document: unknown, status = 200): { requested: string[] } {
  const requested: string[] = []
  vi.stubGlobal('fetch', vi.fn((input: URL) => {
    requested.push(input.href)
    if (!input.pathname.endsWith(COMPONENT_KIT_SETTINGS_ROUTE)) throw new Error(`unexpected fetch: ${input.href}`)
    return Promise.resolve({ ok: status === 200, status, json: () => Promise.resolve(document) })
  }))
  return { requested }
}

/** A fresh copy of the module, so each case starts before the row's browser half ran. */
async function fresh(): Promise<typeof import('../src/client/crud-settings.ts')> {
  return import('../src/client/crud-settings.ts')
}

describe('the data page\'s base path', () => {
  it('is read once, applied to the request layer, and handed to every waiter', async () => {
    const { requested } = serve({ bizBasePath: '/probe-base' })
    const settings = await fresh()
    const first = settings.settleCrudBasePath()
    const second = settings.settleCrudBasePath()
    expect(second).toBe(first)
    expect(await first).toBe('/probe-base/')
    expect(await settings.crudBasePathReady()).toBe('/probe-base/')
    expect(getBizBasePath()).toBe('/probe-base/')
    expect(requested).toEqual([new URL(COMPONENT_KIT_SETTINGS_ROUTE.slice(1), `${location.origin}/`).href])
  })

  it('fails the page, not the row, when the route answers something else', async () => {
    serve({ bizBasePath: 'relative' })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = await fresh()
    await expect(settings.settleCrudBasePath()).rejects.toThrow('answered a document with no usable bizBasePath')
    await expect(settings.crudBasePathReady()).rejects.toThrow('answered a document with no usable bizBasePath')
    expect(error).toHaveBeenCalledTimes(1)
    expect(String(error.mock.calls[0]?.[0])).toContain('component-kit: the data page cannot open')
  })

  it('names the status when the route is not there', async () => {
    serve(undefined, 503)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const settings = await fresh()
    await expect(settings.settleCrudBasePath()).rejects.toThrow('answered 503')
  })

  it('refuses a page drawn before the row\'s browser half started', async () => {
    const settings = await fresh()
    await expect(settings.crudBasePathReady()).rejects.toThrow('drawn before the row\'s browser half started')
  })
})
