import { expect, it } from 'vitest'
import { applyLedgerEntry, decidedUnitIds, decisionFor, EMPTY_SCOPE, openUnits } from '../src/state.ts'
import type { LedgerEntry } from '../src/types.ts'

const catalog = ['a', 'b', 'c', 'd']

const entry = (overrides: Partial<LedgerEntry> = {}): LedgerEntry => ({
  kind: 'decide',
  scope: 's',
  revision: 1,
  decisions: [{ decisionId: 'd1', unitIds: ['a', 'b'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [7] }],
  supersedes: [],
  ...overrides,
})

it('folds decisions into the effective state and keeps the decided units out of the open set', () => {
  const state = applyLedgerEntry(EMPTY_SCOPE, entry())
  expect(state.revision).toBe(1)
  expect([...decidedUnitIds(state)]).toEqual(['a', 'b'])
  expect(openUnits(state, catalog)).toEqual(['c', 'd'])
  expect(decisionFor(state, 'a')?.decisionId).toBe('d1')
  expect(state.active[0]?.sourceEventSeqs).toEqual([7])
})

it('returns the previous reference for a stale revision', () => {
  const state = applyLedgerEntry(EMPTY_SCOPE, entry({ revision: 2 }))
  expect(applyLedgerEntry(state, entry({ revision: 2 }))).toBe(state)
})

it('supersedes a decision and reopens its units', () => {
  const state = applyLedgerEntry(EMPTY_SCOPE, entry())
  const next = applyLedgerEntry(state, entry({ revision: 2, decisions: [], supersedes: ['d1'] }))
  expect(next.revision).toBe(2)
  expect(next.active).toEqual([])
  expect(openUnits(next, catalog)).toEqual(catalog)
  expect(decisionFor(next, 'a')).toBeUndefined()
})

it('replaces a superseded decision with the newer one in the same revision', () => {
  const state = applyLedgerEntry(EMPTY_SCOPE, entry())
  const next = applyLedgerEntry(state, entry({
    revision: 2,
    supersedes: ['d1'],
    decisions: [{ decisionId: 'd2', unitIds: ['a', 'b'], disposition: 'new', targetIds: [], sourceEventSeqs: [9] }],
  }))
  expect(next.active.map(decision => decision.decisionId)).toEqual(['d2'])
  expect(next.active[0]?.disposition).toBe('new')
})
