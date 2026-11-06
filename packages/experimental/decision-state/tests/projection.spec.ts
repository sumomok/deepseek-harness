import { expect, it } from 'vitest'
import { decide, record } from './helpers.ts'
import { foldRecordData, parseRecord, RECORD_TYPE, UNKNOWN_SCOPE } from '../src/projection.ts'

const empty = { scopes: {}, corrupt: [] as string[] }

it('parses complete records and rejects malformed payloads', () => {
  expect(parseRecord(record(1, [decide('d1', ['a'])]))).toEqual(record(1, [decide('d1', ['a'])]))
  expect(parseRecord({ scope: 's', revision: 1 })).toBeUndefined()
  expect(parseRecord({ scope: '', revision: 1, active: [] })).toBeUndefined()
})

it('ignores foreign record types with the same state reference', () => {
  expect(foldRecordData(empty, 'plugin:other/record', record(1, []))).toBe(empty)
})

it('folds records per scope and marks unreadable payloads corrupt', () => {
  const once = foldRecordData(empty, RECORD_TYPE, record(1, [decide('d1', ['a'])]))
  expect(once.scopes.s?.active.map(decision => decision.decisionId)).toEqual(['d1'])
  const broken = foldRecordData(once, RECORD_TYPE, { scope: 's' })
  expect(broken.corrupt).toContain('s')
  expect(foldRecordData(once, RECORD_TYPE, 'garbage').corrupt).toContain(UNKNOWN_SCOPE)
  const repaired = foldRecordData(broken, RECORD_TYPE, record(2, [decide('d1', ['a'])]))
  expect(repaired.corrupt).toEqual([])
  expect(repaired.scopes.s?.revision).toBe(2)
})

it('marks a scope corrupt when revision order or unit uniqueness breaks', () => {
  const once = foldRecordData(empty, RECORD_TYPE, record(1, [decide('d1', ['a'])]))
  const stale = foldRecordData(once, RECORD_TYPE, record(1, [decide('d1', ['a'])]))
  expect(stale.corrupt).toContain('s')
  const conflict = foldRecordData(empty, RECORD_TYPE, record(1, [decide('d1', ['a']), decide('d2', ['a'])]))
  expect(conflict.corrupt).toContain('s')
})
