/**
 * The node half against the real webserver and the real catalog registry: the
 * base path is judged at load, served on its route with no caching, refused on
 * every other method, and absent — with the row still loading — where no
 * webserver is composed; the ability route answers the rights judgement of the
 * composed data backend, and is not claimed without one; and every component
 * of the row reaches the catalog under this package's own name and version and
 * leaves with the fiber.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import { COMPONENT_KIT_ENTRIES, ComponentCatalogRegistry } from '@deepseek-ai/dsh-experimental-component-surface'
import {
  BizBackendService,
  BizOperationRules,
  type BizBackendFailure,
  type BizSubject,
  type BizUserRights,
  type PrincipalKey,
} from '@deepseek-ai/dsh-experimental-biz-backend'
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

/** What the stub backend's rights read answers with, per case. */
let rights: BizUserRights | BizBackendFailure = { resclass: [], rows: [] }

/** The person the stub's resolver admits every request as, or nobody, per case. */
let admitted: PrincipalKey | undefined = brandString<PrincipalKey>('visitor-a')

/** Whom every rights read was for, in order. */
let readFor: BizSubject[] = []

afterEach(() => {
  rights = { resclass: [], rows: [] }
  admitted = brandString<PrincipalKey>('visitor-a')
  readFor = []
})

/** The real data-backend service with its rights read stubbed, so the judgement is the deployment's own. */
class StubBizBackend extends BizBackendService {
  /**
   * Install the stub as `ctx.bizBackend`, judging by the default rules.
   * @param ctx - the context that owns it.
   */
  constructor(ctx: Context) {
    super(ctx, 'https://biz.invalid/', { resolve: () => undefined, principalOfRequest: () => admitted }, BizOperationRules({}))
  }

  /**
   * Answer the rights read.
   * @param subject - whom the read is for.
   * @returns what the case stated.
   */
  override userRights(subject: BizSubject): Promise<BizUserRights | BizBackendFailure> {
    readFor.push(subject)
    return Promise.resolve(rights)
  }
}

/** The stub as a plugin. */
const StubBackendPlugin = { name: 'stub-biz-backend', apply: (ctx: Context) => { new StubBizBackend(ctx) } }

/**
 * The ability route for one table, as an absolute URL.
 * @param ctx - the served context.
 * @param meta - the table, or nothing for a request naming none.
 * @returns the URL.
 */
function abilitiesUrl(ctx: Context, meta?: string): string {
  const url = new URL(`http://127.0.0.1:${String(ctx.webServer.port)}${ComponentKit.COMPONENT_KIT_ABILITIES_ROUTE}`)
  if (meta !== undefined) url.searchParams.set('meta', meta)
  return url.href
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

  it('registers every one of its components under its own package name and version', async () => {
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

  it('answers what the signed-in visitor may do on one table, judged by the composed backend', async () => {
    rights = { resclass: [{ resclassenname: 'SpaceLayer', operations: ['add'] }, { resclassenname: 'CITY', operations: [] }], rows: [] }
    const ctx = await served()
    await ctx.plugin(StubBackendPlugin).await()
    const answer = await fetch(abilitiesUrl(ctx, 'SpaceLayer'))
    expect(answer.status).toBe(200)
    expect(answer.headers.get('cache-control')).toBe('no-store')
    expect(await answer.json()).toEqual({ create: true, update: false, delete: false, import: true, export: true })
    expect(await (await fetch(abilitiesUrl(ctx, 'CITY'))).json())
      .toEqual({ create: false, update: false, delete: false, import: false, export: true })
    // A table the rights table holds no row for, and one nobody has.
    expect(await (await fetch(abilitiesUrl(ctx, 'SITE'))).json()).toEqual(ComponentKit.NO_ABILITIES)
    // Every one of the three reads was of the rights of the person the request was admitted as.
    expect(readFor).toEqual(Array.from({ length: 3 }, () => ({ kind: 'principal', principal: 'visitor-a' })))
  })

  it('answers 401 and reads nothing for a request that names nobody signed in', async () => {
    admitted = undefined
    rights = { resclass: [{ resclassenname: 'SpaceLayer', operations: ['add'] }], rows: [] }
    const ctx = await served()
    await ctx.plugin(StubBackendPlugin).await()
    const answer = await fetch(abilitiesUrl(ctx, 'SpaceLayer'))
    expect(answer.status).toBe(401)
    expect(await answer.json()).toEqual({ error: 'component-kit: this request names no signed-in person whose rights could be read' })
    expect(readFor).toEqual([])
  })

  it('answers every ability off when the rights cannot be read or name no table', async () => {
    const ctx = await served()
    await ctx.plugin(StubBackendPlugin).await()
    for (const answered of [
      { kind: 'unauthenticated' },
      { kind: 'rejected', status: 400, code: 1, message: '用户未授权' },
      { resclass: [], rows: [] },
    ] as const) {
      rights = answered
      expect(await (await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).json()).toEqual(ComponentKit.NO_ABILITIES)
    }
  })

  it('refuses a request naming no table, and every method but GET', async () => {
    const ctx = await served()
    await ctx.plugin(StubBackendPlugin).await()
    const unnamed = await fetch(abilitiesUrl(ctx))
    expect(unnamed.status).toBe(400)
    expect(await unnamed.json()).toEqual({ error: 'component-kit: expected the table as a non-empty `meta` query parameter' })
    expect((await fetch(abilitiesUrl(ctx, ''))).status).toBe(400)
    const posted = await fetch(abilitiesUrl(ctx, 'SpaceLayer'), { method: 'POST' })
    expect(posted.status).toBe(405)
    expect(posted.headers.get('allow')).toBe('GET')
  })

  it('claims no ability route without a data backend, and gives it up with the backend', async () => {
    const ctx = await served()
    expect((await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).status).toBe(404)
    const backend = ctx.plugin(StubBackendPlugin)
    await backend.await()
    expect((await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).status).toBe(200)
    await backend.dispose()
    expect((await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).status).toBe(404)
  })

  it('gives the ability route up with the row\'s own fiber', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 }).await()
    await ctx.plugin(StubBackendPlugin).await()
    const row = ctx.plugin(ComponentKit, {})
    await row.await()
    expect((await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).status).toBe(200)
    await row.dispose()
    expect((await fetch(abilitiesUrl(ctx, 'SpaceLayer'))).status).toBe(404)
  })
})
