import { expect, it } from 'vitest'
import { nextEntry } from '../src/service.ts'
import { applyLedgerEntry, EMPTY_SCOPE } from '../src/state.ts'

it('assigns the next revision and keeps supersede chains consistent', () => {
  const first = nextEntry(EMPTY_SCOPE, {
    scope: 's',
    decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [1] }],
    supersedes: [],
  })
  expect(first.revision).toBe(1)
  const state = applyLedgerEntry(EMPTY_SCOPE, first)
  const second = nextEntry(state, { scope: 's', decisions: [], supersedes: ['d1'] })
  expect(second.revision).toBe(2)
  const after = applyLedgerEntry(state, second)
  expect(after.revision).toBe(2)
  expect(after.active).toEqual([])
})
