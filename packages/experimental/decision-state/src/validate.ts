/**
 * Submission validation and assembly.
 *
 * The model may only settle open units. The host rejects submissions that
 * touch a decided unit, skip an open unit, or leave a `new` unit outside every
 * task, and merges the effective decisions back into the delivered proposal.
 *
 * @module @deepseek-ai/dsh-decision-state/validate
 */

import { decisionFor, openUnits } from './state.ts'
import { DISPOSITIONS, type Decision, type Disposition, type ScopeState } from './types.ts'

/** One unit disposition written by the model. */
export interface SubmissionDisposition {
  readonly unitId: string
  readonly disposition: Disposition
  readonly targetIds?: readonly string[]
}

/** One task grouping written by the model. */
export interface SubmissionTask {
  readonly id: string
  readonly title: string
  readonly unitIds: readonly string[]
}

/** A model submission for one scope revision. */
export interface Submission {
  readonly scope: string
  readonly revision: number
  readonly dispositions: readonly SubmissionDisposition[]
  readonly tasks: readonly SubmissionTask[]
}

/** Structured validation failure. */
export interface ValidationError {
  readonly code:
    | 'revision-stale'
    | 'unit-unknown'
    | 'unit-decided'
    | 'unit-missing'
    | 'unit-duplicate'
    | 'disposition-invalid'
    | 'target-missing'
    | 'task-id-invalid'
    | 'task-title-invalid'
    | 'task-unit-unknown'
    | 'task-unit-decided'
    | 'task-unit-duplicate'
    | 'new-unit-uncovered'
  readonly detail: string
}

/** Merged proposal the host delivers after accepting a submission. */
export interface AssembledProposal {
  readonly scope: string
  readonly revision: number
  readonly dispositions: readonly SubmissionDisposition[]
  readonly tasks: readonly SubmissionTask[]
}

const isPresent = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0

/**
 * Validate one submission against the effective state.
 * @param submission - model output.
 * @param state - effective scope state.
 * @param catalog - every unit of the scope, in product order.
 * @returns `{ ok: true }` or the collected errors.
 */
export function validateSubmission(
  submission: Submission,
  state: ScopeState,
  catalog: readonly string[],
): { ok: true } | { ok: false; errors: readonly ValidationError[] } {
  const errors: ValidationError[] = []
  const known = new Set(catalog)
  if (submission.revision !== state.revision) {
    errors.push({ code: 'revision-stale', detail: `submitted ${submission.revision}, current ${state.revision}` })
  }
  const seen = new Set<string>()
  for (const entry of submission.dispositions) {
    if (!known.has(entry.unitId)) { errors.push({ code: 'unit-unknown', detail: entry.unitId }); continue }
    if (decisionFor(state, entry.unitId) !== undefined) { errors.push({ code: 'unit-decided', detail: entry.unitId }); continue }
    if (seen.has(entry.unitId)) errors.push({ code: 'unit-duplicate', detail: entry.unitId })
    seen.add(entry.unitId)
    if (!DISPOSITIONS.includes(entry.disposition)) errors.push({ code: 'disposition-invalid', detail: `${entry.unitId}:${String(entry.disposition)}` })
    if (entry.disposition === 'existing' && !(entry.targetIds ?? []).some(isPresent)) errors.push({ code: 'target-missing', detail: entry.unitId })
  }
  for (const unitId of openUnits(state, catalog)) {
    if (!seen.has(unitId)) errors.push({ code: 'unit-missing', detail: unitId })
  }
  const taskUnits = new Set<string>()
  const taskIds = new Set<string>()
  for (const task of submission.tasks) {
    if (!isPresent(task.id)) errors.push({ code: 'task-id-invalid', detail: JSON.stringify(task.id) })
    else if (taskIds.has(task.id)) errors.push({ code: 'task-id-invalid', detail: `duplicate ${task.id}` })
    else taskIds.add(task.id)
    if (!isPresent(task.title)) errors.push({ code: 'task-title-invalid', detail: task.id })
    const inTask = new Set<string>()
    for (const unitId of task.unitIds) {
      if (!known.has(unitId)) { errors.push({ code: 'task-unit-unknown', detail: unitId }); continue }
      if (decisionFor(state, unitId) !== undefined) { errors.push({ code: 'task-unit-decided', detail: unitId }); continue }
      if (inTask.has(unitId)) errors.push({ code: 'task-unit-duplicate', detail: `${task.id}:${unitId}` })
      inTask.add(unitId)
      taskUnits.add(unitId)
    }
  }
  for (const entry of submission.dispositions) {
    if (entry.disposition === 'new' && known.has(entry.unitId) && !taskUnits.has(entry.unitId)) {
      errors.push({ code: 'new-unit-uncovered', detail: entry.unitId })
    }
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors }
}

/**
 * Merge effective decisions into the delivered proposal.
 * @param state - effective scope state.
 * @param submission - accepted submission.
 * @returns dispositions of decided units first, then the accepted open ones.
 */
export function assemble(state: ScopeState, submission: Submission): AssembledProposal {
  const decided: SubmissionDisposition[] = state.active.flatMap(decision => decision.unitIds.map(unitId => ({
    unitId,
    disposition: decision.disposition,
    ...(decision.targetIds.length === 0 ? {} : { targetIds: decision.targetIds }),
  })))
  return {
    scope: submission.scope,
    revision: submission.revision,
    dispositions: [...decided, ...submission.dispositions],
    tasks: submission.tasks,
  }
}

/**
 * Render the bounded decision view shown to the model.
 * @param state - effective scope state.
 * @param catalog - every unit of the scope, in product order.
 * @param limit - maximum decided rows rendered.
 * @returns one line per decision plus an omission count; empty when nothing is decided.
 */
export function renderView(state: ScopeState, catalog: readonly string[], limit = 40): string {
  const decisions = state.active.slice(0, limit)
  if (decisions.length === 0) return ''
  const lines = decisions.map((decision: Decision) => {
    const targets = decision.targetIds.length === 0 ? '' : ` → ${decision.targetIds.join(', ')}`
    return `- ${decision.unitIds.join('、')}: ${decision.disposition}${targets}`
  })
  const omitted = state.active.length - decisions.length
  const tail = omitted === 0 ? '' : `\n… 另有 ${omitted} 条已定决定未展开（revision ${state.revision}）；完整状态按 ID 读取。`
  return `已定决定（不可改写，revision ${state.revision}）：\n${lines.join('\n')}${tail}\n其余 ${openUnits(state, catalog).length} 个单元待处置。`
}
