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
 * No recording of its own. The seeded log shows the page, and one scripted
 * model turn asks for the read: the loop logs its `tool/call` — which is what
 * the `contentAccess` projection folds and publishes to every browser — and
 * runs the tool, whose wait the seat answers. A format-4 log cannot hold a
 * call left open inside a closed step, so the call is opened live rather than
 * seeded. What the assertions read is the result that call settled as.
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

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const SEED = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
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

/** The id of the one read the scripted turn asks for. */
const CALL_ID = ToolCallId('content-read-hidden-probe')

/** What the user asks; the scripted answer does not depend on it. */
const PROMPT = 'Read the page in the content column.'

/**
 * The two model answers the turn consumes: the read, then a closing line once
 * its result is in.
 */
const SCRIPT: ReplayOverrideDoc = [
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: CALL_ID, name: 'content_read', arguments: '{}' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  },
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Read.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Read.' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  },
]

/**
 * The route a seat bids on, and the wait a seat whose tab is not in front pays
 * before its first bid.
 *
 * `apps/web` cannot import the experimental package, so both are restated:
 * `CONTENT_CLAIM_ROUTE` and `HIDDEN_CLAIM_GRACE_MS` in
 * `packages/experimental/content-frame/src/access/wire.ts`. A change to either
 * must be a visible change here.
 */
const CLAIM_ROUTE = '/content-frame/claim'
const HIDDEN_CLAIM_GRACE_MS = 500

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
 * Seed a log that shows a page.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withShownPage(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
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
 * Report this tab as one the user is not looking at, the way the browser does.
 *
 * Nothing here listens for `visibilitychange`: the seat reads the value at the
 * moment it bids, so overriding the property is the whole of what a hidden tab
 * looks like from inside the page.
 * @param page - the console's page.
 */
async function hideTab(page: Page): Promise<void> {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    Object.defineProperty(document, 'hidden', { value: true, configurable: true })
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
  /** When the prompt that asks for the read was sent, which precedes the first render that could bid. */
  let asked = 0
  /** When the first bid for the read reached the host, as the browser sent it. */
  let firstBid: number | undefined
  const sessionEvents: SessionEvent[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    const script = join(harnessHome, 'replay.override.json')
    await writeFile(script, JSON.stringify(SCRIPT))
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: script, replayOverride: script })
    seeded = await seedSession(scaffold, withShownPage(await readFile(SEED, 'utf8')), SEEDED_SESSION)
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id === seeded) sessionEvents.push(event)
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      if (firstBid === undefined && request.url().endsWith(CLAIM_ROUTE)) firstBid = Date.now()
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-shell-column="content"]').waitFor({ state: 'attached', timeout: 30_000 })
    // Hidden before the call exists, which is what puts the grace on the path:
    // hiding it after the first bid would leave the seat's one and only claim
    // for this call already sent from a visible tab.
    await hideTab(page)
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

  it('answers the read from a tab that is not in front', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-hidden'))
    const input = page.locator(COMPOSER).first()
    await writeComposerDraft(page, input, PROMPT)
    // The closing line is the second scripted answer, and teardown asserts the
    // script was consumed whole, so the turn has to end before the test does.
    const turnEnded = scaffold.whenTurnSettled(60_000)
    asked = Date.now()
    await page.keyboard.press('Enter')

    expect(await turnEnded).toBe(seeded)
    const result = sessionEvents.find(event =>
      event.type === 'tool/result' && event.data.message.source.callId === CALL_ID)
    if (result?.type !== 'tool/result') throw new Error('the read settled with no result')
    const text = result.data.message.content
      .map(block => (block.type === 'text' ? block.text : ''))
      .join('')
    // The listing of the document the hidden tab walked, carrying the header
    // line the tool composes around whatever the seat returned — and not the
    // sentence a claim window that passed with no browser in it composes.
    expect({
      isError: result.data.message.isError,
      listing: text.startsWith('Page: Home — the app is at /content-app/'),
      unclaimed: text.includes('is showing this session\'s content column'),
      // Still hidden when the answer arrived: nothing brought the tab back.
      hidden: await page.evaluate(() => document.visibilityState),
    }).toEqual({ isError: false, listing: true, unclaimed: false, hidden: 'hidden' })
    expect(text).toContain('Hosted content app')

    // And the grace was paid. Sending the prompt precedes the render that let
    // the seat see the call, so this understates the wait the seat took and
    // can only fail where the seat did not take one at all.
    expect(firstBid ?? 0).toBeGreaterThanOrEqual(asked + HIDDEN_CLAIM_GRACE_MS)
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
