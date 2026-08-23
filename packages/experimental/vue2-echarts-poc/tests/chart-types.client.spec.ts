/**
 * The chart vocabulary this row shares with its consumers: the supported set
 * both the module registration and a validating host read, and the point
 * counter both sides of the verdict use.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { describe, expect, it } from 'vitest'
import { countSeriesPoints, SUPPORTED_SERIES_TYPES } from '../src/chart-types.ts'

describe('SUPPORTED_SERIES_TYPES', () => {
  it('is the bar/line/pie set, in the order a description lists it', () => {
    expect(SUPPORTED_SERIES_TYPES).toEqual(['bar', 'line', 'pie'])
  })
})

describe('countSeriesPoints', () => {
  it('sums the data entries of every series', () => {
    expect(countSeriesPoints([{ data: [1, 2, 3] }, { data: [{ value: 4 }] }])).toBe(4)
  })

  it('counts nothing for an empty list', () => {
    expect(countSeriesPoints([])).toBe(0)
  })

  it('skips a series whose data is not an inline array', () => {
    // A dataset-driven or transform-driven series carries no `data`; a
    // malformed one may carry anything at all.
    expect(countSeriesPoints([{ type: 'bar' }, { data: 'nope' }, { data: [7] }])).toBe(1)
  })

  it('skips entries that are not series objects at all', () => {
    expect(countSeriesPoints([null, 'bar', 42, { data: [1] }])).toBe(1)
  })
})
