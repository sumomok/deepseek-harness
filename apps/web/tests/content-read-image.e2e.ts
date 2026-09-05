/**
 * Web e2e scenario: the agent looks at a picture the page draws, because the
 * page says nothing at all about what it is.
 *
 * The composition is the shipped Web surface plus this scenario's own patch
 * layer, so the whole channel is the real one — the session publishes its open
 * call, the page seat in a real browser claims it, exports the element's own
 * rendered pixels out of a real iframe, posts them to the picture route, and
 * the host commits them to the real attachment store before the call settles.
 * What the model is shown is a real image block referencing a real object.
 *
 * The session is routed to a model that declares image input, because the read
 * refuses a route that does not before it exports anything. That takes two
 * things, and the second is the one that does the work: the patch layer names
 * the route this composition's sessions start on, and the spec then selects it
 * on the seeded session itself, because a session that already logged a request
 * header derives its route from its own log and never from the composition's
 * default.
 *
 * The session is composed from a preset that mounts no tools at all, so the
 * only tools it is offered are the content column's. That is what makes the
 * picture the only way to answer: handed a QR code and a shell, this model
 * installed OpenCV over the network and read the payload out of the stored
 * attachment, which is a transcript no replay can reproduce.
 *
 * The application is `tests/fixtures/markup-app`, whose pairing code carries no
 * alternative text, no title and no name — the listing has nothing to print for
 * it and the markup says only that an `img` is there. What it shows is in its
 * pixels and nowhere else, which is the condition this read exists for.
 *
 * The page is served at `?pictures=code`, which takes its other two pictures
 * out, and what that is for is what the fixture pins. The harness compares the
 * whole replayed log against the recorded one, and a picture's `attachmentId`
 * is a content hash of the exported bytes, re-derived live by the replay — so
 * the recording pins every export this turn makes, not only the one the
 * assertions below read. A checked-in PNG decoded and re-encoded produces the
 * same bytes wherever it replays; the canvas and the vector in that page are
 * rasterized by the browser, where fonts and antialiasing are not promised to
 * agree across platforms or across engine versions, and a recording that had
 * read them would drift on both. They stay in the page for this package's own
 * suite, which holds the export decisions rather than the bytes.
 *
 * The fixture pins what the MODEL said; every read and every export executes
 * for real.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  fixtureUserPrompts, recordFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  COMPOSER, FRAME_DIR, fixtureFor, lastAnswerText, openContentColumn, toolResults,
} from './content-column.ts'
import { saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SCENARIO = 'content-read-image'
const FIXTURE = fixtureFor(SCENARIO)

/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/markup-app')

/** This scenario's own patch layer: the content column, on a route that takes pictures. */
const OVERLAY = fileURLToPath(new URL('./content-read-image.overlay.yml', import.meta.url))

/**
 * The route this scenario's session runs on, selected on the seeded session
 * itself. The overlay's `agent-default-model` row alone would not put the
 * session here: a session that already logged a request header derives its
 * route from its own log, and the seed logged one.
 */
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } as const

/**
 * The preset this scenario's session is composed from: a persona and no tools
 * at all, so the only tools left are the content column's own.
 */
const PRESET = { root: fileURLToPath(new URL('./fixtures/presets', import.meta.url)), id: 'content-column' }

/** Every tool the session may be offered, which is the whole content column and nothing else. */
const OFFERED = [
  'content_act',
  'content_read',
  'content_read_attrs',
  'content_read_dom',
  'content_read_dom_content',
  'content_read_image',
  'content_show',
]

/**
 * Whether this scenario's recording is on disk. A replay run without it is
 * skipped rather than failed: the recording needs a real key, so the spec and
 * its fixture can land in different commits, and a lane with no key must not
 * go red for a scenario nobody has recorded yet. Once the fixture is in the
 * tree this is always true.
 */
const RECORDED = existsSync(FIXTURE)

