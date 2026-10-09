/**
 * What of a description a reference carries: no DataPage row; a control in an
 * original-system table cell by its page, column, role and region only, its
 * column as its display target; an original-system place without an anchor
 * with no display target; every other place as described.
 */

import { describe, expect, it } from 'vitest'
import { ANCHOR_FORMAT, DESCRIBE_FORMAT } from '@haoran/dsh-point-anchor'
import type { PointDescription } from '@haoran/dsh-point-anchor'
import { forReference, isCellControl, placeLabel } from '../src/place.ts'
import type { PlaceWords } from '../src/place.ts'

const BASE = { v: DESCRIBE_FORMAT, anchorFormat: ANCHOR_FORMAT } as const

const WORDS: PlaceWords = {
  role: role => `R:${role}`,
  cellControl: (column, role) => `${column}/${role}`,
  tableItem: role => `table/${role}`,
}

describe('a description as a reference carries it', () => {
  it('loses a DataPage row and the count of columns left out', () => {
    const cell: PointDescription = {
      ...BASE,
      what: { kind: 'data-page', region: 'table', part: 'cell' },
      anchor: { kind: 'data-page', model: 'M', region: 'table', part: 'cell', column: 'name' },
      shown: { page: '页', target: '名称' },
      row: { name: '张三' },
      rowOmitted: 2,
    }
    expect(forReference(cell)).toEqual({ ...BASE, what: cell.what, anchor: cell.anchor, shown: cell.shown })
  })

  it('names a control in an original-system table cell by page, column, role and region, its column as the target', () => {
    const control: PointDescription = {
      ...BASE,
      what: { kind: 'frame', role: 'icon' },
      anchor: { kind: 'frame', page: 'orders', column: '状态', role: 'icon', name: '启用', mark: 'el-icon-success', nth: 1, in: 'main' },
      shown: { nav: '订单管理', page: '订单', target: '启用' },
    }
    const carried = forReference(control)
    expect(carried).toEqual({
      ...BASE,
      what: control.what,
      anchor: { kind: 'frame', page: 'orders', column: '状态', role: 'icon', in: 'main' },
      shown: { nav: '订单管理', page: '订单', target: '状态' },
    })
    expect(placeLabel(carried, WORDS)).toBe('状态/R:icon')
    const outside = forReference({ ...control, anchor: { kind: 'frame', page: 'orders', column: '状态', role: 'button' } })
    expect(outside.anchor).toEqual({ kind: 'frame', page: 'orders', column: '状态', role: 'button' })
  })

  it('keeps a table cell itself and an original-system control outside every table as described', () => {
    const cell: PointDescription = {
      ...BASE,
      what: { kind: 'frame', role: 'rowheader' },
      anchor: { kind: 'frame', page: 'orders', column: '姓名', role: 'rowheader', in: 'main' },
      shown: { page: '订单', target: '姓名' },
    }
    expect(forReference(cell)).toEqual(cell)
    expect(isCellControl(cell.anchor)).toBe(false)
    expect(placeLabel(cell, WORDS)).toBeUndefined()
    const query: PointDescription = {
      ...BASE,
      what: { kind: 'frame', role: 'button' },
      anchor: { kind: 'frame', page: 'orders', role: 'button', name: '查询', in: 'main' },
      shown: { page: '订单', target: '查询' },
    }
    expect(forReference(query)).toEqual(query)
  })

  it('keeps no display target of an original-system place without an anchor', () => {
    const loose: PointDescription = { ...BASE, what: { kind: 'frame', role: 'link' }, unanchored: 'no-column', shown: { page: '订单', target: '13800000000' } }
    const carried = forReference(loose)
    expect(carried).toEqual({ ...BASE, what: loose.what, unanchored: 'no-column', shown: { page: '订单' } })
    expect(placeLabel(carried, WORDS)).toBe('table/R:link')
    expect(placeLabel({ ...carried, unanchored: 'nameless' }, WORDS)).toBeUndefined()
  })

  it('keeps a sidebar entry and a picture as described', () => {
    const nav: PointDescription = { ...BASE, what: { kind: 'nav' }, anchor: { kind: 'nav', nav: 'view', id: 'v' }, shown: { target: '图层' } }
    expect(forReference(nav)).toEqual(nav)
    const picture: PointDescription = {
      ...BASE, what: { kind: 'picture', tag: 'canvas' }, anchor: { kind: 'picture', page: 'orders', tag: 'canvas', nth: 1 }, shown: { page: '订单' },
    }
    expect(forReference(picture)).toEqual(picture)
  })

  it('bounds its own label to 64 code points', () => {
    const long: PointDescription = {
      ...BASE, what: { kind: 'frame', role: 'button' }, anchor: { kind: 'frame', page: 'p', column: '列'.repeat(100), role: 'button' }, shown: {},
    }
    expect(Array.from(placeLabel(long, WORDS) ?? '')).toHaveLength(64)
  })
})
