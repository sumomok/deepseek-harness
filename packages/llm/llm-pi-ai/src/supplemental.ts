/**
 * Providers and models this deployment can reach that the installed pi-ai
 * catalog does not describe. An entry lands here when the upstream service is
 * published and its endpoint works, but no pi-ai release ships it yet: routing
 * it otherwise would mean every user hand-declaring the same profile.
 *
 * The tables are defaults beneath configuration, never overrides. A profile
 * field wins over its supplemental counterpart, an explicit `models` list
 * replaces the route's default model set entirely, and the installed catalog
 * wins every id it already describes. An entry is removed once the catalog
 * ships it; until then it is the only place these facts live.
 *
 * @module dsh-llm-pi-ai/supplemental
 */

import type { Transport } from '@earendil-works/pi-ai'
import type { PiAiCompatProfile, PiAiModelProfile } from './catalog.ts'

/**
 * Provider facts supplied for a route the installed catalog does not ship.
 * The fields are the ones a route needs before anyone configures it: a name,
 * the protocol, the endpoint, and the compatibility switches pi-ai cannot
 * detect for an endpoint it does not recognize.
 */
export interface SupplementalProvider {
  /** Name shown by configuration surfaces and selectors. */
  displayName: string
  /** Wire protocol every model on the route speaks; one of `supportedProtocols()`. */
  api: string
  /** Endpoint every model on the route uses until a profile repoints it. */
  baseURL: string
  /** Streaming transport preference; absent leaves pi-ai's own choice. */
  transport?: Transport
  /**
   * Wire-compatibility switches for the endpoint. A profile's own switches
   * win field by field; on a route repointed to another protocol, only the
   * switches that protocol takes are applied.
   */
  compat?: PiAiCompatProfile
}

/**
 * Providers the installed catalog does not ship, keyed by route.
 *
 * `ollama` serves the Ollama OpenAI-compatible endpoint. Its compatible layer
 * rejects `store`, the `developer` role, and strict tool schemas, and reads
 * the output cap from `max_tokens`.
 */
const PROVIDERS: Readonly<Record<string, SupplementalProvider>> = {
  ollama: {
    displayName: 'Ollama',
    api: 'openai-completions',
    baseURL: 'https://ollama.com/v1',
    transport: 'sse',
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
    },
  },
}

/**
 * Models added to a route's default model set, keyed by route. Each entry is
 * served as though the installed catalog described it: a profile with no
 * `models` list gets it in addition to the catalog's models, and an explicit
 * `models` list replaces the whole default set, including these entries.
 */
const MODELS: Readonly<Record<string, readonly PiAiModelProfile[]>> = {
  ollama: [
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1_048_576,
      input: ['text'],
    },
    {
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_048_576,
      input: ['text', 'image'],
    },
    {
      id: 'kimi-k3',
      name: 'Kimi K3',
      contextWindow: 1_048_576,
      input: ['text', 'image'],
    },
    {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      contextWindow: 262_144,
      input: ['text', 'image'],
    },
    {
      id: 'glm-5.3',
      name: 'GLM-5.3',
      contextWindow: 1_048_576,
      input: ['text'],
    },
    {
      id: 'glm-5.3-flash',
      name: 'GLM-5.3 Flash',
      contextWindow: 1_048_576,
      input: ['text', 'image'],
    },
    {
      id: 'minimax-m3',
      name: 'MiniMax M3',
      contextWindow: 524_288,
      input: ['text', 'image'],
    },
    {
      id: 'mistral-large-4',
      name: 'Mistral Large 4',
      contextWindow: 1_048_576,
      input: ['text', 'image'],
    },
  ],
  'kimi-coding': [
    {
      id: 'k3.1-pro',
      name: 'Kimi K3.1 Pro',
      contextWindow: 1_048_576,
      maxTokens: 131_072,
      input: ['text', 'image'],
      reasoningEfforts: {
        low: 'low',
        high: 'high',
        max: 'max',
      },
      // The Kimi coding endpoint rejects the developer role and the store
      // parameter; the catalog declares both for k3, and this model is not in
      // the catalog, so they are stated here.
      compat: {
        supportsDeveloperRole: false,
        supportsStore: false,
      },
    },
  ],
}

/**
 * Every provider route with supplemental facts.
 * @returns the route keys, in declaration order.
 */
export function supplementalProviderIds(): readonly string[] {
  return Object.keys(PROVIDERS)
}

/**
 * The supplemental facts for one route, whether or not the installed catalog
 * also ships it; deciding which layer wins belongs to the caller.
 * @param provider - provider route key.
 * @returns the facts, or `undefined` for a route no table names.
 */
export function supplementalProvider(provider: string): SupplementalProvider | undefined {
  return PROVIDERS[provider]
}

/**
 * The supplemental model defaults for one route.
 * @param provider - provider route key.
 * @returns the model entries in table order; empty for a route no table names.
 */
export function supplementalModels(provider: string): readonly PiAiModelProfile[] {
  return MODELS[provider] ?? []
}
