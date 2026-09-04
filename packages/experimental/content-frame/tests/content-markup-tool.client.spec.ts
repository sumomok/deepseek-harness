/**
 * The three markup reads against the real tool runtime: what the model is
 * offered, what it is refused before anything waits, and what each settlement
 * answers with.
 *
 * Every model-visible string is pinned verbatim. The descriptions are what
 * decide whether a model reaches for a whole page of markup where a listing
 * would have done, and the refusals are the only text it reads while deciding
 * its next step.
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
import {
  contentReadAttrsTool, contentReadDomContentTool, contentReadDomTool,
} from '../src/access/markup-tool.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import type { ReadOutcome, ReadSnapshot } from '../src/access/wire.ts'

/** Deadlines short enough for a test to sit through both of them. */
const FAST: CallTimeouts = { claimTimeoutMs: 30, answerTimeoutMs: 60, pinMs: 5000 }

/** The tab every case here answers from. */
const TAB = 'tab_1'

/** One tree, as a browser seat posts it. */
const TREE: ReadSnapshot = {
  kind: 'dom',
  url: 'http://127.0.0.1:5173/content-app/reports/?q=open#top',
  title: 'Fleet console',
  signIn: false,
  text: 'e1 section#ops {class: panel}\n  e2 i {class: el-icon-edit}',
  truncated: false,
  shown: 2,
  total: 2,
  settled: true,
}

let calls = 0

/** A parent Agent backed by a real Session — the tool reads `agent.session.header.id`. */
function agentWithSession(session: Session): NonNullable<ToolExecutionInput['agent']> {
  return { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>
}

/** One booted set of the three tools, plus the table a browser answers through. */
interface Bench {
  ctx: Context
  pending: PendingCalls
  run: (name: string, args: Record<string, unknown>) => { callId: string; settled: Promise<ToolExecutionResult> }
}

/** Boot the three tools over a real registry and a real session. */
async function bench(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const pending = new PendingCalls()
  const wait = { pending, timeouts: FAST, front: () => undefined }
  ctx.tools.register(contentReadDomTool(wait))
  ctx.tools.register(contentReadAttrsTool(wait))
  ctx.tools.register(contentReadDomContentTool(wait))
  const session = Session.create(SessionId(`content-markup-${++calls}`))
  const agent = agentWithSession(session)
  return {
    ctx,
    pending,
    run: (name, args) => {
      const callId = `call-${++calls}`
      return {
        callId,
        settled: ctx.tools.execute({
          callId: callId as ToolExecutionInput['callId'],
          name,
          arguments: args,
          agent,
          signal: new AbortController().signal,
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

/** One whole successful outcome over one posted snapshot. */
function posted(snapshot: Partial<ReadSnapshot> = {}): ReadOutcome {
  return { status: 'ok', page: { id: 'home', title: 'Home' }, snapshot: { ...TREE, ...snapshot } }
}

/** Run one call of one tool and answer it with one outcome. */
async function settleWith(
  name: string,
  args: Record<string, unknown>,
  outcome: ReadOutcome,
): Promise<ToolExecutionResult> {
  const { pending, run } = await bench()
  const { callId, settled } = run(name, args)
  await answer(pending, callId, outcome)
  return await settled
}

describe('what the three markup reads offer the model', () => {
  it('pins the element tree\'s description and parameters verbatim', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().find(schema => schema.name === 'content_read_dom')).toEqual({
      name: 'content_read_dom',
      description: 'Print the page\'s own markup under one ref: every element inside it, one per line and '
        + 'indented by nesting, each with its tag, its #id, its class tokens as {class: ...}, a ref of its own, '
        + 'and the start of the text it holds directly. Nothing is interpreted — this is what the document '
        + 'says, verbatim. It answers what a row of the page is built from — the tag, the id and the class '
        + 'tokens — which is what a skill about this application reads to say what a row the page names nowhere '
        + 'is. scope is required, so the markup is always printed under one element. Every element printed '
        + 'keeps a ref that later calls can point at and act on. A long text is cut on its line and says so. '
        + 'A cut tree returns a cursor: pass it as after, with the same scope. Never prints a password box\'s '
        + 'value.',
      parameters: {
        type: 'object',
        properties: {
          scope: {
            type: 'string',
            description: 'a ref (like e12) printed by an earlier read of this page: the element whose markup to '
              + 'print, and everything inside it',
          },
          after: {
            type: 'string',
            description: 'the cursor a cut tree returned; continues right after it — pass the same scope with it',
          },
        },
        required: ['scope'],
      },
    })
  })

  it('pins the attribute read\'s description and parameters verbatim', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().find(schema => schema.name === 'content_read_attrs')).toEqual({
      name: 'content_read_attrs',
      description: 'Print every attribute of one element, name and value exactly as the page wrote them — '
        + 'data-*, href, type, style, whatever it carries — and nothing else. The ref comes from an earlier '
        + 'read of this page. It answers what identifies a row where that is written in an attribute rather '
        + 'than in its class tokens; what any of it means is for a skill about this application to say and '
        + 'never for this tool. A password box\'s value is withheld.',
      parameters: {
        type: 'object',
        properties: {
          ref: {
            type: 'string',
            description: 'a ref (like e12) printed by an earlier read of this page: the one element to read',
          },
        },
        required: ['ref'],
      },
    })
  })

  it('pins the whole-text read\'s description verbatim', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().find(schema => schema.name === 'content_read_dom_content')?.description).toBe(
      'Print the whole visible text of one element as the page renders it: a line break wherever the page '
      + 'breaks the line, and nothing the page hides. Nothing is cut, so a long text — a paragraph, a cell, a '
      + 'message — arrives entire. The ref comes from an earlier read of this page. A text larger than one '
      + 'result can carry is refused, with its size, rather than shortened.',
    )
  })

  it('offers all three only where the deployment configured page access', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().map(schema => schema.name).sort()).toEqual([
      'content_read_attrs', 'content_read_dom', 'content_read_dom_content',
    ])
  })
})

