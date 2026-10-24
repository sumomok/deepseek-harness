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
import { readWindowDigest } from '../src/read-registry.ts'
import type { ReadFsLike } from '../src/read-registry.ts'

const SIGNAL = new AbortController().signal

interface Bench {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
}

async function harness(options: { projections?: boolean; todo?: boolean; subagents?: boolean; fs?: ReadFsLike } = {}): Promise<Bench> {
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
  if (options.fs !== undefined) ctx.provide('fs', options.fs)
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

function callPlan(session: Session, plan: string, callId: string, outcome: 'approved' | 'dismissed' | 'failed' | 'unknown'): { readonly callSeq: SessionSeq; readonly resultSeq: SessionSeq } {
  const call = ToolCallId(callId)
  const callEvent = session.append('tool/call', {
    turn: 1, step: 1, callId: call, name: 'exit_plan_mode', arguments: JSON.stringify({ plan }),
  })
  const text = outcome === 'approved'
    ? 'Plan approved — plan mode exited; carry out the plan starting with your next step.'
    : outcome === 'dismissed'
      ? 'The user dismissed the plan review to reply in their own words; plan mode remains active.'
      : outcome === 'failed'
        ? 'rejected'
        : 'plan review answered in another build'
  const message: ToolResultMessage = {
    id: MessageId(`result-${callId}`),
    role: 'tool',
    source: { kind: 'tool', callId: call },
    toolCallId: call,
    content: [{ type: 'text', text }],
    ...outcome === 'failed' ? { isError: true } : {},
  }
  const resultEvent = session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
  return { callSeq: callEvent.seq, resultSeq: resultEvent.seq }
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

/** Minimal filesystem service the Files section reads through in these tests. */
class FakeReadFs implements ReadFsLike {
  readonly files = new Map<string, { text: string; version: string; size?: number; type?: string }>()

  add(path: string, file: { text: string; version: string; size?: number; type?: string }): void {
    this.files.set(path, file)
  }

  async resolve(path: string): Promise<object> { return { key: path } }

  async stat(target: object): Promise<{ version: string; size?: number; type: string } | undefined> {
    const file = this.files.get((target as { key?: string }).key ?? '')
    if (file === undefined) return undefined
    return { version: file.version, type: file.type ?? 'file', ...file.size === undefined ? {} : { size: file.size } }
  }

  async readText(target: object): Promise<string> {
    const file = this.files.get((target as { key?: string }).key ?? '')
    if (file === undefined) throw new Error('missing')
    return file.text
  }
}

/** Record one successful `read` with the metadata the read tool now persists. */
function recordFileRead(session: Session, callId: string, meta: Record<string, unknown>): void {
  const call = ToolCallId(callId)
  session.append('tool/call', {
    turn: 1, step: 1, callId: call, name: 'read', arguments: JSON.stringify({ file_path: meta['path'] }),
  })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: {
      id: MessageId(`read-${callId}`),
      role: 'tool',
      source: { kind: 'tool', callId: call },
      toolCallId: call,
      content: [{ type: 'text', text: 'read result' }],
    },
    meta,
  }, { surfaceOp: 'append' })
}

/** The persisted metadata for one full or windowed read. */
function readMeta(path: string, text: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const lines = text.split('\n').map((line, index) => ({ number: index + 1, text: line }))
  return {
    path,
    offset: 1,
    lines,
    totalLines: lines.length,
    version: 'v1',
    size: text.length,
    read: 'full',
    digest: readWindowDigest(lines),
    ...overrides,
  }
}

/** Append the summary and its surface replacement; return the replacement's seq. */
function checkpointReplacement(session: Session, id: string, summary: string): number {
  const compactionId = CompactionId(id)
  const target = session.surface.nodes.at(-1)
  if (target === undefined) throw new Error('no surface node to replace')
  const start = session.append('compaction/start', { compactionId, turn: null })
  const shadowedRange = { start: SessionSeq(0), end: SessionSeq(0) }
  const summaryEvent = session.append('compaction/summary', {
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
  const replacement = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: 'compact-checkpoint', compactionId },
  }), { surfaceOp: { op: 'replace', startSeq: target, endSeq: target }, sourceEventSeqs: [target, start.seq, summaryEvent.seq] })
  return replacement.seq
}

