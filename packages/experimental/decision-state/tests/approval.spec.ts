/** L1: an accepted submission reaches the ledger only after the human approves it. */
import { Context } from '@deepseek-ai/cordis'
import { onTestFinished, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import UserQuestionService, { type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import DecisionState, { Config, PROPOSE_OPEN_WORK } from '@deepseek-ai/dsh-experimental-decision-state'

const APPROVE = '批准并记录'
const REVISE = '继续修改'

function answerWith(label: string, custom?: string) {
  return async (request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> => ({
    answers: request.questions.map(question => ({
      id: question.id,
      selected: [label],
      ...custom === undefined ? {} : { custom },
    })),
  })
}

const submission = {
  scope: 'demo',
  revision: 1,
  dispositions: [
    { unitId: 'b', disposition: 'new' },
    { unitId: 'c', disposition: 'new' },
    { unitId: 'd', disposition: 'defer' },
  ],
  tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
}

async function mount(options: { approval: 'auto' | 'review'; answer?: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer> }) {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(UserQuestionService)
  if (options.answer !== undefined) ctx.on('user-questions/request', options.answer)
  await ctx.plugin(DecisionState, Config.parse({
    approval: options.approval,
    scopes: { demo: { units: ['a', 'b', 'c', 'd'] } },
  }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const events: SessionEvent[] = []
  ctx.on('session/event', (session, event) => {
    if (session.id === 'decision-approval') events.push(event)
  })
  return { ctx, harness, events }
}

function seed(ctx: Context, agent: Agent) {
  ctx.decisionState.record(agent, {
    scope: 'demo',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
}

function resultText(events: readonly SessionEvent[]): string {
  const result = events.filter(event => event.type === 'tool/result').at(-1)
  return result?.type === 'tool/result'
    ? result.data.message.content.map(block => block.type === 'text' ? block.text : '').join('\n')
    : ''
}

it('commits an approved proposal and ends the turn', async () => {
  const { ctx, harness, events } = await mount({ approval: 'review', answer: answerWith(APPROVE) })
  const adapter = new MockAdapter([toolCallResponse('call-1', PROPOSE_OPEN_WORK, submission), textResponse('unused')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await harness.create(SessionId('decision-approval'), { provider: 'mock', model: 'mock' })
  seed(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '提交' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(2)
  expect(ctx.decisionState.open(agent, 'demo')).toEqual([])
  expect(adapter.requests).toHaveLength(1)
  expect(resultText(events)).toContain('方案已接受')
  expect(resultText(events)).toContain('revision 2')
})

it('returns the reviewer feedback without committing', async () => {
  const { ctx, harness, events } = await mount({
    approval: 'review',
    answer: answerWith(REVISE, '先把 d 留在开放状态'),
  })
  const adapter = new MockAdapter([toolCallResponse('call-1', PROPOSE_OPEN_WORK, submission), textResponse('done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await harness.create(SessionId('decision-approval'), { provider: 'mock', model: 'mock' })
  seed(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '提交' }], source: { kind: 'user' } }))
  await agent.whenIdle()

  expect(ctx.decisionState.scope(agent, 'demo').revision).toBe(1)
  expect(ctx.decisionState.open(agent, 'demo')).toEqual(['b', 'c', 'd'])
  expect(adapter.requests).toHaveLength(2)
  expect(resultText(events)).toContain('先把 d 留在开放状态')
})

it('fails loud when review mode has no question channel', async () => {
  const ctx = new Context()
  onTestFinished(async () => { await ctx.fiber.dispose() })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(DecisionState, Config.parse({
    approval: 'review',
    scopes: { demo: { units: ['a', 'b'] } },
  }))
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('decision-no-questions'), { provider: 'mock', model: 'mock' })

  await expect(ctx.decisionState.requestApproval(agent, 'proposal', new AbortController().signal))
    .rejects.toThrowError(/user-questions/)
})
