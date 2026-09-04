/**
 * The composition the picture read's route gate sees, stood in one service at a
 * time.
 *
 * `ModelRouteServices.get` is an overload set, so a plain arrow returning a
 * union satisfies none of its arms; this builder declares the same overloads
 * once and every spec composing a composition takes it from here.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import type {
  ModelRouteServices, RouteModalities, RouteSelectionState,
} from '../src/access/model-switch.ts'

/** Which services a stood-in composition mounts; an absent one is not mounted. */
export interface RouteServiceParts {
  /** The LLM registry, for a composition that has one. */
  readonly llm?: RouteModalities
  /** The projection registry, for a composition whose model-selection unit is registered. */
  readonly selection?: RouteSelectionState
}

/**
 * A composition mounting exactly the services given.
 * @param parts - the services this composition has.
 * @returns the narrowed context the gate reads.
 */
export function routeServices(parts: RouteServiceParts): ModelRouteServices {
  function get(service: 'llm'): RouteModalities | undefined
  function get(service: 'sessionProjections'): RouteSelectionState | undefined
  function get(service: string): RouteModalities | RouteSelectionState | undefined {
    return service === 'llm' ? parts.llm : parts.selection
  }
  return { get }
}

/**
 * An LLM registry answering for every route with one set of modalities.
 * @param modalities - what every route declares it accepts, absent for a
 * registry whose routes declare nothing.
 * @returns the narrowed registry.
 */
export function fixedModalities(modalities?: readonly string[]): RouteModalities {
  return {
    resolveModelInfo: () => Promise.resolve(modalities === undefined ? {} : { inputModalities: modalities }),
  }
}
