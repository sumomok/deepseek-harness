/**
 * The supplemental table: providers and models this package serves ahead of
 * the installed pi-ai catalog, and the precedence that keeps configuration in
 * charge of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { catalogModels } from '../src/catalog.ts'
import { resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '../src/config.ts'
import { supplementalModels, supplementalProvider, supplementalProviderIds } from '../src/supplemental.ts'

// Routes name their credential by reference; the value lives in the
// environment. A named reference that misses makes the route list no models,
// so the case that resolves a stored credential needs one present.
beforeEach(() => {
  vi.stubEnv('OLLAMA_API_KEY', 'test-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

/** Mount the adapter over an empty catalog composition, with optional profiles. */
async function boot(config: LlmPiAi.Options = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(LlmPiAi, config)
  return ctx
}

/** Resolve one configured route. */
function resolved(provider: string, configured: PiAiProviderProfile): ResolvedPiAiProviderProfile {
  const profile = resolveProfiles({ [provider]: configured }).get(provider)
  if (profile === undefined) throw new Error(`provider "${provider}" did not resolve`)
  return profile
}

/** The model ids one resolved route serves. */
function modelIds(profile: ResolvedPiAiProviderProfile): string[] {
  return profile.piProvider?.getModels().map(model => model.id) ?? []
}

describe('supplemental provider directory', () => {
  it('offers the route a settings surface can configure before it is declared', async () => {
    const ctx = await boot()
    const directory = ctx.llm.listConfigurableProviders()

    expect(directory).toContainEqual({
      provider: 'ollama',
      displayName: 'Ollama',
      settingsNs: 'llm-pi-ai',
      settingsPath: ['providers', 'ollama'],
      // pi-ai ships nothing under this key, which is what a configuration
      // surface marks as a route this package supplies rather than the catalog.
      declared: true,
      defaultBaseURL: 'https://ollama.com/v1',
    })
    // A card is not a live route: nothing registers until a profile supplies a
    // credential, so a model selector cannot offer a route that cannot
    // authenticate.
    expect(ctx.llm.listProviders()).toEqual([])
  })

  it('registers the route once a profile supplies only a credential', async () => {
    const ctx = await boot({ providers: { ollama: { apiKeyEnv: 'OLLAMA_API_KEY' } } })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['ollama'])
    // The endpoint, protocol, and models all come from the supplemental table.
    expect((await ctx.llm.listModels('ollama')).map(model => model.id)).toEqual([
      'deepseek-v4-pro',
      'deepseek-v4.1-flash',
      'kimi-k3',
      'kimi-k2.7-code',
      'glm-5.3',
      'glm-5.3-flash',
      'minimax-m3',
      'mistral-large-4',
    ])
    expect(ctx.llm.listConfigurableProviders().find(entry => entry.provider === 'ollama')).toMatchObject({
      declared: true,
      displayName: 'Ollama',
      defaultBaseURL: 'https://ollama.com/v1',
    })
  })
})

describe('supplemental model defaults', () => {
  it('serves the catalog plus the supplemental model without configuration', () => {
    const profile = resolved('kimi-coding', { apiKeyEnv: 'KIMI_CODING_API_KEY' })
    const catalogIds = [...catalogModels('kimi-coding').keys()]

    expect(modelIds(profile)).toEqual([...catalogIds, 'k3.1-pro'])
    expect(profile.piProvider?.getModels().find(model => model.id === 'k3.1-pro')).toMatchObject({
      name: 'Kimi K3.1 Pro',
      provider: 'kimi-coding',
      api: 'openai-completions',
      baseUrl: 'https://api.kimi.com/coding/v1',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ['text', 'image'],
      reasoning: true,
      thinkingLevelMap: { low: 'low', high: 'high', max: 'max', medium: null },
    })
  })

  it('keeps a supplemental capacity a capability rather than a request cap', () => {
    const profile = resolved('kimi-coding', { apiKeyEnv: 'KIMI_CODING_API_KEY' })

    // `maxTokens` sizes what the model can emit. Only a profile that names a
    // cap asks every request to be limited by it.
    expect(profile.configuredMaxTokens.has('k3.1-pro')).toBe(false)
  })

  it('lets an explicit models list replace the supplemental model set', () => {
    expect(modelIds(resolved('kimi-coding', { models: [{ id: 'k3' }] }))).toEqual(['k3'])
  })

  it('inherits the supplement for a supplemental id an explicit list names', () => {
    const profile = resolved('kimi-coding', { models: [{ id: 'k3.1-pro' }] })

    expect(modelIds(profile)).toEqual(['k3.1-pro'])
    expect(profile.piProvider?.getModels()[0]).toMatchObject({
      name: 'Kimi K3.1 Pro',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ['text', 'image'],
      reasoning: true,
    })
  })
})

