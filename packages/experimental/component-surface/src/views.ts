/**
 * What a view is judged by, whoever wrote it: the deployment in `cordis.yml`,
 * or a skill pack in a file beside its instructions.
 *
 * One judgement for both, and it is the tool's own — the same catalog, the same
 * ceilings, the same alphabet for an id — so what a person may write is exactly
 * what the model may send and neither can drift from the other. What differs is
 * what a refusal costs: a deployment's own view is a load failure, and a pack's
 * view holds that pack back.
 *
 * A view is judged before anyone clicks it rather than at the click, so a
 * deployment learns about a broken view when the row loads.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/views
 */

import type { ComponentCall, ComponentCatalog } from './component-call.ts'
import { judgeDataPageNodes } from './data-page.ts'
import { applyViewParams } from './params.ts'
import type { ContentView } from './types.ts'
import { validateComponentCall, type ComponentCallFailure } from './validate.ts'

/**
 * Configured views indexed by id, in declaration order, each already tightened
 * to what validation accepted — which is exactly what one accepted call is, so
 * the command appends the same three values from either source.
 */
export type ViewIndex = ReadonlyMap<string, ComponentCall>

/** One view as its writer hands it over, before anything has judged it. */
export interface ContributedView extends ContentView {
  /**
   * Values the spec's `{"$param": "<name>"}` references stand for, fixed by
   * whoever wrote the view. A deployment writing views in `cordis.yml` declares
   * none: the file it writes them in is the deployment's own.
   */
  readonly params?: Readonly<Record<string, unknown>>
}

/** One refused view: where in it the refusal happened, and what is wrong with the value. */
export interface ViewRefusal {
  /** Parameter path of the offending value, such as `spec.nodes[0].component`. */
  readonly path: string
  /** What is wrong with it, in the words the model would be refused in. */
  readonly reason: string
}

/** A view the catalog accepts, tightened to what will be drawn, or the value that stopped it. */
export type ViewJudgement =
  | { readonly ok: true; readonly call: ComponentCall }
  | { readonly ok: false; readonly refusal: ViewRefusal }

/**
 * Strip the tool's own name off a refusal, leaving the path and the sentence.
 *
 * The refusals are written for a model correcting a call it just made, and a
 * deployment reading a startup failure is neither; what survives the strip is
 * the part that is true of both — which value was refused and why. The failure
 * text always names its own path, which is where the cut is made.
 * @param failure - the refusal validation answered with.
 * @returns the refusal from its path onwards.
 */
function refusalDetail(failure: ComponentCallFailure): string {
  return failure.text.slice(failure.text.indexOf(failure.path))
}

/**
 * Judge one view against the components this deployment offers.
 *
 * Parameters first, because what the catalog judges is the spec that will be
 * drawn; then the call's own judgement; then the rules the data page adds,
 * which are the tool's own — a deployment that does not offer the page refuses
 * a view placing one by name, a view placing two is refused at the second, and
 * a sort naming both directions is refused either way. The one rule a view is
 * exempt from is the arrangement: a view is a page a person wrote down, so the
 * regions, buttons, paging and read-only flag in it are that person's.
 * @param catalog - the components this deployment offers.
 * @param offersDataPage - whether this deployment offers the data page at all.
 * @param view - the view as its writer wrote it.
 * @returns the accepted call, or the value that stopped it.
 */
export function judgeView(catalog: ComponentCatalog, offersDataPage: boolean, view: ContributedView): ViewJudgement {
  const substituted = applyViewParams(view.spec, view.params ?? {})
  if (!substituted.ok) {
    return { ok: false, refusal: { path: substituted.failure.path, reason: `${substituted.failure.path} — ${substituted.failure.reason}` } }
  }
  const result = validateComponentCall(catalog, { id: view.id, title: view.title, spec: substituted.spec })
  if (!result.ok) return { ok: false, refusal: { path: result.failure.path, reason: refusalDetail(result.failure) } }
  // The refusals a call placing a page gets, but for the one a view is exempt
  // from: the arrangement in a view is the arrangement its writer wrote. A view
  // may place a page at all because the click that shows it is the user's own,
  // so it opens on that click (`view-command.ts`).
  const failure = judgeDataPageNodes(catalog, result.call.spec, offersDataPage, true)
  if (failure !== undefined) return { ok: false, refusal: { path: failure.path, reason: refusalDetail(failure) } }
  return { ok: true, call: result.call }
}

/**
 * Judge the deployment's own configured views and index them by id.
 * @param catalog - the components this deployment offers.
 * @param views - the `views` config value, in declaration order.
 * @param homeView - the `homeView` config value, when set.
 * @param offersDataPage - whether this deployment offers the data page at all.
 * @returns the id index, in declaration order.
 * @throws {Error} when a view's id, title or spec is not one the tool would
 * have accepted, when an id repeats, or when `homeView` names no configured view.
 */
export function indexViews(
  catalog: ComponentCatalog,
  views: readonly ContentView[],
  homeView: string | undefined,
  offersDataPage: boolean,
): ViewIndex {
  const index = new Map<string, ComponentCall>()
  for (const [position, view] of views.entries()) {
    const judged = judgeView(catalog, offersDataPage, view)
    if (!judged.ok) {
      throw new Error(`component-surface: views[${position}] ${JSON.stringify(view.id)} — ${judged.refusal.reason}`)
    }
    if (index.has(judged.call.id)) {
      throw new Error(`component-surface: duplicate view id ${JSON.stringify(judged.call.id)} at views[${position}]`)
    }
    index.set(judged.call.id, judged.call)
  }
  if (homeView !== undefined && !index.has(homeView)) {
    throw new Error(`component-surface: homeView ${JSON.stringify(homeView)} names no configured view`)
  }
  return index
}