function compact(session: Session, id = 'c1', summary = 'condensed history'): void {
  checkpointReplacement(session, id, summary)
  session.append('compaction/end', { compactionId: CompactionId(id), turn: null })
}

/** A checkpoint whose surface replacement committed but whose closing event never did. */
function compactWithoutEnd(session: Session, id = 'c-missing', summary = 'condensed history'): number {
  return checkpointReplacement(session, id, summary)
}

/** A checkpoint replacement over one explicit surface node, with no closing event. */
function checkpointReplacementOver(
  session: Session,
  id: string,
  summary: string,
  shadowed: SessionSeq,
): number {
  const compactionId = CompactionId(id)
  const start = session.append('compaction/start', { compactionId, turn: null })
  const shadowedRange = { start: SessionSeq(0), end: SessionSeq(0) }
  const summaryEvent = session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: summary }],
    shadowedRange,
    shadowedSeqs: [shadowed],
    shadowedTokenCount: 12,
    provider: 'test-provider',
    model: 'test-model',
    rawOutput: [{ type: 'text', text: summary }],
    llmStreamCall: true,
  })
  const replacement = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: summary }],
    source: { kind: 'compact-checkpoint', compactionId },
  }), {
    surfaceOp: { op: 'replace', startSeq: shadowed, endSeq: shadowed },
    sourceEventSeqs: [shadowed, start.seq, summaryEvent.seq],
  })
  return replacement.seq
}

