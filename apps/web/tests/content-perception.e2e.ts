/**
 * Web e2e scenario: what the agent knows about the content column.
 *
 * Everything the column shows is drawn by the browser, and until this layer
 * existed the agent could see none of it: a page the user opened from the
 * sidebar, the tab the user brought to the front, and the route the hosted
 * application took on its own were all invisible to the model. This scenario
 * drives each of the three through the real console and reads the result where
 * the model reads it — the durable log, and the assembled prompt.
 *
 * Zero model calls. Every gesture is a real click in a real browser, and every
 * assertion is against the host: the injected notice as a `user/message`, the
 * two new events on the session log, and the `content:column` context the next
 * request would carry. The composition is `server-sidebar.overlay.yml` — the
 * product console's own stack — because the page-opening gesture this scenario
 * starts from is that sidebar's navigation menu.
 *
 * The frame's own routing is driven with `history.pushState`, which fires no
 * event of any kind: it is the case the watch's polling exists for, and no unit
 * test can show a real application's route change reaching the log.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback` (the same approach `content-show.e2e.ts` uses).
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
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

/** A fresh conversation's composer placeholder — the signal that the workbench opened one. */
const HERO_PLACEHOLDER = 'Describe what you want to build'

/** Switcher keys the column mints, as `<kind> <entryId>`. */
const HOME_ENTRY = 'page home'
const REPORTS_ENTRY = 'page reports'

/**
 * The sentence the agent reads when the user opens a page, verbatim.
 * `apps/web` cannot import the experimental package (see the module doc), so
 * the text is restated rather than imported — a change to it must be a visible
 * change here.
 */
const OPENED_NOTICE = 'The user opened the page "Home" in the content column (内容区); it is in front now.'

/** Where this scenario drives the hosted application, which no event announces. */
const ROUTED_URL = '/content-app/?view=fleet'
const ROUTED_TITLE = 'Fleet overview'

const sidebar = (page: Page): Locator => page.locator('[data-server-sidebar]')
const navSection = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="nav"]')
const workbenchButton = (page: Page): Locator => sidebar(page).locator('[data-server-sidebar-section="workbench"]')
const activeFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')
const switcherEntry = (page: Page, key: string): Locator => page.locator(`[data-content-surface-entry="${key}"]`)

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-perception-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * One live session's events, widened past this compilation's own event union.
 *
 * `content/shown`, `content/navigated` and `content-surface/selected` all
 * augment `SessionEventMap` from experimental packages `apps/web` cannot
 * import, so this compilation has no member to narrow on — widen before
 * comparing rather than let a real string mismatch type-error.
 * @param scaffold - the running Web scaffold.
 * @param sessionId - the live session.
 * @returns that session's events, with type and data widened.
 */
function eventsOf(scaffold: WebScaffold, sessionId: string): { type: string; data: unknown }[] {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`content-perception e2e: no live agent for ${sessionId}`)
  return agent.session.events.map((event: SessionEvent) => ({ type: event.type as string, data: event.data as unknown }))
}

/**
 * The payloads one session logged under a type.
 * @param scaffold - the running Web scaffold.
 * @param sessionId - the live session.
 * @param type - the event type to collect.
 * @returns every payload logged under that type, in log order.
 */
function logged(scaffold: WebScaffold, sessionId: string, type: string): unknown[] {
  return eventsOf(scaffold, sessionId).filter(event => event.type === type).map(event => event.data)
}

/** The shape a `user/message` carries, as this scenario reads it. */
interface LoggedMessage {
  content: { type: string; text?: string }[]
  source: { kind: string; plugin?: string; form?: string }
}

/**
 * Every plugin-injected notice on one session's log, as plain text.
 *
 * `agent.inject` queues the message for the next pre-step rather than
 * appending it, and the splice that queues it is itself a session event — so
 * this is where a notice is durable in a run that never calls a model. The
 * `user/message` it becomes once a driver claims it is the same message under
 * the same id.
 * @param scaffold - the running Web scaffold.
 * @param sessionId - the live session.
 * @returns one string per injected notice, in log order.
 */
function injectedNotices(scaffold: WebScaffold, sessionId: string): string[] {
  const queued = (logged(scaffold, sessionId, 'agent/inbox/spliced') as { target: string; inserted: LoggedMessage[] }[])
    .filter(splice => splice.target === 'next-step')
    .flatMap(splice => splice.inserted)
  return [...queued, ...logged(scaffold, sessionId, 'user/message') as LoggedMessage[]]
    .filter(message => message.source.kind === 'plugin' && message.source.form === 'notice')
    .map(message => message.content.map(block => block.text ?? '').join(''))
}

/**
 * The `content:column` block the next request for this session would carry.
 * @param scaffold - the running Web scaffold.
 * @param sessionId - the live session.
 * @returns the context text, or undefined when the row contributed none.
 */
async function columnContext(scaffold: WebScaffold, sessionId: string): Promise<string | undefined> {
  const agent = scaffold.ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) throw new Error(`content-perception e2e: no live agent for ${sessionId}`)
  const assembly = await scaffold.ctx.systemPrompt.assemble({ agent })
  return assembly.contexts.find(entry => entry.name === 'content:column')?.text
}

