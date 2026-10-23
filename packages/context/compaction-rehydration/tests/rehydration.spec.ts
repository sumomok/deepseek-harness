/**
 * The rebuild message a compaction leaves behind: it restates the todo list,
 * the last approved plan, unsettled jobs, and direct subagents from the
 * Session log, once per checkpoint, and never twice across a resume.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, type Agent } from '@deepseek-ai/dsh-agent'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { JobId } from '@deepseek-ai/dsh-jobs'
import { createUserMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import * as Rehydration from '../src/index.ts'

const SIGNAL = new AbortController().signal

interface Bench {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
}

async function harness(options: { projections?: boolean; todo?: boolean; subagents?: boolean } = {}): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { personaPrefix: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  if (options.projections !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Rehydration)
  if (options.todo === true) await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
  if (options.subagents === true) registerCatalogProjection(ctx)
  const session = ctx.sessions.create()
  return { ctx, session, agent: sessionAgent(session, ctx) }
}

/** A parent-owned catalog projection stub: latest chunked records win per child. */
function registerCatalogProjection(ctx: Context): void {
  ctx.sessionProjections.register({
    key: 'subagentCatalog',
    stateSchema: z.object({ head: z.any().optional() }),
    init: () => ({}),
    apply: (state: Record<string, unknown>, event) => {
      if (event.type !== 'subagent/catalog') return state
      const head = state['head'] as { readonly values: readonly unknown[]; readonly previous?: unknown } | undefined
      const value = {
        childId: String(event.data.childId),
        ...'label' in event.data && event.data.label !== undefined ? { label: event.data.label } : {},
      }
      return {
        ...state,
        head: head === undefined || head.values.length >= 64
          ? { values: [value], ...head === undefined ? {} : { previous: head } }
          : { values: [...head.values, value], ...head.previous === undefined ? {} : { previous: head.previous } },
      }
    },
    stateVersion: 0,
  } as never)
}

function sessionAgent(session: Session, ctx: Context): Agent {
  return {
    id: session.id,
    options: {},
    session,
    inbox: {} as never,
    status: 'running',
    ctx,
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('rehydration appends from pre-step only') },
    cancel: () => {},
    runMaintenance: task => task(SIGNAL),
    whenIdle: () => Promise.resolve(),
  } as Agent
}

function openTurn(session: Session, turn = 1): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function writeTodos(session: Session, todos: readonly TodoItem[]): void {
  session.append('todo/write', { todos: [...todos] })
}

function callPlan(session: Session, plan: string, callId: string, isError: boolean): void {
  const call = ToolCallId(callId)
  session.append('tool/call', {
    turn: 1, step: 1, callId: call, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }),
  })
  const message: ToolResultMessage = {
    id: MessageId(`result-${callId}`),
    role: 'tool',
    source: { kind: 'tool', callId: call },
    toolCallId: call,
    content: [{ type: 'text', text: isError ? 'rejected' : 'approved' }],
    ...isError ? { isError: true } : {},
  }
  session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
}

function registerJob(session: Session, jobId: string, label: string, owner = session.id): void {
  session.append('job/registered', {
    jobId: JobId(jobId), owner, kind: 'bash', label, startedAt: 1,
  })
}

function settleJob(session: Session, jobId: string, label: string): void {
  session.append('job/settled', {
    jobId: JobId(jobId), owner: session.id, kind: 'bash', label, startedAt: 1, finishedAt: 2, status: 'completed',
  })
}

function catalogChild(session: Session, childId: string, label: string): void {
  session.append('subagent/catalog', {
    version: 1, childId: SessionId(childId), childCreatedAt: 1, mode: 'continuable', label,
  })
}

function compact(session: Session, id = 'c1', summary = 'condensed history'): void {
  const compactionId = CompactionId(id)
  const shadowedRange = { start: SessionSeq(0), end: SessionSeq(0) }
  session.append('compaction/start', { compactionId, turn: null })
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: summary }],
    shadowedRange,
    shadowedSeqs: [SessionSeq(0)],
    shadowedTokenCount: 12,
    provider: 'test-provider',
    model: 'test-model',
    rawOutput: [{ type: 'text', text: summary }],
    llmStreamCall: true,
  })
  session.append('compaction/end', { compactionId, turn: null })
}

async function fire(ctx: Context, agent: Agent, turn = 1, step = 1): Promise<number> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'request proposal' }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'reject') return 0
  const added = decision.messages.filter(message => message !== proposed)
  for (const message of added) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return added.length
}

function rebuildTexts(session: Session): string[] {
  return session.snapshotEvents()
    .filter(event => event.type === 'user/message' && event.data.source.kind === 'compaction-rehydration')
    .map((event) => {
      const block = event.data.content.find(candidate => candidate.type === 'text')
      return block?.type === 'text' ? block.text : ''
    })
}

