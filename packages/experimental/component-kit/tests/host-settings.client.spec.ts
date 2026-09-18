/**
 * The node half against the real webserver and the real catalog registry: the
 * base path is judged at load, served on its route with no caching, refused on
 * every other method, and absent — with the row still loading — where no
 * webserver is composed; and the row's six components reach the catalog under
 * this package's own name and version and leave with the fiber.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { COMPONENT_KIT_ENTRIES, ComponentCatalogRegistry } from '@deepseek-ai/dsh-experimental-component-surface'
import { readComponentKitSource } from '../src/manifest.ts'
import * as ComponentKit from '../src/index.ts'

/** This package's own manifest, which is what the row registers its components under. */
const OWN = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string
  version: string
}

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Boot the webserver on an OS-assigned port and this row over it. */
async function served(config: ComponentKit.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(ComponentKit, config).await()
  return ctx
}

/** The served route, as an absolute URL. */
function settingsUrl(ctx: Context): string {
  return `http://127.0.0.1:${String(ctx.webServer.port)}${ComponentKit.COMPONENT_KIT_SETTINGS_ROUTE}`
}

describe('the component-kit node half', () => {
  it('serves the configured base path, normalized and uncached', async () => {
    const ctx = await served({ bizBasePath: '/nrms-server' })
    const response = await fetch(settingsUrl(ctx))
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ bizBasePath: '/nrms-server/' })
  })

  it('serves the root where the deployment configured nothing', async () => {
    const ctx = await served()
    expect(await (await fetch(settingsUrl(ctx))).json()).toEqual({ bizBasePath: '/' })
  })

  it('answers HEAD and refuses every other method, naming the two it serves', async () => {
    const ctx = await served()
    expect((await fetch(settingsUrl(ctx), { method: 'HEAD' })).status).toBe(200)
    const refused = await fetch(settingsUrl(ctx), { method: 'POST' })
    expect(refused.status).toBe(405)
    expect(refused.headers.get('allow')).toBe('GET, HEAD')
  })

  it('refuses to load with a base path that is not a path', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await expect(ctx.plugin(ComponentKit, { bizBasePath: 'https://evil.example/' }).await()).rejects
      .toThrow('component-kit: bizBasePath must be a root-absolute path such as "/" or "/nrms-server/"')
  })

  it('loads without a webserver and serves nothing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ComponentKit, { bizBasePath: '/x/' }).await()
    expect(ctx.get('webServer')).toBeUndefined()
  })

  it('releases the route with the fiber', async () => {
    const ctx = await served()
    const fiber = ctx.plugin(ComponentKit, { bizBasePath: '/again/' })
    await fiber.await()
    await fiber.dispose()
    // The first registration is still there; the second's route went with it.
    expect(await (await fetch(settingsUrl(ctx))).json()).toEqual({ bizBasePath: '/' })
  })

  it('falls back to the root path where apply is reached with no configured one', () => {
    // The schema fills the field, so this is the path a caller reaching `apply`
    // directly takes — the Loader never does.
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => { ComponentKit.apply(ctx, {}) }).not.toThrow()
  })

  it('loads without a catalog and contributes nothing', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ComponentKit, {}).await()
    expect(ctx.get('componentCatalog')).toBeUndefined()
  })

  it('registers its six components under its own package name and version', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ComponentCatalogRegistry).await()
    const fiber = ctx.plugin(ComponentKit, {})
    await fiber.await()
    // The contribution lives in a grandchild fiber waiting on the registry, and
    // the row's own await does not reach it.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.componentCatalog.catalog.entries.map(entry => entry.id))
      .toEqual(COMPONENT_KIT_ENTRIES.map(entry => entry.id))
    expect(ctx.componentCatalog.components.map(one => one.source))
      .toEqual(COMPONENT_KIT_ENTRIES.map(() => ({ package: OWN.name, version: OWN.version })))
  })

  it('refuses a manifest carrying no name and version to attribute its components to', () => {
    expect(() => readComponentKitSource({ name: '@deepseek-ai/dsh-experimental-component-kit' }))
      .toThrow('component-kit: own package.json carries no name and version to register its components under')
    expect(() => readComponentKitSource(undefined))
      .toThrow('component-kit: own package.json carries no name and version to register its components under')
  })

  it('takes its components back out of the catalog with the fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(ComponentCatalogRegistry).await()
    const fiber = ctx.plugin(ComponentKit, {})
    await fiber.await()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(ctx.componentCatalog.catalog.entries).toHaveLength(COMPONENT_KIT_ENTRIES.length)

    await fiber.dispose()
    expect(ctx.componentCatalog.catalog.entries).toEqual([])
  })
})
