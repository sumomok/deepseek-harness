/**
 * Track solver behavior: the 24-unit ratio the product line is defined by, the
 * fixed points (rail width, session floor, details band, content-empty
 * collapse), the narrow-frame fold that takes the session column out of the
 * grid below the breakpoint, and the two properties every frame must hold —
 * the tracks tile the frame exactly, and the solve is a pure function of its
 * inputs, so re-widening restores the ratio without hysteresis.
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_UNITS, CONTENT_UNITS, DETAILS_WIDTH, isNarrow, SESSION_MIN, SESSION_RAIL,
  SESSION_UNITS, SIDEBAR_AUTO_COLLAPSE, solveTracks, TOTAL_UNITS,
} from '../src/client/tracks.ts'

/** A frame width divisible by 24 so the ratio lands on whole pixels. */
const FRAME = 1680

describe('isNarrow', () => {
  it('is false at exactly the breakpoint and true one pixel below it', () => {
    expect(isNarrow(SIDEBAR_AUTO_COLLAPSE)).toBe(false)
    expect(isNarrow(SIDEBAR_AUTO_COLLAPSE - 1)).toBe(true)
  })

  it('is false for a wide frame and true for a phone-width one', () => {
    expect(isNarrow(2400)).toBe(false)
    expect(isNarrow(500)).toBe(true)
  })
})

