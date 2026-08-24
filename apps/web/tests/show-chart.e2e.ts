/**
 * Web e2e scenario: `show_chart` calls painted as live Vue 2.7 ECharts charts
 * inside the conversation transcript.
 *
 * Two compositions, because the placement claims a keyed tool-view rather than
 * a column and is therefore layout-independent: the shipped Web surface plus
 * the tool's own overlay (what `develop` would run), and the service-line shell
 * where the same component row also fills the content column. The seeded log
 * carries four settled calls, so what the assertions read is the replay path —
 * the transcript hands each row its call slice, the row sanitizes the option and
 * paints it, and only a real engine can answer whether a sized canvas came out.
 *
 * The last two calls share one chart id. That pair covers the whole supersede
 * path end to end: the host folds both calls into the `showCharts` projection,
 * the browser reads it through the standard projection hook, and the older row
 * collapses to a notice while the newer one paints.
 *
 * The live await path — a tool body blocked on the browser's verdict — is
 * covered by the package's host specs against a fake reporter; a keyless replay
 * lane runs no model and therefore issues no live call.
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
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const TOOL_DIR = join(REPO_ROOT, 'packages/experimental/vue2-echarts-tool-poc')
const OFFICIAL_OVERLAY = join(TOOL_DIR, 'overlay/show-chart.patch.yml')
const THREE_COLUMN_OVERLAY = join(TOOL_DIR, 'overlay/show-chart-three-column.patch.yml')

/** Every experimental row either overlay may insert, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-content-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-content-poc')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc', TOOL_DIR],
] as const

/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** The four seeded calls, by call id and caption. */
const BAR_CALL = 'call_00_chart_bar'
const PIE_CALL = 'call_00_chart_pie'
const DEMO_OLD_CALL = 'call_00_chart_demo_old'
const DEMO_NEW_CALL = 'call_00_chart_demo_new'
const BAR_TITLE = 'Weekly revenue'
const PIE_TITLE = 'Traffic sources'
const DEMO_OLD_TITLE = 'Coverage, first draft'
const DEMO_NEW_TITLE = 'Coverage'

/** The chart id the last two calls share, so the newer one replaces the older row. */
const DEMO_ID = 'demo'

/** The superseded row's English copy, as this package's dictionary states it. */
const SUPERSEDED_NOTICE = `${DEMO_OLD_TITLE}: updated by a later call.`

/** The bar option the seeded call carries. */
const BAR_OPTION = {
  animation: false,
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', name: BAR_TITLE, data: [120, 200, 150, 80, 70] }],
}

/** The pie option the seeded call carries. */
const PIE_OPTION = {
  animation: false,
  legend: { top: 'bottom' },
  series: [{
    type: 'pie',
    name: PIE_TITLE,
    radius: '55%',
    data: [
      { value: 1048, name: 'Search' },
      { value: 735, name: 'Direct' },
      { value: 580, name: 'Referral' },
    ],
  }],
}

/** The line option the older `demo` call carries; a later call replaces it. */
const DEMO_OLD_OPTION = {
  animation: false,
  xAxis: { type: 'category', data: ['Q1', 'Q2', 'Q3'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', name: DEMO_OLD_TITLE, data: [3, 5, 4] }],
}

/** The radar option the newer `demo` call carries — a different chart under the same id. */
const DEMO_NEW_OPTION = {
  animation: false,
  legend: { bottom: 0 },
  radar: {
    indicator: [{ name: 'Speed', max: 100 }, { name: 'Reach', max: 100 }, { name: 'Cost', max: 100 }],
  },
  series: [{ type: 'radar', name: DEMO_NEW_TITLE, data: [{ value: [80, 60, 40], name: DEMO_NEW_TITLE }] }],
}

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-show-chart-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/** One settled `show_chart` call, as the log records it. */
function chartCall(callId: string, title: string, option: unknown, points: number, id?: string): string[] {
  const args = JSON.stringify({ ...id === undefined ? {} : { id }, title, option })
  return [
    JSON.stringify({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'show_chart', arguments: args },
    }),
    JSON.stringify({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId,
        content: [{ type: 'text', text: `Rendered: ${title} — 1 series, ${points} points` }],
        isError: false,
      },
      surfaceOp: 'append',
    }),
  ]
}

/**
 * Splice four settled chart calls into a recorded session, inside its open step.
 * The last two share one chart id, older first, so the transcript carries both
 * a superseded row and the call that replaced it.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withChartCalls(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"step/end"'))
  if (closing === -1) throw new Error('seed fixture has no step/end to splice before')
  return [
    ...lines.slice(0, closing),
    ...chartCall(BAR_CALL, BAR_TITLE, BAR_OPTION, 5),
    ...chartCall(PIE_CALL, PIE_TITLE, PIE_OPTION, 3),
    ...chartCall(DEMO_OLD_CALL, DEMO_OLD_TITLE, DEMO_OLD_OPTION, 3, DEMO_ID),
    ...chartCall(DEMO_NEW_CALL, DEMO_NEW_TITLE, DEMO_NEW_OPTION, 3, DEMO_ID),
    ...lines.slice(closing),
  ].join('\n')
}

/** The transcript row of one call, addressed by the call id the host logged. */
const callRow = (page: Page, callId: string): Locator => page.locator(`[data-chat-call-id="${callId}"]`)

/** The revealed chart stage inside one call's row. */
const verifiedStage = (page: Page, callId: string): Locator =>
  callRow(page, callId).locator('[data-show-chart-stage][data-verified="yes"]')

/** One element's rendered box. */
async function box(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
  const rect = await locator.boundingBox()
  if (rect === null) throw new Error('element is not rendered')
  return rect
}

