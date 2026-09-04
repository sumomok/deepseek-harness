/**
 * The route gate the picture read runs before it opens its wait.
 *
 * A stored picture is permanent and a text-only route drops the image block
 * from the request after the pixels are already on disk, so the read has to
 * decide whether a picture can reach the model at all before a browser is asked
 * to draw one. That decision needs the route the NEXT request would go to,
 * which is not one field: a selection the user just made outranks the route the
 * session's last request logged, which outranks the options the agent was
 * created with. The first two tiers and their order are
 * `packages/api/session-controller/src/agent.ts`'s in `selectionFor`; the last
 * one is not — the controller falls back to the deployment default, which this
 * Client-face program cannot read. Nothing reaches that tier inside a tool
 * execution, because a tool call implies a request and a request logs a header.
 *
 * Every service this gate reads is narrowed to the methods it calls, so the
 * gate is a pure function of what a composition actually mounted and a test
 * stands one in without booting it.
 * @module @deepseek-ai/dsh-experimental-content-frame/access/model-switch
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
// Type-only, and from the browser-safe face rather than the host one: the
// session controller is a split package this Client-face program may only enter
// through its client half, and that half owns both the model-selection
// vocabulary and the `modelSelection` projection key this gate's first tier
// reads.
import type {
  ModelSelection, SessionSelectModelRequest, SessionSelectModelValue,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import {
  CANCELLED_REFUSAL, noImageAnywhereRefusal, noImageRouteRefusal, routeSwitchRefusal, UNRESOLVED_ROUTE_REFUSAL,
} from './text.ts'
import {
  DECLINE_DESCRIPTION, DECLINE_LABEL, distinctRouteLabel, MODEL_SWITCH_DETAIL, MODEL_SWITCH_HEADER,
  MODEL_SWITCH_QUESTION, routeLabel,
} from './switch-text.ts'

/** The modality this read needs the session's route to declare. */
const IMAGE_MODALITY = 'image'

/** The card's own id, echoed back on the answer. */
const MODEL_SWITCH_QUESTION_ID = 'content-image-model'

/** The agent a call runs for, which this gate needs whole rather than by id. */
type CallingAgent = NonNullable<ToolRunContext['agent']>

/**
 * The route decision in flight for one session, so the next one waits for it.
 *
 * A picture read declares itself safe to run beside its siblings, so two of
 * them in one step reach this gate at once. Undecided, both would find the same
 * text-only route and both would put a card up. Serialized, the second one runs
 * after the first has changed the model and reads that change as its own first
 * tier, so it passes without asking anything.
 *
 * Keyed weakly, and never held past the decision: what it orders is this
 * package's own route decision and nothing else.
 */
const decisions = new WeakMap<Session, Promise<unknown>>()

/**
 * The sessions whose user has already answered one of these cards with
 * anything other than a route.
 *
 * A refused read is one the model may retry, and a card put up again on every
 * retry is a person answering the same question until the turn is cancelled.
 * The mark suppresses the card only: a session whose user later changes the
 * model in the console passes this gate at its first step, mark or no mark.
 * It lives as long as the process does, so a reloaded session is asked once
 * more.
 *
 * Only a decision is recorded here. A card nobody was there to answer, or one
 * whose channel broke while it stood, leaves no mark and is put up again by the
 * next read — a console with no tab open, and a tab reloaded mid-card, must not
 * cost the user the offer for the rest of the process.
 */
const declined = new WeakSet<Session>()

/**
 * The `UserQuestionError` codes that end a card as a decision: the user closed
 * it, and a delegated child agent that can never reach a human of its own.
 * Every other rejection says nothing about what the user wants — a caller the
 * registry no longer holds, a transport that dropped, an answerer that threw,
 * and `NO_PROVIDER`, which reports that no console was connected at that
 * moment rather than that anyone declined.
 */
