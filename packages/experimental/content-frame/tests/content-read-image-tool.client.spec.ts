/**
 * The picture read against the real tool runtime: what the model is offered,
 * what it is refused before anything is exported or stored, and what each
 * settlement answers with.
 *
 * Every model-visible string is pinned verbatim, and so is the order of the two
 * gates: a stored picture is permanent, so a call that cannot end in one has to
 * fail before a browser is ever asked to draw.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { contentReadImageTool } from '../src/access/image-tool.ts'
import type { ModelRouteServices } from '../src/access/model-switch.ts'
import { fixedModalities, routeServices } from './route-services.client.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import {
  ELEMENT_REF_REFUSAL, EMPTY_COLUMN_REFUSAL, MISREPORTED_REFUSAL, noImageRouteRefusal, UNRESOLVED_ROUTE_REFUSAL,
} from '../src/access/text.ts'
import { CONTENT_READ_IMAGE_TOOL_NAME, type ReadOutcome } from '../src/access/wire.ts'

/** Deadlines short enough for a test to sit through both of them. */
const FAST: CallTimeouts = { claimTimeoutMs: 30, answerTimeoutMs: 60, pinMs: 5000 }

/** The tab every case here answers from. */
const TAB = 'tab_1'

/** The route this session's requests are declared to go to. */
const PROVIDER = 'deepseek-official'

/** A model that takes pictures. */
const VISION_MODEL = 'deepseek-v4-flash-vision-exp'

/** A model that takes text only. */
const TEXT_MODEL = 'deepseek-v4-flash'

let calls = 0

/**
 * A composition whose LLM registry answers for one route.
 * @param modalities - what that route declares it accepts, absent for a route
 * that declares nothing.
 * @returns the narrowed services the tool reads.
 */
function routes(modalities?: readonly string[]): ModelRouteServices {
  return routeServices({ llm: fixedModalities(modalities) })
}

/** A composition with no LLM registry at all. */
const NO_ROUTES: ModelRouteServices = { get: () => undefined }

/** One settled picture, as the host composes it once the pixels are stored. */
const STORED: Extract<ReadOutcome, { status: 'image' }> = {
  status: 'image',
  page: { id: 'home', title: 'Home' },
  url: 'http://127.0.0.1:5173/content-app/?q=open#top',
  ref: 'e12',
  tag: 'img',
  natural: { width: 240, height: 240 },
  settled: true,
  image: {
    attachmentId: 'sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640',
    mediaType: 'image/png',
    bytes: 3182,
    width: 240,
    height: 240,
    name: 'content-home-e12.png',
  },
}

/** One booted picture read, plus the table a browser answers through. */
interface Bench {
  pending: PendingCalls
  run: (args: Record<string, unknown>) => { callId: string; settled: Promise<ToolExecutionResult> }
}

/**
 * Boot the tool over a real registry and a real session.
 * @param model - the model this session's agent is routed to.
 * @param registry - the LLM registry the modality gate reads.
 * @returns the bench.
 */
async function bench(model: string, registry: ModelRouteServices): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const pending = new PendingCalls()
  ctx.tools.register(contentReadImageTool({ pending, timeouts: FAST, front: () => undefined }, registry))
  const session = Session.create(SessionId(`content-image-${++calls}`))
  // The gate reads the session's own request header first and the agent's
  // options behind it; a session that has not made a request has only the
  // second.
  const agent = { id: session.id, session, options: { provider: PROVIDER, model } } as unknown as
    NonNullable<ToolExecutionInput['agent']>
  return {
    pending,
    run: (args) => {
      const callId = `call-${++calls}`
      return {
        callId,
        settled: ctx.tools.execute({
          callId: callId as ToolExecutionInput['callId'],
          name: CONTENT_READ_IMAGE_TOOL_NAME,
          arguments: args,
          agent,
          signal: new AbortController().signal,
        }),
      }
    },
  }
}

/**
 * Claim one call as soon as its body has registered the wait, then answer it.
 * @param pending - the table the call is waiting in.
 * @param callId - the call to answer.
 * @param outcome - what to answer it with.
 */
async function answer(pending: PendingCalls, callId: string, outcome: ReadOutcome): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const ack = await pending.claim({ callId, tabId: TAB })
    if (ack.claimed) {
      pending.report({ callId, tabId: TAB, outcome })
      return
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
  }
  throw new Error(`the call ${callId} never registered its wait`)
}

