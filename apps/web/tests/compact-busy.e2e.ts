// Keyless browser coverage for `/compact` while a Turn is running, through the
// shipped Web composition and the real HTTP/SSE wire. A replay override parks
// the Turn; a bare `/compact` from the composer is refused in the composer
// without reaching the Host, and a Host refusal of the same command (sent over
// `commands/execute`, as another client would) renders its card outside the
// collapsed process group.
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { deriveReplayScript, parseSessionLog, type ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/compact-busy', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const COMPOSER_EXPECTED = join(SNAPSHOT_DIR, 'composer.expected.md')
const HOST_CARD_EXPECTED = join(SNAPSHOT_DIR, 'host-card.expected.md')
const NOTICE_EXPECTED = join(SNAPSHOT_DIR, 'notice.expected.md')
const MODE = webSnapshotMode()

const ACTIVE_PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'
const NOTICE = 'A reply is in progress. Compact after this turn ends.'

describe('web e2e: /compact during a running Turn', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let overrideDir: string | undefined

  afterEach(async () => {
    const failures: unknown[] = []
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (overrideDir !== undefined) {
      await rm(overrideDir, { recursive: true, force: true })
        .catch((error: unknown) => failures.push(error))
    }
    overrideDir = undefined
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'compact-busy teardown failed')
  })

  it.skipIf(MODE === 'record')('refuses bare /compact in the composer and keeps a Host refusal card outside the folded group', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-compact-busy-'))
    const readyFile = join(overrideDir, '.hang-ready')
    const overridePath = join(overrideDir, 'replay.override.json')
    const recorded = deriveReplayScript(parseSessionLog(await readFile(FIXTURE, 'utf8')))
    expect(recorded).toHaveLength(1)
    const replay: ReplayEntry[] = [{ kind: 'hang', readyFile }]
    await writeFile(overridePath, JSON.stringify(replay))

    const sessionEvents: Array<{ sessionId: string; event: SessionEvent }> = []
    const live = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: overridePath, compareReplaySession: false })
    scaffold = live
    live.ctx.on('session/event', (session, event: SessionEvent) => {
      sessionEvents.push({ sessionId: String(session.id), event })
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(live.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, live.workspaceCwd)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compact-busy'))

    const input = page.locator('[data-composer-input]').first()
    const settled = live.whenTurnSettled()
    await input.fill(ACTIVE_PROMPT)
    await input.press('Enter')
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)
    await page.getByRole('button', { name: 'Stop generating' }).waitFor()

    await input.fill('/compact')
    await input.press('Enter')
    // The refusal is the composer's transient error Toast: a body-portal alert
    // anchored on the composer card, so it is captured on its own.
    const alert = page.getByRole('alert').filter({ hasText: NOTICE })
    await alert.waitFor({ timeout: 10_000 })
    await compareOrRefreshGolden(NOTICE_EXPECTED, await alert.ariaSnapshot(), MODE)
    expect(await input.textContent()).toBe('')
    expect(sessionEvents.some(({ event }) => event.type === 'command/run')).toBe(false)
    const composer = await captureStableAria(page, '[class*="centerCol"]', live.workspaceCwd)
    await compareOrRefreshGolden(COMPOSER_EXPECTED, composer, MODE)

    const sessionId = sessionEvents.find(({ event }) => event.type === 'turn/start')?.sessionId
    if (sessionId === undefined) throw new Error('expected the parked Turn to have started')
    const response = await live.hostFetch('/api/commands/execute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: `compact-busy-${randomUUID()}`,
        method: 'commands/execute',
        payload: { args: { agentId: sessionId, line: '/compact', submittedAttachments: [] } },
      }),
    })
    expect(response.ok).toBe(true)
    const card = page.locator('[data-chat-flow-kind="manual-compaction"]')
    await card.waitFor({ timeout: 10_000 })
    expect(await card.evaluate(element => element.closest('[data-chat-group-key]') === null)).toBe(true)
    expect(await card.evaluate(element => element.closest('[hidden]') === null)).toBe(true)
    const hostCard = await captureStableAria(page, '[class*="centerCol"]', live.workspaceCwd)
    await compareOrRefreshGolden(HOST_CARD_EXPECTED, hostCard, MODE)

    await page.getByRole('button', { name: 'Stop generating' }).click()
    await settled
    expect(sessionEvents.filter(({ event }) => event.type === 'command/run')).toHaveLength(1)
    expect(sessionEvents.some(({ event }) => event.type === 'compaction/start')).toBe(false)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['composer.expected.md', 'host-card.expected.md', 'notice.expected.md'])
  })
})
