/**
 * The column's two pure decisions: which kind seats are mounted, and which
 * entry is on display.
 *
 * A seat is one kind's mounted renderer. Every seat stays mounted for the
 * page's life and all but one are hidden, because a kind renderer may hold DOM
 * the column must not destroy — the page kind's live iframes are the case this
 * router was built around, and unmounting its seat while a chart is selected
 * would reload every one of them. Two rules follow: the seat list is
 * append-only (React moves a keyed child whose position changes, and moving an
 * iframe reloads it), and a kind never leaves it.
 *
 * A seat's own entries can shrink, though — an entry the user dismissed
 * outright leaves the stream rather than being replaced in it — and
 * `selectedEntry`'s fallback is what keeps the picked-entry-is-gone case from
 * blanking the column either way.
 */

import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'

/**
 * Stable identity of one entry across renders and sessions.
 * @param entry - the entry's kind and id.
 * @returns the entry's switcher and seat key, `<kind> <entryId>`.
 */
export function entryKeyOf(entry: Pick<ContentSurfaceEntry, 'kind' | 'entryId'>): string {
  return `${entry.kind} ${entry.entryId}`
}

/** The column's mounted kind seats. */
export interface SurfaceSeats {
  /** Mount order, never reordered and never shortened — this is what the column renders. */
  readonly kinds: readonly string[]
}

/** The empty seat list, shared so a column that has seen no entry keeps one snapshot identity. */
export const NO_SEATS: SurfaceSeats = { kinds: [] }

/** The empty entry list, shared so a session with no surface keeps one snapshot identity. */
export const NO_ENTRIES: readonly ContentSurfaceEntry[] = []

/**
 * Fold one render's entries into the mounted seat list.
 * @param seats - the previous seat list.
 * @param entries - the entries the column can see this render.
 * @returns the next seat list, or `seats` itself when every kind was already mounted.
 */
export function foldSeats(seats: SurfaceSeats, entries: readonly ContentSurfaceEntry[]): SurfaceSeats {
  const added = entries.map(entry => entry.kind).filter(kind => !seats.kinds.includes(kind))
  if (added.length === 0) return seats
  // Appended in first-seen order, deduplicated against each other as well.
  return { kinds: [...seats.kinds, ...new Set(added)] }
}

/**
 * The entry the column shows.
 *
 * The same fallback covers two distinct reasons a pick can outlive its entry:
 * a later record replacing it in place (a redrawn chart), and the entry being
 * dismissed outright (its tab closed — the host-side fold removes the record
 * rather than replacing it, see `dsh-experimental-content-surface`'s
 * `projection.ts`). Either way the picked key is simply no longer present in
 * `entries`, and this function does not need to know which happened.
 * @param entries - this session's entries, newest first.
 * @param picked - the entry key the user chose for this session, when one is still live.
 * @returns the chosen entry, the newest one when the choice is gone, or undefined when there are none.
 */
export function selectedEntry(
  entries: readonly ContentSurfaceEntry[],
  picked: string | undefined,
): ContentSurfaceEntry | undefined {
  // A pick outliving its entry falls back to the newest rather than blanking
  // the column: the entry it named was replaced by a later record, or
  // dismissed outright, and the newest surviving entry is the closest thing
  // to what the user was looking at.
  return entries.find(entry => entryKeyOf(entry) === picked) ?? entries[0]
}