describe('explicit provider profiles over supplemental defaults', () => {
  it('wins field by field while the unset fields keep the supplement', () => {
    const profile = resolved('ollama', {
      displayName: 'Local Ollama',
      baseURL: 'http://127.0.0.1:11434/v1',
      transport: 'auto',
      models: [{ id: 'local-only', name: 'Local Only', contextWindow: 8192 }],
    })

    expect(profile).toMatchObject({
      displayName: 'Local Ollama',
      api: 'openai-completions',
      baseURL: 'http://127.0.0.1:11434/v1',
      transport: 'auto',
    })
    expect(modelIds(profile)).toEqual(['local-only'])
    // The endpoint moved, but the compatibility switches the table declares
    // for Ollama's compatible layer still apply until a profile sets its own.
    expect(profile.piProvider?.getModels()[0]?.compat).toMatchObject({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    })
  })

  it('keeps the developer role off the Kimi coding endpoint for the supplemental model', () => {
    // Kimi's coding endpoint answers `role 'developer' is not allowed` with a
    // 400. The catalog states that switch for its own k3 models; k3.1-pro is
    // not in the catalog, so the table has to state it or every request on
    // this route fails.
    const profile = resolved('kimi-coding', { apiKeyEnv: 'KIMI_CODING_API_KEY' })
    const model = profile.piProvider?.getModels().find(entry => entry.id === 'k3.1-pro')

    expect(model?.compat).toMatchObject({
      supportsDeveloperRole: false,
      supportsStore: false,
    })
  })

  it('lets a profile switch win over the supplemental value for that field', () => {
    const profile = resolved('ollama', {
      compat: { supportsReasoningEffort: true },
      models: [{ id: 'local-only', name: 'Local Only', contextWindow: 8192 }],
    })

    expect(profile.piProvider?.getModels()[0]?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    })
  })

  it('keeps only the switches a repointed protocol takes', () => {
    const profile = resolved('ollama', {
      api: 'anthropic-messages',
      baseURL: 'https://shim.test/v1',
      models: [{ id: 'shim-model', name: 'Shim', contextWindow: 8192, maxTokens: 1024 }],
    })

    // The supplemental switches describe an OpenAI-compatible endpoint; a
    // route pointed at another protocol must not carry them as if applied.
    expect(modelIds(profile)).toEqual(['shim-model'])
    expect(profile.piProvider?.getModels()[0]?.api).toBe('anthropic-messages')
    expect(profile.piProvider?.getModels()[0]?.compat).toBeUndefined()
  })
})

describe('supplemental table', () => {
  it('resolves every entry from its declaration alone', () => {
    for (const provider of supplementalProviderIds()) {
      const facts = supplementalProvider(provider)
      expect(facts).toBeDefined()
      expect(LlmPiAi.supportedProtocols()).toContain(facts?.api)
      const profile = resolved(provider, {})
      expect(profile.modelErrors.size).toBe(0)
      const served = modelIds(profile)
      const supplementalIds = supplementalModels(provider).map(entry => entry.id)
      expect(new Set(supplementalIds).size).toBe(supplementalIds.length)
      for (const id of supplementalIds) expect(served).toContain(id)
    }
  })

  it('answers nothing for a route no table names', () => {
    expect(supplementalProvider('no-such-provider')).toBeUndefined()
    expect(supplementalModels('no-such-provider')).toEqual([])
  })
})
