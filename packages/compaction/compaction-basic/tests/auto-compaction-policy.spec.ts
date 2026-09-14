import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionPolicy } from '@deepseek-ai/dsh-compaction-basic'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import LlmRuntime, {
  createMessage,
  createUserMessage,
  CONTEXT_WINDOW_EXCEEDED_CODE,
  LlmAdapter,
} from '@deepseek-ai/dsh-llm'
import type { ContentBlock, LlmFailure, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { agentEvents, type Agent, type RequestErrorAction } from '@deepseek-ai/dsh-agent'

const SIGNAL = new AbortController().signal
const MODEL = 'policy-model'
/** Provider output of the anchored call — the exact gap between the two numerators. */
const OUTPUT_TOKENS = 700
const USAGE: TokenUsage = { inputTokens: 4_000, outputTokens: OUTPUT_TOKENS }

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A policy seat mounted the way a host-plane settings plugin mounts one. */
class TestPolicy extends Service implements CompactionPolicy {
  enabled = true
  ratio = 0.6

  constructor(ctx: Context) {
    super(ctx, 'compactionPolicy')
  }

  isEnabled(): boolean {
    return this.enabled
  }

  thresholdRatio(): number {
    return this.ratio
  }
}

class TestEngine extends BasicCompactionEngine {
  error: Error | undefined
  calls = 0

  override async summarize(input: SummarizationInput): Promise<{
    summary: ContentBlock[]
    provider: string
    model: string
  }> {
    this.calls += 1
    void input
    await Promise.resolve()
    if (this.error !== undefined) throw this.error
    return {
      summary: [{ type: 'text', text: 'checkpoint' }],
      provider: 'summary-provider',
      model: 'summary-model',
    }
  }
}

function createContext(contextWindow: number): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(contextWindow))
  return ctx
}

/**
 * Four closed turns whose last assistant message reports provider usage, then
 * one open turn. The reported usage is what makes the two candidate numerators
 * differ by exactly {@link OUTPUT_TOKENS}.
 */
