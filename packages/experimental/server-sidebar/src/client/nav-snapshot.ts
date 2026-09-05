/**
 * Capture a workflow's navigation snapshot from a session's content-surface
 * projection: every distinct entry the navigation catalog still lists, oldest
 * first. Both extractors dedupe by id (re-showing a page or a view moves its
 * entry to the front rather than adding a second one), so this is exactly
 * "every catalogued thing ever shown, oldest to newest" — not a single current
 * pointer.
 *
 * This module also owns the one translation between the two vocabularies the
 * sidebar spans: a navigation kind (`page` / `view`, what a menu row and a
 * stored snapshot carry) and the content-surface entry kind it lands as
 * (`page` / `component`). Both entry-kind literals are copies of
 * `@deepseek-ai/dsh-experimental-content-frame`'s `PAGE_KIND` and
 * `@deepseek-ai/dsh-experimental-component-surface`'s `COMPONENT_KIND` rather
 * than imported values — a cross-package value import is not this
 * repository's sanctioned way to couple two client-adjacent plugins (see
 * `nav-catalog.ts`'s module doc for the same reasoning; the drift guard is in
 * this package's own tests). The entry TYPE, by contrast, comes from a
 * type-only import of `@deepseek-ai/dsh-experimental-content-surface/types` —
 * the same type-only pattern this package already uses to pull
 * `dsh-client-ui-sidebar`'s SlotMap declarations, needed here only so
 * `useProjection('contentSurface')` resolves to something other than
 * `unknown`.
 * @module @deepseek-ai/dsh-experimental-server-sidebar/client/nav-snapshot
 */
import type {} from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-client-runtime/client'
import type { NavSnapshotItem, NavSnapshotKind } from '../workflows.ts'

/** Content-surface entry kind each navigation kind lands as (see the module doc for why these are copies). */
const SURFACE_KIND: Record<NavSnapshotKind, string> = { page: 'page', view: 'component' }

/** The inverse of {@link SURFACE_KIND}, derived from it so the pair cannot drift. */
const NAV_KIND_BY_SURFACE_KIND = new Map<string, NavSnapshotKind>(
  Object.entries(SURFACE_KIND).map(([kind, surfaceKind]) => [surfaceKind, kind as NavSnapshotKind]),
)

/**
 * The content-surface entry kind one navigation kind lands as.
 * @param kind - the navigation kind.
 * @returns the entry kind that kind's command records.
 */
export function surfaceKindOf(kind: NavSnapshotKind): string {
  return SURFACE_KIND[kind]
}

/**
 * The navigation kind one content-surface entry came from.
 * @param surfaceKind - an entry's `kind`, of unknown shape (the projection is
 * read defensively — see `ServerSidebarRoot.tsx`).
 * @returns the navigation kind, or `undefined` for an entry no navigation
 * gesture can produce (a chart the agent drew, or a kind a future package
 * adds).
 */
export function navKindOf(surfaceKind: unknown): NavSnapshotKind | undefined {
  return typeof surfaceKind === 'string' ? NAV_KIND_BY_SURFACE_KIND.get(surfaceKind) : undefined
}

/**
 * One navigation target's set key, joined on a separator no id may carry so
 * two kinds cannot collide on one string.
 * @param kind - the navigation kind.
 * @param entryId - the target's id within that kind.
 * @returns the key identifying that target.
 */
function navKey(kind: NavSnapshotKind, entryId: string): string {
  return `${kind}\u0000${entryId}`
}

/**
 * Capture the navigable snapshot of one session's content-surface projection.
 *
 * An entry is kept only when `catalog` still lists its `{kind, entryId}` pair,
 * because a snapshot is replayed by re-running each stop's own command
 * (`open-nav.ts`'s `replayNavSnapshot`) and both commands refuse an id their
 * deployment configuration does not name. Two entries in an ordinary
 * projection fail that test: a `component` entry the model produced with its
 * own `show_component` call, whose id is free-form model output rather than a
 * configured view, and an entry whose page or view the deployment has since
 * dropped. Neither is a navigation stop this shell can return to, so neither
 * is recorded as one.
 * @param view - the session's `contentSurface` projection value, as
 * `useProjection('contentSurface')` reads it; `undefined` when the capability
 * is absent or nothing has ever been shown.
 * @param catalog - the merged navigation menu (`nav-catalog.ts`'s
 * `mergeNavCatalogs`), which is exactly the set of stops a replay can reach.
 * @returns the navigation stops, oldest first; empty when there is no
 * projection or nothing on record is catalogued (a chart the agent drew is
 * never captured — a v1 boundary, see the package README).
 */
export function captureNavSnapshot(
  view: SessionProjectionMap['contentSurface'] | undefined,
  catalog: readonly NavSnapshotItem[],
): NavSnapshotItem[] {
  const catalogued = new Set(catalog.map(item => navKey(item.kind, item.entryId)))
  const entries = view?.entries ?? []
  // `entries` is newest-first (highest owning seq first, per content-surface's
  // own ContentSurfaceView doc); reverse to oldest-first so replaying this
  // snapshot in order leaves the last-replayed stop current, matching what was
  // current when the snapshot was captured.
  return entries
    .map((entry): NavSnapshotItem | undefined => {
      const kind = navKindOf(entry.kind)
      if (kind === undefined || !catalogued.has(navKey(kind, entry.entryId))) return undefined
      return { kind, entryId: entry.entryId }
    })
    .filter((item): item is NavSnapshotItem => item !== undefined)
    .reverse()
}
