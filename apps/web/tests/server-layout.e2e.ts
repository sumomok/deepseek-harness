/**
 * Web e2e scenario: the service-line shell replacing the shipped one.
 *
 * The composition is the shipped Web surface plus the experimental overlay's
 * disable+insert pair, so what runs is the real loader chain — the ui-layout
 * row never reaches the browser boot manifest, the browser fetches this shell's
 * bundle instead, and every shipped registrant lands in it unchanged. The
 * assertions cover what only a real engine can answer: the ratio a real layout
 * pass produces, which column each shipped surface ended up in, and that
 * replacing the shell left no console damage behind.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * link the loader resolves the row through is created here rather than by
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
const SHELL_PACKAGE = '@deepseek-ai/dsh-experimental-server-layout'
const SHELL_DIR = join(REPO_ROOT, 'packages/experimental/server-layout')
const OVERLAY = join(SHELL_DIR, 'overlay/three-column.patch.yml')
const SESSION = 'server-layout-web-e2e'

/** The shell's contract-frozen geometry, restated: this spec lives in the Host aggregate. */
const SESSION_RAIL = 56
/** Ratio units the three resident columns are defined by. */
const RATIO = { session: 3, content: 16, chat: 5 }
/** Layout tolerance: a real layout pass rounds, and the grid carries 1px borders. */
const TOLERANCE = 0.02

/** English copy of this shell's dictionary; the page advertises en-US. */
const PLACEHOLDER_TITLE = 'Content column is empty'
/** The composer's own English placeholder — the chat column's landmark. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/**
 * Prepare a harness home whose profile fallback resolves the experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithShellLink(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-server-layout-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(SHELL_DIR, join(scope, SHELL_PACKAGE.slice('@deepseek-ai/'.length)), 'dir')
  return home
}

const column = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)

/** One element's rendered box; the shell's tracks are what decides it. */
async function box(locator: Locator): Promise<{ left: number; right: number; width: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return { left: rect.x, right: rect.x + rect.width, width: rect.width }
}

/** Assert one element sits horizontally inside a column's track. */
async function expectInsideColumn(target: Locator, name: string, page: Page): Promise<void> {
  const [inner, outer] = [await box(target), await box(column(page, name))]
  expect(inner.left).toBeGreaterThanOrEqual(outer.left - 1)
  expect(inner.right).toBeLessThanOrEqual(outer.right + 1)
}

describe.skipIf(MODE === 'record')('web e2e: service-line three-column shell', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithShellLink()
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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('splits the frame on the 3:16:5 ratio with all three columns visible', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-ratio'))
    const [session, content, chat] = await Promise.all([
      box(column(page, 'session')), box(column(page, 'content')), box(column(page, 'chat')),
    ])
    for (const width of [session.width, content.width, chat.width]) expect(width).toBeGreaterThan(0)

    // One ratio unit, measured; each column's share of it must land on its
    // declared unit count within the layout tolerance.
    const unit = (session.width + content.width + chat.width) / (RATIO.session + RATIO.content + RATIO.chat)
    const drift = { session: session.width, content: content.width, chat: chat.width }
    for (const name of ['session', 'content', 'chat'] as const) {
      drift[name] = Math.abs(drift[name] / unit / RATIO[name] - 1)
    }
    expect(drift.session).toBeLessThan(TOLERANCE)
    expect(drift.content).toBeLessThan(TOLERANCE)
    expect(drift.chat).toBeLessThan(TOLERANCE)

    // Resident and adjacent: the columns tile the frame left to right.
    expect(content.left).toBeCloseTo(session.right, 0)
    expect(chat.left).toBeCloseTo(content.right, 0)

    // Evidence for the composition, not a failure artifact.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-server-layout.png') })
  }, 90_000)

  it('folds the session column to its rail and restores the ratio on expand', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-fold'))
    const expanded = (await box(column(page, 'session'))).width

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect.poll(async () => (await box(column(page, 'session'))).width, { timeout: 10_000 })
      .toBeCloseTo(SESSION_RAIL, 0)
    // The fold hands its ratio units to the two columns behind it.
    expect((await box(column(page, 'content'))).width).toBeGreaterThan(expanded)

    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await expect.poll(async () => (await box(column(page, 'session'))).width, { timeout: 10_000 })
      .toBeCloseTo(expanded, 0)
  }, 90_000)

  it('keeps the session list in the left column and the composer in the right one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-occupants'))
    await expectInsideColumn(page.locator('[role="treeitem"]').first(), 'session', page)
    await expectInsideColumn(page.getByPlaceholder(COMPOSER_PLACEHOLDER), 'chat', page)
  }, 90_000)

  it('shows its own empty state in the unclaimed content column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-placeholder'))
    const placeholder = page.getByText(PLACEHOLDER_TITLE, { exact: true })
    await expect.poll(async () => await placeholder.count()).toBe(1)
    await expectInsideColumn(placeholder, 'content', page)
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
