/**
 * REAL-composition coverage for this package's two routes: a test-only
 * cordis.yml booted through the vendored Loader mounts the webserver and
 * content-frame rows, and every assertion observes the served HTTP surface —
 * entry document, content types, directory resolution, the loud 404 that must
 * not reach the webserver fallback, traversal and symlink-escape rejection,
 * method gating, the browser settings document, and route release on fiber
 * disposal (HMR safety).
 *
 * The config-validation cases call `apply` directly: a rejected configuration
 * never reaches a served surface, so there is nothing for HTTP to observe.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test — the node half of a dual-face client package is
 * spelled this way (dsh-client-modules, dsh-client-hmr).
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import * as ContentFrame from '../src/index.ts'
import type { ContentPage } from '../src/types.ts'

/**
 * A fresh session from the host store. Reached through `ctx.get` and cast:
 * this package compiles in the Client aggregate, where the cordis
 * `Context.sessions` merge names the browser service rather than the host store.
 * @param ctx - the booted composition.
 * @returns a new session.
 */
function newSession(ctx: Context): Session {
  return (ctx.get('sessions') as unknown as SessionStore).create()
}

/** Body the test-owned webserver fallback answers with, to prove the route never delegates a miss. */
const FALLBACK_BODY = 'DSH-SPA-SHELL'

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

