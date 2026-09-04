/**
 * Web e2e scenario: `show_component` calls drawn as real blocks in the content
 * column of the service-line console.
 *
 * The composition is the shipped Web surface with the console overlay: the
 * shell, the entry stream, the column that routes it by kind, the component row
 * carrying the renderers, and the row that offers the tool. The seeded log
 * carries three settled calls under two entry ids, the later of the pair last,
 * so what the assertions read is the whole path — a durable log, the `component`
 * extractor judging each recorded call, the `contentSurface` projection folding
 * one entry per id, the tail page carrying it to the browser, and finally the
 * one thing only a real browser answers: whether the block a user sees is the
 * one the surviving call placed, with its buttons and their labels.
 *
 * The press is the same path in reverse, and it is asserted here because it is
 * assertable nowhere else: `/component-action` reaches the host only through
 * `remote.commands`, which is the browser's seam, and the ACP protocol the
 * snapshot lane speaks has no command method to invoke it with. That lane
 * composes the command registry all the same — the description it pins tells
 * the model a press comes back — but it cannot press. One click here therefore
 * has to carry the whole return channel — the recorded command input, the chat
 * echo that input does not leave, the notice the agent is given, the turn it
 * opens, the collapsed row the user reads, the model's own next words, and the
 * pressed bar a tab round trip brings back still pressed — against the shipped
 * bundles, the real gateway, and a real session log.
 *
 * The live outbound path — a tool body judging a call the model is making right
 * now — is covered by the package's host specs; a keyless replay lane runs no
 * model of its own and answers the one request this scenario makes from a
 * committed script.
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
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('./snapshots/fresh-round-trip/session.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./component-surface.overlay.yml', import.meta.url))
// The one model answer this scenario consumes: the turn a press opens. Written
// by hand rather than recorded, because the press is what has to be driven and
// no key is needed to script the reply it earns. Its text is not a fixed
// string: it opens with a `{{fromRequest:}}` pattern that llm-replay resolves
// against the live request, so the reply can only be produced at all if the
// notice built from the press is in that request — a pattern matching nothing
// throws instead of answering.
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-action/session.jsonl', import.meta.url))

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const

/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

/** The composer's own English placeholder — the signal that a session is open. */
const COMPOSER_PLACEHOLDER = 'Message the agent'

const SESSION = 'component-surface-web-e2e'

/** The entry ids the three seeded calls own, and the titles the user reads. */
const BUDGET_ID = 'budget'
const CLEANUP_ID = 'cleanup'
const BUDGET_DRAFT_TITLE = 'Budget, first draft'
const BUDGET_TITLE = 'Budget approval'
const CLEANUP_TITLE = 'Clean up the branch'

/** The prompts the three seeded blocks carry, which is what the seat draws as a heading. */
const BUDGET_DRAFT_PROMPT = 'Approve the draft budget?'
const BUDGET_PROMPT = 'Approve the revised budget?'
const BUDGET_MESSAGE = 'It raises the quarterly total by one eighth.'
const CLEANUP_PROMPT = 'Delete the merged branch?'

/** The spec the superseded `budget` call placed. */
const BUDGET_DRAFT_SPEC = {
  nodes: [{
    id: 'ask',
    component: 'el.confirm-bar',
    props: {
      title: BUDGET_DRAFT_PROMPT,
      buttons: [{ id: 'approve', label: 'Approve draft', tone: 'primary' }],
    },
  }],
}

/** The spec the later `budget` call placed under the same id. */
const BUDGET_SPEC = {
  nodes: [{
    id: 'ask',
    component: 'el.confirm-bar',
    props: {
      title: BUDGET_PROMPT,
      message: BUDGET_MESSAGE,
      buttons: [
        { id: 'approve', label: 'Approve', tone: 'primary' },
        { id: 'later', label: 'Decide later' },
        { id: 'reject', label: 'Reject', tone: 'danger' },
      ],
    },
  }],
}

