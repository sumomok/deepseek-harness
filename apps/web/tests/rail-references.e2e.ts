// Prompt references through the real Loader, Typert RPC, Host, and browser:
// an owner fixture adds reference drafts to the composer attachment row, and
// every user-facing surface shows only their labels while the durable user
// message records them on its source. The question tool holds the first turn
// open so the queued row and pending steering are observable before the loop
// admits them; the override-only replay script answers all three model calls.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Locator, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { assertFixtureInventory, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const OWNER = fileURLToPath(new URL('./fixtures/plugins/fixture-rail-references', import.meta.url))
const EXPECTED_DIR = fileURLToPath(new URL('./expected/rail-references', import.meta.url))
const MODE = webSnapshotMode()
const SHOTS = process.env['DSH_RAIL_REFERENCES_SHOTS']

/** Titles of the reference chips inside one element, in DOM order. */
async function chipLabels(scope: Locator): Promise<(string | null)[]> {
  return scope.locator('[data-reference-chip]').evaluateAll(chips => chips.map(chip => chip.getAttribute('title')))
}

/** Durable user messages whose text contains `text`. */
function userMessages(events: readonly SessionEvent[], text: string): SessionEvent<'user/message'>[] {
  return events.filter((event): event is SessionEvent<'user/message'> =>
    event.type === 'user/message' && JSON.stringify(event.data.content).includes(text))
}

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS !== undefined) await page.screenshot({ path: join(SHOTS, `${name}.png`) })
}