const DECIDED_CODES: ReadonlySet<string> = new Set(['ASK_CANCELLED', 'DELEGATED_CALLER'])

/**
 * Whether one rejection from the card settles the question for this session.
 *
 * The value is read structurally rather than by class: it is a rejection, and
 * it reaches this package restored from a remote waterfall rather than thrown
 * across a typed call.
 * @param error - what `ask` rejected with.
 * @returns whether it is a decision rather than a broken channel.
 */
function decidedTheCard(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && typeof error.code === 'string'
    && DECIDED_CODES.has(error.code)
}

/**
 * Run one session's route decision after any decision already in flight for it.
 * @param session - the session whose decisions are ordered.
 * @param decide - the decision to run.
 * @returns what the decision answered.
 */
function serializeDecision<T>(session: Session, decide: () => Promise<T>): Promise<T> {
  const result = (decisions.get(session) ?? Promise.resolve()).then(decide)
  decisions.set(session, result.catch(() => undefined))
  return result
}

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
 * The one thing this gate asks of whichever question service a composition
 * mounted: put one question in front of the user and wait for the answer.
 */
export interface RouteQuestionAsker {
  /**
   * Ask the composed answerers and wait.
   * @param request - the questions, the owning agent, and the cancellation.
   * @returns what the user chose or typed.
   */
  readonly ask: (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>
}

/**
 * The one thing this gate asks of whichever session controller a composition
 * mounted: change one session's model.
 *
 * This is the only way this package changes a route. Appending the selection
 * event alone would not move a live agent, and installing a second selection
 * reference would leave the console's picker and the projection behind the
 * route actually in use.
 */
export interface RouteSwitcher {
  /**
   * Validate and install one model selection for the next request.
   * @param request - the session and the route to put it on.
   * @returns the normalized selection the host installed.
   */
  readonly selectModel: (request: SessionSelectModelRequest) => Promise<SessionSelectModelValue>
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
    (service: 'userQuestions'): RouteQuestionAsker | undefined
    (service: 'sessionController'): RouteSwitcher | undefined
  }
}

/**
 * The route this session's next request would go to.
 *
 * Read in three tiers, because a gate reading fewer refuses a session the user
 * has already moved: the console's model picker appends a selection that no
 * request has consumed yet, and until one does, the logged header still names
 * the route the session came from. The first two are `selectionFor`'s own; the
 * third is this agent's options rather than the deployment default the
 * controller falls back to, and no tool execution reaches it.
 * @param services - the mounted services this gate reads.
 * @param agent - the agent whose session names the route.
 * @returns that route, or `undefined` when no tier names one.
 */