/** Write the application fixture and a two-row cordis.yml, then boot it through the real Loader. */
async function loadComposition(withDefaultPage = true, withHomePage = false): Promise<Context> {
  world = await mkdtemp(join(tmpdir(), 'dsh-content-frame-'))
  const root = join(world, 'app')
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'section'), { recursive: true })
  await mkdir(join(root, 'empty'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<body>APP ENTRY</body>')
  await writeFile(join(root, 'a file.txt'), 'SPACED')
  await writeFile(join(root, 'section', 'index.html'), '<body>SECTION ENTRY</body>')
  await writeFile(join(root, 'assets', 'app.css'), '#x{color:red}')
  await writeFile(join(root, 'assets', 'app.js'), 'export {}')
  await writeFile(join(root, 'assets', 'logo.png'), 'PNG')
  await writeFile(join(root, 'assets', 'ui.woff2'), 'WOFF2')
  await writeFile(join(root, 'assets', 'favicon.ico'), 'ICO')
  await writeFile(join(root, 'assets', 'blob.bin'), 'BLOB')
  // Outside the served root, reachable only through the symlink planted below.
  await writeFile(join(world, 'secret.txt'), 'SECRET')

  const configPath = join(world, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    // Every optional seam, so this composition also activates the tool, the
    // command, the projection, and the content-column children rather than
    // only the route.
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-commands'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-experimental-content-surface'",
    '- id: content',
    "  name: '@deepseek-ai/dsh-experimental-content-frame'",
    '  config:',
    `    root: '${root}'`,
    '    cacheSize: 4',
    ...withDefaultPage ? ['    defaultPage: home'] : [],
    ...withHomePage ? ['    homePage: home'] : [],
    '    pages:',
    '      - id: home',
    '        title: Home',
    '        description: The entry page.',
    '        url: /content-app/',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(world).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', HttpServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-commands', CommandRuntime],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-experimental-content-surface', ContentSurfaceRegistry],
    ['@deepseek-ai/dsh-experimental-content-frame', ContentFrame],
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

/** GET (by default) one path against the running server. */
async function request(port: number, path: string, init?: RequestInit): Promise<Answer> {
  const response = await fetch(`http://127.0.0.1:${String(port)}${path}`, init)
  return {
    status: response.status,
    type: response.headers.get('content-type'),
    allow: response.headers.get('allow'),
    cacheControl: response.headers.get('cache-control'),
    // Wide enough for the settings document's page catalog, which is now the
    // longest body this suite reads in full.
    body: (await response.text()).slice(0, 200),
  }
}

describe('hosted application route', () => {
  it('serves the configured root and refuses everything outside it', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    // The optional seams the row reaches for are all live in this composition,
    // so the tool, the command, the projection, and the page extractor are
    // part of what booted.
    expect(loaded.tools.schemas().map(schema => schema.name)).toContain('content_show')
    const commandSession = newSession(loaded)
    const commandAgent = { id: commandSession.id, session: commandSession } as unknown as Parameters<typeof loaded.commands.execute>[0]
    expect(loaded.commands.list(commandAgent)).toContainEqual({
      name: 'show-content-page',
      description: 'Show one of this deployment\'s content-column pages. Used by the sidebar\'s page-navigation menu; not meant to be typed by hand.',
      input: { hint: 'page id' },
    })
    const execution = await loaded.commands.execute(commandAgent, '/show-content-page home', [], new AbortController().signal)
    expect(execution?.result).toEqual({ kind: 'success', text: 'Now showing Home in the content column.' })
    expect(commandSession.events.filter(event => event.type === 'content/shown').map(event => event.data))
      .toEqual([{ page: 'home', by: 'user' }])
    const session = newSession(loaded)
    expect(loaded.sessionProjections.snapshot(session).values.content)
      .toEqual({ state: 'default', url: '/content-app/', title: 'Home' })
    session.append('content/shown', { page: 'home' })
    expect(loaded.sessionProjections.snapshot(session).values.contentSurface)
      .toEqual({ entries: [{ kind: 'page', entryId: 'home', seq: session.seq - 1, title: 'Home', payload: { state: 'shown', page: 'home', url: '/content-app/', title: 'Home', by: 'agent' } }] })
    const server = loaded.webServer
    const port = server.port
    // The dsh SPA seat, as a live deployment has it: a miss inside the hosted
    // application must never be answered by this.
    const releaseFallback = server.registerFallback((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(FALLBACK_BODY)
    })

    // The bare prefix, the trailing slash, and the entry path all render index.html.
    for (const path of ['/content-app', '/content-app/', '/content-app/index.html']) {
      expect(await request(port, path)).toMatchObject({
        status: 200,
        type: 'text/html; charset=utf-8',
        cacheControl: 'no-cache',
        body: '<body>APP ENTRY</body>',
      })
    }
    // A directory below the root resolves to its own entry document.
    expect(await request(port, '/content-app/section')).toMatchObject({ status: 200, body: '<body>SECTION ENTRY</body>' })

    // The content types a real static build needs; the SPA seat's own table
    // stops at seven kinds and would ship the last four as octet-stream.
    const served: [string, string, string][] = [
      ['/content-app/assets/app.css', 'text/css; charset=utf-8', '#x{color:red}'],
      ['/content-app/assets/app.js', 'text/javascript; charset=utf-8', 'export {}'],
      ['/content-app/assets/logo.png', 'image/png', 'PNG'],
      ['/content-app/assets/ui.woff2', 'font/woff2', 'WOFF2'],
      ['/content-app/assets/favicon.ico', 'image/x-icon', 'ICO'],
      ['/content-app/assets/blob.bin', 'application/octet-stream', 'BLOB'],
    ]
    for (const [path, type, body] of served) {
      expect(await request(port, path)).toMatchObject({ status: 200, type, body })
    }
    // A percent-escaped name reaches the file it spells.
    expect(await request(port, '/content-app/a%20file.txt')).toMatchObject({
      status: 200,
      type: 'text/plain; charset=utf-8',
      body: 'SPACED',
    })

    // HEAD answers the same headers with no body.
    const head = await request(port, '/content-app/assets/app.css', { method: 'HEAD' })
    expect(head).toMatchObject({ status: 200, type: 'text/css; charset=utf-8', body: '' })

    // Loud 404: a miss and a directory with no entry document both stop here
    // rather than reaching the fallback, which is live and answering elsewhere.
    for (const path of ['/content-app/no/such/asset.js', '/content-app/empty']) {
      expect(await request(port, path)).toMatchObject({ status: 404, body: '' })
    }
    expect(await request(port, '/elsewhere')).toMatchObject({ status: 200, body: FALLBACK_BODY })

    // Traversal outside the root is 403; non-GET/HEAD names the methods it has.
    expect(await request(port, '/content-app/..%2f..%2fsecret.txt')).toMatchObject({ status: 403 })
    expect(await request(port, '/content-app/', { method: 'POST' })).toMatchObject({ status: 405, allow: 'GET, HEAD' })

    // The browser half's own configuration, served because the boot manifest
    // carries no `config` block to the browser. Uncached: the row it describes
    // can be replaced under a running page.
    expect(await request(port, '/content-frame/settings')).toMatchObject({
      status: 200,
      type: 'application/json',
      cacheControl: 'no-store',
      body: '{"cacheSize":4,"pages":[{"id":"home","title":"Home","description":"The entry page.","url":"/content-app/"}]}',
    })
    expect(await request(port, '/content-frame/settings', { method: 'POST' }))
      .toMatchObject({ status: 405, allow: 'GET, HEAD' })

    // HMR safety: disposing the row releases both routes, and the fallback —
    // not this package — answers the prefix again.
    const entry = [...loaded.loader.entries()].find(candidate => candidate.options.id === 'content')
    expect(entry).toBeDefined()
    await entry!.fiber?.dispose()
    expect(await request(port, '/content-app/')).toMatchObject({ status: 200, body: FALLBACK_BODY })
    expect(await request(port, '/content-frame/settings')).toMatchObject({ status: 200, body: FALLBACK_BODY })
    releaseFallback()
  })

  it('omits the default page from both faces when the deployment configures none', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(false)
    expect(await request(loaded.webServer.port, '/content-frame/settings'))
      .toMatchObject({ status: 200, body: '{"cacheSize":4,"pages":[{"id":"home","title":"Home","description":"The entry page.","url":"/content-app/"}]}' })
    expect(loaded.sessionProjections.snapshot(newSession(loaded)).values.content)
      .toEqual({ state: 'empty' })
  })

  it('serves homePage in the settings document when configured', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition(false, true)
    expect(await request(loaded.webServer.port, '/content-frame/settings')).toMatchObject({
      status: 200,
      body: '{"cacheSize":4,"pages":[{"id":"home","title":"Home","description":"The entry page.","url":"/content-app/"}],"homePage":"home"}',
    })
  })

  // fs.symlink needs elevation or developer mode on Windows; the Linux
  // coverage lane owns this branch.
  it.skipIf(process.platform === 'win32')('refuses a symlink that leaves the root', { timeout: 60_000 }, async () => {
    const loaded = await loadComposition()
    await symlink(join(world!, 'secret.txt'), join(world!, 'app', 'escape.txt'))
    expect(await request(loaded.webServer.port, '/content-app/escape.txt')).toMatchObject({ status: 403 })
  })
})

