/**
 * Web e2e scenario: the agent reads a page's own markup where the listing can
 * name nothing.
 *
 * The composition is the shipped Web surface plus the content-frame overlay, so
 * the whole channel is the real one — the session publishes its open call, the
 * page seat in a real browser claims it, walks the hosted document inside a
 * real iframe, and posts the tree back into the waiting call. jsdom can stand
 * in for none of that: it has no layout, and a frame pointed at a real route
 * never loads there at all.
 *
 * The application this reads is `tests/fixtures/markup-app`, whose Operations
 * column is drawn as bare elements with a class and a data attribute and
 * nothing a specification defines. `content_read` therefore prints that column
 * empty, which is the condition `content_read_dom` exists for and the thing a
 * unit test cannot assemble: what makes the column empty is a real browser
 * computing that those elements carry no role, no name and no pointer cursor.
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
const SCENARIO = 'content-read-dom'
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
const PROMPT = '内容区那张表的「Operations」列看起来是空的，可我明明看到每行有两个小方块。'
  + '去看看这个页面到底是怎么写的，把第一行那两个东西的原始写法告诉我。'

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the agent reads the page\'s own markup', () => {
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

  it('answers with the markup a real browser rendered, where the listing named nothing', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-dom'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    const input = page.locator(COMPOSER).first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 90_000)
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    // How a page gets read is the model's to choose: which ref it scopes to,
    // how many reads it takes, and whether it also asks for a whole text are
    // not facts about this product. What follows is what the product promises
    // whichever way the model went.
    const trees = toolResults(sessionEvents, 'content_read_dom')
    expect(trees.length).toBeGreaterThanOrEqual(1)
    // Every tree carries the header line, which the tool composes around
    // whatever the seat returned rather than the model writing it. A read that
    // failed answers a sentence instead, so this holds the channel as well.
    expect(trees.filter(text => !text.startsWith('Page: Home — the app is at /content-app/'))).toEqual([])
    // The condition the tree exists for: the listing prints the Operations
    // column with nothing in it, because those elements carry no role, no name
    // and no pointer cursor for a browser to compute.
    const listings = toolResults(sessionEvents, 'content_read')
    expect(listings.length).toBeGreaterThanOrEqual(1)
    expect(listings.some(text => text.includes('table "Fleet"'))).toBe(true)
    // And the tree prints what the document says, verbatim: the tag, the class
    // tokens the page wrote, in the order it wrote them.
    expect(trees.some(text => text.includes('i {class: op op-a}'))).toBe(true)
    expect(trees.some(text => text.includes('i {class: op op-b}'))).toBe(true)
    // Nothing is read out of them. `op-a` reaches the model as `op-a`, and the
    // reader never turns it into a word like "edit".
    expect(trees.filter(text => text.includes('op-a edit') || text.includes('"edit"'))).toEqual([])
    // The answer repeats the markup the model was shown. The wording is the
    // model's and is pinned nowhere here.
    const answer = lastAnswerText(sessionEvents)
    expect(['op-a', 'op-b'].filter(token => answer.includes(token))).toEqual(['op-a', 'op-b'])
    // Only this turn: the scenario seeds a previous round to have a session to
    // open, and a replay fixture carrying it would bind this run's first model
    // call to the seeded round's reply.
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 300_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
