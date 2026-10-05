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
 * the session header's own title for a conversation with no durable title,
 * the Settings entries the console withholds (`ui-chat`'s busy-compaction row,
 * the vendored `@haoran/dsh-auto-compact` row, and the Settings header's
 * configuration-file action) while both console presets reach the compaction
 * engine the plugin drives, the keyboard shortcuts the shortcut reference
 * leaves out and whose keys do nothing in a real browser,
 * the Host administration Remote methods the console bundle disables, which
 * answer 404 to a request the login cookie admits while the console's own
 * Remote calls answer,
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
 * see the package README's Known Limitations). The describe with no
 * workspace connected also checks that the console serves
 * `@deepseek-ai/dsh-experimental-page-refresh` in place of `client-hmr`, and
 * that a second page whose connection the test refuses draws the
 * connection-loss notice in `server-layout`'s overlay layer, clear of the
 * composer.
 *
 * The last describe block owns the `console-auto-compact` Web snapshot: it
 * replays an authored conversation through the same composition and checks
 * that automatic compaction runs at the bundle's 60% inside both console
 * presets, and not below it.
 *
 * Every other describe makes zero model calls, the same shape
 * `rail-search-expand.e2e.ts` uses for a pure client-layout scenario: every
 * session those describes open is created live through the UI with no message
 * ever typed into the composer.
 * The one exception is the "Save as workflow" and de-terminology scenario,
 * which needs a real user-authored message on the log to satisfy decision
 * ③'s visibility gate and a real closed step to satisfy the turns/steps row's
 * render condition — both seeded directly onto the live agent's session
 * (`agent.session.append(..., { surfaceOp: 'append' })`, the same technique
 * `seeded-history.e2e.ts` uses to inject a durable message without a model
 * call) rather than driven through the composer.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the
 * identifiers and event payloads read from one are restated here, and the
 * profile links the Loader resolves the rows through are created by
 * `console-launch.ts`, which installs the console the way a deployment
 * installs it: the `dsh-experimental-console-profile` bundle and a generated
 * deployment layer, both enabled after the shipped Web bundles.
 */

import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page, WebSocketRoute } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFailed, onTestFinished } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage, type StreamChunk, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
// Type-only: the `compaction` and `compactionPolicy` Context merges.
import type {} from '@deepseek-ai/dsh-compaction-basic'
import {
  CONSOLE_ROWS, harnessHomeWithRowLinks, launchConsole, type ConsoleReplayOptions,
} from './console-launch.ts'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

