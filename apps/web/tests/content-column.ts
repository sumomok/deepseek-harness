/**
 * What the content-column Web scenarios share: the profile links their
 * composition needs, the seed that puts a page in the column, and the two
 * readings of a finished turn every one of them asserts on.
 *
 * One home, because the scenarios differ in the prompt, the hosted application,
 * what they assert, and at most one patch layer — and in nothing about how the
 * composition is assembled, which is why assembling it lives here as well. A
 * further scenario is a spec that imports this and says what it is for.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

/** The package these scenarios exercise. */
export const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')

/** The patch layer composing the content column over the shipped Web surface. */
const OVERLAY = join(FRAME_DIR, 'overlay/content-column.patch.yml')

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
] as const

/** The composer's own input, whose presence is the signal that a session is open. */
export const COMPOSER = '[data-composer-input]'

/**
 * The recorded round every one of these scenarios seeds before it drives its
 * own: a session has to exist for the sidebar to open one, and this is the
 * corpus's smallest complete round.
 */
const SEED = join(REPO_ROOT, 'snapshots/web/fresh-round-trip/session.jsonl')

/**
 * Where one scenario's own recording lives, which the corpus fixes.
 * @param scenario - the scenario's name.
 * @returns the path to its `session.jsonl`.
 */
export function fixtureFor(scenario: string): string {
  return join(REPO_ROOT, 'snapshots/web', scenario, 'session.jsonl')
}

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the links
 * the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 * @param prefix - what the temporary directory is named after, per scenario.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(prefix: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `dsh-${prefix}-`))
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

/**
 * Open the sidebar's nth session row and wait for its composer.
 * @param page - the browser page.
 * @param index - which session row, counting the workspace group as the first.
 */
async function openSession(page: Page, index: number): Promise<void> {
  const row = page.locator('[role="treeitem"]').nth(index)
  await row.waitFor({ timeout: 15_000 })
  await row.click()
  await page.locator(COMPOSER).first().waitFor({ timeout: 15_000 })
}

/**
 * The model-facing text of every result one tool produced in this run.
 * @param events - every session event the run recorded, in order.
 * @param tool - the tool's wire name.
 * @returns each result's text blocks, in log order.
 */
export function toolResults(events: readonly SessionEvent[], tool: string): string[] {
  const calls = new Set(events.flatMap(event => (
    event.type === 'tool/call' && event.data.name === tool ? [String(event.data.callId)] : []
  )))
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    if (!calls.has(String(event.data.message.source.callId))) return []
    return event.data.message.content[0].content.flatMap(
      block => (block.type === 'text' ? [block.text] : []),
    )
  })
}

/**
 * The text of the last answer the model wrote, which is this turn's own answer:
 * a step that only calls tools carries no text block at all, and a step that
 * says something before calling one is followed by the step that answers.
 * @param events - every session event the run recorded, in order.
 * @returns that answer, or an empty string when the turn wrote none.
 */
export function lastAnswerText(events: readonly SessionEvent[]): string {
  const answers = events.flatMap((event) => {
    if (event.type !== 'assistant/message') return []
    const text = event.data.message.content.flatMap(
      block => (block.type === 'text' ? [block.text] : []),
    ).join('')
    return text === '' ? [] : [text]
  })
  return answers.at(-1) ?? ''
}

/** What one content-column scenario is, in the terms the four differ in. */
export interface ContentColumnScenario {
  /** The scenario's name, which names its harness home and its recording's directory. */
  scenario: string
  /** The hosted application the overlay serves into the column. */
  appRoot: string
  /** Where the run appends every session event it observes, in order. */
  events: SessionEvent[]
  /**
   * The patch layer to compose instead of this package's own, for a scenario
   * whose composition differs — a route declaring image input, say. It must
   * carry everything the package's own overlay does: the scaffold takes exactly
   * one, so a scenario's layer replaces rather than extends it.
   */
  overlay?: string
  /**
   * The preset this scenario's session is composed from, as a roster root to
   * scan and the id inside it.
   *
   * Every model tool the Web profile offers comes from a preset — the profile
   * disables all of its `tool-*` rows (`packages/bundle/web-app/cordis.patch.yml`)
   * and `standard` mounts them again — so a scenario that must not be able to
   * shell out cannot take `bash` away in a patch layer and names a preset that
   * never mounts it instead.
   */
  preset?: { root: string; id: string }
  /**
   * The route this scenario's session must run on, selected on the seeded
   * session the way the composer's model picker selects one.
   *
   * A composition's `agent-default-model` row is not enough and cannot be: a
   * session that already logged a request header keeps deriving its route from
   * its own log, and the default applies only to a session that logged none
   * (`packages/api/session-controller/src/agent.ts`, `selectionFor`). The seed
   * every scenario here replays logged one, so a scenario that needs another
   * route has to select it.
   */
  model?: { provider: string; model: string }
}

