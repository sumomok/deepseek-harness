/**
 * Web e2e scenario: the agent reads the page the user is looking at.
 *
 * The composition is the shipped Web surface plus the content-frame overlay, so
 * the whole channel is the real one — the session publishes its open read, the
 * page seat in a real browser claims it, walks the hosted document inside a
 * real iframe, and posts the listing back into the waiting call. jsdom can
 * stand in for none of that: it has no layout, and a frame pointed at a real
 * route never loads there at all.
 *
 * The fixture pins what the MODEL said; the read executes for real. What the
 * assertions read is therefore the browser's own answer about a document the
 * browser itself rendered.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, launchWebScaffold, recordFixture, seedSession, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/content-read/session.jsonl', import.meta.url))
const SEED = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
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
const SEEDED_SESSION = 'content-read-web-e2e'

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** What the user asks. Deliberately about the page, never about the tool. */
const PROMPT = '读一下内容区现在这个页面，告诉我表格有几行、有哪些按钮'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-read-'))
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
 * @param shown - the page id the agent showed.
 * @returns the fixture text to seed.
 */
function withShownPage(fixtureText: string, shown: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
    JSON.stringify({ type: 'content/shown', data: { page: shown } }),
    ...lines.slice(closing),
  ].join('\n')
}

/** Open the sidebar's nth session row and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

/** The model-facing text of every `content_read` result the log recorded. */
function readResults(events: readonly SessionEvent[]): string[] {
  const calls = new Set(events.flatMap(event => (
    event.type === 'tool/call' && event.data.name === 'content_read' ? [String(event.data.callId)] : []
  )))
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    if (!calls.has(String(event.data.message.source.callId))) return []
    return event.data.message.content[0].content.flatMap(
      block => (block.type === 'text' ? [block.text] : []),
    )
  })
}

describe('web e2e: the agent reads the page in the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The recording lands in a directory of its own, created here so the first
    // record run writes rather than failing on a missing path.
    if (MODE === 'record') await mkdir(dirname(FIXTURE), { recursive: true })
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({
      harnessHome,
      extraOverlayPath: OVERLAY,
      ...(MODE === 'record' ? {} : { replayFixture: FIXTURE, paceMs: 15 }),
    })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    await seedSession(scaffold, withShownPage(await readFile(SEED, 'utf8'), 'home'), SEEDED_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.locator('[data-shell-column="content"]').waitFor({ state: 'attached', timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    await openSession(page, 1)
    // The read is defined as the page in front of the user, so the frame has to
    // be showing it before the turn starts.
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

  it('answers the user by reading the page a real browser is showing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    // The row states the fact and nothing else; the listing is the model's.
    await page.locator('[data-content-read-stage="done"]').first().waitFor({ timeout: 30_000 })

    const listings = readResults(sessionEvents)
    expect(listings).toHaveLength(1)
    const listing = listings[0] ?? ''
    // The header the tool composes, then the reader's own rows: the table's
    // shape reaches the model, its contents do not.
    expect(listing.startsWith('Page: Home — the app is at /content-app/')).toBe(true)
    expect(listing).toContain('3 rows')
    expect(listing).toContain('Add machine')
    // A dialog the page has not opened is on the map and nowhere else.
    expect(listing).not.toContain('Shut down the whole fleet?')
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE)
  }, 200_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
