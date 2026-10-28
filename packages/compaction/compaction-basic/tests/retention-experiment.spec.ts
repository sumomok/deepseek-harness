// @vitest-environment node
/**
 * Retention experiment: how much of the surface does pressure compaction keep?
 *
 * The question is mechanical — before and after are counted by the token
 * meter, never judged by a model. A comparison target is another harness's
 * published behavior (roughly 96% of the surface reclaimed per compaction);
 * these numbers either reach that or they do not.
 *
 * Run with:
 *   node_modules/.bin/vitest run tests/retention-experiment.spec.ts
 */
import { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { createMessage, createSystemMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import BasicCompactionEngine from '../src/index.ts'
import type { SummarizationInput } from '../src/summarizer.ts'
import type { BasicCompactionConfig } from '../src/index.ts'

const MODEL = 'experiment-model'
const WINDOW = 1_000_000
/** Answers the model's context window and finishes any summarization request empty. */
class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** The summary every run is given: a fixed stand-in, so no model is called. */
const SUMMARY: ContentBlock[] = [{ type: 'text', text: 'checkpoint '.repeat(400).trim() }]

/** Answers the summarization request with SUMMARY instead of calling a model. */
class ExperimentEngine extends BasicCompactionEngine {
  override async summarize(
    _input: SummarizationInput,
    _agent: never,
    _signal?: AbortSignal,
  ): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    return { summary: SUMMARY, provider: 'experiment', model: 'experiment' }
  }
}

const SIGNAL = new AbortController().signal

/**
 * A session shaped like a long working conversation: each turn carries a user
 * request, a few assistant steps, and one large tool result, which is what
 * fills a real surface.
 * @param turns - How many turns to build.
 * @param resultChars - Size of each tool result.
 * @returns The session, with a newer turn left open like a live one.
 */
function workingSession(turns: number, resultChars: number): Session {
  const session = Session.create(SessionId(`experiment-${String(turns)}`))
  const filler = 'x'.repeat(resultChars)
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', { turn, step: 1, message: createSystemMessage('You are a coding agent.') }, { surfaceOp: 'append' })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `request ${String(turn)}: adjust the parser` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    for (let step = 1; step <= 2; step += 1) {
      session.append('step/start', { turn, step })
      if (turn === 1 && step === 1) {
        session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
      }
      const callId = ToolCallId(`call-${String(turn)}-${String(step)}`)
      // The assistant message carries the tool-call part; the tool/result then
      // pairs with it on the surface.
      session.append('assistant/message', {
        stream: [],
        turn,
        step,
        message: createMessage({
          role: 'assistant',
          content: [
            { type: 'text', text: `reading part ${String(step)}` },
            { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
          ],
          source: { kind: 'model', ...{ provider: MODEL, model: MODEL } },
        }),
      }, { surfaceOp: 'append' })
      session.append('tool/call', { turn, step, callId, name: 'read', arguments: '{}' })
      session.append('tool/result', {
        turn,
        step,
        message: createMessage({
          role: 'tool',
          source: { kind: 'tool', callId },
          toolCallId: callId,
          content: [{ type: 'text', text: filler }],
        }),
      }, { surfaceOp: 'append' })
      session.append('step/end', { turn, step })
    }
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function createContext(): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL, 'actual'], new ContextAdapter(WINDOW))
  return ctx
}

/** Run one pressure compaction and report the token movement it caused. */
async function measure(configured: BasicCompactionConfig, turns: number, resultChars: number): Promise<{
  before: number
  after: number
  reclaimed: number
  ratio: number
  shadowed: number
}> {
  const ctx = createContext()
  const engine = new ExperimentEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 8192, ...configured })
  const session = workingSession(turns, resultChars)
  const before = ctx.tokenMeter.measure(session).surfaceTokens
  const result = await engine.compactIfNeeded(
    { session, options: { provider: MODEL, model: MODEL } } as never,
    'pressure',
    SIGNAL,
  )
  const after = ctx.tokenMeter.measure(session).surfaceTokens
  const reclaimed = before - after
  return {
    before,
    after,
    reclaimed,
    ratio: before === 0 ? 0 : reclaimed / before,
    shadowed: result?.shadowedTokenCount ?? 0,
  }
}

describe('retention experiment', () => {
  it('reports how much of the surface each retainTokens setting keeps', async () => {
    const turns = 40
    const resultChars = 24_000
    const rows: string[] = []
    for (const share of [0.16, 0.08, 0.04, 0.02, 0.005]) {
      const retainTokens = Math.round(WINDOW * share)
      const measured = await measure({ auto: false, thresholdRatio: 0.4, retainTokens }, turns, resultChars)
      rows.push(
        `retain=${String(retainTokens).padStart(7)}  before=${String(measured.before).padStart(8)}`
        + `  after=${String(measured.after).padStart(7)}  reclaimed=${String(measured.reclaimed).padStart(8)}`
        + `  ratio=${(measured.ratio * 100).toFixed(1)}%`,
      )
    }
    // eslint-disable-next-line no-console -- the table is this experiment's output
    console.log(`\n${rows.join('\n')}\n`)
    expect(rows).toHaveLength(5)
  }, 60_000)
})
