/**
 * Deterministic fold over the durable decision ledger.
 *
 * The fold is synchronous and allocation-light: entries that change nothing
 * return the previous state reference, and active decisions keep their object
 * identity across unrelated revisions.
 *
 * @module @deepseek-ai/dsh-decision-state/state
 */

import type { Decision, LedgerEntry, ScopeState } from './types.ts'

/** State before the first ledger entry of a scope. */
export const EMPTY_SCOPE: ScopeState = Object.freeze({ revision: 0, active: Object.freeze([]) as readonly Decision[] })

/**
 * Apply one ledger entry.
 * @param state - state before the entry.
 * @param entry - durable entry, in log order.
 * @returns the state after the entry; the same reference when the entry is stale.
 */
export function applyLedgerEntry(state: ScopeState, entry: LedgerEntry): ScopeState {
  if (entry.revision <= state.revision) return state
  const superseded = new Set(entry.supersedes)
  const kept = state.active.filter(decision => !superseded.has(decision.decisionId))
  const added = entry.decisions.filter(decision => !superseded.has(decision.decisionId))
  if (kept.length === state.active.length && added.length === 0) {
    return state.revision === entry.revision ? state : { revision: entry.revision, active: state.active }
  }
  return { revision: entry.revision, active: [...kept, ...added] }
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
