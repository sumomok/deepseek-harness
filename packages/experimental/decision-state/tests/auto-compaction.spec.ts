/** Real automatic pressure compaction through the mounted engine and the Agent loop. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState, { PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

class SmallWindowAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 2000 } })
  }
}

class FixedSummaryEngine extends BasicCompactionEngine {
  override async summarize() {
    return { summary: [{ type: 'text' as const, text: 'COMPACTED SUMMARY' }], provider: 'mock', model: 'mock' }
  }
}

it('condenses under pressure and keeps the record and its view', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(FixedSummaryEngine, { thresholdRatio: 0.2, retainTokens: 100, headroomTokens: 0, maxTokens: 64 })
  await ctx.plugin(DecisionState, { scopes: { demo: { units: ['a', 'b', 'c', 'd'] } } })
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === 'decision-auto-compaction') events.push(event) })
  const harness = await mountAgentLoopTestHarness(ctx)

  const adapter = new SmallWindowAdapter([
    toolCallResponse('call-1', PROPOSE_OPEN_WORK, {
      scope: 'demo', revision: 1,
      dispositions: [{ unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
      tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
    }),
    textResponse('ok'),
    textResponse('ok'),
    textResponse('ok'),
    textResponse('after compaction'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await harness.create(SessionId('decision-auto-compaction'), { provider: 'mock', model: 'mock' })
  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  for (let index = 0; index < 4; index += 1) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `片段 ${index} ${'x'.repeat(400)}` }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
  }
  expect(events.filter(event => event.type === 'compaction/end').length).toBeGreaterThan(0)
  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(1)
  expect(ctx.decisionState.scope(agent, 'demo').active.some(decision => decision.unitIds.includes('a'))).toBe(true)
  expect(ctx.decisionState.open(agent, 'demo')).toEqual(['b', 'c', 'd'])

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '最后的检查' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const last = adapter.requests.at(-1)!
  const rendered = (last.messages ?? []).flatMap(message => message.content).map(block => 'text' in block ? block.text : '').join('\n')
  expect(rendered).toContain('COMPACTED SUMMARY')
  expect(rendered).toContain('revision 1')
  expect(rendered).toContain('待处置单元：b、c、d')
})
