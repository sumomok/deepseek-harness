/**
 * The upgrade path the supplemental table relies on: once an installed pi-ai
 * release ships a route or model the table also lists, the catalog's entry
 * serves and the table's entry is ignored. Replacing the catalog at the pi-ai
 * boundary is the only way to exercise that state against a fixed dependency.
 */
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'

vi.mock('@earendil-works/pi-ai/providers/all', () => {
  const kimiModels = [{
    id: 'k3.1-pro',
    name: 'Catalog K3.1 Pro',
    api: 'openai-completions',
    baseUrl: 'https://catalog.test/v1',
    provider: 'kimi-coding',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 4096,
    maxTokens: 2048,
  }]
  return {
    builtinProviders: () => [
      { id: 'kimi-coding', baseUrl: 'https://catalog.test/v1', auth: {} },
      { id: 'ollama', baseUrl: 'https://catalog.test/ollama/v1', auth: {} },
    ],
    getBuiltinModels: (provider: string) => provider === 'kimi-coding' ? kimiModels : [],
    getAllBuiltinModels: (provider: string) => provider === 'kimi-coding' ? kimiModels : [],
  }
})

import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { resolveRouteModels } from '../src/catalog.ts'

describe('installed catalog priority', () => {
  it('keeps a catalog model the supplemental table also lists', () => {
    const { models, configuredMaxTokens } = resolveRouteModels({
      provider: 'kimi-coding',
      defaultContextWindow: 1_000_000,
      defaultMaxTokens: 128_000,
      defaultInput: ['text'],
    })

    // The catalog's entry serves once, under its own name and capacities; the
    // supplemental entry adds neither a duplicate nor its reasoning levels.
    expect(models.map(model => model.id)).toEqual(['k3.1-pro'])
    expect(models[0]).toMatchObject({
      name: 'Catalog K3.1 Pro',
      api: 'openai-completions',
      baseUrl: 'https://catalog.test/v1',
      contextWindow: 4096,
      maxTokens: 2048,
      input: ['text'],
      reasoning: false,
    })
    expect(configuredMaxTokens.size).toBe(0)
  })

  it('lists the route as a catalog route once the catalog ships it', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {})

    const entries = ctx.llm.listConfigurableProviders().filter(entry => entry.provider === 'ollama')
    expect(entries).toHaveLength(1)
    // One entry, described by the catalog: the supplemental display name and
    // endpoint stop applying the moment pi-ai describes the route itself.
    expect(entries[0]).toMatchObject({
      displayName: 'ollama',
      declared: false,
      defaultBaseURL: 'https://catalog.test/ollama/v1',
    })
  })
})
