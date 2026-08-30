/**
 * `captureNavSnapshot`'s reduction of a `contentSurface` projection value to
 * an oldest-first page-id list.
 */
import { describe, expect, it } from 'vitest'
import { captureNavSnapshot } from '../src/client/nav-snapshot.ts'

describe('captureNavSnapshot', () => {
  it('answers empty for an undefined projection value', () => {
    expect(captureNavSnapshot(undefined)).toEqual([])
  })

  it('answers empty when there are no page-kind entries', () => {
    expect(captureNavSnapshot({ entries: [{ kind: 'chart', entryId: 'c1', seq: 1, title: 'Chart', payload: {} }] }))
      .toEqual([])
  })

  it('reverses newest-first entries to oldest-first, filtering to page kind only', () => {
    const view = {
      entries: [
        { kind: 'page', entryId: 'reports', seq: 3, title: 'Reports', payload: {} },
        { kind: 'chart', entryId: 'c1', seq: 2, title: 'Chart', payload: {} },
        { kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: {} },
      ],
    }
    expect(captureNavSnapshot(view)).toEqual(['home', 'reports'])
  })
})
