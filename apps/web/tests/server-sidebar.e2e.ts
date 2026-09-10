/**
 * Web e2e scenario: the product-console sidebar
 * (`@deepseek-ai/dsh-experimental-server-sidebar`) — the fixed three-section
 * shell (workbench / navigation / my workflows), decision ③'s conditional
 * "Save as workflow" header action, decision ⑧'s degrade-to-a-fresh-
 * conversation path, decision ②'s de-terminology layer (both the official
 * disable rows and the one CSS-injection fallback), the brand-and-hero
 * facade (the sidebar's own "Workbench Assistant" fallback text, the
 * priority-shadowed `conversation.hero.brand.mark` takeover, and the
 * fish/preview-badge/headline/workspace-row/agent-preset hero rules — see the
 * package README's Brand and hero facade section), the workbench's
 * clean-draft click semantics, the current-selection highlight, drag-and-drop
 * workflow reordering, the footer's identity band (the signed-in name and
 * the sign-out control, both fitting the column),
 * (`@deepseek-ai/dsh-experimental-content-frame`)
 * hiding the `show-content-page` command's own chat echo while its durable
 * `command/run`/`content/shown`/`command/done` lifecycle still lands on the
 * log, and (`@deepseek-ai/dsh-experimental-server-layout`) the content
 * column collapsing on a content-less blank draft. A second describe block
 * reruns the workbench-click scenario under content-frame's `homePage`
 * config, proving the opposite pairing — an auto-shown home page and a
 * content column that never collapses — and, on that same draft, both
 * answers the clean-draft judgment gives: a second click reuses the draft its
 * own first click populated and adds no second home-page record, while a
 * draft the visitor has navigated elsewhere in is unclean and takes the
 * create path, which shows the home page again (on the same conversation —
 * see the package README's Known Limitations). A fourth describe covers the
 * business-content-only decision: one seeded closed turn carrying every
 * process row the guard now hides, read back for each hide, for the produced
 * files and the approval card it keeps, for the swapped composer placeholder
 * in both composer states, and for the re-texted running indicator.
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
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
// The type import also carries llm-retry's own `SessionEventMap` merge, which
// is what lets the seeded `llm/retry` narrow instead of widening to a string.
import type { RetryId } from '@deepseek-ai/dsh-llm-retry/types'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands/types'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction/checkpoint'
// Empty type import alongside the named one: carries compaction's own
// `SessionEventMap` merge, which the checkpoint outlet deliberately does not.
import type { CompactionId } from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import { WorkflowRunId } from '@deepseek-ai/dsh-workflow/types'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
// Empty type import: carries the approval service onto the scaffold's Context
// so the business-content scenario below can ask for a decision directly.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const OVERLAY = fileURLToPath(new URL('./server-sidebar.overlay.yml', import.meta.url))
/** Identical to {@link OVERLAY}, plus content-frame's `homePage` config. */
const HOMEPAGE_OVERLAY = fileURLToPath(new URL('./server-sidebar-homepage.overlay.yml', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
/**
 * Every experimental package the overlay's rows need resolvable, as package name
 * and source directory. Most are inserted by name; `library-skills` is instead
 * named by the `bundledSkillDir` expression of the overlay's `skill-filesystem`
 * row, which resolves it from the profile the same way.
 */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
  ['@deepseek-ai/dsh-experimental-server-sidebar', join(REPO_ROOT, 'packages/experimental/server-sidebar')],
  ['@deepseek-ai/dsh-experimental-library-skills', join(REPO_ROOT, 'packages/experimental/library-skills')],
] as const
/**
 * Identical to {@link OVERLAY}, plus the component rows and one configured
 * view — the one composition here where both catalogs exist to be merged.
 */
const VIEWS_OVERLAY = fileURLToPath(new URL('./server-sidebar-views.overlay.yml', import.meta.url))
/** {@link ROWS} plus the three rows {@link VIEWS_OVERLAY} adds. */
const VIEW_ROWS = [
  ...ROWS,
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
/** A workflow naming a session nobody ever created — seeded before the browser ever reads it (decision ⑧). */
const GHOST_SESSION_ID = 'server-sidebar-e2e-ghost-session'
const GHOST_WORKFLOW_ID = 'ghost-workflow'
/** This package's own settings namespace; a bare string literal, not an import (see the module doc above). */
const SERVER_SIDEBAR_NAMESPACE = 'server-sidebar' as SettingsNamespace

// A fresh session's composer still carries the hero placeholder
// (`placeholder.hero` in dsh-client-ui-conversation) until a message lands
// on it, then falls back to the established-session default. The composer is
// a contenteditable that carries its copy on `data-placeholder`, never as a
// real `placeholder` attribute, so no by-placeholder query reaches it (the
// same locator `command-image-envelope.expected.e2e.ts` uses).
/**
 * `dsh-client-ui-conversation`'s `placeholder.workspace`, rendered by the
 * inert composer while no Workspace is connected. Named here because a
 * scenario below pins it as the one leak this package cannot close.
 */
const LEAKED_PLACEHOLDER = 'Choose a workspace to start'

/**
 * The customer-facing name of the preset the overlay pins as `defaultPreset`,
 * and the only preset name a console renders: the composition offers no
 * permission switch at all (see the scenario below), so the hidden chip's
 * `aria-label` settles on this one and never moves. The overlay's whole
 * `permission` row — its three ids, their names, the `isolate` key, and the
 * pinned default — is owned by
 * `packages/experimental/server-sidebar/tests/customer-overlay.client.spec.ts`.
 */
const RENAMED_PRESET = '可修改文件'
/**
 * Every command the console's slash menu lists, in the order `commands.list`
 * sorts them. `permission` is absent by composition rather than by filtering:
 * the overlay isolates `commands` from the `permission-presets` row, so that
 * package's command child never activates. Pinning the whole set rather than
 * the one absence is what also fails on a command this composition gains.
 */
const CONSOLE_COMMANDS = [
  'compact',
  'content-navigated',
  'dismiss-content-entry',
  'feedback',
  'goal',
  'plan',
  'select-content-entry',
  'show-content-page',
] as const

const HERO_PLACEHOLDER = 'Describe what you want to build... / commands, @ files or sessions'
const ESTABLISHED_PLACEHOLDER = 'Message or run a task... / commands, @ files or sessions'

/**
 * The one composer carrying a given placeholder.
 * @param page - the browser page.
 * @param placeholder - exact `data-placeholder` copy.
 * @returns the composer locator.
 */
function composer(page: Page, placeholder: string): Locator {
  return page.locator(`[data-composer-input][data-placeholder="${placeholder}"]`)
}

/**
 * This deployment's local shape for the server-menu settings document —
 * apps/web cannot import the experimental package (see the module doc above).
 */
interface LocalNavStop {
  kind: 'page' | 'view'
  entryId: string
}
interface LocalWorkflow {
  id: string
  name: string
  order: number
  homeSessionId: string
  navSnapshot: LocalNavStop[]
  savedAt: number
}
interface LocalGroup {
  id: string
  name: string
  pinned: boolean
  order: number
}
interface LocalServerMenu {
  workflows: (LocalWorkflow & { groupId?: string })[]
  groups: LocalGroup[]
  workbenchSessionId?: string
}

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(rows: readonly (readonly [string, string])[] = ROWS): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-server-sidebar-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of rows) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

const sidebar = (page: Page): Locator => page.locator('[data-server-sidebar]')
const workbenchButton = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="workbench"]')
const navSection = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="nav"]')
const workflowsSection = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="workflows"]')
const activeFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')
const shellColumn = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)

/**
 * One element the de-terminology stylesheet hides: present in the DOM and
 * rendering nothing. Both halves matter — every rule in `terminology-guard.ts`
 * is a class-substring match against a CSS-module local name, so the way it
 * fails is the element ceasing to match, and a bare `isVisible() === false`
 * passes just as happily on an element that is not there at all.
 * @param scope - the region the element lives in.
 * @param className - CSS-module local-name substring the guard rule targets.
 */
