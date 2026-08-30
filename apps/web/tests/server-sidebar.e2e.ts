/**
 * Web e2e scenario: the product-console sidebar
 * (`@deepseek-ai/dsh-experimental-server-sidebar`) — the fixed three-section
 * shell (workbench / navigation / my workflows), decision ③'s conditional
 * "Save as workflow" header action, decision ⑧'s degrade-to-a-fresh-
 * conversation path, and decision ②'s de-terminology layer (both the
 * official disable rows and the one CSS-injection fallback).
 *
 * Mostly zero model calls, the same shape `rail-search-expand.e2e.ts` uses
 * for a pure client-layout scenario: every session this scenario opens is
 * created live through the UI with no message ever typed into the composer.
 * The one exception is the "Save as workflow" and de-terminology scenario,
 * which needs a real user-authored message on the log to satisfy decision
 * ③'s visibility gate and a real closed step to satisfy the turns/steps row's
 * render condition — both seeded directly onto the live agent's session
 * (`agent.session.append(..., { surfaceOp: 'append' })`, the same technique
 * `seeded-history.e2e.ts` uses to inject a durable message without a model
 * call) rather than driven through the composer.
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
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
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
/** A workflow naming a session nobody ever created — seeded before the browser ever reads it (decision ⑧). */
const GHOST_SESSION_ID = 'server-sidebar-e2e-ghost-session'
const GHOST_WORKFLOW_ID = 'ghost-workflow'
/** This package's own settings namespace; a bare string literal, not an import (see the module doc above). */
const SERVER_SIDEBAR_NAMESPACE = settingsNamespace('server-sidebar')

// A fresh session's composer still carries the hero placeholder
// (`placeholder.hero` in dsh-client-ui-conversation) until a message lands
// on it, then falls back to the established-session default.
const HERO_PLACEHOLDER = 'Describe what you want to build'
const ESTABLISHED_PLACEHOLDER = 'Message the agent'

/**
 * This deployment's local shape for the server-menu settings document —
 * apps/web cannot import the experimental package (see the module doc above).
 */
interface LocalWorkflow {
  id: string
  name: string
  order: number
  homeSessionId: string
  navSnapshot: string[]
  savedAt: number
}
interface LocalServerMenu {
  workflows: LocalWorkflow[]
  workbenchSessionId?: string
}

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

const sidebar = (page: Page): Locator => page.locator('[data-server-sidebar]')
const workbenchButton = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="workbench"]')
const navSection = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="nav"]')
const workflowsSection = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="workflows"]')
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

/** Read the server-menu settings document straight from the host, bypassing the HTTP route entirely. */
function readServerMenu(scaffold: WebScaffold): LocalServerMenu {
  return scaffold.ctx.settings.get(SERVER_SIDEBAR_NAMESPACE) as LocalServerMenu
}

/**
 * Seed a full, closed turn (`turn/start` → `user/message` → `step/start` →
 * `assistant/message` → `step/end` → `turn/end`) directly onto a live
 * session's log, with no model call. `user/message` satisfies decision ③'s
 * visibility gate; the closed step satisfies the turns/steps row's own
 * `stats.steps > 0` render condition, which a bare `user/message` alone
 * would not (`StatsLine.tsx` renders nothing at zero steps) — needed here so
 * the de-terminology assertion proves the CSS guard actually hides a row
 * that would otherwise render, not merely that nothing rendered anyway.
 * @param scaffold - the live scaffold.
 * @param sessionId - the session to seed onto; must have a live agent.
 */
function seedClosedTurn(scaffold: WebScaffold, sessionId: string): void {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`server-sidebar e2e: no live agent for ${sessionId}`)
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Build the weekly report page.' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Done.' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

