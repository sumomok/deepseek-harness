/**
 * @deepseek-ai/dsh-experimental-skill-pack-components — the component catalog,
 * as a skill pack reads it.
 *
 * Two packages that must not depend on each other meet here.
 * [`component-surface`](../component-surface/README.md) owns the catalog a
 * component plugin registers into and the judgement a spec is accepted by; it
 * knows nothing about packs. [`skill-pack`](../skill-pack/README.md) withholds
 * a pack until the parts its views place exist and until those views can be
 * drawn; it declares the service keys that answer both questions and reaches
 * into no component package to answer them. This row is what a deployment
 * composes to connect the two, and it is the only place the edge runs in both
 * directions.
 *
 * What it publishes is the components this deployment *offers* rather than the
 * ones it registered. A component the deployment did not turn on cannot be
 * drawn, so a pack requiring it must stay inactive — the data page on a
 * deployment that left `crud` off is that case, and it is why the catalog
 * registry answers an offer rather than a registration.
 * @module @deepseek-ai/dsh-experimental-skill-pack-components
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.componentCatalog, the registry the parts are read off.
import type {} from '@deepseek-ai/dsh-experimental-component-surface'
// Type-only: resolves ctx.skillPackParts, the key this row provides.
import type {} from '@deepseek-ai/dsh-experimental-skill-pack'
import type { PartsSource, ProvidedPart } from '@deepseek-ai/dsh-experimental-skill-pack'

/** Stable Cordis plugin name. */
export const name = 'skill-pack-components'

/**
 * The catalog is required rather than waited for optionally: with no component
 * catalog there is nothing to adapt, and a row providing an empty parts source
 * would answer "no component plugin registers that part" for a deployment that
 * never composed a component surface at all.
 */
export const inject = ['componentCatalog']

/**
 * Read the components this deployment offers as the parts a pack requires.
 *
 * Each offered component becomes one part: the catalog id a pack names in
 * `requires.parts`, the npm name of the package that registered it, and that
 * package's own version, which is what a pack's `requires.components` range is
 * matched against. The identity is the contributing package's, read at
 * registration off its own manifest, so a pack and a plugin agree on the
 * version without either writing it down twice.
 * @param ctx - the injected context carrying `ctx.componentCatalog`.
 * @returns the parts source to publish under `skillPackParts`.
 */
export function componentParts(ctx: Context): PartsSource {
  return {
    list: (): readonly ProvidedPart[] => ctx.componentCatalog.offered.map(component => ({
      id: component.entry.id,
      plugin: component.source.package,
      version: component.source.version,
    })),
    // The catalog's own subscription, disposer included: a component plugin
    // mounted or withdrawn is exactly the event a pack's state turns on, and
    // wrapping it in a second notifier would add a way for the two to disagree
    // about when it happened.
    onChange: (listener: () => void): (() => void) => ctx.componentCatalog.onChange(listener),
  }
}

/**
 * Publish the component catalog under the key the pack root's provider reads.
 * @param ctx - plugin context carrying the component catalog.
 */
export function apply(ctx: Context): void {
  ctx.provide('skillPackParts', componentParts(ctx))
}
