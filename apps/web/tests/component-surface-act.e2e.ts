/**
 * Web e2e scenario: `act_component` presses one button of a confirmation bar
 * the user is looking at, and the press it causes comes back as the agent's own.
 *
 * The composition is the component rows of `component-surface.e2e.ts` plus
 * `content-frame`, whose shared content channel is what carries an
 * `act_component` call to the tab showing the session. The seed places one
 * `el.confirm-bar` with three buttons; every button performs the bar's single
 * `press` action and carries its button id as its own key.
 *
 * The model is a committed script, so the calls are fixed and the outcomes are
 * the real ones: the host's argument check, the browser's step executor against
 * the drawn bar, the `/component-action` command the press reports through, and
 * the notice the command hands the running turn. The script's last reply opens
 * with a `{{fromRequest:}}` pattern on the sentence a report caused by the
 * agent's own step opens with, so that reply exists only if the notice built
 * from the press carried it into the model's request.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { toolResults } from './content-column.ts'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./component-surface-act.overlay.yml', import.meta.url))
/**
 * The five model answers of the prompt's turn, written by hand: three
 * `act_component` calls, one `read_component` call, and the closing reply. The
 * read is one further channel round trip after the press, so the notice the
 * press reported has reached the turn's inbox before the closing request is
 * composed.
 */
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-act/replay.override.json', import.meta.url))
/** The hosted application `content-frame` serves; the overlay reads it from the environment. */
const APP_ROOT = join(REPO_ROOT, 'packages/experimental/content-frame/tests/fixtures/app')

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', join(REPO_ROOT, 'packages/experimental/content-frame')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const

/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

const SESSION = 'component-surface-act-web-e2e'

/** The entry the seed places, and what the bar in it says. */
const BUDGET_ID = 'budget'
const BUDGET_TITLE = 'Budget approval'
const BUDGET_PROMPT = 'Approve the revised budget?'
const APPROVE_ID = 'approve'
const APPROVE_LABEL = 'Approve'

/** The bar the seed places: three buttons sharing the bar's one `press` action. */
const BUDGET_SPEC = {
  nodes: [{
    id: 'ask',
    component: 'el.confirm-bar',
    props: {
      title: BUDGET_PROMPT,
      buttons: [
        { id: APPROVE_ID, label: APPROVE_LABEL, tone: 'primary' },
        { id: 'later', label: 'Decide later' },
        { id: 'reject', label: 'Reject', tone: 'danger' },
      ],
    },
  }],
}

/** What the user asks. */
const PROMPT = 'Approve the budget for me.'

/** The `act_component` call that pressed the bar, whose id the press's report names. */
const PRESSING_CALL = 'call_00_act000000000000000000000003'

/** The host's refusal of the first call: a click naming a control by its action key takes no `name`. */
const NAME_REFUSAL = 'step 1: a click presses one control named by its key, so it takes no "name".'
/** The step failure the second call reports: `press` names every button drawn, and the sentence lists their own keys. */
const SHARED_FAILURE = '- click on "press": action "press" names 3 drawn controls in the entry; '
  + 'name the one to press by its own key: approve, later, reject.'
/** The third call's step line. */
const PRESSED_LINE = `- click on "${APPROVE_ID}": done`

/** The sentence a report the agent's own step caused opens with. */
const OWN_STEP_OPENING = 'This report comes from step 1 of your own call acting on this entry, not from the user: '
/** What the agent is told about the press, marked as its own. */
const PRESS_TEXT = `${OWN_STEP_OPENING}You pressed "${APPROVE_LABEL}" in content panel entry "${BUDGET_ID}" `
  + `("${BUDGET_TITLE}"), on the 确认条 block "ask".`
/** The summary the notice declares, naming the assistant as who pressed. */
const PRESS_SUMMARY = `助手在「${BUDGET_TITLE}」里点了「${APPROVE_LABEL}」`
/** The plugin kind the command posts its notice under. */
const NOTICE_PLUGIN: string = 'content-component'

/** The closing reply, whose step number llm-replay read out of the request the notice was in. */
const MODEL_REPLY = 'Step 1 of my own call pressed Approve; the revised budget is approved.'

/** The line the bar draws once its press was recorded, in this lane's English. */
const SENT_LINE = 'Sent to the conversation'
/** The line the bar draws for a press left waiting on the user's next message, in this lane's English. */
const QUEUED_LINE = 'Noted — the conversation will see it with your next message'
/** The command's own answer for a press left waiting, which the transcript would draw as a row. */
const ACTION_QUEUED = '已记下，你下次发消息时对话会看到。'

/**
 * The composer of the open session.
 * @param page - the page under test.
 * @returns the composer input locator.
 */
function composerInput(page: Page): Locator {
  return page.locator('[data-composer-input]').first()
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-surface-act-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * Splice one settled `show_component` call placing {@link BUDGET_SPEC} into the
 * recorded session, inside its open step.
 *
 * A format-4 log advertises the call in an assistant message before its
 * `tool/call` and settles it with an identified tool-role result message; their
 * identities take ordinals 7 and 8 of the seed fixture's `{{message:N}}` token
 * space, which ordinals 1-6 already use.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withBudgetCall(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"step/end"'))
  if (closing === -1) throw new Error('seed fixture has no step/end to splice before')
  const callId = 'call_00_component_budget'
  const args = JSON.stringify({ id: BUDGET_ID, title: BUDGET_TITLE, spec: BUDGET_SPEC })
  return [
    ...lines.slice(0, closing),
    JSON.stringify({
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: '{{message:7}}',
          role: 'assistant',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4-flash' },
          content: [{ type: 'tool-call', id: callId, name: 'show_component', arguments: args }],
        },
        stream: [],
      },
      surfaceOp: 'append',
    }),
    JSON.stringify({ type: 'tool/call', data: { turn: 1, step: 1, callId, name: 'show_component', arguments: args } }),
    JSON.stringify({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        message: {
          id: '{{message:8}}',
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: `Now showing "${BUDGET_TITLE}" in the content panel.` }],
          isError: false,
        },
      },
      surfaceOp: 'append',
    }),
    ...lines.slice(closing),
  ].join('\n')
}

