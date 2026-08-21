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
 * (the route's content types are what decides that), and which session
 * transitions the frame survives — the session-maybe adoption rule decides
 * that, and it is what determines whether the hosted application keeps its own
 * state.
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
const contentFrame = (page: Page): Locator => page.locator('iframe[data-content-frame]')

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

/** Attribute the probe stamps on the live iframe element. */
const PROBE_ATTRIBUTE = 'data-dsh-probe'

/** Marks the live frame carries while a spec drives navigation around it. */
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
/** A frame React mounted anew: the marks are gone and the hosted document ran once. */
const FRESH: FrameProbe = { element: null, document: undefined, loads: 1 }

/** The hosted document's global, as this spec reads it: the fixture's load counter and the probe's own mark. */
interface HostedWindow {
  __dshProbe?: string
  __contentAppLoads?: number
}

/**
 * Stamp the live frame and its document, then read both back.
 * @param page - the browsing page.
 * @param stamp - mark to write, or undefined to read only.
 * @returns the marks, or undefined while no frame with a live document is mounted.
 */
async function probeFrame(page: Page, stamp: string | undefined): Promise<FrameProbe | undefined> {
  return await page.evaluate(([mark, attribute]: [string | undefined, string]) => {
    const element = document.querySelector<HTMLIFrameElement>('iframe[data-content-frame]')
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
  }, [stamp, PROBE_ATTRIBUTE] as [string | undefined, string])
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
    // No session is opened here: the adoption spec below needs the frame in the
    // session-less incarnation it boots into.
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
    const inner = page.frameLocator('iframe[data-content-frame]')
    const heading = inner.locator('#fixture-heading')
    await heading.waitFor({ timeout: 15_000 })
    expect(await heading.textContent()).toBe('Hosted content app')
    // The sheet applies only when the route answered `text/css`, so the
    // computed color is the browser's own verdict on the route's MIME table.
    expect(await heading.evaluate(node => getComputedStyle(node).color)).toBe('rgb(0, 128, 0)')
  }, 90_000)

  it('survives the first session adoption, then remounts on every later transition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-frame-identity'))
    // The session-maybe incarnation the page booted into adopts the first
    // session that arrives, so the frame and the document inside it survive
    // that one transition — the hosted application keeps its own state through
    // the user's first click.
    expect(await probeFrame(page, 'kept')).toEqual(KEPT)
    await openSession(page, 1)
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(KEPT)

    // Evidence for the composition, not a failure artifact: the hosted page in
    // the content column with a real session open beside it.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-frame.png') })

    // After adoption the entry behaves like a strict session entry: switching
    // sessions is a fresh incarnation, so the application reloads and whatever
    // the user had in it is gone.
    await openSession(page, 2)
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(FRESH)

    // Returning to no-session is another incarnation, by the same rule.
    expect(await probeFrame(page, 'kept')).toEqual(KEPT)
    await page.getByRole('button', { name: 'New session' }).first().click()
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(FRESH)
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
