import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  createMessage,
  createSystemMessage,
  createUserMessage,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Engine-driven measurements for the context-lifecycle redesign.
 *
 * Every assertion here describes an observable behavior of the real
 * `BasicCompactionEngine`; nothing mocks the code under test. All cases are
 * green against `d88044e906`: the B2 target behaviors this file once marked
 * `it.fails` now hold, so they are asserted directly.
 */

const SIGNAL = new AbortController().signal
const MODEL = 'test-model'

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow = 1_000) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'reply' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RecordingEngine extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []
  summary: ContentBlock[] = [{ type: 'text', text: 'checkpoint' }]
  summaryProvider = 'summary-provider'
  summaryModel = 'summary-model'
  error: unknown

  override async summarize(input: SummarizationInput): Promise<{
    summary: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
  }> {
    this.calls.push(input)
    if (this.error !== undefined) throw this.error
    return { summary: this.summary, provider: this.summaryProvider, model: this.summaryModel, maxTokens: 123 }
  }
}

function createContext(contextWindow = 1_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(contextWindow))
  return ctx
}

function engine(config: BasicCompactionConfig = { auto: false }, ctx = createContext()): RecordingEngine {
  return new RecordingEngine(ctx, { headroomTokens: 0, maxTokens: 8192, ...config })
}

function agent(session: Session, model: string | undefined = MODEL): Agent {
  return { session, options: model === undefined ? {} : { provider: model, model } } as Agent
}

/** Closed two-message turns; `system` puts a system message at surface node 0. */
function conversation(turns = 4, text = 'fixture '.repeat(40).trim(), system?: string): Session {
  const session = Session.create(SessionId(`conversation-${String(turns)}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1 && system !== undefined) {
      session.append('system/message', { turn, step: 1, message: createSystemMessage(system) }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${String(turn)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    }
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${String(turn)}` }],
        source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn })
  }
  // Automatic compaction brackets must be enclosed in an open turn.
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function compact(
  engineUnderTest: BasicCompactionEngine,
  session: Session,
  model: string | undefined = MODEL,
): Promise<CompactionResult | null> {
  return engineUnderTest.compactIfNeeded(agent(session, model), 'pressure', SIGNAL)
}

describe('fixed prefix precheck', () => {
  it('refuses to summarize when the fixed prefix alone crosses the threshold', async () => {
    const subject = engine({ auto: false, thresholdRatio: 0.5, retainTokens: 180 })
    const session = conversation(1)
    session.append('request/header', {
      header: {
        config: { provider: MODEL, model: MODEL },
        tools: [{ name: 'bulk', description: 'x'.repeat(100_000), parameters: { type: 'object' } }],
      },
      reason: 'resume',
    })
    await expect(compact(subject, session)).rejects.toThrow(/fixed prefix .* already at or above the pressure threshold/)
    expect(subject.calls).toHaveLength(0)
  })

  it('does not call the summarizer when a single compaction cannot restore the threshold', async () => {
    const ctx = createContext(1_000)
    const subject = engine({ auto: false, thresholdRatio: 0.5, retainTokens: 250, maxTokens: 1 }, ctx)
    const session = conversation(4, 'x'.repeat(600))
    session.append('request/header', {
      header: {
        config: { provider: MODEL, model: MODEL },
        tools: [{ name: 'bulk', description: 't'.repeat(1_500), parameters: { type: 'object' } }],
      },
      reason: 'resume',
    })
    const logs: string[] = []
    ctx.logger.info = ((message: string) => void logs.push(message)) as typeof ctx.logger.info
    const result = await compact(subject, session)
    expect(result).toBeNull()
    expect(subject.calls).toHaveLength(0)
    expect(logs.some(message => message.includes('cannot restore the threshold'))).toBe(true)
  })
})

