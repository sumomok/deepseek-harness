/**
 * Web e2e scenario: the retrofit sidebar menu (`@deepseek-ai/dsh-experimental-server-sidebar`) —
 * page routes drawn from content-frame's configured pages, and per-account
 * favorite sessions, both compliant click-through paths this package adds
 * over the shipped sidebar.
 *
 * Zero model calls: every session this scenario uses is created live through
 * the UI with no message sent, so the composition needs no replay fixture —
 * the same shape `rail-search-expand.e2e.ts` uses for a pure client-layout
 * scenario.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the
 * profile links the loader resolves the rows through are created here rather
 * than by `healProfilesModuleFallback` (the same approach `content-show.e2e.ts`
 * uses for its own experimental rows).
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./server-sidebar.overlay.yml', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
  ['@deepseek-ai/dsh-experimental-server-sidebar', join(REPO_ROOT, 'packages/experimental/server-sidebar')],
] as const
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
/** A favorite naming a session nobody ever created — seeded before the browser ever reads it. */
const GHOST_SESSION_ID = 'server-sidebar-e2e-ghost-session'
/** This package's own settings namespace; a bare string literal, not an import (see the module doc above). */
const SERVER_SIDEBAR_NAMESPACE = settingsNamespace('server-sidebar')

// Every session this scenario opens is fresh (created live, no message ever
// sent), so its composer still carries the hero placeholder
// (`placeholder.hero` in dsh-client-ui-conversation) rather than the
// established-session default `Message the agent`.
const COMPOSER_PLACEHOLDER = 'Describe what you want to build'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-server-sidebar-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

const menu = (page: Page): Locator => page.locator('[data-server-sidebar-menu]')
const activeFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')

/**
 * Wait for the column to settle on exactly this page's URL.
 *
 * Polls for the literal target rather than the generic `/content-app/...`
 * shape: switching pages within one already-open session (unlike opening a
 * different session) never passes through a frame-less moment, so a generic
 * match would resolve on the PREVIOUS page's still-present src before the
 * click's own effect lands.
 * @param page - the browsing page.
 * @param path - the exact src the active frame must carry.
 */
async function expectShown(page: Page, path: string): Promise<void> {
  await expect.poll(async () => await activeFrame(page).getAttribute('src'), { timeout: 15_000 }).toBe(path)
}

/** This deployment's shape for `content/shown`'s data — a local type, since apps/web cannot import content-frame. */
interface ShownPageData {
  page: string | null
  by?: 'agent' | 'user'
}

/** Whether any live agent's session recorded showing `page` with the given writer. */
function anySessionShowed(scaffold: WebScaffold, page: string, by: 'agent' | 'user'): boolean {
  return scaffold.ctx.agents.list().some(agent => agent.session.events.some((event: SessionEvent) => {
    // `'content/shown'` augments `SessionEventMap` from content-frame, which
    // apps/web cannot import (see the module doc), so this compilation's
    // `SessionEvent['type']` union has no such member to narrow on — widen
    // before comparing rather than let a real string mismatch type-error.
    if ((event.type as string) !== 'content/shown') return false
    const data = event.data as unknown as ShownPageData
    return data.page === page && data.by === by
  }))
}

