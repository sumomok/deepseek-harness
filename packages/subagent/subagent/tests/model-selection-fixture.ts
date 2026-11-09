/** Real AgentLoop and persistence fixture for local child model selection. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import { onTestFinished } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { mountWorkingDirectoryFixture } from './working-directory-fixture.ts'

export const leadSelection = { provider: 'lead', model: 'lead-A', reasoningEffort: ReasoningEffortId('lead-high') }
export const childSelection = { provider: 'child', model: 'child-B' }
export const laterSelection = { provider: 'later', model: 'later-C', reasoningEffort: ReasoningEffortId('later-high') }
export const childDefaultEffort = ReasoningEffortId('child-low')
export const childExplicitEffort = ReasoningEffortId('child-high')

/** Pause the first child request after its header is committed, until explicitly released. */
class ChildAdapter extends MockAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  readonly release = Promise.withResolvers<undefined>()

  constructor(private readonly paused: boolean) {
    super([textResponse('child answer'), textResponse('child follow-up')], {
      efforts: [
        { id: childDefaultEffort, name: 'Child low' },
        { id: childExplicitEffort, name: 'Child high' },
      ],
      defaultEffort: childDefaultEffort,
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (this.paused && this.requests.length === 0) {
      this.entered.resolve(undefined)
      await this.release.promise
    }
    yield* super.stream(options)
  }
}

/**
 * Own an isolated persistence root and runtime generations, releasing held requests before disposal.
 * @returns a boot function for creation and cold-resume tests.
 */
export async function modelSelectionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-child-model-'))
  const generations: Array<{ ctx: Context; childAdapter: ChildAdapter }> = []
  onTestFinished(async () => {
    for (const generation of generations) generation.childAdapter.release.resolve(undefined)
    for (const { ctx } of generations.toReversed()) await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })

  async function boot(options: { resume?: boolean; paused?: boolean } = {}) {
    const ctx = new Context()
    const childAdapter = new ChildAdapter(options.paused ?? false)
    generations.push({ ctx, childAdapter })
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TestSessionQuery)
    await mountWorkingDirectoryFixture(ctx)
    await ctx.plugin(SubagentRuntime)
    await ctx.plugin(Spawn, { providerName: 'spawn' })
    await ctx.plugin(Fork, { providerName: 'fork' })
    const leadAdapter = new MockAdapter([textResponse('parent answer'), textResponse('parent follow-up')], {
      efforts: [{ id: leadSelection.reasoningEffort, name: 'Lead high' }],
      defaultEffort: leadSelection.reasoningEffort,
    })
    const laterAdapter = new MockAdapter([textResponse('later answer'), textResponse('resumed answer')], {
      efforts: [{ id: laterSelection.reasoningEffort, name: 'Later high' }],
      defaultEffort: laterSelection.reasoningEffort,
    })
    ctx.llm.registerAdapter(['lead'], leadAdapter)
    ctx.llm.registerAdapter(['child'], childAdapter)
    ctx.llm.registerAdapter(['later'], laterAdapter)
    const parent = options.resume
      ? (await ctx.agents.resume({ resumeSessionId: SessionId('parent'), agentOptions: leadSelection })).agent
      : await ctx.agentLoop.create(SessionId('parent'), leadSelection)
    return { ctx, parent, leadAdapter, childAdapter, laterAdapter }
  }
  return { boot }
}

/**
 * Complete a real parent request so fork has a balanced prefix to inherit.
 * @param parent - parent Agent receiving the history turn.
 */
export async function completeParentTurn(parent: Agent): Promise<void> {
  parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent history' }], source: { kind: 'user' } }))
  await parent.whenIdle()
}