/** Save one screenshot under the repository's artifact directory. */
async function evidence(page: Page, name: string): Promise<void> {
  // Evidence for the composition, not a failure artifact.
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true })
}

/** One booted world: the scaffold, the browser, and the console tripwire. */
interface World {
  scaffold: WebScaffold
  browser: Browser
  page: Page
  harnessHome: string
  tripwire: ReturnType<typeof watchConsole>
  consoleErrors: string[]
}

/** Boot one composition, seed the chart session, and open it. */
async function openWorld(overlayPath: string, sessionId: string): Promise<World> {
  const harnessHome = await harnessHomeWithRowLinks()
  const scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: overlayPath })
  await seedSession(scaffold, withChartCalls(await readFile(FIXTURE, 'utf8')), sessionId)

  const browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  const consoleErrors: string[] = []
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
  // The workspace group row precedes its sessions; expanding it lists them.
  await page.locator('[role="treeitem"]').first().click()
  const row = page.locator('[role="treeitem"]').nth(1)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
  return { scaffold, browser, page, harnessHome, tripwire, consoleErrors }
}

/** Tear one world down. */
async function closeWorld(world: World | undefined): Promise<void> {
  if (world === undefined) return
  await world.browser.close()
  await world.scaffold.close()
  await rm(world.harnessHome, { recursive: true, force: true })
}

/** One call's row painted a sized canvas. */
async function assertPainted(page: Page, callId: string): Promise<void> {
  await verifiedStage(page, callId).waitFor({ timeout: 30_000 })
  const painted = await box(callRow(page, callId).locator('canvas').first())
  expect({ callId, wide: painted.width > 0, tall: painted.height > 0 })
    .toEqual({ callId, wide: true, tall: true })
}

/**
 * The `demo` id belongs to the newer call: the older row collapsed to the
 * notice with no engine behind it, and the newer one painted.
 */
async function assertSupersededRow(page: Page): Promise<void> {
  const older = callRow(page, DEMO_OLD_CALL)
  await older.getByText(SUPERSEDED_NOTICE, { exact: true }).waitFor({ timeout: 30_000 })
  // No canvas at all in the superseded row: it mounts no chart, so it also
  // reports no verdict for a call that settled long ago.
  expect(await older.locator('canvas').count()).toBe(0)
  await assertPainted(page, DEMO_NEW_CALL)
}

/** Both id-less charts painted a sized canvas inside their own transcript rows. */
async function assertChartsInTranscript(page: Page): Promise<void> {
  for (const [callId, title] of [[BAR_CALL, BAR_TITLE], [PIE_CALL, PIE_TITLE]] as const) {
    await assertPainted(page, callId)
    // The caption the call carried, in the row that owns the call id.
    expect(await callRow(page, callId).getByText(title, { exact: true }).count()).toBeGreaterThan(0)
  }
}

describe.skipIf(MODE === 'record')('web e2e: show_chart under the shipped layout', () => {
  let world: World | undefined

  beforeAll(async () => {
    world = await openWorld(OFFICIAL_OVERLAY, 'show-chart-web-e2e-official')
  }, 180_000)

  afterAll(async () => {
    await closeWorld(world)
    world = undefined
  })

  it('paints both seeded calls as sized canvases inside the conversation', async () => {
    const page = (world as World).page
    onTestFailed(() => saveFailureShot(page, 'web-e2e-show-chart-official'))
    await assertChartsInTranscript(page)
    // Two rows, two engines: neither call borrowed the other's canvas.
    expect(await page.locator('[data-show-chart-stage] canvas').count()).toBeGreaterThanOrEqual(2)
    await evidence(page, 'web-e2e-show-chart-official')
  }, 120_000)

  it('collapses the chart a later call redrew and paints the call that replaced it', async () => {
    const page = (world as World).page
    onTestFailed(() => saveFailureShot(page, 'web-e2e-show-chart-supersede'))
    await assertSupersededRow(page)
    await evidence(page, 'web-e2e-show-chart-supersede')
  }, 120_000)

  it('leaves the console clean', () => {
    const live = world as World
    expect(live.tripwire.pageErrors).toEqual([])
    expect(live.consoleErrors).toEqual([])
    expect(live.tripwire.warnings).toEqual([])
  })
})

describe.skipIf(MODE === 'record')('web e2e: show_chart under the service-line shell', () => {
  let world: World | undefined

  beforeAll(async () => {
    world = await openWorld(THREE_COLUMN_OVERLAY, 'show-chart-web-e2e-three-column')
  }, 180_000)

  afterAll(async () => {
    await closeWorld(world)
    world = undefined
  })

  it('paints the transcript charts and the content panel from one component row', async () => {
    const page = (world as World).page
    onTestFailed(() => saveFailureShot(page, 'web-e2e-show-chart-three-column'))
    await assertChartsInTranscript(page)

    // The other placement of the same row, in the column only this shell opens:
    // one Vue runtime, two consumers.
    const panel = page.locator('[data-shell-column="content"] canvas').first()
    await panel.waitFor({ timeout: 30_000 })
    const painted = await box(panel)
    expect({ wide: painted.width > 0, tall: painted.height > 0 }).toEqual({ wide: true, tall: true })
    await evidence(page, 'web-e2e-show-chart-three-column')
  }, 120_000)

  it('collapses the chart a later call redrew under this shell too', async () => {
    const page = (world as World).page
    onTestFailed(() => saveFailureShot(page, 'web-e2e-show-chart-supersede-three-column'))
    await assertSupersededRow(page)
    await evidence(page, 'web-e2e-show-chart-supersede-three-column')
  }, 120_000)

  it('leaves the console clean', () => {
    const live = world as World
    expect(live.tripwire.pageErrors).toEqual([])
    expect(live.consoleErrors).toEqual([])
    expect(live.tripwire.warnings).toEqual([])
  })
})
