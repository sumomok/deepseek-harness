/**
 * The `page` extractor: which logged events become entries, what identifies
 * one, and how a recorded id resolves against the page list running now —
 * including the id a deployment retired, which keeps its entry rather than
 * vanishing from the session's history.
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { indexPages } from '../src/pages.ts'
import { frontEntry, PAGE_KIND, pageExtractor } from '../src/surface.ts'
import type { ContentSurfaceView } from '@deepseek-ai/dsh-experimental-content-surface/types'
import type { ContentPage } from '../src/types.ts'

const PAGES: ContentPage[] = [
  { id: 'dashboard', title: 'Fleet dashboard', description: 'Live status.', url: '/content-app/' },
  { id: 'reports', title: 'Weekly reports', description: 'Newest first.', url: '/content-app/reports/' },
]

const extractor = pageExtractor(indexPages(PAGES, undefined))

/** One committed event, as the fold delivers it. */
function event(type: string, data: unknown, seq = 0): SessionEvent {
  return { type, seq, time: 0, data } as SessionEvent
}

describe('page extractor', () => {
  it('owns the page kind', () => {
    expect(extractor.kind).toBe(PAGE_KIND)
  })

  it('records the page a `content/shown` event names, under that page id', () => {
    expect(extractor.read(event('content/shown', { page: 'reports', by: 'user' })))
      .toEqual({ entryId: 'reports', data: { page: 'reports', by: 'user' } })
  })

  it('defaults a pre-`by` log to \'agent\', the only writer that existed then', () => {
    expect(extractor.read(event('content/shown', { page: 'reports' })))
      .toEqual({ entryId: 'reports', data: { page: 'reports', by: 'agent' } })
  })

  it('records nothing for a cleared column or an unrelated event', () => {
    expect(extractor.read(event('content/shown', { page: null }))).toBeUndefined()
    expect(extractor.read(event('turn/end', {}))).toBeUndefined()
  })

  it('resolves a configured page into its current title and view, carrying the writer', () => {
    expect(extractor.resolve({ page: 'reports', by: 'user' })).toEqual({
      title: 'Weekly reports',
      payload: { state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports', by: 'user' },
    })
  })

  it('keeps a retired page as an entry named by the id the log recorded', () => {
    expect(extractor.resolve({ page: 'retired', by: 'agent' })).toEqual({
      title: 'retired',
      payload: { state: 'missing', page: 'retired', by: 'agent' },
    })
  })
})

describe('the entry a column has in front', () => {
  /** One published stream, as the projection's view hands it over. */
  function view(over: Partial<ContentSurfaceView>): ContentSurfaceView {
    return {
      entries: [{ kind: PAGE_KIND, entryId: 'reports', seq: 2, title: 'Weekly reports', payload: {} }],
      ...over,
    }
  }

  it('names it by the title the switcher shows', () => {
    expect(frontEntry(view({ front: { kind: PAGE_KIND, entryId: 'reports' } })))
      .toMatchObject({ kind: PAGE_KIND, title: 'Weekly reports' })
  })

  it('answers nothing for an empty column, a column nobody publishes, and a front the stream lost', () => {
    // The three ways the one refusal that reads this gets no entry, and every
    // one of them earns the same advice: a composition with no projection
    // registry, a session that has produced nothing, and a `front` naming an
    // entry that has since been dismissed.
    expect(frontEntry(undefined)).toBeUndefined()
    expect(frontEntry(view({ entries: [] }))).toBeUndefined()
    expect(frontEntry(view({ front: { kind: PAGE_KIND, entryId: 'home' } }))).toBeUndefined()
  })
})
