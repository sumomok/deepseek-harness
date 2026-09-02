/**
 * `content_read` against the real tool runtime: what the model is offered, what
 * each of the four settlements answers with, and the header the listing arrives
 * under.
 *
 * Every model-visible string is pinned verbatim, because those strings are the
 * whole contract the model reads — the description it chooses the tool from,
 * the parameter lines, and above all the failures, which are the only tool text
 * it reads while deciding its next step. The two deadline sentences are pinned
 * twice: once against the shipped defaults as pure text, and once through a
 * real settlement with the short deadlines these cases can afford to wait for.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { contentReadTool } from '../src/access/read-tool.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import { unansweredRefusal, unclaimedRefusal, type FrontEntry } from '../src/access/text.ts'
import type { ReadOutcome, ReadSnapshot } from '../src/access/wire.ts'

/** Deadlines short enough for a test to sit through both of them. */
const FAST: CallTimeouts = { claimTimeoutMs: 30, answerTimeoutMs: 60, pinMs: 5000 }

/** The tab every case here answers from. */
const TAB = 'tab_1'

/** One listing, as a browser seat posts it. */
const LISTING: ReadSnapshot = {
  kind: 'outline',
  url: 'http://127.0.0.1:5173/content-app/reports/?q=open#top',
  title: 'Fleet console',
  signIn: false,
  text: '1 main\n  2 button "Refresh" e12',
  truncated: false,
  shown: 2,
  total: 2,
  settled: true,
}

/** A whole successful outcome over one listing. */
function read(snapshot: Partial<ReadSnapshot> = {}): ReadOutcome {
  return { status: 'ok', page: { id: 'home', title: 'Home' }, snapshot: { ...LISTING, ...snapshot } }
}

let calls = 0

/** A parent Agent backed by a real Session — the tool reads `agent.session.header.id`. */
function agentWithSession(session: Session): NonNullable<ToolExecutionInput['agent']> {
  return { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>
}

/** One booted tool over a real registry, plus the table a browser answers through. */
interface Bench {
  ctx: Context
  pending: PendingCalls
  run: (args: Record<string, unknown>, signal?: AbortSignal) => { callId: string; settled: Promise<ToolExecutionResult> }
}

/** Boot the tool over a real registry and a real session. */
async function bench(timeouts: CallTimeouts = FAST, front?: FrontEntry): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const pending = new PendingCalls()
  ctx.tools.register(contentReadTool(pending, timeouts, () => front))
  const session = Session.create(SessionId(`content-read-${++calls}`))
  const agent = agentWithSession(session)
  return {
    ctx,
    pending,
    run: (args, signal = new AbortController().signal) => {
      const callId = `call-${++calls}`
      return {
        callId,
        settled: ctx.tools.execute({
          callId: callId as ToolExecutionInput['callId'],
          name: 'content_read',
          arguments: args,
          agent,
          signal,
        }),
      }
    },
  }
}

/** Claim one call as soon as its body has registered the wait, then answer it. */
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

/** Run one call and answer it with one outcome. */
async function settleWith(outcome: ReadOutcome, args: Record<string, unknown> = {}): Promise<ToolExecutionResult> {
  const { pending, run } = await bench()
  const { callId, settled } = run(args)
  await answer(pending, callId, outcome)
  return await settled
}

