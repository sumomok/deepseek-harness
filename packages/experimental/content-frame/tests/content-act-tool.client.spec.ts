/**
 * `content_act` against the real tool runtime: what the model is offered, what
 * it is refused before anything runs, what each settlement answers with, and
 * the approval every call is asked under.
 *
 * The approval cases are the load-bearing ones. A set of steps changes the
 * user's own page, so the red line is that no path reaches the body without the
 * user having been asked — no approval service means denied, a rejection means
 * denied, and confirming the page's own dialog needs a request that said so.
 * Each of those is driven through the registry rather than asserted about the
 * listener, because the registry is what a deployment actually runs.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionInput, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { contentActTool } from '../src/access/act-tool.ts'
import { registerActApproval } from '../src/access/act-approval.ts'
import { DialogApprovals } from '../src/access/dialog-approvals.ts'
import { PendingCalls, type CallTimeouts } from '../src/access/pending.ts'
import type { ActOutcome, ActStep, ChannelOutcome, ClaimAck } from '../src/access/wire.ts'
import type { FrontEntry } from '../src/access/text.ts'

/** Deadlines short enough for a test to sit through both phases. */
const FAST: CallTimeouts = { claimTimeoutMs: 30, answerTimeoutMs: 60, pinMs: 5000 }

/** The steps bound every case here runs under. */
const MAX_STEPS = 20

/** The tab every case here answers from. */
const TAB = 'tab_1'

/** The two steps most cases run. */
const STEPS: ActStep[] = [
  { action: 'fill', ref: 'e4', label: '名称', text: '东风' },
  { action: 'click', ref: 'e5', label: '查询' },
]

/** One whole report of steps that ran, as a browser seat posts it. */
const DONE: ActOutcome = {
  status: 'done',
  page: { id: 'points', title: '点位信息' },
  title: '点位信息 — 控制台',
  steps: [{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }],
  text: 'Done 2/2 on 点位信息: fill "名称" ← "东风"; click "查询" (settled after 0.8s).\n'
    + 'Page events during these steps: none.\nPage now:\n1 main',
  truncated: false,
}

let calls = 0

/** A parent Agent backed by a real Session — the tool reads `agent.session.header.id`. */
function agentWithSession(session: Session): NonNullable<ToolExecutionInput['agent']> {
  return { id: session.id, session } as unknown as NonNullable<ToolExecutionInput['agent']>
}

/** How the deployment under test answers an approval request, if it has a channel at all. */
type Approval = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable' | 'none'

/** One booted tool over a real registry, plus the table a browser answers through. */
interface Bench {
  /** The composition, for a caller reading the registry's own schemas. */
  ctx: Context
  /** The table the browser half claims and reports against. */
  pending: PendingCalls
  /** Every reason the user was asked with, in order. */
  asked: string[]
  /** Run one call, answering it from the table by hand. */
  run: (args: Record<string, unknown>) => { callId: string; settled: Promise<ToolExecutionResult> }
}

/**
 * Boot the tool, its approval listener, and an approval channel that answers
 * one way, over a real registry and a real session.
 * @param approval - what the user's channel answers, or `none` for a deployment with no channel.
 * @param timeouts - the deadlines this case can afford to wait for.
 * @param front - the entry this deployment's column has in front.
 * @returns the bench.
 */
async function bench(
  approval: Approval = 'allowed-once',
  timeouts: CallTimeouts = FAST,
  front?: FrontEntry,
): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const pending = new PendingCalls()
  const approvals = new DialogApprovals()
  const asked: string[] = []
  ctx.tools.register(contentActTool(pending, timeouts, MAX_STEPS, () => front, approvals))
  registerActApproval(ctx, approvals, MAX_STEPS)
  if (approval !== 'none') {
    ctx.provide('approval', {
      request: (request: { reason?: string }) => {
        asked.push(request.reason ?? '')
        return Promise.resolve(approval)
      },
    } as never)
  }
  const agent = agentWithSession(Session.create(SessionId(`content-act-${++calls}`)))
  return {
    ctx,
    pending,
    asked,
    run: (args) => {
      const callId = `call-${++calls}`
      return {
        callId,
        settled: ctx.tools.execute({
          callId: callId as ToolExecutionInput['callId'],
          name: 'content_act',
          arguments: args,
          agent,
          signal: new AbortController().signal,
        }),
      }
    },
  }
}