async function expectGuardHides(scope: Locator, className: string): Promise<void> {
  const target = scope.locator(`[class*="${className}"]`)
  // Polled, not read once: `Locator.count()` does not retry, and a row that
  // reaches the browser over the remote-event stream a tick after whatever the
  // scenario waited on would read as zero and fail the presence half for a
  // timing reason rather than a guard reason.
  await expect.poll(
    () => target.count(),
    { timeout: 15_000, message: `${className}: no element for the guard rule to hide` },
  ).toBeGreaterThan(0)
  await expect.poll(() => target.first().isVisible(), { timeout: 15_000 }).toBe(false)
}

/**
 * One element the de-terminology stylesheet hides by attribute rather than by
 * class substring: present in the DOM, invisible, and invisible *because of a
 * `display: none` rule of this package's own*. The third half is what the
 * class-substring sibling above does not need: `ui-chat`'s compact transcript
 * already folds process rows behind `hidden="until-found"`, which reads as
 * invisible too, so a present-and-invisible pair alone would pass with every
 * rule in `terminology-guard.ts` deleted.
 * @param scope - the region the element lives in.
 * @param selector - the exact selector the guard rule couples on.
 */
async function expectGuardHidesSelector(scope: Locator, selector: string): Promise<void> {
  const target = scope.locator(selector)
  await expect.poll(
    () => target.count(),
    { timeout: 15_000, message: `${selector}: no element for the guard rule to hide` },
  ).toBeGreaterThan(0)
  await expect.poll(() => target.first().isVisible(), { timeout: 15_000 }).toBe(false)
  // Polled as well: this and the visibility read above are separate round
  // trips, so a re-render between them would otherwise throw instead of retry.
  await expect.poll(
    () => target.first().evaluate(el => getComputedStyle(el).display),
    { timeout: 15_000, message: `${selector}: not hidden by a display rule of this package's own` },
  ).toBe('none')
}

/** Every banned spelling of the vendor's Workspace vocabulary. */
const WORKSPACE_WORDS = ['workspace', 'Workspace', 'WORKSPACE', '工作区'] as const

/**
 * The composer's access-preset chip, located by the `aria-label` attribute
 * rather than by role: `terminology-guard.ts` hides the control in CSS, and a
 * role query resolves nothing for a `display: none` element. The attribute is
 * still the half that carries the preset name at either composer width — the
 * visible label collapses to the glyph alone once the row is narrow
 * (`PermissionSelect.module.css`'s own `@container (max-width: 460px)` query
 * inside the size container `InputBar.module.css` establishes).
 * @param page - the browsing page.
 * @returns the chip locator.
 */
function accessChip(page: Page): Locator {
  return shellColumn(page, 'chat').locator('[aria-label^="Access mode, current:"]')
}

/**
 * The banned words present in the conversation column's rendered text.
 * `innerText` is what a reader sees: it omits `display: none` subtrees (the
 * hero row `terminology-guard.ts` hides) and `hidden="until-found"` ones.
 * @param page - the browsing page.
 * @returns each banned word the column currently shows.
 */
async function workspaceWordsInChat(page: Page): Promise<string[]> {
  const text = await shellColumn(page, 'chat').innerText()
  return WORKSPACE_WORDS.filter(word => text.includes(word))
}

/** Where a passing scenario leaves its own screenshots — the gitignored repo convention `saveFailureShot` also writes to. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

/**
 * Save a screenshot of a state worth showing a reviewer. Evidence for the
 * composition, not a failure artifact.
 * @param page - the browsing page.
 * @param name - the artifact's file name, without extension.
 */
async function evidence(page: Page, name: string): Promise<void> {
  await mkdir(ARTIFACTS, { recursive: true })
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true })
}

