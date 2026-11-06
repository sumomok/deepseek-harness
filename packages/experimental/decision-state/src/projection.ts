/**
 * Session projection folding committed decision records.
 *
 * Records are experimental plugin records, so they never enter the
 * model-visible surface and survive compaction, fork and resume. A record the
 * owner cannot validate marks its scope corrupt instead of silently reopening
 * units; a later valid record for that scope clears the mark.
 *
 * @module @deepseek-ai/dsh-decision-state/projection
 */

import { z } from 'zod'
import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { EMPTY_SCOPE, foldRecord } from './state.ts'
import type { Decision, DecisionRecord, ScopeState } from './types.ts'

/** Record type owned by this package. */
export const RECORD_TYPE = 'plugin:decision-state/record'

/** Corruption mark for a record whose payload does not name a readable scope. */
export const UNKNOWN_SCOPE = '*'

const decisionSchema = z.object({
  decisionId: z.string().min(1),
  unitIds: z.array(z.string().min(1)).min(1),
  disposition: z.enum(['new', 'existing', 'unchanged', 'defer', 'exclude']),
  targetIds: z.array(z.string().min(1)),
  sourceEventSeqs: z.array(z.number().int().nonnegative()),
}).strict()

const recordSchema = z.object({
  scope: z.string().min(1),
  revision: z.number().int().nonnegative(),
  active: z.array(decisionSchema),
}).strict()

const scopeSchema = z.object({
  revision: z.number().int().nonnegative(),
  active: z.array(decisionSchema),
}).strict()

const stateSchema = z.object({
  scopes: z.record(z.string(), scopeSchema),
  corrupt: z.array(z.string()),
}).strict()

/** Host-only projection state: effective decisions per scope plus scopes whose latest record failed validation. */
export interface DecisionProjectionState {
  readonly scopes: { readonly [scope: string]: ScopeState }
  readonly corrupt: readonly string[]
}

/**
 * Parse one committed record payload.
 * @param data - the record's committed JSON payload.
 * @returns the record, or `undefined` when the payload is not a decision record.
 */
export function parseRecord(data: unknown): DecisionRecord | undefined {
  const parsed = recordSchema.safeParse(data)
  return parsed.success ? parsed.data : undefined
}

/**
 * Fold one committed event.
 * @param state - state before the event.
 * @param event - committed Session event; non-record events leave the state unchanged.
 * @returns the next state, always the same reference when nothing changed.
 */
export function foldEvent(state: DecisionProjectionState, event: SessionEvent): DecisionProjectionState {
  const record = pluginRecordOf(event)
  return record === undefined ? state : foldRecordData(state, record.type, record.data)
}

/**
 * Fold one plugin record payload.
 * @param state - state before the record.
 * @param type - committed record type.
 * @param data - committed JSON payload.
 * @returns the next state; foreign types leave the state unchanged.
 */
export function foldRecordData(state: DecisionProjectionState, type: string, data: unknown): DecisionProjectionState {
  if (type !== RECORD_TYPE) return state
  const payload = parseRecord(data)
  if (payload === undefined) {
    const scope = typeof data === 'object' && data !== null && 'scope' in data && typeof data.scope === 'string'
      ? data.scope
      : UNKNOWN_SCOPE
    return markCorrupt(state, scope)
  }
  const previous = Object.hasOwn(state.scopes, payload.scope) ? state.scopes[payload.scope] ?? EMPTY_SCOPE : EMPTY_SCOPE
  const folded = foldRecord(previous, payload)
  if (!folded.ok) return markCorrupt(state, payload.scope)
  const scopes = { ...state.scopes, [payload.scope]: folded.state }
  const corrupt = state.corrupt.filter(scope => scope !== payload.scope)
  return { scopes, corrupt }
}

const markCorrupt = (state: DecisionProjectionState, scope: string): DecisionProjectionState =>
  state.corrupt.includes(scope) ? state : { scopes: state.scopes, corrupt: [...state.corrupt, scope] }

/** Effective decisions per scope, folded from the Session log. */
export const decisionStateProjection: ProjectionDefinition<'decisionState', DecisionProjectionState> = {
  key: 'decisionState',
  stateVersion: 1,
  stateSchema,
  init: () => ({ scopes: {}, corrupt: [] }),
  apply: (state, event) => foldEvent(state, event),
}

/** Effective decisions of one scope. */
export type { Decision, ScopeState }