/** Claim one call as soon as its body has registered the wait, then answer it. */
async function answer(pending: PendingCalls, callId: string, outcome: ChannelOutcome): Promise<void> {
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
async function settleWith(
  outcome: ChannelOutcome,
  args: Record<string, unknown> = { steps: STEPS },
): Promise<ToolExecutionResult> {
  const { pending, run } = await bench()
  const { callId, settled } = run(args)
  await answer(pending, callId, outcome)
  return await settled
}

describe('the entry one call was approved against', () => {
  it('hands the claiming console the entry the column had in front when the wait opened', async () => {
    // The wait opens after the user has answered, so this is the entry they
    // were looking at while they read the request — and the seat holds the
    // column to it rather than running the steps on whatever is there now.
    const { pending, run } = await bench('allowed-once', FAST, { entryId: 'points', kind: 'page', title: '点位信息' })
    const { callId, settled } = run({ steps: STEPS })
    let ack: ClaimAck = { claimed: false }
    for (let attempt = 0; attempt < 200 && !ack.claimed; attempt += 1) {
      ack = await pending.claim({ callId, tabId: TAB })
      if (!ack.claimed) await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    expect(ack).toEqual({ claimed: true, page: { id: 'points', title: '点位信息' } })
    pending.report({ callId, tabId: TAB, outcome: DONE })
    await settled
  })

  it('composes the refusal a console posts when the column moved under the call', async () => {
    const result = await settleWith({
      status: 'error',
      code: 'front-changed',
      message: 'The page in front is now "报表", not "点位信息" the steps were approved for; nothing was done.',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: The page in front is now "报表", not "点位信息" the steps were approved for; nothing was done.',
    )
  })
})

describe('what content_act offers the model', () => {
  it('pins the model-visible schema verbatim', async () => {
    const { ctx } = await bench()
    expect(ctx.tools.schemas().find(schema => schema.name === 'content_act')).toEqual({
      name: 'content_act',
      description: 'Act on the page the user is looking at in the content column (内容区 — the column between '
        + 'the sidebar and this conversation), the way the user would: click a '
        + 'control, fill a box, choose from a list, press a key, or wait for text to appear. Every target is a '
        + 'ref from an earlier read of this page, and every label is that element\'s name copied from the '
        + 'read — the browser checks the name before it acts, so a page that changed since the read stops the '
        + 'call instead of '
        + 'clicking something else; for a row the read printed with no name, pass label "" and its mark, the '
        + 'class tokens the read printed for it. The steps run in order and stop at the first failure; '
        + 'the answer reports '
        + 'each step, what the page did while they ran, and a fresh reading of the page. One call is one '
        + 'approval request, so put the steps that belong together in one call.',
      parameters: {
        type: 'object',
        required: ['steps'],
        properties: {
          steps: {
            type: 'array',
            description: 'the steps to run in order, each {action, ref, label, mark?, text?, value?, key?}',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                action: {
                  type: 'string',
                  enum: ['click', 'fill', 'select', 'press', 'wait'],
                  description: '"click" a control; "fill" replaces a box\'s whole value with text; "select" '
                    + 'chooses the option whose visible text is value; "press" sends one key such as Enter or '
                    + 'Escape; "wait" waits for text to appear anywhere on the page',
                },
                ref: {
                  type: 'string',
                  description: 'the element\'s ref, like "e12", printed by an earlier read of this page; omit only for "wait"',
                },
                label: {
                  type: 'string',
                  description: 'the element\'s name exactly as the read printed it; the browser refuses the '
                    + 'step when the page now shows another name there. Pass "" for a row the read printed '
                    + 'with no name, and give mark as well. Omit only for "wait"',
                },
                mark: {
                  type: 'string',
                  description: 'only for a row the read printed with no name: the class tokens the read '
                    + 'printed for it, which is what the browser checks that row by. where the read printed '
                    + 'e7 clickable {class: row-action danger}, pass ref "e7", label "" and mark "row-action '
                    + 'danger" — the tokens alone, without the braces and without the "class:" printed in '
                    + 'front of them. Omit for every row that has a name',
                },
                text: { type: 'string', description: 'what "fill" types, and what "wait" waits to see' },
                value: { type: 'string', description: 'the option "select" chooses, by the text the user would read' },
                key: {
                  type: 'string',
                  description: 'the key "press" sends, as the browser names it: Enter, Escape, Tab, ArrowDown',
                },
              },
              required: ['action'],
            },
          },
          dialogs: {
            type: 'string',
            enum: ['cancel', 'accept'],
            description: 'how to answer a confirm/alert/prompt the page itself opens while these steps run: '
              + '"cancel" (the default) records what it said and stops at that step; "accept" is only permitted '
              + 'when the approval request said so, so pass it only when the user is being asked to approve '
              + 'confirming as well',
          },
        },
      },
    })
  })

  it('presents the call as the same sentence the user was asked, and the result by its first line', () => {
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    expect(tool.presentCall?.({ steps: STEPS })).toEqual({
      card: 'generic',
      title: 'Act on the page in the content column',
      kind: 'other',
      rawInput: '在「当前展示的这一项」上：填「名称」为「东风」；点「查询」',
    })
    expect(tool.presentResult?.({ steps: STEPS }, { content: [{ type: 'text', text: DONE.text }], isError: false }))
      .toEqual({
        card: 'generic',
        title: 'Done 2/2 on 点位信息: fill "名称" ← "东风"; click "查询" (settled after 0.8s).',
      })
    // Replay may reach the presenter with a result carrying no text at all.
    expect(tool.presentResult?.({ steps: STEPS }, { content: [], isError: false }))
      .toEqual({ card: 'generic', title: 'Act on the page in the content column' })
  })

  it('presents a call it could not read as steps, rather than throwing on every replay', () => {
    // The presenter runs on replay of whatever was logged, including the
    // arguments this tool refused: a call the body rejected for a missing
    // field would otherwise throw every time its row was drawn.
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    for (const args of [
      { steps: [{ action: 'fill', ref: 'e1', label: '名称' }] },
      { steps: [{ action: 'click', label: '查询' }] },
      { steps: [] },
    ]) {
      expect(tool.presentCall?.(args)).toEqual({
        card: 'generic',
        title: 'Act on the page in the content column',
        kind: 'other',
        rawInput: JSON.stringify(args),
      })
    }
    // Arguments the tool's own schema refuses never reach the presenter at all;
    // the registry answers for those.
    expect(tool.presentCall?.({ steps: [{ action: 'click', ref: 'e1', label: '查询' }], dialogs: 'maybe' }))
      .toBeUndefined()
    // And more steps than this deployment runs is still a call the user was
    // asked about in words, because the wire can read it.
    expect(tool.presentCall?.({ steps: [...STEPS, ...STEPS] })).toEqual({
      card: 'generic',
      title: 'Act on the page in the content column',
      kind: 'other',
      rawInput: '在「当前展示的这一项」上：填「名称」为「东风」；点「查询」；填「名称」为「东风」；点「查询」',
    })
  })

  it('cuts the raw arguments it prints for a call it could not read', () => {
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    const args = { steps: [{ action: 'fill', ref: 'e1', label: '名'.repeat(400) }] }
    const printed = tool.presentCall?.(args) as { rawInput: string } | undefined
    expect(printed?.rawInput).toHaveLength(201)
    expect(printed?.rawInput.endsWith('…')).toBe(true)
  })

  it('runs alone, because two sets of steps would interleave on one page', () => {
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    expect(tool.isConcurrencySafe?.({ steps: STEPS })).toBe(false)
  })
})

describe('what content_act refuses before anyone is asked', () => {
  it('names the step and the parameter each refusal is about', async () => {
    const { run } = await bench()
    for (const [steps, refusal] of [
      [[], 'steps must name at least one step'],
      [
        Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'click', ref: 'e1', label: 'x' })),
        'steps must hold at most 20 steps',
      ],
      [[{ action: 'click', label: '查询' }], 'step 1: every step but "wait" needs ref, a ref like "e12" printed by an earlier read of this page'],
      [[{ action: 'click', ref: 'twelve', label: '查询' }], 'step 1: every step but "wait" needs ref, a ref like "e12" printed by an earlier read of this page'],
      [
        [{ action: 'click', ref: 'e5' }],
        'step 1: every step but "wait" needs label, the element\'s name exactly as the read printed it, '
        + 'or "" for a row it printed with no name',
      ],
      [
        [STEPS[1], { action: 'fill', ref: 'e4', label: '名称' }],
        'step 2: a "fill" step needs text, the value to type into the box',
      ],
      [[{ action: 'select', ref: 'e6', label: '站点' }], 'step 1: a "select" step needs value, the option\'s visible text'],
      [[{ action: 'press', ref: 'e4', label: '名称' }], 'step 1: a "press" step needs key, such as "Enter"'],
      [[{ action: 'wait' }], 'step 1: a "wait" step needs text, the words to wait for'],
      // The same refusal for the empty string, which every page's visible text
      // contains: the step would answer at once having waited for nothing.
      [[{ action: 'wait', text: '' }], 'step 1: a "wait" step needs text, the words to wait for'],
      [[{ action: 'fill', ref: 'e4', label: '名称', text: 'x'.repeat(1001) }], 'step 1: text must be at most 1000 characters'],
      [[{ action: 'select', ref: 'e6', label: '站点', value: 'x'.repeat(1001) }], 'step 1: value must be at most 1000 characters'],
      [[{ action: 'press', ref: 'e4', label: '名称', key: 'x'.repeat(33) }], 'step 1: key must be at most 32 characters'],
      [[{ action: 'click', ref: 'e5', label: 'x'.repeat(257) }], 'step 1: label must be at most 256 characters'],
      // A row the read printed with no name is named by the mark it printed
      // instead, and a row has one identity: a name or a mark, never both.
      [
        [{ action: 'click', ref: 'e5', label: '' }],
        'step 1: a row the read printed with no name is named by its mark: where the read printed '
        + 'e7 clickable {class: row-action danger}, pass ref "e7", label "" and mark "row-action danger" — '
        + 'the tokens alone, without the braces and without the "class:" printed in front of them',
      ],
      // The row as the listing printed it, copied whole into the field: what a
      // console's own log shows a model doing three times over.
      [
        [{ action: 'click', ref: 'e5', label: '', mark: '{class: el-icon-delete}' }],
        'step 1: mark is the class tokens themselves, not the whole of what the read printed '
        + 'there: where the read printed e7 clickable {class: row-action danger}, pass ref "e7", label "" and '
        + 'mark "row-action danger" — the tokens alone, without the braces and without the "class:" printed '
        + 'in front of them',
      ],
      [
        [{ action: 'click', ref: 'e5', label: '', mark: 'class: el-icon-delete' }],
        'step 1: mark is the class tokens themselves, not the whole of what the read printed '
        + 'there: where the read printed e7 clickable {class: row-action danger}, pass ref "e7", label "" and '
        + 'mark "row-action danger" — the tokens alone, without the braces and without the "class:" printed '
        + 'in front of them',
      ],
      [
        [{ action: 'click', ref: 'e5', label: '编辑', mark: 'el-icon-edit' }],
        'step 1: a row has one identity: pass label for a row the read named, or mark with label "" '
        + 'for one it did not — not both',
      ],
      [
        [{ action: 'click', ref: 'e5', label: '', mark: 'x'.repeat(1001) }],
        'step 1: mark must be at most 1000 characters',
      ],
    ] as const) {
      const result = await run({ steps }).settled
      expect({ steps, isError: result.isError, text: text(result) })
        .toEqual({ steps, isError: true, text: `Error: ${refusal}` })
    }
  })

  it('asks about nothing it has already refused', async () => {
    // The request would name a call that cannot run either way, so the refusal
    // comes first and the user is never interrupted for it.
    const { asked, run } = await bench()
    await run({ steps: [] }).settled
    expect(asked).toEqual([])
  })

  it('asks about nothing past the deployment\'s own step bound', async () => {
    // The gate reads the same bound the body does. Without it, a call one step
    // too long would be put in front of the user as twenty-one sentences and
    // then refused by the body anyway — and a model with no approval service
    // would read those sentences as the reason instead of the one naming the
    // bound to split the call at.
    const { asked, run } = await bench()
    const steps = Array.from({ length: MAX_STEPS + 1 }, () => ({ action: 'click', ref: 'e1', label: '查询' }))
    const result = await run({ steps }).settled
    expect(asked).toEqual([])
    expect({ isError: result.isError, text: text(result) }).toEqual({
      isError: true,
      text: 'Error: steps must hold at most 20 steps',
    })
  })

  it('refuses a call with no owning session', async () => {
    const { ctx } = await bench()
    const result = await ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'content_act',
      arguments: { steps: STEPS },
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    // The kernel refuses an agent-less call at the approval seam first, which
    // is the same red line from the other side.
    expect(text(result)).toContain('requires approval')
  })
})

