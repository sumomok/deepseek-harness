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
import { PAGE_KIND, pageExtractor } from '../src/surface.ts'
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
    expect(extractor.read(event('content/shown', { page: 'reports' }))).toEqual({ entryId: 'reports', data: 'reports' })
  })

  it('records nothing for a cleared column or an unrelated event', () => {
    expect(extractor.read(event('content/shown', { page: null }))).toBeUndefined()
    expect(extractor.read(event('turn/end', {}))).toBeUndefined()
  })

  it('resolves a configured page into its current title and view', () => {
    expect(extractor.resolve('reports')).toEqual({
      title: 'Weekly reports',
      payload: { state: 'shown', page: 'reports', url: '/content-app/reports/', title: 'Weekly reports' },
    })
  })

  it('keeps a retired page as an entry named by the id the log recorded', () => {
    expect(extractor.resolve('retired')).toEqual({
      title: 'retired',
      payload: { state: 'missing', page: 'retired' },
    })
  })
})
