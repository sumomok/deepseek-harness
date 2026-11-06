/** Real automatic pressure compaction through the mounted engine and the Agent loop. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { pluginRecordOf, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState, { Config, PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

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

const rewrite = toolCallResponse('call-rewrite', PROPOSE_OPEN_WORK, {
  scope: 'demo', revision: 1,
  dispositions: [{ unitId: 'a', disposition: 'new' }, { unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
  tasks: [{ id: 't1', title: 'work', unitIds: ['a', 'b', 'c'] }],
})
const valid = toolCallResponse('call-valid', PROPOSE_OPEN_WORK, {
  scope: 'demo', revision: 1,
  dispositions: [{ unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
  tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
})

it('condenses under pressure and keeps the record, its view and its guard', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(FixedSummaryEngine, { thresholdRatio: 0.35, retainTokens: 100, headroomTokens: 0, maxTokens: 64 })
  await ctx.plugin(DecisionState, Config.parse({ scopes: { demo: { units: ['a', 'b', 'c', 'd'] } } }))
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === 'decision-auto-compaction') events.push(event) })
  const harness = await mountAgentLoopTestHarness(ctx)

  const adapter = new SmallWindowAdapter([
    textResponse('start'),
    textResponse('ok'),
    textResponse('ok'),
    textResponse('ok'),
    rewrite,
    valid,
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await harness.create(SessionId('decision-auto-compaction'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: `片段 0 ${'x'.repeat(400)}` }], source: { kind: 'user' } }))
  await agent.whenIdle()
  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  const before = JSON.stringify(ctx.decisionState.scope(agent, 'demo'))
  for (let index = 1; index < 4; index += 1) {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: `片段 ${index} ${'x'.repeat(400)}` }], source: { kind: 'user' },
    }))
    await agent.whenIdle()
  }

  // A real pressure compaction ran at a step boundary: matching start/summary/end, no error,
  // and the old history actually left the surface.
  const starts = events.filter(event => event.type === 'compaction/start')
  const ends = events.filter(event => event.type === 'compaction/end')
  expect(starts.length).toBeGreaterThan(0)
  expect(ends.length).toBe(starts.length)
  const end = ends.at(-1)
  if (end?.type !== 'compaction/end') throw new Error('no compaction end')
  const summary = events.findLast(event =>
    event.type === 'compaction/summary' && event.data.compactionId === end.data.compactionId)
  if (summary?.type !== 'compaction/summary') throw new Error('no matching compaction summary')
  expect(end.data.error).toBeUndefined()
  const firstHistory = events.find(event => event.type === 'user/message' && JSON.stringify(event.data).includes('片段 0'))
  if (firstHistory?.type !== 'user/message') throw new Error('no first history message')
  expect(summary.data.shadowedSeqs).toContain(firstHistory.seq)
  expect(agent.session.surface.nodes).not.toContain(firstHistory.seq)

  // The record sits inside the replaced range but is a plugin record, never shadowed.
  const record = events.map(pluginRecordOf).find(entry =>
    entry?.type === 'plugin:decision-state/record' && JSON.stringify(entry.data).includes('d1'))!
  expect(record.seq).toBeGreaterThan(summary.data.shadowedRange.start)
  expect(record.seq).toBeLessThan(summary.data.shadowedRange.end)
  expect(summary.data.shadowedSeqs).not.toContain(record.seq)

  // The ledger is identical after compaction.
  expect(JSON.stringify(ctx.decisionState.scope(agent, 'demo'))).toBe(before)
  expect(ctx.decisionState.state(agent).corrupt).toEqual([])
  expect(ctx.decisionState.open(agent, 'demo')).toEqual(['b', 'c', 'd'])

  // The next turn's request carries the summary and the regenerated view.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const textOf = (request: (typeof adapter.requests)[number]) => (request.messages ?? [])
    .flatMap(message => message.content).map(block => 'text' in block ? block.text : '').join('\n')
  const rewriting = textOf(adapter.requests.at(-1)!)
  expect(rewriting).toContain('COMPACTED SUMMARY')
  expect(rewriting).toContain('revision 1')
  expect(rewriting).toContain('待处置单元：b、c、d')
  expect(rewriting).toContain('unit-decided')

  // The guard still rejects a rewrite after compaction, and a valid submission concludes with the decided unit.
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '提交' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const result = events.filter(event => event.type === 'tool/result').at(-1)!
  const resultText = result.data.message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
  expect(resultText).toContain('方案已接受')
  expect(resultText).toContain('"unitId":"a"')
  expect(resultText).toContain('"targetIds":["#1"]')
  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(2)
  expect(ctx.decisionState.open(agent, 'demo')).toEqual([])
})
