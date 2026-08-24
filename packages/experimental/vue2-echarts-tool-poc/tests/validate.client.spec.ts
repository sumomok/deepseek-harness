/**
 * The first layer `show_chart` puts in front of a model-supplied option: the
 * deployment bounds and the supported series set. Every refusal is text the
 * model reads and corrects itself from, so each one is pinned verbatim.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { SUPPORTED_SERIES_LIST, validateChartId, validateChartOption } from '../src/validate.ts'
import type { ChartLimits } from '../src/validate.ts'

/** Bounds wide enough that only the case under test can fail. */
const LIMITS: ChartLimits = { maxOptionBytes: 65536, maxPoints: 2000 }

describe('validateChartOption', () => {
  it('accepts every supported series type', () => {
    const series = [
      { type: 'bar', data: [1, 2] },
      { type: 'line', data: [3] },
      { type: 'pie', data: [{ value: 4 }] },
      { type: 'radar', data: [{ value: [5, 6, 7] }] },
    ]
    expect(validateChartOption({ series }, LIMITS)).toBeUndefined()
  })

  it('names the supported set as the description does', () => {
    expect(SUPPORTED_SERIES_LIST).toBe('bar, line, pie, radar')
  })

  it('refuses an option past the byte ceiling, naming both numbers', () => {
    const option = { series: [{ type: 'bar', data: [1] }], title: { text: 'x'.repeat(200) } }
    expect(validateChartOption(option, { maxOptionBytes: 64, maxPoints: 2000 })).toBe(
      'show_chart: the option is 258 bytes; this deployment accepts at most 64. Send fewer points or shorter labels.',
    )
  })

  it('measures the byte ceiling in UTF-8, not characters', () => {
    // Four three-byte characters in a label put the same option past a limit a
    // character count would clear.
    const option = { series: [{ type: 'bar', data: [1], name: '四个汉字' }] }
    expect(validateChartOption(option, { maxOptionBytes: 50, maxPoints: 2000 })).toBe(
      'show_chart: the option is 60 bytes; this deployment accepts at most 50. Send fewer points or shorter labels.',
    )
  })

  it('accepts an option exactly at the byte ceiling', () => {
    const option = { series: [{ type: 'bar', data: [1] }] }
    const exact = Buffer.byteLength(JSON.stringify(option), 'utf8')
    expect(validateChartOption(option, { maxOptionBytes: exact, maxPoints: 2000 })).toBeUndefined()
  })

  it('refuses an empty series list', () => {
    expect(validateChartOption({ series: [] }, LIMITS)).toBe(
      'show_chart: option.series must list at least one series.',
    )
  })

  it('refuses an unsupported series type and lists what is supported', () => {
    const series = [{ type: 'bar', data: [1] }, { type: 'scatter', data: [2] }]
    expect(validateChartOption({ series }, LIMITS)).toBe(
      'show_chart: unsupported series type "scatter" at series[1]. Supported types: bar, line, pie, radar.',
    )
  })

  it('refuses a series that declares no type', () => {
    expect(validateChartOption({ series: [{ data: [1] }] }, LIMITS)).toBe(
      'show_chart: unsupported series type none at series[0]. Supported types: bar, line, pie, radar.',
    )
  })

  it('refuses a series entry that is not an object at all', () => {
    expect(validateChartOption({ series: ['bar'] }, LIMITS)).toBe(
      'show_chart: unsupported series type none at series[0]. Supported types: bar, line, pie, radar.',
    )
  })

  it('refuses a null series entry', () => {
    expect(validateChartOption({ series: [null] }, LIMITS)).toBe(
      'show_chart: unsupported series type none at series[0]. Supported types: bar, line, pie, radar.',
    )
  })

  it('refuses more points than the deployment accepts, counting across series', () => {
    const series = [{ type: 'bar', data: [1, 2] }, { type: 'line', data: [3, 4] }]
    expect(validateChartOption({ series }, { maxOptionBytes: 65536, maxPoints: 3 })).toBe(
      'show_chart: the option carries 4 data points; this deployment accepts at most 3. Aggregate the data before charting it.',
    )
  })

  it('accepts a point total exactly at the ceiling', () => {
    const series = [{ type: 'bar', data: [1, 2] }, { type: 'line', data: [3] }]
    expect(validateChartOption({ series }, { maxOptionBytes: 65536, maxPoints: 3 })).toBeUndefined()
  })
})

describe('validateChartId', () => {
  it('accepts a call that names no chart id', () => {
    expect(validateChartId(undefined)).toBeUndefined()
  })

  it('accepts an id the model can reuse verbatim', () => {
    expect(validateChartId('weekly-revenue')).toBeUndefined()
  })

  it('accepts an id padded with whitespace, which names the same chart', () => {
    expect(validateChartId('  weekly-revenue  ')).toBeUndefined()
  })

  it('refuses a blank id rather than treating it as absent', () => {
    for (const blank of ['', '   ', '\n']) {
      expect(validateChartId(blank)).toBe(
        'show_chart: id must not be blank. Omit it for a new chart, or pass the id of the chart this call replaces.',
      )
    }
  })

  it('accepts an id exactly at the length ceiling', () => {
    expect(validateChartId('x'.repeat(64))).toBeUndefined()
  })

  it('refuses an id past the length ceiling, naming both numbers', () => {
    expect(validateChartId('x'.repeat(65))).toBe(
      'show_chart: id is 65 characters; at most 64 are accepted. Use a short stable id such as "weekly-revenue".',
    )
  })
})
