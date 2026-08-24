/**
 * Web e2e scenario: a self-hosted static application inside the content
 * column's page seat.
 *
 * The composition is the shipped Web surface plus the content-frame overlay,
 * which mounts the three experimental rows — the service-line shell replacing
 * ui-layout, the column's router claiming the seat that shell opens, and this
 * package contributing the `page` kind and the application behind it. What runs
 * is the real loader chain and the real webserver route, so the assertions
 * cover what only a real engine can answer: that the column says so while a
 * session has produced nothing, that the frame then fills its seat, and that
 * the hosted document loads with its own stylesheet applied — which is the
 * browser's verdict on the route's content-type table.
 *
 * The agent-driven side of the column — the tool, per-session pages, and the
 * frame cache — is content-show.e2e.ts; the column's own routing between kinds
 * is content-surface.e2e.ts.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
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
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
const OVERLAY = join(FRAME_DIR, 'overlay/content-column.patch.yml')
/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
] as const
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
const SEEDED_SESSION = 'content-frame-web-e2e-a'

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-frame-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

const column = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)
const pageSeat = (page: Page): Locator => page.locator('[data-content-surface-seat="page"]')
const contentFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')

/** One element's rendered box; the shell's tracks are what decides it. */
async function box(locator: Locator): Promise<{ left: number; right: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return { left: rect.x, right: rect.x + rect.width, width: rect.width, height: rect.height }
}

/**
 * Splice one `content/shown` event into a recorded session, before its closing turn.
 * @param fixtureText - the committed seed fixture.
 * @param shown - the page id the agent showed.
 * @returns the fixture text to seed.
 */
function withShownPage(fixtureText: string, shown: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
    JSON.stringify({ type: 'content/shown', data: { page: shown } }),
    ...lines.slice(closing),
  ].join('\n')
}

/** Open the sidebar's nth session row and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

describe.skipIf(MODE === 'record')('web e2e: hosted application in the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    await seedSession(scaffold, withShownPage(await readFile(FIXTURE, 'utf8'), 'home'), SEEDED_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await column(page, 'content').waitFor({ timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    // No session is opened here: the column's empty state is the first spec.
    await page.locator('[role="treeitem"]').first().click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('says the column is empty before any session is open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-empty'))
    // The column lists what a session produced; the deployment's `defaultPage`
    // is a value of the `content` projection, not something a session produced.
    await page.locator('[data-content-surface-empty]').waitFor({ timeout: 15_000 })
    expect(await contentFrame(page).count()).toBe(0)
  }, 90_000)

  it('fills the page seat with the frame once a session shows one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-geometry'))
    await openSession(page, 1)
    await contentFrame(page).waitFor({ timeout: 15_000 })
    const [frame, seat, content] = await Promise.all([box(contentFrame(page)), box(pageSeat(page)), box(column(page, 'content'))])
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.left).toBeGreaterThanOrEqual(content.left - 1)
    expect(frame.right).toBeLessThanOrEqual(content.right + 1)
    // Resident, not a strip: the frame takes its seat's whole height, which is
    // the column minus the switcher above it.
    expect(frame.height).toBeGreaterThan(seat.height - 2)
  }, 90_000)

  it('loads the hosted document and applies its own stylesheet', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-document'))
    const inner = page.frameLocator('iframe[data-content-frame][data-content-active]')
    const heading = inner.locator('#fixture-heading')
    await heading.waitFor({ timeout: 15_000 })
    expect(await heading.textContent()).toBe('Hosted content app')
    // The sheet applies only when the route answered `text/css`, so the
    // computed color is the browser's own verdict on the route's MIME table.
    expect(await heading.evaluate(node => getComputedStyle(node).color)).toBe('rgb(0, 128, 0)')
    // Evidence for the composition, not a failure artifact.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-frame.png') })
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