describe('what content_read offers the model', () => {
  it('pins the model-visible schema verbatim', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().find(schema => schema.name === 'content_read')).toEqual({
      name: 'content_read',
      description: 'Read the page the user is looking at in the content column (内容区 — the column between the '
        + 'sidebar and this conversation) as a numbered structure: containers, '
        + 'controls, headings and text, each control carrying a ref like e12 that later calls can point at. The '
        + 'default mode "outline" lists everything in a scope; when the whole page is too large it answers with '
        + 'the page\'s map — its containers with counts — and names the scope to read next. Tables report their '
        + 'header, size and one sample row: pass scope with the table\'s ref to list its rows, or find with a '
        + 'row\'s text to get that row and its buttons\' refs. A cut listing returns a cursor; pass it as after '
        + 'to continue. Reads only the entry in front — call content_show first to put a page there. Never '
        + 'returns a password box\'s value.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['outline', 'map'],
            description: '"outline" (default) lists every item in the scope with refs; "map" lists only the '
              + 'page\'s containers with counts — read it first on an unfamiliar page',
          },
          scope: {
            type: 'string',
            description: 'a ref from a previous read; read only that element\'s subtree — a table to list its '
              + 'rows, a dialog, a section',
          },
          after: { type: 'string', description: 'the cursor a cut listing returned; continues right after it' },
          find: {
            type: 'string',
            description: 'case-insensitive text filter: a flat list of items whose name or text contains it, '
              + 'table rows included',
          },
        },
      },
    })
  })

  it('presents the call and its result as pure functions of what they carry', () => {
    const tool = contentReadTool(new PendingCalls(), FAST, () => undefined)
    expect(tool.presentCall?.({})).toEqual({
      card: 'generic',
      title: 'Read the page in the content column',
      kind: 'other',
    })
    expect(tool.presentCall?.({ mode: 'map', scope: 'e4', after: 'e9', find: 'Ada' })).toEqual({
      card: 'generic',
      title: 'Read the page in the content column',
      kind: 'other',
      rawInput: 'mode map, scope e4, after e9, find "Ada"',
    })
    expect(tool.presentResult?.({}, { content: [{ type: 'text', text: 'Page: Home — x\n1 main' }], isError: false }))
      .toEqual({ card: 'generic', title: 'Page: Home — x' })
    // Replay may reach the presenter with a result carrying no text at all;
    // display must degrade to the pending title rather than throw.
    expect(tool.presentResult?.({}, { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Read the page in the content column' })
  })
})

describe('what content_read refuses before it waits', () => {
  it('names the parameter each refusal is about', async () => {
    const { run } = await bench()
    for (const [args, refusal] of [
      [{ scope: 'twelve' }, 'scope must be a ref like "e12" from a previous read'],
      [{ scope: 'e' }, 'scope must be a ref like "e12" from a previous read'],
      [{ after: '12' }, 'after must be a ref like "e12" from a previous read'],
      [{ find: '' }, 'find must be 1–200 characters'],
      [{ find: 'x'.repeat(201) }, 'find must be 1–200 characters'],
    ] as const) {
      const result = await run({ ...args }).settled
      expect({ args, isError: result.isError, text: text(result) })
        .toEqual({ args, isError: true, text: `Error: ${refusal}` })
    }
  })

  it('takes the longest find it accepts', async () => {
    const { pending, run } = await bench()
    const { callId, settled } = run({ find: 'x'.repeat(200) })
    await answer(pending, callId, read())
    expect((await settled).isError).toBe(false)
  })

  it('refuses a call with no owning session', async () => {
    const { ctx } = await bench()
    const result = await ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'content_read',
      arguments: {},
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: content_read requires an owning agent session')
  })
})

describe('what content_read answers when no listing arrives', () => {
  it('pins the two deadline sentences against the deployment defaults', () => {
    expect(unclaimedRefusal(3000, undefined)).toBe(
      'No open console is showing this session\'s content column (waited 3s). '
      + 'Call content_show to put a page there, or ask the user to open the console, then retry.',
    )
    // A column that already holds something is the case the first sentence
    // gets wrong: `content_show` appends another `content/shown` and answers
    // that it is now showing, without a console being any more open.
    expect(unclaimedRefusal(3000, { entryId: 'points', kind: 'page', title: '点位信息' })).toBe(
      'No open console is showing this session\'s content column (waited 3s); '
      + 'the page "点位信息" is already in front. '
      + 'Ask the user whether they have the console open on this session, then retry. '
      + 'content_show cannot help here.',
    )
    // Named by its own kind word, because the column's key domain is open and
    // `content_show` helps a chart in front no more than a page.
    expect(unclaimedRefusal(3000, { entryId: 'gold', kind: 'chart', title: '黄金走势' })).toContain(
      'the chart "黄金走势" is already in front.',
    )
    expect(unansweredRefusal(15000)).toBe(
      'The console claimed this read but did not answer within 15s; '
      + 'retry once, and if it repeats ask the user to reload the console.',
    )
  })

  it('says no console is open once the claim window passes, and offers content_show for an empty column', async () => {
    const { run } = await bench()
    const result = await run({}).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: No open console is showing this session\'s content column (waited 0.03s). '
      + 'Call content_show to put a page there, or ask the user to open the console, then retry.',
    )
  })

  it('withholds that offer where the column already holds what the read was for', async () => {
    // The whole point of the second path: this session's column is not empty,
    // so the tool the model would reach for next changes nothing about why the
    // read failed, and the refusal says so rather than leaving it to be found.
    const { run } = await bench(FAST, { entryId: 'home', kind: 'page', title: 'Home' })
    const result = await run({}).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: No open console is showing this session\'s content column (waited 0.03s); '
      + 'the page "Home" is already in front. '
      + 'Ask the user whether they have the console open on this session, then retry. '
      + 'content_show cannot help here.',
    )
  })

  it('says the console went quiet once the report deadline passes', async () => {
    const { pending, run } = await bench()
    const { callId, settled } = run({})
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await pending.claim({ callId, tabId: TAB })).claimed) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    const result = await settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: The console claimed this read but did not answer within 0.06s; '
      + 'retry once, and if it repeats ask the user to reload the console.',
    )
  })

  it('refuses a report of steps posted against a read', async () => {
    // One table, one claim, two tools: the tool that opened the wait is what
    // knows whether the document it was handed answers its own call.
    const result = await settleWith({
      status: 'done',
      page: { id: 'home', title: 'Home' },
      title: 'Fleet console',
      steps: [{ index: 1, status: 'ok' }],
      text: 'Done 1/1 on Home: click "Refresh" (settled after 0.1s).',
      truncated: false,
    } as never)
    expect(result.isError).toBe(true)
    expect(text(result))
      .toBe('Error: The console answered this call with something else; call content_read to see where the page is now.')
  })

  it('names the cancellation the agent loop replaces with its own outcome', async () => {
    const aborter = new AbortController()
    const tool = contentReadTool(new PendingCalls(), FAST, () => undefined)
    const session = Session.create(SessionId(`content-read-${++calls}`))
    const exec = {
      callId: 'call_cancelled',
      name: 'content_read',
      arguments: {},
      agent: agentWithSession(session),
      signal: aborter.signal,
    } as unknown as ToolRunContext
    const settled = tool.execute({}, exec)
    aborter.abort()
    await expect(settled).rejects.toThrow('content_read was cancelled')
  })
})

