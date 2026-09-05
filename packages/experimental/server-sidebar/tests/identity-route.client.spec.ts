/**
 * REAL-composition coverage for the identity settings route: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver and the
 * server-sidebar row, and every assertion observes the served HTTP surface —
 * the served claim name, its cache directive, the method set, and route
 * release on fiber disposal. The settings capability is deliberately absent:
 * this route is the half of the node plugin that a composition without
 * durable settings still gets.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs
 * to, not the face under test (see `workflow-route.client.spec.ts`).
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
import * as ServerSidebar from '../src/index.ts'
import { SERVER_IDENTITY_ROUTE } from '../src/route.ts'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/** Write a two-row cordis.yml and boot it through the real Loader. */
async function loadComposition(displayNameClaim: string): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-server-sidebar-identity-'))
  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: server-sidebar',
    "  name: '@deepseek-ai/dsh-experimental-server-sidebar'",
    '  config:',
    `    displayNameClaim: '${displayNameClaim}'`,
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
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

/** Issue one request against the running server. */
async function call(ctx: Context, init: RequestInit = {}): Promise<{
  status: number
  cacheControl: string | null
  allow: string | null
  body: string
}> {
  const response = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_IDENTITY_ROUTE}`, init)
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    allow: response.headers.get('allow'),
    body: await response.text(),
  }
}

describe('server-sidebar identity route', () => {
  it('serves the configured claim name, uncached', async () => {
    const ctx = await loadComposition('login_uname')
    const answer = await call(ctx)
    expect(answer.status).toBe(200)
    expect(answer.cacheControl).toBe('no-store')
    expect(JSON.parse(answer.body)).toEqual({ displayNameClaim: 'login_uname' })
  })

  it('serves a HEAD of the same document', async () => {
    const ctx = await loadComposition('login_uname')
    expect((await call(ctx, { method: 'HEAD' })).status).toBe(200)
  })

  it('states the complete method set it serves', async () => {
    const ctx = await loadComposition('login_uname')
    const answer = await call(ctx, { method: 'POST' })
    expect({ status: answer.status, allow: answer.allow }).toEqual({ status: 405, allow: 'GET, HEAD' })
  })

  it('releases the route when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition('login_uname')
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-sidebar')
    await row?.fiber?.dispose()
    const answer = await fetch(`http://127.0.0.1:${String(ctx.webServer.port)}${SERVER_IDENTITY_ROUTE}`)
    expect(answer.status).toBe(404)
    await answer.arrayBuffer()
  })

  it('refuses a blank claim name at load rather than showing everyone as anonymous', () => {
    expect(() => { ServerSidebar.apply(new Context(), { displayNameClaim: '  ' }) })
      .toThrow('server-sidebar: displayNameClaim must name a claim')
  })
})
