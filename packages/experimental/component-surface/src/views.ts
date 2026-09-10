/**
 * The configured view list, judged once at load and then read by both
 * host-side registrants: the route that publishes the catalog to the sidebar,
 * and the command that puts one view in the column.
 *
 * Judgement lives here rather than in either of them so a deployment learns
 * about a broken view when the row loads, not when a user first clicks it —
 * and it is the same judgement a tool call gets, run by the same pass, so a
 * spec a person writes and a spec the model writes are accepted on identical
 * terms and neither can drift from the other.
 * @module @deepseek-ai/dsh-experimental-component-surface/src/views
 */

import { CRUD_ID, crudNodes, type ComponentCall } from './component-call.ts'
import type { ContentView } from './types.ts'
import { validateComponentCall, type ComponentCallFailure } from './validate.ts'

/**
 * Configured views indexed by id, in declaration order, each already tightened
 * to what validation accepted — which is exactly what one accepted call is, so
 * the command appends the same three values from either source.
 */
export type ViewIndex = ReadonlyMap<string, ComponentCall>

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
 * Judge the configured views and index them by id.
 * @param views - the `views` config value, in declaration order.
 * @param homeView - the `homeView` config value, when set.
 * @returns the id index, in declaration order.
 * @throws {Error} when a view's id, title or spec is not one the tool would
 * have accepted, when an id repeats, when a view places the data page, or when
 * `homeView` names no configured view.
 */
export function indexViews(views: readonly ContentView[], homeView: string | undefined): ViewIndex {
  const index = new Map<string, ComponentCall>()
  for (const [position, view] of views.entries()) {
    const result = validateComponentCall(view)
    if (!result.ok) {
      throw new Error(
        `component-surface: views[${position}] ${JSON.stringify(view.id)} — ${refusalDetail(result.failure)}`)
    }
    if (index.has(result.call.id)) {
      throw new Error(`component-surface: duplicate view id ${JSON.stringify(result.call.id)} at views[${position}]`)
    }
    // A data page opens only once the user has been asked, and a view asks
    // nobody: a click on the sidebar would put the page's first request on the
    // wire with the user's own credential and no question in front of it.
    if (crudNodes(result.call.spec).length > 0) {
      throw new Error(
        `component-surface: views[${position}] ${JSON.stringify(result.call.id)} — places a ${CRUD_ID} block, which `
        + 'only a call the user is asked about may place')
    }
    index.set(result.call.id, result.call)
  }
  if (homeView !== undefined && !index.has(homeView)) {
    throw new Error(`component-surface: homeView ${JSON.stringify(homeView)} names no configured view`)
  }
  return index
}
