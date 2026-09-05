/**
 * Web e2e scenario: the session is on a model that takes no pictures, the user
 * is asked whether to change it, and the same turn answers from the pixels.
 *
 * The composition, the hosted application and the preset are [the picture
 * scenario](./content-read-image.e2e.ts)'s. One thing differs, and it is the
 * whole scenario: no route is selected on the seeded session, so the session
 * keeps the `deepseek-v4-flash` its seed logged — a text-only route in the
 * replay catalogue. The picture read therefore reaches its route gate with
 * nothing to work with, and the gate puts a card in the console instead of
 * refusing.
 *
 * The click is the TEST's own action in every mode, the way the approval
 * scenario's is: the turn cannot finish without it, in record and in replay
 * alike. What the card says is pinned as its own golden, because it is the one
 * surface of the content column a person rather than a model reads.
 *
 * The route this scenario is about is asserted while the card stands rather
 * than before the prompt. A session nothing has opened is not live host-side —
 * the other content scenarios are live only because selecting their route
 * resolved their agent — and the card is a stable waiting state where the
 * request that raised it has already been logged. Asserting there says more
 * than asserting up front: the request that reached the gate really ran on the
 * text-only route.
 *
 * What the fixture then pins is that the change really happened and really
 * carried the picture: a `model/selection`, a `request/header` recorded as a
 * change onto the vision route, and an answer describing what the page drew. A
 * change that had not taken effect would have put `[image omitted …]` in the
 * request, and the model would have had nothing to describe.
 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, recordFixture, watchConsole,
  webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import {
  COMPOSER, FRAME_DIR, fixtureFor, lastAnswerText, openContentColumn, toolResults,
} from './content-column.ts'
import { saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const SCENARIO = 'content-read-image-switch'
const FIXTURE = fixtureFor(SCENARIO)

/** Where this scenario's own goldens live. */
const SNAPSHOT_DIR = dirname(FIXTURE)

/** The card the gate puts up, as the console renders it. */
const CARD_EXPECTED = join(SNAPSHOT_DIR, 'card.expected.md')

/** The hosted application this scenario serves; the overlay reads it from the environment. */
const APP_ROOT = join(FRAME_DIR, 'tests/fixtures/markup-app')

/**
 * The picture scenario's patch layer, unchanged. Its `agent-default-model` row
 * names the vision route, which decides where a NEW session starts and nothing
 * about this one: the seeded session derives its route from its own log.
 */
const OVERLAY = fileURLToPath(new URL('./content-read-image.overlay.yml', import.meta.url))

/** The route the seeded session is on, which takes no pictures. */
const SEEDED_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const

/** The route the card offers and the user chooses. */
const VISION_ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' } as const

/** The option label that route is offered under: the provider's name and the model's. */
const VISION_OPTION = 'DeepSeek：DeepSeek-V4-Flash-Vision-Exp'

/** The preset this scenario's session is composed from: a persona and no tools at all. */
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
 * go red for a scenario nobody has recorded yet.
 */
const RECORDED = existsSync(FIXTURE)

/**
 * Every request header this run has recorded, in log order.
 * @param events - the session events observed so far.
 * @returns why each header was written, and the model its request went to.
 */
function requestHeaders(events: readonly SessionEvent[]): { reason: string; model: string }[] {
  return events.flatMap(event => (event.type === 'request/header'
    ? [{ reason: event.data.reason, model: event.data.header.config.model }]
    : []))
}

/** What the user asks: about the page, never about the model it runs on. */
const PROMPT = '内容区那个页面表格下面有一张小方图，看不出是什么。'
  + '你看看那张图上画的到底是什么东西，然后告诉我。'

