/**
 * Web e2e scenario: the agent-driven content column and its per-session frames.
 *
 * The composition is the shipped Web surface plus an overlay mounting both
 * experimental rows with a two-page deployment. Two sessions are seeded with
 * different `content/shown` events, so what the assertions read is the whole
 * host path — a durable log, the `content` projection resolving each recorded
 * id against the configured pages, the tail page carrying it to the browser —
 * and then the one thing only a real browser can answer: whether the frame a
 * user comes back to is the SAME element, still holding the same live
 * document. That is what the column's `root` scope and its frame cache exist
 * for, and no unit test can observe it.
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
const OVERLAY = fileURLToPath(new URL('./content-show.overlay.yml', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
/** Both experimental rows the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
] as const
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
const HOME_SESSION = 'content-show-web-e2e-home'
const REPORTS_SESSION = 'content-show-web-e2e-reports'

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** Attribute the probe stamps on a live iframe element. */
const PROBE_ATTRIBUTE = 'data-dsh-probe'

/**
 * Prepare a harness home whose profile fallback resolves both experimental rows.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-show-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * Splice one `content/shown` event into a recorded session, before its closing turn.
 * @param fixtureText - the committed seed fixture.
 * @param page - the page id the agent showed.
 * @returns the fixture text to seed.
 */
function withShownPage(fixtureText: string, page: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
    JSON.stringify({ type: 'content/shown', data: { page } }),
    ...lines.slice(closing),
  ].join('\n')
}

const column = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)
const activeFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')

/** Open the sidebar session row whose title cell is at `index` and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

/** The two pages the overlay configures, by URL, with the heading each document renders. */
const HEADINGS: Readonly<Record<string, string>> = {
  '/content-app/': 'Hosted content app',
  '/content-app/reports/': 'Weekly reports',
}

/**
 * Open one sidebar session and read what the column then shows.
 *
 * The sidebar's row order is the host's, not this spec's, so a row is
 * identified by the page its own log named rather than by an assumed index.
 * @param page - the browsing page.
 * @param index - sidebar row to click.
 * @returns the URL the column shows and the heading inside that document.
 */
async function openAndRead(page: Page, index: number): Promise<{ src: string; heading: string | null }> {
  await openSession(page, index)
  const src = await shownSrc(page)
  const inner = page.frameLocator('iframe[data-content-frame][data-content-active]')
  const heading = inner.locator('#fixture-heading')
  await heading.waitFor({ timeout: 15_000 })
  return { src, heading: await heading.textContent() }
}

/** Wait for the column to settle on a configured page and answer with its URL. */
async function shownSrc(page: Page): Promise<string> {
  await expect.poll(async () => await activeFrame(page).getAttribute('src'), { timeout: 15_000 })
    .toMatch(/^\/content-app\//)
  return await activeFrame(page).getAttribute('src') ?? ''
}

/** Marks the shown frame carries while a spec drives navigation around it. */
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
 * Stamp the shown frame and its document, then read both back.
 * @param page - the browsing page.
 * @param stamp - mark to write, or undefined to read only.
 * @returns the marks, or undefined while no shown frame has a live document.
 */
async function probeFrame(page: Page, stamp: string | undefined): Promise<FrameProbe | undefined> {
  return await page.evaluate(([mark, attribute]: [string | undefined, string]) => {
    const element = document.querySelector<HTMLIFrameElement>('iframe[data-content-frame][data-content-active]')
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

describe.skipIf(MODE === 'record')('web e2e: the agent-driven content column', () => {
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
    await seedSession(scaffold, withShownPage(fixture, 'home'), HOME_SESSION)
    await seedSession(scaffold, withShownPage(fixture, 'reports'), REPORTS_SESSION)

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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('shows nothing until a session says what to show', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-show-empty'))
    // This deployment configures no default page, so a shell with no session
    // open explains the empty column rather than guessing at one.
    await page.locator('[data-content-notice]').waitFor({ timeout: 15_000 })
    expect(await activeFrame(page).count()).toBe(0)
  }, 90_000)

  it('restores each session\'s own page from its log', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-show-restore'))
    const first = await openAndRead(page, 1)
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-show-first.png') })
    const second = await openAndRead(page, 2)
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-show-second.png') })

    // Two sessions, two pages: each column follows its own log, not the other's.
    expect([first.src, second.src].sort()).toEqual(['/content-app/', '/content-app/reports/'])
    // And each frame really loaded the document its page names.
    expect(first.heading).toBe(HEADINGS[first.src])
    expect(second.heading).toBe(HEADINGS[second.src])
  }, 120_000)

  it('keeps each session\'s frame alive across a switch and back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-show-keepalive'))
    // Mark the frame of the session currently open, and the document in it.
    const marked = await shownSrc(page)
    expect(await probeFrame(page, 'kept')).toEqual(KEPT)

    const other = await openAndRead(page, 1)
    expect(other.src).not.toBe(marked)

    await openSession(page, 2)
    // Both marks survived: the same element, still holding the document it
    // loaded once. Under a session-scoped column both would be gone.
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(KEPT)
    expect(await shownSrc(page)).toBe(marked)
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-content-show-keepalive.png') })
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