/** The deployment layer installed beside the console bundle: the content column's page catalog. */
const OVERLAY = fileURLToPath(new URL('./server-sidebar.overlay.yml', import.meta.url))
/** Identical to {@link OVERLAY}, plus content-frame's `homePage` config. */
const HOMEPAGE_OVERLAY = fileURLToPath(new URL('./server-sidebar-homepage.overlay.yml', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
/**
 * Identical to {@link OVERLAY}, plus the component rows and one configured
 * view — the one composition here where both catalogs exist to be merged.
 */
const VIEWS_OVERLAY = fileURLToPath(new URL('./server-sidebar-views.overlay.yml', import.meta.url))
/** {@link CONSOLE_ROWS} plus the three rows {@link VIEWS_OVERLAY} adds. */
const VIEW_ROWS = [
  ...CONSOLE_ROWS,
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const
/** The hosted application this scenario serves; the deployment layer reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
/** A workflow naming a session nobody ever created — seeded before the browser ever reads it (decision ⑧). */
const GHOST_SESSION_ID = 'server-sidebar-e2e-ghost-session'
const GHOST_WORKFLOW_ID = 'ghost-workflow'
/**
 * The server-sidebar row's profile entry id, which the settings service
 * addresses; a bare string literal, not an import (see the module doc above).
 */
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
 * The customer-facing name of the preset the console bundle pins as
 * `defaultPreset`. The composition offers no permission switch and no chip
 * (see the scenario below), so no visible control may carry it. The bundle's
 * whole `permission` row — its three ids, their names, the `isolate` key, and
 * the pinned default — is owned by
 * `packages/experimental/console-profile/tests/profile.spec.ts`.
 */
const RENAMED_PRESET = '可修改文件'
/**
 * Every row the console's slash menu renders, by the text it shows (a
 * command's label where the menu has one, else its name), in menu order. `permission` is absent by composition rather than by filtering:
 * the console bundle isolates `commands` from the `permission-presets` row, so that
 * package's command child never activates. `Goal` and `Plan` are absent too:
 * they belong to the shipped presets' `command-goal` and `plan-mode` rows,
 * which the `console` Agent preset does not mount, and so is `Compact`, whose
 * `command-compact` row its compaction group leaves out. Pinning the whole set rather
 * than the one absence is what also fails on a command this composition gains.
 */
const CONSOLE_COMMANDS = [
  'File',
  'Feedback',
  'content-navigated',
  'dismiss-content-entry',
  'select-content-entry',
  'show-content-page',
] as const

const HERO_PLACEHOLDER = 'Describe what you want to build, / commands, @ files or sessions'
const ESTABLISHED_PLACEHOLDER = 'Message or run a task, / commands, @ files or sessions'

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
 * Every tool a session under the console's `console` Agent preset is offered
 * in this composition, sorted: the preset's own (`read`, `write`, `edit`,
 * `read_image`, `skill`, `ask_user_question`, `todo_write`) and the host
 * plane's `content_show`.
 */
const CONSOLE_TOOLS = [
  'ask_user_question', 'content_show', 'edit', 'read', 'read_image', 'skill', 'todo_write', 'write',
]

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

/** One Remote unary's RPC result. */
interface RemoteResult {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/** What the Host answered to one Remote unary: the HTTP status, and the result when the API Gateway claimed the endpoint. */
interface RemoteAnswer {
  status: number
  result?: RemoteResult
}

/**
 * Send one Typert Remote unary the way the page's own client does: a
 * `client-request` envelope POSTed to `/api/<namespace>/<method>` with the
 * scaffold's login cookie, which admits it as the Host's operator.
 * @param scaffold - the launched console.
 * @param endpoint - `<namespace>/<method>`.
 * @param args - the method's arguments, by parameter name.
 * @returns the HTTP status, with the RPC result when the status is 200.
 */
async function remoteCall(scaffold: WebScaffold, endpoint: string, args: Readonly<Record<string, unknown>>): Promise<RemoteAnswer> {
  const response = await scaffold.hostFetch(`/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request', rpcId: `server-sidebar-${endpoint}-${randomUUID()}`, method: endpoint, payload: { args },
    }),
  })
  if (response.status !== 200) return { status: response.status }
  return { status: 200, result: (await response.json() as { result: RemoteResult }).result }
}

/**
 * Remote methods of the Host administration services the console bundle
 * disables, each with arguments of the kind its method takes. No Gateway claim
 * covers them, so each answers 404 to an admitted visitor. The read-only
 * listing call comes first: a composition that still serves the plugin manager
 * fails on a call that changes nothing.
 */
const CLOSED_ENDPOINTS: readonly (readonly [string, Readonly<Record<string, unknown>>])[] = [
  ['pluginManager/listBundles', {}],
  ['pluginManager/setBundleEnabled', { name: '@deepseek-ai/dsh-experimental-inspector-profile', enabled: true }],
  ['pluginManager/installBundle', { spec: '@deepseek-ai/dsh-experimental-inspector-profile' }],
  ['pluginInventory/list', {}],
  ['pluginRegistryProbe/fastest', {}],
  ['dynamicCordisRunner/runHostHalf', {
    agent: 'server-sidebar-closed', pluginId: 'probe', packageId: 'probe', mode: 'once', requestId: null, approveFutureVersions: false,
  }],
  ['terminal/create', { agent: 'server-sidebar-closed', request: { id: 'server-sidebar-terminal', cols: 80, rows: 24 } }],
  ['officeToPdf/render', { workspaceFileScope: { sessionId: 'server-sidebar-closed' }, path: '/etc/hosts.docx', priority: 'visible' }],
  // Goals: arming a goal and continuing one both answer the admitted visitor
  // when `goal` and `goal-round-driver` are composed; the console disables
  // them, so no visitor spends the Host's key on model turns until a round cap.
  ['goals/create', { agent: 'server-sidebar-closed', request: { objective: 'probe the closed goal surface' } }],
  ['goals/resume', { agent: 'server-sidebar-closed', request: {} }],
]

/** Read the server-sidebar row's live menu fields straight from the host, bypassing the HTTP route entirely. */
function readServerMenu(scaffold: WebScaffold): LocalServerMenu {
  return scaffold.ctx.settings.describe().find(form => form.ns === SERVER_SIDEBAR_NAMESPACE)?.value as LocalServerMenu
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
 * visibility gate. With `usage`, the step reports token accounting, so the
 * composer's statistics row draws its cache-hit reading even under Compact
 * (`StatsPills.tsx`'s `UsagePill`) — needed where the de-terminology
 * assertion proves the CSS guard hides a row that would otherwise render, not
 * merely that nothing rendered anyway.
 * @param scaffold - the live scaffold.
 * @param sessionId - the session to seed onto; must have a live agent.
 * @param usage - the step's token accounting; omitted, the step reports none.
 */
function seedClosedTurn(scaffold: WebScaffold, sessionId: string, usage?: TokenUsage): void {
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
    stream: [],
    ...usage === undefined ? {} : { usage },
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/**
 * Close one turn on a session with no user prompt in it: the turn makes the
 * session non-blank, and with no prompt the title service derives no title.
 * @param scaffold - the running scaffold.
 * @param sessionId - the session to append to.
 */
function seedUntitledTurn(scaffold: WebScaffold, sessionId: string): void {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`server-sidebar e2e: no live agent for ${sessionId}`)
  agent.session.append('turn/start', { turn: 1 })
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Ready.' }],
      source: { kind: 'model', provider: 'fixture', model: 'fixture' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
  agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** The release version the client build embeds, which Settings → General shows. */
const { version: CLIENT_VERSION } = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8')) as { version: string }

/**
 * The English titles of the Settings → General rows `server-sidebar` withholds
 * on the console (`settings-entries.ts`), in that module's order.
 */
const WITHHELD_GENERAL_TITLES = [
  'Compaction while busy', 'Automatic compaction', 'Language', 'Appearance', 'Font size', 'Work details',
  'Performance & usage', 'Open chat links in', 'Send behavior while busy', 'Show coding view',
] as const

/**
 * The English labels `dsh-client-ui-workspace` and `dsh-client-ui-sidebar-files`
 * give the seven keyboard shortcuts `server-sidebar` withholds on the console
 * (`console-shortcuts.ts`).
 */
const WITHHELD_SHORTCUT_LABELS = [
  'New Session', 'Search sessions', 'Add workspace', 'Rename session', 'Fork session', 'Archive session', 'Workspace files',
] as const

/**
 * Each withheld command's Web default on this device, as Playwright names the
 * keys: `primary` is Meta on macOS and Control on Windows. A Linux browser
 * has no Web default for any of them, so it has no key to press.
 */
const WITHHELD_SHORTCUT_KEYS = process.platform === 'darwin' || process.platform === 'win32'
  ? (() => {
    const primary = process.platform === 'darwin' ? 'Meta' : 'Control'
    return {
      new: `${primary}+Alt+KeyN`, search: `${primary}+Alt+KeyK`, add: `${primary}+Alt+KeyO`, rename: `${primary}+Alt+KeyG`,
      fork: `${primary}+Shift+KeyF`, archive: `${primary}+Alt+KeyA`, files: `${primary}+Alt+KeyP`, reference: `${primary}+Slash`,
    }
  })()
  : undefined

/**
 * One settings write per namespace the console's lock holds, each to a valid
 * value other than the lock's.
 */
const LOCKED_WRITES = [
  ['bash-sandbox', { timeoutMs: 30_000 }],
  ['agent-loop', { maxParallelToolCalls: 11 }],
  ['subagent', { maxDepth: 2 }],
  ['subagent-model-selection-settings', { enabled: true }],
  ['auto-compact', { thresholdPercent: 61 }],
  ['locale', { preference: 'en' }],
  ['ui-theme', { preference: 'dark' }],
  ['ui-chat', { performanceUsage: 'detailed' }],
  ['ui-conversation', { busyEnter: 'steer' }],
  ['ui-settings', { enabled: true }],
] as const

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
    // The deployment layer's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchConsole(harnessHome, OVERLAY)
    // Seed one ghost workflow before the browser ever loads: the live menu
    // fields of the server-sidebar row this composition just loaded. Its `homeSessionId` names a session that
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
    // The band is one row and fits what it renders: the settings seat draws
    // its compact icon form, which is what leaves the identity cluster the
    // width to render the name and the sign-out label without clipping them
    // against its own `overflow: hidden`.
    await expect(identityRow.getByRole('button', { name: 'Sign out' }).isVisible()).resolves.toBe(true)
    await expect(
      identityRow.locator('> :first-child').evaluate(el => el.scrollWidth <= el.clientWidth),
    ).resolves.toBe(true)
    await expect(identityRow.evaluate((el) => {
      const [identity, settings] = [...el.children]
      if (identity === undefined || settings === undefined) return false
      const left = identity.getBoundingClientRect()
      const right = settings.getBoundingClientRect()
      // Same line: `align-items: center` puts both boxes on one vertical centre.
      return Math.abs((left.top + left.bottom) / 2 - (right.top + right.bottom) / 2) < 1
    })).resolves.toBe(true)
  }, 60_000)

  it('replaces the hero fish mark and headline with the sidebar\'s own brand copy, hides the preview badge and the live workspace row, and drops the agent-preset dropdown entirely', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-hero-facade'))
    const heroRoot = page.locator('[data-phase="hero"]')
    await heroRoot.waitFor({ timeout: 15_000 })

    const headlineText = heroRoot.locator('[class*="titleGroup"] > :first-child')
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

      // No homePage is configured in this deployment layer: a blank workbench draft
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

      seedClosedTurn(scaffold, workbenchSessionId, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 })
      await page.getByRole('button', { name: 'Save as workflow' }).waitFor({ timeout: 15_000 })

      // De-terminology, twice over. The lock holds Performance & usage at
      // Compact, under which the composer's statistics row never draws the
      // turns/steps counts ("1 turns 1 steps", `StatsPills.tsx`), even now
      // that a closed step is on the log. The row Compact still draws, the
      // cache-hit reading the seeded usage produces, is in the DOM and not
      // visible: the CSS guard hides that row itself, and a node inserted
      // between the composer card and the row would leave it visible.
      // `textContent` reads the hidden row, which `innerText` does not.
      expect(await page.getByText('1 turns 1 steps').count()).toBe(0)
      const usageReading = page.locator('[data-composer-stat="usage"]')
      await expect.poll(() => usageReading.count(), { timeout: 15_000 }).toBe(1)
      expect(await usageReading.textContent()).toContain('Cache hit')
      await expect(usageReading.isVisible()).resolves.toBe(false)

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
    // The access chip is `dsh-client-ui-permission-presets`' registration in
    // `conversation.input.permission`, and this composition disables that row,
    // so the composer carries no chip whose name could say "Workspace".
    expect(await accessChip(page).count()).toBe(0)
    // The hero chip-and-picker row is hidden by `terminology-guard.ts`'s
    // class-substring rule, which a renamed CSS module class would stop
    // matching without any other signal.
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
    await expect.poll(() => dialog.getByText('Keyboard shortcuts', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText('Permission', { exact: true }).count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    // The composer chip is the disabled `ui-permission` row's registration, so
    // it is absent rather than hidden.
    expect(await accessChip(page).count()).toBe(0)
  }, 60_000)

  it('draws a Settings dialog with the General section only, the configuration-file action withheld, and the close button at the right', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-settings-dialog'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    await dialog.waitFor({ timeout: 10_000 })
    // Settings → Plugins is gone with its two disabled rows, and no settings
    // form is drawn for `console-mcp`: its server list is not volatile.
    await expect.poll(() => dialog.locator('nav').innerText(), { timeout: 10_000 })
      .toBe('Settings\nGeneral\nGeneral settings')
    // The General panel is drawn, and the disabled `ui-settings-session-log`
    // row leaves no upload switch in it.
    await expect.poll(() => dialog.getByText('Keyboard shortcuts', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    expect(await dialog.getByText(/Session Log/).count()).toBe(0)
    const header = await dialog.evaluate((panel) => {
      const row = panel.querySelector('[class$="_header"]')
      const actions = row?.querySelector(':scope > [class$="_actions"]')
      const close = row?.querySelector(':scope > button')
      const right = (element: Element | null | undefined): number | undefined => element?.getBoundingClientRect().right
      return {
        actionText: actions?.textContent,
        actionControls: actions?.querySelectorAll('button, a, [role="button"]').length,
        headerRight: right(row),
        closeRight: right(close),
        actionsRight: right(actions),
      }
    })
    // `settings-entries.ts` shadows the configuration-file action, so it never
    // mounts; the empty action row stays in the layout, which is what keeps
    // the close button at the header's right edge.
    expect(header.actionText).toBe('')
    expect(header.actionControls).toBe(0)
    expect(await dialog.getByText('Open configuration file').count()).toBe(0)
    expect(header.closeRight).toBeDefined()
    expect(header.actionsRight).toBeDefined()
    expect(header.closeRight!).toBeGreaterThan(header.actionsRight!)
    expect(header.headerRight! - header.closeRight!).toBeLessThanOrEqual(16)
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)
  }, 30_000)

  it('withholds every Settings → General row but the keyboard shortcuts and the version, while each locked row keeps its config', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-withheld-rows'))
    // The vendored plugin's browser half ran: it installs its stylesheet
    // before it registers its row, so a missing row below is the shadow, not
    // a client bundle that never loaded.
    expect(await page.locator('style[data-dsh-auto-compact]').count()).toBe(1)
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings' })
    // A failed check below would otherwise leave the dialog over the next test.
    onTestFinished(async () => {
      if (await dialog.count() > 0) await page.keyboard.press('Escape')
    })
    await dialog.waitFor({ timeout: 10_000 })
    // Both halves: the General panel is drawn — the one row it keeps with a
    // control is on screen — and no withheld row is. The panel draws exactly
    // two rows, the keyboard shortcuts and the current version, so a row a
    // later release adds to Settings → General turns this red as well: the
    // list's `display: contents` wrapper holds one element per drawn row, and
    // a withheld cell draws none. The row count and the withheld titles are
    // checked before the version row is awaited, so a row that leaks fails on
    // its own check.
    await expect.poll(() => dialog.getByText('Keyboard shortcuts', { exact: true }).count(), { timeout: 10_000 }).toBe(1)
    await expect.poll(() => dialog.locator('[data-slot="settings.general.item"] > *').count(), { timeout: 10_000 }).toBe(2)
    for (const title of WITHHELD_GENERAL_TITLES) {
      expect({ title, count: await dialog.getByText(title, { exact: true }).count() }).toEqual({ title, count: 0 })
    }
    await dialog.getByText(`Current version: ${CLIENT_VERSION}`, { exact: true }).waitFor({ timeout: 10_000 })
    expect(await dialog.locator('input[type="range"]').count()).toBe(0)
    expect(await dialog.getByRole('switch').count()).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => dialog.count(), { timeout: 10_000 }).toBe(0)

    // The rows are withheld, not their packages: the vendored plugin is
    // mounted at the lock's 60%, and every locked namespace answers the
    // lock's config.
    const row = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'auto-compact')
    expect(row?.options).toMatchObject({
      name: '@haoran/dsh-auto-compact',
      config: { enabled: true, thresholdPercent: 60 },
    })
    // Rethrows the activation error of a row that failed to load.
    await row?.fiber?.await()
    const forms = scaffold.ctx.settings.describe()
    expect(forms.find(form => form.ns === 'auto-compact')?.value).toEqual({ enabled: true, thresholdPercent: 60 })
    expect(forms.find(form => form.ns === 'ui-chat')?.value)
      .toMatchObject({ performanceUsage: 'compact', linkOpening: 'sidebar', busyCompaction: 'turn-end' })
    expect(forms.find(form => form.ns === 'ui-theme')?.value).toMatchObject({ preference: 'system', fontSize: 14 })
    expect(forms.find(form => form.ns === 'ui-conversation')?.value).toMatchObject({ busyEnter: 'queue' })
    expect(forms.find(form => form.ns === 'ui-settings')?.value).toMatchObject({ enabled: false })
  }, 30_000)

  it('lists in the shortcut reference none of the shortcuts the console withholds, and no row in its vocabulary', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-shortcut-reference'))
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings' })
    const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    // A failed check below would otherwise leave both dialogs over the next test.
    onTestFinished(async () => {
      if (await reference.count() > 0) await page.keyboard.press('Escape')
      if (await settings.count() > 0) await page.keyboard.press('Escape')
    })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: 'Edit shortcuts', exact: true }).click()
    await reference.waitFor({ timeout: 10_000 })
    // Both halves: the reference lists its rows — the shell's own among them —
    // and none of the withheld ones. Absence alone would pass on a reference
    // that drew no rows at all.
    const labels = reference.locator('[class*="commandLabel"]')
    await expect.poll(() => labels.allInnerTexts(), { timeout: 10_000 }).toContain('Open keyboard shortcuts')
    const listed = await labels.allInnerTexts()
    for (const label of [...WITHHELD_SHORTCUT_LABELS, 'Remove from list']) {
      expect({ label, listed: listed.includes(label) }).toEqual({ label, listed: false })
    }
    for (const label of listed) {
      for (const banned of [/\bsession\b/i, /\bworkspace\b/i, /\barchive\b/i, /会话/, /工作区/, /归档/]) {
        expect(label, `banned text matched ${String(banned)}`).not.toMatch(banned)
      }
    }
    await page.keyboard.press('Escape')
    await expect.poll(() => reference.count(), { timeout: 10_000 }).toBe(0)
    await page.keyboard.press('Escape')
    await expect.poll(() => settings.count(), { timeout: 10_000 }).toBe(0)
  }, 30_000)

  it.skipIf(WITHHELD_SHORTCUT_KEYS === undefined)(
    'runs none of the withheld commands for its key in a real browser, while the shell\'s own keys still run',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-withheld-keys'))
      const keys = WITHHELD_SHORTCUT_KEYS!
      // The page rests on "My Workflow"'s own conversation, which has run a
      // turn: every withheld command has a target here, so a key that reached
      // the registry would act on it.
      const workflowRow = workflowsSection(page).getByRole('button', { name: /My Workflow/ })
      await expect(workflowRow.getAttribute('data-active')).resolves.toBe('true')
      await composer(page, ESTABLISHED_PLACEHOLDER).waitFor({ timeout: 15_000 })
      const temporaryRows = sidebar(page).locator('[data-server-sidebar-section="temporary"] li')
      const temporaryBefore = await temporaryRows.count()
      const archivedBefore = [...scaffold.ctx.workspaceRegistry.archivedSessionIds]
      const menuBefore = readServerMenu(scaffold)

      for (const key of [keys.new, keys.search, keys.add, keys.rename, keys.fork, keys.archive, keys.files]) {
        await page.keyboard.press(key)
      }
      // The registry runs a command synchronously on the press; a fork or an
      // archive it started would land within this wait.
      await page.waitForTimeout(1_000)
      expect(await page.getByRole('dialog').count()).toBe(0)
      expect(await page.getByText(/removed from the list/).count()).toBe(0)
      expect(await page.getByRole('tab', { name: 'Files' }).count()).toBe(0)
      expect(await page.getByText(LEAKED_PLACEHOLDER).count()).toBe(0)
      await expect(workflowRow.getAttribute('data-active')).resolves.toBe('true')
      await composer(page, ESTABLISHED_PLACEHOLDER).waitFor({ timeout: 5_000 })
      expect(await temporaryRows.count()).toBe(temporaryBefore)
      expect([...scaffold.ctx.workspaceRegistry.archivedSessionIds]).toEqual(archivedBefore)
      expect(readServerMenu(scaffold)).toEqual(menuBefore)

      // The shell's own key still reaches the registry: the presses above were
      // delivered, and consumed only where a withheld command held them.
      await page.keyboard.press(keys.reference)
      const reference = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
      await reference.waitFor({ timeout: 10_000 })
      await page.keyboard.press('Escape')
      await expect.poll(() => reference.count(), { timeout: 10_000 }).toBe(0)
    },
    30_000,
  )

  it('refuses a settings write to the pinned preset, while the sidebar\'s own menu fields save', async () => {
    // `remote.settings` answers any browser the deployment admits, so the
    // pinned preset holds only because the lock composes above the profile
    // patch. The sidebar row sits in the bundle layer below it, which is what
    // lets the same service save the menu (`beforeAll` wrote it).
    await expect(scaffold.ctx.settings.update('permission', { defaultPreset: 'danger-full-access' }))
      .rejects.toThrow(/overridden by a home patch or command-line overlay/)
    await scaffold.ctx.settings.update(SERVER_SIDEBAR_NAMESPACE, { workbenchSessionId: workbenchSessionId })
  })

  it('refuses a settings write that would turn on Session-log upload', async () => {
    // The page has no switch for it (`ui-settings-session-log` is disabled),
    // and the lock holds `enabled: false` against the same RPC write.
    await expect(scaffold.ctx.settings.update('session-log-deepseek', { enabled: true }))
      .rejects.toThrow(/overridden by a home patch or command-line overlay/)
  })

  it('refuses a settings write to every preference and tunable the lock holds', async () => {
    // Each of these saves into the profile patch every visitor shares; the
    // lock composes above it, so config-editor refuses a write that differs
    // from the lock's value, and the page offers no control for any of them.
    const describedBefore = new Map<string, unknown>(scaffold.ctx.settings.describe().map(form => [form.ns, form.value]))
    for (const [ns, patch] of LOCKED_WRITES) {
      expect(describedBefore.has(ns)).toBe(true)
      await expect(scaffold.ctx.settings.update(ns, patch), ns)
        .rejects.toThrow(/overridden by a home patch or command-line overlay/)
    }
    const describedAfter = new Map<string, unknown>(scaffold.ctx.settings.describe().map(form => [form.ns, form.value]))
    for (const [ns] of LOCKED_WRITES) expect(describedAfter.get(ns)).toEqual(describedBefore.get(ns))
  })

  it('serves an admitted visitor no Host administration method, while the console\'s own calls still answer', async () => {
    // Every row the composition keeps activated: a disabled row whose
    // dependent stayed composed would leave that dependent waiting.
    const inactive = [...scaffold.ctx.loader.entries()]
      .filter(entry => !entry.disabled && entry.fiber?.state !== FiberState.ACTIVE)
      .map(entry => entry.options.id)
    expect(inactive).toEqual([])
    // The login cookie admits this request as the operator Peer with no
    // per-method check, so absence from the composition is the only refusal.
    for (const [endpoint, args] of CLOSED_ENDPOINTS) {
      expect({ endpoint, ...await remoteCall(scaffold, endpoint, args) }).toEqual({ endpoint, status: 404 })
    }
    // `llm` itself stays; with `llm-pi-ai` gone no discovery fetches the URL.
    const discovery = await remoteCall(scaffold, 'llm/discoverModels', {
      settingsNs: 'llm-pi-ai', request: { baseURL: 'http://127.0.0.1:9/v1', api: 'openai-completions' },
    })
    expect(discovery.result).toMatchObject({
      ok: false, error: { code: 'llm/model-discovery-rejected', message: 'no model discovery is registered for "llm-pi-ai"' },
    })
    // The lock refuses the same write the settings page would send.
    const write = await remoteCall(scaffold, 'settings/update', { ns: 'agent-default-model', patch: { model: 'deepseek-v4-pro' } })
    expect(write.result).toMatchObject({ ok: false, error: { code: 'settings/rejected' } })
    expect(write.result?.error?.message).toMatch(/overridden by a home patch or command-line overlay/)
    expect(scaffold.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    // The console's own calls take the same path and answer.
    expect(await remoteCall(scaffold, 'session/list', { _request: {} })).toMatchObject({ status: 200, result: { ok: true } })
    const described = await remoteCall(scaffold, 'settings/describe', {})
    expect(described).toMatchObject({ status: 200, result: { ok: true } })
    const namespaces = (described.result?.value as { namespaces: { ns: string }[] }).namespaces.map(view => view.ns)
    expect(namespaces).toContain(SERVER_SIDEBAR_NAMESPACE)
    expect(namespaces.filter(ns => ['llm-pi-ai', 'web-search-deepseek'].includes(ns))).toEqual([])
  })

  it('mounts the MCP capability with no server, and offers no settings form that could add one', async () => {
    // `servers` is ordinary Config of a bundle-layer row: the settings service
    // projects no form for it and refuses a write, so no admitted browser can
    // add a server. The empty list opens no connection and registers no tool,
    // which the exact tool catalog below also pins.
    const row = [...scaffold.ctx.loader.entries()].find(entry => entry.options.id === 'console-mcp')
    expect(row?.options).toMatchObject({ name: '@deepseek-ai/dsh-experimental-console-mcp', config: { servers: [] } })
    // Rethrows the activation error of a row that failed to load.
    await row?.fiber?.await()
    expect(scaffold.ctx.settings.describe().map(form => form.ns)).not.toContain('console-mcp')
    await expect(scaffold.ctx.settings.update('console-mcp', { servers: [{ id: 'iot', url: 'https://mcp.example.test/mcp' }] }))
      .rejects.toThrow('Plugin entry "console-mcp" has no volatile fields')
  })

  it('runs a new session under the `console` preset, whose default no settings write can move', async () => {
    const ctx = scaffold.ctx
    await expect(ctx.agentPresets.resolve()).resolves.toEqual({ id: 'console' })
    await expect(ctx.settings.update('agent-preset-registry', { selectedDefault: 'standard' }))
      .rejects.toThrow(/overridden by a home patch or command-line overlay/)
    const handle = await ctx.agents.create({
      sessionId: SessionId('server-sidebar-console-preset'),
      setup: agentCtx => ctx.agentPresets.mount(agentCtx).then(() => undefined),
    })
    try {
      // The exact catalog: the preset's own tools plus the host plane's
      // content-column tools, which reach every preset. No shell, search,
      // job, goal, plan, delegation, or web tool.
      expect(ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()).toEqual(CONSOLE_TOOLS)
      // Automatic compaction is a host-plane row; the engine it calls is this
      // preset's own, inside the isolated `compaction` group, which only the
      // preset registry can address. Reaching it is what lets the plugin's
      // policy turn off the backend's own between-steps check.
      expect(ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeDefined()
      expect(ctx.get('compaction')).toBeUndefined()
      expect(ctx.get('compactionPolicy')?.isEnabled()).toBe(false)
      expect(ctx.get('compactionPolicy')?.thresholdRatio()).toBe(0.6)
    } finally {
      await handle.dispose()
    }
  })

  it('offers `console` and a `standard` with console\'s tools, so no session can run under a shipped preset', async () => {
    // `session.create` takes an `agentPreset` over RPC, which no page control
    // gates; each shipped preset is absent from the registry rather than hidden.
    // `standard` stays resolvable so sessions created under it before `console`
    // existed can resume, and it resolves to the customer tool set.
    const presets = await scaffold.ctx.agentPresets.list()
    expect(presets.map(preset => preset.id).sort()).toEqual(['console', 'standard'])
    expect(presets.every(preset => preset.broken === undefined)).toBe(true)
    for (const shipped of ['ptc', 'minimal', 'cordis']) {
      await expect(scaffold.ctx.agentPresets.resolve(shipped)).rejects.toThrow(`Unknown agent preset: ${shipped}`)
    }
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('server-sidebar-standard-preset'),
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    try {
      expect(scaffold.ctx.tools.schemas(handle.agent).map(schema => schema.name).sort()).toEqual(CONSOLE_TOOLS)
      // The `standard` twin carries the same `compaction` group, so automatic
      // compaction reaches an engine for its sessions too.
      expect(scaffold.ctx.agentPresets.serviceFor(handle.agent, 'compaction')).toBeDefined()
    } finally {
      await handle.dispose()
    }
  })

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
    await expect.poll(() => laneHead.getByRole('img', { name: 'Pinned' }).isVisible(), { timeout: 10_000 }).toBe(true)
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
    // One click arms, a second commits: a conversation this control takes off
    // the list does not come back (see the package README's Known Limitations).
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
    // No composer control names the pinned preset: the chip belongs to the
    // disabled `ui-permission` row.
    for (const chip of await page.getByText(RENAMED_PRESET).all()) {
      await expect(chip.isVisible()).resolves.toBe(false)
    }
    expect(await page.locator('[data-composer-card]').innerText()).not.toMatch(/workspace/i)
  }, 30_000)

  it('titles a conversation with no durable title by the label its sidebar row shows, in place of its directory name', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-server-sidebar-untitled-header'))
    // Make the current workbench draft an untitled conversation — a closed
    // turn with no prompt — then displace it with a workbench click, so it is
    // reachable from the temporary section, where its row reads Untitled chat.
    const untitled = workbenchSessionId
    seedUntitledTurn(scaffold, untitled)
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await sidebar(page).waitFor({ timeout: 15_000 })
    // A click that lands before the reloaded page has listed its sessions and
    // workspaces finds nowhere to create a conversation and does nothing, so
    // the click repeats until the server menu names a new workbench. A click
    // after that point is never made.
    await expect.poll(async () => {
      if (readServerMenu(scaffold).workbenchSessionId === untitled) await workbenchButton(page).click()
      return readServerMenu(scaffold).workbenchSessionId
    }, { timeout: 15_000, interval: 1_000 }).not.toBe(untitled)
    await composer(page, HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
    workbenchSessionId = readServerMenu(scaffold).workbenchSessionId!

    const temporary = sidebar(page).locator('[data-server-sidebar-section="temporary"]')
    await temporary.getByRole('button', { name: /Untitled chat/ }).click()
    await composer(page, ESTABLISHED_PLACEHOLDER).waitFor({ timeout: 15_000 })
    expect(scaffold.ctx.sessionTitle.get(scaffold.ctx.agents.get(SessionId(untitled))!.session)).toBeUndefined()

    // The session list's `displayTitle` for this conversation is the
    // directory's basename; the header shows the temporary row's copy instead,
    // and the crumb that would carry the basename is present and renders
    // nothing. The click above made another conversation the workbench, so
    // this one no longer reads Workbench.
    const header = page.locator('header').filter({ has: page.locator('[class*="titleCluster"]') })
    const title = header.locator('[data-server-sidebar-untitled-title]')
    await expect.poll(() => title.isVisible(), { timeout: 15_000 }).toBe(true)
    await expect(title.innerText()).resolves.toBe('Untitled chat')
    await expectGuardHides(header, 'crumbs')
    const headerText = await header.innerText()
    expect(headerText).not.toContain('server-sidebar-workspace')
    expect(headerText).not.toContain(untitled)
    await evidence(page, 'web-e2e-server-sidebar-untitled-header')

    // The new workbench draft becomes untitled too. A page loaded with no
    // conversation open lands on the workbench whatever it carries, and its
    // header reads the sidebar's 工作台 entry; the displaced conversation on
    // the same page reads 未命名对话.
    seedUntitledTurn(scaffold, workbenchSessionId)
    const zhPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    try {
      await zhPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await sidebar(zhPage).waitFor({ timeout: 30_000 })
      const zhHeader = zhPage.locator('header').filter({ has: zhPage.locator('[class*="titleCluster"]') })
      const zhTitle = zhHeader.locator('[data-server-sidebar-untitled-title]')
      await expect.poll(() => zhTitle.isVisible(), { timeout: 15_000 }).toBe(true)
      await expect(zhTitle.innerText()).resolves.toBe('工作台')
      await expectGuardHides(zhHeader, 'crumbs')
      await evidence(zhPage, 'web-e2e-server-sidebar-workbench-header-zh')
      const zhTemporary = sidebar(zhPage).locator('[data-server-sidebar-section="temporary"]')
      await zhTemporary.getByRole('button', { name: /未命名对话/ }).click()
      await expect.poll(() => zhTitle.innerText(), { timeout: 15_000 }).toBe('未命名对话')
      await expectGuardHides(zhHeader, 'crumbs')
      await evidence(zhPage, 'web-e2e-server-sidebar-untitled-header-zh')
    } finally {
      await zhPage.close()
    }
  }, 120_000)

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
    scaffold = await launchConsole(harnessHome, HOMEPAGE_OVERLAY)
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
      // Contrast the un-configured deployment layer's own workbench test: with a home
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
    scaffold = await launchConsole(harnessHome, VIEWS_OVERLAY)
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
      // opened by different commands, and that catalog's own entry id.
      expect(await navSection(page).locator('[data-server-sidebar-nav-kind]').evaluateAll(
        rows => rows.map(row => [row.getAttribute('data-server-sidebar-nav-kind'), row.getAttribute('data-server-sidebar-nav-entry')]),
      )).toEqual([['page', 'home'], ['page', 'reports'], ['view', 'site-overview']])
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
    // This describe composes the lock the `--patch` way; the others use the home patch.
    scaffold = await launchConsole(harnessHome, OVERLAY, 'command-line')
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

  it('refuses a settings write to the pinned preset with the lock passed as `--patch`', async () => {
    // Only the composition tells the two lock forms apart: config-editor's
    // refusal names both. No home patch exists, so the refusal comes from the
    // command-line overlay alone.
    await expect(access(join(harnessHome, 'cordis.patch.yml'))).rejects.toThrow(/ENOENT/)
    await expect(scaffold.ctx.settings.update('permission', { defaultPreset: 'danger-full-access' }))
      .rejects.toThrow(/overridden by a home patch or command-line overlay/)
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

      // …and `terminology-guard.ts` paints nothing over the composer
      // placeholder: it is the only thing telling the visitor the composer
      // cannot accept input, so the element keeps its own font size and grows
      // no `::after` of this package's own.
      const inertPlaceholder = shellColumn(page, 'chat').locator('[data-composer-placeholder]')
      await inertPlaceholder.waitFor({ timeout: 15_000 })
      await expect(inertPlaceholder.evaluate(el => getComputedStyle(el).fontSize)).resolves.not.toBe('0px')
      await expect(inertPlaceholder.evaluate(el => getComputedStyle(el, '::after').content)).resolves.toBe('none')
      await expect(inertPlaceholder.innerText()).resolves.toContain(LEAKED_PLACEHOLDER)
    },
    30_000,
  )

  it(
    'serves the build check in place of live plugin replacement, and draws its connection-loss notice in the overlay layer clear of the composer',
    async () => {
      const served = await (await scaffold.hostFetch('/')).text()
      expect(served).toContain('"@deepseek-ai/dsh-experimental-page-refresh"')
      expect(served).toContain('__DSH_PAGE_REFRESH_CONFIG__')
      expect(served).not.toContain('@deepseek-ai/dsh-client-hmr')
      // client-hmr's event channel, which carries live plugin replacement.
      expect((await scaffold.hostFetch('/plugins/events')).status).toBe(404)

      // A page of its own, so refusing its connection leaves this describe's page connected.
      const second = await newEnglishPage(browser)
      onTestFinished(() => second.close())
      onTestFailed(() => saveFailureShot(second, 'web-e2e-server-sidebar-connection-notice'))
      let refuse = false
      const open: WebSocketRoute[] = []
      await second.routeWebSocket('**/api/remote.mux', (client) => {
        if (refuse) {
          void client.close({ code: 1012, reason: 'test connection refused' })
          return
        }
        const server = client.connectToServer()
        open.push(client, server)
        client.onMessage((message) => { server.send(message) })
        server.onMessage((message) => { client.send(message) })
      })
      await second.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await sidebar(second).waitFor({ timeout: 30_000 })
      const composer = second.locator('[data-composer-input]')
      await composer.waitFor({ timeout: 15_000 })
      refuse = true
      await Promise.all(open.map(route => route.close({ code: 1012, reason: 'test connection loss' })))
      const notice = second.locator('[data-shell-overlay] [data-page-refresh-notice="lost"]')
      await notice.waitFor({ timeout: 15_000 })
      const [noticeBox, composerBox] = await Promise.all([notice.boundingBox(), composer.boundingBox()])
      expect(noticeBox).not.toBeNull()
      expect(composerBox).not.toBeNull()
      const overlaps = noticeBox!.x < composerBox!.x + composerBox!.width
        && composerBox!.x < noticeBox!.x + noticeBox!.width
        && noticeBox!.y < composerBox!.y + composerBox!.height
        && composerBox!.y < noticeBox!.y + noticeBox!.height
      expect(overlaps).toBe(false)
    },
    60_000,
  )

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

/**
 * The console's automatic-compaction scenario. Its snapshot directory owns the
 * recorded session, the system-prompt and tool-schema pins of the console
 * composition, and the Chat column's ARIA once the conversation is compacted.
 */
const AUTO_COMPACT_DIR = join(REPO_ROOT, 'snapshots/web/console-auto-compact')
const AUTO_COMPACT_FIXTURE = join(AUTO_COMPACT_DIR, 'session.v4.jsonl')
const AUTO_COMPACT_EXPECTED = join(AUTO_COMPACT_DIR, 'compacted.expected.md')
/**
 * The replay models' context window. Above 163,840 tokens, 60% of the window
 * is below the window minus the compaction backend's 65,536-token headroom, so
 * the bundle's share is the term that decides; the backend's own 80% would
 * not trigger until 134,464.
 */
const AUTO_COMPACT_WINDOW = 200_000
/** The usage the second reply reports: 62.5% of the window. */
const ABOVE_SHARE = 125_000
/** The usage the negative control's second reply reports: 57.5% of the window. */
const BELOW_SHARE = 115_000
/** The replay route every scenario session selects. */
const AUTO_COMPACT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const
/**
 * Length, in UTF-16 code units, of the sessions' workspace path. The first
 * turn's runtime-context message names that path and is among the messages the
 * compaction replaces; the token meter prices its text at
 * `ceil(length / 4)`, so a temporary root of machine-dependent length would
 * change the recorded `shadowedTokenCount`.
 */
const AUTO_COMPACT_WORKSPACE_LENGTH = 240
/**
 * A directory path of exactly {@link AUTO_COMPACT_WORKSPACE_LENGTH} code units
 * under `root`.
 * @param root - the absolute directory the workspace sits in.
 * @returns `root` joined with a padded directory name.
 */
function fixedLengthWorkspace(root: string): string {
  const name = 'server-sidebar-workspace-'
  const padding = AUTO_COMPACT_WORKSPACE_LENGTH - root.length - 1 - name.length
  if (padding < 0) throw new Error(`temporary root ${root} is longer than ${AUTO_COMPACT_WORKSPACE_LENGTH - name.length - 1} characters`)
  const path = join(root, name + 'x'.repeat(padding))
  if (path.length !== AUTO_COMPACT_WORKSPACE_LENGTH) throw new Error(`workspace path ${path} is not ${AUTO_COMPACT_WORKSPACE_LENGTH} characters long`)
  return path
}
/**
 * A prompt of `repeats` sentences, priced by the token meter at four
 * characters a token.
 * @param label - the prompt's first word.
 * @param repeats - how many times the sentence repeats.
 * @returns the prompt text.
 */
const longPrompt = (label: string, repeats: number): string =>
  `${label} ${'event sourcing keeps every change as an event. '.repeat(repeats)}`
/**
 * The second prompt alone (about 35,000 tokens) fills the verbatim tail the
 * compaction backend keeps, 16% of the window, so the first turn is the span a
 * compaction condenses. The first prompt (about 9,400 tokens) is large enough
 * that condensing it brings the third turn's request back under 60%, so one
 * compaction settles the turn.
 */
const AUTO_COMPACT_PROMPTS = [
  longPrompt('First', 800), longPrompt('Second', 3_000), 'Now summarize what we discussed.',
] as const
const SUMMARY = '## Summary\n\nThe user sent two long notes about event sourcing: every change is kept as an event.'
const ANSWER = 'Event sourcing keeps every change as an event.'

/**
 * One scripted text reply.
 * @param text - the reply text.
 * @param inputTokens - the prompt usage the reply reports.
 * @returns the replay entry.
 */
function textReply(text: string, inputTokens: number): ReplayEntry {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] satisfies StreamChunk[],
  }
}

/**
 * The model calls of the three prompts: two replies, then, when the second
 * reply's usage passes the share, the compaction summary before the third.
 * @param secondUsage - the usage the second reply reports.
 * @returns the whole replay script.
 */
function autoCompactScript(secondUsage: number): ReplayEntry[] {
  return [
    textReply('READY', 200),
    textReply('READY', secondUsage),
    ...secondUsage > AUTO_COMPACT_WINDOW * 0.6 ? [textReply(SUMMARY, 40_000)] : [],
    textReply(ANSWER, 300),
  ]
}

/** The snapshot mode; the scenario's recording is authored, so a record run skips it. */
const AUTO_COMPACT_MODE = webSnapshotMode()

describe.skipIf(AUTO_COMPACT_MODE === 'record')('web e2e: automatic compaction in the console at 60% of the context window', () => {
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT
  let harnessHome: string | undefined
  let scriptDir: string | undefined
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  const events = new Map<string, SessionEvent[]>()

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    // The scaffold's own close compares the replayed session with the fixture
    // and checks every scripted call was consumed.
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    scaffold = undefined
    for (const dir of [harnessHome, scriptDir]) {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
    }
    harnessHome = undefined
    scriptDir = undefined
    events.clear()
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'console auto-compact teardown failed')
  })

  /**
   * Launch the console over the replay route with a registered workspace.
   * @param replay - the fixture or scripted override the route replays.
   * @returns the scaffold and the workspace directory.
   */
  async function launch(replay: ConsoleReplayOptions): Promise<{ live: WebScaffold; workspaceDir: string }> {
    harnessHome = await harnessHomeWithRowLinks()
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    const live = await launchConsole(harnessHome, OVERLAY, 'home', {
      replayContextWindow: AUTO_COMPACT_WINDOW, paceMs: 10, ...replay,
    })
    scaffold = live
    live.ctx.on('session/event', (session, event: SessionEvent) => {
      const log = events.get(session.id) ?? []
      log.push(event)
      events.set(session.id, log)
    })
    const workspaceDir = fixedLengthWorkspace(live.workspaceCwd)
    await mkdir(workspaceDir, { recursive: true })
    await live.ctx.workspaceRegistry.create(workspaceDir)
    return { live, workspaceDir }
  }

  /**
   * Write a whole-script override for one launch.
   * @param secondUsage - the usage the second reply reports.
   * @returns the override file's path.
   */
  async function scriptFile(secondUsage: number): Promise<string> {
    scriptDir = await mkdtemp(join(tmpdir(), 'dsh-console-auto-compact-'))
    const path = join(scriptDir, 'replay.override.json')
    await writeFile(path, JSON.stringify(autoCompactScript(secondUsage)))
    return path
  }

  /**
   * Run the three prompts on a session of the given preset, created on the
   * Host as a session RPC creates one.
   * @param live - the running scaffold.
   * @param workspaceDir - the session's working directory.
   * @param preset - the Agent preset the session runs under.
   * @returns the session's events.
   */
  async function runOnPreset(live: WebScaffold, workspaceDir: string, preset: 'console' | 'standard'): Promise<SessionEvent[]> {
    const sessionId = SessionId(`console-auto-compact-${preset}`)
    const handle = await live.ctx.agents.create({
      sessionId,
      meta: { cwd: workspaceDir, agentPreset: preset },
      agentOptions: AUTO_COMPACT_ROUTE,
      setup: agentCtx => live.ctx.agentPresets.mount(agentCtx, preset).then(() => undefined),
    })
    try {
      for (const prompt of AUTO_COMPACT_PROMPTS) {
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      return events.get(sessionId) ?? []
    } finally {
      await handle.dispose()
    }
  }

  /**
   * The turn each compaction opened in, in log order.
   * @param log - one session's events.
   * @returns the `turn` of every `compaction/start`.
   */
  function compactionTurns(log: readonly SessionEvent[]): (number | null | undefined)[] {
    return log.flatMap(event => event.type === 'compaction/start' ? [event.data.turn] : [])
  }

  it('compacts the workbench conversation before the third prompt\'s first request, and the Chat column shows it', async () => {
    const { live } = await launch({ replayFixture: AUTO_COMPACT_FIXTURE })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-console-auto-compact'))
    const tripwire = watchConsole(page)
    await page.goto(live.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
    await workbenchButton(page).click()
    await expect.poll(() => readServerMenu(live).workbenchSessionId, { timeout: 15_000 }).toBeDefined()
    const sessionId = SessionId(readServerMenu(live).workbenchSessionId!)
    await expect.poll(() => live.ctx.agents.get(sessionId) !== undefined, { timeout: 15_000 }).toBe(true)
    const selected = await live.ctx.sessionController.selectModel({ sessionId, ...AUTO_COMPACT_ROUTE })
    expect(selected.selected).toMatchObject(AUTO_COMPACT_ROUTE)

    const input = page.locator('[data-composer-input]').first()
    for (const prompt of AUTO_COMPACT_PROMPTS) {
      await input.waitFor({ timeout: 15_000 })
      const settled = live.whenTurnSettled(60_000)
      await input.fill(prompt)
      await input.press('Enter')
      expect(await settled).toBe(sessionId)
    }

    // The bundle's 60% decided: the second reply reported 62.5% of the
    // window, which the backend's own check would have let pass, and the
    // conversation was compacted inside the third turn, before its first
    // model request.
    const log = events.get(sessionId) ?? []
    expect(live.ctx.sessionProjections.stateOf(live.ctx.agents.get(sessionId)!.session, 'agentPreset')).toBe('console')
    expect(compactionTurns(log)).toEqual([3])
    const start = log.findIndex(event => event.type === 'compaction/start')
    const firstReply = log.findIndex(event => event.type === 'assistant/message' && event.data.turn === 3)
    expect(start).toBeGreaterThan(-1)
    expect(start).toBeLessThan(firstReply)
    const end = log.find(event => event.type === 'compaction/end')
    expect(end?.data).toMatchObject({ turn: 3 })
    expect(end?.data.sourceCommandId).toBeUndefined()

    // What a customer sees: every process group open, so the console's
    // compaction row among the third turn's process rows (`server-sidebar`'s
    // `CompactedRow`, one sentence with no count and nothing to open) is in the
    // capture, and the conversation scrolled to its end.
    await page.getByText(ANSWER, { exact: true }).waitFor({ timeout: 15_000 })
    const controls = page.locator('[data-turn-process], [data-process-activity]')
    for (let index = 0; index < await controls.count(); index++) {
      const control = controls.nth(index)
      if (await control.isVisible() && await control.getAttribute('aria-expanded') === 'false') await control.click()
    }
    const scroll = page.locator('[data-shell-column="chat"] [data-conversation-scroll]')
    await expect.poll(async () => {
      const distance = await scroll.evaluate((host) => {
        host.scrollTop = host.scrollHeight
        return host.scrollHeight - host.clientHeight - host.scrollTop
      })
      return Math.abs(distance) <= 1 && await page.getByRole('button', { name: 'Back to bottom', exact: true }).count() === 0
    }, { timeout: 10_000 }).toBe(true)
    const aria = await captureStableAria(page, '[data-shell-column="chat"]', live.workspaceCwd, {
      replacements: [[AUTO_COMPACT_PROMPTS[0], '{{first-prompt}}'], [AUTO_COMPACT_PROMPTS[1], '{{second-prompt}}']],
    })
    await compareOrRefreshGolden(AUTO_COMPACT_EXPECTED, aria, AUTO_COMPACT_MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it('leaves the conversation whole when the second reply reports 57.5% of the window', async () => {
    const { live, workspaceDir } = await launch({
      replayFixture: AUTO_COMPACT_FIXTURE, replayOverride: await scriptFile(BELOW_SHARE), compareReplaySession: false,
    })
    // The script holds no summary, so a compaction would consume the third
    // answer and leave the third turn's request unanswered.
    expect(compactionTurns(await runOnPreset(live, workspaceDir, 'console'))).toEqual([])
  }, 180_000)

  it('compacts a session of the `standard` twin at the same share', async () => {
    const { live, workspaceDir } = await launch({
      replayFixture: AUTO_COMPACT_FIXTURE, replayOverride: await scriptFile(ABOVE_SHARE), compareReplaySession: false,
    })
    expect(compactionTurns(await runOnPreset(live, workspaceDir, 'standard'))).toEqual([3])
  }, 180_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(AUTO_COMPACT_DIR, [
      'compacted.expected.md',
      'session.v4.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
    ])
  })
})
