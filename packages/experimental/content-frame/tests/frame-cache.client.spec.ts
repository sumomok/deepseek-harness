/**
 * The page seat's keepalive bookkeeping. Two properties carry everything the
 * browser cares about and both are asserted here: the rendered list is
 * append-only (React moves a keyed child whose position changes, and moving an
 * iframe reloads it), and the frame on display is never the one evicted.
 *
 * Frame ids are `"<session> <page>"`, so the fixtures below are one session's
 * two pages and a second session's page — the three ways a frame is reached.
 */

import { describe, expect, it } from 'vitest'
import { foldFrames, NO_FRAMES, type CachedFrame, type FrameCache } from '../src/client/frame-cache.ts'

const A: CachedFrame = { frameId: 'a home', url: '/content-app/' }
const B: CachedFrame = { frameId: 'b reports', url: '/content-app/reports/' }
const C: CachedFrame = { frameId: 'c home', url: '/content-app/' }

/** Fold a run of active frames from the empty cache. */
function run(limit: number, ...actives: (CachedFrame | undefined)[]): FrameCache {
  return actives.reduce<FrameCache>((cache, active) => foldFrames(cache, active, limit), NO_FRAMES)
}

/** Mount order of the rendered list. */
function mounted(cache: FrameCache): string[] {
  return cache.frames.map(frame => frame.frameId)
}

describe('foldFrames', () => {
  it('opens the cache with the first frame shown', () => {
    expect(run(3, A)).toEqual({ frames: [A], order: ['a home'] })
  })

  it('returns the same cache when the active frame is already the most recent', () => {
    const cache = run(3, A)
    expect(foldFrames(cache, { ...A }, 3)).toBe(cache)
  })

  it('never reorders the rendered list, so no frame is ever moved in the DOM', () => {
    const cache = run(3, A, B, C, A, B, A)
    expect(mounted(cache)).toEqual(['a home', 'b reports', 'c home'])
    // Recency moved instead; it is what eviction reads and it never reaches the DOM.
    expect(cache.order).toEqual(['a home', 'b reports', 'c home'])
  })

  it('leaves a returning frame\'s entry untouched, so its document survives the round trip', () => {
    const first = run(3, A)
    const back = foldFrames(foldFrames(first, B, 3), { ...A }, 3)
    // The same entry object: its `src` never changes, so React touches nothing.
    expect(back.frames[0]).toBe(first.frames[0])
  })

  it('retains every frame while the seat shows none', () => {
    const cache = run(3, A, B)
    expect(foldFrames(cache, undefined, 3)).toBe(cache)
  })

  it('navigates a cached frame in place when its page url moved under it', () => {
    const before = run(3, B, A)
    const moved = foldFrames(before, { frameId: 'a home', url: '/content-app/reports/' }, 3)
    // One entry per frame id still, in the same mount order: the frame
    // navigates rather than a second one mounting beside it.
    expect(moved.frames).toEqual([B, { frameId: 'a home', url: '/content-app/reports/' }])
    // The other frame's entry is the very same object, so React leaves it be.
    expect(moved.frames[0]).toBe(before.frames[0])
  })

  it('evicts the least recently shown frame past the bound', () => {
    const cache = run(2, A, B, C)
    expect(mounted(cache)).toEqual(['b reports', 'c home'])
    expect(cache.order).toEqual(['c home', 'b reports'])
  })

  it('never evicts the frame on display, even at a bound of one', () => {
    expect(run(1, A, B)).toEqual({ frames: [B], order: ['b reports'] })
  })
})