export function effectiveRoute(services: ModelRouteServices, agent: CallingAgent): RouteChoice | undefined {
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
 * The route the user chose, or `undefined` for every other answer.
 *
 * The answer comes back from a browser, so a label that is not one this card
 * offered names no route: skipping, typing free text, and choosing the option
 * that changes nothing all end here, and so does an answer to another question.
 * @param routes - the labelled candidates this card offered.
 * @param answer - what came back.
 * @returns the chosen route, or `undefined`.
 */
function chosenRoute(
  routes: readonly LabelledRoute[],
  answer: AskUserQuestionAnswer,
): LabelledRoute | undefined {
  const answered = answer.answers.find(one => one.id === MODEL_SWITCH_QUESTION_ID)
  if (answered === undefined || answered.selected.length !== 1) return undefined
  const [label] = answered.selected
  return routes.find(route => route.label === label)
}

/**
 * Ask whether to change this session's model, and change it when the user says
 * so.
 *
 * Runs where the modality check ran, before the wait opens and before a browser
 * is asked to draw: a declined change must leave no stored picture behind, and
 * a card can stand for minutes while the read's own claim deadline is seconds.
 *
 * Every ending but the change itself answers the model with the refusal it
 * would have received anyway. The card is not mentioned to it: what the model
 * is told is that this route takes no picture, which stays true.
 * @param services - the mounted services this gate reads.
 * @param exec - the execution the card belongs to.
 * @param agent - the agent whose session would be moved.
 * @param route - the route the session is on now.
 * @param llm - the mounted LLM registry.
 * @returns the refusal, or `undefined` once the session is on a route that takes pictures.
 */
async function offerSwitch(
  services: ModelRouteServices,
  exec: ToolRunContext,
  agent: CallingAgent,
  route: RouteChoice,
  llm: RouteModalities,
): Promise<string | undefined> {
  if (declined.has(agent.session)) return noImageRouteRefusal(route.model)
  // Read before the catalogue is walked: a composition that cannot put a card
  // up has nothing to do with what the deployment could offer, and asking each
  // provider for its models is an adapter call.
  const asker = services.get('userQuestions')
  const switcher = services.get('sessionController')
  if (asker === undefined || switcher === undefined) return noImageRouteRefusal(route.model)
  const routes = optionLabels(await imageCapableRoutes(llm))
  if (routes.length === 0) return noImageAnywhereRefusal(route.model)
  let answer: AskUserQuestionAnswer
  try {
    answer = await asker.ask({ questions: [switchQuestion(routes)], agent, signal: exec.signal })
  } catch (theCardWasNotAnswered) {
    // The call is cancelled only when its own signal says so, and a cancelled
    // call is not an answer to record. Of the rest, only a card the user closed
    // and a caller that can never be asked settle the question for this
    // session; a console nobody had open, and a channel that broke while the
    // card stood, are answered the same way and asked again by the next read.
    if (exec.signal.aborted) return CANCELLED_REFUSAL
    if (decidedTheCard(theCardWasNotAnswered)) declined.add(agent.session)
    return noImageRouteRefusal(route.model)
  }
  const chosen = chosenRoute(routes, answer)
  if (chosen === undefined) {
    declined.add(agent.session)
    return noImageRouteRefusal(route.model)
  }
  try {
    await switcher.selectModel({
      sessionId: agent.session.header.id,
      provider: chosen.provider,
      model: chosen.model,
    })
  } catch (error) {
    // The user did answer, and what refused the change is the host's own route
    // resolution rather than their decision, so the next read asks again.
    return routeSwitchRefusal(error instanceof Error ? error.message : String(error))
  }
  // The catalogue said this route takes pictures and the host accepted the
  // change; neither statement is the criterion this gate is built on. A
  // deployment whose catalogue and whose resolved route disagree would
  // otherwise export and store a picture for a request that drops it.
  const moved = await llm.resolveModelInfo(chosen.provider, chosen.model, exec.signal)
  if (moved.inputModalities?.includes(IMAGE_MODALITY) !== true) return noImageRouteRefusal(chosen.model)
  return undefined
}

/**
 * Decide whether this session's next request would carry a picture, asking the
 * user to change the model when it would not.
 *
 * An absent `inputModalities` is a negative answer rather than an unknown one:
 * a route that does not say it accepts images is one this read cannot use.
 * @param services - the mounted services this gate reads.
 * @param exec - the execution whose session names the route.
 * @returns the refusal, or `undefined` when a picture can reach the model.
 */
export async function routeGate(
  services: ModelRouteServices,
  exec: ToolRunContext,
): Promise<string | undefined> {
  const agent = exec.agent
  const llm = services.get('llm')
  if (agent === undefined || llm === undefined) return UNRESOLVED_ROUTE_REFUSAL
  return await serializeDecision(agent.session, async () => {
    const route = effectiveRoute(services, agent)
    if (route === undefined) return UNRESOLVED_ROUTE_REFUSAL
    const active = await llm.resolveModelInfo(route.provider, route.model, exec.signal)
    if (active.inputModalities?.includes(IMAGE_MODALITY) === true) return undefined
    return await offerSwitch(services, exec, agent, route, llm)
  })
}