describe('solveTracks', () => {
  it('splits an expanded frame on the 3:16:5 ratio', () => {
    const tracks = solveTracks(FRAME, false, false, false, false)
    expect(tracks).toEqual({
      session: (FRAME * SESSION_UNITS) / TOTAL_UNITS,
      content: (FRAME * CONTENT_UNITS) / TOTAL_UNITS,
      chat: (FRAME * CHAT_UNITS) / TOTAL_UNITS,
      details: 0,
    })
  })

  it('folds the session column to the control rail and leaves 16:5 behind it', () => {
    const tracks = solveTracks(FRAME, true, false, false, false)
    expect(tracks.session).toBe(SESSION_RAIL)
    const body = FRAME - SESSION_RAIL
    expect(tracks.content).toBe(Math.round((body * CONTENT_UNITS) / (CONTENT_UNITS + CHAT_UNITS)))
    expect(tracks.chat).toBe(body - tracks.content)
  })

  it('takes the details band off the top and re-splits what remains', () => {
    const open = solveTracks(FRAME, false, true, false, false)
    expect(open.details).toBe(DETAILS_WIDTH)
    expect(open).toEqual({ ...solveTracks(FRAME - DETAILS_WIDTH, false, false, false, false), details: DETAILS_WIDTH })
  })

  it('restores the closed solve exactly when details close again', () => {
    expect(solveTracks(FRAME, false, true, false, false)).not.toEqual(solveTracks(FRAME, false, false, false, false))
    expect(solveTracks(FRAME, false, false, false, false)).toEqual(solveTracks(FRAME, false, false, false, false))
  })

  it.each([120, 320, 500, 977, 1024, 1440, 1681, 3840])('tiles a %ipx frame with no gap or overflow', (width) => {
    for (const folded of [false, true]) {
      for (const details of [false, true]) {
        for (const contentEmpty of [false, true]) {
          for (const narrow of [false, true]) {
            const tracks = solveTracks(width, folded, details, contentEmpty, narrow)
            expect(tracks.session + tracks.content + tracks.chat + tracks.details).toBe(width)
          }
        }
      }
    }
  })

  it('holds the expanded session column at its floor on a narrow-but-wide frame', () => {
    const tracks = solveTracks(500, false, false, true, false)
    expect(tracks).toEqual({ session: SESSION_MIN, content: 0, chat: 320, details: 0 })
  })

  it('takes the session column out of the grid below the breakpoint', () => {
    const tracks = solveTracks(500, false, false, true, true)
    expect(tracks).toEqual({ session: 0, content: 0, chat: 500, details: 0 })
  })

  it('divides the whole frame between content and chat when narrow with content to show', () => {
    const tracks = solveTracks(504, false, false, false, true)
    expect(tracks.session).toBe(0)
    expect(tracks.content).toBe(Math.round((504 * CONTENT_UNITS) / (CONTENT_UNITS + CHAT_UNITS)))
    expect(tracks.content + tracks.chat).toBe(504)
  })

  it('zeroes the session column when narrow even if it is also marked folded', () => {
    expect(solveTracks(500, true, false, false, true).session).toBe(0)
  })

  it('keeps the details band while narrow and gives the rest to content and chat', () => {
    const tracks = solveTracks(900, false, true, true, true)
    expect(tracks.session).toBe(0)
    expect(tracks.details).toBe(DETAILS_WIDTH)
    expect(tracks.chat).toBe(900 - DETAILS_WIDTH)
  })

  it('stays on the grid at exactly the breakpoint (session at its floor)', () => {
    const { session } = solveTracks(SIDEBAR_AUTO_COLLAPSE, false, false, false, isNarrow(SIDEBAR_AUTO_COLLAPSE))
    expect(session).toBe(SESSION_MIN)
  })

  it('leaves the grid one pixel below the breakpoint (session zero)', () => {
    const width = SIDEBAR_AUTO_COLLAPSE - 1
    const { session } = solveTracks(width, false, false, false, isNarrow(width))
    expect(session).toBe(0)
  })

  it('meets the floor exactly where the ratio does, so a 1440px frame solves on the ratio', () => {
    const { session } = solveTracks(1440, false, false, false, false)
    expect(session).toBe(SESSION_MIN)
    expect(session).toBe((1440 * SESSION_UNITS) / TOTAL_UNITS)
  })

  it('lets the ratio win above the floor', () => {
    expect(solveTracks(2400, false, false, false, false).session).toBe(300)
  })

  it('clamps the floor to the frame rather than overflowing it', () => {
    expect(solveTracks(120, false, false, false, false)).toEqual({ session: 120, content: 0, chat: 0, details: 0 })
  })

  it('applies the floor to what the details band leaves, not to the frame', () => {
    const tracks = solveTracks(500, false, true, true, false)
    expect(tracks).toEqual({ session: 140, content: 0, chat: 0, details: DETAILS_WIDTH })
  })

  it('does not lift a folded rail on a narrow-but-wide frame', () => {
    expect(solveTracks(500, true, false, false, false).session).toBe(SESSION_RAIL)
  })

  it('keeps every track non-negative on a frame narrower than its fixed points', () => {
    const tracks = solveTracks(200, true, true, true, false)
    expect(tracks.details).toBe(200)
    expect(tracks).toEqual({ session: 0, content: 0, chat: 0, details: 200 })
  })

  it('degrades a zero-width frame to zero tracks rather than negative ones', () => {
    expect(solveTracks(-40, false, false, false, false)).toEqual({ session: 0, content: 0, chat: 0, details: 0 })
  })

  it('gives a folded frame more content and chat than an expanded one', () => {
    const expanded = solveTracks(FRAME, false, false, false, false)
    const folded = solveTracks(FRAME, true, false, false, false)
    expect(folded.content).toBeGreaterThan(expanded.content)
    expect(folded.chat).toBeGreaterThan(expanded.chat)
  })

  it('collapses the content column to zero and hands its whole share to chat', () => {
    const open = solveTracks(FRAME, false, false, false, false)
    const empty = solveTracks(FRAME, false, false, true, false)
    expect(empty.content).toBe(0)
    expect(empty.chat).toBe(open.content + open.chat)
    expect(empty.session).toBe(open.session)
    expect(empty.details).toBe(open.details)
  })

  it('restores the open solve exactly once content is no longer empty', () => {
    expect(solveTracks(FRAME, false, false, true, false)).not.toEqual(solveTracks(FRAME, false, false, false, false))
    expect(solveTracks(FRAME, false, false, false, false)).toEqual(solveTracks(FRAME, false, false, false, false))
  })

  it('collapses content the same way alongside a folded session and an open details band', () => {
    const tracks = solveTracks(FRAME, true, true, true, false)
    expect(tracks.content).toBe(0)
    expect(tracks.details).toBe(DETAILS_WIDTH)
    expect(tracks.session).toBe(SESSION_RAIL)
    expect(tracks.session + tracks.content + tracks.chat + tracks.details).toBe(FRAME)
  })
})
