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
 *
 * Which entry is on display is a logged decision, and the fold publishes it as
 * the stream's `front`; what stays local is only the click the column has not
 * heard back about yet. `selectedEntry` reads both.
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

/** A click the column is still holding, before or beside the record of it. */
export interface PickedEntry {
  /** The clicked entry's switcher key, `<kind> <entryId>`. */
  readonly key: string
  /** `entries[0].seq` at click time — the newest entry the user was choosing against. */
  readonly atSeq: number
}

/**
 * The click the column holds until the record of it comes back.
 *
 * `entries[0]` is what the user was choosing against, and its absence makes the
 * pick moot either way: a strip with no tabs has nothing to click, and
 * {@link selectedEntry} answers `undefined` for an empty stream whatever it is
 * given.
 * @param entries - this session's entries, newest first.
 * @param key - the clicked entry's switcher key.
 * @returns the click, ready to hold.
 */
export function pickedAt(entries: readonly ContentSurfaceEntry[], key: string): PickedEntry {
  return { key, atSeq: entries[0]?.seq ?? 0 }
}

/**
 * The entry the column shows.
 *
 * Two sources answer this, and the local one is the smaller. A click is held
 * here only for the moment between the button and the command's record of it
 * coming back through the projection — and only while it is still the user's
 * latest word: an entry recorded after the click (the agent showing a page,
 * redrawing a chart) is what the column moves to, which is the same rule the
 * host applies to `front` and the reason both are compared by seq. Past that
 * moment, and after any reload, `front` is the answer, because the log is where
 * the decision lives.
 *
 * The final fallback covers the two reasons a pick or a `front` can outlive its
 * entry: a later record replacing it in place (a redrawn chart), and the entry
 * being dismissed outright (its tab closed — the host-side fold removes the
 * record rather than replacing it, see `dsh-experimental-content-surface`'s
 * `projection.ts`). Either way the named entry is simply no longer present in
 * `entries`, and this function does not need to know which happened.
 * @param entries - this session's entries, newest first.
 * @param picked - the click this column is still holding for this session, when there is one.
 * @param front - the entry the host says is in front, from the `contentSurface` projection.
 * @returns the chosen entry, the newest one when neither choice is live, or undefined when there are none.
 */
export function selectedEntry(
  entries: readonly ContentSurfaceEntry[],
  picked: PickedEntry | undefined,
  front: { kind: string; entryId: string } | undefined,
): ContentSurfaceEntry | undefined {
  const newest = entries[0]
  if (picked !== undefined && newest !== undefined && newest.seq <= picked.atSeq) {
    const clicked = entries.find(entry => entryKeyOf(entry) === picked.key)
    if (clicked !== undefined) return clicked
  }
  const recorded = front === undefined
    ? undefined
    : entries.find(entry => entry.kind === front.kind && entry.entryId === front.entryId)
  return recorded ?? newest
}
