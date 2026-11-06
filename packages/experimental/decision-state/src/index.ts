/**
 * Experimental decision ledger.
 *
 * Records complete per-scope decision state as durable plugin records, folds it
 * into an effective state, validates model submissions against that state, and
 * assembles the delivered proposal from decisions plus accepted open
 * dispositions.
 *
 * @module @deepseek-ai/dsh-decision-state
 */

export {
  decidedUnitIds,
  decisionFor,
  EMPTY_SCOPE,
  foldRecord,
  openUnits,
  replaceDecisions,
  type FoldResult,
} from './state.ts'
export { assemble, renderView, validateSubmission } from './validate.ts'
export type { AssembledProposal, Submission, SubmissionDisposition, SubmissionTask, ValidationError } from './validate.ts'
export {
  decisionStateProjection,
  foldEvent,
  foldRecordData,
  parseRecord,
  RECORD_TYPE,
  UNKNOWN_SCOPE,
  type DecisionProjectionState,
} from './projection.ts'
export { DecisionStateService, type DecisionChange } from './service.ts'
export { Config, createProposeOpenWorkTool, PROPOSE_OPEN_WORK, ScopeConfig } from './tool.ts'
export { DISPOSITIONS } from './types.ts'
export type { Decision, DecisionRecord, Disposition, ScopeState } from './types.ts'
export { DecisionStateService as default } from './service.ts'
