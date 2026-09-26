/**
 * REAL-composition coverage for this package: a test-only cordis.yml booted
 * through the vendored Loader mounts the web server, the static dist server,
 * and the server-base row, and every assertion reads the index the composition
 * actually serves — the Host-ownership carrier a deployment that claims the
 * Host adds and its position ahead of the document's own scripts and of a
 * competing injector's rows, the dist server's own `<base href="./">` left as
 * the document's only base element, the index a deployment that claims nothing
 * is served, and the release of the row on fiber disposal.
 *
 * The configuration cases call the `Config` schema directly: a rejected claim
 * never reaches a served index, so there is nothing for HTTP to observe.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import * as ServerBase from '../src/index.ts'

/** A dist index in the shape the shell build emits under `base: './'`. */
const DIST_INDEX = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <link rel="manifest" href="./manifest.webmanifest" />',
  '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
  '    <title>DSH Local Build</title>',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
  '',
].join('\n')

/**
 * The carrier a deployment claiming the Host serves, pinned verbatim: `fetch`
 * is the page's own, which keeps the RPC on HTTP and on the Gateway WebSocket,
 * and the absent `openStream` and `loadBundle` are what leave the plugin
 * bundles loading over HTTP.
 */
const OWNS_HOST_MARKUP
  = '<script>globalThis.__DSH_TRANSPORT__ ??= { fetch: (input, init) => globalThis.fetch(input, init), ownsHost: true };</script>'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/**
 * Write a dist and a cordis.yml over it, then boot the composition through the
 * real Loader.
 * @param row - `null` to compose without the server-base row at all, `claims`
 * for a row carrying `ownsHost: true`, and `silent` for a row whose config
 * leaves the field out, which is the deployment that states no ownership claim.
 * @param earlierRow - a row contributed by a listener registered before the
 * server-base row is created, standing in for a plugin that activates first.
 * @returns the booted root context.
 */
async function loadComposition(
  row: 'claims' | 'silent' | null = 'claims', earlierRow?: IndexInjection,
): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-server-base-'))
  const dist = join(world, 'dist')
  await mkdir(dist)
  const distIndex = join(dist, 'index.html')
  await writeFile(distIndex, DIST_INDEX)
  const configPath = join(world, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-credentials-local'",
    '  config:',
    `    path: ${JSON.stringify(join(world, '.credentials.yaml'))}`,
    '    watch: false',
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // The dist server authorizes an index render through the launch-token
    // session this row owns, so the index is unreachable without it.
    "- name: '@deepseek-ai/dsh-client-connection'",
    "- name: '@deepseek-ai/dsh-host-frontend-static'",
    '  config:',
    `    distIndex: ${JSON.stringify(distIndex)}`,
  ]
  if (row !== null) {
    rows.push('- id: server-base', "  name: '@deepseek-ai/dsh-experimental-server-base'")
    if (row === 'claims') rows.push('  config:', '    ownsHost: true')
  }
  await writeFile(configPath, `${rows.join('\n')}\n`)

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  if (earlierRow !== undefined) {
    context.on('webserver/index-inject', (table) => { table.push(earlierRow) })
  }
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-credentials-local', LocalCredentials],
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-host-frontend-static', FrontendStatic],
    ['@deepseek-ai/dsh-experimental-server-base', ServerBase],
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
  // Loader settlement does not reject a failed plugin; each fiber's own await rethrows it.
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return context
}

/**
 * Fetch the served index of a booted composition, through the one-time launch
 * token `dsh web` gates its origin behind: exchanging it leaves the browser
 * session cookie the dist server authorizes an index render with.
 * @param ctx - the booted composition.
 * @returns the served index html.
 */
async function fetchIndex(ctx: Context): Promise<string> {
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  const exchange = await fetch(ctx.connection.authenticatedUrl(origin), { redirect: 'manual' })
  const setCookie = exchange.headers.get('set-cookie')
  if (setCookie === null) throw new Error('launch-token exchange set no session cookie')
  const response = await fetch(`${origin}/`, { headers: { cookie: setCookie.split(';', 1)[0]! } })
  expect(response.status).toBe(200)
  return await response.text()
}

describe('server-base index row', () => {
  it('serves the ownership carrier ahead of the shell\'s entry module when the deployment claims the Host', async () => {
    const html = await fetchIndex(await loadComposition('claims'))
    const carrierAt = html.indexOf(OWNS_HOST_MARKUP)
    expect(carrierAt).toBeGreaterThan(html.indexOf('<head>'))
    // `client-connection` reads the global once, at its own plugin boot, so
    // the carrier has to be in the document ahead of the shell's entry module.
    expect(carrierAt).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('places the carrier ahead of rows contributed by an earlier injector', async () => {
    // The client module system contributes parser-blocking bundle tags from a
    // listener of its own, and nothing orders plugin activation. Registering
    // the competing listener before the row is created is the case the
    // prepend has to survive.
    const bundleTag: IndexInjection = { kind: 'script-src', placement: 'head', src: 'plugins/x/client.js' }
    const html = await fetchIndex(await loadComposition('claims', bundleTag))
    const bundleAt = html.indexOf('<script src="plugins/x/client.js">')
    expect(bundleAt).toBeGreaterThan(-1)
    expect(html.indexOf(OWNS_HOST_MARKUP)).toBeLessThan(bundleAt)
  })

  it('leaves the dist server\'s document base as the only base element', async () => {
    const html = await fetchIndex(await loadComposition('claims'))
    // The deployment prefix is the dist server's `<base href="./">`, which
    // resolves every page URL under the mount the page was loaded from; a
    // second base element from this row would override it.
    expect(html.match(/<base\b/gi)).toHaveLength(1)
    expect(html).toContain('<base href="./">')
  })

  it('serves no ownership carrier for a deployment that claims nothing', async () => {
    // The default is the deployment whose page is reached by whoever the
    // network lets through, and the client reads such a page as somebody
    // else's Host from the authority alone.
    expect(await fetchIndex(await loadComposition('silent'))).not.toContain('__DSH_TRANSPORT__')
    expect(await fetchIndex(await loadComposition(null))).not.toContain('__DSH_TRANSPORT__')
  })

  it('releases the carrier when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition('claims')
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-base')
    await row?.fiber?.dispose()
    expect(await fetchIndex(ctx)).not.toContain('__DSH_TRANSPORT__')
  })
})

describe('server-base configuration', () => {
  it('leaves a deployment that says nothing about ownership claiming nothing', () => {
    expect(ServerBase.Config({}).ownsHost).toBe(false)
    expect(ServerBase.Config({ ownsHost: true }).ownsHost).toBe(true)
  })

  it('rejects an ownership claim that is not a boolean', () => {
    // The claim decides which surface the client offers every admitted
    // visitor, so a value that is not a boolean fails the row instead of being
    // read for its truthiness.
    expect(() => ServerBase.Config({ ownsHost: 'yes' } as never))
      .toThrow('$.ownsHost expected boolean but got yes')
  })

  it('names itself and the service it waits for', () => {
    expect(ServerBase.name).toBe('server-base')
    expect(ServerBase.inject).toEqual(['webServer'])
  })
})
