/**
 * One provider/model resolution rule shared by pressure policy, capacity, and
 * summary requests: the newest pending model selection after the last durable
 * request header, then that header, then the AgentOptions pair.
 *
 * @module @deepseek-ai/dsh-compaction-basic/route
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** One provider/model route. */
export type RoutedTarget = Pick<LlmCallConfig, 'provider' | 'model'>

/** Extract one non-empty route from an event payload. */
function payloadRoute(value: unknown): RoutedTarget | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const provider: unknown = Reflect.get(value, 'provider')
  const model: unknown = Reflect.get(value, 'model')
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Resolve the durable provider/model of the latest logged request header.
 * @param session - session supplying the request log.
 * @returns the header route, or undefined before the first routed request.
 */
export function durableTarget(session: Session): RoutedTarget | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined) return undefined
  return payloadRoute(config)
}

/**
 * Resolve the model selection newer than the latest request header. A
 * selection at or before that header has already been consumed (or superseded)
 * by the request, so it is not pending.
 * @param session - session supplying the selection and header log.
 * @returns the pending selection route, or undefined when none is newer.
 */
export function pendingSelection(session: Session): RoutedTarget | undefined {
  let lastHeaderSeq = -1
  let selection: RoutedTarget | undefined
  let selectionSeq = -1
  for (const event of session.snapshotEvents()) {
    if (event.type === 'request/header') {
      lastHeaderSeq = event.seq
      continue
    }
    if (String(event.type) !== 'model/selection') continue
    const data: unknown = event.data
    const route = payloadRoute(data)
    if (route === undefined) continue
    selection = route
    selectionSeq = event.seq
  }
  return selectionSeq > lastHeaderSeq ? selection : undefined
}

/**
 * Route named by a durable request header or model-selection event.
 * @param event - session event to inspect.
 * @returns the route, or undefined for unrelated or malformed events.
 */
export function eventRoute(event: SessionEvent): RoutedTarget | undefined {
  if (event.type === 'request/header') return payloadRoute(event.data.header.config)
  if (String(event.type) !== 'model/selection') return undefined
  const data: unknown = event.data
  return payloadRoute(data)
}

/**
 * Resolve the pressure route for policy, capacity, and cost: the newest pending
 * selection, else the durable header. It deliberately does not fall back to
 * AgentOptions, so a session with no durable route is not compacted.
 * @param agent - agent owning the session.
 * @returns the pressure route, or undefined without a durable selection/header.
 */
export function pressureTarget(agent: Agent): RoutedTarget | undefined {
  return pendingSelection(agent.session) ?? durableTarget(agent.session)
}

/**
 * Resolve the conversation route for summary fallback and per-model config:
 * pending selection, then durable header, then the AgentOptions pair.
 * @param agent - agent owning the session and routing options.
 * @returns the route, or undefined when none is available.
 */
export function conversationTarget(agent: Agent): RoutedTarget | undefined {
  const pending = pendingSelection(agent.session)
  if (pending !== undefined) return pending
  const durable = durableTarget(agent.session)
  if (durable !== undefined) return durable
  const provider = agent.options.provider
  const model = agent.options.model
  if (provider === undefined || provider.length === 0
    || model === undefined || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Resolve the route one summary request uses: an explicitly configured
 * summarizer pair, else the conversation route (pending selection, header,
 * AgentOptions).
 * @param config - configured summarization provider/model pair.
 * @param agent - agent owning the conversation.
 * @returns the summary route, or undefined when no route resolves.
 */
export function summarizationTarget(
  config: { readonly summarizationProvider: string; readonly summarizationModel: string },
  agent: Agent,
): RoutedTarget | undefined {
  if (config.summarizationProvider.length > 0 && config.summarizationModel.length > 0) {
    return { provider: config.summarizationProvider, model: config.summarizationModel }
  }
  return conversationTarget(agent)
}
