/**
 * Experimental decision ledger.
 *
 * Records versioned decisions as durable Session messages, folds them into an
 * effective state, validates model submissions against it, and assembles the
 * delivered proposal from decisions plus accepted open dispositions.
 *
 * @module @deepseek-ai/dsh-decision-state
 */

export { applyLedgerEntry, decidedUnitIds, decisionFor, EMPTY_SCOPE, openUnits } from './state.ts'
export { assemble, renderView, validateSubmission } from './validate.ts'
export type { AssembledProposal, Submission, SubmissionDisposition, SubmissionTask, ValidationError } from './validate.ts'
export {
  decisionStateProjection,
  applyEntryToProjection,
  parseLedgerEntry,
  type DecisionProjectionState,
} from './projection.ts'
export { DecisionStateService, nextEntry, type DecisionChange } from './service.ts'
export { Config, createProposeOpenWorkTool, PROPOSE_OPEN_WORK, ScopeConfig } from './tool.ts'
export { DISPOSITIONS } from './types.ts'
export type { Decision, Disposition, LedgerEntry, ScopeState } from './types.ts'
