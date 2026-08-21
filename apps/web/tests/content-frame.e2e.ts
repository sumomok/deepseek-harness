/**
 * Web e2e scenario: a self-hosted static application in the shell's content
 * column.
 *
 * The composition is the shipped Web surface plus the content-frame overlay,
 * which mounts both experimental rows — the service-line shell replacing
 * ui-layout, and this package claiming the column the shell opens. What runs
 * is the real loader chain and the real webserver route, so the assertions
 * cover what only a real engine can answer: that the frame lands inside the
 * content track, that the hosted document loads and its own stylesheet applies
 * (the route's content types are what decides that), and that the shell's
 * default page survives the first session opening — the column is `root`
 * scoped, so no session transition may remount what it holds.
 *
 * The agent-driven side of the column — the tool, the projection, and the
 * per-session frame cache — is content-show.e2e.ts.
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
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
const OVERLAY = join(FRAME_DIR, 'overlay/content-column.patch.yml')
/** Both experimental rows the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
] as const
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
const FIRST_SESSION = 'content-frame-web-e2e-a'
const SECOND_SESSION = 'content-frame-web-e2e-b'

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/**
 * Prepare a harness home whose profile fallback resolves both experimental rows.
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
const contentFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')

/** One element's rendered box; the shell's tracks are what decides it. */
async function box(locator: Locator): Promise<{ left: number; right: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return { left: rect.x, right: rect.x + rect.width, width: rect.width, height: rect.height }
}

/** Open the sidebar's nth session row and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

/** Attribute the probe stamps on the shown iframe element. */
const PROBE_ATTRIBUTE = 'data-dsh-probe'

/** Marks a frame carries while a spec drives navigation around it. */
interface FrameProbe {
  /** Stamped on the iframe element: null again once React mounted a new one. */
  element: string | null
  /** Stamped inside the hosted document: absent again once the frame loaded a new one. */
  document: string | undefined
  /** How many times the hosted document executed; a fresh frame starts at 1. */
  loads: number | undefined
}

/** A frame that survived every transition since it was stamped. */
const KEPT: FrameProbe = { element: 'kept', document: 'kept', loads: 1 }

/** The hosted document's global, as this spec reads it: the fixture's load counter and the probe's own mark. */
interface HostedWindow {
  __dshProbe?: string
  __contentAppLoads?: number
}

/**
 * Stamp or read one frame's element and its document.
 * @param page - the browsing page.
 * @param stamp - mark to write, or undefined to read only.
 * @param selector - which frame; the shown one by default.
 * @returns the marks, or undefined while no such frame has a live document.
 */
async function probeFrame(
  page: Page,
  stamp: string | undefined,
  selector = 'iframe[data-content-frame][data-content-active]',
): Promise<FrameProbe | undefined> {
  return await page.evaluate(([mark, attribute, query]: [string | undefined, string, string]) => {
    const element = document.querySelector<HTMLIFrameElement>(query)
    const inner = element?.contentWindow as unknown as HostedWindow | null | undefined
    if (element === null || inner === null || inner === undefined) return undefined
    if (mark !== undefined) {
      element.setAttribute(attribute, mark)
      inner.__dshProbe = mark
    }
    return {
      element: element.getAttribute(attribute),
      document: inner.__dshProbe,
      loads: inner.__contentAppLoads,
    }
  }, [stamp, PROBE_ATTRIBUTE, selector] as [string | undefined, string, string])
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
    await column(page, 'content').waitFor({ timeout: 30_000 })
    await contentFrame(page).waitFor({ timeout: 15_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    // No session is opened here: with none current the column shows the
    // overlay's `defaultPage`, which is the frame the specs below start from.
    await page.locator('[role="treeitem"]').first().click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('fills the content column with the frame', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-geometry'))
    const [frame, content] = await Promise.all([box(contentFrame(page)), box(column(page, 'content'))])
    expect(frame.width).toBeGreaterThan(0)
    expect(frame.left).toBeGreaterThanOrEqual(content.left - 1)
    expect(frame.right).toBeLessThanOrEqual(content.right + 1)
    // Resident, not a strip: the frame takes the column's whole height.
    expect(frame.height).toBeGreaterThan(content.height - 2)
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
  }, 90_000)

  it('keeps a cached frame\'s document alive when a session opens beside it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-identity'))
    // Mark the frame the column shows with no session current — the overlay's
    // default page — and the document inside it.
    expect(await probeFrame(page, 'kept')).toEqual(KEPT)

    await openSession(page, 1)
    // The session owns its own frame, showing the same default page because
    // its log names none.
    await expect.poll(
      async () => await contentFrame(page).getAttribute('src'), { timeout: 15_000 }).toBe('/content-app/')

    // Evidence for the composition, not a failure artifact: the hosted page in
    // the content column with a real session open beside it.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-frame.png') })

    // The marked frame is still mounted, merely hidden. The column is a `root`
    // slot, so the framework never remounts it and nothing it holds is
    // destroyed by a session transition.
    expect(await probeFrame(page, undefined, `iframe[data-content-frame][${PROBE_ATTRIBUTE}="kept"]`))
      .toEqual(KEPT)
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
