/**
 * REAL-composition coverage for this package: a test-only cordis.yml booted
 * through the vendored Loader mounts the web server, the static dist server,
 * and the server-base row, and every assertion reads the index the composition
 * actually serves — the `<base>` element and its position ahead of the
 * document's own asset references and of a competing injector's rows, the
 * `__DSH_BASE__` global, the prefix-free index a composition without the row
 * serves, the Host-ownership carrier a deployment that claims the Host adds,
 * and the release of the rows on fiber disposal.
 *
 * The configuration cases call `requireBasePath` and the `Config` schema
 * directly: a rejected prefix never reaches a served index, so there is nothing
 * for HTTP to observe.
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

const BASE_PATH = '/console/'

/**
 * A dist index in the shape the shell build emits under `base: './'`: the
 * asset references are relative, so they are exactly what a `<base>` element
 * ahead of them has to govern.
 */
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
 * @param basePath - prefix for the server-base row, or null to compose
 * without that row at all.
 * @param earlierRow - a row contributed by a listener registered before the
 * server-base row is created, standing in for a plugin that activates first.
 * @param ownsHost - written into the row when true; left out of the yaml when
 * false, which is the deployment that states no ownership claim at all.
 * @returns the booted root context.
 */
async function loadComposition(
  basePath: string | null = BASE_PATH, earlierRow?: IndexInjection, ownsHost = false,
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
  if (basePath !== null) {
    rows.push(
      '- id: server-base',
      "  name: '@deepseek-ai/dsh-experimental-server-base'",
      '  config:',
      `    basePath: ${JSON.stringify(basePath)}`,
    )
    if (ownsHost) rows.push('    ownsHost: true')
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

describe('server-base index rows', () => {
  it('serves the configured prefix as the document\'s only base element', async () => {
    const html = await fetchIndex(await loadComposition())
    const headAt = html.indexOf('<head>')
    const baseAt = html.indexOf(`<base href="${BASE_PATH}">`)
    expect(baseAt).toBeGreaterThan(headAt)
    // The dist server prepends its own `<base href="/">` after `<head>`, ahead
    // of the injected rows, so a revert of its stand-aside guard leaves two
    // base elements and the parser honors the root one — while every ordering
    // case below still passes, because both precede the assets. The count is
    // the only assertion that fails.
    expect(html.match(/<base\b/gi)).toHaveLength(1)
  })

  it('places the base element ahead of every asset reference it has to govern', async () => {
    const html = await fetchIndex(await loadComposition())
    const baseAt = html.indexOf(`<base href="${BASE_PATH}">`)
    // A `<base>` governs only what follows it, so a link or script rendered
    // first would keep resolving against the document URL — the whole prefix
    // would apply to some URLs and not others.
    expect(baseAt).toBeGreaterThan(-1)
    expect(baseAt).toBeLessThan(html.indexOf('<link'))
    expect(baseAt).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('places the base element ahead of rows contributed by an earlier injector', async () => {
    // The client module system contributes parser-blocking bundle tags from a
    // listener of its own; its rows must resolve against the prefix too, and
    // nothing orders plugin activation. Registering the competing listener
    // before the row is created is the case that ordering has to survive.
    const bundleTag: IndexInjection = { kind: 'script-src', placement: 'head', src: 'plugins/x/client.js' }
    const html = await fetchIndex(await loadComposition(BASE_PATH, bundleTag))
    const bundleAt = html.indexOf('<script src="plugins/x/client.js">')
    expect(bundleAt).toBeGreaterThan(-1)
    expect(html.indexOf(`<base href="${BASE_PATH}">`)).toBeLessThan(bundleAt)
  })

  it('serves the same prefix as a global readable before any document script', async () => {
    const html = await fetchIndex(await loadComposition())
    expect(html).toContain(`<script>globalThis["${ServerBase.DSH_BASE_GLOBAL}"] = "${BASE_PATH}"</script>`)
  })

  it('serves no ownership carrier for a deployment that claims nothing', async () => {
    const html = await fetchIndex(await loadComposition())
    // The default is the deployment whose page is reached by whoever the
    // network lets through, and the client reads such a page as somebody
    // else's Host from the authority alone.
    expect(html).not.toContain('__DSH_TRANSPORT__')
  })

  it('serves the ownership carrier behind the base element when the deployment claims the Host', async () => {
    const html = await fetchIndex(await loadComposition(BASE_PATH, undefined, true))
    const baseAt = html.indexOf(`<base href="${BASE_PATH}">`)
    const carrierAt = html.indexOf(OWNS_HOST_MARKUP)
    expect(baseAt).toBeGreaterThan(-1)
    expect(carrierAt).toBeGreaterThan(baseAt)
    // `client-connection` reads the global once, at its own plugin boot, so
    // the carrier has to be in the document ahead of the shell's entry module.
    expect(carrierAt).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('serves the root prefix a process at the origin root is configured with', async () => {
    const html = await fetchIndex(await loadComposition('/'))
    expect(html).toContain('<base href="/">')
    expect(html).toContain(`<script>globalThis["${ServerBase.DSH_BASE_GLOBAL}"] = "/"</script>`)
  })

  it('leaves the index on the dist server\'s own site-root anchor when the row is not composed', async () => {
    const html = await fetchIndex(await loadComposition(null))
    // The dist server anchors a prefix-less deployment at the site root itself,
    // and stands aside for the row above when one is composed; what this row's
    // absence must leave behind is that anchor and no prefix global.
    expect(html).toContain('<base href="/">')
    expect(html).not.toContain(ServerBase.DSH_BASE_GLOBAL)
  })

  it('releases both rows when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition()
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'server-base')
    await row?.fiber?.dispose()
    const html = await fetchIndex(ctx)
    // Back to the dist server's own site-root anchor, which is what a
    // composition without this row serves.
    expect(html).toContain('<base href="/">')
    expect(html).not.toContain(`<base href="${BASE_PATH}">`)
    expect(html).not.toContain(ServerBase.DSH_BASE_GLOBAL)
  })
})

describe('server-base configuration', () => {
  it('takes an absolute, slash-terminated path', () => {
    for (const basePath of ['/', '/console/', '/a/b/', '/team~1/x.y/']) {
      expect(ServerBase.requireBasePath(basePath)).toBe(basePath)
    }
  })

  it('rejects a prefix the browser could not resolve its URLs against', () => {
    for (const [basePath, message] of [
      ['console/', 'server-base: basePath must start with "/", received "console/"'],
      ['/console', 'server-base: basePath must end with "/", received "/console"'],
      ['/console/?a=1/', 'server-base: basePath must carry no query string, received "/console/?a=1/"'],
      ['/console/#x/', 'server-base: basePath must carry no fragment, received "/console/#x/"'],
      ['/console//', 'server-base: basePath must carry no empty path segment, received "/console//"'],
      ['/con sole/', 'server-base: basePath must be a plain URL path, received "/con sole/"'],
      // Refusing the characters is what keeps the value safe to place in the
      // element's quoted attribute without an escaping step in between.
      ['/"><script>x</script>/', 'server-base: basePath must be a plain URL path, received "/"><script>x</script>/"'],
      // `&` is a legal path sub-delimiter, refused for the same reason: inside
      // an attribute value it begins a character reference, so the served
      // prefix would not read back as the configured one.
      ['/a&b/', 'server-base: basePath must be a plain URL path, received "/a&b/"'],
    ] as const) {
      expect(() => ServerBase.requireBasePath(basePath)).toThrow(message)
    }
  })

  it('leaves a deployment that says nothing about ownership claiming nothing', () => {
    expect(ServerBase.Config({ basePath: BASE_PATH }).ownsHost).toBe(false)
    expect(ServerBase.Config({ basePath: BASE_PATH, ownsHost: true }).ownsHost).toBe(true)
  })

  it('rejects an ownership claim that is not a boolean', () => {
    // The claim decides which surface the client offers every admitted
    // visitor, so a value that is not a boolean fails the row instead of being
    // read for its truthiness.
    expect(() => ServerBase.Config({ basePath: BASE_PATH, ownsHost: 'yes' } as never))
      .toThrow('$.ownsHost expected boolean but got yes')
  })

  it('names itself and the service it waits for', () => {
    expect(ServerBase.name).toBe('server-base')
    expect(ServerBase.inject).toEqual(['webServer'])
  })
})
