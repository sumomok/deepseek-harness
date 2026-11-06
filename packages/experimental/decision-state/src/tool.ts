/**
 * `propose_open_work` tool: the model's only writable path into a scope.
 *
 * The tool validates the submission against the effective decisions and
 * returns the host-assembled proposal, which includes every decided unit.
 *
 * @module @deepseek-ai/dsh-decision-state/tool
 */

import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { DISPOSITIONS } from './types.ts'
import { assemble, validateSubmission, type Submission } from './validate.ts'
import type { DecisionStateService } from './service.ts'

/** One scope's unit catalog, declared by the host. */
export const ScopeConfig = z.object({
  /** Every unit of the scope, in product order. */
  units: z.array(z.string().min(1)).min(1),
}).strict()

/** Deployment configuration: scopes and their catalogs. */
export const Config = z.object({
  scopes: z.record(z.string(), ScopeConfig).default({}),
}).prefault({})

/** Validated tool configuration. */
export type Config = z.infer<typeof Config>

/** Model-facing tool name. */
export const PROPOSE_OPEN_WORK = 'propose_open_work'

/**
 * Build the tool bound to one recorder.
 * @param service - recorder exposing the effective state.
 * @param config - configured scopes.
 * @returns the tool definition.
 */
export function createProposeOpenWorkTool(service: DecisionStateService, config: Config) {
  return defineTool({
    name: PROPOSE_OPEN_WORK,
    description: '提交本轮的处置方案。只能填写开放单元：已定决定不在可写范围内，提交会被拒绝。必须携带当前 revision。',
    parameters: {
      scope: { type: 'string', required: true, description: '工作范围 id。' },
      revision: { type: 'integer', required: true, description: '当前状态版本，由宿主视图给出。' },
      dispositions: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            unitId: { type: 'string', required: true, description: '开放单元 id。' },
            disposition: { type: 'string', enum: [...DISPOSITIONS], required: true, description: '该单元的处置。' },
            targetIds: { type: 'array', items: { type: 'string' }, description: 'existing 时指向的目标 id。' },
          },
        },
      },
      tasks: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '任务 id。' },
            title: { type: 'string', required: true, description: '任务标题。' },
            unitIds: { type: 'array', items: { type: 'string' }, required: true, description: '任务包含的开放单元。' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true, enum: ['accepted', 'rejected'] },
          proposal: { type: 'json' },
          errors: { type: 'json' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.status === 'accepted' ? '方案已接受，含已定单元。' : '方案被拒绝：请按 errors 修正后重新提交。' }],
    },
    execute: (args, exec) => Promise.resolve(propose(service, config, args, exec)),
  })
}

const propose = (service: DecisionStateService, config: Config, args: {
  scope: string
  revision: number
  dispositions: readonly { unitId: string; disposition: (typeof DISPOSITIONS)[number]; targetIds?: readonly string[] }[]
  tasks: readonly { id: string; title: string; unitIds: readonly string[] }[]
}, exec: ToolRunContext) => {
  const agent = exec.agent
  if (agent === undefined) throw new HarnessError('propose_open_work requires an agent', 'DECISION_NO_AGENT')
  const scope = config.scopes[args.scope]
  if (scope === undefined) throw new HarnessError(`unknown scope: ${args.scope}`, 'DECISION_UNKNOWN_SCOPE')
  const state = service.scope(agent, args.scope)
  const submission: Submission = {
    scope: args.scope,
    revision: args.revision,
    dispositions: args.dispositions.map(entry => ({ ...entry, targetIds: entry.targetIds ?? [] })),
    tasks: args.tasks,
  }
  const verdict = validateSubmission(submission, state, scope.units)
  if (!verdict.ok) {
    return { status: 'rejected' as const, errors: verdict.errors.map(error => ({ code: String(error.code), detail: error.detail })) }
  }
  exec.concludeTurn()
  const assembled = assemble(state, submission)
  return {
    status: 'accepted' as const,
    proposal: {
      scope: assembled.scope,
      revision: assembled.revision,
      dispositions: assembled.dispositions.map(entry => ({
        unitId: entry.unitId,
        disposition: entry.disposition,
        targetIds: [...(entry.targetIds ?? [])],
      })),
      tasks: assembled.tasks.map(task => ({ id: task.id, title: task.title, unitIds: [...task.unitIds] })),
    },
  }
}
