// Keyless browser regression for the approval card's file-change preview: a
// pending `write` escalation must show the path and the lines it would add
// BEFORE the user answers, so allowing is a decision about content rather than
// about a tool name. The script is authored, not recorded — the escalation the
// scenario needs is one deterministic tool call, and authoring it keeps the
// lane runnable without a model key.
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFinalWorkspaceSnapshot, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  fixtureUserPrompts, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/approval-preview-diff', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v2.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()

const PROMPT = 'Create notes.txt in the workspace with three short lines, then reply with the single word DONE and stop.'

describe.skipIf(MODE === 'record')('web e2e: the approval card shows the file change it is asking about', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    // The authored script is not a recording of this run, so the replayed log
    // is deliberately not compared against it.
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: false })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('previews the path and the added lines, then writes exactly them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-approval-preview-diff'))
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })

    // Read Only is what makes the write escalate: the call asks to widen the
    // sandbox, and that ask is the approval the card renders.
    await page.locator('[aria-label^="Access mode"]').click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await expect.poll(
      () => page.locator('[aria-label="Access mode, current: Read Only"]').count(),
      { timeout: 15_000 },
    ).toBe(1)

    const settled = scaffold.whenTurnSettled(60_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    const diff = panel.locator('[data-diff]')
    await diff.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      UI_EXPECTED,
      await captureStableAria(page, '[data-approval-key]', scaffold.workspaceCwd),
      MODE,
    )

    await panel.getByRole('button', { name: 'Allow once' }).click()
    await settled

    // The preview described the write, so the file on disk must be exactly it,
    // and nothing else may have been written behind the one answered request.
    expect(await readFile(join(scaffold.workspaceCwd, 'workspace', 'notes.txt'), 'utf8'))
      .toBe('alpha\nbeta\ngamma\n')
    await assertFinalWorkspaceSnapshot(SNAPSHOT_DIR, join(scaffold.workspaceCwd, 'workspace'))
    await expect.poll(() => page.getByText('DONE', { exact: true }).count(), { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1)
    expect(await page.locator('[data-approval-key]').count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 180_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['session.v2.jsonl', 'ui.expected.md', 'workspace.expected'])
  })
})
