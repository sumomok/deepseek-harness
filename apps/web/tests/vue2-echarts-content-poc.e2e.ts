/**
 * Web e2e scenario: a Vue 2.7 ECharts component in the service-line shell's
 * content column, split across a component row and a placement row.
 *
 * The composition is the shipped Web surface plus the placement package's
 * overlay, so what runs is the real loader chain — the shell replaces
 * ui-layout, the modules node half orders the component row ahead of the
 * placement row that requests it through `dsh.client.external`, the browser
 * fetches both bundles, and the placement claims the column. The assertions
 * cover what only a real engine can answer for a foreign framework on a canvas:
 * that ECharts painted a sized canvas inside the column, that a bar click
 * reaches Vue's own reactivity and React's state at once, and that a React data
 * change patches the live chart instead of rebuilding it.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves both rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const PLACEMENT_DIR = join(REPO_ROOT, 'packages/experimental/vue2-echarts-content-poc')
const OVERLAY = join(PLACEMENT_DIR, 'overlay/vue2-echarts-content.patch.yml')
/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-content-poc', PLACEMENT_DIR],
] as const
const SESSION = 'vue2-echarts-content-web-e2e'

/** English copy of the panel's dictionary; the page advertises en-US. */
const TITLE = 'ECharts bar chart (Vue 2.7 component)'
const RANDOMIZE = 'Randomize'
const UNSELECTED = 'No bar selected'
/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** Attribute the spec stamps on the live canvas to recognize it again. */
const PROBE_ATTRIBUTE = 'data-dsh-probe'
/** The seeded data set's tallest bar, which fills the plot area top to bottom. */
const TALLEST_BAND = 1
/** Bands the seeded data set plots. */
const BANDS = 7
/** Plot inset the chart option declares (echarts-chart.ts `grid`). */
const GRID = { left: 48, right: 16, top: 16, bottom: 32 }

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vue2-echarts-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

const column = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)
const canvas = (page: Page): Locator => column(page, 'content').locator('canvas').first()
const counter = (page: Page): Locator => column(page, 'content').locator('[data-vue-clicks]')

/** One element's rendered box. */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return rect
}

describe.skipIf(MODE === 'record')('web e2e: a Vue 2.7 ECharts panel in the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await column(page, 'content').waitFor({ timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    const row = page.locator('[role="treeitem"]').nth(1)
    await row.waitFor({ timeout: 15_000 })
    await row.click()
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
    await canvas(page).waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('paints a sized ECharts canvas inside the content column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue2-echarts-render'))
    const [painted, content] = await Promise.all([box(canvas(page)), box(column(page, 'content'))])
    expect(painted.width).toBeGreaterThan(0)
    expect(painted.height).toBeGreaterThan(0)
    // Inside the column the placement claimed, not beside it.
    expect(painted.x).toBeGreaterThanOrEqual(content.x - 1)
    expect(painted.x + painted.width).toBeLessThanOrEqual(content.x + content.width + 1)

    expect(await column(page, 'content').getByText(TITLE, { exact: true }).count()).toBe(1)
    expect(await column(page, 'content').getByText(UNSELECTED, { exact: true }).count()).toBe(1)
    expect(await counter(page).textContent()).toBe('0')

    // Evidence for the composition, not a failure artifact.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-vue2-echarts-content.png'), fullPage: true })
  }, 90_000)

  it('answers a bar click from Vue reactivity and echoes it back through React', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue2-echarts-click'))
    const plot = await box(canvas(page))
    const band = (plot.width - GRID.left - GRID.right) / BANDS
    await page.mouse.click(
      plot.x + GRID.left + band * (TALLEST_BAND + 0.5),
      plot.y + plot.height - GRID.bottom - 8,
    )
    // The Vue-owned counter moved, and React's state came back down as copy.
    await expect.poll(async () => await counter(page).textContent(), { timeout: 10_000 }).toBe('1')
    await column(page, 'content').getByText('Selected Tue: 200', { exact: true })
      .waitFor({ timeout: 10_000 })
  }, 90_000)

  it('patches the live chart when React replaces the data', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-vue2-echarts-randomize'))
    await page.evaluate((attribute: string) => {
      document.querySelector('[data-shell-column="content"] canvas')?.setAttribute(attribute, 'kept')
    }, PROBE_ATTRIBUTE)

    await page.getByRole('button', { name: RANDOMIZE }).click()
    // Same canvas element, and the Vue counter still holds the click above it:
    // a rebuilt chart would arrive with a fresh canvas and a counter back at 0.
    await expect.poll(async () => await canvas(page).getAttribute(PROBE_ATTRIBUTE), { timeout: 10_000 })
      .toBe('kept')
    expect(await counter(page).textContent()).toBe('1')
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