/** The button pressed in the return-channel test, and the words that press earns. */
const APPROVE_LABEL = 'Approve'
const APPROVE_ID = 'approve'
/**
 * The reply the scripted turn produces — which is the fixture's tail with the
 * button's name substituted into its head out of the request. Seeing this exact
 * sentence in the transcript is therefore the assertion that the notice naming
 * the pressed button reached the model.
 */
const MODEL_REPLY = `${APPROVE_LABEL} it is — I will submit the revised budget now.`
/** What the agent is told the press was, verbatim, and what the user reads on the collapsed row. */
const PRESS_TEXT = `The user pressed "${APPROVE_LABEL}" in content panel entry "${BUDGET_ID}" ("${BUDGET_TITLE}"), on the 确认条 block "ask".`
const PRESS_SUMMARY = `用户在「${BUDGET_TITLE}」里点了「${APPROVE_LABEL}」`
/** The plugin id the notice declares, which is also what the collapsed row prints as its producer. */
const NOTICE_PLUGIN = 'content-component'
/**
 * What the pressed bar itself says, in the English this lane's browser asks
 * for. The line is `component-kit`'s `confirmBar.sent`, restated here because
 * an experimental package cannot be a dependency of `apps/web`; the Chinese an
 * end user reads (`已发送到对话`) is pinned in that package's own spec.
 */
const SENT_LINE = 'Sent to the conversation'
/**
 * The one sentence every unrecordable gesture earns, as `command.ts` writes it.
 * A refused press reaches no agent, so this row in the chat is the only thing
 * that tells the person who pressed that nothing came of it.
 */
const ACTION_NOT_RECORDED = '这个动作没能记下来。'
/** A `/component-action` line naming no action at all — the shape a hand-typed one takes. */
const MALFORMED_ACTION = '/component-action {"entryId":"budget"}'
/** The header the shell draws over any logged non-user message, in English. */
const CONTEXT_ROW_HEADING = 'Context injection'

/** The spec the `cleanup` call placed, so the column holds two entries at once. */
const CLEANUP_SPEC = {
  nodes: [{
    id: 'ask',
    component: 'el.confirm-bar',
    props: {
      title: CLEANUP_PROMPT,
      buttons: [{ id: 'delete', label: 'Delete', tone: 'danger' }],
    },
  }],
}

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-surface-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * One settled `show_component` call, as the log records it.
 * @param callId - the tool call id.
 * @param id - the entry the call owns.
 * @param title - the line the user reads in the switcher strip.
 * @param spec - what the call placed.
 * @returns the two log lines the loop writes for one settled call.
 */
function componentCall(callId: string, id: string, title: string, spec: unknown): string[] {
  const args = JSON.stringify({ id, title, spec })
  return [
    JSON.stringify({
      type: 'tool/call',
      data: { turn: 1, step: 1, callId, name: 'show_component', arguments: args },
    }),
    JSON.stringify({
      type: 'tool/result',
      data: {
        turn: 1,
        step: 1,
        callId,
        content: [{ type: 'text', text: `Now showing "${title}" in the content panel.` }],
        isError: false,
      },
      surfaceOp: 'append',
    }),
  ]
}

/**
 * Splice three settled component calls into a recorded session, inside its open step.
 *
 * The first and the last share the `budget` id, older first, so the column has
 * to fold them into one entry owned by the later call.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withComponentCalls(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"step/end"'))
  if (closing === -1) throw new Error('seed fixture has no step/end to splice before')
  return [
    ...lines.slice(0, closing),
    ...componentCall('call_00_component_budget_old', BUDGET_ID, BUDGET_DRAFT_TITLE, BUDGET_DRAFT_SPEC),
    ...componentCall('call_00_component_cleanup', CLEANUP_ID, CLEANUP_TITLE, CLEANUP_SPEC),
    ...componentCall('call_00_component_budget_new', BUDGET_ID, BUDGET_TITLE, BUDGET_SPEC),
    ...lines.slice(closing),
  ].join('\n')
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')

/** One entry's tab in the column's switcher strip, addressed by the key the column builds. */
const tab = (page: Page, entryId: string): Locator =>
  page.locator(`[data-content-surface-entry="component ${entryId}"]`)

