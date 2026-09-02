/**
 * Web e2e scenario: the agent acts on the page the user is looking at.
 *
 * The composition is the shipped Web surface plus the content-frame overlay, so
 * the whole channel is the real one — the session publishes its open call, the
 * page seat in a real browser claims it, dispatches the steps at a document a
 * real engine rendered, and posts what happened back into the waiting call.
 * jsdom can stand in for none of it: it has no layout, and a frame pointed at a
 * real route never loads there at all.
 *
 * The fixture pins what the MODEL said; the steps run for real and the
 * approval is the TEST's own click. What the assertions read is therefore the
 * document the browser itself changed.
 *
 * The application under the steps is this scenario's own — `tests/fixtures/
 * act-app` — because the read scenario's fixture is a page nothing happens on,
 * and a click has to change something for the last assertion to mean anything.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { existsSync } from 'node:fs'
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
const FIXTURE = fileURLToPath(new URL('./snapshots/content-act/session.jsonl', import.meta.url))
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
/** The hosted application these steps run against; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/act-app')
const SEEDED_SESSION = 'content-act-web-e2e'

/**
 * Whether this scenario's recording is on disk. A replay run without it is
 * skipped rather than failed: the recording needs a real key, so the spec and
 * its fixture can land in different commits, and a lane with no key must not
 * go red for a scenario nobody has recorded yet. Once the fixture is in the
 * tree this is always true.
 */
const RECORDED = existsSync(FIXTURE)

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** What the user asks. Deliberately about the page, never about the tool. */
const PROMPT = '把内容区那个表单里的机器名改成 mill-09，然后点添加'

/**
 * How long the test leaves the approval unanswered. Past the host's claim
 * window several times over, which is what makes this a regression test rather
 * than a click.
 */
const APPROVAL_DELAY_MS = 5000

/** What the box holds before anything runs, and what it holds afterwards. */
const BEFORE = 'mill-04'
const AFTER = 'mill-09'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-act-'))
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

/** The model-facing text of every `content_act` result the log recorded. */
function actResults(events: readonly SessionEvent[]): string[] {
  const calls = new Set(events.flatMap(event => (
    event.type === 'tool/call' && event.data.name === 'content_act' ? [String(event.data.callId)] : []
  )))
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    if (!calls.has(String(event.data.message.source.callId))) return []
    return event.data.message.content[0].content.flatMap(
      block => (block.type === 'text' ? [block.text] : []),
    )
  })
}

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the agent acts on the page in the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
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
    await page.locator('[role="treeitem"]').first().click()
    await openSession(page, 1)
    // The steps run against the page in front of the user, so the frame has to
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

  it('runs the steps a user approved, and answers with what the page became', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-act'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const frame = page.frameLocator('iframe[data-content-frame][data-content-active]')
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 90_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The approval is the TEST's action in every mode: the fixture pins what
    // the model said, and the gate is a real round trip through the real panel.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: MODE === 'record' ? 180_000 : 90_000 })
    // The request is composed from the arguments alone, before any browser has
    // claimed the call, so it names the column rather than the page's title.
    const reason = await panel.locator('[data-approval-scroll]').innerText()
    expect(reason).toContain('当前展示的这一项')
    expect(reason).toContain(AFTER)

    // Answered slowly on purpose. A real console found the failure this pins:
    // the tool body registers its wait only after the approval is answered, so
    // the host answers every claim `unknown` until then, and a seat that gave
    // up at the host's own claim window would have stopped bidding before the
    // wait existed. Five seconds is past every window in this composition.
    await new Promise<void>((resolve) => { setTimeout(resolve, APPROVAL_DELAY_MS) })

    // Nothing has run: the model asking is not the page changing, and until a
    // person answers, the document is exactly as the user left it.
    expect(await frame.locator('#machine-name').inputValue()).toBe(BEFORE)
    expect(await frame.locator('#added-count').getAttribute('data-added')).toBe('0')

    await panel.getByRole('button', { name: 'Allow once' }).click()
    const sessionId = await settled

    // The page the browser itself changed, read off the live document.
    await expect.poll(() => frame.locator('#machine-name').inputValue(), { timeout: 30_000 }).toBe(AFTER)
    expect(await frame.locator('#added-count').getAttribute('data-added')).toBe('1')

    const answers = actResults(sessionEvents)
    // How many calls it takes is the model's to choose — a read first, then the
    // steps, or the steps split in two — so what is pinned is what every one of
    // them promises rather than how many there were.
    expect(answers.length).toBeGreaterThanOrEqual(1)
    const last = answers.at(-1) ?? ''
    // Three sections, in order: what ran, what the page did on its own, and the
    // page as it reads now. The first is composed by the seat around the steps
    // the model sent, and the third is a whole read of the page it changed.
    expect(last).toMatch(/^Done \d+\/\d+ on Home: /)
    expect(last).toContain(`fill "Machine name" ← "${AFTER}"`)
    expect(last.split('\n').some(line => line.startsWith('Page events during these steps'))).toBe(true)
    expect(last).toContain('\nPage now:\n')
    // The message the page showed is in the second section, whether the four
    // hundred milliseconds it stays had passed by the time the report was
    // composed or not: the closing read carries it in neither case as
    // something these steps produced, which is why the watch exists.
    expect(last).toContain(`message "Added ${AFTER}"`)
    // And the closing read is of the changed page, so the model needs no
    // further call to see what it did.
    expect(last).toContain('Machines added: 1')

    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 300_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
