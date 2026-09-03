/**
 * The `contentPages` fold: which page each writer put in the column, and where
 * its frame went. Host-only, so there is no wire half to check — what the
 * assertions read is the state the content-column context is assembled from.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session/types'
import { contentPagesProjection } from '../src/perception/pages-projection.ts'
import type { ContentPagesState } from '../src/types.ts'

const unit = contentPagesProjection()

/** A session only for the header and inherited-prefix length `init` takes; this fold reads neither. */
const SEAT = Session.create(SessionId('content-pages'))

/** One `content/shown` event, as the fold receives it. */
function shown(page: string | null, by?: 'agent' | 'user'): SessionEvent {
  return { type: 'content/shown', seq: SessionSeq(1), time: 0, data: { page, ...by === undefined ? {} : { by } } }
}

/** One `content/navigated` event, as the fold receives it. */
function navigated(page: string, url: string, title: string): SessionEvent {
  return { type: 'content/navigated', seq: SessionSeq(2), time: 0, data: { page, url, title, by: 'user' } }
}

/** Fold a run of events from the empty state. */
function fold(events: readonly SessionEvent[]): ContentPagesState {
  return events.reduce<ContentPagesState>((state, event) => unit.apply(state, event), unit.init(SEAT.header, SEAT.inheritedEventCount))
}

describe('contentPages projection', () => {
  it('records who put each page in the column', () => {
    expect(fold([shown('home', 'user'), shown('reports', 'agent')]))
      .toEqual({ home: { by: 'user' }, reports: { by: 'agent' } })
  })

  it('reads a log written before the writer was recorded as the tool, which was the only writer then', () => {
    expect(fold([shown('home')])).toEqual({ home: { by: 'agent' } })
  })

  it('keeps the address a page was last seen at when it is shown again', () => {
    // Showing a cached page does not move it, so the location survives.
    expect(fold([shown('home', 'agent'), navigated('home', '/content-app/#/device', 'Devices'), shown('home', 'user')]))
      .toEqual({ home: { by: 'user', location: { url: '/content-app/#/device', title: 'Devices' } } })
  })

  it('records an address for a page no shown event has named yet', () => {
    // An application that redirects on load can move a frame before the event
    // that put it there reaches this fold.
    expect(fold([navigated('home', '/content-app/#/x', '')]))
      .toEqual({ home: { location: { url: '/content-app/#/x', title: '' } } })
  })

  it('replaces the address on each move, leaving every other page untouched', () => {
    expect(fold([
      shown('home', 'agent'),
      shown('reports', 'user'),
      navigated('home', '/content-app/#/a', 'A'),
      navigated('home', '/content-app/#/b', 'B'),
    ])).toEqual({
      home: { by: 'agent', location: { url: '/content-app/#/b', title: 'B' } },
      reports: { by: 'user' },
    })
  })

  it('writes nothing for a cleared column, which names no page', () => {
    const state = fold([shown('home', 'user')])
    expect(unit.apply(state, shown(null))).toBe(state)
  })

  it('keeps the same state reference for an event it does not own', () => {
    const state = fold([shown('home', 'user')])
    expect(unit.apply(state, { type: 'turn/start', seq: SessionSeq(3), time: 0, data: { turn: 1 } })).toBe(state)
  })

  it('accepts its own state back through the schema, with and without either half', () => {
    const state = fold([shown('home', 'user'), navigated('reports', '/content-app/reports/', 'R')])
    expect(unit.stateSchema.parse(state)).toEqual(state)
    // Absent rather than present and undefined: the checkpoint is JSON.
    expect(Object.hasOwn(unit.stateSchema.parse(state).reports!, 'by')).toBe(false)
  })

  it('has no client view: the browser knows where its own frames are', () => {
    expect(unit.wire).toBeUndefined()
  })
})