/** One element's rendered width; `server-layout.e2e.ts`'s own helper, restated for this scenario's column checks. */
async function columnWidth(locator: Locator): Promise<number> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return rect.width
}

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
  return scaffold.ctx.agents.list().some(agent => agent.session.snapshotEvents().some((event: SessionEvent) => {
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
 * The given session's `show-content-page` command-lifecycle event types, in
 * log order (`command/run` → `content/shown` → `command/done`, one triple
 * per click). `command/run`/`command/done` come from `@deepseek-ai/dsh-commands`
 * (imported type-only above, so they narrow normally); `content/shown` still
 * needs the same widening `anySessionShowed` uses, since content-frame's own
 * `SessionEventMap` merge is not importable here.
 */
function commandTripleTypes(scaffold: WebScaffold, sessionId: string): string[] {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) return []
  return agent.session.snapshotEvents()
    .map((event: SessionEvent) => event.type as string)
    .filter(type => type === 'command/run' || type === 'content/shown' || type === 'command/done')
}

/**
 * The given session's `show-content-view` command-lifecycle event types, in
 * log order (`command/run` → `content-component/shown` → `command/done`, one
 * triple per click). The middle member needs the same widening
 * `anySessionShowed` uses: `content-component/shown` augments
 * `SessionEventMap` from component-surface, which apps/web cannot import.
 * @param scaffold - the live scaffold.
 * @param sessionId - the session to read.
 * @returns the event types, in log order.
 */
function viewCommandTripleTypes(scaffold: WebScaffold, sessionId: string): string[] {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) return []
  return agent.session.snapshotEvents()
    .map((event: SessionEvent) => event.type as string)
    .filter(type => type === 'command/run' || type === 'content-component/shown' || type === 'command/done')
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
        navSnapshot: [{ kind: 'page', entryId: 'reports' }],
        savedAt: Date.now(),
      }],
    })
    // Registered before the browser ever connects, so the client's initial
    // boot payload already carries it — no live-push race to synchronize
    // against. The sidebar's own auto-land and this scenario's explicit
    // workbench click both resolve through the same
    // `UiWorkspace.connectWorkspace` coalescing, so whichever gets there
    // first, the session left open is the same one either way.
    // The directory name carries the banned word deliberately: the hero chip
    // renders the Workspace title, so a guard rule that stopped matching would
    // put that exact string on screen and `workspaceWordsInChat` would see it.
    // Renaming this directory to something innocuous weakens that scan.
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
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
    // No fold/collapse rail control survives decision ①. Named exactly: this
    // shell's own group and temporary sections carry their own 收起/展开
    // carets, which are section folds, not the removed column rail.
    expect(await page.getByRole('button', { name: /collapse sidebar|Open the pages/i }).count()).toBe(0)

    // Scoped to this package's own chrome: decision ②'s banned-word list is
    // this package's obligation for its own copy, not a system-wide audit of
    // every shipped package's strings (content-column's empty-state copy is
    // pre-existing, out-of-scope text). The conversation column has its own
    // scan — `workspaceWordsInChat` below — which covers the hero, since
    // `ShellFrame` seats the whole `conversation` slot inside the chat column.
    const sidebarText = await sidebar(page).innerText()
    for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /会话/, /新会话/]) {
      expect(sidebarText, `banned text matched ${banned}`).not.toMatch(banned)
    }

    // Brand and hero facade: the sidebar's own fallback text (no build hash).
    await expect(sidebar(page).getByText('Workbench Assistant').isVisible()).resolves.toBe(true)
    expect(sidebarText).not.toContain('DSH Local Build')
    // The avatar identity and the settings seat merge into one row, name
    // first (left) and the settings seat last (right, space-between).
    const identityRow = sidebar(page).locator('[data-server-sidebar-section="identity"]')
    await identityRow.getByText('User').waitFor()
    const identityChildren = await identityRow.evaluate(el => el.children.length)
    expect(identityChildren).toBe(2)
    // The band fits what it renders: at this column width the settings seat
    // wraps onto its own line rather than squeezing the name to nothing or
    // clipping the sign-out label against the identity cluster's own
    // `overflow: hidden`.
    await expect(identityRow.getByRole('button', { name: 'Sign out' }).isVisible()).resolves.toBe(true)
    await expect(
      identityRow.locator('> :first-child').evaluate(el => el.scrollWidth <= el.clientWidth),
    ).resolves.toBe(true)
  }, 60_000)

  it('replaces the hero fish mark and headline with the sidebar\'s own brand copy, hides the preview badge and the live workspace row, and drops the agent-preset dropdown entirely', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-hero-facade'))
    const heroRoot = page.locator('[data-phase="hero"]')
    await heroRoot.waitFor({ timeout: 15_000 })

    const headlineText = heroRoot.locator('[class*="headlineText"]')
    await headlineText.waitFor()
    await expect(headlineText.evaluate(el => getComputedStyle(el).fontSize)).resolves.toBe('0px')
    // The CSS `::after` swap paints this package's own brand copy; the
    // headline's original DOM text node survives unchanged underneath it
    // (see the package README's Known Limitations for that residual gap).
    await expect(
      headlineText.evaluate(el => getComputedStyle(el, '::after').content),
    ).resolves.toContain('工作台小助手')

    await expectGuardHides(heroRoot, 'fishHitbox')
    await expectGuardHides(heroRoot, 'previewBadge')
    await expectGuardHides(heroRoot, 'heroWorkspaceRow')

    // ui-agent-preset is disabled outright (decision: not merely hidden by
    // the heroWorkspaceRow CSS rule above) — its hero chip, its read-only
    // session-header label, and its Settings row are all gone, not only the
    // one DOM position that rule happens to cover.
    expect(await page.getByTitle('Agent preset for the session you are about to start').count()).toBe(0)
    expect(await page.getByText('PTC mode').count()).toBe(0)
  }, 30_000)

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
      await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })

      // No homePage is configured in this overlay: a blank workbench draft
      // shows nothing in the content column, so the shell collapses it
      // (`dsh-experimental-server-layout`'s own content-empty read) and chat
      // absorbs the reclaimed share instead.
      await expect.poll(() => columnWidth(shellColumn(page, 'content')), { timeout: 10_000 }).toBe(0)

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
      await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
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
      expect(commandTripleTypes(scaffold, workbenchSessionId)).toEqual(['command/run', 'content/shown', 'command/done'])

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

      // The show-content-page command's chat echo is hidden
      // (`dsh-experimental-content-frame`'s empty `conversation.chat.commandview`
      // registration + hiding stylesheet): no "Now showing" row is ever
      // visible, though the durable command lifecycle (asserted above) still
      // lands on the log in full. The conversation stays in its hero phase
      // (no message flow rendered at all) until a real `user/message`
      // arrives, so this scenario waits for the message flow to actually
      // mount — the "Save as workflow" button's own appearance above already
      // proves that — before checking the command row is not among what it
      // rendered; checking any earlier would pass vacuously. The command's
      // own slot anchor (always rendered once its chat node mounts,
      // regardless of what — if anything — occupies the key; see
      // `scoped-slots.tsx`) confirms the render pipeline actually reached
      // this command row rather than never folding it at all.
      expect(await page.locator('[data-slot="conversation.chat.commandview"]').count()).toBeGreaterThan(0)
      expect(await page.getByText('Now showing', { exact: false }).count()).toBe(0)

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
      }).toMatchObject({ homeSessionId: workbenchSessionId, navSnapshot: [{ kind: 'page', entryId: 'home' }] })
    },
    90_000,
  )

  it(
    'produces a fresh conversation when the workbench is clicked again now that it carries a user message (clean-draft semantics)',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-blank-draft'))
      const priorWorkbenchSessionId = workbenchSessionId

      // The client's local blank bit for a session only ever lowers through
      // an accepted composer send or a fresh session-list read; the prior
      // test's `seedClosedTurn` appended `turn/start` straight onto the
      // durable log without going through either path. A reload forces
      // exactly that fresh read (the same host fold `sessionBlank` performs
      // for every attached Session), so the resident client learns the
      // workbench conversation is no longer blank before this test clicks
      // it. Load-time continuity (decision ①) reopens the same alive
      // session regardless of content, so the reload itself lands back on
      // it unchanged.
      const warningStart = tripwire.warnings.length
      await page.reload({ waitUntil: 'load' })
      acknowledgeReloadConnectionLoss(tripwire, warningStart)
      await sidebar(page).waitFor({ timeout: 15_000 })
      await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).toBe(priorWorkbenchSessionId)

      await workbenchButton(page).click()
      await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })

      // Load-time continuity reopens a non-blank session as-is; a click
      // instead lands on a brand-new one and repoints workbenchSessionId.
      await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBe(priorWorkbenchSessionId)
      workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!
      expect(scaffold.ctx.agents.get(SessionId(workbenchSessionId))).toBeDefined()

      // The displaced session is not deleted: its own agent is still live,
      // and "My Workflow" (saved against it above) still binds it.
      expect(scaffold.ctx.agents.get(SessionId(priorWorkbenchSessionId))).toBeDefined()
      expect(readServerMenu(scaffold).workflows.find(w => w.name === 'My Workflow')?.homeSessionId).toBe(priorWorkbenchSessionId)
    },
    60_000,
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

  it('highlights the current workflow row, and only that one row, once it is open', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-highlight'))
    const ghostRow = workflowsSection(page).getByRole('button', { name: /Ghost Workflow/ })
    await expect.poll(() => ghostRow.getAttribute('data-active'), { timeout: 10_000 }).toBe('true')
    expect(await sidebar(page).locator('[data-active="true"]').count()).toBe(1)
    // The workbench itself must not also light up while a workflow already
    // binds the current session (see the package README's Selection
    // highlight section).
    expect(await workbenchButton(page).getAttribute('data-active')).toBe('false')
  }, 30_000)

  it('switches back to "My Workflow" and returns to its own bound conversation', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-switch-back'))
    await workflowsSection(page).getByRole('button', { name: /My Workflow/ }).click()
    await expectShown(page, '/content-app/')
  }, 60_000)

  it('reorders workflows via drag-and-drop, persisting the new order', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-drag-reorder'))
    const before = readServerMenu(scaffold).workflows
    const ghostBefore = before.find(w => w.name === 'Ghost Workflow')!
    const mineBefore = before.find(w => w.name === 'My Workflow')!
    expect(ghostBefore.order).toBeLessThan(mineBefore.order)

    const ghostRow = workflowsSection(page).locator('li').filter({ hasText: 'Ghost Workflow' })
    const mineRow = workflowsSection(page).locator('li').filter({ hasText: 'My Workflow' })

    // Headless Chromium does not reliably synthesize a native `dragstart`
    // from simulated mouse movement (`locator.dragTo` included) for a custom
    // HTML5-draggable element — real Chromium (unlike jsdom) does implement
    // `DragEvent`/`DataTransfer` natively, so the robust replacement is
    // dispatching the real drag sequence directly inside the page with a
    // shared `DataTransfer`, exactly what a native drag delivers to the
    // page's own listeners.
    const source = await mineRow.elementHandle()
    const target = await ghostRow.elementHandle()
    if (source === null || target === null) throw new Error('drag-and-drop e2e: source or target row not found')
    // One shared DataTransfer, installed on `window` between round trips so
    // each dispatch is its own `page.evaluate` call: React 18 flushes a
    // discrete native event's state update synchronously within that event's
    // own dispatch, but only guarantees it is visible once dispatchEvent has
    // returned — batching every dispatch inside one evaluate call left later
    // dispatches reading state from before the earlier ones committed.
    await page.evaluate(() => { (window as unknown as { __dragTransfer: DataTransfer }).__dragTransfer = new DataTransfer() })
    const dispatchOn = async (el: typeof source, type: string, clientY: number): Promise<void> => {
      await page.evaluate(([targetEl, eventType, y]) => {
        const dataTransfer = (window as unknown as { __dragTransfer: DataTransfer }).__dragTransfer
        targetEl.dispatchEvent(new DragEvent(eventType, { bubbles: true, cancelable: true, dataTransfer, clientY: y }))
      }, [el, type, clientY] as const)
    }
    // Drop near the target row's own top edge: its top half, which inserts
    // the dragged row immediately before it (WorkflowGroup's own
    // `rowHalf`/`beforeIdFor`).
    const targetTop = (await target.boundingBox())!.y
    const sourceTop = (await source.boundingBox())!.y
    await dispatchOn(source, 'dragstart', sourceTop + 2)
    await dispatchOn(target, 'dragover', targetTop + 2)
    await dispatchOn(target, 'drop', targetTop + 2)
    await dispatchOn(source, 'dragend', targetTop + 2)

    await expect.poll(
      () => readServerMenu(scaffold).workflows.find(w => w.name === 'My Workflow')?.order,
      { timeout: 10_000 },
    ).toBe(0)
    expect(readServerMenu(scaffold).workflows.find(w => w.name === 'Ghost Workflow')?.order).toBe(1)
  }, 30_000)

  it('renders no Workspace vocabulary anywhere in the conversation column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-vocabulary'))
    // The chip's accessible name, not the column's rendered text: the visible
    // label collapses to a glyph at narrow composer widths, and which width
    // this scenario lands on depends on whether the content column is open.
    // The name is also the half a screen reader announces, so it is the half
    // that must not say "Workspace".
    const chipName = await accessChip(page).getAttribute('aria-label')
    expect(chipName).toBe(`Access mode, current: ${RENAMED_PRESET}`)
    // Two independent sources, pinned together because both are silent when
    // they break: the hero chip-and-picker row (hidden by
    // `terminology-guard.ts`'s class-substring rule, which a renamed CSS
    // module class would stop matching) and the access chip above, which
    // reverts to "Workspace Write" the moment the overlay's `permission` row
    // stops overriding the shipped preset table.
    expect(await workspaceWordsInChat(page)).toEqual([])
  }, 30_000)

  it('offers a customer no permission switch, on any of the three surfaces that carried one', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-no-permission-switch'))
    // Three surfaces, because closing any one of them leaves the other two:
    // the slash menu, the Settings → General default row, and the composer
    // chip. Each is closed by a different mechanism, so each is read here.
    const input = composer(page, ESTABLISHED_PLACEHOLDER)
    const menu = page.locator('[data-trigger-menu]')

    // A bare `/` filters nothing, so this is the whole rendered command set.
    await writeComposerDraft(page, input, '/')
    await menu.waitFor({ timeout: 10_000 })
    await expect.poll(
      () => menu.locator('[role="option"] [class*="itemName"]').allInnerTexts(),
      { timeout: 10_000 },
    ).toEqual([...CONSOLE_COMMANDS])

    // Narrow that same open menu to the command's own name rather than
    // retyping the draft: the assertion above leaves the row list non-empty,
    // so polling it to empty is a real wait for the query to land. Starting
    // from a cleared composer would sample an empty menu before the query was
    // reflected and pass without ever testing anything.
    //
    // Typing the name is the residue this composition accepts: with no
    // descriptor and no client contribution under it, the trigger has nothing
    // to offer and nothing to intercept Enter with, so the line goes to the
    // model as ordinary text (see the package README).
    await page.keyboard.type('permission')
    await expect.poll(
      () => menu.locator('[role="option"] [class*="itemName"]').allInnerTexts(),
      { timeout: 10_000 },
    ).toEqual([])
    await input.press('Escape')
    await expect.poll(() => menu.count(), { timeout: 10_000 }).toBe(0)
    await writeComposerDraft(page, input, '')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await dialog.getByRole('button', { name: 'General' }).getAttribute('aria-current')).toBe('true')
    // Both halves: the General panel is rendered — one of its shipped rows is
    // on screen — and it carries no permission default row. Absence alone
    // would pass on a panel that failed to render at all.
    await expect.poll(() => dialog.getByText('Appearance', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText('Permission', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    // The chip stays where it was: present, hidden by `terminology-guard.ts`,
    // and naming the preset the overlay pins, which nothing on this page can
    // change any more.
    await expectGuardHides(page.locator('[data-composer-card] [class*="modes"]'), 'trigger')
    expect(await accessChip(page).getAttribute('aria-label')).toBe(`Access mode, current: ${RENAMED_PRESET}`)
  }, 60_000)

  it('files a workflow under a group the visitor names, pins that group, and remembers the fold across a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-groups'))
    const section = workflowsSection(page)
    await section.getByRole('button', { name: 'New group' }).click()
    const nameField = section.getByRole('textbox')
    await nameField.fill('Reports')
    await nameField.press('Enter')
    await expect.poll(() => readServerMenu(scaffold).groups.map(g => g.name), { timeout: 10_000 }).toEqual(['Reports'])
    const groupId = readServerMenu(scaffold).groups[0]!.id

    // Move a row in through its own 移动到… menu rather than by dragging:
    // HTML5 drag-and-drop has no touch equivalent, so this is the path touch
    // has (see the package README).
    const ghostRow = section.locator('li').filter({ hasText: 'Ghost Workflow' })
    await ghostRow.hover()
    await ghostRow.getByRole('button', { name: 'Move to…' }).click()
    await page.getByRole('menuitem', { name: 'Reports' }).click()
    await expect.poll(
      () => readServerMenu(scaffold).workflows.find(w => w.name === 'Ghost Workflow')?.groupId,
      { timeout: 10_000 },
    ).toBe(groupId)
    // The other workflow stayed where it was: a move is not a re-file of the list.
    expect(readServerMenu(scaffold).workflows.find(w => w.name === 'My Workflow')?.groupId).toBeUndefined()

    // The row's controls are revealed by a hover on the row OR by the focus
    // being inside it, so focusing its own always-drawn name button brings
    // them up and the next Tab walks into them. That is as far as the
    // keyboard goes here — the list this trigger opens is portaled past every
    // other focusable element on the page, which the package README records
    // as a limitation rather than a path.
    await page.mouse.move(5, 5)
    await ghostRow.getByRole('button', { name: /Ghost Workflow/ }).focus()
    await expect(ghostRow.getByRole('button', { name: 'Move to…' }).isVisible()).resolves.toBe(true)
    await page.keyboard.press('Tab')
    await expect(page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
      .resolves.toBe('Move to…')

    const laneHead = section.locator('[class*="laneHead"]').filter({ hasText: 'Reports' })
    await laneHead.hover()
    await laneHead.getByRole('button', { name: 'Pin to top' }).click()
    await expect.poll(() => readServerMenu(scaffold).groups[0]?.pinned, { timeout: 10_000 }).toBe(true)
    await expect(laneHead.getByRole('img', { name: 'Pinned' }).isVisible()).resolves.toBe(true)
    // The pinned lane sorts ahead of the ungrouped rows it now precedes.
    const lanes = section.locator('[class*="lane"][data-pinned]')
    await expect(lanes.first().getAttribute('data-pinned')).resolves.toBe('true')
    await evidence(page, 'web-e2e-server-sidebar-group-pinned')

    await laneHead.getByRole('button', { name: 'Collapse' }).click()
    await expect.poll(() => ghostRow.count(), { timeout: 10_000 }).toBe(0)

    // The fold is a browser-local preference (`dsh.server-sidebar.view.v1`),
    // so it survives a reload without any write to the deployment's document.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await sidebar(page).waitFor({ timeout: 15_000 })
    await laneHead.waitFor({ timeout: 15_000 })
    expect(await section.locator('li').filter({ hasText: 'Ghost Workflow' }).count()).toBe(0)
    await expect(laneHead.getByRole('button', { name: 'Expand' }).isVisible()).resolves.toBe(true)
    await evidence(page, 'web-e2e-server-sidebar-group-folded')
  }, 90_000)

  it('lists a displaced draft under the temporary section and takes it off the list on a confirmed removal', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-temporary'))
    // Make the current workbench draft unreusable, then click the workbench:
    // clean-draft semantics mint a fresh conversation and leave this one with
    // no row of its own anywhere else in the shell, which is exactly what the
    // temporary section is for.
    const displaced = workbenchSessionId
    seedClosedTurn(scaffold, displaced)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await sidebar(page).waitFor({ timeout: 15_000 })
    await workbenchButton(page).click()
    // The click's own durable outcome first, the composer second. The sidebar's
    // load-time auto-open is still resolving when the shell mounts, so a click
    // landing beside it can leave the established composer on screen for a
    // moment; waiting on the hero placeholder before the repoint has been
    // observed makes that ordering the barrier, and it timed out here twice
    // under load. The repoint is the effect a click always has on a draft that
    // has run a turn (`openWorkbenchOnClick` takes the create path), so it is
    // the barrier that cannot arrive early.
    await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBe(displaced)
    await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
    workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!

    const temporary = sidebar(page).locator('[data-server-sidebar-section="temporary"]')
    await expect(temporary.getByText('Temporary workflows').isVisible()).resolves.toBe(true)
    await expect.poll(() => temporary.locator('li').count(), { timeout: 15_000 }).toBe(1)
    const row = temporary.locator('li').first()
    // The conversation's own durable title, plus how long ago it changed.
    // Nothing else: the session list's `displayTitle` falls back to the
    // Workspace directory's basename and then to the bare id — the first is
    // banned vocabulary, and the second is not something a banned-word check
    // can catch, so both are asserted absent below. (A conversation with no
    // durable title shows the section's fixed copy instead; that branch is
    // pinned by the package's own unit coverage.)
    await expect(row.getByText('Build the weekly report page.').isVisible()).resolves.toBe(true)
    await expect(row.getByText('Just now').isVisible()).resolves.toBe(true)
    const temporaryText = await temporary.innerText()
    for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /会话/, /新会话/]) {
      expect(temporaryText, `banned text matched ${banned}`).not.toMatch(banned)
    }
    expect(temporaryText).not.toContain('server-sidebar-workspace')
    expect(temporaryText).not.toContain(displaced)
    await evidence(page, 'web-e2e-server-sidebar-temporary')

    await row.hover()
    // A double click cannot archive by accident: the armed row opens 确定移出
    // to the left and puts 取消 exactly where the 移出列表 icon was, so the
    // second press of a double click disarms the row instead of committing it.
    await row.getByRole('button', { name: 'Remove from list' }).dblclick()
    await expect.poll(() => row.getByRole('button', { name: 'Confirm removal' }).count(), { timeout: 10_000 }).toBe(0)
    expect(await temporary.locator('li').count()).toBe(1)

    // Open it before taking it off the list, so the row being removed is the
    // conversation on screen — the case that decides where the shell rests
    // afterwards.
    await row.getByRole('button', { name: /Build the weekly report page/ }).click()
    await composer(page, ESTABLISHED_PLACEHOLDER).waitFor({ timeout: 15_000 })
    await expect(row.getByRole('button', { name: /Build the weekly report page/ }).getAttribute('data-active'))
      .resolves.toBe('true')

    await row.hover()
    await row.getByRole('button', { name: 'Remove from list' }).click()
    // One click arms, a second commits: archiving is one-way from inside this
    // console (see the package README's Known Limitations).
    await expect(row.getByRole('button', { name: 'Confirm removal' }).isVisible()).resolves.toBe(true)
    await evidence(page, 'web-e2e-server-sidebar-temporary-confirm')
    await row.getByRole('button', { name: 'Confirm removal' }).click()
    await expect.poll(() => temporary.locator('li').count(), { timeout: 15_000 }).toBe(0)
    await expect(temporary.getByText('Nothing temporary right now').isVisible()).resolves.toBe(true)
    // Archived, not deleted: the conversation's own agent is still live on the host.
    expect(scaffold.ctx.agents.get(SessionId(displaced))).toBeDefined()

    // The console rests on a conversation rather than on nothing: archiving
    // the open one clears the selection, and the sidebar's own load-time
    // landing is a one-shot, so the dismissal lands on 工作台 itself. The
    // recorded workbench conversation is still live, so it is reopened rather
    // than re-created.
    await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
    expect(await page.locator('[data-phase="inert"]').count()).toBe(0)
    await expect(workbenchButton(page).getAttribute('data-active')).resolves.toBe('true')
    expect(readServerMenu(scaffold).workbenchSessionId).toBe(workbenchSessionId)
    // The state a dismissal leaves behind is the one that used to read
    // "Choose a workspace to start", so the whole page is screened here, not
    // just this package's own column. `innerText` reports rendered text, so
    // this also screens what the terminology guard's stylesheet hides.
    const landedText = await page.locator('body').innerText()
    for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /会话/, /新会话/]) {
      expect(landedText, `banned text matched ${banned}`).not.toMatch(banned)
    }
    await evidence(page, 'web-e2e-server-sidebar-temporary-landed')

    // Leave the page on an established conversation, the state the remaining
    // assertions in this block read.
    await workflowsSection(page).getByRole('button', { name: /My Workflow/ }).click()
    await composer(page, ESTABLISHED_PLACEHOLDER).waitFor({ timeout: 15_000 })
  }, 120_000)

  it('leaves the Chat/Trajectory tab switcher and the model selector out of the customer-form composition', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-de-terminology'))
    expect(await page.getByRole('tab').count()).toBe(0)
    expect(await page.getByRole('button', { name: /^Select model, current/ }).count()).toBe(0)
    // The composer itself must not be stuck blocked now that no plugin
    // registers `useComposerBlock` (ui-model-selection is disabled).
    await expect(composer(page, ESTABLISHED_PLACEHOLDER).isEnabled()).resolves.toBe(true)
    // The permission-preset chip is `ui-conversation`'s own composer control
    // with no disable row: the terminology guard hides it in CSS, so it stays
    // in the DOM and visibility is what this screens. The established
    // conversation this block rests on is what makes the chip render at all.
    for (const chip of await page.getByText(RENAMED_PRESET).all()) {
      await expect(chip.isVisible()).resolves.toBe(false)
    }
    expect(await page.locator('[data-composer-card]').innerText()).not.toMatch(/workspace/i)
  }, 30_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

