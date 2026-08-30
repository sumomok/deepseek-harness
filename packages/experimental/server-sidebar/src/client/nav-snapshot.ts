/**
 * Capture a workflow's navigation snapshot from a session's content-surface
 * projection: every distinct `page`-kind entry currently on record, oldest
 * first. `content-surface`'s `page` extractor dedupes by page id (re-showing
 * a page moves its entry to the front rather than adding a second one), so
 * this is exactly "every page ever shown, oldest to newest" — not a single
 * current pointer.
 *
 * The `page` kind literal is a copy of
 * `@deepseek-ai/dsh-experimental-content-frame`'s own `PAGE_KIND` rather than
 * an imported value — a cross-package value import is not this repository's
 * sanctioned way to couple two client-adjacent plugins (see `pages.ts`'s
 * module doc for the same reasoning). The entry TYPE, by contrast, comes from
 * a type-only import of `@deepseek-ai/dsh-experimental-content-surface/types`
 * — the same type-only pattern this package already uses to pull
 * `dsh-client-ui-sidebar`'s SlotMap declarations, needed here only so
 * `useProjection('contentSurface')` resolves to something other than
 * `unknown`.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/nav-snapshot
 */
import type {} from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-client-runtime/client'

/** Literal copy of content-frame's `PAGE_KIND` (see the module doc for why). */
const PAGE_KIND = 'page'

/**
 * Capture the page-kind navigation snapshot of one session's content-surface
 * projection.
 * @param view - the session's `contentSurface` projection value, as
 * `useProjection('contentSurface')` reads it; `undefined` when the
 * capability is absent or no page has ever been shown.
 * @returns page ids, oldest first; empty when there is no projection or no
 * page-kind entries (chart-kind entries are never captured — a v1 boundary,
 * see the package README).
 */
export function captureNavSnapshot(view: SessionProjectionMap['contentSurface'] | undefined): string[] {
  const entries = view?.entries ?? []
  // `entries` is newest-first (highest owning seq first, per content-surface's
  // own ContentSurfaceView doc); reverse to oldest-first so replaying this
  // snapshot in order leaves the last-replayed page current, matching what
  // was current when the snapshot was captured.
  return entries.filter(entry => entry.kind === PAGE_KIND).map(entry => entry.entryId).reverse()
}