/** The prompt the seat currently draws, or null while it draws no block. */
async function shownPrompt(page: Page): Promise<string | null> {
  return await seat(page).getByRole('heading').textContent()
}

/**
 * Wait until the shell has given the content column a width.
 *
 * The column collapses to zero while the current session's surface is empty
 * and widens once its entries arrive, so a seat can hold a fully drawn block
 * one paint before the track it sits in is wide enough to show it.
 * @param page - the browsing page.
 */
async function awaitOpenColumn(page: Page): Promise<void> {
  await expect.poll(async () => (await seat(page).boundingBox())?.width ?? 0, { timeout: 15_000 })
    .toBeGreaterThan(200)
}

/**
 * The scenario session's log as the running host holds it.
 *
 * Read in process rather than off disk: the scaffold's own readiness barrier
 * hands over the live agent, and its session is the same durable record the
 * JSONL provider writes.
 * @param scaffold - the booted scaffold.
 * @returns every event the session carries, in order.
 */
function liveEvents(scaffold: WebScaffold): readonly SessionEvent[] {
  const agent = scaffold.ctx.agents.get(SessionId(SESSION))
  if (agent === undefined) throw new Error(`no live agent for ${SESSION}`)
  return agent.session.events
}

/** Save one screenshot under the repository's artifact directory. */
async function evidence(page: Page, name: string): Promise<void> {
  // Evidence for the composition, not a failure artifact.
  await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: true })
}