function conversation(
  turns = 4,
  reportUsage = true,
  usage: TokenUsage = USAGE,
  /** Record the provider's own output blocks, the way a live call does. */
  realStream = false,
): Session {
  const session = Session.create(
    SessionId(`policy-${turns}-${String(reportUsage)}-${String(usage.inputTokens)}-${String(realStream)}`),
  )
  const text = 'fixture '.repeat(40).trim()
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
      session.append('request/context', { provider: MODEL, model: MODEL, contextWindow: WINDOW })
    }
    session.append('assistant/message', {
      stream: realStream && turn === turns
        ? [
          { type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
          { type: 'chunk', time: 2, chunk: { type: 'text-delta', index: 0, text: `${text} assistant ${turn}` } },
          {
            type: 'chunk',
            time: 3,
            chunk: {
              type: 'block-end',
              index: 0,
              block: { type: 'text', text: `${text} assistant ${turn}` },
            },
          },
          ...reportUsage ? [{ type: 'chunk' as const, time: 4, chunk: { type: 'usage' as const, usage } }] : [],
          { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'stop' } } },
        ]
        : [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
      ...reportUsage && turn === turns ? { usage } : {},
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Capacity large enough that the two numerators straddle the default threshold. */
const WINDOW = 10_000

function agent(session: Session): Agent {
  return { session, options: {} } as Agent
}

function preStep(ctx: Context, owner: Agent, signal = SIGNAL): Promise<unknown> {
  return agentEvents(ctx, owner).waterfall(
    'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

function recover(ctx: Context, owner: Agent): Promise<boolean> {
  const failure: LlmFailure = { message: 'overflow', code: CONTEXT_WINDOW_EXCEEDED_CODE }
  const turn = owner.session.snapshotEvents().findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  return agentEvents(ctx, owner).waterfall(
    'agent/request-error',
    { turn, step: 1, provider: MODEL, failure, retryPolicy: undefined, signal: SIGNAL },
    (): Promise<RequestErrorAction> => Promise.resolve(undefined),
  ).then(action => action?.kind === 'retry')
}

/** The context-meter numerator, selected exactly as `contextOccupancy` selects it. */
function meterNumerator(ctx: Context, session: Session): number {
  const pressure = ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure
  const used = pressure?.projectedTokens ?? pressure?.pressureTokens
  expect(used).toBeDefined()
  return used!
}

function compacted(session: Session): boolean {
  return session.snapshotEvents().some(event => event.type === 'compaction/summary')
}

describe('context-meter numerator', () => {
  // The engine's numerator is not exposed, so each case brackets it: a budget
  // equal to the projection must trigger, and one token above it must not.
  // That pins the value the engine compares without asserting any arithmetic
  // relation to the meter total.
  async function triggersAt(ctx: Context, session: Session, thresholdTokens: number): Promise<boolean> {
    const engine = new TestEngine(ctx, { thresholdRatio: thresholdTokens / WINDOW, retainTokens: 500 })
    await preStep(ctx, agent(session))
    return engine.calls > 0
  }

  it('is the projection the context meter publishes, on a session whose stream is a real one', async () => {
    const probe = createContext(WINDOW)
    const streamed = conversation(4, true, USAGE, true)
    const projected = meterNumerator(probe, streamed)
    // A recorded output stream prices the anchored call heuristically, so the
    // meter total differs from the projection by something other than the
    // reported output tokens: the two candidate numerators are genuinely
    // different values here, and neither difference is assumed.
    const total = probe.tokenMeter.measure(streamed).totalTokens
    expect(total).not.toBe(projected)
    expect(total).not.toBe(projected + OUTPUT_TOKENS)

    expect(await triggersAt(createContext(WINDOW), conversation(4, true, USAGE, true), projected)).toBe(true)
    expect(await triggersAt(createContext(WINDOW), conversation(4, true, USAGE, true), projected + 1)).toBe(false)
  })

  it('is the same projection when the log kept no output stream', async () => {
    const projected = meterNumerator(createContext(WINDOW), conversation())

    expect(await triggersAt(createContext(WINDOW), conversation(), projected)).toBe(true)
    expect(await triggersAt(createContext(WINDOW), conversation(), projected + 1)).toBe(false)
  })

  it('trails the meter total by the reported output only in the special case of an empty stream', () => {
    const ctx = createContext(WINDOW)
    const session = conversation()
    const projected = meterNumerator(ctx, session)

    // `stream: []` prices the anchored call's output at zero, which is the one
    // arrangement where the difference is exactly `outputTokens`. A recorded
    // stream prices it heuristically instead, and the difference moves — in
    // either direction — so no general arithmetic relation holds.
    expect(ctx.tokenMeter.measure(session).totalTokens).toBe(projected + OUTPUT_TOKENS)
  })

  it('triggers on the displayed occupancy, not on the meter total that also carries response output', async () => {
    const ctx = createContext(WINDOW)
    const session = conversation()
    const projected = meterNumerator(ctx, session)
    const total = ctx.tokenMeter.measure(session).totalTokens
    // A ratio whose budget sits strictly between the two candidate numerators:
    // the meter total alone would qualify, the displayed occupancy does not.
    const ratio = (projected + OUTPUT_TOKENS / 2) / WINDOW
    expect(Math.floor(WINDOW * ratio)).toBeGreaterThan(projected)
    expect(Math.floor(WINDOW * ratio)).toBeLessThan(total)
    const engine = new TestEngine(ctx, { thresholdRatio: ratio, retainTokens: 500 })

    await preStep(ctx, agent(session))

    expect(engine.calls).toBe(0)
    expect(compacted(session)).toBe(false)
  })

  it('keeps the route-priced meter total when a usage sample is too small to anchor it', async () => {
    const ctx = createContext(WINDOW)
    // A sample this far below the priced history cannot anchor the measurement,
    // so the meter stays on its own route-priced estimate while the projection
    // still publishes the provider figure the meter would display.
    const session = conversation(4, true, { inputTokens: 3, outputTokens: 3 })
    const measurement = ctx.tokenMeter.measure(session)
    expect(measurement.baseline.kind).toBe('estimated')
    expect(meterNumerator(ctx, session)).toBeLessThan(measurement.totalTokens)
    const engine = new TestEngine(ctx, {
      thresholdRatio: (measurement.totalTokens - 1) / WINDOW,
      retainTokens: 20,
    })

    await preStep(ctx, agent(session))

    expect(engine.calls).toBe(1)
  })

  it('falls back to the meter total before any provider usage is reported', async () => {
    const ctx = createContext(WINDOW)
    const session = conversation(4, false)
    expect(ctx.sessionProjections.snapshot(session, ['contextPressure']).values.contextPressure)
      .not.toHaveProperty('pressureTokens')
    const total = ctx.tokenMeter.measure(session).totalTokens
    const engine = new TestEngine(ctx, {
      thresholdRatio: (total - 1) / WINDOW,
      retainTokens: 20,
    })

    await preStep(ctx, agent(session))

    expect(engine.calls).toBe(1)
  })
})

describe('live compaction policy', () => {
  it('keeps the configured threshold when no policy service is mounted', async () => {
    const ctx = createContext(WINDOW)
    const session = conversation()
    const projected = meterNumerator(ctx, session)
    const engine = new TestEngine(ctx, { retainTokens: 500 })
    expect(projected).toBeLessThan(Math.floor(WINDOW * 0.8))

    await preStep(ctx, agent(session))

    expect(engine.calls).toBe(0)
  })

  it('compacts at the policy threshold instead of the configured one', async () => {
    const ctx = createContext(WINDOW)
    const policy = new TestPolicy(ctx)
    const session = conversation()
    const projected = meterNumerator(ctx, session)
    policy.ratio = (projected - 1) / WINDOW
    const engine = new TestEngine(ctx, { retainTokens: 500 })

    await preStep(ctx, agent(session))

    expect(engine.calls).toBe(1)
    expect(compacted(session)).toBe(true)
  })

  it('outranks a modelPolicies threshold while that override keeps its retention', async () => {
    const shadowedUnder = async (retainTokens: number): Promise<number> => {
      const ctx = createContext(WINDOW)
      const policy = new TestPolicy(ctx)
      const session = conversation()
      policy.ratio = (meterNumerator(ctx, session) - 1) / WINDOW
      const engine = new TestEngine(ctx, {
        retainTokens: 500,
        // A threshold this per-model override could never reach on its own.
        modelPolicies: [{ provider: MODEL, model: MODEL, thresholdRatio: 1, retainTokens }],
      })

      await preStep(ctx, agent(session))

      expect(engine.calls).toBe(1)
      const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
      return summary?.data.shadowedSeqs.length ?? 0
    }

    // Compaction ran despite the override's threshold of 1, and the override's
    // own retention still decided how much of the tail survived.
    expect(await shadowedUnder(400)).toBeLessThan(await shadowedUnder(20))
  })

  it('skips the pressure path while the policy is disabled, and resumes when it is re-enabled', async () => {
    const ctx = createContext(WINDOW)
    const policy = new TestPolicy(ctx)
    const session = conversation()
    policy.ratio = (meterNumerator(ctx, session) - 1) / WINDOW
    policy.enabled = false
    const engine = new TestEngine(ctx, { retainTokens: 500 })

    await preStep(ctx, agent(session))
    expect(engine.calls).toBe(0)

    policy.enabled = true
    await preStep(ctx, agent(session))
    expect(engine.calls).toBe(1)
  })

  it('recovers from a provider-confirmed overflow even while the policy is disabled', async () => {
    const ctx = createContext(WINDOW)
    const policy = new TestPolicy(ctx)
    policy.enabled = false
    const engine = new TestEngine(ctx, { thresholdRatio: 1, retainTokens: 500 })
    const session = conversation(3)

    expect(await recover(ctx, agent(session))).toBe(true)

    expect(engine.calls).toBe(1)
    expect(compacted(session)).toBe(true)
  })

  it.each([
    ['above one', 1.5],
    ['not positive', 0],
    ['below the retained tail', 0.05],
  ])('warns once per routed target for a threshold %s and keeps the configured ratio', async (_name, ratio) => {
    const ctx = createContext(WINDOW)
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => void warnings.push(message)) as typeof ctx.logger.warn
    const policy = new TestPolicy(ctx)
    policy.ratio = ratio
    const session = conversation()
    const projected = meterNumerator(ctx, session)
    const engine = new TestEngine(ctx, {
      thresholdRatio: (projected - 1) / WINDOW,
      retainTokens: 500,
    })

    await preStep(ctx, agent(session))
    await preStep(ctx, agent(session))

    expect(warnings).toEqual([
      expect.stringContaining(`compaction policy threshold ratio ${ratio} is unusable for ${MODEL}/${MODEL}`),
    ])
    // The configured ratio still governed, so compaction ran on the first step.
    expect(engine.calls).toBeGreaterThanOrEqual(1)
  })
})

describe('automatic failure record', () => {
  it('leaves a durable errored compaction/end the conversation can render', async () => {
    const ctx = createContext(WINDOW)
    ctx.logger.warn = vi.fn() as typeof ctx.logger.warn
    const policy = new TestPolicy(ctx)
    const session = conversation()
    policy.ratio = (meterNumerator(ctx, session) - 1) / WINDOW
    const engine = new TestEngine(ctx, { retainTokens: 500 })
    engine.error = new Error('summarizer unavailable')

    await preStep(ctx, agent(session))

    const end = session.snapshotEvents().find(event => event.type === 'compaction/end')
    expect(end?.data.error).toContain('summarizer unavailable')
    expect(compacted(session)).toBe(false)
  })
})
