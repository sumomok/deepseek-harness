/** End-to-end: recorded decision is injected, rewriting it is rejected, and the accepted proposal carries it. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, appendPluginRecord, type SessionEvent } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState from '@deepseek-ai/dsh-experimental-decision-state'
import { PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

it('injects recorded decisions, rejects rewrites, and assembles the accepted proposal', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(DecisionState, { scopes: { demo: { units: ['a', 'b', 'c', 'd'] } } })
  const harness = await mountAgentLoopTestHarness(ctx)

  const rewrite = toolCallResponse('call-1', PROPOSE_OPEN_WORK, {
    scope: 'demo', revision: 1,
    dispositions: [{ unitId: 'a', disposition: 'new' }, { unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
    tasks: [{ id: 't1', title: 'work', unitIds: ['a', 'b', 'c'] }],
  })
  const valid = toolCallResponse('call-2', PROPOSE_OPEN_WORK, {
    scope: 'demo', revision: 1,
    dispositions: [{ unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }],
    tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
  })
  const adapter = new MockAdapter([rewrite, valid, textResponse('done')])
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => { if (session.id === 'decision-integration') events.push(event) })
  ctx.llm.registerAdapter(['mock'], adapter)

  const agent = await harness.create(SessionId('decision-integration'), { provider: 'mock', model: 'mock' })
  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  const first = adapter.requests[0]
  expect((first.tools ?? []).some(tool => tool.name === PROPOSE_OPEN_WORK)).toBe(true)
  const textOf = (request: (typeof adapter.requests)[number]) => (request.messages ?? [])
    .flatMap(message => message.content).map(block => 'text' in block ? block.text : '').join('\n')
  // The decision is committed before the turn, so the view is already present and the
  // record itself never enters the model-visible surface.
  const firstText = textOf(first)
  expect(firstText).toContain('revision 1')
  expect(firstText).toContain('待处置单元：b、c、d')
  expect(firstText).not.toContain('"decisionId"')

  // The rejected rewrite comes back to the model; the accepted submission concludes the
  // turn, so the adapter sees exactly two requests and no follow-up text turn.
  expect(textOf(adapter.requests[1]!)).toContain('方案被拒绝')
  expect(textOf(adapter.requests[1]!)).toContain('unit-decided')
  expect(adapter.requests).toHaveLength(2)

  // The accepted result carries the assembled proposal back through the tool result.
  const result = events.filter(event => event.type === 'tool/result').at(-1)
  const resultText = result?.type === 'tool/result'
    ? result.data.message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    : ''
  expect(resultText).toContain('方案已接受')
  expect(resultText).toContain('"unitId":"b"')
})

it('refuses a duplicate unit before writing and repairs a corrupt scope', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(DecisionState, { scopes: { demo: { units: ['a', 'b', 'c'] } } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('decision-repair'), { provider: 'mock', model: 'mock' })

  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  expect(() => ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd2', unitIds: ['a'], disposition: 'new', targetIds: [], sourceEventSeqs: [2] }],
    supersedes: [],
  })).toThrowError(/unit a decided twice/)
  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(1)

  appendPluginRecord(agent.session, 'plugin:decision-state/record', {
    scope: 'demo',
    revision: 2,
    active: [
      { decisionId: 'd3', unitIds: ['b'], disposition: 'new', targetIds: [], sourceEventSeqs: [3] },
      { decisionId: 'd4', unitIds: ['b'], disposition: 'new', targetIds: [], sourceEventSeqs: [4] },
    ],
  })
  expect(ctx.decisionState.state(agent).corrupt).toContain('demo')

  ctx.decisionState.repair(agent, 'demo', [
    { decisionId: 'd5', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [5] },
  ])
  expect(ctx.decisionState.state(agent).corrupt).not.toContain('demo')
  expect(ctx.decisionState.open(agent, 'demo')).toEqual(['b', 'c'])
})