describe('web e2e: the product-console sidebar with a configured home page', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  /** The workbench's persistent session id, captured once the first test creates it. */
  let workbenchSessionId: string
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: HOMEPAGE_OVERLAY })
    // A workbench click resolves against a connected Workspace (see
    // `session-resolution.ts`); with none connected there is nowhere to
    // create the session into, and the click is a contained no-op.
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-homepage-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it(
    'auto-shows the configured home page on a blank workbench draft, with the content column no longer collapsed',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-homepage'))
      await workbenchButton(page).click()
      await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })

      await expectShown(page, '/content-app/')
      await expect.poll(() => anySessionShowed(scaffold, 'home', 'user'), { timeout: 15_000 }).toBe(true)
      // Contrast the un-configured overlay's own workbench test: with a home
      // page configured, a blank draft is never actually empty, so the
      // content column stays expanded rather than collapsing.
      await expect.poll(() => columnWidth(shellColumn(page, 'content')), { timeout: 10_000 }).toBeGreaterThan(0)

      await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBeUndefined()
      workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!
      expect(commandTripleTypes(scaffold, workbenchSessionId)).toEqual(['command/run', 'content/shown', 'command/done'])
    },
    60_000,
  )

  it(
    'reuses that same draft on a second click, showing the home page it already carries only once',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-homepage-reuse'))
      const agentsBefore = scaffold.ctx.agents.list().length
      await workbenchButton(page).click()
      await expectShown(page, '/content-app/')

      // The draft is clean by both halves of the judgment: it has run no
      // turn, and the one page its content column carries is the home page
      // the first click itself put there. So this click reuses it instead of
      // minting a second conversation, and skips the repeat
      // `show-content-page` rather than appending a second identical triple.
      await page.waitForTimeout(1000)
      expect(readServerMenu(scaffold).workbenchSessionId).toBe(workbenchSessionId)
      expect(scaffold.ctx.agents.list()).toHaveLength(agentsBefore)
      expect(commandTripleTypes(scaffold, workbenchSessionId)).toEqual(['command/run', 'content/shown', 'command/done'])
    },
    60_000,
  )

  it(
    'shows the home page again on the next click once the visitor has navigated the draft elsewhere',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-homepage-navigated'))
      const priorWorkbenchSessionId = workbenchSessionId
      await navSection(page).getByRole('button', { name: 'Weekly reports' }).click()
      await expectShown(page, '/content-app/reports/')

      // The draft has still run no turn, so the blank bit alone would have
      // called it reusable; the reports entry on its content column is what
      // makes it unclean, which sends this click down the create path and so
      // shows the home page again rather than skipping it as a repeat.
      await workbenchButton(page).click()
      await expectShown(page, '/content-app/')
      expect(commandTripleTypes(scaffold, priorWorkbenchSessionId)).toEqual([
        'command/run', 'content/shown', 'command/done',
        'command/run', 'content/shown', 'command/done',
        'command/run', 'content/shown', 'command/done',
      ])
      // ...but it lands on the same conversation all the same: the create
      // path resolves through `connectWorkspace`, which reuses any blank
      // session already in the Workspace, and this draft is one. See the
      // package README's Known Limitations for what a real displacement of a
      // blank draft would take.
      expect(readServerMenu(scaffold).workbenchSessionId).toBe(priorWorkbenchSessionId)
    },
    60_000,
  )

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
describe('web e2e: the product-console sidebar over both content catalogs', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  /** The workbench's persistent session id, captured once the first test creates it. */
  let workbenchSessionId: string
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks(VIEW_ROWS)
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: VIEWS_OVERLAY })
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-views-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it(
    'offers both catalogs in one menu — content-frame\'s pages first, then component-surface\'s views',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-views-menu'))
      // The merge is the whole point of this composition: two same-origin
      // routes read at mount, each contributing rows in its own declaration
      // order, pages ahead of views. A menu missing the last row is what a
      // drifted route path looks like, which is why the order is pinned
      // exactly rather than by presence.
      await expect.poll(
        async () => await navSection(page).getByRole('button').allTextContents(),
        { timeout: 20_000 },
      ).toEqual(['Home', 'Weekly reports', 'Site overview'])
      // Each row carries which catalog it came from, because the two are
      // opened by different commands.
      expect(await navSection(page).locator('[data-server-sidebar-nav-kind]').evaluateAll(
        rows => rows.map(row => row.getAttribute('data-server-sidebar-nav-kind')),
      )).toEqual(['page', 'page', 'view'])
    },
    60_000,
  )

  it(
    'puts the configured view in the content column on click, drawing both of its blocks in the layout order the spec declares',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-views-open'))
      await workbenchButton(page).click()
      await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
      await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBeUndefined()
      workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!

      await navSection(page).getByRole('button', { name: 'Site overview' }).click()

      const seat = page.locator('[data-content-surface-seat="component"]')
      const table = seat.locator('[data-component-block="toy.table"]')
      const record = seat.locator('[data-component-block="toy.record"]')
      await table.waitFor({ timeout: 20_000 })
      await expect.poll(
        async () => await table.locator('.el-table__body-wrapper tbody tr').count(),
        { timeout: 20_000 },
      ).toBe(2)
      // Nothing is ticked yet, so the `$from` binding the record block waits on
      // has produced nothing and the seat draws its waiting line in place of
      // the component. The node still holds its place in the stack rather than
      // the column closing over it, which is what the awaiting line being the
      // second child proves.
      expect(await record.count()).toBe(0)
      await seat.locator('[data-component-surface-awaiting="detail"]').waitFor({ timeout: 20_000 })

      // The click's own durable record: a command triple whose middle event is
      // this package's own, not content-frame's — the two nav kinds dispatch
      // to two different commands.
      await expect.poll(
        () => viewCommandTripleTypes(scaffold, workbenchSessionId),
        { timeout: 15_000 },
      ).toEqual(['command/run', 'content-component/shown', 'command/done'])
      await evidence(page, 'web-e2e-server-sidebar-views-open')
    },
    90_000,
  )

  it(
    'drives the detail block from the table\'s own selection, with no round trip through the host',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-views-binding'))
      const seat = page.locator('[data-content-surface-seat="component"]')
      const record = seat.locator('[data-component-block="toy.record"]')

      // element-ui draws the table body more than once, and the native input
      // inside each control is transparent and unclickable — so what is clicked
      // is the visible box a user clicks (component-surface.e2e.ts does the
      // same for its checkbox table).
      const radios = seat.locator('[data-component-block="toy.table"] .el-radio__inner:visible')
      await radios.nth(0).click()
      await expect.poll(
        async () => await record.locator('.form-item-content').allTextContents(),
        { timeout: 20_000 },
      ).toEqual(['North plant', 'Running'])

      // Picking the other row re-reads the binding rather than appending to it.
      await radios.nth(1).click()
      await expect.poll(
        async () => await record.locator('.form-item-content').allTextContents(),
        { timeout: 20_000 },
      ).toEqual(['South plant', 'Stopped'])
      await evidence(page, 'web-e2e-server-sidebar-views-binding')

      // Each tick is a recorded `select` gesture of the table's own — a
      // `command/run`/`command/done` pair carrying no content event. What the
      // binding does NOT do is place the view again: `content-component/shown`
      // is still the single one the navigation click wrote, so the detail
      // block is being fed on the seat rather than by a round trip that
      // re-appends the entry.
      expect(viewCommandTripleTypes(scaffold, workbenchSessionId))
        .toEqual([
          'command/run', 'content-component/shown', 'command/done',
          'command/run', 'command/done',
          'command/run', 'command/done',
        ])
    },
    90_000,
  )

  it(
    'captures the open view as a `view` stop when the conversation is saved as a workflow',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-views-workflow'))
      seedClosedTurn(scaffold, workbenchSessionId)
      await page.getByRole('button', { name: 'Save as workflow' }).click()
      const nameField = page.getByPlaceholder('Workflow name')
      await nameField.waitFor({ timeout: 10_000 })
      await nameField.fill('Site Flow')
      await nameField.press('Enter')

      await expect.poll(async () => await workflowsSection(page).getByRole('button', { name: /Site Flow/ }).isVisible(), {
        timeout: 10_000,
      }).toBe(true)

      // The stop carries the kind, which is what a replay needs to pick the
      // command to run — a snapshot of bare ids could not.
      await expect.poll(() => readServerMenu(scaffold).workflows.find(w => w.name === 'Site Flow'), {
        timeout: 10_000,
      }).toMatchObject({
        homeSessionId: workbenchSessionId,
        navSnapshot: [{ kind: 'view', entryId: 'site-overview' }],
      })
      await evidence(page, 'web-e2e-server-sidebar-views-workflow')
    },
    90_000,
  )

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