/** The smallest valid page list, so a root case is only about the root. */
const HOME: ContentPage = { id: 'home', title: 'Home', description: 'The entry page.', url: '/content-app/' }

describe('configuration validation', () => {
  it('rejects a relative, missing, or non-directory root at load', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-content-frame-config-'))
    const file = join(world, 'index.html')
    await writeFile(file, '<body></body>')
    const ctx = new Context()
    const pages = [HOME]

    await expect(ContentFrame.apply(ctx, { root: 'app/dist', pages })).rejects.toThrow(/must be an absolute path/)
    await expect(ContentFrame.apply(ctx, { root: join(world, 'nowhere'), pages }))
      .rejects.toThrow(/is not an existing directory/)
    await expect(ContentFrame.apply(ctx, { root: file, pages })).rejects.toThrow(/is not an existing directory/)
  })

  it('rejects a broken page list before it ever reaches the root check', async () => {
    world = await mkdtemp(join(tmpdir(), 'dsh-content-frame-pages-'))
    const ctx = new Context()
    // Deliberately paired with a root that would also fail: the page list is
    // checked first, so these messages prove the ordering as well as the rule.
    const apply = (pages: ContentPage[], extra?: { defaultPage?: string; homePage?: string; cacheSize?: number }): Promise<void> =>
      ContentFrame.apply(ctx, { root: 'relative/never-reached', pages, ...extra })

    await expect(apply([])).rejects.toThrow(/pages must list at least one page/)
    await expect(apply([{ ...HOME, id: '' }])).rejects.toThrow(/every page needs a non-empty id/)
    await expect(apply([{ ...HOME, id: 'none' }])).rejects.toThrow(/"none" is reserved for clearing the column/)
    await expect(apply([HOME, { ...HOME, title: 'Other' }])).rejects.toThrow(/duplicate page id "home"/)
    await expect(apply([{ ...HOME, url: 'https://example.test/app' }]))
      .rejects.toThrow(/page "home" url must be a same-origin path/)
    await expect(apply([{ ...HOME, url: '//example.test/app' }]))
      .rejects.toThrow(/page "home" url must be a same-origin path/)
    await expect(apply([HOME], { defaultPage: 'reports' }))
      .rejects.toThrow(/defaultPage "reports" names no configured page/)
    await expect(apply([HOME], { homePage: 'reports' }))
      .rejects.toThrow(/homePage "reports" names no configured page/)
    await expect(apply([HOME], { cacheSize: 0 })).rejects.toThrow(/cacheSize must be at least 1, received 0/)
  })

  it('defaults the frame cache bound rather than leaving it unset', () => {
    expect(ContentFrame.Config({ root: '/app', pages: [HOME] }).cacheSize).toBe(3)
  })
})
