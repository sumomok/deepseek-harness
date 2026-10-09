// @vitest-environment jsdom
/**
 * The whole `act_component` chain, host to browser and back.
 *
 * One composition mounts the real webserver, tool runtime, session store,
 * projection registry, content-surface router and this row; the browser half is
 * the real `ContentChannel` content-frame provides, joined by this package's
 * domain, with `fetch` pointed at the composition's own origin so the claim and
 * the report travel the served routes. Nothing between the model's call and the
 * drawn entry is stood in except the document the column would have drawn.
 *
 * What that buys is the wiring no unit test reaches: the call recorded in the
 * session's log, folded into the projection the seat reads, claimed over HTTP,
 * run inside the entry, reported back over HTTP, and answered to the model as
 * the value the output schema declares.
 */

import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import ContentSurfaceRegistry from '@deepseek-ai/dsh-experimental-content-surface'
import * as ContentFrame from '@deepseek-ai/dsh-experimental-content-frame'
import { CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE } from '@deepseek-ai/dsh-experimental-content-frame/src/access/wire.ts'
import { ContentChannel } from '@deepseek-ai/dsh-experimental-content-frame/src/client/access/channel.ts'
import { ACT_COMPONENT_TOOL_NAME, type ComponentCall } from '../src/act-component-call.ts'
import { READ_COMPONENT_TOOL_NAME } from '../src/read-component-call.ts'
import * as ComponentSurface from '../src/index.ts'
import { joinComponentChannel, type ComponentChannelWiring } from '../src/client/component-channel.ts'

/**
 * The hosted directory this composition serves; any real directory will do.
 * Resolved from the vitest working directory rather than `import.meta.url`,
 * which the jsdom environment reports as an http URL.
 */
const APP_ROOT = resolve(process.cwd(), 'packages/experimental/content-frame/tests/fixtures/app')

/** The entry every case here acts on. */
const ENTRY = 'demo'

/** The call id every case here opens. */
const CALL = 'call_1'

/** One step that presses a control the entry declares. */
const CLICK_ADD = { action: 'click', key: 'add' } as const

/** The document the column would have drawn: one component entry in front. */
function drawColumn(entryId = ENTRY, inner = '<button data-component-action="add">Add</button>'): void {
  document.body.innerHTML = `
    <nav data-content-surface-switcher>
      <button data-content-surface-entry="page home">Home</button>
      <button data-content-surface-entry="component ${entryId}" data-content-surface-selected>${entryId}</button>
    </nav>
    <div data-content-surface-seat="page" data-content-surface-active></div>
    <div data-content-surface-seat="component" data-content-surface-active>
      <div data-component-surface>${inner}</div>
    </div>
    <aside data-sidebar><button data-component-action="console-add">Add from the console</button></aside>
  `
}

/** One post the browser half made to a channel route. */
interface Post {
  path: string
  body: { callId?: string; tabId?: string; outcome?: { status?: string; code?: string } }
}

/** One booted chain: the composition, its session, and the seat joined to its channel. */
interface Bench {
  ctx: Context
  session: Session
  channel: ContentChannel
  wiring: ComponentChannelWiring
  posts: Post[]
  /** The served origin the browser half's posts are aimed at. */
  origin: string
  /** The open calls the projection publishes for this session. */
  pending: () => readonly ComponentCall[]
  /** Start one call of either tool the way an agent loop would, and answer with what it settles as. */
  call: (name: string, args: unknown, callId?: string) => Promise<ToolExecutionResult>
  /** Claim one open call over the served route, without ever reporting it. */
  claim: (callId: string) => Promise<void>
  /** Post one report for a call over the served route, and answer with what the route said. */
  post: (callId: string, outcome: unknown) => Promise<Response>
  /** Dispose this row, as a composition dropping it does. */
  unloadRow: () => Promise<void>
  /** Dispose the composition. */
  close: () => Promise<void>
}

/** The one real fetch captured before the browser half's own is stubbed. */
const realFetch = globalThis.fetch

let open: Bench | undefined

afterEach(async () => {
  vi.unstubAllGlobals()
  await open?.close()
  open = undefined
  document.body.innerHTML = ''
})

