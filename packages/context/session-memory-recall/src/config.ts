/**
 * Configuration for automatic same-workspace prior-Session recall.
 *
 * @module @deepseek-ai/dsh-session-memory-recall/config
 */

import z from '@deepseek-ai/schemastery'

/** Default UTF-8 byte cap for one injected recall message. */
export const DEFAULT_MAX_BYTES = 4096

/** Default number of recalled Session excerpts. */
export const DEFAULT_MAX_HITS = 3

/** Default search deadline in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 200

/** Default minimum trimmed query length. */
export const DEFAULT_MIN_QUERY_CHARS = 3

/** User-facing configuration for automatic prior-Session recall. */
export interface Config {
  /** Enable automatic recall. Defaults to false so mounting is inert. */
  enabled?: boolean
  /** UTF-8 byte cap for the injected message. Defaults to 4096. */
  maxBytes?: number
  /** Maximum recalled Session excerpts, 1-5. Defaults to 3. */
  maxHits?: number
  /** Search deadline in milliseconds; 0 disables searching. Defaults to 200. */
  timeoutMs?: number
  /** Minimum trimmed user-query length. Defaults to 3. */
  minQueryChars?: number
  /** Include subagent-origin Sessions. Defaults to false. */
  includeSubagents?: boolean
  /** Include parent/child/fork lineage Sessions. Defaults to false. */
  includeLineage?: boolean
}

/** Validated immutable recall configuration. */
export interface ResolvedConfig {
  readonly enabled: boolean
  readonly maxBytes: number
  readonly maxHits: number
  readonly timeoutMs: number
  readonly minQueryChars: number
  readonly includeSubagents: boolean
  readonly includeLineage: boolean
}

/** Schemastery schema for the plugin configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  maxBytes: z.number().step(1).min(1).max(65_536).default(DEFAULT_MAX_BYTES),
  maxHits: z.number().step(1).min(1).max(5).default(DEFAULT_MAX_HITS),
  timeoutMs: z.number().step(1).min(0).max(5_000).default(DEFAULT_TIMEOUT_MS),
  minQueryChars: z.number().step(1).min(1).max(1_000).default(DEFAULT_MIN_QUERY_CHARS),
  includeSubagents: z.boolean().default(false),
  includeLineage: z.boolean().default(false),
})

/**
 * Resolve defaults into a detached immutable configuration.
 * @param config - untrusted plugin configuration.
 * @returns validated recall configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return Object.freeze({
    enabled: config.enabled ?? false,
    maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
    maxHits: config.maxHits ?? DEFAULT_MAX_HITS,
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    minQueryChars: config.minQueryChars ?? DEFAULT_MIN_QUERY_CHARS,
    includeSubagents: config.includeSubagents ?? false,
    includeLineage: config.includeLineage ?? false,
  })
}