/** What the user asks: about the page, never about the tools. */
const PROMPT = '内容区那个页面表格下面有一张小方图，看不出是什么。'
  + '你看看那张图上画的到底是什么东西，然后告诉我。'

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the agent looks at a picture on the page', () => {
  let scaffold: WebScaffold
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let close: () => Promise<void>
  let seeded: SessionId
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    ({ close, page, scaffold, sessionId: seeded, tripwire } = await openContentColumn({
      scenario: SCENARIO,
      appRoot: APP_ROOT,
      events: sessionEvents,
      overlay: OVERLAY,
      model: ROUTE,
      preset: PRESET,
    }))
  }, 180_000)

  afterAll(async () => {
    await close?.()
  })

  it('answers from the pixels a real browser exported, which no reading of the page prints', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-image'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    // Before anything is driven: this read refuses a route that declares no
    // image input, so a session sitting on the wrong route answers refusals
    // for every call and says nothing about why. Both halves of the condition
    // are asserted here, where a keyless run reaches them.
    const session = scaffold.ctx.sessions.get(seeded)
    if (session === undefined) throw new Error(`seeded session "${seeded}" is not live`)
    expect(scaffold.ctx.sessionProjections.snapshot(session).values.modelSelection?.next)
      .toMatchObject(ROUTE)
    expect((await scaffold.ctx.llm.resolveModelInfo(ROUTE.provider, ROUTE.model)).inputModalities)
      .toContain('image')

    // And what the session may reach for. A model handed a QR code and a shell
    // decodes it with a shell: the first recording of this scenario had the
    // model install OpenCV over the network and read the payload out, which is
    // a transcript no replay can reproduce. The composition is what makes the
    // picture the only way to answer, so it is asserted here rather than asked
    // for in the prompt.
    const agent = scaffold.ctx.agents.get(seeded)
    if (agent === undefined) throw new Error(`seeded session "${seeded}" has no live agent`)
    expect(scaffold.ctx.tools.schemas(agent).map(schema => schema.name).sort()).toEqual(OFFERED)

    // And what the page in front of it draws: exactly one picture, the
    // checked-in PNG. The recording pins a content hash of every export the
    // turn makes, so a page still drawing the canvas and the star would pin
    // bytes a browser is free to rasterize differently. Polled rather than read
    // once: the column is opened on a heading the markup carries before the
    // pictures, and the flag is applied by the application's own script. The
    // count of one is read while the document is still parsing if the `img`
    // alone has arrived, so the chart the script removes is polled for as well:
    // a run whose script never executed fails here rather than on the hashes.
    const frame = page.frameLocator('iframe[data-content-frame][data-content-active]')
    await expect.poll(() => frame.locator('img, canvas, svg').count(), { timeout: 15_000 }).toBe(1)
    await expect.poll(() => frame.locator('#throughput').count(), { timeout: 15_000 }).toBe(0)

    const input = page.locator(COMPOSER).first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 90_000)
    await input.fill(PROMPT)
    await input.press('Enter')
    const sessionId = await settled

    // How the model reaches the element is its own to choose — a listing then a
    // markup read, or a markup read straight from the page. What is pinned is
    // what every route promises.
    const pictures = toolResults(sessionEvents, 'content_read_image')
    expect(pictures.length).toBeGreaterThanOrEqual(1)
    // Every answer opens with the page line the tool composes around whatever
    // the seat exported, and carries the one line of facts about what came out.
    expect(pictures.filter(text => !text.startsWith('Page: Home — the app is at /content-app/?pictures=code')))
      .toEqual([])
    // 348 is under the raster floor and twice it is over, so the seat draws the
    // stored PNG at twice its own size: the line carries both numbers.
    expect(pictures.some(text => /e\d+ <img> 348×348 px, exported 696×696 as image\/png, \d+ bytes/u.test(text)))
      .toBe(true)
    // And nothing else was exported: the two the browser would rasterize are
    // not on this page, so no recorded hash depends on how it rasterizes.
    expect(pictures.filter(text => /<(?:canvas|svg)>/u.test(text))).toEqual([])

    // The picture itself reaches the model as an image block referencing a
    // stored object, which is the whole point: the text above it says nothing
    // about what the page drew.
    const blocks = sessionEvents.flatMap((event) => {
      if (event.type !== 'tool/result') return []
      return event.data.message.content.flatMap(result => result.content.filter(block => block.type === 'image'))
    })
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]).toMatchObject({ attachment: { mediaType: 'image/png', width: 696, height: 696 } })

    // And the answer is the model's own reading of those pixels. The probe this
    // scenario was designed against showed a vision model naming a matrix code
    // for what it is and declining to invent its payload, so what is asserted
    // is that it said what the picture is — in either language.
    expect(lastAnswerText(sessionEvents)).toMatch(/二维码|qr|matrix code|barcode|条码/iu)
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 300_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