describe('what a markup read answers with', () => {
  it('opens with the page and the address, then prints the markup', async () => {
    const result = await settleWith('content_read_dom', { scope: 'e1' }, posted())
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top\n'
      + 'e1 section#ops {class: panel}\n  e2 i {class: el-icon-edit}',
    )
  })

  it('says the page was still changing when the read ran', async () => {
    const result = await settleWith('content_read_dom', { scope: 'e1' }, posted({ settled: false }))
    expect(text(result)).toContain(
      '\nThe page was still changing when this read ran; read again for the settled page.\n',
    )
  })

  it('carries the cursor a cut tree returned', async () => {
    const result = await settleWith(
      'content_read_dom',
      { scope: 'e1' },
      posted({ truncated: true, shown: 1, total: 9, cursor: 'e2' }),
    )
    expect(text(result)).toContain('e1 section#ops')
    expect(result.isError).toBe(false)
  })

  it('answers the attribute read under its own kind', async () => {
    const result = await settleWith(
      'content_read_attrs',
      { ref: 'e2' },
      posted({ kind: 'attrs', text: 'e2 i\n  class="el-icon-edit"', shown: 1, total: 1 }),
    )
    expect(text(result)).toBe(
      'Page: Home — the app is at /content-app/reports/?q=open#top\ne2 i\n  class="el-icon-edit"',
    )
  })

  it('answers the whole-text read under its own kind', async () => {
    const result = await settleWith(
      'content_read_dom_content',
      { ref: 'e2' },
      posted({ kind: 'content', text: '编辑', shown: 1, total: 1 }),
    )
    expect(text(result)).toBe('Page: Home — the app is at /content-app/reports/?q=open#top\n编辑')
  })

  it('prints an address the browser reported unparsed rather than dropping it', async () => {
    // A wire value: the browser sends `document.URL`, which is absolute, but
    // the report route takes JSON from anything that can reach the origin.
    const result = await settleWith('content_read_dom', { scope: 'e1' }, posted({ url: 'not an address' }))
    expect(text(result)).toContain('the app is at not an address')
  })
})