describe('web e2e: the product-console sidebar with no workspace connected', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    // Deliberately no `workspaceRegistry.create`: this is the fresh-install
    // state the other two describes set up past.
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('keeps the sidebar free of Workspace vocabulary with none connected', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-vocabulary-empty'))
    expect(WORKSPACE_WORDS.filter(word => LEAKED_PLACEHOLDER.includes(word))).not.toEqual([])
    expect(await sidebar(page).innerText()).not.toMatch(/workspace/iu)
  }, 30_000)

  it(
    'leaves the composer placeholder as the only Workspace word in the conversation column',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-vocabulary-empty-chat'))
      // With no Workspace there is no session to open, so `ConversationRoot`
      // renders its inert composer under `placeholder.workspace`. That string
      // belongs to `dsh-client-ui-conversation`'s own locale namespace, which
      // no other plugin may register into (the registry throws on a duplicate
      // namespace/locale pair), and it is not a preset name a composition can
      // rename — so this scenario pins the leak rather than asserting it away.
      // See the package README's Known Limitations.
      const composerBox = page.locator(`[data-composer-input][data-placeholder="${LEAKED_PLACEHOLDER}"]`)
      await composerBox.waitFor({ timeout: 15_000 })
      const remaining = await shellColumn(page, 'chat').innerText()
      // Everything except that one placeholder is already clean, so a new leak
      // anywhere else in the column turns this red.
      expect(remaining.replace(LEAKED_PLACEHOLDER, '')).not.toMatch(/workspace/iu)
      // The hero chip-and-picker row stays hidden in this state too: with no
      // Workspace its chip would read the placeholder label, not a title.
      await expect(page.locator('[class*="heroWorkspaceRow"]').isVisible()).resolves.toBe(false)

      // …and the guard's placeholder swap does NOT reach this state. The
      // element is the same one the console repaints as 说说要做什么 elsewhere,
      // but here it is the only thing telling the visitor the composer cannot
      // accept input, so painting an invitation over it would be a lie. The
      // rule excludes it through the composer input's own `data-phase="inert"`.
      const inertPlaceholder = shellColumn(page, 'chat').locator('[data-composer-placeholder]')
      await inertPlaceholder.waitFor({ timeout: 15_000 })
      await expect(inertPlaceholder.evaluate(el => getComputedStyle(el).fontSize)).resolves.not.toBe('0px')
      await expect(inertPlaceholder.evaluate(el => getComputedStyle(el, '::after').content)).resolves.toBe('none')
      await expect(inertPlaceholder.innerText()).resolves.toContain(LEAKED_PLACEHOLDER)
    },
    30_000,
  )

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

