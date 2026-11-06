import { expect, it } from 'vitest'
import { applyLedgerEntry, EMPTY_SCOPE } from '../src/state.ts'
import type { LedgerEntry } from '../src/types.ts'
import { assemble, renderView, validateSubmission, type Submission } from '../src/validate.ts'

const catalog = ['a', 'b', 'c', 'd']
const decided: LedgerEntry = {
  kind: 'decide',
  scope: 's',
  revision: 1,
  decisions: [{ decisionId: 'd1', unitIds: ['a'], disposition: 'existing', targetIds: ['#1'], sourceEventSeqs: [3] }],
  supersedes: [],
}
const state = applyLedgerEntry(EMPTY_SCOPE, decided)

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
  expect(proposal.revision).toBe(1)
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

it('renders a bounded view with an omission count', () => {
  const many = applyLedgerEntry(EMPTY_SCOPE, {
    kind: 'decide', scope: 's', revision: 1, supersedes: [],
    decisions: Array.from({ length: 3 }, (_, index) => ({ decisionId: `d${index}`, unitIds: ['#{index}'], disposition: 'existing' as const, targetIds: [`#${index}`], sourceEventSeqs: [1] })),
  })
  const view = renderView(many, catalog, 2)
  expect(view).toContain('revision 1')
  expect(view).toContain('另有 1 条')
  expect(view).toContain('其余 4 个单元待处置')
  expect(renderView(EMPTY_SCOPE, catalog)).toBe('')
})
