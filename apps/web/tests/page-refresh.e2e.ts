/**
 * Web e2e scenario: `@deepseek-ai/dsh-experimental-page-refresh` over the
 * shipped Web surface with live client plugin replacement off, the two rows the
 * customer console composes. A real browser holds the page while the test
 * drops its Gateway WebSocket, which the page re-establishes on its own: while
 * the server still serves the build the page booted with, the reconnect's
 * build check changes nothing; once the server serves another build — one more
 * client plugin composed live, which the open page never loads — the next
 * reconnect reloads the page exactly once, and the reloaded page, now on the
 * served build, does not navigate again on the reconnect after that. A module
 * script that something other than the shell adds to the page — a browser
 * extension injecting its own code — is part of neither build and reloads
 * nothing.
 *
 * Zero model calls: no session is opened.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * link the loader resolves the row through is created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Page, type Response, type WebSocketRoute } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./page-refresh.overlay.yml', import.meta.url))
const PACKAGE_NAME = '@deepseek-ai/dsh-experimental-page-refresh'
const PACKAGE_DIR = join(REPO_ROOT, 'packages/experimental/page-refresh')
/** A client plugin installed in the profile and composed only when the scenario creates its row. */
const FIXTURE = fileURLToPath(new URL('./fixtures/plugins/fixture-live-client', import.meta.url))
const FIXTURE_NAME = '@fixture/live-client'
/** Text the shipped home view draws once the application has mounted. */
const MOUNTED_TEXT = 'Into the Unknown'
/** A module script from outside the served shell, as a browser extension adds one to the page. */
const FOREIGN_SCRIPT = 'https://extension.invalid/main-world-inject.js'

/**
 * A harness home whose profile fallback resolves this package by name.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithPackageLink(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-page-refresh-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(PACKAGE_DIR, join(scope, PACKAGE_NAME.slice('@deepseek-ai/'.length)), 'dir')
  return home
}

/**
 * Wait for the page's next build check: its request for the document it was
 * served from.
 * @param page - the browser page.
 * @returns the answer the check received.
 */
function nextBuildCheck(page: Page): Promise<Response> {
  return page.waitForResponse(response => response.request().resourceType() === 'fetch'
    && new URL(response.url()).pathname === '/', { timeout: 20_000 })
}

it('reloads an open page exactly once after its server starts serving another build', async () => {
  const harnessHome = await harnessHomeWithPackageLink()
  // Registered first, so it runs after the scaffold has closed.
  onTestFinished(() => rm(harnessHome, { recursive: true, force: true }))
  const scaffold = await launchWebScaffold({
    harnessHome,
    extraOverlayPath: OVERLAY,
    extraInstallAnchors: [join(FIXTURE, 'package.json')],
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const console = watchConsole(page)
  onTestFailed(() => saveFailureShot(page, 'web-e2e-page-refresh'))
  await page.route(FOREIGN_SCRIPT, route => route.fulfill({ contentType: 'text/javascript', body: '' }))
  // Added once the document is parsed and before the shell's own module
  // script runs, the moment an extension injects into the page's main world.
  await page.addInitScript((src) => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState !== 'interactive') return
      const script = document.createElement('script')
      script.type = 'module'
      script.src = src
      document.head.append(script)
    })
  }, FOREIGN_SCRIPT)
  const sockets: { client: WebSocketRoute; server: WebSocketRoute }[] = []
  await page.routeWebSocket('**/api/remote.mux', (client) => {
    const server = client.connectToServer()
    sockets.push({ client, server })
    client.onMessage((message) => { server.send(message) })
    server.onMessage((message) => { client.send(message) })
  })
  /** Drop the live Gateway WebSocket; the page reconnects by itself. */
  const dropConnection = async (): Promise<void> => {
    const active = sockets.at(-1)!
    await Promise.all([
      active.client.close({ code: 1012, reason: 'test connection loss' }),
      active.server.close({ code: 1012, reason: 'test connection loss' }),
    ])
  }
  /** The index the server serves now, boot graph included. */
  const servedEntries = async (): Promise<string> => await (await scaffold.hostFetch('/')).text()

  // The first connection checks too, and finds the build the page booted with.
  const firstCheck = nextBuildCheck(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.getByText(MOUNTED_TEXT, { exact: true }).waitFor({ timeout: 20_000 })
  expect((await firstCheck).status()).toBe(200)
  let navigations = 0
  page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) navigations++ })

  const sameBuildCheck = nextBuildCheck(page)
  await dropConnection()
  expect((await sameBuildCheck).status()).toBe(200)
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 200) }))
  expect(navigations).toBe(0)
  // The foreign script is on the page, and neither check counted it: the page
  // is still the one it navigated to, with no reload offered.
  expect(await page.locator(`script[type="module"][src="${FOREIGN_SCRIPT}"]`).count()).toBe(1)
  expect(await page.evaluate(() => (performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming).type))
    .toBe('navigate')
  expect(await page.locator('[data-page-refresh-notice="update"]').count()).toBe(0)

  expect(await servedEntries()).not.toContain(FIXTURE_NAME)
  await scaffold.ctx.loader.create({ name: FIXTURE_NAME })
  await expect.poll(servedEntries, { timeout: 20_000 }).toContain(FIXTURE_NAME)
  // The open page never loads the new plugin: nothing replaces client plugins live.
  expect(await page.evaluate(() => document.documentElement.dataset.liveMounts)).toBeUndefined()

  await dropConnection()
  await expect.poll(() => navigations, { timeout: 20_000 }).toBe(1)
  await page.getByText(MOUNTED_TEXT, { exact: true }).waitFor({ timeout: 20_000 })
  // The reloaded page booted with the served build, plugin included.
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.liveMounts)).toBe('1')
  // Its own first check found that build and cleared the reload record.
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('dsh-page-refresh:reloaded-for'))).toBeNull()

  const reloadedCheck = nextBuildCheck(page)
  await dropConnection()
  expect((await reloadedCheck).status()).toBe(200)
  await page.evaluate(() => new Promise<void>((resolve) => { setTimeout(resolve, 200) }))
  expect(navigations).toBe(1)
  expect(await page.locator('[data-page-refresh-notice="update"]').count()).toBe(0)
  expect(console.pageErrors).toEqual([])
})