/**
 * Boot the composition and join one seat to its channel.
 * @param config - this deployment's `act_component` deadlines and the page domain's step bound.
 * @returns the booted chain.
 */
async function boot(config: { actClaimTimeoutMs?: number; actTimeoutMs?: number; pageMaxSteps?: number } = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(HttpServer, { host: '127.0.0.1', port: 0 }).await()
  await ctx.plugin(SystemPrompt).await()
  await ctx.plugin(ToolRuntime).await()
  await ctx.plugin(SessionStore).await()
  await ctx.plugin(SessionProjectionRegistry).await()
  await ctx.plugin(ContentSurfaceRegistry).await()
  await ctx.plugin(ContentFrame, {
    root: APP_ROOT,
    pages: [{ id: 'home', title: 'Home', description: 'The hosted application.', url: '/content-app/' }],
    // A page member beside the component one: both domains share the channel,
    // which is the composition `act_component` is offered in.
    pageAccess: {
      claimTimeoutMs: 5000,
      readTimeoutMs: 5000,
      pinMs: 60_000,
      settleQuietMs: 250,
      outlineChars: 12_000,
      actTimeoutMs: 60_000,
      maxSteps: config.pageMaxSteps ?? 20,
      settleMaxMs: 2000,
      actApproval: 'always',
    },
  }).await()
  const row = ctx.plugin(ComponentSurface, {
    ...config.actClaimTimeoutMs === undefined ? {} : { actClaimTimeoutMs: config.actClaimTimeoutMs },
    ...config.actTimeoutMs === undefined ? {} : { actTimeoutMs: config.actTimeoutMs },
  })
  await row

  // The client aggregate types this service's `create()` as minting an id; the
  // host store's own contract returns the live session, which is what the tools take.
  const session = (ctx.get('sessions') as unknown as SessionStore).create()
  const channel = new ContentChannel()
  const wiring = joinComponentChannel(channel)
  const posts: Post[] = []
  const origin = `http://127.0.0.1:${String(ctx.webServer.port)}`
  vi.stubGlobal('fetch', (url: URL | string, init?: RequestInit) => {
    const resolved = new URL(String(url), document.baseURI)
    if (typeof init?.body === 'string' && resolved.pathname.startsWith('/content-')) {
      posts.push({ path: resolved.pathname, body: JSON.parse(init.body) as Post['body'] })
    }
    return realFetch(`${origin}${resolved.pathname}${resolved.search}`, init)
  })

  const bench: Bench = {
    ctx,
    session,
    channel,
    wiring,
    posts,
    origin,
    pending: () => ctx.sessionProjections.snapshot(session).values.componentAccess?.pending ?? [],
    call: (name, args, callId = CALL) => ctx.tools.execute({
      callId: callId as ToolCallId,
      name,
      arguments: args,
      agent: { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>,
      signal: new AbortController().signal,
    }),
    claim: async (callId) => {
      await realFetch(`${origin}${CONTENT_CLAIM_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ callId, tabId: channel.tabId }),
      })
    },
    post: (callId, outcome) => realFetch(`${origin}${CONTENT_REPORT_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId, tabId: channel.tabId, outcome }),
    }),
    unloadRow: async () => { await row.dispose() },
    close: async () => { await ctx.fiber.dispose() },
  }
  open = bench
  return bench
}

/**
 * Record one tool call in the session's log the way the agent loop does, start
 * the call, and — unless the case is about nobody answering — hand the seat the
 * open calls the projection publishes.
 * @param bench - the booted chain.
 * @param name - the tool the call is for.
 * @param args - the call's arguments.
 * @param offer - whether a seat bids for the call at all.
 * @returns what the call settles as.
 */
async function callThroughTheColumn(
  bench: Bench,
  name: string,
  args: unknown,
  offer = true,
): Promise<ToolExecutionResult> {
  bench.session.append('tool/call', {
    turn: 1,
    step: 1,
    callId: CALL as ToolCallId,
    name,
    arguments: JSON.stringify(args),
  })
  const settled = bench.call(name, args)
  if (!offer) return settled
  // The seat offers what the projection publishes, on its own turn: the call is
  // registered inside the tool body, so a bid before that is answered `unknown`
  // and retried, which is the loop's own behaviour rather than this file's.
  await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
  const pending = bench.pending()
  expect(pending.map(call => call.callId)).toEqual([CALL])
  bench.wiring.offer(bench.session.id, pending)
  return settled
}

