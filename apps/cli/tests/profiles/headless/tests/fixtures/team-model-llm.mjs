/** Deterministic external LLM substitute for public Team model-selection tests. */

import { appendFileSync } from 'node:fs'
import { LlmAdapter, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

const providerA = 'team-model-a'
const providerB = 'team-model-b'

function toolCalls(messages) {
  return messages.flatMap(message => message.role === 'assistant'
    ? message.content.filter(block => block.type === 'tool-call')
    : [])
}

function textChunks(text) {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class TeamModelAdapter extends LlmAdapter {
  nextCall = 0

  constructor(capturePath) {
    super()
    this.capturePath = capturePath
  }

  listModels(provider) {
    const models = provider === providerA ? ['model-a'] : ['model-b', 'blocked-model']
    return Promise.resolve(models.map(id => ({ provider, id, name: id })))
  }

  resolveModel(provider, model) {
    const efforts = provider === providerA ? ['parent-only'] : ['low', 'high']
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: provider === providerA ? 262144 : 131072 },
      reasoning: {
        efforts: efforts.map(id => ({ id: ReasoningEffortId(id), name: id })),
        defaultEffort: ReasoningEffortId(efforts[0]),
      },
    })
  }

  call(name, args) {
    const id = ToolCallId(`team-model-${++this.nextCall}`)
    const argumentsText = JSON.stringify(args)
    return [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: argumentsText },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: argumentsText } },
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]
  }

  lead(messages) {
    const userText = messages.filter(message => message.role === 'user')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text))
    if (!userText.includes('TEAM_MODEL_DELEGATE')) return textChunks('TEAM_MODEL_HISTORY_A')
    const calls = toolCalls(messages)
    const discoveries = calls.filter(call => call.name === 'list_subagent_models').length
    if (discoveries === 0) return this.call('list_subagent_models', {})
    if (discoveries === 1) return this.call('list_subagent_models', { provider: providerB })
    if (discoveries === 2) return this.call('list_subagent_models', { provider: providerB, model: 'model-b' })
    const attempts = calls.filter(call => call.name === 'spawn_teammate').length
    const fresh = { name: 'retry-fresh', description: 'Use model B defaults.', prompt: 'TEAM_MODEL_FRESH', context: 'fresh' }
    if (attempts === 0) return this.call('spawn_teammate', { ...fresh, provider: providerB })
    if (attempts === 1) return this.call('spawn_teammate', { ...fresh, provider: providerB, model: 'blocked-model' })
    if (attempts === 2) return this.call('spawn_teammate', {
      ...fresh, provider: providerB, model: 'model-b', reasoning_effort: 'parent-only',
    })
    if (attempts === 3) return this.call('spawn_teammate', { ...fresh, provider: providerB, model: 'model-b' })
    if (attempts === 4) return this.call('spawn_teammate', {
      name: 'selected-fork', description: 'Use model B with inherited completed history.', prompt: 'TEAM_MODEL_FORK',
      context: 'fork', provider: providerB, model: 'model-b', reasoning_effort: 'high',
    })
    if (attempts === 5) return this.call('spawn_teammate', {
      name: 'inherited', description: 'Inherit the Lead model.', prompt: 'TEAM_MODEL_INHERITED',
    })
    const lastCall = calls.at(-1)
    if (lastCall?.name !== 'list_agents') return this.call('list_agents', {})
    const result = messages.findLast(message => message.role === 'tool' && message.toolCallId === lastCall.id)
    const roster = JSON.parse(result.content.find(block => block.type === 'text').text)
    const children = roster.filter(member => member.role !== 'lead')
    if (children.length === 3 && children.every(member => member.status === 'inactive')) {
      return textChunks('TEAM_MODEL_SELECTION_OK')
    }
    return this.call('wait_agent', { timeout_ms: 10000 })
  }

  async *stream(options) {
    const context = options.messages.findLast(message => message.source?.kind === 'runtime-context')
    const identity = context?.source.sections.find(section => section.name === 'team:identity')?.text
    if (identity === undefined) throw new Error('Team identity missing from actual LLM request')
    appendFileSync(this.capturePath, JSON.stringify({
      identity,
      provider: options.provider,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
      system: options.system,
      messages: options.messages,
      tools: options.tools,
    }) + '\n')
    const chunks = identity.startsWith('You are the Team Lead named "lead".')
      ? this.lead(options.messages)
      : textChunks('TEAM_MODEL_CHILD_OK')
    for (const chunk of chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

/** Cordis plugin name. */
export const name = 'team-model-fixture-llm'
/** LLM registry dependency. */
export const inject = ['llm']
/** Per-test request capture destination. */
export const Config = z.object({ capturePath: z.string() })

/**
 * Register the external model substitute with independent provider routes.
 * @param ctx - Loader context with the real LLM runtime.
 * @param config - Private capture path owned by the test.
 */
export function apply(ctx, config) {
  ctx.effect(() => ctx.llm.registerAdapter([providerA, providerB], new TeamModelAdapter(config.capturePath)))
}
