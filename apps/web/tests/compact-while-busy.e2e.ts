// Keyless browser coverage for `/compact` typed while a Turn is running,
// through the shipped Web composition and the real HTTP/SSE wire. Paced replay
// keeps the first step streaming while the composer sends `/compact`; the
// Settings row chooses the timing. Interrupt compacts at the next step
// boundary inside the Turn; Queue, the default, compacts once the Turn has
// ended. The waiting card, the localized refusal of a second request, and the
// card's place outside the folded completed Turn are pinned as goldens.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import type { ReplayEntry } from '@deepseek-ai/dsh-llm-replay'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, openSettings, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/compact-while-busy', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
// Standard is the work-details view in which a running Turn's process groups
// and a completed Turn fold; the Web client defaults to Detailed.
const STANDARD_VIEW_OVERLAY = '- id: ui-chat\n  config:\n    transcriptView: standard\n'
const GOLDENS = ['settings-row.expected.md', 'interrupt-completed.expected.md', 'queue-waiting.expected.md', 'queue-completed.expected.md']

// A long first prompt gives the manual compaction a span its summary shrinks.
const LONG_PROMPT = `Read notes.txt and summarize it. ${'event sourcing keeps every change as an event. '.repeat(400)}`
const PACE_MS = 120
// Streamed before the tool call so the first step stays open for several seconds.
const OPENING = Array.from({ length: 40 }, (_, index) => `step ${index} `)

function readCall(): ReplayEntry {
  const args = JSON.stringify({ file_path: 'notes.txt' })
  const opening = OPENING.join('')
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      ...OPENING.map((text): StreamChunk => ({ type: 'text-delta', index: 0, text })),
      { type: 'block-end', index: 0, block: { type: 'text', text: opening } },
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'busy-read' as never, name: 'read', argumentsDelta: args },
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'busy-read' as never, name: 'read', arguments: args } },
      { type: 'usage', usage: { inputTokens: 3_000, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] satisfies StreamChunk[],
  }
}

function textReply(text: string): ReplayEntry {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens: 3_000, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] satisfies StreamChunk[],
  }
}

const SUMMARY = textReply('The user asked for a summary of notes.txt about event sourcing.')
const ANSWER = textReply('notes.txt says event sourcing stores changes as events.')

interface Run {
  readonly live: WebScaffold
  readonly page: Page
  readonly events: SessionEvent[]
}

