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
 * Two describe blocks, two compositions: the first composes server-layout
 * alone, so nothing ever produces a `contentSurface` projection value and the
 * content column's own collapse-when-empty read
 * (`@deepseek-ai/dsh-experimental-server-layout`'s `ShellFrame.tsx`,
 * `currentContentEmpty`) sees the natural "no producer at all" case; the
 * second additionally composes `content-surface` and `content-frame` (not
 * `content-column`, which this scenario does not need — the 'content' slot
 * stays genuinely unclaimed in both compositions, so the shell's own
 * placeholder still owns it) and seeds a real `content/shown` event directly
 * onto the live session, so the same read sees a populated one. The first
 * composition's three columns used to all report non-zero width before this
 * collapse existed; that assertion now lives in the second block, against a
 * composition that actually has content to show.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const SHELL_PACKAGE = '@deepseek-ai/dsh-experimental-server-layout'
const SHELL_DIR = join(REPO_ROOT, 'packages/experimental/server-layout')
const OVERLAY = join(SHELL_DIR, 'overlay/three-column.patch.yml')
const CONTENT_OVERLAY = fileURLToPath(new URL('./server-layout-content.overlay.yml', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
const CONTENT_APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
const SESSION = 'server-layout-web-e2e'
const CONTENT_SESSION = 'server-layout-content-web-e2e'

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
 * Prepare a harness home whose profile fallback resolves every named
 * experimental row.
 * @param rows - package name and source directory pairs to link.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(rows: readonly (readonly [string, string])[]): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-server-layout-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of rows) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
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

/** Open the workspace tree's first session row and wait for its composer. */
async function openFirstSession(page: Page): Promise<void> {
  // The workspace group row precedes its sessions; expanding it lists them.
  await page.locator('[role="treeitem"]').first().click()
  const row = page.locator('[role="treeitem"]').nth(1)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

describe.skipIf(MODE === 'record')('web e2e: service-line three-column shell', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks([[SHELL_PACKAGE, SHELL_DIR]])
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await column(page, 'content').waitFor({ state: 'attached', timeout: 30_000 })
    await openFirstSession(page)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('collapses the content column to zero width and hands its whole share to chat with no content producer composed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-collapsed'))
    const [session, content, chat] = await Promise.all([
      box(column(page, 'session')), box(column(page, 'content')), box(column(page, 'chat')),
    ])
    expect(content.width).toBe(0)
    // The session column keeps its normal 3-unit share; chat absorbs
    // everything content would otherwise have taken, not just its own 5-unit
    // share — the same reclaim the details band's own collapse gets.
    const unit = (session.width + chat.width) / (RATIO.session + RATIO.content + RATIO.chat)
    expect(Math.abs(session.width / unit / RATIO.session - 1)).toBeLessThan(TOLERANCE)
    // Resident and adjacent: chat abuts session directly with no gap.
    expect(chat.left).toBeCloseTo(session.right, 0)

    // Evidence for the composition, not a failure artifact.
    await page.screenshot({ path: join(REPO_ROOT, '.artifacts', 'web-e2e-server-layout-collapsed.png') })
  }, 90_000)

  it('folds the session column to its rail and restores the ratio on expand, with chat (not content) absorbing the fold', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-fold'))
    const expanded = (await box(column(page, 'session'))).width

    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    await expect.poll(async () => (await box(column(page, 'session'))).width, { timeout: 10_000 })
      .toBeCloseTo(SESSION_RAIL, 0)
    // The fold hands its ratio units to chat: content stays collapsed either way.
    expect((await box(column(page, 'content'))).width).toBe(0)
    expect((await box(column(page, 'chat'))).width).toBeGreaterThan(expanded)

    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await expect.poll(async () => (await box(column(page, 'session'))).width, { timeout: 10_000 })
      .toBeCloseTo(expanded, 0)
  }, 90_000)

  it('keeps the session list in the left column and the composer in the right one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-occupants'))
    await expectInsideColumn(page.locator('[role="treeitem"]').first(), 'session', page)
    await expectInsideColumn(page.getByPlaceholder(COMPOSER_PLACEHOLDER), 'chat', page)
  }, 90_000)

  it('keeps its own empty-state body mounted in the unclaimed content column even though the column itself is collapsed', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-placeholder'))
    // Slot occupancy (nobody claimed 'content', so the shell's own fallback
    // renders) and content-emptiness (nothing to show, so the column
    // collapses) are independent facts — the fallback stays in the tree at
    // zero width rather than being torn down, the same way the details
    // subtree stays mounted while closed.
    const placeholder = page.getByText(PLACEHOLDER_TITLE, { exact: true })
    await expect.poll(async () => await placeholder.count()).toBe(1)
    expect((await box(column(page, 'content'))).width).toBe(0)
  }, 90_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

describe.skipIf(MODE === 'record')('web e2e: service-line shell with a populated content surface', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks([
      [SHELL_PACKAGE, SHELL_DIR],
      ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
      ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
    ])
    // The overlay's `!!js` expression resolves against this process.
    process.env.DSH_CONTENT_APP_ROOT = CONTENT_APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: CONTENT_OVERLAY })
    await seedSession(scaffold, await readFile(FIXTURE, 'utf8'), CONTENT_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await column(page, 'content').waitFor({ state: 'attached', timeout: 30_000 })
    await openFirstSession(page)

    // A real `content_show` call or `show-content-page` command invocation
    // needs a browser-driven UI this scenario has no reason to build; append
    // the same event `content-frame`'s command handler appends directly onto
    // the now-live agent's session (`command.ts`'s own append, minus the
    // command lifecycle it wraps it in). `content/shown` is not a type this
    // compilation knows (content-frame's `SessionEventMap` merge is not
    // importable from apps/web), so the call is widened past `append`'s
    // typed overload rather than trusted from an imported type.
    const agent = scaffold.ctx.agents.get(SessionId(CONTENT_SESSION))
    if (agent === undefined) throw new Error('server-layout content e2e: no live agent for the seeded session')
    // Widened as a method call, not a detached function: `append` reads `this`.
    const session = agent.session as unknown as { append: (type: string, data: unknown) => number }
    session.append('content/shown', { page: 'home', by: 'agent' })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('splits the frame on the 3:16:5 ratio with all three columns visible', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-layout-ratio'))
    await expect.poll(async () => (await box(column(page, 'content'))).width, { timeout: 15_000 }).toBeGreaterThan(0)
    // The grid expansion is animated (`--ds-transition-duration-slow`, 0.3s);
    // the poll above only proves the expand has started, not settled.
    await page.waitForTimeout(400)
    const [session, content, chat] = await Promise.all([
      box(column(page, 'session')), box(column(page, 'content')), box(column(page, 'chat')),
    ])

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

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