/** One assembled content-column run: what a spec drives, and how it is taken down. */
export interface ContentColumnRun {
  /** The booted harness, for the session events and the turn barrier. */
  scaffold: WebScaffold
  /** The seeded session the browser opened, which this run drives. */
  sessionId: SessionId
  /** The browser page showing the harness, its content column already up. */
  page: Page
  /** The page's console watch, which every scenario asserts is clean. */
  tripwire: ReturnType<typeof watchConsole>
  /** Close the browser and the scaffold, remove the harness home, and restore the environment. */
  close: () => Promise<void>
}

/**
 * Boot the content-column composition, seed a round into the session the
 * scenario will drive, and open it in a real browser with the hosted page
 * already showing in the column.
 *
 * The frame has to be showing the page before a turn starts: a read and a step
 * are both defined as the page in front of the user, so a scenario that drove
 * its prompt first would be racing the frame's own load.
 * @param scenario - what this scenario differs in.
 * @returns the run, open at the composer of the seeded session.
 */
export async function openContentColumn(scenario: ContentColumnScenario): Promise<ContentColumnRun> {
  const mode = webSnapshotMode()
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT
  const fixture = fixtureFor(scenario.scenario)
  const harnessHome = await harnessHomeWithRowLinks(scenario.scenario)
  // The recording lands in a directory of its own, created here so the first
  // record run writes rather than failing on a missing path.
  if (mode === 'record') await mkdir(dirname(fixture), { recursive: true })
  // The overlay's `!!js` expression resolves against this process, which is
  // where the scaffold runs the Loader.
  process.env.DSH_CONTENT_APP_ROOT = scenario.appRoot
  const scaffold = await launchWebScaffold({
    harnessHome,
    extraOverlayPath: scenario.overlay ?? OVERLAY,
    ...(scenario.preset === undefined
      ? {}
      : { agentPresets: { roots: [{ path: scenario.preset.root, trust: 'user' as const }], default: 'standard' } }),
    ...(mode === 'record' ? {} : { replayFixture: fixture, paceMs: 15 }),
  })
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { scenario.events.push(event) })
  const sessionId = await seedSession(
    scaffold,
    withShownPage(await readFile(SEED, 'utf8'), 'home'),
    `${scenario.scenario}-web-e2e`,
    scenario.preset?.id,
  )
  if (scenario.model !== undefined) {
    // The same call the composer's picker makes, on the same session, before
    // anything drives a turn: it appends `model/selection`, which is the one
    // tier that outranks the route the seed logged.
    const selected = await scaffold.ctx.sessionController.selectModel({ sessionId, ...scenario.model })
    expect(selected.selected, `${scenario.scenario}: selected route`).toMatchObject(scenario.model)
  }

  const browser: Browser = await chromium.launch()
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.locator('[data-shell-column="content"]').waitFor({ state: 'attached', timeout: 30_000 })
  // The workspace group row precedes its sessions; expanding it lists them.
  await page.locator('[role="treeitem"]').first().click()
  await openSession(page, 1)
  await page.frameLocator('iframe[data-content-frame][data-content-active]')
    .locator('#fixture-heading').waitFor({ timeout: 30_000 })

  return {
    scaffold,
    sessionId,
    page,
    tripwire,
    close: async (): Promise<void> => {
      // Every step runs whatever the ones before it did: the scaffold's own
      // close is what reports a replay mismatch, and a teardown that stopped
      // there would leave the browser up and the harness home on disk.
      const failures: unknown[] = []
      await browser.close().catch((error: unknown) => failures.push(error))
      await scaffold.close().catch((error: unknown) => failures.push(error))
      await rm(harnessHome, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
      if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
      else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'content-column teardown failed')
    },
  }
}
