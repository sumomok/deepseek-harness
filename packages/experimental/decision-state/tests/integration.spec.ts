/** End-to-end: recorded decision is injected, rewriting it is rejected, and the accepted proposal carries it. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState from '../src/service.ts'
import { PROPOSE_OPEN_WORK } from '../src/tool.ts'

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
  // The ledger message lands in this request; the projection-driven view is assembled from
  // committed events, so it appears from the next request on.
  expect(textOf(first)).toContain('"kind":"decide"')
  const second = textOf(adapter.requests[1]!)
  expect(second).toContain('已定决定（不可改写')
  expect(second).toContain('revision 1')

  // The rejected rewrite comes back to the model; the accepted submission concludes the
  // turn, so the adapter sees exactly two requests and no follow-up text turn.
  expect(textOf(adapter.requests[1]!)).toContain('拒绝')
  expect(adapter.requests).toHaveLength(2)
})
