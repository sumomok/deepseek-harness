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
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { noImageRouteRefusal, UNRESOLVED_ROUTE_REFUSAL } from './text.ts'
import {
  DECLINE_DESCRIPTION, DECLINE_LABEL, distinctRouteLabel, MODEL_SWITCH_DETAIL, MODEL_SWITCH_HEADER,
  MODEL_SWITCH_QUESTION, routeLabel,
} from './switch-text.ts'

/** The modality this read needs the session's route to declare. */
const IMAGE_MODALITY = 'image'

/** The card's own id, echoed back on the answer. */
const MODEL_SWITCH_QUESTION_ID = 'content-image-model'

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
  /**
   * Every provider route with a registered adapter.
   * @returns those routes, in registration order.
   */
  readonly listProviders: () => readonly { id: string; name: string }[]
  /**
   * What one provider says it has. Catalog membership is the deployment's own
   * claim, which is exactly what a card offering a change needs.
   * @param provider - the registered provider route to list.
   * @returns that provider's models, in adapter-preferred order.
   */
  readonly listModels: (
    provider: string,
  ) => Promise<readonly { id: string; name: string; inputModalities?: readonly string[] }[]>
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

/** One route the card could offer, before it has a label. */
export interface CandidateRoute extends RouteChoice {
  /** The provider's own display name. */
  readonly providerName: string
  /** The model's own display name. */
  readonly modelName: string
}

/** One route the card does offer, under the label its answer comes back as. */
export interface LabelledRoute extends RouteChoice {
  /** The option label, which is this route's identity in the answer. */
  readonly label: string
}

/**
 * Every configured route that declares image input.
 *
 * The catalogue is the deployment's own claim about what it has, which is what
 * a card offering a change needs; whether a route accepts a request is settled
 * by the host when the change is made. A provider whose catalogue cannot be
 * read is left out and the rest of the card stands, the way the session
 * controller's own catalogue isolates one provider's failure.
 * @param llm - the mounted LLM registry.
 * @returns the candidates, in provider registration and adapter-preferred order.
 */
export async function imageCapableRoutes(llm: RouteModalities): Promise<CandidateRoute[]> {
  const candidates: CandidateRoute[] = []
  for (const provider of llm.listProviders()) {
    let listed: readonly { id: string; name: string; inputModalities?: readonly string[] }[]
    try {
      listed = await llm.listModels(provider.id)
    } catch (_thisProvidersCatalogueCouldNotBeRead) {
      continue
    }
    for (const model of listed) {
      if (model.inputModalities?.includes(IMAGE_MODALITY) !== true) continue
      candidates.push({
        provider: provider.id,
        model: model.id,
        providerName: provider.name,
        modelName: model.name,
      })
    }
  }
  return candidates
}

/**
 * Label every candidate so no two options on one card read the same.
 *
 * A label is the identity the answer comes back as, so two options sharing one
 * would make a choice unreadable. Two candidates whose provider and model
 * display names agree carry their model id as well. A route can never read as
 * the option that changes nothing, because every route's label carries the
 * separator between the two names and that option's does not. Two provider
 * routes registered under one display name and listing one model id are the
 * case these labels cannot tell apart; the README's Known Limitations owns it.
 *
 * A display name ending in the conventional recommendation suffix is shown
 * without it and answered with it, so no candidate is lost to one.
 * @param candidates - the routes to offer, in the order the card lists them.
 * @returns the same routes, each under its label.
 */
export function optionLabels(candidates: readonly CandidateRoute[]): LabelledRoute[] {
  const seen = new Set<string>()
  const shared = new Set<string>()
  for (const candidate of candidates) {
    const label = routeLabel(candidate.providerName, candidate.modelName)
    if (seen.has(label)) shared.add(label)
    seen.add(label)
  }
  return candidates.map((candidate) => {
    const label = routeLabel(candidate.providerName, candidate.modelName)
    return {
      provider: candidate.provider,
      model: candidate.model,
      label: shared.has(label) ? distinctRouteLabel(label, candidate.model) : label,
    }
  })
}

/**
 * The card itself: one single-select question listing every route that can look
 * at pictures, and one option that changes nothing.
 *
 * No presentation intent is declared, so the console renders the generic option
 * list. The decline option is an option rather than the card's own skip control,
 * because declining is an answer to this question and skipping is a control the
 * console offers on every question.
 * @param routes - the labelled candidates to offer.
 * @returns the question to ask.
 */
export function switchQuestion(routes: readonly LabelledRoute[]): AskUserQuestionItem {
  return {
    id: MODEL_SWITCH_QUESTION_ID,
    header: MODEL_SWITCH_HEADER,
    question: MODEL_SWITCH_QUESTION,
    detail: MODEL_SWITCH_DETAIL,
    options: [
      ...routes.map(route => ({ label: route.label })),
      { label: DECLINE_LABEL, description: DECLINE_DESCRIPTION },
    ],
  }
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
