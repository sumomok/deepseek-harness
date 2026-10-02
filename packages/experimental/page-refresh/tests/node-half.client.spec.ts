// @vitest-environment jsdom
/**
 * REAL-composition coverage for the node half: a test-only cordis.yml booted
 * through the vendored Loader mounts the web server and this row, and the
 * assertions read the index the web server renders for its dist server — the
 * settings global with the schema's defaults or a deployment's own values, the
 * browser half's reading of that global and of the build the same index
 * carries, and the release of the row on fiber disposal. The index is rendered
 * through `renderIndex`, the call the static dist server makes for every index
 * response, with the `<base href="./">` that server then inserts; the session
 * check in front of that call belongs to the Host face of the connection
 * package, which this Client-program spec does not load.
 *
 * The configuration cases call the `Config` schema directly. One composition
 * case boots a row whose config the schema rejects: the row keeps its entry and
 * a fiber, which is what the client module registry lists a browser half by,
 * while the served index carries no settings global.
 *
 * The jsdom environment supplies the `DOMParser` the browser half reads the
 * served index's module scripts with.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as PageRefresh from '../src/index.ts'
import { PAGE_REFRESH_ENTRY_ID } from '../src/config.ts'
import { readServedBuild } from '../src/client/identity.ts'
import { readPageRefreshSettings } from '../src/client/settings.ts'
import { bootGraph, FakePage, revisions } from './fake-browser.client.ts'

/** A dist index in the form the shell build emits under `base: './'`. */
const DIST_INDEX = [
  '<!doctype html>',
  '<html lang="en">',
  '  <head>',
  '    <meta charset="utf-8" />',
  '    <script type="module" crossorigin src="./assets/index-abc.js"></script>',
  '    <title>DSH Local Build</title>',
  '  </head>',
  '  <body><div id="root"></div></body>',
  '</html>',
  '',
].join('\n')

/** The address the composition's index is served from. */
const SERVED_URL = 'https://console.example/console/'

/** The settings global as the schema's defaults render it. */
const DEFAULT_MARKUP = '<script>globalThis["__DSH_PAGE_REFRESH_CONFIG__"] = '
  + '{"checkOnVisible":true,"reloadDelayMs":0,"disconnectNotice":true,"stuckAfterSeconds":60}</script>'

let world: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (world !== undefined) await rm(world, { recursive: true, force: true })
  world = undefined
})

/**
 * Write a cordis.yml and boot it through the real Loader.
 * @param config - YAML lines of this row's `config` block; `null` for a row without one.
 * @returns the booted root context.
 */
async function loadComposition(config: string[] | null): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-page-refresh-'))
  const configPath = join(world, 'cordis.yml')
  const rows = [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    '- id: page-refresh',
    "  name: '@deepseek-ai/dsh-experimental-page-refresh'",
    ...config === null ? [] : ['  config:', ...config.map(line => `    ${line}`)],
  ]
  await writeFile(configPath, `${rows.join('\n')}\n`)

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  // The boot graph the client module system would contribute.
  context.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_BOOT__', value: bootGraph([{ id: 'a', rev: '1' }, { id: 'b', rev: '2' }]) })
  })
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-experimental-page-refresh', PageRefresh],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as never
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  // Loader settlement does not reject a failed plugin; each fiber's own await rethrows it.
  for (const entry of context.loader.entries()) await entry.fiber?.await()
  return context
}

