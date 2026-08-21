/**
 * Web e2e scenario: a Vue 3 component hosted in a React slot.
 *
 * The composition is the shipped Web surface plus the experimental probe's
 * overlay, so what runs is the real loader chain — the modules node half scans
 * the row's `dsh.client` declaration, the browser fetches one more plugin
 * bundle, and the header renders its entry. The assertions cover what only a
 * real engine can answer for a foreign framework: that the Vue tree paints, that
 * its own reactivity answers a click, that its CSS Modules follow the theme
 * cascade, and that a session switch remounts it without leaking an error.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * link the loader resolves the row through is created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const OVERLAY = join(REPO_ROOT, 'packages/experimental/vue-ui-poc/tests/vue-ui-poc.overlay.yml')
const PROBE_PACKAGE = '@deepseek-ai/dsh-experimental-vue-ui-poc'
const PROBE_DIR = join(REPO_ROOT, 'packages/experimental/vue-ui-poc')
const FIRST_SESSION = 'vue-ui-poc-web-e2e-a'
const SECOND_SESSION = 'vue-ui-poc-web-e2e-b'

/** English copy of the probe's dictionary; the page advertises en-US. */
const TITLE = 'Vue component mounted'
const BUTTON = 'Vue count button'

/**
 * Prepare a harness home whose profile fallback resolves the experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithProbeLink(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vue-poc-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(PROBE_DIR, join(scope, PROBE_PACKAGE.slice('@deepseek-ai/'.length)), 'dir')
  return home
}

/** The probe's counter button, as the header renders it. */
const counter = (page: Page) => page.getByRole('button', { name: BUTTON })

/** Open the sidebar's nth session row and wait for the probe to mount. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await counter(page).waitFor({ timeout: 15_000 })
}

describe.skipIf(MODE === 'record')('web e2e: Vue component in a React slot', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithProbeLink()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    const fixture = await readFile(FIXTURE, 'utf8')
    await seedSession(scaffold, fixture, FIRST_SESSION)
    await seedSession(scaffold, fixture, SECOND_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('renders the Vue tree inside the session header', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue-ui-poc-render'))
    await openSession(page, 1)
    expect(await page.getByText(TITLE, { exact: true }).count()).toBe(1)
    expect((await counter(page).textContent())?.trim()).toBe('Count 0')
    expect(await page.getByText('React echo 0', { exact: true }).count()).toBe(1)
  }, 90_000)

  it('answers clicks from Vue reactivity and echoes them back through React', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue-ui-poc-count'))
    await counter(page).click()
    await expect.poll(() => counter(page).textContent()).toContain('Count 1')
    await page.getByText('React echo 1', { exact: true }).waitFor({ timeout: 10_000 })

    // The second click proves the React re-render patched the live Vue tree
    // rather than remounting it: a remount would restart the count at 1.
    await counter(page).click()
    await expect.poll(() => counter(page).textContent()).toContain('Count 2')
    await page.getByText('React echo 2', { exact: true }).waitFor({ timeout: 10_000 })
  }, 90_000)

  it('repaints the Vue tree from the theme cascade', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue-ui-poc-theme'))
    const sample = async (): Promise<{ background: string; color: string }> =>
      await page.evaluate((name: string) => {
        const button = document.querySelector(`button[aria-label="${name}"]`) as HTMLElement
        const style = getComputedStyle(button)
        return { background: style.backgroundColor, color: style.color }
      }, BUTTON)

    const light = await sample()
    await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
    const dark = await sample()
    // Both faces of the component's own tokens flip: the CSS Modules sheet the
    // plugin bundle injected participates in the same cascade React uses.
    expect(dark.background).not.toBe(light.background)
    expect(dark.color).not.toBe(light.color)

    await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
    expect(await sample()).toEqual(light)
  }, 90_000)

  it('remounts cleanly across a session switch', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue-ui-poc-remount'))
    await openSession(page, 2)
    // A fresh Vue instance: the session area is keyed by session id, so the
    // previous tree was unmounted through the bridge's render(null, host).
    await expect.poll(() => counter(page).textContent()).toContain('Count 0')
    await counter(page).click()
    await expect.poll(() => counter(page).textContent()).toContain('Count 1')

    await openSession(page, 1)
    await expect.poll(() => counter(page).textContent()).toContain('Count 0')
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