/**
 * The same, for one `act_component` call.
 * @param bench - the booted chain.
 * @param args - the call's arguments.
 * @param offer - whether a seat bids for the call at all.
 * @returns what the call settles as.
 */
function actThroughTheColumn(
  bench: Bench,
  args: { entry: string; steps: readonly unknown[] },
  offer = true,
): Promise<ToolExecutionResult> {
  return callThroughTheColumn(bench, ACT_COMPONENT_TOOL_NAME, args, offer)
}

describe('the act_component chain', () => {
  it('settles a call with the steps the console ran inside the entry, over the served routes', async () => {
    drawColumn()
    const bench = await boot()
    const pressed = vi.fn()
    document.querySelector('[data-component-action="add"]')?.addEventListener('click', pressed)

    const result = await actThroughTheColumn(bench, { entry: ENTRY, steps: [CLICK_ADD] })

    expect(pressed).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      status: 'done',
      entry: { id: ENTRY, title: ENTRY },
      steps: [{ index: 1, status: 'ok' }],
      text: `Acted on the component entry "${ENTRY}" (${ENTRY}).\n- click on "add": done`,
    })
    // What the model reads is the report's own text, rendered by the tool.
    expect(result.content).toEqual([{ type: 'text', text: (result.value as { text: string }).text }])
    // The claim and the report carry the tab identity the page channel minted:
    // one page load, one tab, whichever domain answers.
    expect(bench.posts.map(post => post.path)).toEqual([CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE])
    expect(bench.posts.map(post => ({ callId: post.body.callId, tabId: post.body.tabId }))).toEqual([
      { callId: CALL, tabId: bench.channel.tabId },
      { callId: CALL, tabId: bench.channel.tabId },
    ])
    expect(bench.posts[1]?.body.outcome).toMatchObject({ status: 'done' })
    // The loop writes the result, and the call leaves the projection with it, so
    // a later frame does not offer it to a seat again.
    bench.session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'msg_1',
        role: 'user',
        content: [{ type: 'tool_result', callId: CALL, content: [], isError: false }],
        source: { kind: 'tool', callId: CALL },
      },
    } as never, { surfaceOp: 'append' })
    expect(bench.pending()).toEqual([])
  })

  it('refuses a step that would leave the entry, and leaves what is outside it untouched', async () => {
    drawColumn()
    const bench = await boot()
    const outside = vi.fn()
    document.querySelector('[data-component-action="console-add"]')?.addEventListener('click', outside)

    const result = await actThroughTheColumn(bench, { entry: ENTRY, steps: [{ action: 'click', key: 'console-add' }] })

    expect(outside).not.toHaveBeenCalled()
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({
      status: 'failed',
      steps: [{ index: 1, status: 'failed', message: 'control "console-add" is not part of the entry on display.' }],
    })
  })

  it('refuses a call while another entry is in front, and says which one it is', async () => {
    drawColumn('other')
    const bench = await boot()
    const result = await actThroughTheColumn(bench, { entry: ENTRY, steps: [CLICK_ADD] })
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('act_component did not run: The entry in front is "other", not the one this call named.')
    }
    expect(bench.posts.map(post => post.body.outcome)).toEqual([
      undefined,
      { status: 'error', code: 'front-changed', message: 'The entry in front is "other", not the one this call named.' },
    ])
  })

  it('refuses a call past the step ceiling before any console is asked', async () => {
    drawColumn()
    const bench = await boot()
    // The call is in the log even though the projection publishes none of it:
    // nine steps is not a set of arguments this tool or the fold can read.
    const result = await actThroughTheColumn(bench, {
      entry: ENTRY,
      steps: Array.from({ length: 9 }, () => CLICK_ADD),
    }, false)
    expect(result.isError).toBe(true)
    if (result.isError) expect(result.error.message).toBe('act_component runs at most 8 steps in one call.')
    expect(bench.posts).toEqual([])
  })

  it('answers unverified when a console claimed the call and never reported', async () => {
    drawColumn()
    const bench = await boot({ actTimeoutMs: 300 })
    bench.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CALL as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ entry: ENTRY, steps: [CLICK_ADD] }),
    })
    const settled = bench.call(ACT_COMPONENT_TOOL_NAME, { entry: ENTRY, steps: [CLICK_ADD] })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    await bench.claim(CALL)
    const result = await settled
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({ status: 'unverified', steps: [] })
    expect((result.value as { text: string }).text).toContain('A console claimed the call and reported nothing within 300ms')
  })

  it('refuses a posted report this domain cannot read, and leaves the call waiting', async () => {
    drawColumn()
    const bench = await boot({ actClaimTimeoutMs: 300 })
    bench.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CALL as ToolCallId,
      name: ACT_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ entry: ENTRY, steps: [CLICK_ADD] }),
    })
    const settled = bench.call(ACT_COMPONENT_TOOL_NAME, { entry: ENTRY, steps: [CLICK_ADD] })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    // The report route reads the body with the member that opened the call, so
    // a document this domain does not take is refused there rather than folded
    // into a session.
    const refused = await realFetch(`${bench.origin}${CONTENT_REPORT_ROUTE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ callId: CALL, tabId: bench.channel.tabId, outcome: { status: 'nonsense' } }),
    })
    expect(refused.status).toBe(400)
    expect(bench.pending()).toHaveLength(1)
    const result = await settled
    expect(result.isError).toBe(true)
  })

  it('refuses a call no console ever claimed, with the claim window it waited', async () => {
    drawColumn()
    const bench = await boot({ actClaimTimeoutMs: 300 })
    const result = await actThroughTheColumn(bench, { entry: ENTRY, steps: [CLICK_ADD] }, false)
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('No console showing this session claimed the call within 300ms, so no step ran.')
    }
    // No seat bid, so no route was reached at all.
    expect(bench.posts).toEqual([])
  })
})

describe('the channel member this row joins', () => {
  it('leaves with the row, so a report for a call that domain opened is no longer read by it', async () => {
    // Nothing here offers the calls to a seat: the posts are made the way a
    // browser half posts them, so what the report route answers is the
    // membership's own doing and not another domain's reading of the body.
    // The page domain beside it accepts one step per call, which is what makes
    // the two-step report below this domain's wherever the channel reads it.
    const bench = await boot({ pageMaxSteps: 1, actTimeoutMs: 400 })
    const report = {
      status: 'done',
      page: { id: ENTRY, title: ENTRY },
      title: ENTRY,
      steps: [{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }],
      text: `Acted on the component entry "${ENTRY}" (${ENTRY}).`,
      truncated: false,
    }
    const started: Promise<ToolExecutionResult>[] = []
    for (const callId of ['call_1', 'call_2']) {
      bench.session.append('tool/call', {
        turn: 1,
        step: 1,
        callId: callId as ToolCallId,
        name: ACT_COMPONENT_TOOL_NAME,
        arguments: JSON.stringify({ entry: ENTRY, steps: [CLICK_ADD] }),
      })
      started.push(bench.call(ACT_COMPONENT_TOOL_NAME, { entry: ENTRY, steps: [CLICK_ADD] }, callId))
    }
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    await bench.claim('call_1')
    await bench.claim('call_2')
    // While the row is loaded its member is the one the call was opened by, so
    // the report settles the call it names.
    const read = await bench.post('call_1', report)
    expect(read.status).toBe(200)
    expect(await read.json()).toEqual({ accepted: true })
    expect(await started[0]).toMatchObject({ isError: false, value: { status: 'done' } })
    await bench.unloadRow()
    // The row is gone, so the member it registered left the channel with it:
    // the same report speaks for no domain any more, and the call it names is
    // left waiting until the composition that opened it goes away.
    const refused = await bench.post('call_2', report)
    expect(refused.status).toBe(400)
    // Nobody ran its steps and nobody read a report for it: the call waits out
    // the answer deadline it was opened with and comes back as such.
    expect(await started[1]).toMatchObject({ isError: false, value: { status: 'unverified' } })
  })
})

describe('the read_component chain', () => {
  it('settles a read call with the reading the console composed inside the entry, over the served routes', async () => {
    drawColumn(ENTRY, `
      <div data-component-node="toolbar"><button data-component-action="add">Add</button></div>
      <input data-component-field="zh_label" value="层名">
    `)
    const bench = await boot()

    const result = await callThroughTheColumn(bench, READ_COMPONENT_TOOL_NAME, { entry: ENTRY })

    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toEqual({
      status: 'done',
      entry: { id: ENTRY, title: ENTRY },
      text: [
        `Read the component entry "${ENTRY}" (${ENTRY}).`,
        'Blocks: toolbar.',
        'Controls:',
        '- "add" (in toolbar): button "Add"',
        'Fields:',
        '- "zh_label": textbox = "层名"',
        'No dialog is open.',
      ].join('\n'),
    })
    // What the model reads is the reading's own text, rendered by the tool.
    expect(result.content).toEqual([{ type: 'text', text: (result.value as { text: string }).text }])
    // The read rode the same claim and report routes and the same tab identity
    // the acting tool uses: one channel, one seat, two tools.
    expect(bench.posts.map(post => post.path)).toEqual([CONTENT_CLAIM_ROUTE, CONTENT_REPORT_ROUTE])
    expect(bench.posts.every(post => post.body.tabId === bench.channel.tabId)).toBe(true)
    expect(bench.posts[1]?.body.outcome).toMatchObject({ status: 'read' })
  })

  it('refuses a read call no console ever claimed, with the claim window it waited', async () => {
    drawColumn()
    const bench = await boot({ actClaimTimeoutMs: 300 })
    const result = await callThroughTheColumn(bench, READ_COMPONENT_TOOL_NAME, { entry: ENTRY }, false)
    expect(result.isError).toBe(true)
    if (result.isError) {
      expect(result.error.message).toBe('No console showing this session claimed the call within 300ms, so nothing was read.')
    }
    expect(bench.posts).toEqual([])
  })

  it('answers unverified when a console claimed the read and never reported', async () => {
    drawColumn()
    const bench = await boot({ actTimeoutMs: 300 })
    bench.session.append('tool/call', {
      turn: 1,
      step: 1,
      callId: CALL as ToolCallId,
      name: READ_COMPONENT_TOOL_NAME,
      arguments: JSON.stringify({ entry: ENTRY }),
    })
    const settled = bench.call(READ_COMPONENT_TOOL_NAME, { entry: ENTRY })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    await bench.claim(CALL)
    const result = await settled
    expect(result.isError).toBe(false)
    if (result.isError) return
    expect(result.value).toMatchObject({ status: 'unverified' })
    expect((result.value as { text: string }).text)
      .toBe('A console claimed the call and reported nothing within 300ms; the reading never arrived.')
  })
})

describe('one tab identity for every domain in the page', () => {
  it('bids under the channel instance\'s own tab id, whichever domain the call belongs to', async () => {
    const bench = await boot()
    const posts: Post[] = []
    vi.stubGlobal('fetch', (url: URL | string, init?: RequestInit) => {
      const resolved = new URL(String(url), document.baseURI)
      posts.push({ path: resolved.pathname, body: JSON.parse(String(init?.body)) as Post['body'] })
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ claimed: true, tabId: bench.channel.tabId }) })
    })
    const second = bench.channel.join({
      name: 'another_domain',
      ready: () => true,
      answer: () => Promise.resolve({ kind: 'outcome' as const, outcome: { status: 'error' as const, code: 'empty' as const, message: 'no' } }),
    })
    bench.wiring.offer(bench.session.id, [{ callId: 'call_act', tool: 'act_component', args: { entry: ENTRY, steps: [CLICK_ADD] } }])
    second.offer({
      calls: [{ callId: 'call_other', sessionId: bench.session.id }],
      openCalls: ['call_act', 'call_other'],
    })
    await new Promise<void>((resolve) => { setTimeout(resolve, 30) })
    const claims = posts.filter(post => post.path === CONTENT_CLAIM_ROUTE)
    expect(claims.map(post => post.body.callId).sort()).toEqual(['call_act', 'call_other'])
    expect(new Set(claims.map(post => post.body.tabId))).toEqual(new Set([bench.channel.tabId]))
  })
})
