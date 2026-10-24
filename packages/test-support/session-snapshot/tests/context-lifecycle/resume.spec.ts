import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import * as CompactionRehydration from '@deepseek-ai/dsh-compaction-rehydration'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'

/**
 * Process-level resume across a compaction interruption.
 *
 * A compaction transaction commits in stages: `compaction/start`, then the
 * summary, then the replacement message, then `compaction/end`. A process that
 * dies between any two stages must not leave a half-applied replacement, and a
 * restarted process must be able to open the same session again.
 *
 * These tests use the real JSONL backend and the real `ctx.agents.resume`
 * path; the fixture log is built through `Session.append` so it passes
 * the same validation a production writer would.
 */

const MODEL = 'test-model'
const roots: string[] = []

/**
 * The JSONL backend takes its session lock through a prebuilt Node-API binding
 * (`native/system/packages/<platform>-<arch>/bin/system.node`). A fresh git
 * worktree does not carry that artifact, so these cases self-skip until the
 * checkout is provisioned; they are not skipped because the behavior is absent.
 */
const LOCK_BINDING = join(import.meta.dirname, '..', '..', '..', '..', '..', 'native', 'system', 'packages',
  `${process.platform}-${process.arch}`, 'bin', 'system.node')
const HAS_LOCK_BINDING = existsSync(LOCK_BINDING)

class TextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000 } })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'reply' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function mount(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  void new TokenMeter(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(CompactionRehydration)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter([MODEL], new TextAdapter())
  return ctx
}

/** Two complete turns, then whatever the interruption builds on top. */
function baseSession(id: SessionId, turns = 2, seedEarly?: (session: Session) => void): Session {
  const session = Session.create(id)
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `question ${String(turn)} `.concat('body '.repeat(120)) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${String(turn)}` }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    if (turn === 1) seedEarly?.(session)
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  // Automatic compaction brackets must be enclosed in an open turn.
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Persist a validated in-memory log through the real backend seam. */
async function seed(ctx: Context, session: Session): Promise<void> {
  const detached = ctx.sessions.prepare(session.id)
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(session.snapshotEvents())
  await handle.close()
}

async function readLog(ctx: Context, id: SessionId): Promise<readonly { type: string }[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ctx-resume-'))
  roots.push(root)
  return root
}

describe.skipIf(!HAS_LOCK_BINDING)('resume after an interrupted compaction', () => {
  it('reopens a session whose compaction never closed, without a replacement', async () => {
    const root = await tempRoot()
    const id = SessionId('interrupted-open-start')

    const first = await mount(root)
    const session = baseSession(id)
    session.append('compaction/start', { compactionId: CompactionId('interrupted'), turn: 3 })
    await seed(first, session)
    await first.fiber.dispose()

    const second = await mount(root)
    const handle = await second.agents.resume({ resumeSessionId: id })
    const log = await readLog(second, id)

    // The abandoned attempt left no summary and no replacement message.
    expect(log.filter(event => event.type === 'compaction/summary')).toEqual([])
    const replacements = log.filter((event) => {
      const op = (event as { surfaceOp?: { op?: string } }).surfaceOp
      return op?.op === 'replace'
    })
    expect(replacements).toEqual([])
    // The resumed agent owns the same durable session.
    expect(handle.agent.session.id).toBe(id)
    await second.fiber.dispose()
  })

  it('keeps the durable log append-only across the reopen', async () => {
    const root = await tempRoot()
    const id = SessionId('interrupted-append-only')

    const first = await mount(root)
    const session = baseSession(id)
    session.append('compaction/start', { compactionId: CompactionId('interrupted'), turn: 3 })
    const before = session.snapshotEvents().length
    await seed(first, session)
    await first.fiber.dispose()

    const second = await mount(root)
    await second.agents.resume({ resumeSessionId: id })
    const log = await readLog(second, id)
    expect(log.length).toBeGreaterThanOrEqual(before)
    await second.fiber.dispose()
  })

  it('accepts a resume when the interrupted start predates a restart boundary', async () => {
    const root = await tempRoot()
    const id = SessionId('interrupted-stale-evidence')

    const first = await mount(root)
    const session = baseSession(id)
    session.append('compaction/start', { compactionId: CompactionId('interrupted'), turn: 3 })
    session.append('session/end-seed', {})
    await seed(first, session)
    await first.fiber.dispose()

    const second = await mount(root)
    const handle = await second.agents.resume({ resumeSessionId: id })
    expect(handle.agent.session.id).toBe(id)
    await second.fiber.dispose()
  })
})

/** Minimal engine: the compaction transaction runs for real, only the summary text is stubbed. */
class SummaryStubEngine extends BasicCompactionEngine {
  override async summarize(): Promise<{ summary: { type: 'text'; text: string }[]; provider: string; model: string }> {
    return { summary: [{ type: 'text', text: 'checkpoint' }], provider: MODEL, model: MODEL }
  }
}

/**
 * Produce a real compaction cycle with the production engine, then cut the log
 * at a chosen stage. Seeding a prefix of a valid log keeps every event shape
 * authoritative rather than hand-writing a `compaction/summary` payload.
 */
async function compactionCycle(id: SessionId): Promise<{ events: readonly { type: string }[]; stage: Record<string, number> }> {
  const ctx = await mount(await tempRoot())
  // Task state lives *inside* the compacted range so a checkpoint shadows it.
  const session = baseSession(id, 10, (early) => {
    early.append('todo/write', { todos: [{ content: 'plan', status: 'in_progress' }, { content: 'build', status: 'pending' }] })
    early.append('job/registered', {
      jobId: 'job-open-1', owner: String(id), kind: 'bash', startedAt: 1,
      toolCall: { callId: 'call-open-1', name: 'bash' },
    })
    // A read whose metadata predates the version/digest fields, so the rebuilt
    // Files section exercises the bounded re-read fallback.
    early.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: ToolCallId('read-open-1'), name: 'read', arguments: JSON.stringify({ file_path: '/abs/resumed.txt' }) }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    early.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('read-open-1'), name: 'read',
      arguments: JSON.stringify({ file_path: '/abs/resumed.txt' }),
    })
    early.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('read-open-1'),
        content: [{ type: 'text', text: 'resumed content' }],
        isError: false,
      }),
      meta: {
        path: '/abs/resumed.txt',
        offset: 1,
        lines: [{ number: 1, text: 'resumed content' }],
        totalLines: 1,
      },
    }, { surfaceOp: 'append' })
  })
  const engineUnderTest = new SummaryStubEngine(ctx, {
    auto: false, headroomTokens: 0, maxTokens: 8192, thresholdRatio: 0.3, retainTokens: 20,
  })
  await engineUnderTest.compactIfNeeded(
    { session, options: { provider: MODEL, model: MODEL } } as never,
    'pressure',
    new AbortController().signal,
  )
  const events = session.snapshotEvents()
  const find = (predicate: (event: { type: string }) => boolean): number => events.findIndex(predicate)
  const stage = {
    start: find(event => event.type === 'compaction/start'),
    summary: find(event => event.type === 'compaction/summary'),
    replacement: find(event => event.type === 'user/message'
      && (event as unknown as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace'),
    end: find(event => event.type === 'compaction/end'),
  }
  await ctx.fiber.dispose()
  return { events, stage }
}


/** Fire the pre-step waterfall once and report how many rebuild messages it added. */
async function firePreStep(ctx: Context, agent: Agent, turn = 20, step = 1): Promise<number> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'next request' }],
    source: { kind: 'user' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn, step, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind === 'reject') return 0
  const added = decision.messages.filter(message => message !== proposed)
  for (const message of added) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return added.length
}

/** Durable rebuild messages this session already holds. */
function rebuildCount(session: Session): number {
  return session.ownEvents().filter(event => event.type === 'user/message'
    && (event.data as { source?: { kind?: string } }).source?.kind === 'compaction-rehydration').length
}

/** Persist an inclusive prefix of a validated log, then dispose the writer. */
async function seedPrefix(root: string, id: SessionId, events: readonly { type: string }[], upto: number): Promise<void> {
  const ctx = await mount(root)
  const detached = ctx.sessions.prepare(id)
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(events.slice(0, upto + 1) as never)
  await handle.close()
  await ctx.fiber.dispose()
}

async function resumeFrom(root: string, id: SessionId): Promise<Context> {
  const ctx = await mount(root)
  await ctx.agents.resume({ resumeSessionId: id })
  return ctx
}

describe.skipIf(!HAS_LOCK_BINDING)('resume at the three compaction interruption points', () => {
  it('recovers at "start written, summary not written"', async () => {
    const id = SessionId('cut-after-start')
    const { events, stage } = await compactionCycle(id)
    expect(stage['start']).toBeGreaterThanOrEqual(0)
    expect(stage['summary']).toBeGreaterThan(stage['start']!)

    const root = await tempRoot()
    await seedPrefix(root, id, events, stage['start']!)
    const second = await resumeFrom(root, id)
    const log = await readLog(second, id)

    expect(log.filter(event => event.type === 'compaction/summary')).toEqual([])
    expect(log.filter(event => event.type === 'compaction/end')).toEqual([])
    expect(log.filter(event => (event as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace')).toEqual([])
    expect(second.agents.get(id)?.session.id).toBe(id)
    const summaryOnlyAgent = second.agents.get(id)!
    expect(await firePreStep(second, summaryOnlyAgent)).toBe(0)
    expect(rebuildCount(summaryOnlyAgent.session)).toBe(0)
    await second.fiber.dispose()
  })

  it('recovers at "summary written, replacement not written"', async () => {
    const id = SessionId('cut-after-summary')
    const { events, stage } = await compactionCycle(id)
    expect(stage['summary']).toBeGreaterThan(stage['start']!)
    expect(stage['replacement']).toBeGreaterThan(stage['summary']!)

    const root = await tempRoot()
    await seedPrefix(root, id, events, stage['summary']!)
    const second = await resumeFrom(root, id)
    const log = await readLog(second, id)

    // The summary is durable evidence, but it never reached the surface: no
    // replacement and no close, so history stays the pre-compaction history.
    expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(log.filter(event => (event as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace')).toEqual([])
    expect(log.filter(event => event.type === 'compaction/end')).toEqual([])
    // Task state stays in the durable log and nothing was injected over it.
    expect(log.filter(event => event.type === 'todo/write')).toHaveLength(1)
    expect(log.filter(event => event.type === 'job/registered')).toHaveLength(1)
    const session = second.agents.get(id)!.session
    const lastUser = session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)
    expect((lastUser as { surfaceOp?: unknown } | undefined)?.surfaceOp).not.toEqual(
      expect.objectContaining({ op: 'replace' }),
    )
    await second.fiber.dispose()
  })

  it('recovers at "replacement written, compaction/end not written"', async () => {
    const id = SessionId('cut-after-replacement')
    const { events, stage } = await compactionCycle(id)
    expect(stage['replacement']).toBeGreaterThan(stage['summary']!)
    expect(stage['end']).toBeGreaterThan(stage['replacement']!)

    const root = await tempRoot()
    await seedPrefix(root, id, events, stage['replacement']!)
    const second = await resumeFrom(root, id)
    const log = await readLog(second, id)

    // The replacement is on the surface; the missing close must not duplicate it.
    const replacements = log.filter(event => (event as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace')
    expect(replacements).toHaveLength(1)
    expect(log.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    // The checkpoint is a surface fact even though `compaction/end` never
    // landed; task state must not disappear with it.
    expect(log.filter(event => event.type === 'todo/write')).toHaveLength(1)
    expect(log.filter(event => event.type === 'job/registered')).toHaveLength(1)
    const session = second.agents.get(id)!.session
    const surfaces = session.surface.nodes
    expect(surfaces.length).toBeGreaterThan(0)
    const replacement = log.find(event => (event as { surfaceOp?: { op?: string } }).surfaceOp?.op === 'replace') as
      { surfaceOp?: { startSeq?: number; endSeq?: number } } | undefined
    const span = replacement?.surfaceOp
    const taskSeqs = log
      .map((event, index) => ({ event, seq: (event as { seq?: number }).seq ?? index }))
      .filter(({ event }) => event.type === 'todo/write' || event.type === 'job/registered')
      .map(({ seq }) => seq)
    // Task state now sits inside the compacted range, so it is shadowed; the
    // question is whether the rebuild replaces it exactly once.
    for (const seq of taskSeqs) {
      const shadowed = span?.startSeq !== undefined && span.endSeq !== undefined
        && seq >= span.startSeq && seq <= span.endSeq
      expect({ seq, shadowed }).toMatchObject({ seq, shadowed: true })
    }
    const resumedAgent = second.agents.get(id)!
    // The interrupted run never reached a pre-step, so the first pre-step after
    // resume writes the rebuild exactly once; the next one adds nothing.
    expect(await firePreStep(second, resumedAgent)).toBe(1)
    expect(rebuildCount(resumedAgent.session)).toBe(1)
    expect(await firePreStep(second, resumedAgent, 21)).toBe(0)
    expect(rebuildCount(resumedAgent.session)).toBe(1)
    await second.fiber.dispose()
  })

  it('restates a file after a resume with the replacement and no closing event', async () => {
    const id = SessionId('cut-after-replacement-files')
    const { events, stage } = await compactionCycle(id)
    const root = await tempRoot()
    await seedPrefix(root, id, events, stage['replacement']!)
    const second = await resumeFrom(root, id)
    second.provide('fs', {
      resolve: async (path: string) => ({ key: path }),
      stat: async () => ({ version: 'v1', type: 'file', size: 15 }),
      readText: async () => 'resumed content',
    })
    const resumedAgent = second.agents.get(id)!
    expect(await firePreStep(second, resumedAgent)).toBe(1)
    const text = resumedAgent.session.ownEvents()
      .filter(event => event.type === 'user/message'
        && (event.data as { source?: { kind?: string } }).source?.kind === 'compaction-rehydration')
      .map((event) => {
        const block = (event as { data: { content: readonly { type: string; text?: string }[] } }).data.content
          .find(candidate => candidate.type === 'text')
        return block?.text ?? ''
      })
      .join('\n')
    expect(text).toContain('Files read earlier')
    expect(text).toContain('`/abs/resumed.txt` — unchanged since your read')
    expect(text).not.toContain('```text')
    await second.fiber.dispose()
  })
})