/** The switcher key of the tab the column shows as selected. */
async function selectedEntry(page: Page): Promise<string | null> {
  return await page.locator('[data-content-surface-entry][data-content-surface-selected]').getAttribute('data-content-surface-entry')
}

/**
 * Wait for the workbench's own conversation to exist, outside a test body
 * (where `expect.poll` refuses to run).
 * @param scaffold - the running Web scaffold.
 * @returns the one live agent.
 * @throws when no agent appears within the window.
 */
async function theOneAgent(scaffold: WebScaffold): Promise<{ session: { id: unknown } }> {
  const deadline = Date.now() + 15_000
  for (;;) {
    const agents = scaffold.ctx.agents.list()
    if (agents.length === 1) return agents[0] as unknown as { session: { id: unknown } }
    if (Date.now() > deadline) throw new Error(`content-perception e2e: expected one live agent, found ${String(agents.length)}`)
    await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
  }
}

describe('web e2e: what the agent knows about the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT
  /** The workbench's persistent session, captured once the first test opens it. */
  let sessionId: string

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    const workspaceDir = join(scaffold.workspaceCwd, 'content-perception-workspace')
    await mkdir(workspaceDir, { recursive: true })
    await scaffold.ctx.workspaceRegistry.create(workspaceDir)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 30_000 })
    await workbenchButton(page).click()
    await page.getByPlaceholder(HERO_PLACEHOLDER).waitFor({ timeout: 15_000 })
    sessionId = String((await theOneAgent(scaffold)).session.id)
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('tells the agent, in the conversation itself, that the user opened a page', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-perception-notice'))
    await navSection(page).getByRole('button', { name: 'Home' }).click()
    await expect.poll(async () => await activeFrame(page).getAttribute('src'), { timeout: 15_000 })
      .toBe('/content-app/')

    // The notice rides the model-visible surface as an injected context
    // message: durable, replayable, and reaching the agent on its next
    // pre-step rather than waking it now.
    await expect.poll(() => injectedNotices(scaffold, sessionId), { timeout: 15_000 }).toEqual([OPENED_NOTICE])
  }, 90_000)

  it('records which tab the user brought to the front, and restores it after a reload', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-perception-selection'))
    await navSection(page).getByRole('button', { name: 'Weekly reports' }).click()
    await expect.poll(async () => await activeFrame(page).getAttribute('src'), { timeout: 15_000 })
      .toBe('/content-app/reports/')
    // The newest entry takes the front on its own; nothing is recorded yet.
    expect(logged(scaffold, sessionId, 'content-surface/selected')).toEqual([])

    await switcherEntry(page, HOME_ENTRY).click()
    await expect.poll(() => selectedEntry(page), { timeout: 15_000 }).toBe(HOME_ENTRY)
    await expect.poll(() => logged(scaffold, sessionId, 'content-surface/selected'), { timeout: 15_000 })
      .toEqual([{ kind: 'page', entryId: 'home', by: 'user' }])

    // A fresh client holds no click at all: the tab it shows is the one the
    // log says is in front, not the newest entry.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await sidebar(page).waitFor({ timeout: 15_000 })
    await expect.poll(() => selectedEntry(page), { timeout: 15_000 }).toBe(HOME_ENTRY)
    expect(await switcherEntry(page, REPORTS_ENTRY).count()).toBe(1)
  }, 120_000)

  it('records the hosted application routing itself, which fires no event at all', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-perception-navigated'))
    await activeFrame(page).waitFor({ timeout: 15_000 })
    // Exactly what a history-mode router does inside the frame: the address
    // changes, the title follows, and nothing is dispatched.
    await page.evaluate(([url, title]: [string, string]) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[data-content-frame][data-content-active]')
      const view = frame?.contentWindow
      if (view === null || view === undefined) throw new Error('no live frame to route')
      view.history.pushState({}, '', url)
      view.document.title = title
    }, [ROUTED_URL, ROUTED_TITLE] as [string, string])

    await expect.poll(() => logged(scaffold, sessionId, 'content/navigated'), { timeout: 20_000 })
      .toEqual([{ page: 'home', url: ROUTED_URL, title: ROUTED_TITLE, by: 'user' }])
  }, 120_000)

  it('carries the whole column into the next request', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-perception-context'))
    // Both pages, newest first, the one the user picked marked as in front,
    // and the address the frame routed itself to — every line of it folded
    // from this session's own log.
    await expect.poll(() => columnContext(scaffold, sessionId), { timeout: 20_000 }).toBe(
      'The content column (内容区 — the column between the sidebar and this conversation; users also say '
      + '中间 or 右边) holds, newest first:\n'
      + '- "Weekly reports" (page, opened by the user)\n'
      + '- "Home" (page, opened by the user)  ← in front\n'
      + `    the app inside is now at ${ROUTED_URL}, title "${ROUTED_TITLE}"\n`
      + 'content_show puts a page in front.',
    )
  }, 60_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