describe('web e2e: the retrofit sidebar menu', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    // Seed one stale favorite before the browser ever fetches the route: this
    // package's own settings namespace, already registered by the
    // server-sidebar row this composition just loaded.
    await scaffold.ctx.settings.replace(SERVER_SIDEBAR_NAMESPACE, {
      favorites: [{ sessionId: GHOST_SESSION_ID, label: 'Ghost', order: 0 }],
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await menu(page).waitFor({ timeout: 30_000 })
    // Confirm the client's one-shot startup reconcile already evaluated (and
    // found no Workspace) before registering one: `startInitialSelection`
    // (`dsh-client-runtime`) evaluates the Workspace list exactly once per
    // page load and never retries, so registering after it already found
    // none — rather than before — keeps it inert and leaves the Workspace
    // for `openContentPage`'s own auto-create to pick up instead.
    await page.getByText('No sessions yet').waitFor({ timeout: 15_000 })
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)
    // The registration reaches the browser through a live
    // `host/workspace-changed` push over the already-open connection, not a
    // refetch; wait for it to land (the Workspace's own row, which renders
    // even with zero sessions) before any test reads `recentWorkspaceId`.
    await page.getByRole('treeitem', { name: 'server-sidebar-workspace' }).waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('lists every configured page, and renders a favorite naming a deleted session as a gray, removable row', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-menu'))
    await expect(menu(page).getByRole('button', { name: 'Home' }).isVisible()).resolves.toBe(true)
    await expect(menu(page).getByRole('button', { name: 'Weekly reports' }).isVisible()).resolves.toBe(true)

    const staleRow = menu(page).getByRole('button', { name: /Ghost/ })
    await expect(staleRow.isVisible()).resolves.toBe(true)
    await expect(staleRow.isDisabled()).resolves.toBe(true)
    await expect(menu(page).getByText('Session deleted').isVisible()).resolves.toBe(true)
    // The row's actions reveal on hover (MenuSection.module.css); removable,
    // not silently dropped, means the trash action is present once revealed.
    await staleRow.hover()
    await expect(menu(page).getByRole('button', { name: 'Remove favorite' }).isVisible()).resolves.toBe(true)
  }, 60_000)

  it('auto-creates a session and shows the page when none is open, recording the click as the user\'s own', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-autocreate'))
    expect(await activeFrame(page).count()).toBe(0)
    await menu(page).getByRole('button', { name: 'Home' }).click()

    await expectShown(page, '/content-app/')
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
    // The command seam recorded the click, distinct from the tool's own writes.
    await expect.poll(() => anySessionShowed(scaffold, 'home', 'user'), { timeout: 15_000 }).toBe(true)
  }, 90_000)

  it('switches pages within the same session through the command seam', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-switch-page'))
    await menu(page).getByRole('button', { name: 'Weekly reports' }).click()
    await expectShown(page, '/content-app/reports/')
    await expect.poll(() => anySessionShowed(scaffold, 'reports', 'user'), { timeout: 15_000 }).toBe(true)
  }, 60_000)

  it('favorites the current session and renames it in place', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-favorite'))
    await menu(page).getByRole('button', { name: 'Favorite current session' }).click()
    const nameField = menu(page).getByPlaceholder('Favorite name')
    await nameField.waitFor({ timeout: 10_000 })
    await nameField.fill('My Reports')
    await nameField.press('Enter')
    // The commit is fire-and-forget from the click handler (MenuSection.tsx):
    // the edit box closes immediately, but the row itself only appears once
    // the settings-route round trip lands.
    await expect.poll(async () => await menu(page).getByRole('button', { name: 'My Reports' }).isVisible(), {
      timeout: 10_000,
    }).toBe(true)

    // The row's actions reveal on hover (MenuSection.module.css) — see the
    // stale-favorite test's identical note.
    await menu(page).getByRole('button', { name: 'My Reports' }).hover()
    await menu(page).getByRole('button', { name: 'Rename' }).click()
    const renameField = menu(page).getByPlaceholder('Favorite name')
    await renameField.fill('Reports Session')
    await renameField.press('Enter')
    await expect.poll(async () => await menu(page).getByRole('button', { name: 'Reports Session' }).isVisible(), {
      timeout: 10_000,
    }).toBe(true)
  }, 60_000)

  it('switches to the favorited session from a different one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-switch-session'))
    // The New Session button reuses the recent Workspace's own blank session
    // (`WorkspaceRuntime.connectWorkspace` coalescing) rather than minting a
    // second one, and this suite's only session is still blank (no message
    // was ever sent) — so a genuinely distinct "different session" needs its
    // own Workspace. A second Workspace's own "New session in <name>" row
    // action targets it explicitly (`startSession(workspaceId)`), which has
    // nothing to reuse and so mints a real second session.
    const secondCwd = join(scaffold.workspaceCwd, 'second-workspace')
    await mkdir(secondCwd, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(secondCwd)

    const secondGroup = page.getByRole('treeitem', { name: 'second-workspace' })
    await secondGroup.waitFor({ timeout: 15_000 })
    await secondGroup.click()
    await page.getByRole('button', { name: 'New session in second-workspace' }).click()
    await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
    await expect.poll(async () => await activeFrame(page).count(), { timeout: 10_000 }).toBe(0)

    await menu(page).getByRole('button', { name: 'Reports Session' }).click()
    await expectShown(page, '/content-app/reports/')
  }, 90_000)

  it('collapses the menu to a rail icon with a dismissible flyout', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-collapsed'))
    await page.getByRole('button', { name: 'Collapse sidebar' }).click()
    const trigger = page.getByRole('button', { name: 'Open the pages and favorites menu' })
    await expect.poll(async () => await trigger.isVisible(), { timeout: 10_000 }).toBe(true)
    await expect.poll(async () => await menu(page).getByRole('button', { name: 'Home' }).isVisible(), { timeout: 10_000 })
      .toBe(false)

    await trigger.click()
    await expect(menu(page).getByRole('button', { name: 'Home' }).isVisible()).resolves.toBe(true)

    // Dismisses on an outside click, same as any other floating panel here.
    await page.mouse.click(10, 10)
    await expect.poll(async () => await menu(page).getByRole('button', { name: 'Home' }).isVisible(), { timeout: 10_000 })
      .toBe(false)

    await page.getByRole('button', { name: 'Open sidebar' }).click()
    await expect.poll(async () => await menu(page).getByRole('button', { name: 'Home' }).isVisible(), { timeout: 10_000 })
      .toBe(true)
  }, 60_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
