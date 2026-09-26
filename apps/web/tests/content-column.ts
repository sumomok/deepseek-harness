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

import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { expect } from 'vitest'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ReplayProviderConfig } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, launchWebScaffold, seedSession, selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT } from './support.ts'

/**
 * The preset a content-column scenario that must not reach past the column is
 * composed from: a persona, and no tools at all.
 *
 * Every model tool in the Web profile comes from a preset —
 * `packages/bundle/web-app/cordis.patch.yml` disables all of its `tool-*` rows
 * and the `standard` preset mounts them again behind the preset realm — so a
 * profile patch layer cannot take `bash` or `read_image` away from a scenario;
 * naming a preset that never mounts them is what does. What the session is
 * left with is the host plane's own contributions, which for this composition
 * is the content column: `content_show` and the reads and steps the
 * `content-frame` row registers. A scenario about what a page draws must not be
 * able to answer by shelling out, and a recording that installs packages over
 * the network is not a recording anything can replay.
 */
export const CONTENT_COLUMN_PRESET: PresetDefinition = {
  id: 'content-column',
  name: 'Content column only',
  description: 'A session whose only tools are the content column\'s.',
  order: 90,
  plugins: [{
    id: 'persona',
    name: '@deepseek-ai/dsh-persona',
    config: {
      prefix: 'You are an assistant powered by the {{model}} model, working with the user in a console.'
        + ' Your working directory is {{cwd}}.',
    },
  }],
}

/**
 * The customer console's own Agent preset, restated from the `preset-console`
 * row of `packages/experimental/console-profile/cordis.patch.yml`: its persona,
 * the file tools, the skill catalog and loader, compaction, the question tool
 * and the todo list — no shell, no file search, no web tool, and no working
 * directory in the persona.
 *
 * The scenarios about reading markup compose this, because the `standard`
 * preset hands the model a shell, a file search and a web fetch, and with those
 * it read the fixture application's source off disk and fetched the hosted page
 * over HTTP instead of reading what the browser rendered.
 */
export const CONSOLE_PRESET: PresetDefinition = {
  id: 'console',
  name: 'Console',
  description: 'The customer console\'s tool set.',
  order: 90,
  plugins: [
    {
      id: 'persona',
      name: '@deepseek-ai/dsh-persona',
      config: { prefix: '你是数据控制台助手。用户问到的数据，一律通过组件展示给用户看；不要描述你的工作目录、工具或内部实现。' },
    },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
  ],
}

/** Every tool a session composed from {@link CONSOLE_PRESET} is offered: the preset's and the content column's. */
export const CONSOLE_OFFERED = [
  'ask_user_question',
  'content_act',
  'content_read',
  'content_read_attrs',
  'content_read_dom',
  'content_read_dom_content',
  'content_read_image',
  'content_show',
  'edit',
  'read',
  'read_image',
  'skill',
  'todo_write',
  'write',
]

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
 * What every one of these scenarios seeds before it drives its own turn: a
 * closed turn whose only event puts the hosted page in the column. A session
 * has to exist for the sidebar to open one, and the page has to be showing
 * before a turn starts. The turn holds no model call, so the scenario's
 * recording is the whole session and replays from its first model call.
 */
const SEED = [
  { type: 'session', version: 4, id: '{{session:1}}', createdAt: 0, cwd: '{{cwd}}', isSeeded: false, delegationDepth: 0 },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'content/shown', data: { page: 'home' } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
].map(record => JSON.stringify(record)).join('\n')

/**
 * The output cap and thinking efforts the `llm-deepseek` adapter publishes for
 * every catalog route (`packages/llm/llm-deepseek/src/defaults.ts`, `model-info.ts`).
 */
const ADAPTER_DEFAULTS = {
  defaultMaxTokens: 256_000,
  reasoningEfforts: ['off', 'low', 'high', 'max'],
  defaultReasoningEffort: 'high',
}

/**
 * The routes a content-column session is offered in replay, restating the
 * shipped `llm-deepseek` default catalog (`packages/llm/llm-deepseek/src/models.ts`)
 * that a recording runs against, so a replayed request writes the same request
 * header the recorded one did.
 */
export const CONTENT_COLUMN_REPLAY_PROVIDERS: ReplayProviderConfig[] = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    {
      id: 'deepseek-flash',
      name: 'DeepSeek-V41-Flash',
      contextWindow: 1_000_000,
      inputModalities: ['text', 'image'],
      systemPromptUpdate: 'in-history',
      toolUpdate: 'addition-only',
      ...ADAPTER_DEFAULTS,
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
      contextWindow: 1_000_000,
      ...ADAPTER_DEFAULTS,
    },
  ],
}]

/** The route a content-column session runs on unless its scenario names another. */
const DEFAULT_ROUTE = { provider: 'deepseek-official', model: 'deepseek-flash' } as const

/**
 * Where one scenario's own recording lives, which the corpus fixes.
 * @param scenario - the scenario's name.
 * @returns the path to its `session.jsonl` role, whose highest generation replay selects.
 */
export function fixtureFor(scenario: string): string {
  return join(REPO_ROOT, 'snapshots/web', scenario, 'session.jsonl')
}

/**
 * Whether any generation of a scenario's recording is on disk.
 * @param fixture - the scenario's fixture role path, from {@link fixtureFor}.
 * @returns true when its directory holds a `session[.vN].jsonl`.
 */
export function isRecorded(fixture: string): boolean {
  const dir = dirname(fixture)
  return existsSync(dir) && readdirSync(dir).some(name => /^session(?:\.v\d+)?\.jsonl$/u.test(name))
}

/**
 * The user prompts of the recording generation replay selects.
 * @param fixture - the scenario's fixture role path, from {@link fixtureFor}.
 * @returns the recorded user prompt texts, in order.
 */
export async function recordedUserPrompts(fixture: string): Promise<string[]> {
  return fixtureUserPrompts(await readFile(await selectedSessionFixture(fixture), 'utf8'))
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
    return event.data.message.content.flatMap(
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
   * The preset this scenario's session is composed from, declared to the
   * preset registry beside the shipped ones.
   *
   * Every model tool the Web profile offers comes from a preset — the profile
   * disables all of its `tool-*` rows (`packages/bundle/web-app/cordis.patch.yml`)
   * and `standard` mounts them again — so a scenario that must not be able to
   * shell out cannot take `bash` away in a patch layer and names a preset that
   * never mounts it instead.
   */
  preset?: PresetDefinition
  /**
   * The route this scenario's session runs on, `deepseek-flash` when omitted,
   * selected on the seeded session the way the composer's model picker selects
   * one.
   *
   * The composition's `agent-default-model` row is not what routes it: the
   * scaffold overrides that row in replay only, so a session left to the
   * default would run on different routes in record and in replay.
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
      : { agentPresets: { default: 'standard', definitions: [scenario.preset] } }),
    ...(mode === 'record'
      ? {}
      : { replayFixture: fixture, replayProviders: CONTENT_COLUMN_REPLAY_PROVIDERS, paceMs: 15 }),
  })
  scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { scenario.events.push(event) })
  const sessionId = await seedSession(scaffold, SEED, `${scenario.scenario}-web-e2e`, scenario.preset?.id)
  // The same call the composer's picker makes, on the same session, before
  // anything drives a turn: it appends `model/selection`.
  const route = scenario.model ?? DEFAULT_ROUTE
  const selected = await scaffold.ctx.sessionController.selectModel({ sessionId, ...route })
  expect(selected.selected, `${scenario.scenario}: selected route`).toMatchObject(route)

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
