/**
 * `captureNavSnapshot`'s reduction of a `contentSurface` projection value to
 * an oldest-first list of navigation stops, and the kind translation it owns
 * between a menu's vocabulary and the content column's.
 */
import { describe, expect, it } from 'vitest'
import { COMPONENT_KIND } from '@deepseek-ai/dsh-experimental-component-surface/src/component-call.ts'
import { captureNavSnapshot, navKindOf, surfaceKindOf } from '../src/client/nav-snapshot.ts'

describe('surfaceKindOf', () => {
  it('maps a view onto the entry kind component-surface actually records', () => {
    // A deliberate literal copy, made mechanically checkable here for the
    // reason nav-catalog.ts's route paths are: a drift shows up as a workbench
    // that never recognizes its own home view and nothing else.
    expect(surfaceKindOf('view')).toBe(COMPONENT_KIND)
  })

  it('maps a page onto content-frame\'s own entry kind', () => {
    expect(surfaceKindOf('page')).toBe('page')
  })
})

describe('navKindOf', () => {
  it('reads each navigable entry kind back', () => {
    expect(navKindOf('page')).toBe('page')
    expect(navKindOf('component')).toBe('view')
  })

  it('answers undefined for an entry no navigation gesture can produce', () => {
    expect(navKindOf('chart')).toBeUndefined()
  })

  it('answers undefined for an entry whose kind is not even a string', () => {
    expect(navKindOf(42)).toBeUndefined()
  })
})

describe('captureNavSnapshot', () => {
  const CATALOG = [
    { kind: 'page' as const, entryId: 'home' },
    { kind: 'page' as const, entryId: 'reports' },
    { kind: 'view' as const, entryId: 'sales' },
  ]

  it('answers empty for an undefined projection value', () => {
    expect(captureNavSnapshot(undefined, CATALOG)).toEqual([])
  })

  it('answers empty when nothing on record came from a navigation gesture', () => {
    expect(captureNavSnapshot({ entries: [{ kind: 'chart', entryId: 'c1', seq: 1, title: 'Chart', payload: {} }] }, CATALOG))
      .toEqual([])
  })

  it('reverses newest-first entries to oldest-first, keeping both navigable kinds', () => {
    const view = {
      entries: [
        { kind: 'component', entryId: 'sales', seq: 4, title: '销售看板', payload: {} },
        { kind: 'page', entryId: 'reports', seq: 3, title: 'Reports', payload: {} },
        { kind: 'chart', entryId: 'c1', seq: 2, title: 'Chart', payload: {} },
        { kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: {} },
      ],
    }
    expect(captureNavSnapshot(view, CATALOG)).toEqual([
      { kind: 'page', entryId: 'home' },
      { kind: 'page', entryId: 'reports' },
      { kind: 'view', entryId: 'sales' },
    ])
  })

  it('drops a component entry the model showed itself, which names no configured view', () => {
    const view = {
      entries: [
        { kind: 'component', entryId: 'budget-confirm', seq: 2, title: '确认预算', payload: {} },
        { kind: 'page', entryId: 'home', seq: 1, title: 'Home', payload: {} },
      ],
    }
    expect(captureNavSnapshot(view, CATALOG)).toEqual([{ kind: 'page', entryId: 'home' }])
  })

  it('drops an entry whose page the deployment no longer configures', () => {
    const view = { entries: [{ kind: 'page', entryId: 'reports', seq: 1, title: 'Reports', payload: {} }] }
    expect(captureNavSnapshot(view, [{ kind: 'page', entryId: 'home' }])).toEqual([])
  })

  it('does not confuse a view with a page carrying the same id', () => {
    const view = { entries: [{ kind: 'component', entryId: 'home', seq: 1, title: 'Home', payload: {} }] }
    expect(captureNavSnapshot(view, CATALOG)).toEqual([])
  })
})
