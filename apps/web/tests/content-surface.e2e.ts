/**
 * Web e2e scenario: the content column as a stream of typed entries, with two
 * unrelated packages producing them.
 *
 * The composition is the shipped Web surface plus the router's own overlay, so
 * what runs is the real chain: two host rows register extractors, one
 * projection folds both kinds out of the seeded log, the tail page carries the
 * entries to the browser, and the column routes each one to the keyed renderer
 * its kind names. The seeded session carries a shown page, a redrawn chart
 * (two calls, one id), and a second chart, so the switcher has to show three
 * entries rather than four.
 *
 * Then the one thing only a real browser can answer: whether the hosted
 * document survives being pushed aside. Selecting a chart hides the page seat
 * rather than unmounting it, and a second session mounts its own frame beside
 * the first — under either transition, an iframe that is the SAME element is
 * the whole proof, and no unit test can observe it.
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
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
const SURFACE_DIR = join(REPO_ROOT, 'packages/experimental/content-surface')
const COLUMN_DIR = join(REPO_ROOT, 'packages/experimental/content-column')
const OVERLAY = join(SURFACE_DIR, 'overlay/full-surface.patch.yml')

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', SURFACE_DIR],
  ['@deepseek-ai/dsh-experimental-content-column', COLUMN_DIR],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-tool-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-tool-poc')],
] as const

/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')
/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

const MIXED_SESSION = 'content-surface-web-e2e-mixed'
const PAGE_SESSION = 'content-surface-web-e2e-page'

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

/** Attribute the spec stamps on a live iframe element. */
const PROBE_ATTRIBUTE = 'data-dsh-probe'

/** Switcher keys the column mints, as `<kind> <entryId>`. */
const PAGE_ENTRY = 'page home'
const REPORTS_ENTRY = 'page reports'
const DEMO_ENTRY = 'chart demo'
const COVERAGE_ENTRY = 'chart coverage'

/** The line the transcript's superseded row shows, which the switcher must NOT list. */
const DEMO_DRAFT_TITLE = 'Coverage, first draft'

/** A bar option small enough to read and large enough to paint. */
const OPTION = {
  animation: false,
  xAxis: { type: 'category', data: ['Mon', 'Tue', 'Wed'] },
  yAxis: { type: 'value' },
  series: [{ type: 'bar', data: [120, 200, 150] }],
}

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-surface-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/** One settled `show_chart` call, as the log records it. */
function chartCall(callId: string, id: string, title: string): string[] {
  return [
    JSON.stringify({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'show_chart', arguments: JSON.stringify({ id, title, option: OPTION }) },
    }),
    JSON.stringify({
      type: 'tool/result',
      data: { turn: 1, step: 1, callId, content: [{ type: 'text', text: `Rendered: ${title}` }], isError: false },
      surfaceOp: 'append',
    }),
  ]
}

/**
 * Splice one session's content events into a recorded session, inside its open step.
 * @param fixtureText - the committed seed fixture.
 * @param lines - the event lines to splice, in order.
 * @returns the fixture text to seed.
 */
function withEvents(fixtureText: string, lines: readonly string[]): string {
  const all = fixtureText.split('\n')
  const closing = all.findIndex(line => line.includes('"type":"step/end"'))
  if (closing === -1) throw new Error('seed fixture has no step/end to splice before')
  return [...all.slice(0, closing), ...lines, ...all.slice(closing)].join('\n')
}

/** One shown page, as the log records it. */
function shownPage(page: string): string {
  return JSON.stringify({ type: 'content/shown', data: { page } })
}

const column = (page: Page, name: string): Locator => page.locator(`[data-shell-column="${name}"]`)
const switcherEntry = (page: Page, key: string): Locator => page.locator(`[data-content-surface-entry="${key}"]`)
const activeSeat = (page: Page): Locator => page.locator('[data-content-surface-seat][data-content-surface-active]')
const activeFrame = (page: Page): Locator => page.locator('iframe[data-content-frame][data-content-active]')

/** Save one screenshot under the repository's artifact directory. */
async function evidence(page: Page, name: string): Promise<void> {
  // Evidence for the composition, not a failure artifact.
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true })
}

/** Open the sidebar session row whose title cell is at `index` and wait for its composer. */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.getByPlaceholder(COMPOSER_PLACEHOLDER).waitFor({ timeout: 15_000 })
}

/** Select one switcher entry and wait for its seat to take the column. */
async function select(page: Page, key: string): Promise<void> {
  await switcherEntry(page, key).click()
  await expect.poll(async () => await activeSeat(page).getAttribute('data-content-surface-seat'), { timeout: 15_000 })
    .toBe(key.split(' ')[0])
}

/** The switcher keys the column lists, in the order it lists them. */
async function listedEntries(page: Page): Promise<string[]> {
  return await page.locator('[data-content-surface-entry]').evaluateAll(nodes =>
    nodes.map(node => node.getAttribute('data-content-surface-entry') ?? ''))
}

/** Marks the shown frame carries while a spec drives navigation around it. */
interface FrameProbe {
  /** Stamped on the iframe element: null again once React mounted a new one. */
  element: string | null
  /** Stamped inside the hosted document: absent again once the frame loaded a new one. */
  document: string | undefined
  /** How many times the hosted document executed; a fresh frame starts at 1. */
  loads: number | undefined
}

/** A frame that survived every transition since it was stamped. */
const KEPT: FrameProbe = { element: 'kept', document: 'kept', loads: 1 }

/** The hosted document's global, as this spec reads it: the fixture's load counter and the probe's own mark. */
interface HostedWindow {
  __dshProbe?: string
  __contentAppLoads?: number
}

