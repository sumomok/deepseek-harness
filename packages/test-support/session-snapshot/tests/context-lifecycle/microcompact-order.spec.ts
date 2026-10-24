import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { Microcompact } from '../../../../compaction/compaction-microcompact/src/index.ts'
import type { SummarizationInput } from '../../../../compaction/compaction-basic/src/summarizer.ts'


const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

class Adapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 10_000 } })
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class RecordingEngine extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []

  override async summarize(input: SummarizationInput): Promise<{
    summary: ContentBlock[]
    provider: string
    model: string
  }> {
    this.calls.push(input)
    return { summary: [{ type: 'text', text: 'checkpoint' }], provider: 'p', model: 'm' }
  }
}

function agent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
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
        content: [{ type: 'text', text: 'history '.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
  }
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function context(
  order: 'microcompact-first' | 'engine-first',
  minClearable = 20,
): { readonly ctx: Context; readonly engine: RecordingEngine } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new Adapter())
  const microcompact = () => new Microcompact(ctx, {
    enabled: true,
    minIdleSeconds: 0,
    keepRecentToolUses: 5,
    minClearableToolUses: minClearable,
    clearAtLeastTokens: 10,
    allowHostOnlyReadback: true,
  })
  const engine = () => new RecordingEngine(ctx, {
    auto: true,
    headroomTokens: 0,
    maxTokens: 8192,
    thresholdRatio: 0.5,
    retainTokens: 100,
  })
  let subject: RecordingEngine
  if (order === 'microcompact-first') {
    microcompact()
    subject = engine()
  } else {
    subject = engine()
    microcompact()
  }
  return { ctx, engine: subject }
}

function sessionWithHistory(): Session {
  const session = Session.create(SessionId('microcompact-order'))
  vi.setSystemTime(1_000)
  appendTurn(session, 1, 0)
  for (let turn = 2; turn <= 6; turn += 1) appendTurn(session, turn, 5)
  vi.setSystemTime(1_000 + 3_900_000)
  session.append('turn/start', { turn: 7 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'continue' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn: 3, step: 1 })
  return session
}

async function preStep(ctx: Context, session: Session): Promise<void> {
  await agentEvents(ctx, agent(session)).waterfall(
    'agent/pre-step',
    { messages: [], turn: 7, step: 1, signal: SIGNAL },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

describe('idle microcompact before pressure compaction', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  for (const order of ['microcompact-first', 'engine-first'] as const) {
    it(`clears old results before pressure regardless of ${order} registration`, async () => {
      const { ctx, engine } = context(order, 20)
      const session = sessionWithHistory()
      await preStep(ctx, session)
      expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(20)
      expect(engine.calls).toHaveLength(0)
    })

    it(`lets pressure compaction run after an insufficient microcompact (${order})`, async () => {
      const { ctx, engine } = context(order, 100)
      const session = sessionWithHistory()
      await preStep(ctx, session)
      expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(0)
      expect(engine.calls).toHaveLength(1)
    })
  }
})
