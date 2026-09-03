/**
 * Web e2e scenario: the agent reads the page the user is looking at.
 *
 * The composition is the shipped Web surface plus the content-frame overlay, so
 * the whole channel is the real one — the session publishes its open read, the
 * page seat in a real browser claims it, walks the hosted document inside a
 * real iframe, and posts the listing back into the waiting call. jsdom can
 * stand in for none of that: it has no layout, and a frame pointed at a real
 * route never loads there at all.
 *
 * The fixture pins what the MODEL said; the read executes for real. What the
 * assertions read is therefore the browser's own answer about a document the
 * browser itself rendered.
 *
 * This scenario owns the corpus's `web-content` header class: the four content
 * scenarios boot one composition, and the tool schemas and system prompt its
 * pin holds are the ones all four requests carry.
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
import { expandOwningTurnProcess, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SCENARIO = 'content-read'
const FIXTURE = fixtureFor(SCENARIO)
/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/app')

/**
 * Whether this scenario's recording is on disk. A replay run without it is
 * skipped rather than failed: the recording needs a real key, so the spec and
 * its fixture can land in different commits, and a lane with no key must not
 * go red for a scenario nobody has recorded yet. Once the fixture is in the
 * tree this is always true.
 */
const RECORDED = existsSync(FIXTURE)

/** What the user asks. Deliberately about the page, never about the tool. */
const PROMPT = '读一下内容区现在这个页面，告诉我表格有几行、有哪些按钮'

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the agent reads the page in the content column', () => {
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

  it('answers the user by reading the page a real browser is showing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator(COMPOSER).first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled()
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    // The row states the fact and nothing else; the listing is the model's.
    // A tool row is drawn inside its turn's collapsed process group, so the
    // group is opened before the row can be seen.
    const stage = page.locator('[data-content-read-stage="done"]').first()
    await stage.waitFor({ state: 'attached', timeout: 30_000 })
    await expandOwningTurnProcess(page, stage)
    await stage.waitFor({ timeout: 30_000 })

    const listings = toolResults(sessionEvents, 'content_read')
    // How a page gets read is the model's to choose, and five recordings of
    // this one prompt went three ways: one that read three times, with what it
    // asked for each time no longer on record; one that took an outline and
    // then `scope` on the table's ref; and one that took a map and then `scope`
    // on the table and on the form in a single step. The two whose answers were
    // kept answered correctly, so neither the number of reads, nor the mode of
    // any one of them, nor which of them saw the table is a fact about this
    // product. What follows is what the product promises whichever way the
    // model went.
    //
    // The page was read at least once.
    expect(listings.length).toBeGreaterThanOrEqual(1)
    // Every listing carries the header line, which the tool composes around
    // whatever the seat returned rather than the model writing it. A read that
    // failed answers a sentence instead, so this holds the channel as well.
    expect(listings.filter(text => !text.startsWith('Page: Home — the app is at /content-app/'))).toEqual([])
    // And it carries neither of the two lines a page that had not finished
    // drawing itself would add: this fixture holds still inside the read's own
    // quiet window and marks nothing as loading, so a read of it says nothing
    // about either.
    expect(listings.filter(text => text.includes('The page was still changing when this read ran'))).toEqual([])
    expect(listings.filter(text => text.includes('The page marks these as still loading'))).toEqual([])
    // Some listing names the table. The page writes `aria-label="Fleet"`, and
    // an outline, a map, a `scope` on its ref and a `find` on its text each
    // print it the same way, so any read that reached the table shows this.
    expect(listings.some(text => text.includes('table "Fleet"'))).toBe(true)
    // What is written inside a dialog the page has not opened reaches no read:
    // a map prints that node as hidden and no listing descends into it.
    expect(listings.filter(text => text.includes('Shut down the whole fleet?'))).toEqual([])
    // And the answer names all three machines. The page writes each name in a
    // row and again inside that row's button label, so an answer about what the
    // table holds carries all three however it is worded. The wording is the
    // model's and is pinned nowhere here.
    const answer = lastAnswerText(sessionEvents)
    expect(['mill-01', 'mill-02', 'mill-03'].filter(machine => answer.includes(machine)))
      .toEqual(['mill-01', 'mill-02', 'mill-03'])
    // Only this turn: the scenario seeds a previous round to have a session to
    // open, and a replay fixture carrying it would bind this run's first model
    // call to the seeded round's reply.
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 200_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