describe('what content_read answers when there is no page to read', () => {
  it('sends the model to content_show for an empty column', async () => {
    const result = await settleWith({ status: 'error', code: 'empty', message: 'the content column is empty' })
    expect(text(result)).toBe('Error: The content column is empty. Call content_show to put a page there, then retry.')
  })

  it('names the entry in front when the seat could name it, and stays general when it could not', async () => {
    const named = await settleWith({
      status: 'error', code: 'not-a-page', message: 'the entry in front is not a page', kind: 'chart', title: 'Revenue',
    })
    expect(text(named)).toBe(
      'Error: The entry in front is not a page (the chart "Revenue"), which content_read cannot read; '
      + 'a chart drawn by show_chart keeps its data in that call\'s arguments. '
      + 'Call content_show to put a page in front.',
    )
    const general = await settleWith({
      status: 'error', code: 'not-a-page', message: 'the entry in front is not a page',
    })
    expect(text(general)).toBe(
      'Error: The entry in front is not a page, which content_read cannot read; '
      + 'a chart drawn by show_chart keeps its data in that call\'s arguments. '
      + 'Call content_show to put a page in front.',
    )
  })

  it('passes the reader\'s own refusal through and says how to get fresh refs', async () => {
    const result = await settleWith({
      status: 'error', code: 'engine', message: 'scope: "e12" names no element on the page now',
    })
    expect(text(result)).toBe(
      'Error: scope: "e12" names no element on the page now Call content_read without scope or after for fresh refs.',
    )
  })

  it('passes a frame failure through exactly as the seat composed it', async () => {
    const result = await settleWith({
      status: 'error', code: 'frame', message: 'The page in the content column had not finished loading; retry once.',
    })
    expect(text(result)).toBe('Error: The page in the content column had not finished loading; retry once.')
  })

  it('withholds the listing of a page asking the user to sign in', async () => {
    const result = await settleWith(read({ signIn: true, text: '1 form\n  2 textbox "Email" e3' }))
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: The page shows a sign-in form; ask the user to sign in, then retry.')
    expect(text(result)).not.toContain('textbox')
  })
})

