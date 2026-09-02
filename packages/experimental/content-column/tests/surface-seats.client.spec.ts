/**
 * The column's two pure decisions. The seat list must never reorder or shorten
 * — a moved iframe reloads and an unmounted one dies — and the selection reads
 * two sources: the click the column is still waiting on, and the front the
 * host recorded.
 */

import { describe, expect, it } from 'vitest'
import type { ContentSurfaceEntry } from '@deepseek-ai/dsh-experimental-content-surface/types'
import { entryKeyOf, foldSeats, NO_SEATS, pickedAt, selectedEntry } from '../src/client/surface-seats.ts'

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

describe('pickedAt', () => {
  it('takes the click against the newest entry of the moment', () => {
    expect(pickedAt([CHART, PAGE], entryKeyOf(PAGE))).toEqual({ key: 'page reports', atSeq: CHART.seq })
  })

  it('takes a click against an empty stream, which selectedEntry answers the same way regardless', () => {
    const picked = pickedAt([], 'page reports')
    expect(picked).toEqual({ key: 'page reports', atSeq: 0 })
    expect(selectedEntry([], picked, undefined)).toBeUndefined()
  })
})

describe('selectedEntry', () => {
  /** A click on one entry, taken against the newest entry of the moment. */
  const pick = (entry: ContentSurfaceEntry, atSeq: number): { key: string; atSeq: number } =>
    ({ key: entryKeyOf(entry), atSeq })

  it('shows the newest entry when nothing was clicked and nothing is recorded', () => {
    expect(selectedEntry([CHART, PAGE], undefined, undefined)).toBe(CHART)
  })

  it('shows nothing when the session has no entries', () => {
    expect(selectedEntry([], pick(PAGE, 9), { kind: PAGE.kind, entryId: PAGE.entryId })).toBeUndefined()
  })

  it('shows the entry the host recorded in front, with no local click at all', () => {
    // A reloaded page holds no click; the log is the whole answer.
    expect(selectedEntry([CHART, PAGE], undefined, { kind: 'page', entryId: 'reports' })).toBe(PAGE)
  })

  it('falls back to the newest entry when the recorded front is no longer live', () => {
    expect(selectedEntry([CHART], undefined, { kind: 'page', entryId: 'reports' })).toBe(CHART)
  })

  it('shows the entry just clicked, before the record of it comes back', () => {
    expect(selectedEntry([CHART, PAGE], pick(PAGE, CHART.seq), undefined)).toBe(PAGE)
  })

  it('gives an unrecorded click up to an entry recorded after it', () => {
    // The agent showed something after the click: `entries[0]` is newer than
    // the entry the user was choosing against, and that entry is what the
    // column moves to — the same rule the host applies to `front`.
    const shown = entry('page', 'home', 12)
    expect(selectedEntry([shown, CHART, PAGE], pick(PAGE, CHART.seq), undefined)).toBe(shown)
  })

  it('falls back past a click whose entry was replaced or dismissed', () => {
    // A dismissed entry leaves `entries` rather than being replaced in it
    // (unlike a redrawn chart), and this function reads the same "clicked key
    // absent from entries" signal either way.
    expect(selectedEntry([CHART], pick(PAGE, CHART.seq), undefined)).toBe(CHART)
  })

  it('prefers the click it is still waiting on over the front recorded before it', () => {
    expect(selectedEntry([CHART, PAGE], pick(PAGE, CHART.seq), { kind: 'chart', entryId: 'sales' })).toBe(PAGE)
  })
})
