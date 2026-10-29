import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Microcompact } from '../../../../compaction/compaction-microcompact/src/index.ts'

const MODEL = 'test-model'
const roots: string[] = []
const LOCK_BINDING = join(import.meta.dirname, '..', '..', '..', '..', '..', 'native', 'system', 'packages',
  `${process.platform}-${process.arch}`, 'bin', 'system.node')
const HAS_LOCK_BINDING = existsSync(LOCK_BINDING)

class TextAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 10_000 } })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-microcompact-resume-'))
  roots.push(root)
  return root
}

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
  await ctx.plugin(AgentLoop, { agents: [] })
  new Microcompact(ctx, {
    enabled: true,
    minIdleSeconds: 0,
    keepRecentToolUses: 5,
    minClearableToolUses: 20,
    clearAtLeastTokens: 10,
    allowHostOnlyReadback: true,
  })
  ctx.llm.registerAdapter([MODEL], new TextAdapter())
  return ctx
}

function appendTurn(session: Session, turn: number, results: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn ${String(turn)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
  for (let index = 0; index < results; index += 1) {
    const callId = ToolCallId(`call-${String(turn)}-${String(index)}`)
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'persisted result '.repeat(200) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function sessionWithHistory(id: string): Session {
  const session = Session.create(SessionId(id), undefined, {
    version: 4, id: SessionId(id), createdAt: 1, isSeeded: false, cwd: '/work',
  })
  vi.setSystemTime(1_000)
  appendTurn(session, 1, 0)
  for (let turn = 2; turn <= 6; turn += 1) appendTurn(session, turn, 5)
  vi.setSystemTime(1_000 + 3_900_000)
  session.append('turn/start', { turn: 7 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 7, step: 1 })
  return session
}

async function seed(ctx: Context, session: Session): Promise<void> {
  const detached = ctx.sessions.prepare(session.id)
  const handle = await ctx.sessionPersistence.create(detached.header)
  await handle.append(session.snapshotEvents())
  await handle.close()
  await ctx.sessionPersistence.flush()
}

async function readLog(ctx: Context, id: SessionId): Promise<readonly import('@deepseek-ai/dsh-session').SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(id, 'read')
  try {
    return (await handle.read()).events
  } finally {
    await handle.close()
  }
}

async function appendEvents(ctx: Context, id: SessionId, events: readonly import('@deepseek-ai/dsh-session').SessionEvent[]): Promise<void> {
  const handle = await ctx.sessionPersistence.open(id, 'write')
  try {
    await handle.append(events)
  } finally {
    await handle.close()
  }
  await ctx.sessionPersistence.flush()
}

describe.skipIf(!HAS_LOCK_BINDING)('idle microcompact process resume', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('resumes cleared pointers through agents.resume and keeps metering sound', async () => {
    const root = await tempRoot()
    const id = SessionId('microcompact-clean-resume')
    const first = await mount(root)
    const session = sessionWithHistory(id)
    const preview = await first.microcompact.preview(session)
    expect(preview.entries).toHaveLength(20)
    first.microcompact.apply(session, preview)
    await seed(first, session)
    await first.fiber.dispose()

    const second = await mount(root)
    const handle = await second.agents.resume({ resumeSessionId: id })
    expect(handle.agent.session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(20)
    expect(() => second.tokenMeter.measure(handle.agent.session)).not.toThrow()
    expect(() => second.sessionProjections.snapshot(handle.agent.session, ['contextBreakdown']).values.contextBreakdown).not.toThrow()
    const original = handle.agent.session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(original).toBeDefined()
    await second.fiber.dispose()
  })

  it('heals a marker-only resume, meters it, and does not duplicate on a second resume', async () => {
    const root = await tempRoot()
    const id = SessionId('microcompact-marker-resume')
    const first = await mount(root)
    const session = sessionWithHistory(id)
    const preview = await first.microcompact.preview(session)
    first.microcompact.apply(session, preview)
    const markerTarget = session.snapshotEvents().findLast(event => event.type === 'tool/result')
    if (markerTarget?.type !== 'tool/result') throw new Error('expected a tool result')
    session.append('compaction/prune', {
      shadowedRange: { start: markerTarget.seq, end: markerTarget.seq },
      shadowedSeqs: [markerTarget.seq],
      shadowedTokenCount: 1,
    })
    await seed(first, session)
    await first.fiber.dispose()

    const second = await mount(root)
    const raw = await readLog(second, id)
    const before = raw.filter(event => event.type === 'compaction/prune').length
    const detached = Session.create(id, raw, {
      version: 4, id, createdAt: 1, isSeeded: false, cwd: '/work',
    })
    expect(second.microcompact.healOrphanMarker(detached)).toBe(true)
    await appendEvents(second, id, detached.snapshotEvents().slice(raw.length))
    const resumed = await second.agents.resume({ resumeSessionId: id })
    expect(() => second.tokenMeter.measure(resumed.agent.session)).not.toThrow()
    expect(() => second.sessionProjections.snapshot(resumed.agent.session, ['contextBreakdown']).values.contextBreakdown).not.toThrow()
    expect(resumed.agent.session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(before)
    expect(resumed.agent.session.snapshotEvents().some(event => event.type === 'tool/result')).toBe(true)
    await second.fiber.dispose()

    const third = await mount(root)
    const again = await third.agents.resume({ resumeSessionId: id })
    const healed = again.agent.session.snapshotEvents().filter(event => event.type === 'compaction/prune')
    expect(healed).toHaveLength(before)
    expect(() => third.tokenMeter.measure(again.agent.session)).not.toThrow()
    expect(() => third.sessionProjections.snapshot(again.agent.session, ['contextBreakdown']).values.contextBreakdown).not.toThrow()
    await third.fiber.dispose()
  })
})