/**
 * Stamp the shown frame and its document, then read both back.
 * @param page - the browsing page.
 * @param stamp - mark to write, or undefined to read only.
 * @returns the marks, or undefined while no shown frame has a live document.
 */
async function probeFrame(page: Page, stamp: string | undefined): Promise<FrameProbe | undefined> {
  return await page.evaluate(([mark, attribute]: [string | undefined, string]) => {
    const element = document.querySelector<HTMLIFrameElement>('iframe[data-content-frame][data-content-active]')
    const inner = element?.contentWindow as unknown as HostedWindow | null | undefined
    if (element === null || inner === null || inner === undefined) return undefined
    if (mark !== undefined) {
      element.setAttribute(attribute, mark)
      inner.__dshProbe = mark
    }
    return {
      element: element.getAttribute(attribute),
      document: inner.__dshProbe,
      loads: inner.__contentAppLoads,
    }
  }, [stamp, PROBE_ATTRIBUTE] as [string | undefined, string])
}

describe.skipIf(MODE === 'record')('web e2e: the content column as an entry stream', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
    const fixture = await readFile(FIXTURE, 'utf8')
    // One session with both kinds, the chart pair sharing an id so the older
    // call is superseded, and the newest entry a chart.
    await seedSession(scaffold, withEvents(fixture, [
      shownPage('home'),
      ...chartCall('call_00_demo_old', 'demo', DEMO_DRAFT_TITLE),
      ...chartCall('call_00_demo_new', 'demo', 'Coverage'),
      ...chartCall('call_00_coverage', 'coverage', 'Traffic sources'),
    ]), MIXED_SESSION)
    // A second session with a stream of its own, on the other configured page.
    await seedSession(scaffold, withEvents(fixture, [shownPage('reports')]), PAGE_SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await column(page, 'content').waitFor({ timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('lists one entry per chart and page, and shows the newest', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-surface-stream'))
    await openMixedSession(page)

    // Four logged calls, three entries: the redrawn chart is one row, owned by
    // the later call, and the shown page is the oldest of the three.
    expect(await listedEntries(page)).toEqual([COVERAGE_ENTRY, DEMO_ENTRY, PAGE_ENTRY])
    expect(await page.getByText(DEMO_DRAFT_TITLE, { exact: true }).count()).toBe(0)

    // The newest entry is on display, painted by a real engine.
    expect(await activeSeat(page).getAttribute('data-content-surface-seat')).toBe('chart')
    const canvas = column(page, 'content').locator('canvas').first()
    await canvas.waitFor({ timeout: 30_000 })
    const box = await canvas.boundingBox()
    expect({ wide: (box?.width ?? 0) > 0, tall: (box?.height ?? 0) > 0 }).toEqual({ wide: true, tall: true })
    await evidence(page, 'content-surface-newest-chart')
  }, 120_000)

  it('keeps the hosted document alive while a chart holds the column', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-surface-keepalive'))
    await select(page, PAGE_ENTRY)
    await activeFrame(page).waitFor({ timeout: 15_000 })
    const inner = page.frameLocator('iframe[data-content-frame][data-content-active]')
    await inner.locator('#fixture-heading').waitFor({ timeout: 15_000 })
    expect(await probeFrame(page, 'kept')).toEqual(KEPT)
    await evidence(page, 'content-surface-page-entry')

    await select(page, COVERAGE_ENTRY)
    // The chart took the column and the page seat is merely hidden.
    expect(await activeFrame(page).count()).toBe(0)

    await select(page, PAGE_ENTRY)
    // Both marks survived: the same element, still holding the document it
    // loaded once. An unmounted seat would have destroyed both.
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(KEPT)
  }, 120_000)

  it('gives each session its own stream and keeps the first session\'s frame', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-surface-sessions'))
    await openPageSession(page)
    // A session that showed one page and drew nothing has exactly that entry.
    expect(await listedEntries(page)).toEqual([REPORTS_ENTRY])
    await activeFrame(page).waitFor({ timeout: 15_000 })
    expect(await activeFrame(page).getAttribute('src')).toBe('/content-app/reports/')
    await evidence(page, 'content-surface-second-session')

    await openMixedSession(page)
    // Back to the first session's own choice, on the very same element.
    await expect.poll(async () => await probeFrame(page, undefined), { timeout: 15_000 }).toEqual(KEPT)
    expect(await listedEntries(page)).toEqual([COVERAGE_ENTRY, DEMO_ENTRY, PAGE_ENTRY])
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})

/** Open the session carrying both content kinds, whichever sidebar row it is. */
async function openMixedSession(page: Page): Promise<void> {
  await openSessionShowing(page, [COVERAGE_ENTRY, DEMO_ENTRY, PAGE_ENTRY])
}

/** Open the session carrying only the reports page. */
async function openPageSession(page: Page): Promise<void> {
  await openSessionShowing(page, [REPORTS_ENTRY])
}

/**
 * Open whichever of the two seeded sessions lists `expected`.
 *
 * The sidebar's row order is the host's, not this spec's, so a row is
 * identified by the stream its own log produced rather than by an assumed
 * index.
 * @param page - the browsing page.
 * @param expected - the switcher keys that session's log yields.
 */
async function openSessionShowing(page: Page, expected: readonly string[]): Promise<void> {
  for (const index of [1, 2]) {
    await openSession(page, index)
    const listed = await waitForEntries(page)
    if (listed.length === expected.length && listed.every((key, at) => key === expected[at])) return
  }
  throw new Error(`no seeded session lists ${expected.join(', ')}`)
}

/** Wait until the column has published this session's entries, then read them. */
async function waitForEntries(page: Page): Promise<string[]> {
  await expect.poll(async () => (await listedEntries(page)).length, { timeout: 15_000 }).toBeGreaterThan(0)
  return await listedEntries(page)
}