describe('what a markup read refuses', () => {
  it('names the parameter each refusal is about', async () => {
    const { run } = await bench()
    for (const [name, args, refusal] of [
      ['content_read_dom', { scope: 'twelve' },
        'scope must be a ref like "e12" printed by an earlier read of this page'],
      ['content_read_dom', { scope: 'e1', after: '12' },
        'after must be a ref like "e12" that a cut tree returned'],
      ['content_read_attrs', { ref: 'e' },
        'ref must be a ref like "e12" printed by an earlier read of this page'],
      ['content_read_dom_content', { ref: 'twelve' },
        'ref must be a ref like "e12" printed by an earlier read of this page'],
    ] as const) {
      const result = await run(name, { ...args }).settled
      expect({ name, isError: result.isError, text: text(result) })
        .toEqual({ name, isError: true, text: `Error: ${refusal}` })
    }
  })

  it('refuses a call with no owning session, naming the tool that was called', async () => {
    const { ctx } = await bench()
    for (const name of ['content_read_dom', 'content_read_attrs', 'content_read_dom_content']) {
      const result = await ctx.tools.execute({
        callId: `call-${++calls}` as ToolExecutionInput['callId'],
        name,
        arguments: name === 'content_read_dom' ? { scope: 'e1' } : { ref: 'e1' },
        signal: new AbortController().signal,
      })
      expect(text(result)).toBe('Error: This call has no owning agent session')
    }
  })

  it('withholds the markup of a page asking the user to sign in', async () => {
    // A sign-in page's markup is the credential form itself, which is the one
    // page whose spelling the model has no business reading.
    const result = await settleWith('content_read_dom', { scope: 'e1' }, posted({ signIn: true }))
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: The page in the content column shows a sign-in form, which is not read.')
  })

  it('refuses an answer that came back under another read\'s kind', async () => {
    const result = await settleWith('content_read_attrs', { ref: 'e1' }, posted())
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: The console answered this call with another call\'s document.',
    )
  })

  it('refuses a report of steps posted against a markup read', async () => {
    const result = await settleWith('content_read_dom', { scope: 'e1' }, {
      status: 'done',
      page: { id: 'home', title: 'Home' },
      title: 'Fleet console',
      steps: [{ index: 1, status: 'ok' }],
      text: 'Done 1/1 on Home: click "Refresh" (settled after 0.1s).',
      truncated: false,
    } as never)
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('The console answered this call with another call\'s document.')
  })

  it('names itself where the column holds nothing and where it holds another kind', async () => {
    const empty = await settleWith('content_read_dom', { scope: 'e1' }, {
      status: 'error', code: 'empty', message: 'the content column is empty',
    })
    expect(text(empty)).toBe(
      'Error: The content column is empty.',
    )
    const chart = await settleWith('content_read_attrs', { ref: 'e1' }, {
      status: 'error', code: 'not-a-page', message: 'the entry in front is not a page', kind: 'chart', title: '黄金',
    })
    expect(text(chart)).toBe(
      'Error: The entry the content column has in front is not a page (the chart "黄金").',
    )
  })

  it('passes the reader\'s own refusal through with the call that mints fresh refs', async () => {
    const stale = await settleWith('content_read_dom', { scope: 'e9' }, {
      status: 'error', code: 'engine', message: 'scope: "e9" names no element on the page now',
    })
    expect(text(stale)).toBe(
      'Error: scope: "e9" names no element on the page now',
    )
  })

  it('says no console is open once the claim window passes', async () => {
    const { run } = await bench()
    const result = await run('content_read_dom', { scope: 'e1' }).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: No open, visible console tab is showing this session\'s content column (waited 0.03s).',
    )
  })

  it('says the console went quiet once the report deadline passes', async () => {
    const { pending, run } = await bench()
    const { callId, settled } = run('content_read_attrs', { ref: 'e1' })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await pending.claim({ callId, tabId: TAB })).claimed) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    const result = await settled
    expect(text(result)).toBe(
      'Error: The console claimed this read but did not answer within 0.06s.',
    )
  })

  it('names the tool a cancelled call belonged to', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const pending = new PendingCalls()
    const session = Session.create(SessionId(`content-markup-abort-${++calls}`))
    const control = new AbortController()
    control.abort()
    await expect(contentReadDomContentTool({ pending, timeouts: FAST, front: () => undefined })
      .execute({ ref: 'e1' }, {
        callId: 'call_abort' as ToolExecutionInput['callId'],
        agent: agentWithSession(session),
        signal: control.signal,
      } as never)).rejects.toThrow('This call was cancelled')
  })
})

