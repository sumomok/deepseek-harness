/**
 * Load-time defaults and validation for idle microcompaction.
 *
 * @module @deepseek-ai/dsh-compaction-microcompact/config
 */

import { deepFreeze } from '@deepseek-ai/dsh-util-values'

/** Deployment-tunable idle-microcompaction settings. */
export interface MicrocompactConfig {
  /** Enable the idle pass; plugins are inert until a composition opts in. */
  enabled?: boolean
  /** Minimum durable inactivity before the next pre-step may clear results. */
  minIdleSeconds?: number
  /** Newest completed tool uses always kept verbatim. */
  keepRecentToolUses?: number
  /** Clearable results required after exclusions (not including keep-recent). */
  minClearableToolUses?: number
  /** Estimated tokens the selected results must still carry. */
  clearAtLeastTokens?: number
  /** Upper bound on results cleared by one idle pass. */
  maxClearPerRun?: number
  /** Keep every errored tool result verbatim. */
  keepErrors?: boolean
  /** Permit clearing without a model-facing `session_event_read` tool. */
  allowHostOnlyReadback?: boolean
  /** Tool names never considered. */
  excludeTools?: string[]
}

/** Detached, validated defaults. */
export interface ResolvedMicrocompactConfig {
  readonly enabled: boolean
  readonly minIdleSeconds: number
  readonly keepRecentToolUses: number
  readonly minClearableToolUses: number
  readonly clearAtLeastTokens: number
  readonly maxClearPerRun: number
  readonly keepErrors: boolean
  readonly allowHostOnlyReadback: boolean
  readonly excludeTools: readonly string[]
}

/** Safe defaults; the plugin is inert unless explicitly enabled. */
export const DEFAULTS = deepFreeze({
  enabled: false,
  minIdleSeconds: 3900,
  keepRecentToolUses: 5,
  minClearableToolUses: 20,
  clearAtLeastTokens: 20_000,
  maxClearPerRun: 50,
  keepErrors: true,
  allowHostOnlyReadback: false,
  excludeTools: [] as readonly string[],
})

const CONFIG_KEYS = new Set([
  'enabled',
  'minIdleSeconds',
  'keepRecentToolUses',
  'minClearableToolUses',
  'clearAtLeastTokens',
  'maxClearPerRun',
  'keepErrors',
  'allowHostOnlyReadback',
  'excludeTools',
])

/**
 * Resolve optional settings into immutable, validated values.
 * @param config - untrusted loader configuration.
 * @returns detached configuration with every default applied.
 * @throws when a key is unknown, a number is not a non-negative integer, or a boolean is not a boolean.
 */
export function resolveConfig(config: MicrocompactConfig = {}): ResolvedMicrocompactConfig {
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`MicrocompactConfig: unknown key "${key}"`)
  }
  const enabled = config.enabled ?? DEFAULTS.enabled
  const keepErrors = config.keepErrors ?? DEFAULTS.keepErrors
  const allowHostOnlyReadback = config.allowHostOnlyReadback ?? DEFAULTS.allowHostOnlyReadback
  const minIdleSeconds = nonNegative(config.minIdleSeconds, DEFAULTS.minIdleSeconds, 'minIdleSeconds')
  const keepRecentToolUses = nonNegative(config.keepRecentToolUses, DEFAULTS.keepRecentToolUses, 'keepRecentToolUses')
  const minClearableToolUses = nonNegative(config.minClearableToolUses, DEFAULTS.minClearableToolUses, 'minClearableToolUses')
  const clearAtLeastTokens = nonNegative(config.clearAtLeastTokens, DEFAULTS.clearAtLeastTokens, 'clearAtLeastTokens')
  const maxClearPerRun = nonNegative(config.maxClearPerRun, DEFAULTS.maxClearPerRun, 'maxClearPerRun')
  const excludeTools = config.excludeTools ?? DEFAULTS.excludeTools
  if (typeof enabled !== 'boolean') throw new Error('MicrocompactConfig: enabled must be a boolean')
  if (typeof keepErrors !== 'boolean') throw new Error('MicrocompactConfig: keepErrors must be a boolean')
  if (typeof allowHostOnlyReadback !== 'boolean') throw new Error('MicrocompactConfig: allowHostOnlyReadback must be a boolean')
  if (!isStringArray(excludeTools)) throw new Error('MicrocompactConfig: excludeTools must be an array of strings')
  return deepFreeze({
    enabled,
    minIdleSeconds,
    keepRecentToolUses,
    minClearableToolUses,
    clearAtLeastTokens,
    maxClearPerRun,
    keepErrors,
    allowHostOnlyReadback,
    excludeTools: [...excludeTools],
  })
}

/** Narrow untrusted config to a string array without an `any` spread. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Read one non-negative integer setting. */
function nonNegative(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new Error(`MicrocompactConfig: ${name} must be a non-negative safe integer`)
  }
  return resolved
}
