import type { Decision, DecisionRecord } from '../src/types.ts'

/** Build one decision with defaults for tests that do not care about targets. */
export const decide = (decisionId: string, unitIds: string[], extra: Partial<Decision> = {}): Decision => ({
  decisionId,
  unitIds,
  disposition: 'existing',
  targetIds: ['#1'],
  sourceEventSeqs: [1],
  ...extra,
})

/** Build one complete scope record. */
export const record = (revision: number, active: readonly Decision[], scope = 's'): DecisionRecord => ({ scope, revision, active })