/** A summary that never reached the surface: start and summary only, no replacement, no end. */
function summaryOnly(session: Session, id = 'c-summary-only', summary = 'never replaced'): void {
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
  return session.ownEvents()
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
    callPlan(approved.session, '# Plan\n- build the thing', 'plan-1', 'approved')
    compact(approved.session)
    await fire(approved.ctx, approved.agent)
    expect(rebuildTexts(approved.session)[0]).toContain('Latest approved plan')
    expect(rebuildTexts(approved.session)[0]).toContain('- build the thing')

    const dismissed = await harness()
    openTurn(dismissed.session)
    callPlan(dismissed.session, '# Rejected plan', 'plan-2', 'dismissed')
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
    callPlan(session, `# Huge plan\n${'x'.repeat(6000)}`, 'plan-3', 'approved')
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
    callPlan(session, '# Plan\n- keep going', 'plan-4', 'approved')
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
    callPlan(session, '# Plan\n- done', 'plan-5', 'approved')
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

  it('leaves the plan out after a dismissed review, even when an earlier one was approved', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    callPlan(session, '# First plan', 'plan-a', 'approved')
    callPlan(session, '# Second plan', 'plan-b', 'dismissed')
    compact(session)
    expect(await fire(ctx, agent)).toBe(0)
    expect(rebuildTexts(session)[0]).toBeUndefined()
  })

  it('takes the newest plan when two reviews both approve', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    callPlan(session, '# Older plan', 'plan-c', 'approved')
    callPlan(session, '# Newer plan', 'plan-d', 'approved')
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('# Newer plan')
    expect(text).not.toContain('# Older plan')
  })

  it('drops a plan whose review was dismissed without an error', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    callPlan(session, '# Dismissed plan', 'plan-e', 'dismissed')
    compact(session)
    expect(await fire(ctx, agent)).toBe(0)
  })

  it('omits a plan whose review answer it does not recognise', async () => {
    const { ctx, session, agent } = await harness()
    openTurn(session)
    callPlan(session, '# Unrecognised answer', 'plan-f', 'unknown')
    compact(session)
    expect(await fire(ctx, agent)).toBe(0)
  })

  it('does not revive a parent session\'s state in a fork', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'parent task', status: 'pending' }])
    callPlan(session, '# Parent plan', 'plan-h', 'approved')
    registerJob(session, 'bash-parent', 'parent job')
    compact(session)
    expect(await fire(ctx, agent)).toBe(1)

    const child = ctx.sessions.fork(session)
    const childAgent = sessionAgent(child, ctx)
    expect(await fire(ctx, childAgent)).toBe(0)
    expect(rebuildTexts(child)).toHaveLength(0)

    openTurn(child, 1)
    writeTodos(child, [{ content: 'child task', status: 'pending' }])
    compact(child, 'c-child')
    expect(await fire(ctx, childAgent)).toBe(1)
    const text = rebuildTexts(child)[0] ?? ''
    expect(text).toContain('child task')
    expect(text).not.toContain('parent task')
    expect(text).not.toContain('# Parent plan')
    expect(text).not.toContain('parent job')
  })

  it('rebuilds after a checkpoint replacement whose closing event never committed', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'survive a crash mid-compaction', status: 'pending' }])
    const replacementSeq = compactWithoutEnd(session)
    expect(await fire(ctx, agent)).toBe(1)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('survive a crash mid-compaction')
    const event = session.ownEvents().find(candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'compaction-rehydration')
    if (event?.type !== 'user/message' || event.data.source.kind !== 'compaction-rehydration') throw new Error('no rebuild message')
    expect(event.data.source.compactionSeq).toBe(replacementSeq)
    expect(event.data.source.compactionId).toBe('c-missing')
    expect(await fire(ctx, agent, 1, 2)).toBe(0)
  })

  it('does not treat a summary without its replacement as a checkpoint', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'never became visible', status: 'pending' }])
    summaryOnly(session)
    expect(await fire(ctx, agent)).toBe(0)
  })

  it('rebuilds once when resuming after a replacement with no closing event', async () => {
    const first = await harness({ todo: true })
    openTurn(first.session)
    writeTodos(first.session, [{ content: 'resume after a crash', status: 'pending' }])
    compactWithoutEnd(first.session)
    const crashed = first.session.ownEvents()

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(Rehydration)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    const resumed = ctx.sessions.create(first.session.id, { seed: crashed })
    const resumedAgent = sessionAgent(resumed, ctx)
    expect(await fire(ctx, resumedAgent)).toBe(1)
    expect(rebuildTexts(resumed)[0]).toContain('resume after a crash')

    const ctxAgain = new Context()
    await ctxAgain.plugin(SessionStore)
    await ctxAgain.plugin(SystemPrompt, { personaPrefix: '' })
    await ctxAgain.plugin(ToolRuntime)
    await ctxAgain.plugin(UserQuestionService)
    await ctxAgain.plugin(AgentRegistry)
    await ctxAgain.plugin(SessionProjectionRegistry)
    await ctxAgain.plugin(Rehydration)
    await ctxAgain.plugin(ToolTodo, { allowParallelInProgress: true })
    const resumedAgain = ctxAgain.sessions.create(first.session.id, { seed: resumed.ownEvents() })
    expect(await fire(ctxAgain, sessionAgent(resumedAgain, ctxAgain))).toBe(0)
  })

  it('rebuilds shadowed todo, plan, and job state when the close never commits', async () => {
    const { ctx, session, agent } = await harness({ todo: true })
    openTurn(session)
    writeTodos(session, [{ content: 'shadowed task', status: 'pending' }])
    const review = callPlan(session, '# Shadowed plan', 'plan-shadow', 'approved')
    registerJob(session, 'bash-shadow', 'shadowed job')
    const replacementSeq = checkpointReplacementOver(session, 'c-shadow', 'condensed', review.resultSeq)

    expect(await fire(ctx, agent)).toBe(1)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('shadowed task')
    expect(text).toContain('# Shadowed plan')
    expect(text).toContain('shadowed job')
    const event = session.ownEvents().find(candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'compaction-rehydration')
    if (event?.type !== 'user/message' || event.data.source.kind !== 'compaction-rehydration') throw new Error('no rebuild message')
    expect(event.data.source.compactionId).toBe('c-shadow')
    expect(event.data.source.compactionSeq).toBe(replacementSeq)

    expect(await fire(ctx, agent, 1, 2)).toBe(0)
    expect(rebuildTexts(session)).toHaveLength(1)
  })

  it('restates an unchanged read as already read without repeating its content', async () => {
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one\ntwo', version: 'v1' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-1', readMeta('/abs/a.txt', 'one\ntwo'))
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('Files read earlier')
    expect(text).toContain('`/abs/a.txt` — unchanged since your read at seq 3')
    expect(text).not.toContain('```text')
  })

  it('restates a changed full read as current content', async () => {
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'new content', version: 'v2' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-1', readMeta('/abs/a.txt', 'old content'))
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('### `/abs/a.txt`')
    expect(text).toContain('new content')
    expect(text).not.toContain('old content')
  })

  it('points at a window, a missing file, and an oversized file instead of restating them', async () => {
    const fs = new FakeReadFs()
    fs.add('/abs/window.txt', { text: 'one\ntwo', version: 'v1' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-window', readMeta('/abs/window.txt', 'one\ntwo', { offset: 2, read: 'window' }))
    recordFileRead(session, 'read-missing', readMeta('/abs/missing.txt', 'gone'))
    fs.add('/abs/big.txt', { text: 'x', version: 'v2', size: 999_999 })
    recordFileRead(session, 'read-big', readMeta('/abs/big.txt', 'x'))
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('`/abs/window.txt` — only a window was read earlier')
    expect(text).toContain('`/abs/missing.txt` — not found now')
    expect(text).toContain('`/abs/big.txt` — too large to restate here')
    expect(text).not.toContain('```text')
  })

  it('skips credential-like paths entirely', async () => {
    const fs = new FakeReadFs()
    fs.add('/home/user/.ssh/id_rsa', { text: 'secret', version: 'v1' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-secret', readMeta('/home/user/.ssh/id_rsa', 'secret'))
    compact(session)
    expect(await fire(ctx, agent)).toBe(0)
    expect(rebuildTexts(session)).toHaveLength(0)
  })

  it('lists at most five files and keeps the shared message bound', async () => {
    const fs = new FakeReadFs()
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    for (let index = 0; index < 6; index += 1) {
      const path = `/abs/file-${String(index)}.txt`
      fs.add(path, { text: `content ${String(index)}`, version: 'v1' })
      recordFileRead(session, `read-${String(index)}`, readMeta(path, `content ${String(index)}`))
    }
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('/abs/file-5.txt')
    expect(text).toContain('/abs/file-1.txt')
    expect(text).not.toContain('/abs/file-0.txt')
    expect(text.length).toBeLessThanOrEqual(4000)
  })

  it('follows a pruned read replacement to its original sequence', async () => {
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'kept', version: 'v1' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-1', readMeta('/abs/a.txt', 'kept'))
    const original = session.ownEvents().findLast(event => event.type === 'tool/result')!
    if (original.type !== 'tool/result') throw new Error('no result')
    session.append('tool/result', {
      turn: original.data.turn,
      step: original.data.step,
      message: {
        ...original.data.message,
        content: [{ type: 'text', text: '[... pruned ...]' }],
      },
      ...original.data.meta === undefined ? {} : { meta: original.data.meta },
    }, {
      surfaceOp: { op: 'replace', startSeq: original.seq, endSeq: original.seq },
      sourceEventSeqs: [original.seq],
    })
    compact(session)
    await fire(ctx, agent)
    const text = rebuildTexts(session)[0] ?? ''
    expect(text).toContain('`/abs/a.txt` — unchanged since your read at seq 3')
  })

  it('records the files section and its digest on the message source', async () => {
    const fs = new FakeReadFs()
    fs.add('/abs/a.txt', { text: 'one', version: 'v1' })
    const { ctx, session, agent } = await harness({ fs })
    openTurn(session)
    recordFileRead(session, 'read-1', readMeta('/abs/a.txt', 'one'))
    compact(session)
    await fire(ctx, agent)
    const event = session.ownEvents().find(candidate => candidate.type === 'user/message'
      && candidate.data.source.kind === 'compaction-rehydration')
    if (event?.type !== 'user/message' || event.data.source.kind !== 'compaction-rehydration') throw new Error('no rebuild')
    expect(event.data.source.sections.map(section => section.name)).toContain('files')
    expect(event.data.source.digests).toHaveLength(event.data.source.sections.length)
  })
})
