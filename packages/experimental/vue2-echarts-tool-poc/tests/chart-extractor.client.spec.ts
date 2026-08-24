/**
 * The `chart` extractor: both log shapes a chart call takes, the id that
 * identifies an entry, and the caption a call without a title falls back to.
 *
 * The supersede rule itself is the router's — one record per (kind, id) — so
 * what this file proves is that the extractor names the same chart the
 * transcript's own projection names, which is what makes a redraw one entry.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { CHART_KIND, chartExtractor } from '../src/surface.ts'

const extractor = chartExtractor()

const OPTION = { series: [{ type: 'bar', data: [1, 2, 3] }] }

/** One committed event, as the fold delivers it. */
function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

/** A top-level `show_chart` call, whose arguments are raw JSON. */
function toolCall(callId: string, args: unknown): SessionEvent {
  return event('tool/call', { turn: 1, step: 1, callId, name: 'show_chart', arguments: JSON.stringify(args) })
}

/** A Code Mode dispatch of the same tool, whose arguments are already decoded. */
function codeDispatch(subCallId: string, args: unknown): SessionEvent {
  return event('tool/code-dispatch-start', { turn: 1, step: 1, subCallId, name: 'show_chart', arguments: args })
}

describe('chart extractor', () => {
  it('owns the chart kind', () => {
    expect(extractor.kind).toBe(CHART_KIND)
  })

  it('reads a top-level call under the chart id it named', () => {
    expect(extractor.read(toolCall('call_1', { id: 'sales', title: 'Revenue', option: OPTION })))
      .toEqual({ entryId: 'sales', data: { title: 'Revenue', option: OPTION } })
  })

  it('reads a Code Mode call the same way, under its sub-call id', () => {
    expect(extractor.read(codeDispatch('sub_1', { id: 'sales', title: 'Revenue', option: OPTION })))
      .toEqual({ entryId: 'sales', data: { title: 'Revenue', option: OPTION } })
  })

  it('makes a call that named no id its own chart, listed under that call id', () => {
    expect(extractor.read(toolCall('call_2', { option: OPTION })))
      .toEqual({ entryId: 'call_2', data: { title: 'call_2', option: OPTION } })
  })

  it('gives two calls sharing an id one entry id, so the later one replaces the earlier', () => {
    const older = extractor.read(toolCall('call_3', { id: 'sales', title: 'First draft', option: OPTION }))
    const newer = extractor.read(toolCall('call_4', { id: 'sales', title: 'Final', option: OPTION }))
    expect(older?.entryId).toBe(newer?.entryId)
  })

  it('reads nothing from another tool, an unreadable call, or an unrelated event', () => {
    expect(extractor.read(event('tool/call', { turn: 1, step: 1, callId: 'c', name: 'bash', arguments: '{}' }))).toBeUndefined()
    expect(extractor.read(toolCall('call_5', { title: 'no option' }))).toBeUndefined()
    expect(extractor.read(event('turn/end', {}))).toBeUndefined()
  })

  it('resolves a record into its caption and the option its renderer paints', () => {
    expect(extractor.resolve({ title: 'Revenue', option: OPTION }))
      .toEqual({ title: 'Revenue', payload: { option: OPTION } })
  })
})
