import { expect, it } from 'vitest'
import { decide, record } from './helpers.ts'
import { EMPTY_SCOPE, foldRecord, openUnits, replaceDecisions } from '../src/state.ts'

const catalog = ['a', 'b', 'c', 'd']

it('folds a complete record and keeps decided units out of the open set', () => {
  const result = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', ['a', 'b'])]))
  if (!result.ok) throw new Error(result.reason)
  expect(result.state.revision).toBe(1)
  expect(openUnits(result.state, catalog)).toEqual(['c', 'd'])
})

it('rejects a record that is not newer than the current revision', () => {
  const first = foldRecord(EMPTY_SCOPE, record(2, [decide('d1', ['a'])]))
  if (!first.ok) throw new Error(first.reason)
  const stale = foldRecord(first.state, record(2, [decide('d2', ['b'])]))
  expect(stale).toEqual({ ok: false, reason: 'revision 2 not after 2' })
})

it('rejects a record that decides one unit twice', () => {
  const result = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', ['a']), decide('d2', ['a'])]))
  expect(result.ok).toBe(false)
})

it('rejects duplicate decision ids', () => {
  const result = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', ['a']), decide('d1', ['b'])]))
  expect(result.ok).toBe(false)
})

it('replaces decisions by id and keeps the rest', () => {
  const first = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', ['a']), decide('d2', ['b'])]))
  if (!first.ok) throw new Error(first.reason)
  const active = replaceDecisions(first.state, ['d1'], [decide('d3', ['a'], { disposition: 'new', targetIds: [] })])
  expect(active.map(decision => decision.decisionId)).toEqual(['d2', 'd3'])
  expect(active[1]?.disposition).toBe('new')
})