describe('the listing content_read answers with', () => {
  it('answers the page, the path inside the application, and the listing', async () => {
    const result = await settleWith(read())
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      status: 'ok',
      page: { id: 'home', title: 'Home' },
      title: 'Fleet console',
      // The origin is dropped: every page the column shows is a path on the
      // dsh origin, so the host name would cost tokens and say nothing.
      url: '/content-app/reports/?q=open#top',
      kind: 'outline',
      text: '1 main\n  2 button "Refresh" e12',
      truncated: false,
      shown: 2,
      total: 2,
      settled: true,
    })
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top, title "Fleet console"\n'
      + '1 main\n  2 button "Refresh" e12',
    )
  })

  it('says the page was still changing, and names what it marks as loading', async () => {
    const result = await settleWith(read({ settled: false, busy: ['Fleet status', 'Alerts'] }))
    expect(result.value).toMatchObject({ settled: false, busy: ['Fleet status', 'Alerts'] })
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top, title "Fleet console"\n'
      + 'The page marks these as still loading: "Fleet status", "Alerts"\n'
      + 'The page was still changing when this read ran; read again for the settled page.\n'
      + '1 main\n  2 button "Refresh" e12',
    )
  })

  it('says neither line for a page that had settled and marks nothing loading', async () => {
    const result = await settleWith(read())
    expect(text(result)).not.toContain('still loading')
    expect(text(result)).not.toContain('still changing')
  })

  it('records the page name the transcript row draws, and nothing else', async () => {
    const result = await settleWith(read())
    expect(result.meta).toEqual({ page: 'Home' })
  })

  it('states the trail and the open dialog when the page has them', async () => {
    const result = await settleWith(read({ breadcrumb: 'Home › Fleet › Machine 12', modal: 'Confirm delete' }))
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top, title "Fleet console", '
      + 'breadcrumb Home › Fleet › Machine 12\n'
      + 'dialog "Confirm delete" open (modal) — the rest of the page is behind its mask\n'
      + '1 main\n  2 button "Refresh" e12',
    )
  })

  it('says a map is the map when the page was too large for one read', async () => {
    const result = await settleWith(read({ kind: 'map', truncated: true, shown: 9, total: 412, text: '1 main' }))
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top, title "Fleet console" '
      + '[412 items — too large for one read; this is the map]\n1 main',
    )
  })

  it('carries the cursor a cut listing returned', async () => {
    const result = await settleWith(read({ truncated: true, shown: 2, total: 40, cursor: 'e12' }))
    expect(result.value).toMatchObject({ truncated: true, shown: 2, total: 40, cursor: 'e12' })
    // A cut outline says nothing about a map: the suffix belongs to the map answer.
    expect(text(result)).not.toContain('too large for one read')
  })

  it('keeps a location it could not read as a URL rather than dropping it', async () => {
    // The route takes JSON from anything that can reach the origin, so the
    // location is a wire value rather than a browser's own `document.URL`.
    const result = await settleWith(read({ url: 'wherever the page is' }))
    expect(result.value).toMatchObject({ url: 'wherever the page is' })
  })

  it('runs beside its siblings rather than queueing a second claim window', () => {
    expect(contentReadTool(new PendingCalls(), FAST, () => undefined).isConcurrencySafe?.({})).toBe(true)
  })
})
