// Keyless browser coverage for a failed automatic compaction inside a Turn,
// through the shipped Web composition and the real HTTP/SSE wire. A scripted
// replay reports enough prompt usage after a tool step that the next step's
// pressure check opens a compaction bracket, and the summarizer call fails;
// the failure row must stay visible outside the Turn's collapsed process group
// while the Turn runs. A completed Turn's whole-Turn fold still covers it, as
// it covers every process row; this scenario parks the next model call instead.
import { existsSync } from 'node:fs'
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
import type {} from '@deepseek-ai/dsh-compaction/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/compaction-failure-row', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/live-interactions/session.v3.jsonl', import.meta.url))
const FAILED_EXPECTED = join(SNAPSHOT_DIR, 'failed.expected.md')
const MODE = webSnapshotMode()

// Two long earlier prompts give the pressure path a compactable span older
// than its retained tail; the scripted usage alone decides when it triggers.
const LONG_PROMPT = (label: string): string => `${label} ${'event sourcing keeps every change as an event. '.repeat(2_000)}`
const SECOND_PROMPT = 'Read notes.txt and summarize it.'
const SUMMARIZER_FAILURE = 'summarizer unavailable'

function textReply(text: string, inputTokens: number): ReplayEntry {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text },
      { type: 'block-end', index: 0, block: { type: 'text', text } },
      { type: 'usage', usage: { inputTokens, outputTokens: 2 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] satisfies StreamChunk[],
  }
}

function readCall(inputTokens: number): ReplayEntry {
  const args = JSON.stringify({ file_path: 'notes.txt' })
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: 'failure-read' as never, name: 'read', argumentsDelta: args },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'failure-read' as never, name: 'read', arguments: args } },
      { type: 'usage', usage: { inputTokens, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] satisfies StreamChunk[],
  }
}

describe('web e2e: failed automatic compaction inside a Turn', () => {
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
    if (failures.length > 1) throw new AggregateError(failures, 'compaction-failure-row teardown failed')
  })

  it.skipIf(MODE === 'record')('keeps the failure row outside the collapsed process group', async () => {
    overrideDir = await mkdtemp(join(tmpdir(), 'dsh-web-compaction-failure-'))
    const overridePath = join(overrideDir, 'replay.override.json')
    const readyFile = join(overrideDir, '.hang-ready')
    const replay: ReplayEntry[] = [
      textReply('READY', 200),
      textReply('READY', 200),
      readCall(120_000),
      { kind: 'throw', chunks: [], message: SUMMARIZER_FAILURE, code: 'INVALID_REQUEST' },
      { kind: 'hang', readyFile },
    ]
    await writeFile(overridePath, JSON.stringify(replay))

    const sessionEvents: SessionEvent[] = []
    const live = await launchWebScaffold({ replayFixture: FIXTURE, replayOverride: overridePath, compareReplaySession: false })
    scaffold = live
    live.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(live.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, live.workspaceCwd)
    await writeFile(join(live.workspaceCwd, 'workspace', 'notes.txt'), 'Event sourcing stores changes as events.\n')
    onTestFailed(() => saveFailureShot(page, 'web-e2e-compaction-failure-row'))

    const input = page.locator('[data-composer-input]').first()
    for (const label of ['First', 'Second']) {
      const settled = live.whenTurnSettled()
      await input.fill(LONG_PROMPT(label))
      await input.press('Enter')
      await settled
    }
    const parked = live.whenTurnSettled()
    await input.fill(SECOND_PROMPT)
    await input.press('Enter')
    await expect.poll(() => existsSync(readyFile), { timeout: 15_000 }).toBe(true)

    const ends = sessionEvents.filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(1)
    expect(ends[0]!.data.sourceCommandId).toBeUndefined()
    expect(ends[0]!.data.turn).not.toBeNull()
    const row = page.locator('[data-chat-flow-kind="compaction-failure"]')
    await row.waitFor({ timeout: 10_000 })
    const group = page.locator('[data-chat-group-key]').last()
    expect(await group.locator('[data-step-process-body]').first().evaluate(element => element.hasAttribute('hidden'))).toBe(true)
    expect(await row.evaluate(element => element.closest('[data-chat-group-key]') === null)).toBe(true)
    expect(await row.evaluate(element => element.closest('[hidden]') === null)).toBe(true)
    const failed = await captureStableAria(page, '[class*="centerCol"]', live.workspaceCwd, {
      replacements: [[LONG_PROMPT('First'), '{{first-prompt}}'], [LONG_PROMPT('Second'), '{{second-prompt}}']],
    })
    await compareOrRefreshGolden(FAILED_EXPECTED, failed, MODE)
    await page.getByRole('button', { name: 'Stop generating' }).click()
    await parked
    expect(tripwire.pageErrors).toEqual([])
  }, 120_000)

  it.skipIf(MODE === 'record')('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['failed.expected.md'])
    expect(await readFile(join(SNAPSHOT_DIR, 'snapshot.yml'), 'utf8')).toContain('scenario: compaction-failure-row')
  })
})
