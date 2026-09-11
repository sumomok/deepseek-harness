/**
 * Pure track solver for the permanent four-track service shell. Every column
 * is resident: the session list, the content column, and the chat column split
 * the frame on a fixed 24-unit ratio, and the details column is a fixed-width
 * band that the layout service opens and closes. There is no concession chain
 * and no drag preference — the solve is a function of (frame width, sidebar
 * fold, details open, content empty, narrow) alone, so any resize reproduces
 * the same ratio, with one fixed point on it: the expanded session column never
 * solves below {@link SESSION_MIN}. On a frame narrower than the one where its
 * 3/24 share meets that floor, the column holds the floor and content and chat
 * divide what remains on their 16:5.
 *
 * Below {@link SIDEBAR_AUTO_COLLAPSE} the session column leaves the grid
 * entirely: its track resolves to zero and content and chat divide the whole
 * frame, because the floored column would take 180px of a phone-width window
 * that has none to spare. The session list is reached instead through an
 * off-canvas drawer the frame draws over the content (ShellFrame.tsx); the
 * solver only zeroes the track, and {@link isNarrow} is the breakpoint the
 * frame passes it.
 *
 * The content column additionally collapses to zero width when the current
 * session's content surface has shown nothing yet, the same way the details
 * band collapses while closed: chat absorbs the reclaimed share rather than
 * splitting it with an empty column.
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
/**
 * Expanded session column's floor in px. 180 is what the 3/24 share yields
 * from 1440px of columns (a 1440px frame with details closed), so every wider
 * span solves exactly on the ratio and only a narrower one lifts the column
 * above its share; the share alone leaves a 500px window a 63px column that
 * wraps every session title one character per line. Clamped to the columns'
 * width, so a frame narrower than the floor still tiles exactly.
 */
export const SESSION_MIN = 180
/** Details band width while open; closed resolves to zero. */
export const DETAILS_WIDTH = 360
/**
 * Frame width in px at and above which the session column stays in the grid;
 * below it the column leaves the grid and its list is reached through the
 * off-canvas drawer instead (ShellFrame.tsx). 1024 is the deepsuite LG
 * breakpoint, matching the shipped shell's `SIDEBAR_AUTO_COLLAPSE` so the two
 * shells fold at the same width. A frame narrower than this leaves chat under
 * 360px even with the session floor and the content column collapsed, and the
 * floored column would eat width a phone cannot spare; the drawer is what gives
 * that width back. Contract-frozen beside {@link SESSION_RAIL}, not a
 * configuration field: the shell's fold width is a fixed product decision.
 */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/**
 * The off-canvas session drawer's width in px when open, clamped to the frame
 * (ShellFrame.tsx) so a window narrower than the drawer still fits it. A fixed
 * width, not a share: below the breakpoint the drawer floats over the content
 * rather than tiling with it, so no ratio applies. Contract-frozen beside
 * {@link DETAILS_WIDTH}.
 */
export const SIDEBAR_DRAWER = 280

/** Resolved px width of each grid track for one frame. */
export interface Tracks {
  /** Session (sidebar) column; {@link SESSION_RAIL} while folded, 0 while narrow. */
  session: number
  /** Content column — this shell's center band; 0 while it has nothing to show. */
  content: number
  /** Chat (conversation) column. */
  chat: number
  /** Details band; 0 while closed, and the subtree stays mounted at that width. */
  details: number
}

/**
 * Whether a frame is below the fold breakpoint, so the session column leaves
 * the grid for the off-canvas drawer.
 * @param frame - the shell's own measured width in px.
 * @returns `true` when `frame` is strictly below {@link SIDEBAR_AUTO_COLLAPSE}.
 */
export function isNarrow(frame: number): boolean {
  return frame < SIDEBAR_AUTO_COLLAPSE
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
 * @param contentEmpty - whether the content column has nothing to show
 * (collapses it to zero, same as `detailsOpen: false` does for details).
 * @param narrow - whether the frame is below {@link SIDEBAR_AUTO_COLLAPSE}
 * ({@link isNarrow}); when true the session column leaves the grid (track 0)
 * regardless of `sessionFolded`, and content and chat divide what the details
 * band leaves.
 * @returns the px width of each track; they sum to `frame` whenever it is
 * positive, an expanded session column is its 3/24 share or {@link SESSION_MIN}
 * (whichever is wider), and a narrow session column is 0.
 */
export function solveTracks(
  frame: number, sessionFolded: boolean, detailsOpen: boolean, contentEmpty: boolean, narrow: boolean,
): Tracks {
  const width = Math.max(0, frame)
  const details = detailsOpen ? Math.min(DETAILS_WIDTH, width) : 0
  const columns = width - details
  const session = narrow
    ? 0
    : sessionFolded
      ? Math.min(SESSION_RAIL, columns)
      : Math.min(columns, Math.max(SESSION_MIN, share(columns, SESSION_UNITS, TOTAL_UNITS)))
  // A folded rail leaves its ratio units unclaimed, so content and chat divide
  // what remains on their own 16:5 — the center never inherits the whole fold.
  const body = columns - session
  const content = contentEmpty ? 0 : share(body, CONTENT_UNITS, CONTENT_UNITS + CHAT_UNITS)
  return { session, content, chat: body - content, details }
}
