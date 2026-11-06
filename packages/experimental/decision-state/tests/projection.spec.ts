import { expect, it } from 'vitest'
import { applyEntryToProjection, parseLedgerEntry } from '../src/projection.ts'
import type { LedgerEntry } from '../src/types.ts'

const entry: LedgerEntry = {
  kind: 'decide',
  scope: 's',
  revision: 1,
  decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [4] }],
  supersedes: [],
}
const blocks = [{ type: 'text', text: JSON.stringify(entry) }]

it('parses only decision-state messages', () => {
  expect(parseLedgerEntry({ kind: 'user' }, blocks)).toBeUndefined()
  expect(parseLedgerEntry({ kind: 'decision-state' }, blocks)).toEqual(entry)
  expect(parseLedgerEntry({ kind: 'decision-state' }, [{ type: 'text', text: '{}' }])).toBeUndefined()
  expect(parseLedgerEntry({ kind: 'decision-state' }, [{ type: 'text', text: 'not json' }])).toBeUndefined()
})

it('folds entries per scope and returns the previous state for a stale revision', () => {
  const empty = { scopes: {} }
  const once = applyEntryToProjection(empty, entry)
  expect(once.scopes.s?.active.map(decision => decision.decisionId)).toEqual(['d1'])
  expect(applyEntryToProjection(once, entry)).toBe(once)
  const other = applyEntryToProjection(once, { ...entry, scope: 't' })
  expect(other.scopes.s).toBe(once.scopes.s)
  expect(other.scopes.t?.revision).toBe(1)
})