describe('what the body refuses on its own', () => {
  it('refuses a call with no owning session, whatever reached it', async () => {
    // The kernel's approval seam refuses an agent-less call first, so this is
    // driven through the tool directly: there is no session whose column could
    // be acted on, and the body says which.
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    const exec = {
      callId: 'call_no_agent',
      name: 'content_act',
      arguments: { steps: STEPS },
      signal: new AbortController().signal,
      rootCallId: 'call_no_agent',
      token: {},
    } as unknown as Parameters<NonNullable<typeof tool.execute>>[1]
    await expect(tool.execute?.({ steps: STEPS }, exec))
      .rejects.toThrow('This call has no owning agent session')
  })
})

describe('the approval every set of steps runs under', () => {
  it('asks with the steps in the user\'s own words', async () => {
    const { asked, pending, run } = await bench()
    const { callId, settled } = run({ steps: STEPS })
    await answer(pending, callId, DONE)
    expect((await settled).isError).toBe(false)
    expect(asked).toEqual(['在「当前展示的这一项」上：填「名称」为「东风」；点「查询」'])
  })

  it('denies where the deployment composes no approval channel', async () => {
    // The historical degrade, and the reason the listener asks rather than
    // allowing: a composition with no channel runs no steps at all.
    const { run } = await bench('none')
    const result = await run({ steps: STEPS }).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe('Error: 在「当前展示的这一项」上：填「名称」为「东风」；点「查询」')
  })

  it('denies a rejection, a cancellation, and an unavailable channel', async () => {
    for (const [approval, refusal] of [
      ['rejected', 'Error: the user rejected tool "content_act"'],
      ['cancelled', 'Error: approval for tool "content_act" was cancelled'],
      ['unavailable', 'Error: tool "content_act" requires approval, but no approval channel is available'],
    ] as const) {
      const { run } = await bench(approval)
      const result = await run({ steps: STEPS }).settled
      expect({ approval, isError: result.isError, text: text(result) })
        .toEqual({ approval, isError: true, text: refusal })
    }
  })

  it('keeps a denial another listener reached first', async () => {
    // Delegation, not short-circuiting: a policy that denies this call still
    // denies it, and the user is not asked to approve what is already refused.
    const { asked, ctx, run } = await bench()
    ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'deny', reason: 'policy says no' }))
    const result = await run({ steps: STEPS }).settled
    expect({ isError: result.isError, text: text(result), asked })
      .toEqual({ isError: true, text: 'Error: policy says no', asked: [] })
  })

  it('says outright when the page\'s own confirmation is part of what is approved', async () => {
    const { asked, pending, run } = await bench()
    const { callId, settled } = run({ steps: [STEPS[1]], dialogs: 'accept' })
    await answer(pending, callId, DONE)
    expect((await settled).isError).toBe(false)
    expect(asked).toEqual(['在「当前展示的这一项」上：点「查询」，并确认页面弹出的确认框'])
  })

  it('refuses to confirm a dialog on a call the user was never asked about', async () => {
    // The path that matters: a standing allowance, a policy that never asks, or
    // any other listener that allows the call reaches the body without the
    // request the user read. Confirming the page's own dialog needs that
    // request, so this call is refused rather than run with cancel.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    ctx.tools.register(contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals()))
    const result = await ctx.tools.execute({
      callId: `call-${++calls}` as ToolExecutionInput['callId'],
      name: 'content_act',
      arguments: { steps: [STEPS[1]], dialogs: 'accept' },
      agent: agentWithSession(Session.create(SessionId(`content-act-${++calls}`))),
      signal: new AbortController().signal,
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: dialogs "accept" needs an approval request that says the page\'s own confirmation '
      + 'will be confirmed too; this call was approved without it',
    )
  })

  it('spends one approval on one call', async () => {
    // The record is consumed by the call that reads it, so a second call
    // carrying the same id — a replay, a retry — cancels the page's dialog.
    const approvals = new DialogApprovals()
    approvals.ask('call_1')
    expect(approvals.confirmed('call_1')).toBe(true)
    expect(approvals.confirmed('call_1')).toBe(false)
  })

  it('forgets its oldest records rather than growing without bound', async () => {
    const approvals = new DialogApprovals()
    for (let at = 0; at <= 64; at += 1) approvals.ask(`call_${at}`)
    expect(approvals.confirmed('call_0')).toBe(false)
    expect(approvals.confirmed('call_64')).toBe(true)
  })
})

