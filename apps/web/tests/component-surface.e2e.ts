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
 * The live path — a tool body judging a call the model is making right now — is
 * covered by the package's host specs; a keyless replay lane runs no model and
 * therefore issues no live call.
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
const OVERLAY = fileURLToPath(new URL('./component-surface.overlay.yml', import.meta.url))

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
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY })
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

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
