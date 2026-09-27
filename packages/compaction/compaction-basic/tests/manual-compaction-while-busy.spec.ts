import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, ManualCompactionWhileBusy } from '@deepseek-ai/dsh-compaction'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage, LlmAdapter, LlmError, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, RequestMessage, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

const MODEL = 'busy-mock'
const LONG = 'history the summary replaces '.repeat(80)
const COMMAND = CommandId('busy-compact-command')

/** One scripted model call; `hold` keeps the call open until released. */
interface Reply {
  readonly kind: 'tool' | 'text' | 'fail'
  readonly hold?: Promise<undefined>
}

/** Answers each call from a script and reports when a call is in flight. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: RequestMessage[][] = []
  readonly entered: Array<PromiseWithResolvers<undefined>> = []

  constructor(private readonly script: Reply[]) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 1_000_000 } })
  }

  /**
   * Resolve once the call with this index has started streaming.
   * @param index - zero-based call index.
   * @returns a promise for that call's start.
   */
  started(index: number): Promise<undefined> {
    while (this.entered.length <= index) this.entered.push(Promise.withResolvers<undefined>())
    return this.entered[index]!.promise
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const index = this.requests.length
    this.requests.push([...options.messages])
    void this.started(index)
    this.entered[index]!.resolve(undefined)
    const reply = this.script[index] ?? { kind: 'text' }
    if (reply.hold !== undefined) await reply.hold
    options.signal?.throwIfAborted()
    if (reply.kind === 'fail') throw new LlmError('provider unavailable', 'UNKNOWN')
    if (reply.kind === 'tool') {
      const id = ToolCallId(`call-${index}`)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'work', arguments: '{}' } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: `reply ${index}` } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Summarizer stub whose failure is scripted per test. */
class SummaryStubEngine extends BasicCompactionEngine {
  error: unknown
  summaries = 0

  override async summarize(): Promise<{ summary: ContentBlock[]; provider: string; model: string }> {
    this.summaries += 1
    await Promise.resolve()
    if (this.error !== undefined) throw this.error
    return { summary: [{ type: 'text', text: 'BUSY CHECKPOINT' }], provider: MODEL, model: MODEL }
  }
}

interface Bench {
  readonly ctx: Context
  readonly agent: Agent
  readonly engine: SummaryStubEngine
  /** The plugin fiber owning the engine, disposable on its own. */
  readonly engineFiber: { dispose: () => Promise<unknown> }
  readonly adapter: ScriptedAdapter
  /** Compaction, turn, and step boundaries in log order. */
  readonly log: string[]
}

/** A real loop with one `work` tool, invariants, and a scripted adapter. */
async function bench(script: Reply[]): Promise<Bench> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(CompactionInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter([MODEL], adapter)
  ctx.tools.register(defineContentToolFixture({
    name: 'work',
    description: 'does work',
    parameters: {},
    async execute() {
      return [{ type: 'text', text: 'work result' }]
    },
  }))
  const engineFiber = ctx.plugin(SummaryStubEngine, { auto: false })
  await engineFiber
  const engine = ctx.compaction as SummaryStubEngine
  const agent = await ctx.agentLoop.create(SessionId('busy-compact'), { provider: MODEL, model: MODEL })
  const log: string[] = []
  ctx.on('session/event', (_session, event) => {
    switch (event.type) {
      case 'turn/start':
      case 'turn/end':
        log.push(`${event.type}:${event.data.turn}`)
        return
      case 'step/start':
        log.push(`${event.type}:${event.data.turn}.${event.data.step}`)
        return
      case 'compaction/start':
      case 'compaction/end':
        log.push(`${event.type}:${String(event.data.turn)}:${String(event.data.sourceCommandId)}`)
        return
      default:
    }
  })
  return { ctx, agent, engine, engineFiber, adapter, log }
}

function prompt(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function hold(): { promise: Promise<undefined>; release: () => void } {
  const { promise, resolve } = Promise.withResolvers<undefined>()
  return { promise, release: () => { resolve(undefined) } }
}

/**
 * Start one request and capture its outcome, including a synchronous refusal,
 * without letting an early rejection go unhandled.
 */
function outcome(request: () => Promise<CompactionResult | null>): Promise<unknown> {
  try {
    return request().then(value => value, (error: unknown) => error)
  } catch (error: unknown) {
    return Promise.resolve(error)
  }
}

function requestFor(
  b: Bench,
  whileBusy: ManualCompactionWhileBusy,
  signal = new AbortController().signal,
): () => Promise<CompactionResult | null> {
  return () => b.engine.compactNow(b.agent, signal, COMMAND, whileBusy)
}

function sawCheckpoint(messages: RequestMessage[] | undefined): boolean {
  return (messages ?? []).some(message => message.content.some(block => block.type === 'text' && block.text.includes('BUSY CHECKPOINT')))
}

function compactionCount(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === 'compaction/start').length
}

