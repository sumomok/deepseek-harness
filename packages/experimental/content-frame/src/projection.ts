/**
 * The `content` projection unit: which page the shell's content column shows
 * for one session.
 *
 * The fold keeps only the id the log recorded; resolving it against the
 * deployment's page list happens in `view`, which closes over the validated
 * configuration. That split is what lets a deployment rename or retire a page
 * without rewriting history: the log stays what the agent did, and the value
 * the browser reads is always computed against the page list running now.
 */

import { z as zod } from 'zod'
import type { ZodType } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { ContentPageView } from './types.ts'
import type { PageIndex } from './pages.ts'

/** The `content` unit as the registry's client-visible overload takes it: `wire` is required, not optional. */
type ContentProjectionDefinition =
  & Omit<ProjectionDefinition<'content', string | null>, 'wire'>
  & { wire: NonNullable<ProjectionDefinition<'content', string | null>['wire']> }

/** Fold state: the last `content/shown` id, or null before the first one (and after a clear). */
const stateSchema: ZodType<string | null> = zod.union([zod.string(), zod.null()])

/** Wire payload schema of the `content` projection. */
const viewSchema: ZodType<ContentPageView> = zod.discriminatedUnion('state', [
  zod.object({ state: zod.literal('shown'), page: zod.string(), url: zod.string(), title: zod.string() }),
  zod.object({ state: zod.literal('default'), url: zod.string(), title: zod.string() }),
  zod.object({ state: zod.literal('empty') }),
  zod.object({ state: zod.literal('missing'), page: zod.string() }),
])

/**
 * Resolve one recorded page id against the page list running now. Shared with
 * the content-surface `page` extractor, which resolves the same recorded ids
 * into the same two arms and must not drift from this one.
 * @param page - the id a `content/shown` event recorded.
 * @param pages - the validated page index.
 * @returns the shown page, or the `missing` arm when the deployment retired it.
 */
export function resolveShownPage(page: string, pages: PageIndex): ContentPageView {
  const found = pages.get(page)
  if (found === undefined) return { state: 'missing', page }
  return { state: 'shown', page, url: found.url, title: found.title }
}

/**
 * Resolve one folded id against the page list running now.
 * @param state - the last recorded id, or null for the cleared column.
 * @param pages - the validated page index.
 * @param defaultPage - the configured default page id, when set.
 * @returns the whole value the browser renders.
 */
function resolveView(state: string | null, pages: PageIndex, defaultPage: string | undefined): ContentPageView {
  if (state === null) {
    // `defaultPage` was validated against this same index at load, so a
    // configured default always resolves.
    const fallback = defaultPage === undefined ? undefined : pages.get(defaultPage)
    if (fallback === undefined) return { state: 'empty' }
    return { state: 'default', url: fallback.url, title: fallback.title }
  }
  return resolveShownPage(state, pages)
}

/**
 * Build the `content` projection unit for one validated configuration.
 * @param pages - the validated page index.
 * @param defaultPage - the configured default page id, when set.
 * @returns the definition to hand to `ctx.sessionProjections.register`.
 */
export function contentProjection(pages: PageIndex, defaultPage: string | undefined): ContentProjectionDefinition {
  return {
    key: 'content',
    stateSchema,
    init: () => null,
    apply: (state: string | null, event: SessionEvent) =>
      event.type === 'content/shown' ? event.data.page : state,
    wire: { viewSchema, view: state => resolveView(state, pages, defaultPage) },
    stateVersion: 1,
  }
}
