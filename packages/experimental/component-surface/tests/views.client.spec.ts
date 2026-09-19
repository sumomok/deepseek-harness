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
import { indexViews, judgeView } from '../src/views.ts'
import type { ContentView } from '../src/types.ts'
import { KIT_CATALOG } from './kit-catalog.client.ts'

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
    const index = indexViews(KIT_CATALOG, [view('site-overview', '站点概览', OVERVIEW), view('facts', '记录', SINGLE)], undefined, false)
    expect([...index.keys()]).toEqual(['site-overview', 'facts'])
    // What the index holds is what an accepted call holds, which is what the
    // command appends and the seat draws.
    expect(index.get('site-overview')).toEqual({ id: 'site-overview', title: '站点概览', spec: OVERVIEW })
  })

  it('accepts a deployment that configures no views at all', () => {
    expect(indexViews(KIT_CATALOG, [], undefined, false).size).toBe(0)
  })

  it('accepts a homeView naming a configured view', () => {
    expect(indexViews(KIT_CATALOG, [view('facts', '记录', SINGLE)], 'facts', false).size).toBe(1)
  })

  it('refuses a spec the tool would have refused, naming the view and the value inside it', () => {
    // A view whose spec is broken is a menu row that shows an empty column when
    // a user clicks it, with nothing anywhere saying why — so it stops the row
    // from loading, and the sentence carries both the id a person edits and the
    // path inside that view's spec.
    const broken = view('site-overview', '站点概览', { nodes: [{ id: 'x', component: 'toy.chart', props: {} }] })
    expect(() => indexViews(KIT_CATALOG, [view('facts', '记录', SINGLE), broken], undefined, false))
      .toThrow(/^component-surface: views\[1\] "site-overview" — spec\.nodes\[0\]\.component /)
  })

  it('refuses an id the tool would not have accepted as an entry id', () => {
    // The id becomes a content-column entry id, so it is read on exactly the
    // terms a call's is: same alphabet, same ceiling.
    expect(() => indexViews(KIT_CATALOG, [view('site overview', '站点概览', SINGLE)], undefined, false))
      .toThrow(/^component-surface: views\[0\] "site overview" — id — may use only /)
  })

  it('refuses a title the tool would not have accepted', () => {
    expect(() => indexViews(KIT_CATALOG, [view('facts', '   ', SINGLE)], undefined, false))
      .toThrow(/^component-surface: views\[0\] "facts" — title — must be a non-blank string/)
  })

  it('refuses a repeated id, which would leave one view unreachable', () => {
    expect(() => indexViews(KIT_CATALOG, [view('facts', '记录', SINGLE), view('facts', '另一份记录', SINGLE)], undefined, false))
      .toThrow('component-surface: duplicate view id "facts" at views[1]')
  })

  it('refuses a homeView naming no configured view', () => {
    expect(() => indexViews(KIT_CATALOG, [view('facts', '记录', SINGLE)], 'site-overview', false))
      .toThrow('component-surface: homeView "site-overview" names no configured view')
  })
})

describe('a view arranging a data page toolbar', () => {
  /** One view drawing a data page whose toolbar keeps the named buttons. */
  function toolbar(...buttons: readonly string[]): ContentView {
    return view('layers', '图层数据', {
      nodes: [{
        id: 'layer-table',
        component: 'toy.data-page',
        props: { relatedMeta: 'sys_layer', metaLabel: '图层', toolbarButtons: buttons, readOnly: false },
      }],
    })
  }

  it('keeps the buttons the page draws something for', () => {
    expect(judgeView(KIT_CATALOG, true, toolbar('add', 'exp', 'gridexp', 'search', 'clear')).ok).toBe(true)
  })

  it.each([['imp'], ['batch']])('refuses %s, and says what the button would have done', (withdrawn) => {
    // Whoever writes the view is told what this page does with the buttons it
    // accepts, rather than only that theirs is not among them: an import panel
    // and a batch panel are what the page would need to draw for either of
    // these, and it draws neither.
    expect(judgeView(KIT_CATALOG, true, toolbar('add', withdrawn))).toEqual({
      ok: false,
      refusal: {
        path: 'spec.nodes[0].props.toolbarButtons[1]',
        reason: 'spec.nodes[0].props.toolbarButtons[1] — must be one of "add", "exp", "gridexp", "search", "clear". '
          + 'This page draws no import panel and no batch panel, so "imp" and "batch" are not on the list: either '
          + 'button would draw and answer nothing when it was pressed.',
      },
    })
  })

  it('refuses a row operation the page draws no panel for, in the same words', () => {
    const deleting = view('layers', '图层数据', {
      nodes: [{
        id: 'layer-table',
        component: 'toy.data-page',
        props: { relatedMeta: 'sys_layer', metaLabel: '图层', rowOperations: ['delete'], readOnly: false },
      }],
    })
    expect(judgeView(KIT_CATALOG, true, deleting)).toEqual({
      ok: false,
      refusal: {
        path: 'spec.nodes[0].props.rowOperations[0]',
        reason: 'spec.nodes[0].props.rowOperations[0] — must be one of "modify". This page draws no delete '
          + 'confirmation, so "delete" is not on the list: the button would draw and answer nothing when it was pressed.',
      },
    })
  })
})