describe('compactNow for a running agent', () => {
  it('compacts at the next step boundary inside the running turn with next-step', async () => {
    const tool = hold()
    const b = await bench([{ kind: 'tool', hold: tool.promise }, { kind: 'text' }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      expect(b.agent.status).toBe('running')
      const request = outcome(requestFor(b, 'next-step'))
      tool.release()
      const result = await request
      expect(result).toMatchObject({ sourceCommandId: COMMAND })
      await b.agent.whenIdle()
      expect(b.log).toEqual([
        'turn/start:1', 'step/start:1.1',
        `compaction/start:1:${COMMAND}`, `compaction/end:1:${COMMAND}`,
        'step/start:1.2', 'turn/end:1',
      ])
      expect(sawCheckpoint(b.adapter.requests[1])).toBe(true)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('compacts after the turn when next-step has no later step boundary', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'next-step'))
      answer.release()
      expect(await request).toMatchObject({ sourceCommandId: COMMAND })
      expect(b.log).toEqual([
        'turn/start:1', 'step/start:1.1', 'turn/end:1',
        `compaction/start:null:${COMMAND}`, `compaction/end:null:${COMMAND}`,
      ])
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('lets turn-end pass the step boundary and compacts once the turn ends', async () => {
    const tool = hold()
    const b = await bench([{ kind: 'tool', hold: tool.promise }, { kind: 'text' }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'turn-end'))
      tool.release()
      expect(await request).toMatchObject({ sourceCommandId: COMMAND })
      expect(b.log).toEqual([
        'turn/start:1', 'step/start:1.1', 'step/start:1.2', 'turn/end:1',
        `compaction/start:null:${COMMAND}`, `compaction/end:null:${COMMAND}`,
      ])
      expect(sawCheckpoint(b.adapter.requests[1])).toBe(false)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('compacts before a queued turn that follows without an idle gap', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }, { kind: 'text' }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'turn-end'))
      prompt(b.agent, 'queued question')
      answer.release()
      expect(await request).toMatchObject({ sourceCommandId: COMMAND })
      await b.agent.whenIdle()
      expect(b.log).toEqual([
        'turn/start:1', 'step/start:1.1', 'turn/end:1',
        'turn/start:2', `compaction/start:2:${COMMAND}`, `compaction/end:2:${COMMAND}`,
        'step/start:2.1', 'turn/end:2',
      ])
      expect(sawCheckpoint(b.adapter.requests[1])).toBe(true)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  for (const boundary of ['turn/end:1', 'turn/start:2'] as const) {
    it(`compacts at the queued turn's first step when turn-end is requested at ${boundary}`, async () => {
      const answer = hold()
      const b = await bench([{ kind: 'text', hold: answer.promise }, { kind: 'text' }])
      try {
        let request: Promise<unknown> | undefined
        b.ctx.on('session/event', (_session, event) => {
          if (request !== undefined) return
          if (`${event.type}:${'turn' in event.data ? String(event.data.turn) : ''}` !== boundary) return
          request = outcome(requestFor(b, 'turn-end'))
        })
        prompt(b.agent, LONG)
        await b.adapter.started(0)
        prompt(b.agent, 'queued question')
        answer.release()
        await b.adapter.started(1)
        await b.agent.whenIdle()
        expect(await request).toMatchObject({ sourceCommandId: COMMAND })
        expect(b.log).toEqual([
          'turn/start:1', 'step/start:1.1', 'turn/end:1',
          'turn/start:2', `compaction/start:2:${COMMAND}`, `compaction/end:2:${COMMAND}`,
          'step/start:2.1', 'turn/end:2',
        ])
        expect(sawCheckpoint(b.adapter.requests[1])).toBe(true)
      } finally {
        await b.ctx.fiber.dispose()
      }
    })
  }

  it('compacts after a turn that ends in an error', async () => {
    const failing = hold()
    const b = await bench([{ kind: 'text' }, { kind: 'fail', hold: failing.promise }])
    try {
      prompt(b.agent, LONG)
      await b.agent.whenIdle()
      prompt(b.agent, 'fails')
      await b.adapter.started(1)
      const request = outcome(requestFor(b, 'next-step'))
      failing.release()
      expect(await request).toMatchObject({ sourceCommandId: COMMAND })
      expect(b.log.slice(-2)).toEqual([`compaction/start:null:${COMMAND}`, `compaction/end:null:${COMMAND}`])
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('compacts immediately when the agent is idle even with a busy timing', async () => {
    const b = await bench([{ kind: 'text' }])
    try {
      prompt(b.agent, LONG)
      await b.agent.whenIdle()
      expect(await requestFor(b, 'turn-end')()).toMatchObject({ sourceCommandId: COMMAND })
      expect(b.log.slice(-2)).toEqual([`compaction/start:null:${COMMAND}`, `compaction/end:null:${COMMAND}`])
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('refuses a running agent as busy without a busy timing', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const refused = await outcome(() => b.engine.compactNow(b.agent, new AbortController().signal, COMMAND))
      expect(refused).toBeInstanceOf(ManualCompactionError)
      expect((refused as ManualCompactionError).code).toBe('busy')
      answer.release()
      await b.agent.whenIdle()
      expect(compactionCount(b.agent.session)).toBe(0)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('keeps one waiting request per agent', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const first = outcome(requestFor(b, 'turn-end'))
      const second = await outcome(requestFor(b, 'next-step'))
      expect(second).toBeInstanceOf(ManualCompactionError)
      expect((second as ManualCompactionError).code).toBe('busy')
      answer.release()
      expect(await first).toMatchObject({ sourceCommandId: COMMAND })
      expect(compactionCount(b.agent.session)).toBe(1)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('cancels a waiting request when Stop aborts the turn', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'turn-end'))
      b.agent.cancel({ kind: 'user' })
      answer.release()
      const cancelled = await request
      expect(cancelled).toBeInstanceOf(ManualCompactionError)
      expect((cancelled as ManualCompactionError).code).toBe('cancelled')
      await b.agent.whenIdle()
      expect(compactionCount(b.agent.session)).toBe(0)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('rejects with the request reason when its own signal aborts while waiting', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const controller = new AbortController()
      const request = outcome(requestFor(b, 'turn-end', controller.signal))
      const reason = new Error('page closed')
      controller.abort(reason)
      expect(await request).toBe(reason)
      answer.release()
      await b.agent.whenIdle()
      expect(compactionCount(b.agent.session)).toBe(0)
      expect(await requestFor(b, 'turn-end')()).toMatchObject({ sourceCommandId: COMMAND })
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('reports busy when another idle listener claims maintenance before the turn-end request', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      const rival = Promise.withResolvers<undefined>()
      b.ctx.on('agent/status', ({ agent, status }) => {
        if (status === 'idle') void agent.runMaintenance(() => rival.promise)
      }, true)
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'turn-end'))
      answer.release()
      const refused = await request
      expect(refused).toBeInstanceOf(ManualCompactionError)
      expect((refused as ManualCompactionError).code).toBe('busy')
      rival.resolve(undefined)
      await b.agent.whenIdle()
      expect(compactionCount(b.agent.session)).toBe(0)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('cancels a waiting request when the engine is disposed', async () => {
    const answer = hold()
    const b = await bench([{ kind: 'text', hold: answer.promise }])
    try {
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'turn-end'))
      await b.engineFiber.dispose()
      const cancelled = await request
      expect(cancelled).toBeInstanceOf(ManualCompactionError)
      expect((cancelled as ManualCompactionError).code).toBe('cancelled')
      answer.release()
      await b.agent.whenIdle()
      expect(compactionCount(b.agent.session)).toBe(0)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('classifies a failed step-boundary compaction and lets the turn continue', async () => {
    const tool = hold()
    const b = await bench([{ kind: 'tool', hold: tool.promise }, { kind: 'text' }])
    try {
      b.engine.error = new Error('summarizer unavailable')
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'next-step'))
      tool.release()
      const failed = await request
      expect(failed).toBeInstanceOf(ManualCompactionError)
      expect((failed as ManualCompactionError).code).toBe('summary')
      await b.agent.whenIdle()
      expect(b.log.slice(-2)).toEqual(['step/start:1.2', 'turn/end:1'])
      const end = b.agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')
      expect(end?.type === 'compaction/end' && end.data.error).toContain('summarizer unavailable')
    } finally {
      await b.ctx.fiber.dispose()
    }
  })

  it('reports cancellation when Stop lands during a step-boundary compaction', async () => {
    const tool = hold()
    const b = await bench([{ kind: 'tool', hold: tool.promise }, { kind: 'text' }])
    try {
      b.engine.summarize = async () => {
        b.agent.cancel({ kind: 'user' })
        await Promise.resolve()
        throw new Error('aborted by stop')
      }
      prompt(b.agent, LONG)
      await b.adapter.started(0)
      const request = outcome(requestFor(b, 'next-step'))
      tool.release()
      const cancelled = await request
      expect(cancelled).toBeInstanceOf(ManualCompactionError)
      expect((cancelled as ManualCompactionError).code).toBe('cancelled')
      await b.agent.whenIdle()
      expect(b.adapter.requests).toHaveLength(1)
    } finally {
      await b.ctx.fiber.dispose()
    }
  })
})