/** The system prompt the seeded request header carries; the 系统提示词 row's body. */
const SEEDED_SYSTEM_PROMPT = 'You are the console fixture assistant.'
/** The user's own line, kept on screen. */
const SEEDED_USER_LINE = 'Show me the weekly report page.'
/** The reasoning block's text, drawn by `ReasoningRow` and hidden by the guard. */
const SEEDED_THINKING = 'The reports page is the one to open.'
/** The turn's final answer, kept on screen. */
const SEEDED_ANSWER = 'The weekly report page is on the right.'
/** The file the seeded turn writes; the produced-files tail's one chip, kept on screen. */
const SEEDED_PRODUCED_FILE = 'weekly-report.md'
/** The injected runtime-context message's body; a `context` row, hidden by the guard. */
const SEEDED_CONTEXT = 'Runtime context: the reports page is published weekly.'

/**
 * Seed one closed turn carrying every process row the business-content
 * decision hides — a system prompt, an injected runtime-context message, a
 * scheduled provider retry, a reasoning block, a `content_read` tool call with
 * its result card, an intermediate step, and therefore a foldable
 * completed-turn row and a reply footer — plus a standalone command whose name
 * no `conversation.chat.commandview` claims, so `GenericCommandCard` actually
 * draws one. The context row is a `user/message` whose source is a plugin
 * rather than the user, which is exactly what `messageDefinition` classifies
 * as `context` instead of `user`. The turn also writes one file, so `dsh-client-ui-deliverables`
 * fills the reply footer's other child and the kept-tail half of the decision
 * has something to assert. Every row is a durable append with no model call,
 * the same technique {@link seedClosedTurn} uses.
 *
 * The answer lands in its own later step on purpose: `ChatNodeSeat`'s fold
 * window opens only when the turn's last step is a plain-text final answer, so
 * a single-step turn would produce no `turn-process` row to hide.
 * @param scaffold - the live scaffold.
 * @param sessionId - the session to seed onto; must have a live agent.
 */