describe('what content_act answers with', () => {
  it('carries the seat\'s three sections and one entry per step', async () => {
    const result = await settleWith(DONE)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(DONE.text)
    expect(result.value).toEqual({
      status: 'done',
      page: { id: 'points', title: '点位信息' },
      title: '点位信息 — 控制台',
      steps: [{ index: 1, status: 'ok' }, { index: 2, status: 'ok' }],
      text: DONE.text,
      truncated: false,
    })
  })

  it('reports a step that stopped the call as a value rather than a rejection', async () => {
    // A failed step is not a failed call: the model gets the page's new state
    // in the same answer, which is what it needs to decide the next move.
    const failed: ActOutcome = {
      status: 'failed',
      page: { id: 'points', title: '点位信息' },
      title: '点位信息',
      steps: [
        { index: 1, status: 'ok' },
        { index: 2, status: 'failed', message: 'e5 is now "重置", not "查询" — the page changed.' },
      ],
      text: 'Step 2 failed: e5 is now "重置", not "查询" — the page changed. '
        + 'Step 1 ran; later steps were skipped.\nPage events during these steps: none.\nPage now:\n1 main',
      truncated: false,
    }
    const result = await settleWith(failed)
    expect(result.isError).toBe(false)
    expect(result.value).toMatchObject({ status: 'failed', steps: failed.steps })
  })

  it('says nothing was done when no console claims the call', async () => {
    const { run } = await bench()
    const result = await run({ steps: STEPS }).settled
    expect(result.isError).toBe(true)
    expect(text(result)).toBe(
      'Error: No console tab is showing this session\'s content column (waited 0.03s). '
      + 'Nothing was done.',
    )
  })

  it('says what is unknown when the console claims the call and goes quiet', async () => {
    // The one ending that answers rather than rejects: the steps may have run,
    // so the model is told to look at the page instead of retrying blind.
    const { pending, run } = await bench()
    const { callId, settled } = run({ steps: STEPS })
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if ((await pending.claim({ callId, tabId: TAB })).claimed) break
      await new Promise<void>((resolve) => { setTimeout(resolve, 2) })
    }
    const result = await settled
    expect(result.isError).toBe(false)
    expect(result.value).toEqual({
      status: 'unverified',
      steps: [],
      text: 'The console claimed this call but did not report within 0.06s; the steps may have run partially or '
        + 'fully.',
      truncated: false,
    })
  })

  it('composes the same five failures the seat posts when there was no page to act on', async () => {
    for (const [outcome, refusal] of [
      [
        { status: 'error', code: 'empty', message: 'the content column is empty' },
        'Error: The content column is empty.',
      ],
      [
        { status: 'error', code: 'not-a-page', message: 'the entry in front is not a page', kind: 'chart', title: '黄金走势' },
        // The same ending, worded in this tool's own name: a model told the
        // entry is something `content_read cannot read` has been told about
        // the wrong call, and it is the tool it was told about that it reaches
        // for next.
        'Error: The entry the content column has in front is not a page (the chart "黄金走势").',
      ],
      [
        { status: 'error', code: 'frame', message: 'The page in the content column had not finished loading when this read gave up on it.' },
        'Error: The page in the content column had not finished loading when this read gave up on it.',
      ],
      [
        { status: 'error', code: 'engine', message: 'no element carries the ref e4' },
        'Error: no element carries the ref e4',
      ],
      [
        // The one ending only a call that would have acted reaches: the seat
        // words it, and this tool hands it over as it stands.
        {
          status: 'error',
          code: 'front-changed',
          message: 'The page in front is now "报表", not "点位信息" the steps were approved for; nothing was done.',
        },
        'Error: The page in front is now "报表", not "点位信息" the steps were approved for; nothing was done.',
      ],
    ] as const) {
      const result = await settleWith(outcome)
      expect({ code: outcome.code, isError: result.isError, text: text(result) })
        .toEqual({ code: outcome.code, isError: true, text: refusal })
    }
  })

  it('refuses a listing posted against a call that asked for steps', async () => {
    // One table, one claim, two tools: the tool that opened the wait is what
    // knows whether the document it was handed answers its own call.
    const result = await settleWith({
      status: 'ok',
      page: { id: 'points', title: '点位信息' },
      snapshot: {
        kind: 'outline',
        url: 'http://127.0.0.1:5173/content-app/points',
        title: '点位信息',
        text: '1 main',
        truncated: false,
        shown: 1,
        total: 1,
        settled: true,
      },
    })
    expect(result.isError).toBe(true)
    expect(text(result))
      .toBe('Error: The console answered this call with another call\'s document.')
  })

  it('names the cancellation the agent loop replaces with its own outcome', async () => {
    const aborter = new AbortController()
    const tool = contentActTool(new PendingCalls(), FAST, MAX_STEPS, () => undefined, new DialogApprovals())
    const session = Session.create(SessionId(`content-act-${++calls}`))
    const exec = {
      callId: 'call_cancelled',
      name: 'content_act',
      arguments: { steps: STEPS },
      agent: agentWithSession(session),
      signal: aborter.signal,
      rootCallId: 'call_cancelled',
      token: {},
    } as unknown as Parameters<NonNullable<typeof tool.execute>>[1]
    const settled = tool.execute?.({ steps: STEPS }, exec)
    aborter.abort()
    await expect(settled).rejects.toThrow('This call was cancelled')
  })
})

describe('what a browser half is told to run', () => {
  it('drops the fields a step did not carry rather than sending them empty', async () => {
    // What the seat receives is what the tool validated, and an absent field is
    // absent: a `wait` carries no ref, and the seat's own dispatch reads that.
    const { pending, run } = await bench()
    const claimed = vi.fn()
    const { callId, settled } = run({ steps: [{ action: 'wait', text: '保存成功' }] })
    await answer(pending, callId, { ...DONE, steps: [{ index: 1, status: 'ok' }] })
    claimed()
    expect((await settled).isError).toBe(false)
    expect(claimed).toHaveBeenCalledOnce()
  })
})