describe('semantic tail', () => {
  it('leaves a complete user turn at the head of the retained tail', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20 })
    const result = await compact(subject, session)
    expect(result).not.toBeNull()
    const nodes = session.surface.nodes
    const summaryIndex = nodes.findIndex(seq => session.snapshotEvents().some(event =>
      event.seq === seq && event.type === 'user/message' && event.sourceEventSeqs !== undefined))
    expect(summaryIndex).toBeGreaterThanOrEqual(0)
    const firstRetained = nodes[summaryIndex + 1]
    const event = session.snapshotEvents().find(candidate => candidate.seq === firstRetained)
    expect(event?.type).toBe('user/message')
  })

  // Holds on the current engine: retention already lands on a user message.
  it('never starts the retained tail on an assistant message', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20 })
    await compact(subject, session)
    const nodes = session.surface.nodes
    const summaryIndex = nodes.findIndex(seq => session.snapshotEvents().some(event =>
      event.seq === seq && event.type === 'user/message' && event.sourceEventSeqs !== undefined))
    const firstRetained = nodes[summaryIndex + 1]
    const event = session.snapshotEvents().find(candidate => candidate.seq === firstRetained)
    expect(event?.type).not.toBe('assistant/message')
  })
})

describe('consecutive compaction', () => {
  it('closes the first bracket before any second attempt starts', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20, compactionRetries: 1 })
    await compact(subject, session)
    const brackets = session.snapshotEvents().filter(event => event.type === 'compaction/start' || event.type === 'compaction/end')
    const firstEnd = brackets.findIndex(event => event.type === 'compaction/end')
    const secondStart = brackets.findIndex((event, index) => index > firstEnd && event.type === 'compaction/start')
    expect(firstEnd).toBeGreaterThanOrEqual(0)
    if (secondStart !== -1) expect(secondStart).toBeGreaterThan(firstEnd)
  })

  // Holds on the current engine: the retry path refuses to re-summarize a span
  // that is only the previous checkpoint, so exactly one summary is written and
  // no attempt ends with the "summary is not smaller" error.
  it('does not re-summarize its own checkpoint on retry', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20, compactionRetries: 1 })
    await compact(subject, session)
    const events = session.snapshotEvents()
    expect(events.filter(event => event.type === 'compaction/summary')).toHaveLength(1)
    expect(events.filter(event => event.type === 'compaction/end'
      && typeof event.data['error'] === 'string'
      && event.data['error'].includes('summary is not smaller'))).toEqual([])
  })
})

/** Records the GenerateOptions of the last real summarizer call. */
class ScriptedAdapter extends LlmAdapter {
  lastOptions: GenerateOptions | undefined
  constructor(private readonly blocks: readonly ContentBlock[]) { super() }
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000 } })
  }
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    for (const [index, block] of this.blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') yield { type: 'text-delta', index, text: block.text }
      else yield { type: 'block-end', index, block }
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class ExposedCompactionEngine extends BasicCompactionEngine {
  runSummarize(owner: Agent): Promise<unknown> {
    return this.summarize({ messages: [createUserMessage({
      content: [{ type: 'text', text: 'transcript' }],
      source: { kind: 'test' },
    })] }, owner, SIGNAL)
  }
}

describe('stale route', () => {
  async function routeHarness(): Promise<{ ctx: Context; adapter: ScriptedAdapter; compactEngine: ExposedCompactionEngine }> {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionProjectionRegistry)
    void new TokenMeter(ctx)
    const adapter = new ScriptedAdapter([{ type: 'text', text: 'summary' }])
    ctx.llm.registerAdapter(
      ['fallback-model', 'pending-model', 'pending-provider', 'header-provider', 'header-model'],
      adapter,
    )
    const compactEngine = new ExposedCompactionEngine(ctx, { auto: false })
    return { ctx, adapter, compactEngine }
  }

  it('routes the summary to the pending model selection, not the stale header', async () => {
    const { adapter, compactEngine } = await routeHarness()
    const session = conversation(2)
    session.append('request/header', {
      header: { config: { provider: 'header-provider', model: 'header-model' } },
      reason: 'initial',
    })
    session.append('model/selection', { provider: 'pending-provider', model: 'pending-model' })
    await compactEngine.runSummarize(agent(session, 'fallback-model'))
    expect(adapter.lastOptions?.provider).toBe('pending-provider')
    expect(adapter.lastOptions?.model).toBe('pending-model')
  })

  it('falls back to the durable header route when no pending selection exists', async () => {
    const { adapter, compactEngine } = await routeHarness()
    const session = conversation(2)
    session.append('request/header', {
      header: { config: { provider: 'header-provider', model: 'header-model' } },
      reason: 'initial',
    })
    await compactEngine.runSummarize(agent(session, 'fallback-model'))
    expect(adapter.lastOptions?.provider).toBe('header-provider')
    expect(adapter.lastOptions?.model).toBe('header-model')
  })
})