describe.skipIf(MODE === 'record')('web e2e: show_component in the content column', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY })
    await seedSession(scaffold, withComponentCalls(await readFile(FIXTURE, 'utf8')), SESSION)

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
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
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('draws the block the newest call placed, with its own buttons', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface'))
    const block = seat(page).locator('[data-component-block="el.confirm-bar"]')
    await block.waitFor({ timeout: 30_000 })
    // The caption is the entry's title; the heading, the sentence, and the
    // buttons are what the call itself wrote into the spec.
    await expect.poll(async () => await shownPrompt(page), { timeout: 15_000 }).toBe(BUDGET_PROMPT)
    expect(await block.getByText(BUDGET_MESSAGE, { exact: true }).count()).toBe(1)
    expect(await block.getByRole('button').allTextContents()).toEqual(['Approve', 'Decide later', 'Reject'])
    expect(await seat(page).getByText(BUDGET_TITLE, { exact: true }).count()).toBe(1)
    // The block is not only drawn but on display: the shell widened the column
    // it sits in, which it only does once the session's surface has an entry.
    await awaitOpenColumn(page)
    await evidence(page, 'web-e2e-component-surface')
  }, 120_000)

  it('folds the two calls sharing an id into one tab and keeps the other beside it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-supersede'))
    // Three calls, two entries: the superseded draft has no tab of its own, and
    // the tab that survived carries the later call's title.
    await tab(page, CLEANUP_ID).waitFor({ timeout: 30_000 })
    expect(await page.locator('[data-content-surface-entry]').count()).toBe(2)
    expect(await tab(page, BUDGET_ID).textContent()).toContain(BUDGET_TITLE)
    expect(await page.getByText(BUDGET_DRAFT_TITLE, { exact: true }).count()).toBe(0)
    expect(await page.getByText(BUDGET_DRAFT_PROMPT, { exact: true }).count()).toBe(0)

    // And the surviving entry is the one on display, since it owns the newest
    // record in the stream.
    expect(await shownPrompt(page)).toBe(BUDGET_PROMPT)
  }, 120_000)

  it('draws the other entry in the same seat when the user picks it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-switch'))
    await tab(page, CLEANUP_ID).click()
    await expect.poll(async () => await shownPrompt(page), { timeout: 15_000 }).toBe(CLEANUP_PROMPT)
    expect(await seat(page).getByRole('button').allTextContents()).toEqual(['Delete'])
    await evidence(page, 'web-e2e-component-surface-switch')

    await tab(page, BUDGET_ID).click()
    await expect.poll(async () => await shownPrompt(page), { timeout: 15_000 }).toBe(BUDGET_PROMPT)
  }, 120_000)

  it('carries a press back to the agent and puts the answer in the transcript', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-action'))
    // The budget entry is the one on display, and its bar carries the button.
    const approve = seat(page).locator(`[data-component-action="${APPROVE_ID}"]`)
    await expect.poll(async () => await approve.textContent(), { timeout: 15_000 }).toBe(APPROVE_LABEL)
    // The barrier is armed before the press, not after: what the bar itself
    // draws is asserted in between, and the scripted turn can settle while
    // those reads are in flight.
    const settled = scaffold.whenTurnSettled(60_000)
    await approve.click()

    // What the bar answers with on its own, before the agent has said anything:
    // the whole row refuses further presses and the block says where the press
    // went. The agent's own answer is a turn away, and a bar that looked
    // untouched until it arrived would leave a recorded press and a lost one
    // looking the same.
    await expect.poll(async () => await seat(page).getByText(SENT_LINE, { exact: true }).count(), { timeout: 15_000 })
      .toBe(1)
    expect(await seat(page).getByRole('button').evaluateAll(
      buttons => buttons.map(button => (button as HTMLButtonElement).disabled),
    )).toEqual([true, true, true])

    await settled

    // What the log kept: the command's own recorded input, verbatim and
    // log-only, and no event this row invented for itself.
    const events = liveEvents(scaffold)
    const run = events.find(event => event.type === 'command/run')
    expect(run?.type === 'command/run' && run.data.name).toBe('component-action')
    expect(run?.type === 'command/run' && run.data.args).toBe(
      ` {"entryId":"${BUDGET_ID}","componentId":"el.confirm-bar","actionId":"press","nodeId":"ask","payload":{"buttonId":"${APPROVE_ID}"}}`,
    )
    expect(events.filter(event => event.type.startsWith('component'))).toEqual([])

    // What the agent was given, and the turn it was given it in. The press
    // opened turn 2 — the seeded log closed turn 1 — and the notice is a plugin
    // message, never a forged user one.
    const notice = events.find(event => event.type === 'user/message' && event.data.source.kind === 'plugin')
    expect(notice?.type === 'user/message' && notice.data.content).toEqual([{ type: 'text', text: PRESS_TEXT }])
    expect(notice?.type === 'user/message' && notice.data.source).toEqual({
      kind: 'plugin',
      plugin: NOTICE_PLUGIN,
      form: 'notice',
      summary: PRESS_SUMMARY,
    })
    // The set and the causal order, not a fixed interleaving: `command/run` is
    // written before the handler runs, the wake opens the turn inside it, and
    // the notice is claimed into that turn. The seed closed turn 1, so the
    // press's is the second and last.
    const opened = events.filter(event => event.type === 'turn/start')
    expect(opened.length).toBe(2)
    const pressTurn = opened[1]
    expect(pressTurn?.seq ?? 0).toBeGreaterThan(run?.seq ?? Infinity)
    expect(pressTurn?.seq ?? Infinity).toBeLessThan(notice?.seq ?? 0)

    // What the user reads: a collapsed row headed by the shell's own wording for
    // any logged non-user message, naming the producer and this press. The
    // summary is asserted through the DOM rather than through visibility: it is
    // a `flex: 1 1 auto` cell with `overflow: hidden`, so at the console's
    // three-column chat width it is squeezed to nothing and the reader is left
    // with the heading and the plugin id alone.
    const row = page.locator('[data-disclosure-row]', { hasText: PRESS_SUMMARY })
    await row.waitFor({ state: 'attached', timeout: 30_000 })
    await row.scrollIntoViewIfNeeded()
    await expect.poll(async () => await row.isVisible(), { timeout: 15_000 }).toBe(true)
    expect(await row.locator('[data-context-source]').textContent()).toBe(NOTICE_PLUGIN)
    expect(await row.locator('[data-context-summary]').textContent()).toBe(PRESS_SUMMARY)
    // The heading is the shell's own, drawn the same for every producer; this
    // row records the exact wording an end user is shown beside the press.
    expect(await row.textContent()).toContain(CONTEXT_ROW_HEADING)
    // And what expanding it opens on, which is the README's limitation as the
    // user meets it: the model-facing English sentence, internal identifiers
    // included. A `notice` renders its own body, so the source field table the
    // opaque fallback would add is not there — the sentence is the whole of it.
    await row.click()
    const body = page.locator('[data-context-injection-body]', { hasText: PRESS_TEXT })
    await body.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await body.locator('[data-context-text]').textContent()).toBe(PRESS_TEXT)
    expect(await body.locator('[data-context-fields]').count()).toBe(0)

    // The press is not narrated in chat: the command row this row registers for
    // `component-action` renders nothing, so the reader is left with the notice
    // above rather than an English `component-action · Completed` line. The slot
    // anchor is what proves the row was folded and then emptied, instead of
    // never having been rendered at all.
    expect(await page.locator('[data-slot="conversation.chat.commandview"]').count()).toBeGreaterThan(0)
    expect(await page.getByText('component-action', { exact: true }).count()).toBe(0)

    // And what the model said about it, in the turn the press opened. The
    // script's own head is `{{fromRequest:pressed "([^"]+)" in content panel
    // entry}}`, so this sentence exists only because the notice built from the
    // press was in the request that earned it.
    await expect.poll(async () => await page.getByText(MODEL_REPLY, { exact: false }).count(), { timeout: 30_000 })
      .toBe(1)
    await evidence(page, 'web-e2e-component-surface-action')
  }, 120_000)

  it('still reads as pressed after the column has drawn something else and come back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-pressed-persists'))
    // The column discards this kind's DOM on every switch, so the bar that
    // comes back is a fresh mount. What makes it read as pressed is the
    // session's own log: the press's command records are folded on the host and
    // published with the session's projection values. Take that fold away and
    // this tab round trip hands the user a bar they can answer twice.
    await tab(page, CLEANUP_ID).click()
    await expect.poll(async () => await shownPrompt(page), { timeout: 15_000 }).toBe(CLEANUP_PROMPT)
    expect(await seat(page).getByText(SENT_LINE, { exact: true }).count()).toBe(0)

    await tab(page, BUDGET_ID).click()
    await expect.poll(async () => await shownPrompt(page), { timeout: 15_000 }).toBe(BUDGET_PROMPT)
    await expect.poll(async () => await seat(page).getByText(SENT_LINE, { exact: true }).count(), { timeout: 15_000 })
      .toBe(1)
    expect(await seat(page).getByRole('button').evaluateAll(
      buttons => buttons.map(button => (button as HTMLButtonElement).disabled),
    )).toEqual([true, true, true])
    await evidence(page, 'web-e2e-component-surface-pressed-persists')
  }, 120_000)

  it('tells the person who pressed when the gesture reached nobody', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-refused'))
    // Typed by hand rather than pressed, because a seat only ever sends what
    // the drawn spec carries: the reachable way to a refusal is a line naming
    // an action that resolves against nothing. The command is in the slash menu
    // — the registry has no way to keep a row out of it — so this is also the
    // path an end user can stumble into.
    const composer = page.getByPlaceholder(COMPOSER_PLACEHOLDER)
    await composer.fill(MALFORMED_ACTION)
    await composer.press('Enter')

    // The refusal is the row itself. Nothing reached the agent, so no notice
    // and no answer follows it — and the row is not the chat view's English
    // `component-action · Completed` fallback either.
    const refused = page.locator('[data-chat-flow-kind="command"]', { hasText: ACTION_NOT_RECORDED })
    await refused.waitFor({ state: 'attached', timeout: 30_000 })
    await refused.scrollIntoViewIfNeeded()
    await expect.poll(async () => await refused.isVisible(), { timeout: 15_000 }).toBe(true)
    expect(await refused.locator('[data-component-action-refused]').textContent()).toBe(ACTION_NOT_RECORDED)
    expect(await page.getByText('component-action', { exact: true }).count()).toBe(0)
    // Two command rows now: the press's, emptied and collapsed, and this one.
    expect(await page.locator('[data-chat-flow-kind="command"]').count()).toBe(2)
    await evidence(page, 'web-e2e-component-surface-refused')
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
