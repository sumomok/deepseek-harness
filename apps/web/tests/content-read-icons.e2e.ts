/**
 * Web e2e regression: a real browser reads an Element table's glyph as an icon,
 * and its empty value, the `--` placeholder it generates for one, and its tree
 * indent as nothing.
 *
 * Whether a leaf draws a picture is read from the computed style of it and of
 * its `::before` and `::after`, which jsdom does not compute for a
 * pseudo-element; here the frame is pointed at the real route, loads a real
 * document, and a layout engine computes the glyph Element UI writes into
 * `::before`. The fixture page puts, in one table, the empty `div.cell` an
 * empty value is drawn as, an empty `div.cell` whose `::before` the sheet
 * fills with `--`, the indent and placeholder spans a tree table puts in front
 * of a row's text, and an `el-icon-edit` glyph on a bare `<i>`.
 *
 * No recording of its own, and no model. The seeded log shows the page, and a
 * scripted model turn asks for two reads — the page, then the table's rows by
 * the ref the first read gives it — before a closing line. The loop logs each
 * `tool/call`, which the `contentAccess` projection publishes to every browser,
 * and runs the tool, whose wait the seat answers. What the assertions read is
 * the result each call settled as.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ReplayEntry, ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const SEED = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const FRAME_DIR = join(REPO_ROOT, 'packages/experimental/content-frame')
const OVERLAY = join(FRAME_DIR, 'overlay/content-column.patch.yml')

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', FRAME_DIR],
] as const

/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/icon-table')
const SEEDED_SESSION = 'content-read-icons-web-e2e'

/** The id of the read of the whole page. */
const PAGE_CALL = ToolCallId('content-read-icons-page')

/** The id of the read of the table's rows. */
const ROWS_CALL = ToolCallId('content-read-icons-rows')

/** What the user asks; the scripted answer does not depend on it. */
const PROMPT = 'Read the table in the content column.'

/**
 * One model answer that calls `content_read` once.
 * @param id - the call's id.
 * @param args - the call's arguments, as JSON.
 * @returns the answer.
 */
function readCall(id: ToolCallId, args: string): ReplayEntry {
  return {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'content_read', arguments: args } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ],
  }
}

/**
 * The three model answers the turn consumes: the read of the page, the read of
 * the table it numbers first, and a closing line once both results are in.
 */
const SCRIPT: ReplayOverrideDoc = [
  readCall(PAGE_CALL, '{}'),
  readCall(ROWS_CALL, '{"scope":"e1"}'),
  {
    kind: 'chunks',
    chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Read.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Read.' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
  },
]

/** The composer's own stable attribute — the signal that a session is open. */
const COMPOSER = '[data-composer-input]'

/**
 * Prepare a harness home whose profile fallback resolves every experimental row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-content-read-icons-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * Seed a log that shows a page.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withShownPage(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
    JSON.stringify({ type: 'content/shown', data: { page: 'home' } }),
    ...lines.slice(closing),
  ].join('\n')
}

/**
 * What one call settled as, once it has.
 * @param events - the seeded session's events so far.
 * @param callId - the call.
 * @returns whether the result is an error and its text, or undefined while the call is open.
 */
function settled(events: readonly SessionEvent[], callId: ToolCallId): { isError: boolean; text: string } | undefined {
  const result = events.find(event => event.type === 'tool/result' && event.data.message.source.callId === callId)
  if (result?.type !== 'tool/result') return undefined
  const text = result.data.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  return { isError: result.data.message.isError === true, text }
}

describe.skipIf(MODE === 'record')('web e2e: a real browser reads only a glyph as an icon', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const sessionEvents: SessionEvent[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the Loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    const script = join(harnessHome, 'replay.override.json')
    await writeFile(script, JSON.stringify(SCRIPT))
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: script, replayOverride: script })
    const seeded = await seedSession(scaffold, withShownPage(await readFile(SEED, 'utf8')), SEEDED_SESSION)
    scaffold.ctx.on('session/event', (session, event: SessionEvent) => {
      if (session.id === seeded) sessionEvents.push(event)
    })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[data-shell-column="content"]').waitFor({ state: 'attached', timeout: 30_000 })
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    const row = page.locator('[role="treeitem"]').nth(1)
    await row.waitFor({ timeout: 15_000 })
    await row.click()
    await page.locator(COMPOSER).first().waitFor({ timeout: 15_000 })
    await page.frameLocator('iframe[data-content-frame][data-content-active]')
      .locator('#fixture-table .el-icon-edit').first().waitFor({ timeout: 30_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('prints the glyph as an icon, and the empty value, the placeholder and the indent as nothing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-icons'))
    // The placeholder is drawn: the browser computes the `--` the sheet
    // generates into the empty wrapper, so the reads below see it and read it
    // as text rather than as a picture.
    const placeholder = await page.frameLocator('iframe[data-content-frame][data-content-active]')
      .locator('#fixture-table .placeholder-dash .cell').first()
      .evaluate(cell => getComputedStyle(cell, '::before').getPropertyValue('content'))
    expect(placeholder).toBe('"--"')

    const input = page.locator(COMPOSER).first()
    await writeComposerDraft(page, input, PROMPT)
    await page.keyboard.press('Enter')

    await expect.poll(() => settled(sessionEvents, ROWS_CALL) !== undefined, { timeout: 60_000 }).toBe(true)
    const pageRead = settled(sessionEvents, PAGE_CALL)
    const rowsRead = settled(sessionEvents, ROWS_CALL)
    expect([pageRead?.isError, rowsRead?.isError]).toEqual([false, false])
    const listing = pageRead?.text ?? ''
    const rows = rowsRead?.text ?? ''
    // The sample row prints the one icon the operation column draws, an empty
    // cell where the value is empty and where the sheet generates `--` for it,
    // and the name with no icon in front of it.
    expect(listing.split('\n').slice(1)).toEqual([
      'e1 table "设备" 2 rows × 4 cols',
      '  header: 名称 | 备注 | 班组 | 操作',
      '  sample: 东风站 |  |  | [icon]',
      "  rows: pass scope with this table's ref to list rows, or find a row by its text",
    ])
    // Each row lists the glyph as an icon with a ref of its own, and nothing
    // else in the row: not the empty wrapper, not the wrapper the sheet
    // generates `--` into, not the indent, not the placeholder span.
    expect(rows.split('\n').slice(1)).toEqual([
      'e1 table "设备" 2 rows × 4 cols',
      '  header: 名称 | 备注 | 班组 | 操作',
      '  row 1: 东风站 |  |  | e3 icon {class: el-icon-edit}',
      '  row 2: 朝阳站 | 检修中 | 二班 | e5 icon {class: el-icon-edit}',
    ])
    expect([...rows.matchAll(/ icon \{class: ([^}]*)\}/g)].map(match => match[1])).toEqual(['el-icon-edit', 'el-icon-edit'])
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