/** The model-facing text of one settled execution. */
function text(result: ToolExecutionResult): string {
  return result.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

/**
 * Run one call and answer it with one outcome.
 * @param outcome - what the seat is standing in to have posted.
 * @returns the settled execution.
 */
async function settleWith(outcome: ReadOutcome): Promise<ToolExecutionResult> {
  const { pending, run } = await bench(VISION_MODEL, routes(['text', 'image']))
  const { callId, settled } = run({ ref: 'e12' })
  await answer(pending, callId, outcome)
  return await settled
}

describe('the picture read', () => {
  it('offers the model one required ref and nothing else', async () => {
    const { run } = await bench(VISION_MODEL, routes(['text', 'image']))
    const tool = contentReadImageTool(
      { pending: new PendingCalls(), timeouts: FAST, front: () => undefined },
      NO_ROUTES,
    )
    expect(tool.name).toBe('content_read_image')
    const parameters = tool.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(parameters.properties)).toEqual(['ref'])
    expect(parameters.properties.ref).toMatchObject({ type: 'string' })
    expect(parameters.required).toEqual(['ref'])
    // Two of them in one step are answered by the same seat one after the
    // other: the read writes nothing to the page, and storing pixels is
    // content-addressed, so neither can conflict with the other.
    expect(tool.isConcurrencySafe?.({ ref: 'e12' })).toBe(true)
    // The bench is booted so the registry accepted the same definition.
    expect(run).toBeTypeOf('function')
  })

  it('refuses a ref that is not one, before anything waits', async () => {
    const { pending, run } = await bench(VISION_MODEL, routes(['text', 'image']))
    const result = await run({ ref: '__page__' }).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(ELEMENT_REF_REFUSAL)
    // Nothing opened, so nothing is there to claim.
    expect((await pending.claim({ callId: 'call-none', tabId: TAB })).claimed).toBe(false)
  })

  it('refuses a route that declares no picture input, naming the model', async () => {
    const { run } = await bench(TEXT_MODEL, routes(['text']))
    const result = await run({ ref: 'e12' }).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(noImageRouteRefusal(TEXT_MODEL))
  })

  it('refuses a route that declares nothing at all', async () => {
    const { run } = await bench(TEXT_MODEL, routes(undefined))
    expect(text(await run({ ref: 'e12' }).settled)).toContain(noImageRouteRefusal(TEXT_MODEL))
  })

  it('refuses a composition with no registry to resolve the route through', async () => {
    const { run } = await bench(VISION_MODEL, NO_ROUTES)
    expect(text(await run({ ref: 'e12' }).settled)).toContain(UNRESOLVED_ROUTE_REFUSAL)
  })

  it('answers the picture with one line of facts and the picture itself', async () => {
    const result = await settleWith(STORED)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/?q=open#top\n'
      + 'e12 <img> 240×240 px, exported 240×240 as image/png, 3182 bytes',
    )
    expect(result.content.map(block => block.type)).toEqual(['text', 'image'])
    // What the transcript row keeps beside the settled call: the page it looked
    // at. The picture itself is in the result's own image block, and a second
    // copy of it here would be a second record of one fact.
    expect(result.meta).toEqual({ page: 'Home' })
    expect(result.content[1]).toEqual({
      type: 'image',
      attachment: {
        attachmentId: 'sha256:b1ff9c8ea3a780bad09b346c423d2d0e46815926879b18e841d928376a946640',
        mediaType: 'image/png',
        bytes: 3182,
        width: 240,
        height: 240,
        name: 'content-home-e12.png',
      },
    })
  })

  it('says both sizes where the export scaled the element', async () => {
    const result = await settleWith({
      ...STORED,
      natural: { width: 24, height: 24 },
      tag: 'svg',
      image: {
        attachmentId: STORED.image.attachmentId,
        mediaType: 'image/png',
        bytes: 1204,
        width: 384,
        height: 384,
      },
    })
    expect(text(result)).toContain('e12 <svg> 24×24 px, exported 384×384 as image/png, 1204 bytes')
    // A store that gave the picture no display name leaves the field off the
    // reference rather than carrying an empty one.
    expect(result.content[1]).toEqual({
      type: 'image',
      attachment: {
        attachmentId: STORED.image.attachmentId,
        mediaType: 'image/png',
        bytes: 1204,
        width: 384,
        height: 384,
      },
    })
  })

  it('says the page was still changing where it was', async () => {
    expect(text(await settleWith({ ...STORED, settled: false }))).toContain(
      'The page was still changing when this read ran; read again for the settled page.',
    )
  })

  it('rejects a settlement that answered with a listing rather than a picture', async () => {
    const result = await settleWith({
      status: 'ok',
      page: { id: 'home', title: 'Home' },
      snapshot: {
        kind: 'outline',
        url: 'http://127.0.0.1/content-app/',
        title: 'Home',
        text: 'e1 heading "Home"',
        truncated: false,
        shown: 1,
        total: 1,
        settled: true,
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(MISREPORTED_REFUSAL)
  })

  it('rejects with the seat\'s own reason where the seat had none to give', async () => {
    const result = await settleWith({ status: 'error', code: 'empty', message: 'the content column is empty' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(EMPTY_COLUMN_REFUSAL)
  })

  it('names the ref on the call card and the page on the settled one', async () => {
    const tool = contentReadImageTool(
      { pending: new PendingCalls(), timeouts: FAST, front: () => undefined },
      NO_ROUTES,
    )
    expect(tool.presentCall?.({ ref: 'e12' })).toEqual({
      card: 'generic',
      title: 'Read one picture in the content column',
      kind: 'other',
      rawInput: 'ref e12',
    })
    expect(tool.presentResult?.({ ref: 'e12' }, {
      content: [{ type: 'text', text: 'Page: Home — the app is at /content-app/\ne12 <img> 240×240 px' }],
    } as never)).toEqual({
      card: 'generic',
      title: 'Page: Home — the app is at /content-app/',
    })
  })

  it('falls back to the call\'s own title where the result carries no text', async () => {
    const tool = contentReadImageTool(
      { pending: new PendingCalls(), timeouts: FAST, front: () => undefined },
      NO_ROUTES,
    )
    expect(tool.presentResult?.({ ref: 'e12' }, { content: [] } as never)).toEqual({
      card: 'generic',
      title: 'Read one picture in the content column',
    })
  })
})