describe('how the three reads appear in the transcript', () => {
  it('names the call and what it asked for', () => {
    const pending = new PendingCalls()
    const wait = { pending, timeouts: FAST, front: () => undefined }
    expect(contentReadDomTool(wait).presentCall?.({ scope: 'e12' })).toEqual({
      card: 'generic',
      title: 'Read the markup of the page in the content column',
      kind: 'other',
      rawInput: 'scope e12',
    })
    expect(contentReadDomTool(wait).presentCall?.({ scope: 'e12', after: 'e30' })).toEqual({
      card: 'generic',
      title: 'Read the markup of the page in the content column',
      kind: 'other',
      rawInput: 'scope e12, after e30',
    })
    expect(contentReadAttrsTool(wait).presentCall?.({ ref: 'e12' })).toEqual({
      card: 'generic',
      title: 'Read one element\'s attributes in the content column',
      kind: 'other',
      rawInput: 'ref e12',
    })
    expect(contentReadDomContentTool(wait).presentCall?.({ ref: 'e12' })).toEqual({
      card: 'generic',
      title: 'Read one element\'s text in the content column',
      kind: 'other',
      rawInput: 'ref e12',
    })
  })

  it('lets two reads of one step share a seat', () => {
    const wait = { pending: new PendingCalls(), timeouts: FAST, front: () => undefined }
    // The reads write nothing and only wait on a browser, so the registry may
    // run them together and one seat answers them one after the other.
    for (const tool of [contentReadDomTool(wait), contentReadAttrsTool(wait), contentReadDomContentTool(wait)]) {
      expect(tool.isConcurrencySafe?.({ ref: 'e1', scope: 'e1' })).toBe(true)
    }
  })

  it('names the page in the settled row of a single-element read', () => {
    const wait = { pending: new PendingCalls(), timeouts: FAST, front: () => undefined }
    const tool = contentReadAttrsTool(wait)
    expect(tool.presentResult?.({ ref: 'e1' }, {
      content: [{ type: 'text', text: 'Page: Home — the app is at /\ne1 i' }],
      isError: false,
    })).toEqual({ card: 'generic', title: 'Page: Home — the app is at /' })
    expect(tool.presentResult?.({ ref: 'e1' }, { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Read one element\'s attributes in the content column' })
  })

  it('names the page in the settled row, and degrades to the call title without one', () => {
    const wait = { pending: new PendingCalls(), timeouts: FAST, front: () => undefined }
    const tool = contentReadDomTool(wait)
    expect(tool.presentResult?.({ scope: 'e1' }, {
      content: [{ type: 'text', text: 'Page: Home — the app is at /\ne1 div' }],
      isError: false,
    })).toEqual({ card: 'generic', title: 'Page: Home — the app is at /' })
    expect(tool.presentResult?.({ scope: 'e1' }, { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Read the markup of the page in the content column' })
  })
})
