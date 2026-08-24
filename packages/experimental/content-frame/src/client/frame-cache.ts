/**
 * The keepalive bookkeeping of the page kind, as one pure function.
 *
 * The seat renders every cached frame at once and hides all but the active
 * one, so everything about whether a hosted page survives a switch — to
 * another page, to another content kind, or to another session — is decided
 * here. Two browser facts constrain the whole design, and both destroy a live
 * document without removing the element:
 *
 * - Moving an iframe in the DOM reloads it. React moves a keyed child whenever
 *   its position among its siblings changes, so the rendered list is
 *   append-only: entries keep their mount order for life, and recency is kept
 *   in a separate list that never reaches the DOM.
 * - `display: none` detaches an iframe in Blink and reloads it on return, which
 *   is why the seat hides with `visibility` instead (ContentFrame.module.css),
 *   and why the content column hides an unselected seat the same way.
 */

/** One cached frame: the (session, page) pair it belongs to and the page it currently holds. */
export interface CachedFrame {
  /** One session's view of one page; also this frame's React key. */
  readonly frameId: string
  /** Same-origin URL the frame is pointed at. */
  readonly url: string
}

/** The seat's live frames plus the recency that decides which one dies next. */
export interface FrameCache {
  /** Mount order, never reordered — this is what the seat renders. */
  readonly frames: readonly CachedFrame[]
  /** Frame ids, most recently shown first; eviction takes from the tail. */
  readonly order: readonly string[]
}

/** The empty cache, shared so a seat that has never shown a frame keeps one snapshot identity. */
export const NO_FRAMES: FrameCache = { frames: [], order: [] }

/**
 * Fold one render's active frame into the cache.
 *
 * Three rules carry the whole behavior: a frame that is active again only
 * moves in the recency list, never in the rendered one (its element is not
 * touched at all); a frame whose page URL changed under it — a redeployment
 * that moved the page — has its entry replaced, so it navigates in place
 * instead of a second one mounting; and the active frame is never the one
 * evicted, so what the user is looking at cannot be dropped to make room for
 * itself.
 *
 * @param cache - the previous cache.
 * @param active - the frame the seat shows now, or undefined when it shows
 * none (another content kind is selected, no session is open, or the page the
 * entry names was retired).
 * @param limit - how many frames may stay alive at once; at least 1.
 * @returns the next cache, or `cache` itself when nothing moved.
 */
export function foldFrames(cache: FrameCache, active: CachedFrame | undefined, limit: number): FrameCache {
  // Showing nothing retains the cache untouched: the frames are what the user
  // comes back to, and a hidden seat is not a reason to destroy them.
  if (active === undefined) return cache
  const current = cache.frames.find(frame => frame.frameId === active.frameId)
  if (current?.url === active.url && cache.order[0] === active.frameId) return cache

  const order = [active.frameId, ...cache.order.filter(id => id !== active.frameId)]
  const frames = current === undefined
    ? [...cache.frames, active]
    : current.url === active.url
      // Same page: keep the stored entry, so a pure recency change rewrites
      // nothing React could act on.
      ? cache.frames
      : cache.frames.map(frame => (frame.frameId === active.frameId ? active : frame))
  if (frames.length <= limit) return { frames, order }

  // Evict from the recency tail, never the active frame. Removing one entry
  // leaves every survivor's relative position intact, so no frame is moved.
  const evicted = order[order.length - 1] as string
  return {
    frames: frames.filter(frame => frame.frameId !== evicted),
    order: order.slice(0, -1),
  }
}
