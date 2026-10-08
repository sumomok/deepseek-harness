/**
 * What a view file has to say, and what it is allowed to leave unread: the
 * spec and the params are carried through without being judged here.
 */

import { describe, expect, it } from 'vitest'
import { PACK_VIEW_FIELDS, parsePackView } from '../src/views.ts'

const VIEW = [
  'id: space-layer',
  'title: 图层数据',
  'spec:',
  '  - id: layer-table',
  '    component: toy.data-page',
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
        spec: [{ id: 'layer-table', component: 'toy.data-page' }],
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

describe('the keys a view file is read for', () => {
  /** A value each listed key accepts, as one YAML line. */
  const LINES: Readonly<Record<string, string>> = {
    id: 'id: a',
    title: 'title: A',
    spec: 'spec: []',
    params: 'params: { table: t }',
  }

  /** A view file writing exactly the given keys. */
  function writing(paths: readonly string[]): string {
    return paths.map(path => LINES[path]).join('\n') + '\n'
  }

  it('reads a file writing every listed key, and one writing only the required ones', () => {
    expect(parsePackView('v.yml', writing(PACK_VIEW_FIELDS.map(field => field.path)))).toMatchObject({ ok: true })
    expect(parsePackView('v.yml', writing(PACK_VIEW_FIELDS.filter(field => field.required).map(field => field.path))))
      .toMatchObject({ ok: true })
  })

  it('refuses a file leaving out a required key', () => {
    for (const field of PACK_VIEW_FIELDS.filter(one => one.required)) {
      const others = PACK_VIEW_FIELDS.map(one => one.path).filter(path => path !== field.path)
      expect(parsePackView('v.yml', writing(others))).toEqual({ ok: false, path: 'v.yml', reason: `has no ${field.path}` })
    }
  })

  it('ignores a key it does not list', () => {
    expect(parsePackView('v.yml', `${writing(PACK_VIEW_FIELDS.map(field => field.path))}notes: anything\n`))
      .toMatchObject({ ok: true, view: { id: 'a', title: 'A', spec: [], params: { table: 't' } } })
  })
})
