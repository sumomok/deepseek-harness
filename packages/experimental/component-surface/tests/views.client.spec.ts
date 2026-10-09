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
import {
  catalogId,
  COMPONENT_KIT_ENTRIES,
  COMPONENT_KIT_VIEW_ENTRIES,
  DATA_PAGE_ID,
  EDITING_RECORD,
  MAX_SPEC_BYTES,
  OPENED_RECORD,
  readCatalog,
  SHOW_COMPONENT_TOOL_NAME,
  type ComponentCatalog,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'
import { indexViews, judgeView, type ViewRefusal } from '../src/views.ts'
import type { ContentView } from '../src/types.ts'
import { CRUD_CARD, CRUD_FORM, CRUD_PAGE, crudSpec, rewritten, type WrittenNode } from './crud-view.client.ts'
import { KIT_CATALOG, KIT_VIEW_CATALOG } from './kit-catalog.client.ts'

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

/**
 * The refusal of a key named `__proto__`, wherever in a view's spec it is written.
 * @param path - where the key sits, ending in `.__proto__`.
 * @returns the refusal.
 */
function protoKey(path: string): ViewRefusal {
  return {
    path,
    reason: `${path} — is a key named __proto__, which no mapping of a view may carry: copied by assignment, the value under it `
      + 'becomes the mapping\'s prototype instead of a key, so two readers of one file would disagree on what it holds.',
  }
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

describe('a view placing a form page and an info card beside its data page', () => {
  /** What a form page's `request` is, as the catalog states it to whoever wrote anything else there. */
  const FORM_REASON = 'the form saves the record the data page\'s own add and modify buttons name, and nothing else names one.'

  /** What an info card's `record` is, in the same place. */
  const CARD_REASON = 'the card shows the record the data page\'s own names and relation links open, and nothing else names one.'

  /** One view placing the given blocks side by side. */
  function crud(...nodes: readonly WrittenNode[]): ContentView {
    return view('crud', '图层管理', crudSpec(...nodes))
  }

  /**
   * Whether one view of these blocks is accepted.
   * @param nodes - the blocks, in the order the view writes them.
   * @returns whether the judgement accepted the view.
   */
  function accepted(...nodes: readonly WrittenNode[]): boolean {
    return judgeView(KIT_VIEW_CATALOG, true, crud(...nodes)).ok
  }

  /**
   * The refusal one view of these blocks ends in.
   * @param nodes - the blocks, in the order the view writes them.
   * @param catalog - the components the deployment registers; the kit's eight unless a case needs a probe.
   * @returns the refusal, which a person reads without the tool's name in front of it.
   */
  function refused(nodes: readonly WrittenNode[], catalog: ComponentCatalog = KIT_VIEW_CATALOG): ViewRefusal {
    const judged = judgeView(catalog, true, crud(...nodes))
    if (judged.ok) throw new Error('the view was accepted')
    expect(judged.refusal.reason).not.toContain(SHOW_COMPONENT_TOOL_NAME)
    return judged.refusal
  }

  /** The refusal at one path, as {@link refused} returns it. */
  function refusal(path: string, message: string): ViewRefusal {
    return { path, reason: `${path} — ${message}` }
  }

  it('accepts the page beside the form page and the card it opens, and beside either alone', () => {
    expect(accepted(CRUD_PAGE, CRUD_FORM, CRUD_CARD)).toBe(true)
    expect(accepted(CRUD_PAGE, CRUD_FORM)).toBe(true)
    // A page drawing both of its own forms keeps both of its buttons answered
    // without a form page beside it.
    expect(accepted(rewritten(CRUD_PAGE, { regions: { infoCard: false } }), CRUD_CARD)).toBe(true)
  })

  it.each([
    ['a form page', [CRUD_PAGE, rewritten(CRUD_FORM, { request: undefined }), CRUD_CARD], 'spec.nodes[1].props.request', FORM_REASON],
    ['an info card', [CRUD_PAGE, CRUD_FORM, rewritten(CRUD_CARD, { record: undefined })], 'spec.nodes[2].props.record', CARD_REASON],
  ] as const)('refuses %s that leaves out what it reads, and says what the property is', (_case, nodes, path, reason) => {
    // Optional in the catalog, so that a block whose binding the seat has not
    // resolved yet draws its own empty state; a view must still write it.
    expect(refused(nodes)).toEqual(refusal(path, `is required in a view: ${reason}`))
  })

  it('refuses a record written out where the page\'s output belongs, and says how the binding is written', () => {
    // A form page fixed on one record, or a card fixed on one, would edit or
    // show that record whatever the user pressed on the page.
    const fixedForm = rewritten(CRUD_FORM, { request: { mode: 'modify', type: 'SpaceLayer', id: '1' } })
    expect(refused([CRUD_PAGE, fixedForm, CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.request',
      `must read editing of a toy.data-page block of this view, written {"$from": "node:<that block's id>.editing"}: ${FORM_REASON}`,
    ))
    const fixedCard = rewritten(CRUD_CARD, { record: { id: '1', type: 'SpaceLayer' } })
    expect(refused([CRUD_PAGE, CRUD_FORM, fixedCard])).toEqual(refusal(
      'spec.nodes[2].props.record',
      `must read opened of a toy.data-page block of this view, written {"$from": "node:<that block's id>.opened"}: ${CARD_REASON}`,
    ))
  })

  it('refuses the page\'s other output, and one item of its own, by what the value is', () => {
    // The two outputs differ in form, so the call's own judgement refuses each
    // in the other's place before any rule of a view's is reached.
    expect(refused([CRUD_PAGE, rewritten(CRUD_FORM, { request: { $from: 'node:page.opened' } }), CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.request.$from',
      'reads {id, name?, type}, and request accepts {mode (add|modify), type, id?, name?}.',
    ))
    expect(refused([CRUD_PAGE, CRUD_FORM, rewritten(CRUD_CARD, { record: { $from: 'node:page.editing' } })])).toEqual(refusal(
      'spec.nodes[2].props.record.$from',
      'reads {mode (add|modify), type, id?, name?}, and record accepts {id, name?, type}.',
    ))
    expect(refused([CRUD_PAGE, rewritten(CRUD_FORM, { request: { $from: 'node:page.editing[0]' } }), CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.request.$from',
      'takes item 0 out of editing, which is {mode (add|modify), type, id?, name?}.',
    ))
  })

  describe('reading the right value from the wrong place', () => {
    /**
     * A component a call may place that reports what it edits, whole and as a
     * list, a draft in the same form, and what it opened, in the data page's
     * own forms: no shipped component reports any of them, so this is the one
     * way a binding of the right form on the wrong block, or on the wrong
     * output of the right block, reaches a view's judgement.
     */
    const EDITOR: ComponentCatalogEntry = {
      id: catalogId('toy.editor-probe'),
      label: '编辑探针',
      purpose: 'Reports what it edits and what it opened, in the forms the data page does.',
      propsSchema: {},
      actions: [],
      outputs: [
        { id: 'editing', shape: EDITING_RECORD },
        { id: 'edits', shape: { kind: 'array', minItems: 0, maxItems: 3, item: EDITING_RECORD } },
        { id: 'draft', shape: EDITING_RECORD },
        { id: 'opened', shape: OPENED_RECORD },
      ],
    }

    /** A component only a view places, declaring that it reads {@link EDITOR}'s list whole. */
    const LIST_FORM: ComponentCatalogEntry = {
      id: catalogId('toy.list-form-probe'),
      label: '列表表单探针',
      placement: 'view',
      purpose: 'Reads one list of edits whole.',
      propsSchema: {
        request: {
          required: false,
          schema: EDITING_RECORD,
          bindsFrom: { component: EDITOR.id, output: 'edits', reason: 'the probe reads the whole list.' },
        },
      },
      actions: [],
      outputs: [],
    }

    /** A component only a view places, declaring that it reads what {@link EDITOR} is editing. */
    const EDIT_FORM: ComponentCatalogEntry = {
      id: catalogId('toy.edit-form-probe'),
      label: '编辑表单探针',
      placement: 'view',
      purpose: 'Reads what the editor is editing.',
      propsSchema: {
        request: {
          required: false,
          schema: EDITING_RECORD,
          bindsFrom: { component: EDITOR.id, output: 'editing', reason: 'the probe reads what the editor is editing.' },
        },
      },
      actions: [],
      outputs: [],
    }

    /** The kit's eight and the three probes. */
    const PROBED = readCatalog([...COMPONENT_KIT_ENTRIES, ...COMPONENT_KIT_VIEW_ENTRIES, EDITOR, LIST_FORM, EDIT_FORM])

    /** One editor block. */
    const EDITOR_BLOCK: WrittenNode = { id: 'editor', component: EDITOR.id, props: {} }

    it('refuses an output of the right name and form on a block that is not the data page', () => {
      const elsewhere = rewritten(CRUD_FORM, { request: { $from: 'node:editor.editing' } })
      expect(refused([CRUD_PAGE, elsewhere, CRUD_CARD, EDITOR_BLOCK], PROBED)).toEqual(refusal(
        'spec.nodes[1].props.request.$from',
        `reads editing of "editor"; this property reads editing of a toy.data-page block and nothing else: ${FORM_REASON}`,
      ))
      const card = rewritten(CRUD_CARD, { record: { $from: 'node:editor.opened' } })
      expect(refused([CRUD_PAGE, CRUD_FORM, card, EDITOR_BLOCK], PROBED)).toEqual(refusal(
        'spec.nodes[2].props.record.$from',
        `reads opened of "editor"; this property reads opened of a toy.data-page block and nothing else: ${CARD_REASON}`,
      ))
    })

    it('refuses another output of the right block, of the same form', () => {
      // The shared pass accepts the draft where the edit belongs, because the
      // two have one form; only the name says which value the block reads.
      const draft = { id: 'pick', component: EDIT_FORM.id, props: { request: { $from: 'node:editor.draft' } } }
      expect(refused([EDITOR_BLOCK, draft], PROBED)).toEqual(refusal(
        'spec.nodes[1].props.request.$from',
        'reads draft of "editor"; this property reads editing of a toy.editor-probe block and nothing else: the probe '
        + 'reads what the editor is editing.',
      ))
    })

    it('refuses one item of the output a property reads whole', () => {
      const item = { id: 'pick', component: LIST_FORM.id, props: { request: { $from: 'node:editor.edits[0]' } } }
      expect(refused([EDITOR_BLOCK, item], PROBED)).toEqual(refusal(
        'spec.nodes[1].props.request.$from',
        'reads edits[0] of "editor"; this property reads edits of a toy.editor-probe block and nothing else: the probe '
        + 'reads the whole list.',
      ))
    })
  })

  it('judges every block\'s binding before comparing one block with another', () => {
    // A second form page leaving out what it reads is refused for that,
    // because whether it is a second reader of the page is a question about
    // what it reads.
    const again = rewritten({ ...CRUD_FORM, id: 'again' }, { request: undefined })
    expect(refused([CRUD_PAGE, CRUD_FORM, again, CRUD_CARD])).toEqual(refusal(
      'spec.nodes[2].props.request',
      `is required in a view: ${FORM_REASON}`,
    ))
  })

  it('refuses a second form page, which one press would open beside the first', () => {
    expect(refused([CRUD_PAGE, CRUD_FORM, { ...CRUD_FORM, id: 'again' }, CRUD_CARD])).toEqual(refusal(
      'spec.nodes[2]',
      'is a second toy.form-page reading editing of "page": one press would open two forms.',
    ))
  })

  it('refuses a form page saving into another table than the page it follows', () => {
    expect(refused([CRUD_PAGE, rewritten(CRUD_FORM, { relatedMeta: 'SpaceLayerAttr' }), CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.relatedMeta',
      'is "SpaceLayerAttr", and the data page "page" it reads is opened on "SpaceLayer": a form saves into the table its '
      + 'data page shows.',
    ))
  })

  it('refuses a form page whose table differs from the page\'s only in case', () => {
    expect(refused([CRUD_PAGE, rewritten(CRUD_FORM, { relatedMeta: 'spacelayer' }), CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.relatedMeta',
      'is "spacelayer", and the data page "page" it reads is opened on "SpaceLayer": a form saves into the table its '
      + 'data page shows.',
    ))
  })

  it.each([
    ['left to the page', undefined],
    ['written true', true],
  ])('refuses a form page beside a page whose readOnly is %s', (_case, readOnly) => {
    // A read-only page draws neither button, so nothing would ever be put in
    // the form for the user to save.
    expect(refused([rewritten(CRUD_PAGE, { readOnly }), CRUD_FORM, CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.request',
      'reads editing of "page", which is read-only because its readOnly is not false: it draws no add or modify button, '
      + 'so the form never has a record to save.',
    ))
  })

  it.each([
    ['writes no regions at all', undefined, 'add'],
    ['draws its own add form', { addForm: true, modifyForm: false, infoCard: false }, 'add'],
    ['leaves its modify form to the page', { addForm: false, infoCard: false }, 'modify'],
    ['draws its own modify form', { addForm: false, modifyForm: true, infoCard: false }, 'modify'],
  ])('refuses a form page beside a page that %s', (_case, regions, which) => {
    // Written out rather than inferred from the buttons: a page beside a form
    // page draws neither of its own forms, whichever buttons it keeps.
    expect(refused([rewritten(CRUD_PAGE, { regions }), CRUD_FORM, CRUD_CARD])).toEqual(refusal(
      'spec.nodes[1].props.request',
      `reads editing of "page", whose own ${which} form is still drawn because regions.${which}Form is not false: `
      + 'one press would open two forms.',
    ))
  })

  it.each([
    ['add', { addForm: false }],
    ['modify', { modifyForm: false }],
  ])('refuses a page that leaves out its own %s form, keeps the button, and has no form page beside it', (which, regions) => {
    expect(refused([rewritten(CRUD_PAGE, { regions }), CRUD_CARD])).toEqual(refusal(
      `spec.nodes[0].props.regions.${which}Form`,
      `is false while the page keeps its ${which} button, and no toy.form-page in this view reads editing of "page": `
      + 'the button would open nothing.',
    ))
  })

  it.each([
    ['is read-only', { readOnly: undefined }],
    ['draws no toolbar to hold the add button', { regions: { addForm: false, toolbar: false, infoCard: false } }],
    ['keeps no add button in its toolbar', { regions: { addForm: false, infoCard: false }, toolbarButtons: ['exp', 'search', 'clear'] }],
    ['keeps no modify button on its rows', { regions: { modifyForm: false, infoCard: false }, rowOperations: [] }],
  ])('accepts a page leaving out a form without a form page beside it where it %s', (_case, props) => {
    expect(accepted(rewritten(CRUD_PAGE, props), CRUD_CARD)).toBe(true)
  })

  it('refuses a second info card, which one click would fill beside the first', () => {
    expect(refused([CRUD_PAGE, CRUD_FORM, CRUD_CARD, { ...CRUD_CARD, id: 'again' }])).toEqual(refusal(
      'spec.nodes[3]',
      'is a second toy.info-card reading opened of "page": one click would fill two cards.',
    ))
  })

  it.each([
    ['writes no regions at all', [rewritten(CRUD_PAGE, { regions: undefined }), CRUD_CARD], 1],
    ['leaves its own card to the page', [rewritten(CRUD_PAGE, { regions: { addForm: false, modifyForm: false } }), CRUD_FORM, CRUD_CARD], 2],
    ['draws its own card', [rewritten(CRUD_PAGE, { regions: { addForm: false, modifyForm: false, infoCard: true } }), CRUD_FORM, CRUD_CARD], 2],
  ] as const)('refuses an info card beside a page that %s', (_case, nodes, card) => {
    // The page's own side card opens on the same click that fills the info
    // card, and each would report the record it shows.
    expect(refused(nodes)).toEqual(refusal(
      `spec.nodes[${card}].props.record`,
      'reads opened of "page", whose own side card is still drawn because regions.infoCard is not false: one click '
      + 'would open two cards.',
    ))
  })

  it('accepts an info card beside a page that writes its own card false and nothing else', () => {
    expect(accepted(rewritten(CRUD_PAGE, { regions: { infoCard: false } }), CRUD_CARD)).toBe(true)
  })

  it.each([
    ['in place of its own', {}],
    ['beside its own', { infoCardTabs: ['wrong-info'] }],
  ])('refuses an info card whose tab list is written under a key named __proto__ %s', (_case, own) => {
    // Built the way a YAML or JSON reader builds the mapping, with the key as
    // one more key of it; an object literal would set the prototype instead.
    const entries: [string, unknown][] = [...Object.entries({ ...CRUD_CARD.props, ...own }), ['__proto__', { infoCardTabs: ['operation'] }]]
    const props = Object.fromEntries(entries)
    expect(refused([CRUD_PAGE, CRUD_FORM, { ...CRUD_CARD, props }])).toEqual(protoKey('spec.nodes[2].props.__proto__'))
  })
})

describe('a view whose alias refers back to a value containing it', () => {
  /** The sentence each case below is refused in, after the path it names. */
  const CYCLE = 'is an alias of a mapping or list that contains it, so the value written here would contain itself without end'

  /**
   * The read-only data page view the YAML reader hands over for each cyclic
   * form, with the alias already the object that contains it.
   */
  function cyclic(form: 'layout' | 'children' | 'props'): ContentView {
    const props: Record<string, unknown> = { relatedMeta: 'T', metaLabel: 'L', readOnly: true, regions: { infoCard: false } }
    const children: unknown[] = [{ node: 'component', id: 'page', flex: 1 }]
    const layout: Record<string, unknown> = { node: 'stack', dir: 'row', gap: 'md', children }
    if (form === 'layout') layout['self'] = layout
    if (form === 'children') children.push(children)
    if (form === 'props') props['self'] = props
    return view('table-crud', '测试视图', { nodes: [{ id: 'page', component: DATA_PAGE_ID, props }], layout })
  }

  it.each([
    ['a layout stack aliasing itself', 'layout', 'spec.layout.self'],
    ['a child list aliasing itself', 'children', 'spec.layout.children[1]'],
    ['properties aliasing themselves', 'props', 'spec.nodes[0].props.self'],
  ] as const)('is refused at the alias, not thrown, for %s', (_case, form, path) => {
    expect(judgeView(KIT_VIEW_CATALOG, true, cyclic(form))).toEqual({ ok: false, refusal: { path, reason: `${path} — ${CYCLE}` } })
  })

  it('fails the configured view list at load with the view named, not with a stack overflow', () => {
    expect(() => indexViews(KIT_VIEW_CATALOG, [cyclic('layout')], undefined, true))
      .toThrow(`component-surface: views[0] "table-crud" — spec.layout.self — ${CYCLE}`)
  })
})

describe('a view writing a key named __proto__', () => {
  /** One view, its spec as a reader of the view file hands it over. */
  function written(spec: string): ContentView {
    return view('layers', '图层数据', JSON.parse(spec))
  }

  /** One data page block, with its properties and whatever else a case writes beside them. */
  const PAGE = '{"id":"page","component":"toy.data-page","props":{"relatedMeta":"SpaceLayer","metaLabel":"空间图层"}}'

  it('refuses a data page property written under it, at that key', () => {
    // Taken as the properties' prototype instead, the value under the key would
    // be a property no judgement named and the page still drew.
    const spec = '{"nodes":[{"id":"page","component":"toy.data-page","props":'
      + '{"relatedMeta":"SpaceLayer","metaLabel":"空间图层","__proto__":{"readOnly":false}}}]}'
    expect(judgeView(KIT_VIEW_CATALOG, true, written(spec))).toEqual({ ok: false, refusal: protoKey('spec.nodes[0].props.__proto__') })
  })

  it.each([
    [
      'a node',
      '{"nodes":[{"id":"page","component":"toy.data-page","__proto__":{"props":{"relatedMeta":"SpaceLayer","metaLabel":"空间图层"}}}]}',
      'spec.nodes[0].__proto__',
    ],
    ['a spec', `{"nodes":[${PAGE}],"__proto__":{"layout":{"node":"stack","dir":"col","children":[{"node":"component","id":"page"}]}}}`, 'spec.__proto__'],
    [
      'an object-valued property',
      '{"nodes":[{"id":"page","component":"toy.data-page","props":'
      + '{"relatedMeta":"SpaceLayer","metaLabel":"空间图层","querySort":{"__proto__":{"asc":"name"}}}}]}',
      'spec.nodes[0].props.querySort.__proto__',
    ],
    [
      'a layout stack',
      `{"nodes":[${PAGE}],"layout":{"node":"stack","dir":"col","children":[{"node":"component","id":"page"}],"__proto__":{"wrap":true}}}`,
      'spec.layout.__proto__',
    ],
    [
      'a placed block',
      `{"nodes":[${PAGE}],"layout":{"node":"stack","dir":"col","children":[{"node":"component","id":"page","__proto__":{"flex":2}}]}}`,
      'spec.layout.children[0].__proto__',
    ],
    [
      'a table row, whose keys are otherwise the writer\'s own',
      '{"nodes":[{"id":"sites","component":"toy.table","props":{"tableConfig":{"gridItems":[{"relatedMetaAttr":"name"}]},'
      + '"displayValueList":[{"name":"一号站点","__proto__":"内部"}]}}]}',
      'spec.nodes[0].props.displayValueList[0].__proto__',
    ],
  ])('refuses one written in %s, at that key', (_case, spec, path) => {
    expect(judgeView(KIT_VIEW_CATALOG, true, written(spec))).toEqual({ ok: false, refusal: protoKey(path) })
  })

  it('refuses a key no component declares written under it as the whole block under that key', () => {
    // Judged by name, the inner key would be refused for being undeclared; the
    // block it sits in is refused first, for the key it sits under.
    const spec = '{"nodes":[{"id":"page","component":"toy.data-page","props":'
      + '{"relatedMeta":"SpaceLayer","metaLabel":"空间图层","__proto__":{"notDeclaredAnywhere":1}}}]}'
    expect(judgeView(KIT_VIEW_CATALOG, true, written(spec))).toEqual({ ok: false, refusal: protoKey('spec.nodes[0].props.__proto__') })
  })

  it('refuses one hiding more than the size ceiling at that key, not for the size', () => {
    // Four hundred rows of two hundred characters: about 82 KB under the key,
    // which the ceiling on a spec would otherwise be the first to refuse.
    const rows = Array.from({ length: 400 }, (_, index) => ({ name: `${String(index).padStart(4, '0')}${'x'.repeat(190)}` }))
    const table = {
      id: 'sites',
      component: 'toy.table',
      props: Object.fromEntries<unknown>([
        ['tableConfig', { gridItems: [{ relatedMetaAttr: 'name' }] }],
        ['displayValueList', [{ name: '一号站点' }]],
        ['__proto__', { rawValueList: rows }],
      ]),
    }
    expect(new TextEncoder().encode(JSON.stringify({ nodes: [table] })).length).toBeGreaterThan(MAX_SPEC_BYTES)
    expect(judgeView(KIT_VIEW_CATALOG, true, view('sites', '站点', { nodes: [table] })))
      .toEqual({ ok: false, refusal: protoKey('spec.nodes[0].props.__proto__') })
  })
})
