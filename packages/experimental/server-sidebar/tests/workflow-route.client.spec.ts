/**
 * REAL-composition coverage for this package's node half: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver, the
 * real file-backed settings provider, and the server-sidebar row, and every
 * assertion observes the served HTTP surface — the server-menu document, the
 * same-site and content-type fences on the mutating method, the schema and
 * duplicate-id refusals, the merge-not-replace patch semantics, persistence
 * surviving a reload of the composition, and route release on fiber
 * disposal.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test — the node half of a dual-face client package is
 * spelled this way (dsh-client-modules, dsh-client-hmr).
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import FileSettingsProvider from '@deepseek-ai/dsh-settings-file'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as ServerSidebar from '../src/index.ts'
import { SERVER_MENU_ROUTE } from '../src/route.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** One served response, reduced to what the assertions read. */
interface Answer {
  status: number
  type: string | null
  allow: string | null
  cacheControl: string | null
  body: string
}

/**
 * Write a three-row cordis.yml and boot it through the real Loader.
 * @param existingWorld - reuse this directory (and its settings document)
 * instead of creating a fresh one, to prove persistence survives a reload.
 */
async function loadComposition(existingWorld?: string): Promise<Context> {
  world = existingWorld ?? await mkdtemp(join(tmpdir(), 'dsh-server-sidebar-'))
  const documentPath = join(world, 'settings.yaml')
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-invariants'",
    '  config:',
    '    enabled: true',
    "- name: '@deepseek-ai/dsh-settings-file'",
    '  config:',
    `    path: '${documentPath}'`,
    `    dshHome: '${world}'`,
    '    watch: false',
    '- id: server-sidebar',
    "  name: '@deepseek-ai/dsh-experimental-server-sidebar'",
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-invariants', InvariantRegistry],
    ['@deepseek-ai/dsh-settings-file', FileSettingsProvider],
    ['@deepseek-ai/dsh-experimental-server-sidebar', ServerSidebar],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Issue one request against the running server. */
async function call(ctx: Context, path: string, init: RequestInit = {}): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    body: await response.text(),
  }
}

/** POST one server-menu patch. */
function postPatch(ctx: Context, body: unknown, headers: Record<string, string> = {}): Promise<Answer> {
  return call(ctx, SERVER_MENU_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const WORKFLOW = { id: 'w1', name: 'Alpha', order: 0, homeSessionId: 's1', navSnapshot: ['home'], savedAt: 1 }

describe('server-sidebar server-menu route', () => {
  it('answers an empty document before anything is saved, uncached', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SERVER_MENU_ROUTE)
    expect(answer.status).toBe(200)
    expect(answer.type).toBe('application/json')
    expect(answer.cacheControl).toBe('no-store')
    expect(JSON.parse(answer.body)).toEqual({ workflows: [] })
  })

  it('serves a HEAD of the server-menu document', async () => {
    const ctx = await loadComposition()
    expect((await call(ctx, SERVER_MENU_ROUTE, { method: 'HEAD' })).status).toBe(200)
  })

  it('persists a posted workflows patch and answers the server\'s authoritative document', async () => {
    const ctx = await loadComposition()
    const posted = await postPatch(ctx, { workflows: [WORKFLOW] })
    expect(posted.status).toBe(200)
    expect(JSON.parse(posted.body)).toEqual({ workflows: [WORKFLOW] })

    const read = await call(ctx, SERVER_MENU_ROUTE)
    expect(JSON.parse(read.body)).toEqual({ workflows: [WORKFLOW] })
  })

  it('merges a workbenchSessionId-only patch without disturbing an existing workflow list', async () => {
    const ctx = await loadComposition()
    await postPatch(ctx, { workflows: [WORKFLOW] })
    const posted = await postPatch(ctx, { workbenchSessionId: 'home-1' })
    expect(JSON.parse(posted.body)).toEqual({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' })

    const workflowsOnly = await postPatch(ctx, { workflows: [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }] })
    expect(JSON.parse(workflowsOnly.body)).toEqual({
      workflows: [WORKFLOW, { ...WORKFLOW, id: 'w2', name: 'Beta', order: 1 }],
      workbenchSessionId: 'home-1',
    })
  })

  it('refuses a workflows list with a duplicate id', async () => {
    const ctx = await loadComposition()
    const answer = await postPatch(ctx, { workflows: [WORKFLOW, { ...WORKFLOW, name: 'Duplicate' }] })
    expect(answer.status).toBe(400)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: duplicate workflow id "w1"' })
    expect(JSON.parse((await call(ctx, SERVER_MENU_ROUTE)).body)).toEqual({ workflows: [] })
  })

  it('refuses a body shaped wrong before it ever reaches the schema', async () => {
    const ctx = await loadComposition()
    for (const body of ['not json', {}, { workflows: 'nope' }, { workbenchSessionId: 42 }, { workflows: [{ id: 1 }] }]) {
      const answer = await postPatch(ctx, body)
      expect(answer.status).toBe(400)
    }
  })

  it('refuses a post a browser labelled cross-site', async () => {
    const ctx = await loadComposition()
    const answer = await postPatch(ctx, { workflows: [] }, { 'sec-fetch-site': 'cross-site' })
    expect(answer.status).toBe(403)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: the server-menu route serves same-site requests only' })
  })

  it('refuses a post that is not sent as JSON', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SERVER_MENU_ROUTE, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    })
    expect(answer.status).toBe(415)
    expect(JSON.parse(answer.body)).toEqual({ error: 'server-sidebar: the server-menu route accepts application/json only' })
  })

  it('refuses a body past the bound instead of buffering it', async () => {
    const ctx = await loadComposition()
    const answer = await postPatch(ctx, {
      workflows: [{ ...WORKFLOW, name: 'A'.repeat(80 * 1024) }],
    })
    expect(answer.status).toBe(413)
  })

  it('states the complete method set it serves', async () => {
    const ctx = await loadComposition()
    const answer = await call(ctx, SERVER_MENU_ROUTE, { method: 'DELETE' })
    expect({ status: answer.status, allow: answer.allow }).toEqual({ status: 405, allow: 'GET, HEAD, POST' })
  })

  it('persists across a reload of the composition (per-account durability)', async () => {
    const ctx = await loadComposition()
    const world1 = world
    await postPatch(ctx, { workflows: [WORKFLOW], workbenchSessionId: 'home-1' })
    await ctx.fiber.dispose()
    context = undefined

    const reloaded = await loadComposition(world1)
    expect(JSON.parse((await call(reloaded, SERVER_MENU_ROUTE)).body)).toEqual({ workflows: [WORKFLOW], workbenchSessionId: 'home-1' })
  })

  it('releases the route when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition()
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-sidebar')
    await row?.fiber?.dispose()
    const answer = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_MENU_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })
})

describe('server-sidebar without the settings capability', () => {
  it('loads with no server-menu route rather than failing the row', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-server-sidebar-nosettings-'))
    const configPath = join(world, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-host-webserver'",
      '  config:',
      "    host: '127.0.0.1'",
      '    port: 0',
      "- name: '@deepseek-ai/dsh-experimental-server-sidebar'",
      '',
    ].join('\n'))
    context = new Context()
    context.baseUrl = pathToFileURL(world).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', HttpServer],
      ['@deepseek-ai/dsh-experimental-server-sidebar', ServerSidebar],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()
    const unloaded = [...context.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    expect(unloaded).toEqual([])
    const answer = await fetch(`http://127.0.0.1:${String(context.webServer.port)}${SERVER_MENU_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })
})
