import { expect, it } from 'vitest'
import { decide, record } from './helpers.ts'
import { EMPTY_SCOPE, foldRecord } from '../src/state.ts'
import { assemble, renderView, validateSubmission, type Submission } from '../src/validate.ts'

const catalog = ['a', 'b', 'c', 'd']
const folded = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', ['a'])]))
if (!folded.ok) throw new Error(folded.reason)
const state = folded.state

const submission = (overrides: Partial<Submission> = {}): Submission => ({
  scope: 's',
  revision: 1,
  dispositions: [
    { unitId: 'b', disposition: 'new' },
    { unitId: 'c', disposition: 'new' },
    { unitId: 'd', disposition: 'defer' },
  ],
  tasks: [{ id: 't1', title: 'work', unitIds: ['b', 'c'] }],
  ...overrides,
})

const codes = (result: ReturnType<typeof validateSubmission>): string[] => result.ok ? [] : result.errors.map(error => error.code)

it('accepts a complete submission and merges the decided units into the proposal', () => {
  expect(validateSubmission(submission(), state, catalog).ok).toBe(true)
  const proposal = assemble(state, submission())
  expect(proposal.dispositions[0]).toEqual({ unitId: 'a', disposition: 'existing', targetIds: ['#1'] })
  expect(proposal.dispositions.map(entry => entry.unitId)).toEqual(['a', 'b', 'c', 'd'])
})

it('rejects a submission that rewrites a decided unit', () => {
  const result = validateSubmission(submission({ dispositions: [{ unitId: 'a', disposition: 'new' }, { unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }] }), state, catalog)
  expect(codes(result)).toContain('unit-decided')
})

it('rejects a task that dispatches a decided unit again', () => {
  const result = validateSubmission(submission({ tasks: [{ id: 't1', title: 'work', unitIds: ['a', 'b', 'c'] }] }), state, catalog)
  expect(codes(result)).toContain('task-unit-decided')
})

it('rejects a submission that skips an open unit', () => {
  const result = validateSubmission(submission({ dispositions: [{ unitId: 'b', disposition: 'new' }], tasks: [{ id: 't1', title: 'work', unitIds: ['b'] }] }), state, catalog)
  expect(codes(result)).toContain('unit-missing')
})

it('rejects a new unit that no task covers', () => {
  const result = validateSubmission(submission({ tasks: [{ id: 't1', title: 'work', unitIds: ['b'] }] }), state, catalog)
  expect(codes(result)).toContain('new-unit-uncovered')
})

it('rejects a stale revision, an unknown unit and a missing target', () => {
  expect(codes(validateSubmission(submission({ revision: 0 }), state, catalog))).toEqual(['revision-stale'])
  expect(codes(validateSubmission(submission({ dispositions: [{ unitId: 'zz', disposition: 'new' }, { unitId: 'b', disposition: 'new' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }] }), state, catalog))).toEqual(['unit-unknown'])
  expect(codes(validateSubmission(submission({ dispositions: [{ unitId: 'b', disposition: 'existing' }, { unitId: 'c', disposition: 'new' }, { unitId: 'd', disposition: 'defer' }] }), state, catalog))).toContain('target-missing')
})

it('renders revision, decided rows and open ids', () => {
  const view = renderView(state, catalog)
  expect(view).toContain('revision 1')
  expect(view).toContain('已定 1 条')
  expect(view).toContain('待处置单元：b、c、d')
})

it('renders open ids for an empty ledger and blocks a corrupt scope', () => {
  expect(renderView(EMPTY_SCOPE, catalog)).toContain('待处置单元：a、b、c、d')
  expect(renderView(state, catalog, 40, 4000, true)).toContain('校验失败')
})

it('drops decided rows before the open catalog', () => {
  const decided = Array.from({ length: 200 }, (_, index) => `u${index}`)
  const open = Array.from({ length: 100 }, (_, index) => `o${index}`)
  const wide = foldRecord(EMPTY_SCOPE, record(1, [decide('d1', decided)]))
  if (!wide.ok) throw new Error(wide.reason)
  const view = renderView(wide.state, [...decided, ...open], 200, 600)
  expect(view).toContain('待处置单元：o0')
  expect(view).toContain('o99')
  expect(view).not.toContain('- u0: existing')
})

it('keeps the open catalog inside the view budget', () => {
  const long = Array.from({ length: 4 }, (_, index) => decide(`d${index + 2}`, [`x${index}`], { targetIds: ['t'.repeat(120)] }))
  const foldedLong = foldRecord(EMPTY_SCOPE, record(1, long))
  if (!foldedLong.ok) throw new Error(foldedLong.reason)
  const text = renderView(foldedLong.state, ['x0', 'x1', 'x2', 'x3', 'b', 'c', 'd'], 40, 500)
  expect(text).toContain('待处置单元：b、c、d')
})