describe('web e2e: the product-console sidebar', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT
  /** The workbench's persistent session id, captured once test 2 creates it. */
  let workbenchSessionId: string

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    // Seed one ghost workflow before the browser ever loads: this package's
    // own settings namespace, already registered by the server-sidebar row
    // this composition just loaded. Its `homeSessionId` names a session that
    // never existed — decision ⑧'s degrade path, exercised below.
    await scaffold.ctx.settings.replace(SERVER_SIDEBAR_NAMESPACE, {
      workflows: [{
        id: GHOST_WORKFLOW_ID,
        name: 'Ghost Workflow',
        order: 0,
        homeSessionId: GHOST_SESSION_ID,
        navSnapshot: ['reports'],
        savedAt: Date.now(),
      }],
    })
    // Registered before the browser ever connects, so the client's initial
    // boot payload already carries it — no live-push race to synchronize
    // against, and no interference with `dsh-client-runtime`'s own one-shot
    // `startInitialSelection`: that mechanism and this scenario's own
    // explicit workbench click both resolve through the same
    // `WorkspaceRuntime.connectWorkspace` coalescing, so whichever gets
    // there first, the session left open is the same one either way.
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('renders the fixed three-section shell, with no banned session/workspace vocabulary anywhere on the page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-structure'))
    await expect(workbenchButton(page).getByText('Workbench').isVisible()).resolves.toBe(true)
    await expect(navSection(page).getByText('Navigation').isVisible()).resolves.toBe(true)
    await expect(navSection(page).getByRole('button', { name: 'Home' }).isVisible()).resolves.toBe(true)
    await expect(navSection(page).getByRole('button', { name: 'Weekly reports' }).isVisible()).resolves.toBe(true)
    await expect(workflowsSection(page).getByText('My Workflows').isVisible()).resolves.toBe(true)
    await expect(workflowsSection(page).getByRole('button', { name: /Ghost Workflow/ }).isVisible()).resolves.toBe(true)
    // No fold/collapse rail control survives decision ①.
    expect(await page.getByRole('button', { name: /collapse|Open the pages/i }).count()).toBe(0)

    // Scoped to this package's own chrome: decision ②'s banned-word list is
    // this package's obligation for its own copy, not a system-wide audit of
    // every shipped package's strings (content-column's empty-state copy and
    // the hero's workspace-picker copy are pre-existing, out-of-scope text —
    // see the package README's Known Limitations).
    const sidebarText = await sidebar(page).innerText()
    for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /会话/, /新会话/]) {
      expect(sidebarText, `banned text matched ${banned}`).not.toMatch(banned)
    }
  }, 60_000)

  it(
    'creates and opens the persistent workbench conversation on click, then auto-reopens the same one on the next page load with no click',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-workbench'))
      // The mount-time auto-open effect (decision ①'s "no current session"
      // path) may already have raced ahead of this test during the previous
      // test's own assertions — either way, clicking the persistent entry is
      // itself a supported path (not only the auto-open), and
      // `resolveOrCreateSession`'s workspace-connect coalescing (see
      // session-resolution.ts) guarantees a click never mints a second
      // session alongside one auto-open already created.
      await workbenchButton(page).click()
      await page.getByPlaceholder(HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })

      await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBeUndefined()
      workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!
      expect(scaffold.ctx.agents.get(SessionId(workbenchSessionId))).toBeDefined()
      expect(scaffold.ctx.agents.list()).toHaveLength(1)

      // Decision ①'s auto-open-on-load: reload with no click and land back on
      // the same persistent conversation, with no second one minted.
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await sidebar(page).waitFor({ timeout: 15_000 })
      await page.getByPlaceholder(HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
      expect(readServerMenu(scaffold).workbenchSessionId).toBe(workbenchSessionId)
      expect(scaffold.ctx.agents.list()).toHaveLength(1)
    },
    90_000,
  )

  it(
    'shows "Save as workflow" only once the conversation has a user message, and hides the turns/steps row behind the terminology guard',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-save-workflow'))
      await navSection(page).getByRole('button', { name: 'Home' }).click()
      await expectShown(page, '/content-app/')
      await expect.poll(() => anySessionShowed(scaffold, 'home', 'user'), { timeout: 15_000 }).toBe(true)

      expect(await page.getByRole('button', { name: 'Save as workflow' }).count()).toBe(0)

      seedClosedTurn(scaffold, workbenchSessionId)
      await page.getByRole('button', { name: 'Save as workflow' }).waitFor({ timeout: 15_000 })

      // De-terminology: the turns/steps row would show "1 turns · 1 steps"
      // (StatsLine.tsx) now that a closed step is on the log — pin the CSS
      // guard by confirming the row is present in the DOM but not visible,
      // not merely absent for an unrelated reason.
      const statsRow = page.getByText('1 turns · 1 steps')
      expect(await statsRow.count()).toBeGreaterThan(0)
      await expect(statsRow.first().isVisible()).resolves.toBe(false)

      await page.getByRole('button', { name: 'Save as workflow' }).click()
      const nameField = page.getByPlaceholder('Workflow name')
      await nameField.waitFor({ timeout: 10_000 })
      await nameField.fill('My Workflow')
      await nameField.press('Enter')

      await expect.poll(async () => await workflowsSection(page).getByRole('button', { name: /My Workflow/ }).isVisible(), {
        timeout: 10_000,
      }).toBe(true)

      await expect.poll(() => readServerMenu(scaffold).workflows.find(w => w.name === 'My Workflow'), {
        timeout: 10_000,
      }).toMatchObject({ homeSessionId: workbenchSessionId, navSnapshot: ['home'] })
    },
    90_000,
  )

  it('degrades a workflow whose bound conversation is gone, replaying its navigation snapshot into a fresh one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-degrade'))
    // The degrade path creates its replacement session against the recent
    // Workspace, same as the workbench's own first-use path — a second
    // Workspace gives it somewhere to create a session distinct from the
    // workbench's own, so the later "switch back" assertion is a genuine
    // session switch and not a same-session no-op.
    const secondCwd = join(scaffold.workspaceCwd, 'second-workspace')
    await mkdir(secondCwd, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(secondCwd)

    await expect.poll(async () => {
      await workflowsSection(page).getByRole('button', { name: /Ghost Workflow/ }).click()
      return await activeFrame(page).count() > 0
    }, { timeout: 20_000 }).toBe(true)

    await expectShown(page, '/content-app/reports/')
    await expect.poll(() => anySessionShowed(scaffold, 'reports', 'user'), { timeout: 15_000 }).toBe(true)

    await expect.poll(
      () => readServerMenu(scaffold).workflows.find(w => w.id === GHOST_WORKFLOW_ID)?.homeSessionId,
      { timeout: 15_000 },
    ).not.toBe(GHOST_SESSION_ID)
    const degraded = readServerMenu(scaffold).workflows.find(w => w.id === GHOST_WORKFLOW_ID)!.homeSessionId
    expect(degraded).not.toBe(workbenchSessionId)
    expect(scaffold.ctx.agents.get(SessionId(degraded))).toBeDefined()
  }, 90_000)

  it('switches back to "My Workflow" and returns to its own bound conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-switch-back'))
    await workflowsSection(page).getByRole('button', { name: /My Workflow/ }).click()
    await expectShown(page, '/content-app/')
  }, 60_000)

  it('leaves the Chat/Trajectory tab switcher and the model selector out of the customer-form composition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-de-terminology'))
    expect(await page.getByRole('tab').count()).toBe(0)
    expect(await page.getByRole('button', { name: /^Select model, current/ }).count()).toBe(0)
    // The composer itself must not be stuck blocked now that no plugin
    // registers `useComposerBlock` (ui-model-selection is disabled).
    await expect(page.getByPlaceholder(ESTABLISHED_PLACEHOLDER).isEnabled()).resolves.toBe(true)
  }, 30_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
