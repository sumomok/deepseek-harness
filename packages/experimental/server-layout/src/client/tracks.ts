/**
 * Pure track solver for the permanent four-track service shell. Every column
 * is resident: the session list, the content column, and the chat column split
 * the frame on a fixed 24-unit ratio, and the details column is a fixed-width
 * band that the layout service opens and closes. There is no concession chain
 * and no drag preference — the solve is a function of (frame width, sidebar
 * fold, details open) alone, so any resize reproduces the same ratio.
 *
 * Widths come out in px rather than `fr` because the sidebar occupant renders
 * its own inline width from the `width` owner prop: an `fr` track would leave
 * that number unknowable, and the two would drift.
 */

/** Session column's share of the 24-unit ratio. */
export const SESSION_UNITS = 3
/** Content column's share of the 24-unit ratio. */
export const CONTENT_UNITS = 16
/** Chat column's share of the 24-unit ratio. */
export const CHAT_UNITS = 5
/** The ratio's denominator while the session column is expanded. */
export const TOTAL_UNITS = SESSION_UNITS + CONTENT_UNITS + CHAT_UNITS

// Contract-frozen geometry, matching the shipped shell so a registrant written
// against one column renders identically under the other.
/** Folded session column: a 24px icon column between 16px horizontal paddings. */
export const SESSION_RAIL = 56
/** Details band width while open; closed resolves to zero. */
export const DETAILS_WIDTH = 360

/** Resolved px width of each grid track for one frame. */
export interface Tracks {
  /** Session (sidebar) column; {@link SESSION_RAIL} while folded. */
  session: number
  /** Content column — this shell's center band. */
  content: number
  /** Chat (conversation) column. */
  chat: number
  /** Details band; 0 while closed, and the subtree stays mounted at that width. */
  details: number
}

/**
 * Split `total` on `units / of`, rounded to a whole pixel.
 * @param total - pixels to split.
 * @param units - this track's ratio units.
 * @param of - the ratio's denominator.
 * @returns the track's px width.
 */
function share(total: number, units: number, of: number): number {
  return Math.round((total * units) / of)
}

/**
 * Solve the four track widths for one frame.
 * @param frame - the shell's own measured width in px.
 * @param sessionFolded - whether the session column renders its control rail.
 * @param detailsOpen - whether the layout service has the details band open.
 * @returns the px width of each track; they sum to `frame` whenever it is positive.
 */
export function solveTracks(frame: number, sessionFolded: boolean, detailsOpen: boolean): Tracks {
  const width = Math.max(0, frame)
  const details = detailsOpen ? Math.min(DETAILS_WIDTH, width) : 0
  const columns = width - details
  const session = sessionFolded ? Math.min(SESSION_RAIL, columns) : share(columns, SESSION_UNITS, TOTAL_UNITS)
  // A folded rail leaves its ratio units unclaimed, so content and chat divide
  // what remains on their own 16:5 — the center never inherits the whole fold.
  const body = columns - session
  const content = share(body, CONTENT_UNITS, CONTENT_UNITS + CHAT_UNITS)
  return { session, content, chat: body - content, details }
}
