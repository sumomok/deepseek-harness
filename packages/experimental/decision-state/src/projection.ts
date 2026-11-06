/**
 * Session projection folding the durable decision ledger.
 *
 * Entries arrive as `user/message` events whose source kind is `decision-state`;
 * the fold parses each message, applies it to the scope state, and otherwise
 * returns the previous reference so unrelated events cost nothing.
 *
 * @module @deepseek-ai/dsh-decision-state/projection
 */

import { z } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { applyLedgerEntry, EMPTY_SCOPE } from './state.ts'
import type { Decision, LedgerEntry, ScopeState } from './types.ts'

const decisionSchema = z.object({
  decisionId: z.string().min(1),
  unitIds: z.array(z.string().min(1)).min(1),
  disposition: z.enum(['new', 'existing', 'unchanged', 'defer', 'exclude']),
  targetIds: z.array(z.string().min(1)),
  sourceEventSeqs: z.array(z.number().int().nonnegative()),
}).strict()

const entrySchema = z.object({
  kind: z.literal('decide'),
  scope: z.string().min(1),
  revision: z.number().int().nonnegative(),
  decisions: z.array(decisionSchema),
  supersedes: z.array(z.string().min(1)),
}).strict()

const scopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  active: z.array(decisionSchema),
}).strict()

const stateSchema = z.object({ scopes: z.record(z.string(), scopeSchema) }).strict()

/** Host-only projection state: effective decisions per scope. */
export interface DecisionProjectionState {
  readonly scopes: { readonly [scope: string]: ScopeState }
}

/** Text content of one message block list. */
const textOf = (blocks: readonly { type: string; text?: string }[]): string =>
  blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')

/**
 * Parse one ledger message.
 * @param source - message source; only `decision-state` messages carry entries.
 * @param blocks - message content blocks.
 * @returns the entry, or `undefined` for foreign or malformed messages.
 */
export function parseLedgerEntry(
  source: { readonly kind: string },
  blocks: readonly { type: string; text?: string }[],
): LedgerEntry | undefined {
  if (source.kind !== 'decision-state') return undefined
  let raw: unknown
  try { raw = JSON.parse(textOf(blocks)) } catch { return undefined }
  const parsed = entrySchema.safeParse(raw)
  if (!parsed.success) return undefined
  return parsed.data
}

/**
 * Fold one message into the scope state.
 * @param state - state before the message.
 * @param entry - parsed ledger entry.
 * @returns the next state; the same reference when the entry is stale.
 */
export function applyEntryToProjection(state: DecisionProjectionState, entry: LedgerEntry): DecisionProjectionState {
  const previous: ScopeState = state.scopes[entry.scope] ?? EMPTY_SCOPE
  const next = applyLedgerEntry(previous, entry)
  if (next === previous) return state
  return { scopes: { ...state.scopes, [entry.scope]: next } }
}

/** Effective decisions per scope, folded from the Session log. */
export const decisionStateProjection: ProjectionDefinition<'decisionState', DecisionProjectionState> = {
  key: 'decisionState',
  stateVersion: 1,
  stateSchema,
  init: () => ({ scopes: {} }),
  apply: (state, event) => {
    if (event.type !== 'user/message') return state
    const entry = parseLedgerEntry(event.data.source, event.data.content)
    return entry === undefined ? state : applyEntryToProjection(state, entry)
  },
}

/** Effective decisions of one scope. */
export type { Decision, ScopeState }
