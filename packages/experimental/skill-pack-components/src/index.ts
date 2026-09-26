/**
 * @deepseek-ai/dsh-experimental-skill-pack-components — the component surface,
 * as a skill pack reads it, and the pack's views, as the surface draws them.
 *
 * Two packages that must not depend on each other meet here.
 * [`component-surface`](../component-surface/README.md) owns the catalog a
 * component plugin registers into, the judgement a spec is accepted by, and the
 * index of views the sidebar lists; it knows nothing about packs.
 * [`skill-pack`](../skill-pack/README.md) withholds a pack until the parts its
 * views place exist and until those views can be drawn; it declares the service
 * key that answers both and reaches into no component package to answer them.
 * This row is what a deployment composes to connect the two, and it is the only
 * place the edge runs in both directions.
 *
 * What it publishes is the components this deployment *offers* rather than the
 * ones it registered. A component the deployment did not turn on cannot be
 * drawn, so a pack requiring it must stay inactive — the data page on a
 * deployment that left `crud` off is that case, and it is why the catalog
 * registry answers an offer rather than a registration.
 *
 * Views travel the other way. Every active pack's views are registered into
 * `ctx.componentViews` as one source, re-registered whenever the pack set
 * moves, so a pack activating puts its views in the sidebar and a pack going
 * inactive takes them out, with no restart.
 * @module @deepseek-ai/dsh-experimental-skill-pack-components
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: resolves ctx.componentCatalog and ctx.componentViews.
import type {} from '@deepseek-ai/dsh-experimental-component-surface'
// Type-only: resolves ctx.skillPacks and ctx.skillPackParts.
import type {} from '@deepseek-ai/dsh-experimental-skill-pack'
import type { PackView, PackViewRefusal, PartsSource, ProvidedPart } from '@deepseek-ai/dsh-experimental-skill-pack'

/** Stable Cordis plugin name. */
export const name = 'skill-pack-components'

/**
 * Both services are required rather than waited for optionally: with no
 * component catalog there is nothing to adapt, and a row providing an empty
 * parts source would answer "no component plugin registers that part" for a
 * deployment that never composed a component surface at all.
 */
export const inject = ['componentCatalog', 'componentViews', 'skillPacks']

/**
 * Read the components this deployment offers as the parts a pack requires, and
 * judge a pack's views against the surface that would draw them.
 *
 * Each offered component becomes one part: the catalog id a pack names in
 * `requires.parts`, the npm name of the package that registered it, and that
 * package's own version, which is what a pack's `requires.components` range is
 * matched against. The identity is the contributing package's, read at
 * registration off its own manifest, so a pack and a plugin agree on the
 * version without either writing it down twice.
 * @param ctx - the injected context carrying the catalog and the view index.
 * @returns the source to publish under `skillPackParts`.
 */
export function componentSurfaceSource(ctx: Context): PartsSource {
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
    judgeView: (view: PackView): PackViewRefusal | undefined => {
      // The deployment's own views own their ids: a pack repeating one would be
      // a menu row whose owner is decided by load order, so the pack is held
      // back instead. Two packs claiming one id is the pack root's own
      // question, which it answers by withholding both of them.
      if (ctx.componentViews.configuredIds.includes(view.id)) {
        return { path: 'id', reason: `the view id ${JSON.stringify(view.id)} is already offered by this deployment` }
      }
      const judged = ctx.componentViews.judge(view)
      return judged.ok ? undefined : judged.refusal
    },
  }
}

/**
 * Offer every active pack's views to the content surface, and re-offer them
 * whenever the pack set moves.
 *
 * One source for the whole root rather than one per pack: what the view index
 * takes is a package's contribution, and the package contributing here is this
 * row. A pack that goes inactive is simply absent from the next reading.
 *
 * The read is asynchronous and the registration is not, so each reading carries
 * the number of the refresh that asked for it: a reading a later refresh has
 * already superseded, and one that arrives after this fiber has gone, are both
 * dropped rather than registered.
 * @param ctx - the injected context carrying the pack root and the view index.
 */
function offerPackViews(ctx: Context): void {
  let held: (() => void) | undefined
  let generation = 0
  const refresh = (): void => {
    const own = ++generation
    void ctx.skillPacks.activeViews().then((views) => {
      if (own !== generation) return
      held?.()
      held = ctx.componentViews.register({
        owner: name,
        views: views.map(view => ({ id: view.id, title: view.title, spec: view.spec, params: view.params })),
      })
    })
  }
  ctx.effect(() => {
    refresh()
    return () => {
      // A later reading must not register after this fiber has gone.
      generation += 1
      held?.()
      held = undefined
    }
  }, 'skill-pack-components: the active packs\' views')
  ctx.skillPacks.onChange(refresh)
}

/**
 * Publish the component surface under the key the pack root's provider reads,
 * and the active packs' views into the index the sidebar lists.
 * @param ctx - plugin context carrying the component surface and the pack root.
 */
export function apply(ctx: Context): void {
  ctx.provide('skillPackParts', componentSurfaceSource(ctx))
  offerPackViews(ctx)
}
