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
    listProviders: () => [],
    listModels: () => Promise.resolve([]),
  }
}

/** One model a stood-in catalogue lists. */
export interface CatalogueModel {
  /** The model id a route names. */
  readonly id: string
  /** The model's own display name. */
  readonly name: string
  /** What it declares it accepts, absent for a model that declares nothing. */
  readonly inputModalities?: readonly string[]
}

/** One provider a stood-in catalogue lists. */
export interface CatalogueProvider {
  /** The registered provider route. */
  readonly id: string
  /** The provider's own display name. */
  readonly name: string
  /** Its models, absent for a provider whose catalogue cannot be read. */
  readonly models?: readonly CatalogueModel[]
}

/**
 * An LLM registry over one deployment's catalogue.
 * @param providers - what the deployment has registered.
 * @param modalities - what every route resolves as, for a gate that also asks.
 * @returns the narrowed registry.
 */
export function catalogue(providers: readonly CatalogueProvider[], modalities?: readonly string[]): RouteModalities {
  return {
    ...fixedModalities(modalities),
    listProviders: () => providers.map(({ id, name }) => ({ id, name })),
    listModels: (provider) => {
      const listed = providers.find(one => one.id === provider)?.models
      return listed === undefined
        ? Promise.reject(new Error(`the catalogue of "${provider}" cannot be read`))
        : Promise.resolve(listed)
    },
  }
}