function seedProcessTurn(scaffold: WebScaffold, sessionId: string): void {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`server-sidebar e2e: no live agent for ${sessionId}`)
  const session = agent.session
  const callId = ToolCallId('server-sidebar-business-read')
  const args = JSON.stringify({ mode: 'text' })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: SEEDED_USER_LINE }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('request/header', {
    header: {
      config: { provider: 'fixture', model: 'fixture' },
      system: SEEDED_SYSTEM_PROMPT,
    },
    reason: 'initial',
  })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: SEEDED_CONTEXT }],
    source: { kind: 'plugin', plugin: 'runtime-context' },
  }), { surfaceOp: 'append' })
  session.append('llm/retry', {
    retryId: brandString<RetryId>('server-sidebar-business-retry'),
    turn: 1,
    step: 1,
    provider: 'fixture',
    mode: 'normal',
    policyKey: 'fixture',
    retry: 1,
    maxRetries: 3,
    delayMs: 1_000,
    failure: { message: 'fixture transport failure', code: 'transport' },
  })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [
        { type: 'reasoning', text: SEEDED_THINKING },
        { type: 'tool-call', id: callId, name: 'content_read', arguments: args },
      ],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  const call = session.append('tool/call', {
    turn: 1, step: 1, callId, name: 'content_read', arguments: args,
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'heading: Weekly reports' }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
  const writeArgs = JSON.stringify({ file_path: SEEDED_PRODUCED_FILE, content: '# Weekly report\n' })
  const writeId = ToolCallId('server-sidebar-business-write')
  const write = session.append('tool/call', {
    turn: 1, step: 1, callId: writeId, name: 'write', arguments: writeArgs,
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: writeId,
      content: [{ type: 'text', text: `Created ${SEEDED_PRODUCED_FILE}` }],
      isError: false,
    }),
  }, { surfaceOp: 'append', sourceEventSeqs: [write.seq] })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('step/start', { turn: 1, step: 2 })
  session.append('assistant/message', {
    turn: 1,
    step: 2,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: SEEDED_ANSWER }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 2 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  const commandId = CommandId('server-sidebar-business-command')
  session.append('command/run', { commandId, name: 'feedback', source: { kind: 'user' } })
  session.append('command/done', { commandId, kind: 'success', text: 'Sent.' })
  // `dsh-client-ui-goal`'s own row for the `/goal` line, drawn beside the
  // generic command row the same event also produces.
  const goalId = CommandId('server-sidebar-business-goal')
  session.append('command/run', { commandId: goalId, name: 'goal', args: ' ship the weekly report', source: { kind: 'user' } })
  session.append('command/done', { commandId: goalId, kind: 'success', text: 'Goal set.' })
  // `dsh-client-ui-workflow-run`'s lifecycle card.
  const runId = WorkflowRunId('server-sidebar-business-run')
  session.append('tool-workflow/run-start', { runId, name: 'Weekly report' })
  session.append('tool-workflow/run-end', { runId, stopReason: 'completed' })
  // Both compaction rows. The `compaction` Definition needs only the
  // replacement checkpoint (`buildViewNode` returns null without one and
  // tolerates a missing `compaction/summary`); `manual-compaction` is the same
  // checkpoint correlated with a `/compact` run through `sourceCommandId`.
  // Each replacement shadows one throwaway context message of its own, since a
  // surface `replace` names a real surface-node range.
  const autoShadow = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'An earlier exchange, compacted automatically.' }],
    source: { kind: 'plugin', plugin: 'runtime-context' },
  }), { surfaceOp: 'append' })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Summary of the automatically compacted exchange.' }],
    source: compactCheckpointSource(brandString<CompactionId>('server-sidebar-business-auto')),
  }), { surfaceOp: { op: 'replace', start: autoShadow.seq, end: autoShadow.seq }, sourceEventSeqs: [autoShadow.seq] })
  const manualShadow = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'An earlier exchange, compacted on request.' }],
    source: { kind: 'plugin', plugin: 'runtime-context' },
  }), { surfaceOp: 'append' })
  const compactId = CommandId('server-sidebar-business-compact')
  session.append('command/run', { commandId: compactId, name: 'compact', source: { kind: 'user' } })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Summary of the requested compaction.' }],
    source: compactCheckpointSource(brandString<CompactionId>('server-sidebar-business-manual'), compactId),
  }), { surfaceOp: { op: 'replace', start: manualShadow.seq, end: manualShadow.seq }, sourceEventSeqs: [manualShadow.seq] })
}

/**
 * The composer's placeholder is present and paints this package's own copy.
 * The element is `aria-hidden` in `InputBar.tsx`, so reading its `::after` is
 * reading exactly what a sighted visitor sees; the sibling
 * `[data-composer-input]`'s own `data-placeholder` is deliberately untouched
 * (see the package README's Known Limitations), which is what keeps
 * {@link composer} resolving.
 * @param page - the browsing page.
 */
async function expectSwappedPlaceholder(page: Page): Promise<void> {
  const placeholder = shellColumn(page, 'chat').locator('[data-composer-placeholder]')
  await placeholder.waitFor({ timeout: 15_000 })
  await expect(placeholder.evaluate(el => getComputedStyle(el).fontSize)).resolves.toBe('0px')
  await expect(
    placeholder.evaluate(el => getComputedStyle(el, '::after').content),
  ).resolves.toContain('说说要做什么')
}

