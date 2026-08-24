/**
 * The column's two pure decisions. The seat list must never reorder or shorten
 * — a moved iframe reloads and an unmounted one dies — and the selection must
 * survive an entry the user picked being replaced by a later record.
 */

import { describe, expect, it } from 'vitest'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { entryKeyOf, foldSeats, NO_SEATS, selectedEntry } from '../src/client/surface-seats.ts'

/** One published entry. */
function entry(kind: string, entryId: string, seq: number): ContentSurfaceEntry {
  return { kind, entryId, seq, title: `${kind} ${entryId}`, payload: null }
}

const CHART = entry('chart', 'sales', 9)
const PAGE = entry('page', 'reports', 4)
const NOTE = entry('note', 'draft', 2)

describe('entryKeyOf', () => {
  it('qualifies an id by its kind, so two kinds never share a key', () => {
    expect(entryKeyOf(entry('page', 'x', 1))).not.toBe(entryKeyOf(entry('chart', 'x', 1)))
  })
})

describe('foldSeats', () => {
  it('opens empty and mounts a seat for each kind it first sees', () => {
    expect(foldSeats(NO_SEATS, [CHART, PAGE])).toEqual({ kinds: ['chart', 'page'] })
  })

  it('mounts one seat per kind however many entries carry it', () => {
    expect(foldSeats(NO_SEATS, [CHART, entry('chart', 'other', 8)])).toEqual({ kinds: ['chart'] })
  })

  it('returns the same seats when every kind is already mounted', () => {
    const seats = foldSeats(NO_SEATS, [CHART, PAGE])
    expect(foldSeats(seats, [PAGE, CHART])).toBe(seats)
    expect(foldSeats(seats, [])).toBe(seats)
  })

  it('appends a new kind and never moves or drops the ones before it', () => {
    const seats = foldSeats(foldSeats(NO_SEATS, [CHART, PAGE]), [NOTE])
    // NOTE arrived alone, yet the two earlier seats stay mounted and in place:
    // their renderers hold DOM the column may not destroy.
    expect(seats.kinds).toEqual(['chart', 'page', 'note'])
  })
})

describe('selectedEntry', () => {
  it('shows the newest entry when the user has picked nothing', () => {
    expect(selectedEntry([CHART, PAGE], undefined)).toBe(CHART)
  })

  it('shows the entry the user picked', () => {
    expect(selectedEntry([CHART, PAGE], entryKeyOf(PAGE))).toBe(PAGE)
  })

  it('falls back to the newest entry when the pick is no longer live', () => {
    expect(selectedEntry([CHART, PAGE], 'note draft')).toBe(CHART)
  })

  it('shows nothing when the session has no entries', () => {
    expect(selectedEntry([], entryKeyOf(PAGE))).toBeUndefined()
  })
})
