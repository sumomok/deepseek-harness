// Web e2e scenario: a draft file whose name matches the fixed secret-container
// heuristic (`.env`) gets an immediate chip warning and, at send time, an
// in-page confirmation before anything reaches the agent loop. Zero model
// calls: the scenario never confirms through to a real send (that path is
// proven by input-bar.client.spec.tsx's exact-call assertion and by a real
// live-server E2E run with an actual model turn) — this scaffold's
// RouteOnlyAdapter throws on any stream() call, so this scenario stays
// entirely inside the declined branch, which fits the feature's own claim: a
// pure UI gate that never reaches the model unless the user confirms.
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/secret-container-confirmation', import.meta.url))
const UI_EXPECTED = fileURLToPath(new URL('./snapshots/secret-container-confirmation/ui.expected.md', import.meta.url))
const MODE = webSnapshotMode()

/**
 * Drop one fake file onto the composer. No `<input type=file>` exists — the
 * composer's admission listeners live on `document` — so a real browser drop
 * is simulated with a script-constructed DataTransfer, the same technique a
 * real drag-and-drop resolves to once the browser reads the dragged files.
 */
async function dropFile(page: Page, name: string, content: string): Promise<void> {
  await page.evaluate(({ name, content }) => {
    const file = new File([content], name, { type: 'text/plain' })
    const dataTransfer = new DataTransfer()
    dataTransfer.items.add(file)
    const options = { bubbles: true, cancelable: true, dataTransfer }
    document.dispatchEvent(new DragEvent('dragenter', options))
    document.dispatchEvent(new DragEvent('dragover', options))
    document.dispatchEvent(new DragEvent('drop', options))
  }, { name, content })
}

describe('web e2e: secret-container pre-send confirmation', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('warns the draft chip immediately and gates Enter behind a name/path confirmation; declining sends nothing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-secret-container-confirmation'))
    const textarea = page.locator('textarea[placeholder="Describe what you want to build"]')
    await textarea.waitFor({ timeout: 10_000 })

    await dropFile(page, '.env', 'SECRET_KEY=abc123\n')
    const chipRow = page.locator('[role="group"]').filter({ hasText: '.env' })
    await chipRow.waitFor({ timeout: 5_000 })
    expect(await page.locator('[data-secret-warning]').count()).toBe(1)

    await textarea.click()
    await textarea.fill('checking the secret-container confirmation')
    await textarea.press('Enter')

    const dialog = page.getByRole('dialog', { name: 'Send confirmation' })
    await dialog.waitFor({ timeout: 10_000 })
    // The modal is in this page's body (not a native/new window) and escapes
    // the sticky composer's stacking context, matching every other in-page
    // confirmation this product renders.
    expect(await dialog.evaluate(node => node.parentElement?.parentElement === document.body)).toBe(true)
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)

    // Declining leaves the draft and the attachment exactly as they were —
    // no send, no model call, no session created.
    await dialog.getByRole('button', { name: "Don't send" }).click()
    expect(await dialog.count()).toBe(0)
    expect(await textarea.inputValue()).toBe('checking the secret-container confirmation')
    expect(await chipRow.count()).toBe(1)

    // Re-arming Enter reopens the identical gate rather than remembering a
    // "don't ask again" — the product's own no-suppression rule.
    await textarea.press('Enter')
    await dialog.waitFor({ timeout: 5_000 })
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['ui.expected.md'])
  })
})
