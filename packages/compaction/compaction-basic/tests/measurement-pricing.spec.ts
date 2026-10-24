import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'pricing-reuse'

class PricingAdapter extends LlmAdapter {
  price = 300

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000 } })
  }

  override imageRequestPricing(): { priceImages: (images: readonly unknown[]) => { visualTokens: number; text: string }[] } {
    return {
      priceImages: (images: readonly unknown[]) => images.map(() => ({ visualTokens: this.price, text: 'request preview' })),
    }
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class Engine extends BasicCompactionEngine {
  calls = 0

  override async summarize(_input: SummarizationInput, _agent: Agent, _signal?: AbortSignal): Promise<SummaryResult> {
    this.calls += 1
    if (this.calls === 1 && this.failFirst === true) throw new Error('transient summary failure')
    return {
      summary: [{ type: 'text', text: 'short checkpoint' }],
      provider: 'summary-provider',
      model: 'summary-model',
      maxTokens: 8,
    }
  }

  failFirst = false
}

function imageConversation(turns = 4): Session {
  const session = Session.create(SessionId('pricing-reuse'))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [
        { type: 'text', text: `image turn ${turn}` },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(`sha256:${String(turn).repeat(8)}`),
            mediaType: 'image/png',
            bytes: 2048,
            width: 800,
            height: 800,
            name: `shot-${turn}`,
          },
        },
      ],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) session.append('request/header', { header: { config: { provider: MODEL, model: MODEL } }, reason: 'initial' })
    session.append('assistant/message', {
      stream: [], turn, step: 1,
      message: createMessage({
        role: 'assistant', content: [{ type: 'text', text: `ok ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

function mount(adapter: PricingAdapter): { ctx: Context; session: Session; compact: Engine } {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], adapter)
  const session = imageConversation()
  const compact = new Engine(ctx, { headroomTokens: 0, maxTokens: 8192, auto: false, thresholdRatio: 0.8, retainTokens: 350 })
  return { ctx, session, compact }
}

function fakeAgent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

describe('measurement is retaken when pricing changes across awaits', () => {
  it('re-measures after resolveModelInfo changes image pricing', async () => {
    const adapter = new PricingAdapter()
    const { session, compact } = mount(adapter)
    const originalResolve = adapter.resolveModel.bind(adapter)
    adapter.resolveModel = async (provider: string, model: string) => {
      // The engine's pre-decision measurement is already taken; the adapter
      // materializes a different image price while resolving model info.
      adapter.price = 301
      return originalResolve(provider, model)
    }

    const result = await compact.compactIfNeeded(fakeAgent(session), 'pressure', new AbortController().signal)

    expect(result).not.toBeNull()
    expect(compact.calls).toBe(1)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })

  it('re-measures in recovery after a summary-error listener changes pricing', async () => {
    const adapter = new PricingAdapter()
    const { ctx, session, compact } = mount(adapter)
    compact.failFirst = true
    ctx.on('compaction/summary-error', (() => {
      adapter.price = 301
      return true
    }) as never)

    const result = await compact.compactIfNeeded(fakeAgent(session), 'pressure', new AbortController().signal)

    expect(result).not.toBeNull()
    expect(compact.calls).toBe(2)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })
})
