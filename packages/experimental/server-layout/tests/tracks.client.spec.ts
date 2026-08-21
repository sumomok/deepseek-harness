/**
 * Track solver behavior: the 24-unit ratio the product line is defined by, the
 * fixed points (rail width, details band), and the two properties every frame
 * must hold — the tracks tile the frame exactly, and the solve is a pure
 * function of its inputs, so re-widening restores the ratio without hysteresis.
 */
import { describe, expect, it } from 'vitest'
import {
  CHAT_UNITS, CONTENT_UNITS, DETAILS_WIDTH, SESSION_RAIL, SESSION_UNITS, solveTracks, TOTAL_UNITS,
} from '../src/client/tracks.ts'

/** A frame width divisible by 24 so the ratio lands on whole pixels. */
const FRAME = 1680

describe('solveTracks', () => {
  it('splits an expanded frame on the 3:16:5 ratio', () => {
    const tracks = solveTracks(FRAME, false, false)
    expect(tracks).toEqual({
      session: (FRAME * SESSION_UNITS) / TOTAL_UNITS,
      content: (FRAME * CONTENT_UNITS) / TOTAL_UNITS,
      chat: (FRAME * CHAT_UNITS) / TOTAL_UNITS,
      details: 0,
    })
  })

  it('folds the session column to the control rail and leaves 16:5 behind it', () => {
    const tracks = solveTracks(FRAME, true, false)
    expect(tracks.session).toBe(SESSION_RAIL)
    const body = FRAME - SESSION_RAIL
    expect(tracks.content).toBe(Math.round((body * CONTENT_UNITS) / (CONTENT_UNITS + CHAT_UNITS)))
    expect(tracks.chat).toBe(body - tracks.content)
  })

  it('takes the details band off the top and re-splits what remains', () => {
    const open = solveTracks(FRAME, false, true)
    expect(open.details).toBe(DETAILS_WIDTH)
    expect(open).toEqual({ ...solveTracks(FRAME - DETAILS_WIDTH, false, false), details: DETAILS_WIDTH })
  })

  it('restores the closed solve exactly when details close again', () => {
    expect(solveTracks(FRAME, false, true)).not.toEqual(solveTracks(FRAME, false, false))
    expect(solveTracks(FRAME, false, false)).toEqual(solveTracks(FRAME, false, false))
  })

  it.each([320, 977, 1024, 1440, 1681, 3840])('tiles a %ipx frame with no gap or overflow', (width) => {
    for (const folded of [false, true]) {
      for (const details of [false, true]) {
        const tracks = solveTracks(width, folded, details)
        expect(tracks.session + tracks.content + tracks.chat + tracks.details).toBe(width)
      }
    }
  })

  it('keeps every track non-negative on a frame narrower than its fixed points', () => {
    const tracks = solveTracks(200, true, true)
    expect(tracks.details).toBe(200)
    expect(tracks).toEqual({ session: 0, content: 0, chat: 0, details: 200 })
  })

  it('degrades a zero-width frame to zero tracks rather than negative ones', () => {
    expect(solveTracks(-40, false, false)).toEqual({ session: 0, content: 0, chat: 0, details: 0 })
  })

  it('gives a folded frame more content and chat than an expanded one', () => {
    const expanded = solveTracks(FRAME, false, false)
    const folded = solveTracks(FRAME, true, false)
    expect(folded.content).toBeGreaterThan(expanded.content)
    expect(folded.chat).toBeGreaterThan(expanded.chat)
  })
})
