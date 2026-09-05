/**
 * The load-time judgement over a deployment's configured views: which lists are
 * accepted, and what a rejected one says.
 *
 * The judgement is the tool's own — `validateComponentCall` over the same three
 * values a call carries — so what these cases pin is not the catalog rules
 * again but the two things only this pass decides: that a broken view stops the
 * row from loading at all, and that the failure names the view a person has to
 * go and edit.
 */

import { describe, expect, it } from 'vitest'
import { indexViews } from '../src/views.ts'
import type { ContentView } from '../src/types.ts'

/** One accepted two-block view: a table above the details of whatever row is picked. */
const OVERVIEW = {
  nodes: [
    {
      id: 'sites',
      component: 'toy.table',
      props: {
        selectMode: 'radio',
        tableConfig: { gridItems: [{ relatedMetaAttr: 'name', alias: '站点' }] },
        displayValueList: [{ name: '一号站点' }],
      },
    },
    {
      id: 'detail',
      component: 'toy.record',
      props: { dataList: { $from: 'node:sites.selectionDetail' }, columnNum: 1 },
    },
  ],
  layout: {
    node: 'stack',
    dir: 'col',
    gap: 'md',
    children: [{ node: 'component', id: 'sites', flex: 2 }, { node: 'component', id: 'detail', flex: 1 }],
  },
}

/** A second accepted view, so declaration order has something to be an order of. */
const SINGLE = { nodes: [{ id: 'facts', component: 'toy.record', props: { dataList: [{ label: '编号', display: 'A-1' }], columnNum: 1 } }] }

/** One configured view, written the way `cordis.yml` writes it. */
function view(id: string, title: string, spec: unknown): ContentView {
  return { id, title, spec }
}

describe('the configured view list', () => {
  it('indexes accepted views by id, in declaration order, already tightened', () => {
    const index = indexViews([view('site-overview', '站点概览', OVERVIEW), view('facts', '记录', SINGLE)], undefined)
    expect([...index.keys()]).toEqual(['site-overview', 'facts'])
    // What the index holds is what an accepted call holds, which is what the
    // command appends and the seat draws.
    expect(index.get('site-overview')).toEqual({ id: 'site-overview', title: '站点概览', spec: OVERVIEW })
  })

  it('accepts a deployment that configures no views at all', () => {
    expect(indexViews([], undefined).size).toBe(0)
  })

  it('accepts a homeView naming a configured view', () => {
    expect(indexViews([view('facts', '记录', SINGLE)], 'facts').size).toBe(1)
  })

  it('refuses a spec the tool would have refused, naming the view and the value inside it', () => {
    // A view whose spec is broken is a menu row that shows an empty column when
    // a user clicks it, with nothing anywhere saying why — so it stops the row
    // from loading, and the sentence carries both the id a person edits and the
    // path inside that view's spec.
    const broken = view('site-overview', '站点概览', { nodes: [{ id: 'x', component: 'toy.chart', props: {} }] })
    expect(() => indexViews([view('facts', '记录', SINGLE), broken], undefined))
      .toThrow(/^component-surface: views\[1\] "site-overview" — spec\.nodes\[0\]\.component /)
  })

  it('refuses an id the tool would not have accepted as an entry id', () => {
    // The id becomes a content-column entry id, so it is read on exactly the
    // terms a call's is: same alphabet, same ceiling.
    expect(() => indexViews([view('site overview', '站点概览', SINGLE)], undefined))
      .toThrow(/^component-surface: views\[0\] "site overview" — id — may use only /)
  })

  it('refuses a title the tool would not have accepted', () => {
    expect(() => indexViews([view('facts', '   ', SINGLE)], undefined))
      .toThrow(/^component-surface: views\[0\] "facts" — title — must be a non-blank string/)
  })

  it('refuses a repeated id, which would leave one view unreachable', () => {
    expect(() => indexViews([view('facts', '记录', SINGLE), view('facts', '另一份记录', SINGLE)], undefined))
      .toThrow('component-surface: duplicate view id "facts" at views[1]')
  })

  it('refuses a homeView naming no configured view', () => {
    expect(() => indexViews([view('facts', '记录', SINGLE)], 'site-overview'))
      .toThrow('component-surface: homeView "site-overview" names no configured view')
  })
})