describe.skipIf(MODE !== 'record' && !RECORDED)('web e2e: the user is asked to change the model a picture needs', () => {
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
      preset: PRESET,
    }))
  }, 180_000)

  afterAll(async () => {
    await close?.()
  })

  it('asks whether to change the model, then answers from the pixels on the new route', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-read-image-switch'))
    if (MODE !== 'record') {
      expect(fixtureUserPrompts(await readFile(FIXTURE, 'utf8'))).toEqual([PROMPT])
    }
    // Before anything is driven: what the two routes declare. A composition
    // whose text route accepted pictures would raise no card, and one whose
    // vision route did not would leave the card with nothing to offer — either
    // way every assertion below would pass for the wrong reason.
    // Read as the gate reads it: a route whose modalities are unknown declares
    // no picture input either, which is what the keyless replay's catalogue says
    // of the text route.
    expect((await scaffold.ctx.llm.resolveModelInfo(SEEDED_ROUTE.provider, SEEDED_ROUTE.model)).inputModalities
      ?.includes('image')).not.toBe(true)
    expect((await scaffold.ctx.llm.resolveModelInfo(VISION_ROUTE.provider, VISION_ROUTE.model)).inputModalities)
      .toContain('image')

    // One picture on the page, for the reason the picture scenario records: the
    // recording pins a content hash of every export the turn makes.
    const frame = page.frameLocator('iframe[data-content-frame][data-content-active]')
    await frame.locator('#throughput').waitFor({ state: 'detached', timeout: 15_000 })
    expect(await frame.locator('img, canvas, svg').count()).toBe(1)

    const input = page.locator(COMPOSER).first()
    await input.waitFor({ timeout: 10_000 })
    const settled = scaffold.whenTurnSettled(MODE === 'record' ? 240_000 : 90_000)
    await input.fill(PROMPT)
    await input.press('Enter')

    // The composer takes over the input area while the gate waits. Its presence
    // is a stable waiting state rather than a transient one: it stands until it
    // is answered, so a plain wait is race-free.
    const composer = page.locator('[data-question-key]')
    await composer.waitFor({ timeout: MODE === 'record' ? 180_000 : 60_000 })

    // The card stands, so the request that reached the gate is logged and the
    // session is live: it ran on the route the seed logged, and no selection
    // has been made yet.
    const asked = requestHeaders(sessionEvents)
    expect(asked.length).toBeGreaterThanOrEqual(1)
    expect(asked.at(-1)?.model).toBe(SEEDED_ROUTE.model)
    const session = scaffold.ctx.sessions.get(seeded)
    if (session === undefined) throw new Error(`seeded session "${seeded}" is not live while its card stands`)
    expect(scaffold.ctx.sessionProjections.snapshot(session).values.modelSelection?.next)
      .toMatchObject(SEEDED_ROUTE)

    // And what the session may reach for: the content column's own tools and
    // nothing else, so the picture is the only way to answer the prompt.
    const agent = scaffold.ctx.agents.get(seeded)
    if (agent === undefined) throw new Error(`seeded session "${seeded}" has no live agent`)
    expect(scaffold.ctx.tools.schemas(agent).map(schema => schema.name).sort()).toEqual(OFFERED)

    if (MODE !== 'record') {
      const card = await captureStableAria(page, '[data-question-key]', scaffold.workspaceCwd)
      await compareOrRefreshGolden(CARD_EXPECTED, card, MODE)
    }

    // The answer, in both modes: a single-select card records the choice as a
    // draft, and submitting it is a second gesture.
    await composer.getByRole('radio', { name: VISION_OPTION }).click()
    await composer.getByRole('button', { name: 'Submit' }).click()
    const sessionId = await settled

    // The change is in the log twice: as the selection the console made, and as
    // the request header that consumed it.
    const selections = sessionEvents.filter(event => event.type === 'model/selection')
    expect(selections.map(event => event.data)).toMatchObject([VISION_ROUTE])
    const changed = requestHeaders(sessionEvents).filter(header => header.reason === 'change')
    expect(changed.length).toBeGreaterThanOrEqual(1)
    expect(changed.map(header => header.model)).toEqual(changed.map(() => VISION_ROUTE.model))

    // And the read ran on it. How the model reaches the element is its own to
    // choose; what is pinned is what every route promises.
    const pictures = toolResults(sessionEvents, 'content_read_image')
    expect(pictures.length).toBeGreaterThanOrEqual(1)
    expect(pictures.filter(text => !text.startsWith('Page: Home — the app is at /content-app/?pictures=code')))
      .toEqual([])
    // 348 is under the raster floor and twice it is over, so the seat draws the
    // stored PNG at twice its own size: the line carries both numbers.
    expect(pictures.some(text => /e\d+ <img> 348×348 px, exported 696×696 as image\/png, \d+ bytes/u.test(text)))
      .toBe(true)

    const blocks = sessionEvents.flatMap((event) => {
      if (event.type !== 'tool/result') return []
      return event.data.message.content.flatMap(result => result.content.filter(block => block.type === 'image'))
    })
    expect(blocks.length).toBeGreaterThanOrEqual(1)
    expect(blocks[0]).toMatchObject({ attachment: { mediaType: 'image/png', width: 696, height: 696 } })

    // The picture reached the model rather than a placeholder: a change that had
    // not taken effect would have left the model nothing to describe.
    expect(lastAnswerText(sessionEvents)).toMatch(/二维码|qr|matrix code|barcode|条码/iu)
    if (MODE === 'record') await recordFixture(scaffold, sessionId, FIXTURE, { afterSeed: true })
  }, 300_000)

  it.skipIf(MODE === 'record')('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
