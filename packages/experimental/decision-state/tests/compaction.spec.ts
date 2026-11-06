/** After a surface replacement the record still folds, the view survives and no duplicate record is written. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState, { PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

it('keeps the decision and the view across a surface replacement', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(DecisionState, { scopes: { demo: { units: ['a', 'b', 'c', 'd'] } } })
  const harness = await mountAgentLoopTestHarness(ctx)

  const adapter = new MockAdapter([
    toolCallResponse('call-1', PROPOSE_OPEN_WORK, {
      scope: 'demo', revision: 1,
      dispositions: [{ unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
      tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
    }),
    textResponse('ok'),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)

  const agent = await harness.create(SessionId('decision-compaction'), { provider: 'mock', model: 'mock' })
  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '开始' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(1)

  // Replace one surface node with a checkpoint summary, as a compaction does.
  const shadowed = agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '被压缩的历史' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const start = agent.session.append('compaction/start', { compactionId: 'c1', turn: 1 })
  const summaryEvent = agent.session.append('compaction/summary', {
    compactionId: 'c1',
    summary: [{ type: 'text', text: 'condensed' }],
    shadowedRange: { startSeq: shadowed.seq, endSeq: shadowed.seq },
    shadowedSeqs: [SessionSeq(shadowed.seq)],
    shadowedTokenCount: 12,
    provider: 'mock',
    model: 'mock',
    rawOutput: [{ type: 'text', text: 'condensed' }],
    llmStreamCall: true,
  })
  agent.session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'condensed' }],
    source: { kind: 'compact-checkpoint', compactionId: 'c1' },
  }), { surfaceOp: { op: 'replace', startSeq: shadowed.seq, endSeq: shadowed.seq }, sourceEventSeqs: [shadowed.seq, start.seq, summaryEvent.seq] })
  agent.session.append('compaction/end', { compactionId: 'c1', turn: null })

  agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  // The record is a plugin record, outside the surface: compaction changes no revision and writes no duplicate.
  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(1)
  const last = adapter.requests.at(-1)!
  const rendered = (last.messages ?? []).flatMap(message => message.content).map(block => 'text' in block ? block.text : '').join('\n')
  expect(rendered).toContain('revision 1')
  expect(rendered).toContain('待处置单元：b、c、d')
})