describe('web e2e: the console conversation column shows business content only', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  /** The workbench conversation this block seeds onto. */
  let sessionId: string
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    const workspaceDir = join(scaffold.workspaceCwd, 'server-sidebar-business-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('asks 说说要做什么 on a blank draft, with the upstream placeholder attribute left in place', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-business-hero'))
    await workbenchButton(page).click()
    await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
    await expect.poll(() => readServerMenu(scaffold).workbenchSessionId, { timeout: 15_000 }).not.toBeUndefined()
    sessionId = readServerMenu(scaffold).workbenchSessionId!
    await expectSwappedPlaceholder(page)
  }, 60_000)

  it(
    'hides the system prompt, the fold row, the tool call, the thinking row, the command row, and the reply footer\'s metrics, and keeps the question and the answer',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-business-rows'))
      seedProcessTurn(scaffold, sessionId)
      const chat = shellColumn(page, 'chat')
      // The answer is NOT the last thing the fixture appends: `turn/end` and
      // five more hidden rows (the feedback command, the `/goal` pair, the
      // workflow pair, and both compaction checkpoints) follow it, and each
      // reaches the browser over the remote-event stream on its own. So the
      // barrier is the last-seeded row, waited for as `attached` rather than
      // `visible` — the guard hides it, which is the point. The answer is
      // waited for too, since it is the one row this scenario asserts is
      // visible and it must be on screen before that is read.
      await chat.getByText(SEEDED_ANSWER).waitFor({ timeout: 15_000 })
      await chat.locator('[data-chat-flow-kind="manual-compaction"]')
        .first().waitFor({ state: 'attached', timeout: 15_000 })

      // Kept: the visitor's own line and the model's answer.
      await expect(chat.getByText(SEEDED_USER_LINE).isVisible()).resolves.toBe(true)
      await expect(chat.getByText(SEEDED_ANSWER).isVisible()).resolves.toBe(true)

      // Every hidden kind this composition can produce from the log alone.
      // `unknown` is the one it cannot: `isAppendSurfaceEvent` admits only
      // `user/message`, `assistant/message` and `tool/result`, and ui-chat
      // registers a Definition that matches all three unconditionally, so the
      // fallback never fires here. It is pinned in the package's unit spec.
      const hiddenKinds = [
        'system-prompt', 'turn-process', 'tool-call', 'command', 'context',
        'model-retry', 'command-input', 'workflow-run', 'compaction', 'manual-compaction',
      ]
      for (const kind of hiddenKinds) {
        await expectGuardHidesSelector(chat, `[data-chat-flow-kind="${kind}"]`)
      }
      await expectGuardHidesSelector(chat, '[data-variant="think"]')
      // The `content_read` call by name, located inside the seat the rule
      // hides rather than by a rule of its own: the read goes with whatever
      // draws in that seat — `ToolRow`'s generic card here, and
      // content-frame's own `ContentReadRow` in a deployment that configures
      // `pageAccess` (this overlay configures none, so that keyed
      // `tool.call.toolview` entry never registers). It is hidden on purpose:
      // the content column already shows the page the row would describe.
      const readRow = chat.locator('[data-chat-flow-kind="tool-call"] [data-tool="content_read"]')
      await expect.poll(
        () => readRow.count(),
        { timeout: 15_000, message: 'the seeded content_read call rendered no row' },
      ).toBeGreaterThan(0)
      await expect.poll(() => readRow.first().isVisible(), { timeout: 15_000 }).toBe(false)
      // The reply footer loses its two metric pills — 用量 and 用时, neither of
      // which carries a handle of its own — and keeps every other control in
      // that row. Both halves are read: a rule that drifted wider would still
      // satisfy the "pills are gone" half on its own.
      await expectGuardHidesSelector(chat, '[data-turn-tail] :has(> [class*="trigger"])')
      const actions = chat.locator('[data-turn-tail] [class*="actions"]').first()
      await expect(actions.isVisible()).resolves.toBe(true)
      await expect(actions.getByRole('button', { name: 'Copy' }).isVisible()).resolves.toBe(true)
      await expect(actions.getByRole('button', { name: 'Branch into a new conversation' }).isVisible())
        .resolves.toBe(true)
      await expect(chat.locator('[data-turn-tail] [class*="timeEnd"]').first().isVisible()).resolves.toBe(true)
      const produced = chat.locator('[data-turn-tail] [data-produced-files-row]')
      await expect(produced.first().isVisible()).resolves.toBe(true)
      await expect(produced.getByRole('button', { name: new RegExp(SEEDED_PRODUCED_FILE) }).isVisible())
        .resolves.toBe(true)

      // The established composer still resolves by its upstream attribute and
      // still paints this package's copy.
      await expect(composer(page, ESTABLISHED_PLACEHOLDER).count()).resolves.toBe(1)
      await expectSwappedPlaceholder(page)
      await evidence(page, 'web-e2e-server-sidebar-business-rows')
    },
    90_000,
  )

  it('leaves an approval card on screen, out of reach of every flow-row rule', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-business-approval'))
    const agent = scaffold.ctx.agents.get(SessionId(sessionId))
    if (agent === undefined) throw new Error('server-sidebar e2e: the seeded agent is gone')
    // `ApprovalService.request` requires an open turn (its audit pair must be
    // turn-enclosed), and this composition never runs a model, so the turn is
    // opened and closed around the ask.
    agent.session.append('turn/start', { turn: 2 })
    const decision = scaffold.ctx.approval.request({
      agent,
      toolName: 'bash',
      reason: 'The console fixture asks for one decision.',
    })
    const panel = shellColumn(page, 'chat').locator('[data-approval-key]')
    await panel.waitFor({ timeout: 30_000 })
    // `dsh-client-ui-approval` registers into `conversation.composer`, so the
    // card takes the composer over and is never a `ChatNodeSeat` child at all:
    // no `data-chat-flow-kind` rule can reach it.
    expect(await panel.locator('[data-chat-flow-kind]').count()).toBe(0)
    await expect(panel.isVisible()).resolves.toBe(true)
    await evidence(page, 'web-e2e-server-sidebar-business-approval')
    await panel.getByRole('button', { name: 'Allow once' }).click()
    await expect(decision).resolves.toBe('allowed-once')
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await expect.poll(() => panel.count(), { timeout: 15_000 }).toBe(0)
  }, 60_000)

  it('keeps the running indicator visible, re-texted and off the vendor gradient', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-business-running'))
    // The running bit is a Host push tied to real Agent execution
    // (`api-session/status`, emitted from `agent/status`), and this scenario
    // issues no model call — so the push itself is what this test produces,
    // through the same declared remote event the Host would send. Everything
    // downstream of it is the real component and the real stylesheet.
    scaffold.ctx.emit('api-session/status', SessionId(sessionId), true)
    const indicator = shellColumn(page, 'chat').locator('[data-chat-flow] > [class*="turnStatus"]')
    await indicator.waitFor({ timeout: 15_000 })
    await expect(indicator.isVisible()).resolves.toBe(true)
    await expect(indicator.evaluate(el => getComputedStyle(el).fontSize)).resolves.toBe('0px')
    await expect(
      indicator.evaluate(el => getComputedStyle(el, '::after').content),
    ).resolves.toContain('正在处理')
    // The vendor's Chinese brand name is what the upstream copy says, and the
    // shimmer that paints it is a DeepSeek-token gradient clipped to the text;
    // both halves are asserted gone, since dropping only one still ships the
    // branding.
    await expect(indicator.evaluate(el => getComputedStyle(el).backgroundImage)).resolves.toBe('none')
    await expect(
      indicator.evaluate(el => getComputedStyle(el).webkitTextFillColor),
    ).resolves.not.toBe('rgba(0, 0, 0, 0)')
    await evidence(page, 'web-e2e-server-sidebar-business-running')
    scaffold.ctx.emit('api-session/status', SessionId(sessionId), false)
    await expect.poll(() => indicator.count(), { timeout: 15_000 }).toBe(0)
  }, 60_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