/** The index the dist server would answer: rendered, then given its document base. */
function servedIndexOf(ctx: Context): string {
  return ctx.webServer.renderIndex(DIST_INDEX).replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="./">`)
}

/** The value the served index assigns to the settings global. */
function servedSettings(html: string): unknown {
  const prefix = '<script>globalThis["__DSH_PAGE_REFRESH_CONFIG__"] = '
  const start = html.indexOf(prefix) + prefix.length
  const parsed: unknown = JSON.parse(html.slice(start, html.indexOf('</script>', start)))
  return parsed
}

describe('the settings global', () => {
  it('carries the schema\'s defaults for a row without config', async () => {
    const html = servedIndexOf(await loadComposition(null))
    expect(html).toContain(DEFAULT_MARKUP)
    expect(readPageRefreshSettings(servedSettings(html))).toEqual({
      checkOnVisible: true, reloadDelayMs: 0, disconnectNotice: true, stuckAfterSeconds: 60,
    })
  })

  it('carries a deployment\'s own values, which the browser half reads back unchanged', async () => {
    const html = servedIndexOf(await loadComposition([
      'checkOnVisible: false', 'reloadDelayMs: 1500', 'disconnectNotice: false', 'stuckAfterSeconds: 90',
    ]))
    expect(readPageRefreshSettings(servedSettings(html))).toEqual({
      checkOnVisible: false, reloadDelayMs: 1500, disconnectNotice: false, stuckAfterSeconds: 90,
    })
  })

  it('is rendered ahead of the shell\'s entry module', async () => {
    const html = servedIndexOf(await loadComposition(null))
    expect(html.indexOf(DEFAULT_MARKUP)).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('is released when the fiber disposes (HMR safety)', async () => {
    const ctx = await loadComposition(null)
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'page-refresh')
    await row?.fiber?.dispose()
    expect(servedIndexOf(ctx)).not.toContain('__DSH_PAGE_REFRESH_CONFIG__')
  })
})

describe('the build the served index carries', () => {
  it('reads as the plugin revisions and the shell script, resolved under the served base', async () => {
    const html = servedIndexOf(await loadComposition(null))
    const page = new FakePage()
    const served = await readServedBuild({
      fetchDocument: async () => ({ status: 200, contentType: 'text/html; charset=utf-8', text: async () => html }),
      moduleScriptsIn: (body, url) => page.moduleScriptsIn(body, url),
    }, SERVED_URL, new AbortController().signal)
    expect(served).toEqual({
      kind: 'known',
      identity: { entries: revisions({ a: '1', b: '2' }), shell: [`${SERVED_URL}assets/index-abc.js`] },
    })
  })
})

describe('configuration', () => {
  it('defaults every field', () => {
    expect(PageRefresh.Config({})).toEqual({
      checkOnVisible: true, reloadDelayMs: 0, disconnectNotice: true, stuckAfterSeconds: 60,
    })
  })

  it.each([
    [{ stuckAfterSeconds: 0 }, '$.stuckAfterSeconds'],
    [{ stuckAfterSeconds: 2_147_484 }, '$.stuckAfterSeconds'],
    [{ stuckAfterSeconds: 1.5 }, '$.stuckAfterSeconds'],
    [{ reloadDelayMs: -1 }, '$.reloadDelayMs'],
    [{ reloadDelayMs: 2_147_483_648 }, '$.reloadDelayMs'],
    [{ checkOnVisible: 'yes' as never }, '$.checkOnVisible'],
    [{ disconnectNotice: 1 as never }, '$.disconnectNotice'],
  ])('rejects %o', (config, path) => {
    expect(() => PageRefresh.Config(config)).toThrow(path)
  })

  it('leaves a rejected row listed but publishes no settings global', async () => {
    await expect(loadComposition(['stuckAfterSeconds: 0'])).rejects.toThrow('$.stuckAfterSeconds')
    const ctx = context
    if (ctx === undefined) throw new Error('the composition did not start')
    const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'page-refresh')
    expect(row?.fiber).toBeDefined()
    expect(row?.disabled).toBeFalsy()
    expect(servedIndexOf(ctx)).not.toContain('__DSH_PAGE_REFRESH_CONFIG__')
  })

  it('names itself and publishes the global the browser half reads', () => {
    expect(PageRefresh.name).toBe('page-refresh')
    expect(PageRefresh.PAGE_REFRESH_CONFIG_GLOBAL).toBe('__DSH_PAGE_REFRESH_CONFIG__')
  })

  it('looks for its own row in a served boot graph under its package name, the id the host lists a client bundle under', async () => {
    const manifest: unknown = JSON.parse(await readFile(join(import.meta.dirname, '../package.json'), 'utf8'))
    expect(manifest).toMatchObject({ name: PAGE_REFRESH_ENTRY_ID })
  })
})
