// File references after the agent changes directory, through the real Loader,
// Host, and browser. The override-only replay script has the agent enter
// `child/` with working_directory, then answer the next prompt with a relative
// Markdown link. Every referenced name exists both in the workspace root and in
// `child/` with different contents, so each open shows which directory the
// click resolved against: the composer chip, the reply link, and the chip in the
// sent message all open the `child/` copy the `@` menu listed.
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { assertFixtureInventory, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot, writeComposerDraft } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/reference-active-directory', import.meta.url))
const MODE = webSnapshotMode()
const SHOTS = process.env['DSH_REFERENCE_ACTIVE_DIRECTORY_SHOTS']
const ENTERED = 'ENTERED_CHILD'
const LINKED = 'LINKED_BETA'
/** Same names in the root and in `child/`; only the contents tell them apart. */
const FILES = {
  'alpha.txt': ['ROOT ALPHA\n', 'CHILD ALPHA\n'],
  'beta.txt': ['ROOT BETA\nsecond line\n', 'CHILD BETA\nsecond line\n'],
  'gamma.txt': ['ROOT GAMMA\n', 'CHILD GAMMA\n'],
} as const

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

/**
 * Wait for the right Sidebar to show the text preview of `child/<name>`.
 * @returns the visible preview, after its contents name the `child/` copy.
 */
async function childPreview(page: Page, name: keyof typeof FILES): Promise<Locator> {
  const preview = page.locator(`[data-rightbar-col] [data-textpreview-url$="/child/${name}"]`)
  await preview.waitFor({ state: 'visible', timeout: 15_000 })
  await expect.poll(() => preview.innerText()).toContain(FILES[name][1].split('\n')[0])
  expect(await preview.innerText()).not.toContain(FILES[name][0].split('\n')[0])
  return preview
}

describe.skipIf(MODE === 'record')('web e2e: file references resolve against the directory the agent entered', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: join(EXPECTED_DIR, 'session.jsonl'),
      replayOverride: join(EXPECTED_DIR, 'replay.override.json'),
    })
    // Fixture files land before the workspace connects so the Host's file
    // index never races their creation.
    const root = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(join(root, 'child'), { recursive: true })
    for (const [name, [rootText, childText]] of Object.entries(FILES)) {
      await writeFile(join(root, name), rootText)
      await writeFile(join(root, 'child', name), childText)
    }
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

  it('opens the composer chip, the reply link, and the sent chip from the current directory', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-reference-active-directory'))
    const input = page.locator('[data-composer-input]').first()
    const menu = page.getByRole('listbox', { name: 'Trigger suggestions' })
    const send = page.getByRole('button', { name: 'Send message', exact: true })

    // Turn 1: the agent enters child/ through working_directory.
    await writeComposerDraft(page, input, 'Work in the child directory.')
    await send.click()
    await page.getByText(ENTERED, { exact: true }).waitFor({ timeout: 30_000 })
    await shot(page, '1-entered-child')

    // The @ menu lists child/ now: one alpha.txt row with no parent directory,
    // where a root listing would also offer child/alpha.txt. The chip names
    // child/alpha.txt, and a click on it opens that copy.
    await writeComposerDraft(page, input, '@alpha')
    const alphaOption = menu.getByRole('option', { name: /alpha\.txt/ })
    await alphaOption.waitFor({ timeout: 60_000 })
    expect(await alphaOption.count()).toBe(1)
    expect(await alphaOption.textContent()).toBe('alpha.txt')
    await alphaOption.click()
    const alphaChip = input.locator('[data-composer-chip]').last()
    await expect.poll(() => alphaChip.textContent()).toBe('alpha.txt')
    await alphaChip.click()
    await childPreview(page, 'alpha.txt')
    await shot(page, '2-composer-chip-opens-child-alpha')

    // Turn 2: send a chip for gamma.txt; the reply links beta.txt relatively.
    await writeComposerDraft(page, input, '@gamma')
    const gammaOption = menu.getByRole('option', { name: /gamma\.txt/ })
    await gammaOption.waitFor({ timeout: 15_000 })
    await gammaOption.click()
    await expect.poll(() => input.locator('[data-composer-chip]').last().textContent()).toBe('gamma.txt')
    await send.click()
    await page.getByText(LINKED, { exact: true }).waitFor({ timeout: 30_000 })

    // The relative Markdown link, line fragment included, opens child/beta.txt.
    await page.getByRole('button', { name: 'beta.txt', exact: true }).click()
    await childPreview(page, 'beta.txt')
    await shot(page, '3-reply-link-opens-child-beta')

    // The chip in the sent user message opens child/gamma.txt.
    const sentChip = page.locator('[data-chat-flow-kind="user"] button[data-ref-chip="file"]').filter({ hasText: 'gamma.txt' })
    await sentChip.click()
    await childPreview(page, 'gamma.txt')
    await shot(page, '4-sent-chip-opens-child-gamma')

    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(EXPECTED_DIR, ['replay.override.json'])
  })
})