describe.skipIf(MODE === 'record')('web e2e: prompt references ride the attachment row and render as label chips', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  const releaseReplay = Promise.withResolvers<undefined>()
  let disposeReplayBarrier: (() => void) | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      profile: { packages: [{ dir: OWNER, enabled: true }] },
      replayFixture: join(EXPECTED_DIR, 'session.jsonl'),
      replayOverride: join(EXPECTED_DIR, 'replay.override.json'),
    })
    disposeReplayBarrier = scaffold.ctx.on('llm/stream', async function* (_options, next) {
      await releaseReplay.promise
      yield* next()
    }, { prepend: true })
    scaffold.ctx.on('session/event', (_session, event) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  }, 120_000)

  afterAll(async () => {
    releaseReplay.resolve(undefined)
    disposeReplayBarrier?.()
    await browser?.close()
    await scaffold?.close()
  })

  it('removes, sends, queues, and steers references while showing labels only', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-rail-references'))
    const input = page.locator('[data-composer-input]').first()
    const editable = page.locator('[data-composer-input][contenteditable="true"]').first()
    const point = page.getByRole('button', { name: 'Point', exact: true })
    const rail = page.getByRole('group', { name: 'Pending attachments' })
    const send = page.getByRole('button', { name: 'Send message', exact: true })
    await editable.waitFor({ timeout: 10_000 })

    // A: two chips in the attachment row above the editor; ✕ inside the chip removes one.
    await point.click()
    await point.click()
    await expect.poll(() => chipLabels(rail)).toEqual(['新增', '所属专题'])
    const remove = rail.getByRole('button', { name: 'Remove “所属专题”' })
    expect(await remove.evaluate(button => button.closest('[data-reference-chip]')?.getAttribute('title'))).toBe('所属专题')
    const railBox = await rail.boundingBox(), inputBox = await input.boundingBox()
    expect(railBox !== null && inputBox !== null && railBox.y + railBox.height <= inputBox.y).toBe(true)
    await shot(page, '01-rail-two-chips')
    await remove.click()
    await expect.poll(() => chipLabels(rail)).toEqual(['新增'])
    await rail.getByRole('button', { name: '新增', exact: true }).click()
    expect(await page.evaluate(() => document.body.dataset['fixtureActivated'])).toBe('新增')

    // A reference alone never makes the draft sendable.
    expect(await send.isDisabled()).toBe(true)
    await input.press('Enter')
    expect(sessionEvents.filter(event => event.type === 'user/message')).toHaveLength(0)

    // D: the sent message shows the same chip above its text; the text is unchanged.
    await input.fill('这是什么')
    await input.press('Enter')
    const first = page.locator('[class*="userRow"]').filter({ hasText: '这是什么' })
    await first.waitFor({ timeout: 10_000 })
    await expect.poll(() => chipLabels(first)).toEqual(['新增'])
    await expect.poll(() => rail.count()).toBe(0)

    // The turn is running while the replay barrier holds the model: Enter queues.
    await editable.waitFor({ timeout: 10_000 })
    await point.click()
    await input.fill('排队问题')
    await input.press('Enter')
    const dock = page.locator('[data-queue-dock]')
    const queued = dock.getByRole('listitem').filter({ hasText: '排队问题' })
    await queued.waitFor({ timeout: 10_000 })
    await expect.poll(() => chipLabels(queued)).toEqual(['行 3'])
    const edit = queued.getByRole('button', { name: 'Edit queued message' })
    await expect.poll(() => edit.isEnabled(), { timeout: 10_000 }).toBe(true)
    await shot(page, '02-queue-row-chip')
    await edit.click()
    const editor = dock.getByRole('textbox')
    expect(await editor.inputValue()).toBe('排队问题')
    await editor.fill('排队问题（已改）')
    await editor.press('Enter')
    const edited = dock.getByRole('listitem').filter({ hasText: '排队问题（已改）' })
    await edited.waitFor({ timeout: 10_000 })
    await expect.poll(() => chipLabels(edited)).toEqual(['行 3'])

    // Cmd+Enter steers: the pending steering bubble carries the chip.
    await editable.waitFor({ timeout: 10_000 })
    await point.click()
    await input.fill('插话问题')
    await input.press('Meta+Enter')
    const steering = page.locator('[data-pending-steering]').filter({ hasText: '插话问题' })
    await steering.waitFor({ timeout: 10_000 })
    expect(await chipLabels(steering)).toEqual(['列 4'])
    await shot(page, '03-pending-steering-chip')

    // Release the model; answer the question so the steering and the queued turn run.
    releaseReplay.resolve(undefined)
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: 30_000 })
    await composer.getByRole('radio', { name: 'Yes' }).click()
    await composer.getByRole('radio', { name: 'Yes' }).press('Enter')
    await expect.poll(() => sessionEvents.filter(event => event.type === 'turn/end').length, { timeout: 30_000 }).toBe(2)
    await page.getByText('Queued reply.', { exact: true }).waitFor({ timeout: 15_000 })

    for (const [text, label] of [['这是什么', '新增'], ['排队问题（已改）', '行 3'], ['插话问题', '列 4']] as const) {
      const bubble = page.locator('[class*="userRow"]').filter({ hasText: text })
      await expect.poll(() => chipLabels(bubble), { timeout: 10_000 }).toEqual([label])
      const [event] = userMessages(sessionEvents, text)
      expect(event?.data.content).toEqual([{ type: 'text', text }])
      expect(event?.data.source).toMatchObject({
        kind: 'user',
        references: [{ source: 'fixture-owner', label, data: { secret: expect.stringMatching(/^payload-e42-\d$/u) as string } }],
      })
    }
    // The removed chip was never sent.
    expect(JSON.stringify(sessionEvents)).not.toContain('payload-e42-1')
    expect(JSON.stringify(sessionEvents)).not.toContain('所属专题')
    await shot(page, '04-settled-bubbles')

    // No payload or owner name reaches the document, and copy yields the text alone.
    const html = await page.content()
    expect(html).not.toContain('payload-e42')
    expect(html).not.toContain('fixture-owner')
    expect(tripwire.pageErrors).toEqual([])
  }, 200_000)

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(EXPECTED_DIR, ['replay.override.json'])
  })
})
