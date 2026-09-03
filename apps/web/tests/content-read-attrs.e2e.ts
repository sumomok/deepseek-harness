/**
 * Web e2e scenario: the agent reads one element's attributes, because that is
 * the only place the page says what the element is.
 *
 * The composition is the shipped Web surface plus the content-frame overlay, so
 * the whole channel is the real one — the session publishes its open call, the
 * page seat in a real browser claims it, reads the element off the hosted
 * document inside a real iframe, and posts the attributes back into the waiting
 * call.
 *
 * The application is `tests/fixtures/markup-app`, whose row commands carry a
 * class that says nothing (`op op-a`) and a `data-op` that says everything.
 * That split is what this scenario exists for: the class tokens the tree prints
 * identify the row and do not explain it, and the explanation is an attribute
 * away.
 *
 * The fixture pins what the MODEL said; every read executes for real.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  COMPOSER, FRAME_DIR, fixtureFor, lastAnswerText, openContentColumn, toolResults,
} from './content-column.ts'
import { saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SCENARIO = 'content-read-attrs'
const FIXTURE = fixtureFor(SCENARIO)
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/markup-app')

/**
 * Whether this scenario's recording is on disk. A replay run without it is
 * skipped rather than failed: the recording needs a real key, so the spec and
 * its fixture can land in different commits, and a lane with no key must not
 * go red for a scenario nobody has recorded yet. Once the fixture is in the
 * tree this is always true.
 */
const RECORDED = existsSync(FIXTURE)

/** What the user asks: about the page, never about the tools. */
const PROMPT = '内容区表格第一行右边那两个小方块，光看样子看不出是干什么的。'
  + '查一下页面在它们身上写了些什么，然后告诉我这两个各是什么操作。'

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the agent reads one element\'s attributes', () => {
  let scaffold: WebScaffold
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let close: () => Promise<void>
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    ({ close, page, scaffold, tripwire } = await openContentColumn({
      scenario: SCENARIO, appRoot: APP_ROOT, events: sessionEvents,
    }))
  }, 180_000)

  afterAll(async () => {
    await close?.()
  })

  it('answers from the attributes a real browser holds, which no listing prints', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-attrs'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator(COMPOSER).first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 90_000)
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    // How the model reaches the element is its own to choose: a listing then a
    // tree then this, or a tree straight from a table's ref. What is pinned is
    // what every route promises.
    const attributes = toolResults(sessionEvents, 'content_read_attrs')
    expect(attributes.length).toBeGreaterThanOrEqual(1)
    expect(attributes.filter(text => !text.startsWith('Page: Home — the app is at /content-app/'))).toEqual([])
    // Every attribute, name and value as the page wrote them — including the
    // one that says what the command is, which reaches no listing and no tree.
    expect(attributes.some(text => text.includes('data-op="edit"') || text.includes('data-op="delete"'))).toBe(true)
    expect(attributes.some(text => text.includes('data-machine="mill-01"'))).toBe(true)
    // The tool reads nothing out of them: the answer's word for the operation
    // is the model's, from the attribute the page wrote.
    const answer = lastAnswerText(sessionEvents)
    expect(answer.toLowerCase()).toContain('edit')
    expect(answer.toLowerCase()).toContain('delete')
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 300_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
