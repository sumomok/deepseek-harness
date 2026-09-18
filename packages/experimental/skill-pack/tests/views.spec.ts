/**
 * What a view file has to say, and what it is allowed to leave unread: the
 * spec and the params are carried through without being judged here.
 */

import { describe, expect, it } from 'vitest'
import { parsePackView } from '../src/views.ts'

const VIEW = [
  'id: space-layer',
  'title: 图层数据',
  'spec:',
  '  - id: layer-table',
  '    component: toy.crud',
  'params:',
  '  relatedMeta: sys_layer',
  '  metaLabel: 图层',
  '',
].join('\n')

describe('pack view files', () => {
  it('carries the spec and the params through without reading either', () => {
    expect(parsePackView('views/space-layer.yml', VIEW)).toEqual({
      ok: true,
      path: 'views/space-layer.yml',
      view: {
        id: 'space-layer',
        title: '图层数据',
        spec: [{ id: 'layer-table', component: 'toy.crud' }],
        params: { relatedMeta: 'sys_layer', metaLabel: '图层' },
      },
    })
  })

  it('accepts a spec of any structure, including one no component catalog would take', () => {
    const read = parsePackView('v.yml', 'id: a\ntitle: A\nspec: not-a-block-list\n')
    expect(read).toMatchObject({ ok: true })
    expect(read.ok && read.view.spec).toBe('not-a-block-list')
    expect(read.ok && read.view.params).toEqual({})
  })

  it('names the file and what was wrong with it', () => {
    expect(parsePackView('v.yml', 'id: [unclosed\n')).toEqual({ ok: false, path: 'v.yml', reason: 'is not a YAML mapping' })
    expect(parsePackView('v.yml', '- a\n- b\n')).toEqual({ ok: false, path: 'v.yml', reason: 'is not a YAML mapping' })
    expect(parsePackView('v.yml', 'title: A\nspec: []\n')).toEqual({ ok: false, path: 'v.yml', reason: 'has no id' })
    expect(parsePackView('v.yml', 'id: ""\ntitle: A\nspec: []\n')).toEqual({ ok: false, path: 'v.yml', reason: 'has no id' })
    expect(parsePackView('v.yml', 'id: a\nspec: []\n')).toEqual({ ok: false, path: 'v.yml', reason: 'has no title' })
    expect(parsePackView('v.yml', 'id: a\ntitle: 7\nspec: []\n')).toEqual({ ok: false, path: 'v.yml', reason: 'has no title' })
    expect(parsePackView('v.yml', 'id: a\ntitle: A\n')).toEqual({ ok: false, path: 'v.yml', reason: 'has no spec' })
    expect(parsePackView('v.yml', 'id: a\ntitle: A\nspec: []\nparams: [1]\n'))
      .toEqual({ ok: false, path: 'v.yml', reason: 'has params that are not a mapping' })
  })
})
