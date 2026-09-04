/**
 * The route gate the picture read runs before it opens its wait.
 *
 * A stored picture is permanent and a text-only route drops the image block
 * from the request after the pixels are already on disk, so the read has to
 * decide whether a picture can reach the model at all before a browser is asked
 * to draw one. That decision needs the route the NEXT request would go to,
 * which is not one field: a selection the user just made outranks the route the
 * session's last request logged, which outranks the options the agent was
 * created with. The three tiers are the ones
 * `packages/api/session-controller/src/agent.ts` reads in `selectionFor`, in
 * that order.
 *
 * Every service this gate reads is narrowed to the methods it calls, so the
 * gate is a pure function of what a composition actually mounted and a test
 * stands one in without booting it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/model-switch
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only: `modelSelection` is the session controller's own projection key,
// and this gate's first tier is the selection that projection holds.
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller'
import { noImageRouteRefusal, UNRESOLVED_ROUTE_REFUSAL } from './text.ts'

/** The modality this read needs the session's route to declare. */
const IMAGE_MODALITY = 'image'

/** One exact route: the provider a request goes to and the model it names. */
export interface RouteChoice {
  /** The registered provider route. */
  readonly provider: string
  /** The exact model id inside it. */
  readonly model: string
}

/**
 * The one thing this gate asks of whichever LLM registry a composition mounted:
 * what an exact route declares it accepts.
 */
export interface RouteModalities {
  /**
   * Resolve one exact route's metadata.
   * @param provider - the registered provider route.
   * @param model - the exact model id.
   * @param signal - cancellation for the adapter's own lookup.
   * @returns that route's metadata; `inputModalities` is what this reads.
   */
  readonly resolveModelInfo: (
    provider: string,
    model: string,
    signal?: AbortSignal,
  ) => Promise<{ inputModalities?: readonly string[] }>
}

/**
 * The one thing this gate asks of whichever projection registry a composition
 * mounted: the model selection a user has made and no request has consumed.
 */
export interface RouteSelectionState {
  /**
   * Read the durable model-selection fold of one session.
   * @param session - the session whose selection is read.
   * @param key - always the session controller's `modelSelection` unit.
   * @returns that fold, or `undefined` where the unit is not registered.
   */
  readonly stateOf: (
    session: Session,
    key: 'modelSelection',
  ) => { readonly pending: ModelSelection | null } | undefined
}

/**
 * What this gate needs of the plugin context, each service narrowed to the one
 * thing the gate asks it. A composition without any of them is a composition
 * this gate answers for anyway — an absent service is a refusal, never a crash.
 */
export interface ModelRouteServices {
  /**
   * One mounted service, or `undefined` in a composition without it.
   * @param service - the service key.
   * @returns that service, narrowed to what this gate calls on it.
   */
  readonly get: {
    (service: 'llm'): RouteModalities | undefined
    (service: 'sessionProjections'): RouteSelectionState | undefined
  }
}

/**
 * The route this session's next request would go to.
 *
 * Read in the three tiers `selectionFor` reads, because a gate reading fewer
 * refuses a session the user has already moved: the console's model picker
 * appends a selection that no request has consumed yet, and until one does, the
 * logged header still names the route the session came from.
 * @param services - the mounted services this gate reads.
 * @param exec - the execution whose session names the route.
 * @returns that route, or `undefined` when no tier names one.
 */
export function effectiveRoute(services: ModelRouteServices, exec: ToolRunContext): RouteChoice | undefined {
  const agent = exec.agent
  if (agent === undefined) return undefined
  const picked = services.get('sessionProjections')?.stateOf(agent.session, 'modelSelection')?.pending ?? undefined
  if (picked !== undefined) return { provider: picked.provider, model: picked.model }
  const logged = agent.session.requestHeader()?.config
  if (logged !== undefined) return { provider: logged.provider, model: logged.model }
  const { provider, model } = agent.options
  return provider === undefined || model === undefined ? undefined : { provider, model }
}

/**
 * Decide whether this session's next request would carry a picture at all.
 *
 * An absent `inputModalities` is a negative answer rather than an unknown one:
 * a route that does not say it accepts images is one this read cannot use.
 * @param services - the mounted services this gate reads.
 * @param exec - the execution whose session names the route.
 * @returns the refusal, or `undefined` when the route declares image input.
 */
export async function routeGate(
  services: ModelRouteServices,
  exec: ToolRunContext,
): Promise<string | undefined> {
  const route = effectiveRoute(services, exec)
  const llm = services.get('llm')
  if (route === undefined || llm === undefined) return UNRESOLVED_ROUTE_REFUSAL
  const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
  if (active.inputModalities?.includes(IMAGE_MODALITY) === true) return undefined
  return noImageRouteRefusal(route.model)
}