describe('the state a compaction rebuilds', () => {
  it('restates the current todo list once after the checkpoint', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [
      { content: 'finish the parser', status: 'in_progress' },
      { content: 'write the spec', status: 'pending' },
    ])
    compact(session)

    expect(await fire(ctx, agent)).toBe(1)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Current todo list')
    expect(text).toContain('- [in_progress] finish the parser')

    expect(await fire(ctx, agent, 1, 2)).toBe(0)
    expect(rebuildTexts(session)).toHaveLength(1)
  })

  it('restates the plan a user approved and drops a dismissed one', async () => {
    const approved = await harness()
    openTurn(approved.session)
    callPlan(approved.session, '# Plan\n- build the thing', 'plan-1', false)
    compact(approved.session)
    await fire(approved.ctx, approved.agent)
    expect(rebuildTexts(approved.session)[0]).toContain('Latest approved plan')
    expect(rebuildTexts(approved.session)[0]).toContain('- build the thing')

    const dismissed = await harness()
    openTurn(dismissed.session)
    callPlan(dismissed.session, '# Rejected plan', 'plan-2', true)
    compact(dismissed.session)
    expect(await fire(dismissed.ctx, dismissed.agent)).toBe(0)
  })

  it('restates only jobs this session registered and never settled', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    registerJob(session, 'bash-1', 'collect logs')
    registerJob(session, 'bash-2', 'finished already')
    settleJob(session, 'bash-2', 'finished already')
    const other = ctx.sessions.create()
    registerJob(session, 'bash-3', 'someone else', other.id)
    compact(session)

    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Background jobs with no settlement logged')
    expect(text).toContain('collect logs')
    expect(text).toContain('may still be running')
    expect(text).not.toContain('finished already')
    expect(text).not.toContain('someone else')
  })

  it('does not repeat the rebuild on a resumed session', async () => {
    const first = await harness({ todo: true })
    openTurn(first.session)
    writeTodos(first.session, [{ content: 'carry on', status: 'pending' }])
    compact(first.session)
    expect(await fire(first.ctx, first.agent)).toBe(1)
    const events = first.session.snapshotEvents()

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Rehydration)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    const session = ctx.sessions.create(first.session.id, { seed: events })
    expect(await fire(ctx, sessionAgent(session, ctx))).toBe(0)
  })

  it('bounds the message and truncates a long section', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    callPlan(session, `# Huge plan\n${'x'.repeat(6000)}`, 'plan-3', false)
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text.length).toBeLessThanOrEqual(4000)
    expect(text).toContain('(truncated)')
  })

  it('does nothing without a compaction checkpoint', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'still here', status: 'pending' }])
    expect(await fire(ctx, agent)).toBe(0)
  })

  it('rebuilds the log-derived sections when projections are not mounted', async () => {
    const { ctx, session, agent } = await harness({ projections: false })
    openTurn(session)
    callPlan(session, '# Plan\n- keep going', 'plan-4', false)
    writeTodos(session, [{ content: 'not projected', status: 'pending' }])
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('- keep going')
    expect(text).toContain('not projected')
    expect(text).not.toContain('Direct subagents registered by this session')
  })

  it('renders a stable message for the snapshot', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'ship the prototype', status: 'in_progress' }])
    callPlan(session, '# Plan\n- done', 'plan-5', false)
    registerJob(session, 'bash-9', 'tail the log')
    compact(session)
    await fire(ctx, agent)
    expect(rebuildTexts(session)[0]).toMatchSnapshot()
  })

  it('records the assembled sections and their digests on the message source', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'record the sections', status: 'pending' }])
    compact(session)
    await fire(ctx, agent)
    const event = session.snapshotEvents().find(candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'compaction-rehydration')
    expect(event?.type).toBe('user/message')
    if (event?.type !== 'user/message' || event.data.source.kind !== 'compaction-rehydration') throw new Error('no rebuild message')
    const source = event.data.source
    expect(source.form).toBe('snapshot')
    expect(source.compactionId).toBe('c1')
    expect(source.sections.map(section => section.name)).toEqual(['todos'])
    expect(source.digests).toHaveLength(1)
    expect(source.digests[0]).toMatch(/^[0-9a-f]{8}$/)
    expect(source.digests[0]).not.toBe(source.sections[0]?.text)
  })

  it('writes one message for each successful checkpoint', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'first pass', status: 'pending' }])
    compact(session, 'c1')
    expect(await fire(ctx, agent)).toBe(1)
    openTurn(session, 2)
    writeTodos(session, [{ content: 'second pass', status: 'pending' }])
    compact(session, 'c2')
    expect(await fire(ctx, agent, 2)).toBe(1)
    expect(rebuildTexts(session)).toHaveLength(2)
  })

  it('keeps the todo list across a turn boundary before the compaction', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'survive the turn boundary', status: 'pending' }])
    openTurn(session, 2)
    compact(session)
    await fire(ctx, agent, 2)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Current todo list')
    expect(text).toContain('survive the turn boundary')
  })

  it('says a job may have stopped after a restart and never claims it is running', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    registerJob(session, 'bash-7', 'orphaned by the restart')
    session.append('session/end-seed', {})
    registerJob(session, 'bash-8', 'registered after the restart')
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Background jobs with no settlement logged')
    expect(text).toContain('orphaned by the restart')
    expect(text).toContain('may have stopped')
    expect(text).toContain('registered after the restart')
    expect(text).toContain('may still be running')
    expect(text).not.toContain('Background jobs still running')
  })

  it('lists direct children from the catalog projection and keeps other sessions out', async () => {
    const { ctx, session, agent } = await harness({ subagents: true })
    openTurn(session)
    catalogChild(session, 'child-1', 'reviewer')
    catalogChild(session, 'child-2', 'prober')
    const other = ctx.sessions.create()
    openTurn(other)
    catalogChild(other, 'child-9', 'foreign helper')
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Direct subagents registered by this session')
    expect(text).toContain('reviewer')
    expect(text).toContain('prober')
    expect(text).not.toContain('foreign helper')
  })
})
