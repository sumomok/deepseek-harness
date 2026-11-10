/** Shared child-model selection and discovery for delegation consumers. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { parentAgentOptionsForDelegation, SubagentError, type SubagentProvider } from '@deepseek-ai/dsh-subagent'
import type {} from './model-selection-settings.ts'
import {
  assertAllowedModelSelection,
  hasConfiguredLlmSelection,
  hasDelegationModelRequest,
  preflightChildLlmRoute,
  requestedAgentOptions,
  type DelegationModelRequest,
} from './model-selection.ts'

export type { DelegationModelRequest } from './model-selection.ts'
export { registerListSubagentModels } from './list-models.ts'

/** Child defaults and permission to expose model-facing route selection. */
export interface DelegationModelSelectionConfig {
  /** Whether this consumer accepts explicit provider, model, or reasoning-effort fields. */
  readonly modelSelection?: boolean
  /** Deployment-owned defaults overlaid on the delegation provider's route defaults. */
  readonly agentOptions?: AgentOptions | undefined
}

/** Inputs resolved before a consumer reserves or starts a child. */
export interface DelegationModelSelectionOptions {
  /** Calling Agent whose effective route and durable policy apply. */
  readonly parent: Agent
  /** Registered delegation backend whose identity must survive preflight. */
  readonly provider: SubagentProvider
  /** Consumer's selection permission and child defaults. */
  readonly config: DelegationModelSelectionConfig
  /** Model-facing fields, including fields submitted while selection is disabled. */
  readonly request: DelegationModelRequest
  /** Cancellation signal for route resolution and the final readiness check. */
  readonly signal: AbortSignal
}

/**
 * Resolve authorized child options without reserving or starting a child.
 * Enabled selection requires the ready subagentModelSelection settings service.
 * Explicit selections and configured routes use the live LLM adapter; failures
 * propagate unchanged. Provider replacement or cancellation rejects the result.
 * @param ctx - Consumer context carrying subagents and optional settings and LLM services.
 * @param options - Parent, backend, configured defaults, request, and cancellation.
 * @returns Child overrides, preserving omission when every layer inherits.
 */
export async function resolveDelegationModelOptions(
  ctx: Context,
  options: DelegationModelSelectionOptions,
): Promise<AgentOptions | undefined> {
  const { parent, provider, config, request, signal } = options
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const requiresRoutePreflight = hasDelegationModelRequest(request)
    || hasConfiguredLlmSelection(config.agentOptions)
  const configured = requiresRoutePreflight && provider.agentRouteDefaults !== undefined
    ? { ...provider.agentRouteDefaults, ...config.agentOptions }
    : config.agentOptions
  const requested = requestedAgentOptions(parentOptions, configured, request, config.modelSelection === true)
  const owner = ctx.get('subagentModelSelection')
  if (config.modelSelection === true && owner === undefined) {
    throw new SubagentError(
      'child model selection requires the subagentModelSelection service; mount @deepseek-ai/dsh-tool-subagent/model-selection-settings',
      'model_selection_owner_unavailable',
    )
  }
  assertAllowedModelSelection(owner?.policyFor(parent.session), parentOptions, requested, request)
  if (requiresRoutePreflight) {
    const llm = ctx.get('llm')
    if (llm === undefined) {
      throw new SubagentError('cannot resolve the selected child LLM route because the `llm` service is unavailable', 'llm_unavailable')
    }
    await preflightChildLlmRoute(llm, parentOptions, requested, signal, provider.agentRouteDefaults === undefined)
    if (ctx.subagents.getProvider(provider.name) !== provider) {
      throw new SubagentError(
        `subagent provider "${provider.name}" changed while resolving the child LLM route; retry the delegation`,
        'provider_changed',
      )
    }
  }
  signal.throwIfAborted()
  return requested
}