describe('failure circuit survives a restart', () => {
  // `dfd11b79b4`: a fresh engine folds trailing `compaction/end` errors from the
  // durable log on its first check, so a restarted process keeps backing off.
  it('seeds the circuit from trailing compaction/end errors', async () => {
    const session = conversation(4, 'body '.repeat(40).trim())
    session.append('compaction/end', { compactionId: CompactionId('failed-1'), turn: 2, error: 'Connection error.' })
    session.append('compaction/end', { compactionId: CompactionId('failed-2'), turn: 3, error: 'Connection error.' })
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 40, maxConsecutiveFailures: 2 })
    const result = await compact(subject, session)
    expect(result).toBeNull()
    expect(subject.calls).toHaveLength(0)
  })

  it('still compacts when the trailing failures are below the configured limit', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    session.append('compaction/end', { compactionId: CompactionId('failed-1'), turn: 2, error: 'Connection error.' })
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20, maxConsecutiveFailures: 3 })
    await compact(subject, session)
    expect(subject.calls.length).toBeGreaterThan(0)
  })
})

describe('interruption points (engine-level restart)', () => {
  // A fresh engine reads the durable log, which is the same view a restarted
  // process has once the session is reopened. These pin the durable-lock rules
  // for the three points a compaction transaction can be cut at. The process
  // lifecycle (JSONL reopen + agentLoop.create) is still uncovered.
  function withOpenStart(session: Session): void {
    session.append('compaction/start', { compactionId: CompactionId('interrupted'), turn: 5 })
  }

  it('refuses a new compaction while an earlier start is still open', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    withOpenStart(session)
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20 })
    let outcome: 'busy' | 'null' | 'compacted'
    try {
      const result = await compact(subject, session)
      outcome = result === null ? 'null' : 'compacted'
    } catch {
      outcome = 'busy'
    }
    expect(outcome).not.toBe('compacted')
  })

  it('never appends a replacement for the interrupted attempt', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    withOpenStart(session)
    const before = session.snapshotEvents().length
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20 })
    try { await compact(subject, session) } catch { /* busy is expected for this point */ }
    const appended = session.snapshotEvents().slice(before)
    expect(appended.filter(event => event.type === 'compaction/summary')).toEqual([])
    expect(appended.filter(event => event.type === 'user/message')).toEqual([])
  })

  it('treats an unmatched start before a newer end-seed as stale evidence', async () => {
    const session = conversation(10, 'body '.repeat(120).trim())
    withOpenStart(session)
    session.append('session/end-seed', {})
    const subject = engine({ auto: false, thresholdRatio: 0.3, retainTokens: 20 })
    let outcome: 'busy' | 'null' | 'compacted'
    try {
      const result = await compact(subject, session)
      outcome = result === null ? 'null' : 'compacted'
    } catch {
      outcome = 'busy'
    }
    // Documented rule: a start before a newer end-seed does not block.
    expect(outcome).not.toBe('busy')
  })
})
