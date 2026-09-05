/**
 * Web e2e regression: the console answers a read while its tab is not in front.
 *
 * A tab reporting `hidden` holds the same mounted frames and the same live
 * documents as one in front, and macOS reports a foreground window another
 * window covers as hidden — so a seat that treated visibility as a veto left
 * the only console open answering nothing. jsdom can stand in for none of it:
 * the frame here is pointed at the real route, loads a real document, and is
 * walked by a real layout engine.
 *
 * Zero model calls, and no recording of its own. The call the seat answers is
 * spliced into the seeded log — which is what the `contentAccess` projection
 * folds and publishes to every browser — and the host's own wait for it is
 * opened by running the tool directly, under the same call id. What the
 * assertions read is the value that call settled as.
 *
 * Playwright launches Chromium with `--disable-background-timer-throttling`,
 * `--disable-backgrounding-occluded-windows` and `--disable-renderer-
 * backgrounding`, so no automated lane can reproduce a hidden tab's throttled
 * clocks; this one covers the gate, and the clocks are the package README's
 * Known Limitations.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SEED = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.jsonl', import.meta.url))
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
const SEEDED_SESSION = 'content-read-hidden-web-e2e'

/** The id the spliced call and the executed tool share; one call, one wait. */
const CALL_ID = ToolCallId('content-read-hidden-probe')

/** The composer's own stable attribute — the signal that a session is open. */
const COMPOSER = '[data-composer-input]'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-read-hidden-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * Seed a log that shows a page and holds one open read of it.
 *
 * The page is shown before the turn closes, and the read is spliced inside the
 * last open step, which is where a `tool/call` belongs. No result follows it,
 * so the projection publishes the call as open for as long as the session
 * lives — which is what a browser claims.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withShownPageAndOpenRead(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const lastStepEnd = lines.findLastIndex(line => line.includes('"type":"step/end"'))
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (lastStepEnd === -1 || closing === -1) throw new Error('seed fixture has no step/end and turn/end to splice between')
  const step = JSON.parse(lines[lastStepEnd] as string) as { data: { turn: number; step: number } }
  return [
    ...lines.slice(0, lastStepEnd),
    JSON.stringify({
      type: 'tool/call',
      data: { turn: step.data.turn, step: step.data.step, callId: CALL_ID, name: 'content_read', arguments: '{}' },
    }),
    ...lines.slice(lastStepEnd, closing),
    JSON.stringify({ type: 'content/shown', data: { page: 'home' } }),
    ...lines.slice(closing),
  ].join('\n')
}

/** Open the sidebar's nth session row and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.locator(COMPOSER).first().waitFor({ timeout: 15_000 })
}

/**
 * Wait for the console's own agent for one session.
 *
 * Opening a session in the console resolves its agent, and it does so over the
 * connection rather than in the click: the read below runs through that agent,
 * so it is waited for rather than read once.
 * @param scaffold - the running Web scaffold.
 * @param sessionId - the session the console opened.
 * @returns that session's live agent.
 */
async function liveAgent(scaffold: WebScaffold, sessionId: SessionId): Promise<Agent> {
  for (let waited = 0; waited < 30_000; waited += 250) {
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent !== undefined) return agent
    await new Promise<void>((resolve) => { setTimeout(resolve, 250) })
  }
  throw new Error(`the console opened "${sessionId}" and no agent for it became live`)
}

/** Report this tab as one the user is not looking at, the way the browser does. */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(await page.evaluate(() => document.visibilityState)).toBe('hidden')
}

describe.skipIf(MODE === 'record')('web e2e: the console reads while its tab is not in front', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let seeded: SessionId
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    seeded = await seedSession(scaffold, withShownPageAndOpenRead(await readFile(SEED, 'utf8')), SEEDED_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-shell-column="content"]').waitFor({ state: 'attached', timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    await openSession(page, 1)
    await page.frameLocator('iframe[data-content-frame][data-content-active]')
      .locator('#fixture-heading').waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('answers the open read from a tab that is not in front', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-hidden'))
    await hideTab(page)
    const agent = await liveAgent(scaffold, seeded)

    const result = await scaffold.ctx.tools.execute({
      signal: AbortSignal.timeout(60_000),
      callId: CALL_ID,
      name: 'content_read',
      arguments: {},
      agent,
    })
    const text = result.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    // The listing of the document the hidden tab walked, carrying the header
    // line the tool composes around whatever the seat returned — and not the
    // sentence a claim window that passed with no browser in it composes.
    expect({
      isError: result.isError,
      listing: text.startsWith('Page: Home — the app is at /content-app/'),
      unclaimed: text.includes('is showing this session\'s content column'),
    }).toEqual({ isError: false, listing: true, unclaimed: false })
    expect(text).toContain('Hosted content app')
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