/**
 * The scenario session's log as the running host holds it.
 * @param scaffold - the booted scaffold.
 * @returns every event the session carries, in order.
 */
function liveEvents(scaffold: WebScaffold): readonly SessionEvent[] {
  const agent = scaffold.ctx.agents.get(SessionId(SESSION))
  if (agent === undefined) throw new Error(`no live agent for ${SESSION}`)
  return agent.session.snapshotEvents()
}

describe.skipIf(MODE === 'record')('web e2e: act_component presses one button of a drawn bar', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY, replayOverride: REPLAY })
    await seedSession(scaffold, withBudgetCall(await readFile(FIXTURE, 'utf8')), SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    const row = page.locator('[role="treeitem"]').nth(1)
    await row.waitFor({ timeout: 15_000 })
    await row.click()
    await composerInput(page).waitFor({ timeout: 15_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('refuses a target its action ignores, names the own keys a shared action needs, and presses the one named', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-act'))
    const approve = seat(page).locator(`[data-component-action="press"][data-component-key="${APPROVE_ID}"]`)
    await expect.poll(async () => await approve.textContent(), { timeout: 30_000 }).toBe(APPROVE_LABEL)
    // The column widens once the session's surface has an entry; a step acts on
    // the entry in front, so the bar must be on display before the turn starts.
    await expect.poll(async () => (await seat(page).boundingBox())?.width ?? 0, { timeout: 15_000 })
      .toBeGreaterThan(200)

    const settled = scaffold.whenTurnSettled(90_000)
    await writeComposerDraft(page, composerInput(page), PROMPT)
    await page.keyboard.press('Enter')
    await settled

    const events = liveEvents(scaffold)
    const answers = toolResults(events, 'act_component')
    expect(answers.length).toBe(3)
    // The first call is refused whole by the host: a click names its control by
    // its key alone, and a `name` beside it would have been dropped.
    expect(answers[0]).toContain(NAME_REFUSAL)
    // The second reached the bar and pressed nothing: `press` is every button's
    // action, so the step fails and lists the keys that tell them apart.
    expect(answers[1]).toContain(SHARED_FAILURE)
    // The third names one button by its own key.
    expect(answers[2]).toContain(PRESSED_LINE)

    // One press reached the host, and it is the approve button's.
    const runs = events.filter(event => event.type === 'command/run' && event.data.name === 'component-action')
    expect(runs.length).toBe(1)
    const run = runs[0]
    const args = run?.type === 'command/run' ? run.data.args ?? '' : ''
    expect(JSON.parse(args)).toEqual({
      entryId: BUDGET_ID,
      componentId: 'el.confirm-bar',
      actionId: 'press',
      nodeId: 'ask',
      payload: { buttonId: APPROVE_ID },
      step: { call: PRESSING_CALL, index: 1 },
    })
    expect(await approve.getAttribute('disabled')).not.toBeNull()
  }, 180_000)

  it('tells the agent the press was its own step\'s, in the turn it ran in, and leaves the user no queued line', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-act-report'))
    const events = liveEvents(scaffold)
    const notices = events.filter(event => event.type === 'user/message' && event.data.source.kind === NOTICE_PLUGIN)
    expect(notices.length).toBe(1)
    const notice = notices[0]
    expect(notice?.type === 'user/message' && notice.data.content).toEqual([{ type: 'text', text: PRESS_TEXT }])
    expect(notice?.type === 'user/message' && notice.data.source).toEqual({
      kind: NOTICE_PLUGIN,
      form: 'notice',
      summary: PRESS_SUMMARY,
    })
    expect(JSON.stringify(notice)).not.toContain('The user')

    // No turn of its own: the seed closed turn 1 and the prompt opened turn 2,
    // which claimed the notice before it ended.
    const opened = events.filter(event => event.type === 'turn/start')
    expect(opened.length).toBe(2)
    const ended = events.filter(event => event.type === 'turn/end')
    expect(ended.length).toBe(2)
    expect(notice?.seq ?? 0).toBeGreaterThan(opened[1]?.seq ?? Infinity)
    expect(notice?.seq ?? Infinity).toBeLessThan(ended[1]?.seq ?? 0)

    // The closing reply's step number was read out of the request the notice was in.
    await expect.poll(async () => await page.getByText(MODEL_REPLY, { exact: false }).count(), { timeout: 30_000 })
      .toBe(1)

    // The bar says the press was sent, and nothing on the page says it waits
    // for the user's next message.
    const state = seat(page).locator('[data-component-state]')
    await expect.poll(async () => await state.getAttribute('data-component-state'), { timeout: 15_000 }).toBe('sent')
    expect(await state.textContent()).toBe(SENT_LINE)
    expect(await page.getByText(QUEUED_LINE, { exact: false }).count()).toBe(0)
    expect(await page.getByText(ACTION_QUEUED, { exact: false }).count()).toBe(0)
    expect(await page.locator('[data-component-action-waiting]').count()).toBe(0)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-surface-act.png'), fullPage: true })

    // And still no further turn once the page has settled.
    await new Promise<void>((resolve) => { setTimeout(resolve, 2_000) })
    expect(liveEvents(scaffold).filter(event => event.type === 'turn/start').length).toBe(2)
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
