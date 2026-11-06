/**
 * Deterministic fold over committed decision records.
 *
 * A record carries the whole scope state, so the fold checks revision order and
 * the semantic invariants (unique decision ids, one decision per unit) instead
 * of merging deltas. A rejected record leaves the previous state untouched.
 *
 * @module @deepseek-ai/dsh-decision-state/state
 */

import type { Decision, DecisionRecord, ScopeState } from './types.ts'

/** State before the first record of a scope. */
export const EMPTY_SCOPE: ScopeState = Object.freeze({ revision: 0, active: Object.freeze([]) as readonly Decision[] })

/** Outcome of folding one record. */
export type FoldResult =
  | { readonly ok: true; readonly state: ScopeState }
  | { readonly ok: false; readonly reason: string }

/**
 * Fold one record into a scope state.
 * @param state - effective state before the record.
 * @param record - committed record carrying the complete next state.
 * @returns the next state, or the reason the record cannot be trusted.
 */
export function foldRecord(state: ScopeState, record: DecisionRecord): FoldResult {
  if (record.revision <= state.revision) return { ok: false, reason: `revision ${record.revision} not after ${state.revision}` }
  const ids = new Set<string>()
  const units = new Set<string>()
  for (const decision of record.active) {
    if (ids.has(decision.decisionId)) return { ok: false, reason: `duplicate decision ${decision.decisionId}` }
    ids.add(decision.decisionId)
    for (const unitId of decision.unitIds) {
      if (units.has(unitId)) return { ok: false, reason: `unit ${unitId} decided twice` }
      units.add(unitId)
    }
  }
  return { ok: true, state: { revision: record.revision, active: record.active } }
}

/**
 * Units settled by the scope's active decisions.
 * @param state - effective scope state.
 * @returns ids of every decided unit.
 */
export function decidedUnitIds(state: ScopeState): Set<string> {
  return new Set(state.active.flatMap(decision => decision.unitIds))
}

/**
 * Units the model may still submit.
 * @param state - effective scope state.
 * @param catalog - every unit of the scope, in product order.
 * @returns catalog order minus decided units.
 */
export function openUnits(state: ScopeState, catalog: readonly string[]): string[] {
  const decided = decidedUnitIds(state)
  return catalog.filter(unitId => !decided.has(unitId))
}

/**
 * Active decision covering a unit.
 * @param state - effective scope state.
 * @param unitId - unit to look up.
 * @returns the decision, or `undefined` when the unit is open.
 */
export function decisionFor(state: ScopeState, unitId: string): Decision | undefined {
  return state.active.find(decision => decision.unitIds.includes(unitId))
}

/**
 * Replace decisions by id, preserving the rest.
 * @param state - effective scope state.
 * @param supersedes - decision ids to drop.
 * @param additions - decisions to append after the drop.
 * @returns decisions of the next revision.
 */
export function replaceDecisions(
  state: ScopeState,
  supersedes: readonly string[],
  additions: readonly Decision[],
): readonly Decision[] {
  const dropped = new Set(supersedes)
  return [...state.active.filter(decision => !dropped.has(decision.decisionId)), ...additions]
}
