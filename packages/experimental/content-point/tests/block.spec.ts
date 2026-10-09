/**
 * A block reference: built from the seat kind, the component and node ids the
 * page writes and display text, leaving out an id that is no single token and
 * cleaning display text as point-anchor cleans `shown`; read back strictly, so
 * a logged payload this build would not have written is refused, a format other
 * than 1 by its stated number; and written as one key line.
 */

import { describe, expect, it } from 'vitest'
import { BLOCK_FORMAT, blockData, blockKey, blockLabel, parseBlockData } from '../src/block.ts'

describe('a block reference', () => {
  it('carries the seat, the ids that are single tokens, and cleaned display text', () => {
    expect(blockData({ seat: 'component', component: 'toy.info-card', node: 'card', page: ' 图层\n配置 ', target: '信息卡' }))
      .toEqual({ v: BLOCK_FORMAT, kind: 'block', seat: 'component', component: 'toy.info-card', node: 'card', shown: { page: '图层 配置', target: '信息卡' } })
    expect(blockData({ seat: 'component', component: 'two words', node: 'x'.repeat(129), page: '\u200b', target: '' }))
      .toEqual({ v: BLOCK_FORMAT, kind: 'block', seat: 'component', shown: {} })
    expect(blockData({ seat: 'two words' })).toBeUndefined()
    expect(blockData({ seat: 'office', target: '长'.repeat(80) })?.shown.target).toHaveLength(64)
  })

  it('is written as one key line, a value that is not bare quoted', () => {
    const data = blockData({ seat: 'component', component: '图表', node: 'n1' })
    expect(data === undefined ? '' : blockKey(data)).toBe('block seat=component component="图表" node=n1')
    expect(data === undefined ? '' : blockLabel(data)).toBe('component')
  })

  it('reads back what it wrote', () => {
    const data = blockData({ seat: 'component', component: 'el.metric', node: 'rate', page: '图层配置', target: '指标' })
    expect(parseBlockData(JSON.parse(JSON.stringify(data)))).toEqual({ ok: true, value: data })
    expect(parseBlockData({ v: 1, kind: 'block', seat: 'office', shown: {} })).toEqual({ ok: true, value: { v: 1, kind: 'block', seat: 'office', shown: {} } })
  })

  it('refuses a format other than 1 by the number it states', () => {
    expect(parseBlockData({ v: 2, kind: 'block', seat: 'component', shown: {} })).toEqual({ ok: false, problem: { kind: 'format', stated: 2 } })
  })

  it.each([
    ['no object', 'x', 'data'],
    ['an array', [], 'data'],
    ['a fractional format', { v: 1.5, kind: 'block', seat: 'c', shown: {} }, 'v'],
    ['no format', { kind: 'block', seat: 'c', shown: {} }, 'v'],
    ['an unknown key', { v: 1, kind: 'block', seat: 'c', shown: {}, row: {} }, 'row'],
    ['another kind', { v: 1, kind: 'frame', seat: 'c', shown: {} }, 'kind'],
    ['a seat that is no token', { v: 1, kind: 'block', seat: 'a b', shown: {} }, 'seat'],
    ['a seat that is no string', { v: 1, kind: 'block', seat: 1, shown: {} }, 'seat'],
    ['a component that is no token', { v: 1, kind: 'block', seat: 'c', component: '', shown: {} }, 'component'],
    ['a component that is no string', { v: 1, kind: 'block', seat: 'c', component: 1, shown: {} }, 'component'],
    ['a node that is no token', { v: 1, kind: 'block', seat: 'c', node: 'a\tb', shown: {} }, 'node'],
    ['a node that is no string', { v: 1, kind: 'block', seat: 'c', node: null, shown: {} }, 'node'],
    ['no shown', { v: 1, kind: 'block', seat: 'c' }, 'shown'],
    ['an unknown shown key', { v: 1, kind: 'block', seat: 'c', shown: { nav: 'x' } }, 'shown.nav'],
    ['a page this build would have cleaned', { v: 1, kind: 'block', seat: 'c', shown: { page: ' x' } }, 'shown.page'],
    ['an empty target', { v: 1, kind: 'block', seat: 'c', shown: { target: '' } }, 'shown.target'],
    ['a target that is no string', { v: 1, kind: 'block', seat: 'c', shown: { target: 3 } }, 'shown.target'],
  ])('refuses %s, naming the field', (_name, data, field) => {
    expect(parseBlockData(data)).toEqual({ ok: false, problem: { kind: 'invalid', field } })
  })
})
