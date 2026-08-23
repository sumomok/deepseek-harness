/**
 * The three ECharts features that turn a model-supplied option into a document
 * the browser interprets, and what the row does about each of them. These are
 * the trust decisions the package README states, so each one is pinned.
 */
import { describe, expect, it } from 'vitest'
import { sanitizeChartOption } from '../src/client/sanitize.ts'

describe('sanitizeChartOption', () => {
  it('forces rich-text tooltips, so a model-supplied formatter is drawn, not parsed', () => {
    const sanitized = sanitizeChartOption({
      series: [{ type: 'bar', data: [1] }],
      tooltip: { trigger: 'axis', formatter: '<img src=x onerror="alert(1)">' },
    })
    expect(sanitized.tooltip).toEqual({
      trigger: 'axis',
      formatter: '<img src=x onerror="alert(1)">',
      renderMode: 'richText',
    })
  })

  it('overrides an HTML render mode the option asked for', () => {
    const sanitized = sanitizeChartOption({ series: [], tooltip: { renderMode: 'html' } })
    expect(sanitized.tooltip).toEqual({ renderMode: 'richText' })
  })

  it('adds the rich-text tooltip to an option that declared none', () => {
    expect(sanitizeChartOption({ series: [] }).tooltip).toEqual({ renderMode: 'richText' })
  })

  it('ignores a tooltip that is not an object', () => {
    expect(sanitizeChartOption({ series: [], tooltip: 'yes' }).tooltip).toEqual({ renderMode: 'richText' })
  })

  it('drops graphic elements whole', () => {
    const sanitized = sanitizeChartOption({
      series: [{ type: 'bar', data: [1] }],
      graphic: [{ type: 'image', style: { image: 'https://example.invalid/x.png' } }],
    })
    expect(Object.hasOwn(sanitized, 'graphic')).toBe(false)
  })

  it('drops remote-asset symbols wherever they appear', () => {
    const sanitized = sanitizeChartOption({
      series: [{
        type: 'line',
        data: [1],
        symbol: 'image://https://example.invalid/pin.png',
      }],
      legend: { icon: 'circle', itemStyle: { image: 'image://https://example.invalid/legend.png' } },
    })
    const series = (sanitized.series as Record<string, unknown>[])[0] as Record<string, unknown>
    expect(Object.hasOwn(series, 'symbol')).toBe(false)
    const legend = sanitized.legend as { icon: string; itemStyle: Record<string, unknown> }
    expect(Object.hasOwn(legend.itemStyle, 'image')).toBe(false)
    // A built-in symbol name is not an asset reference and stays.
    expect(legend.icon).toBe('circle')
  })

  it('keeps a symbol that names a built-in shape', () => {
    const sanitized = sanitizeChartOption({ series: [{ type: 'line', data: [1], symbol: 'triangle' }] })
    expect((sanitized.series as Record<string, unknown>[])[0]).toEqual({
      type: 'line',
      data: [1],
      symbol: 'triangle',
    })
  })

  it('leaves everything else exactly as the model wrote it', () => {
    const option = {
      title: { text: 'Revenue', subtext: '2026' },
      xAxis: { type: 'category', data: ['Q1', 'Q2'] },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', name: 'Revenue', data: [1, 2], itemStyle: { color: '#4c6ef5' } }],
      legend: { data: ['Revenue'] },
    }
    const { tooltip: _forced, ...rest } = sanitizeChartOption(option)
    expect(rest).toEqual(option)
  })

  it('copies rather than rewrites the option it was handed', () => {
    const option = { series: [{ type: 'bar', data: [1], symbol: 'image://x' }] }
    sanitizeChartOption(option)
    expect(option.series[0]?.symbol).toBe('image://x')
  })
})