describe('web e2e: /compact while a Turn is running', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
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
    if (failures.length > 1) throw new AggregateError(failures, 'compact-while-busy teardown failed')
  })

  /** Boot the Web composition over a scripted replay and connect a fresh Workspace. */
  async function start(replay: ReplayEntry[], shot: string): Promise<Run> {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-compact-while-busy-'))
    const overridePath = join(overrideDir, 'replay.override.json')
    await writeFile(overridePath, JSON.stringify(replay))
    const overlayPath = join(overrideDir, 'standard-view.overlay.yml')
    await writeFile(overlayPath, STANDARD_VIEW_OVERLAY)
    const events: SessionEvent[] = []
    const live = await launchWebScaffold({
      replayFixture: FIXTURE, replayOverride: overridePath, compareReplaySession: false, paceMs: PACE_MS,
      extraOverlayPath: overlayPath,
    })
    scaffold = live
    live.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    browser = await chromium.launch()
    const page = await newEnglishPage(browser)
    await page.goto(live.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, live.workspaceCwd)
    await writeFile(join(live.workspaceCwd, 'workspace', 'notes.txt'), 'Event sourcing stores changes as events.\n')
    onTestFailed(() => saveFailureShot(page, shot))
    return { live, page, events }
  }

  /** Send the long prompt and type `/compact` while its first step streams. */
  async function compactDuringFirstStep(run: Run): Promise<void> {
    const input = run.page.locator('[data-composer-input]').first()
    await input.fill(LONG_PROMPT)
    await input.press('Enter')
    await run.page.getByRole('button', { name: 'Stop generating' }).waitFor()
    await expect.poll(() => run.events.some(event => event.type === 'step/start')).toBe(true)
    await input.fill('/compact')
    await input.press('Enter')
    await expect.poll(() => run.events.some(event => event.type === 'command/run')).toBe(true)
  }

  function types(events: readonly SessionEvent[]): string[] {
    return events
      .filter(event => ['turn/start', 'turn/end', 'step/start', 'command/run', 'command/done', 'compaction/start', 'compaction/end'].includes(event.type))
      .map(event => event.type === 'compaction/start' ? `compaction/start:${String(event.data.turn)}` : event.type)
  }

  async function expectCardOutsideFold(page: Page): Promise<void> {
    await page.getByRole('button', { name: /^Completed in / }).waitFor({ timeout: 15_000 })
    const card = page.locator('[data-chat-flow-kind="manual-compaction"]').first()
    await card.waitFor()
    expect(await card.evaluate(element => element.closest('[data-turn-process-member]') === null)).toBe(true)
    expect(await card.evaluate(element => element.closest('[hidden]') === null)).toBe(true)
  }

  const aria = (run: Run): Promise<string> => captureStableAria(run.page, '[class*="centerCol"]', run.live.workspaceCwd, {
    replacements: [[LONG_PROMPT, '{{long-prompt}}']],
  })

  it.skipIf(MODE === 'record')('Interrupt compacts at the next step boundary inside the running Turn', async () => {
    const run = await start([readCall(), SUMMARY, ANSWER], 'web-e2e-compact-while-busy-interrupt')
    const tripwire = watchConsole(run.page)
    await openSettings(run.page, 'en')
    const settings = run.page.getByRole('dialog', { name: 'Settings' })
    const row = settings.getByText('Compaction while busy', { exact: true }).locator('xpath=../..')
    await row.waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'settings-row.expected.md'), await row.ariaSnapshot(), MODE)
    await row.getByRole('button', { name: 'Queue' }).click()
    await run.page.getByRole('menuitem', { name: 'Interrupt' }).click()
    await expect.poll(() => row.getByRole('button', { name: 'Interrupt' }).count()).toBe(1)
    await settings.getByRole('button', { name: 'Close', exact: true }).click()

    const settled = run.live.whenTurnSettled()
    await compactDuringFirstStep(run)
    await settled
    expect(types(run.events)).toEqual([
      'turn/start', 'step/start', 'command/run', 'compaction/start:1', 'compaction/end',
      'command/done', 'step/start', 'turn/end',
    ])
    const done = run.events.find(event => event.type === 'command/done')
    expect(done?.type === 'command/done' && done.data.kind).toBe('success')
    await expectCardOutsideFold(run.page)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'interrupt-completed.expected.md'), await aria(run), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it.skipIf(MODE === 'record')('Queue waits for the Turn to end and refuses a second request in the reader\'s language', async () => {
    const run = await start([readCall(), ANSWER, SUMMARY], 'web-e2e-compact-while-busy-queue')
    const tripwire = watchConsole(run.page)
    const settled = run.live.whenTurnSettled()
    await compactDuringFirstStep(run)
    const card = run.page.locator('[data-chat-flow-kind="manual-compaction"]').first()
    await card.getByText('Waiting to compact…').waitFor()
    const input = run.page.locator('[data-composer-input]').first()
    await input.fill('/compact')
    await input.press('Enter')
    await run.page.getByText('Compaction is unavailable: another compaction is running or waiting, or the agent is not idle.').waitFor()
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'queue-waiting.expected.md'), await aria(run), MODE)
    await settled
    await expect.poll(() => run.events.some(event => event.type === 'compaction/end')).toBe(true)
    await expect.poll(() => run.events.filter(event => event.type === 'command/done').length).toBe(2)
    expect(types(run.events)).toEqual([
      'turn/start', 'step/start', 'command/run', 'command/run', 'command/done',
      'step/start', 'turn/end', 'compaction/start:null', 'compaction/end', 'command/done',
    ])
    await expectCardOutsideFold(run.page)
    await expect.poll(() => card.getByText('Waiting to compact…').count()).toBe(0)
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'queue-completed.expected.md'), await aria(run), MODE)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, GOLDENS)
    expect(await readFile(join(SNAPSHOT_DIR, 'snapshot.yml'), 'utf8')).toContain('scenario: compact-while-busy')
  })
})
