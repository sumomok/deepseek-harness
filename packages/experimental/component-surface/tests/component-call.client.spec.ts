/**
 * The shared vocabulary both halves of the seam read: the catalog lookups, the
 * lines a refusal and the tool description are both built from, and the two
 * readers that turn a logged argument value into a call's arguments.
 *
 * Nothing here judges a call — that is `validate.ts`'s whole job, and the split
 * is what lets the browser seat read the catalog without carrying the
 * judgement's failure text into a page.
 */

import { describe, expect, it } from 'vitest'
import {
  answersBlock,
  BINDING_KEY,
  catalogEntry,
  catalogLabels,
  catalogOutput,
  COMPONENT_CATALOG,
  COMPONENT_KIND,
  CONFIRM_BAR_ID,
  describeCatalog,
  describeSchema,
  FILTER_BAR_ID,
  isBindingValue,
  MATCH_OPERATORS,
  MAX_SPEC_DEPTH,
  maxSpecDepthOf,
  METRIC_ID,
  parseBindingReference,
  RECORD_DETAIL_ID,
  parseComponentCall,
  readBinding,
  readComponentCall,
  SHOW_COMPONENT_TOOL_NAME,
  TABLE_ID,
  TABLE_SELECTION_DETAIL_OUTPUT,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'

describe('component catalog', () => {
  it('claims one wire tool name and one content kind', () => {
    expect(SHOW_COMPONENT_TOOL_NAME).toBe('show_component')
    expect(COMPONENT_KIND).toBe('component')
  })

  it('offers the confirmation bar under a Chinese name the user reads', () => {
    const entry = catalogEntry(CONFIRM_BAR_ID)
    expect(entry?.label).toBe('确认条')
    expect(Object.keys(entry?.propsSchema ?? {})).toEqual(['title', 'message', 'buttons'])
  })

  it('offers the record detail under a Chinese name, with nothing coming back from it', () => {
    const entry = catalogEntry(RECORD_DETAIL_ID)
    expect(entry?.label).toBe('记录详情')
    expect(Object.keys(entry?.propsSchema ?? {})).toEqual(['dataList', 'labelWidth', 'columnNum'])
    expect(entry?.actions).toEqual([])
  })

  it('offers the data table, the filter bar and the metric ball under Chinese names', () => {
    expect(catalogEntry(TABLE_ID)?.label).toBe('数据表')
    expect(Object.keys(catalogEntry(TABLE_ID)?.propsSchema ?? {})).toEqual([
      'tableConfig', 'displayValueList', 'rawValueList', 'selectMode',
      'isNameClick', 'tableSortable', 'customOperations', 'operationColumnWidth',
    ])
    expect(catalogEntry(FILTER_BAR_ID)?.label).toBe('筛选条件')
    expect(Object.keys(catalogEntry(FILTER_BAR_ID)?.propsSchema ?? {}))
      .toEqual(['relatedMeta', 'metaConfig', 'attrEqEnums', 'confStyle'])
    expect(catalogEntry(METRIC_ID)?.label).toBe('指标球')
    expect(catalogEntry(METRIC_ID)?.actions).toEqual([])
  })

  it('declares the four gestures a table reports, at the grade each one means', () => {
    expect(catalogEntry(TABLE_ID)?.actions.map(action => [action.id, action.report])).toEqual([
      ['select', 'context'],
      ['row-click', 'context'],
      ['sort', 'silent'],
      ['operation', 'wake'],
    ])
    expect(catalogEntry(FILTER_BAR_ID)?.actions.map(action => [action.id, action.report]))
      .toEqual([['submit', 'wake'], ['change', 'silent']])
  })

  it('offers every match strategy the condition editor draws', () => {
    // The table has to be the editor's own: a strategy the user can pick and
    // this package cannot name is a filter the person builds and is then told
    // was not recorded. `NOT_BETWEEN` is the one `matchUtil` has no branch for,
    // and it is here because nothing in this package evaluates a condition.
    expect(MATCH_OPERATORS).toHaveLength(16)
    expect(MATCH_OPERATORS.map(operator => operator.value)).toContain('NOT_BETWEEN')
    expect(MATCH_OPERATORS[0]).toEqual({ value: 'EQ', label: '等于' })
  })

  it('knows no component it does not list', () => {
    expect(catalogEntry('toy.chart')).toBeUndefined()
    expect(catalogEntry(42)).toBeUndefined()
  })

  it('calls a wake the block\'s own answer, and nothing else', () => {
    expect(answersBlock('el.confirm-bar', 'press')).toBe(true)
    expect(answersBlock('toy.table', 'operation')).toBe(true)
    expect(answersBlock('el.filter-bar', 'submit')).toBe(true)
    expect(answersBlock('toy.table', 'select')).toBe(false)
    expect(answersBlock('toy.table', 'sort')).toBe(false)
    expect(answersBlock('el.filter-bar', 'change')).toBe(false)
    expect(answersBlock('toy.table', 'double-press')).toBe(false)
    expect(answersBlock('toy.chart', 'press')).toBe(false)
  })

  it('renders every component as an identity line and the properties it declares', () => {
    expect(describeCatalog(COMPONENT_CATALOG)).toBe(
      '- el.confirm-bar — 确认条 — A short prompt above a row of buttons, for putting one decision in front of the user.'
      + '\n  props: title?, message?, buttons[{id, label, tone? (primary|default|danger)}] (1–5)'
      + '\n- toy.record — 记录详情 — One record laid out as label-and-value pairs, for putting the details of a single thing'
      + ' in front of the user. Nothing comes back from it.'
      + '\n  props: dataList[{label, display}] (1–60), labelWidth? (40–240), columnNum? (1|2|3)'
      + '\n- toy.table — 数据表 — Rows and columns the user can tick, open, sort and act on, for putting a list of things'
      + ' in front of the user.'
      + '\n  props: tableConfig{gridItems[{relatedMetaAttr, alias?, isShow? (true|false), isSortable? (true|false),'
      + ' relatedComponent? (display_default|display_yesno|display_progress|display_circle|display_tag),'
      + ' relatedComponentObj?{<field>: text|number|boolean, color?: #RGB|#RRGGBB|rgb()|rgba()}}] (1–30)},'
      + ' displayValueList[{<field>: text|number|boolean}] (1–500),'
      + ' rawValueList?[{<field>: text|number|boolean}] (1–500), selectMode? (checkbox|radio),'
      + ' isNameClick? (true|false), tableSortable? (true|false), customOperations?[{key, label}] (1–5),'
      + ' operationColumnWidth? (60–400)'
      + '\n  outputs: selectionDetail [{label, display}] (0–30)'
      + '\n- el.filter-bar — 筛选条件 — A row of conditions the user edits and submits back to you, for agreeing on what'
      + ' to look for before you look.'
      + '\n  props: relatedMeta, metaConfig{attributes[{attributeEnName, alias,'
      + ' dataType? (string|date|datetosecond|integer|long|float|double)}] (1–40)},'
      + ' attrEqEnums?[{value (EQ|NOT_EQ|IN|NOT_IN|LIKE|NOT_LIKE|IS_NULL|NOT_NULL|PREFIX|NOT_PREFIX|GREATER_THAN'
      + '|EQ_AND_GREATER_THAN|LESS_THAN|LESS_AND_EQ_THAN|BETWEEN|NOT_BETWEEN), label}] (1–16),'
      + ' confStyle?{gutter? (0–100), showMatchMode? (true|false)}'
      + '\n- el.metric — 指标球 — One measurement drawn as a filling ball, for putting a single number in front of the'
      + ' user. Nothing comes back from it.'
      + '\n  props: size? (40–400), process (0–100), text?, background? (#RGB|#RRGGBB|rgb()|rgba()),'
      + ' borderColor? (#RGB|#RRGGBB|rgb()|rgba()), pointColor? (#RGB|#RRGGBB|rgb()|rgba()),'
      + ' isPointShow? (true|false)',
    )
    // Two lines per component, and a third wherever another block can read
    // something out of one.
    expect(describeCatalog(COMPONENT_CATALOG).split('\n'))
      .toHaveLength(2 * COMPONENT_CATALOG.length + COMPONENT_CATALOG.filter(entry => entry.outputs.length > 0).length)
  })

  it('states what another block can read out of a component, and only where there is something', () => {
    // The `outputs:` line is what makes a binding writable: the reference names
    // one of these ids, and whether the property it is bound to accepts the
    // value is decided against the form stated here.
    const lines = describeCatalog(COMPONENT_CATALOG).split('\n').filter(line => line.startsWith('  outputs: '))
    expect(lines).toEqual(['  outputs: selectionDetail [{label, display}] (0–30)'])
    expect(catalogEntry(CONFIRM_BAR_ID)?.outputs).toEqual([])
    expect(catalogEntry(RECORD_DETAIL_ID)?.outputs).toEqual([])
    expect(catalogEntry(FILTER_BAR_ID)?.outputs).toEqual([])
    expect(catalogEntry(METRIC_ID)?.outputs).toEqual([])
  })

  it('looks one output up on the component that declares it', () => {
    const table = catalogEntry(TABLE_ID)
    if (table === undefined) throw new Error('the catalog has no table')
    expect(catalogOutput(table, TABLE_SELECTION_DETAIL_OUTPUT)?.id).toBe('selectionDetail')
    expect(catalogOutput(table, TABLE_SELECTION_DETAIL_OUTPUT)?.shape.kind).toBe('array')
    expect(catalogOutput(table, 'rows')).toBeUndefined()
    expect(catalogOutput(table, 42)).toBeUndefined()
  })

  it('renders one value\'s shape on a line that names no property', () => {
    expect(describeSchema({ kind: 'string', maxLength: 8 })).toBe('text')
    expect(describeSchema({ kind: 'number', min: 0, max: 9 })).toBe('number')
    // A list states its bounds, which is what makes two lists of the same items
    // readable as different offers where one is refused for carrying more.
    expect(describeSchema({ kind: 'array', minItems: 0, maxItems: 4, item: { kind: 'boolean' } })).toBe('[true|false] (0–4)')
  })

  it('names a record whose keys are the caller\'s own without listing them', () => {
    // The keys are the model's to choose, so what the line has to carry is that
    // they are field names and that each one holds a scalar.
    const probe: ComponentCatalogEntry = {
      id: 'toy.probe',
      label: '探针',
      purpose: 'Described, never placed.',
      propsSchema: {
        rows: {
          required: true,
          schema: {
            kind: 'array',
            minItems: 1,
            maxItems: 9,
            item: { kind: 'record', key: { kind: 'string', maxLength: 8 }, maxKeys: 4, maxValueLength: 8, minValue: 0, maxValue: 1 },
          },
        },
      },
      actions: [],
      outputs: [],
    }
    expect(describeCatalog([probe]).split('\n')[1]).toBe('  props: rows[{<field>: text|number|boolean}] (1–9)')
  })

  it('states the notation of a string the component reads as something narrower', () => {
    // The reading is enforced by a pass that drops the value rather than
    // refusing the call, so a model not told the notation is never told why
    // what it sent disappeared.
    const probe: ComponentCatalogEntry = {
      id: 'toy.probe',
      label: '探针',
      purpose: 'Described, never placed.',
      propsSchema: {
        icon: { required: false, schema: { kind: 'string', maxLength: 80 } },
        caption: { required: false, schema: { kind: 'string', maxLength: 80 } },
      },
      actions: [],
      outputs: [],
      sanitize: { icon: 'path' },
    }
    expect(describeCatalog([probe]).split('\n')[1]).toBe('  props: icon? (/same-origin-path), caption?')
  })

  it('names what one item of a list is, whatever shape the item has', () => {
    // A list of bare values is what a reported gesture carries — the row numbers
    // one selection covers — so the rendering has to reach past a list of records.
    const list = (item: ComponentCatalogEntry['propsSchema'][string]['schema']): ComponentCatalogEntry['propsSchema'][string] =>
      ({ required: true, schema: { kind: 'array', minItems: 1, maxItems: 2, item } })
    const probe: ComponentCatalogEntry = {
      id: 'toy.probe',
      label: '探针',
      purpose: 'Described, never placed.',
      propsSchema: {
        words: list({ kind: 'string', maxLength: 4 }),
        counts: list({ kind: 'number', min: 0, max: 9 }),
        flags: list({ kind: 'boolean' }),
        tones: list({ kind: 'enum', values: ['wide', 2] }),
        grid: list({ kind: 'array', minItems: 1, maxItems: 2, item: { kind: 'string', maxLength: 4 } }),
      },
      actions: [],
      outputs: [],
    }
    expect(describeCatalog([probe]).split('\n')[1]).toBe(
      '  props: words[text] (1–2), counts[number] (1–2), flags[true|false] (1–2), tones[wide|2] (1–2), grid[[text]] (1–2)',
    )
  })

  it('derives the property line from the schema a call is judged against', () => {
    // Not written beside the catalog: a property the schema grows and the
    // description does not is a property no model will ever send.
    const probe: ComponentCatalogEntry = {
      id: 'toy.probe',
      label: '探针',
      purpose: 'Described, never placed.',
      propsSchema: {
        header: {
          required: true,
          schema: {
            kind: 'object',
            fields: {
              title: { required: true, schema: { kind: 'string', maxLength: 8 } },
              icon: { required: false, schema: { kind: 'string', maxLength: 8 } },
            },
          },
        },
        width: { required: false, schema: { kind: 'number', min: 1, max: 10 } },
        mode: { required: false, schema: { kind: 'enum', values: ['wide', 2] } },
      },
      actions: [],
      outputs: [],
    }
    expect(describeCatalog([probe]).split('\n')[1]).toBe('  props: header{title, icon?}, width? (1–10), mode? (wide|2)')
  })

  it('says on a component\'s own line that nothing comes back from it, and only there', () => {
    // The model reads this list one line at a time; a component that answers
    // nothing and one that answers a press must not read alike.
    const lines = describeCatalog(COMPONENT_CATALOG).split('\n')
    const silent = lines.filter(line => line.includes('Nothing comes back from it.'))
    expect(silent).toHaveLength(COMPONENT_CATALOG.filter(entry => entry.actions.length === 0).length)
    expect(silent[0]).toContain(RECORD_DETAIL_ID)
  })

  it('names the components a spec places in the wording shown on screen', () => {
    expect(catalogLabels([
      { id: 'a', component: CONFIRM_BAR_ID, props: {} },
      { id: 'b', component: RECORD_DETAIL_ID, props: {} },
    ])).toBe('确认条、记录详情')
  })

  it('falls back to the raw id for a node naming no catalog entry', () => {
    // Reachable from a persisted entry written before a component was renamed:
    // `resolve` deliberately consults no catalog, so a stored spec can outlive
    // the table the call was accepted against.
    expect(catalogLabels([{ id: 'a', component: 'toy.chart', props: {} }])).toBe('toy.chart')
  })
})

describe('the spec nesting ceiling', () => {
  /** One catalog entry around a declared property, for measuring what that property costs. */
  function entryWith(schema: ComponentCatalogEntry['propsSchema']): ComponentCatalogEntry {
    return { id: 'toy.probe', label: '探针', purpose: 'Measured, never placed.', propsSchema: schema, actions: [], outputs: [] }
  }

  it('leaves room for the deepest document this deployment declares as legal, and one layout level over', () => {
    // The layout is the deeper of the two documents a spec carries: the spec,
    // the stack it starts with, then a children list and a child per level —
    // ten for the four stacks a layout may open. The ceiling is one level over
    // that, so a layout opening a fifth stack is still walked far enough to be
    // refused at the stack that opened it rather than as a document too deep to
    // read.
    expect(MAX_SPEC_DEPTH).toBe(12)
  })

  it('spends four levels on a component whose properties are all scalars', () => {
    expect(maxSpecDepthOf([entryWith({ text: { required: true, schema: { kind: 'string', maxLength: 8 } } })])).toBe(4)
  })

  it('widens by one for a record whose keys are the caller\'s own', () => {
    const keyed = entryWith({
      row: {
        required: true,
        schema: { kind: 'record', key: { kind: 'string', maxLength: 8 }, maxKeys: 4, maxValueLength: 8, minValue: 0, maxValue: 1 },
      },
    })
    expect(maxSpecDepthOf([keyed])).toBe(5)
  })

  it('spends one level on a list of bare values, and two on a list of records', () => {
    const scalars = entryWith({
      picked: {
        required: true,
        schema: { kind: 'array', minItems: 0, maxItems: 4, item: { kind: 'number', min: 0, max: 9 } },
      },
    })
    expect(maxSpecDepthOf([scalars])).toBe(5)
  })

  it('widens by one for a record-valued property', () => {
    const nested = entryWith({
      header: {
        required: false,
        schema: { kind: 'object', fields: { title: { required: true, schema: { kind: 'string', maxLength: 8 } } } },
      },
    })
    expect(maxSpecDepthOf([nested])).toBe(5)
    // The properties of the whole catalog: spec, nodes, one node, its props,
    // the table's tableConfig, its gridItems list, one column, and that
    // column's renderer configuration — the shallower of the two documents, and
    // the one this function measures.
    expect(maxSpecDepthOf([...COMPONENT_CATALOG, nested])).toBe(8)
  })
})

describe('reading one bound property', () => {
  // Two readings, and the split is the point: what the caller *meant* is what
  // the refusals are written against, and what the seat resolves is only the
  // reference that came out whole.
  it('recognizes a value written as a binding, however malformed the reference is', () => {
    expect(isBindingValue({ [BINDING_KEY]: 'node:t.selection' })).toBe(true)
    expect(isBindingValue({ [BINDING_KEY]: 42, flex: 1 })).toBe(true)
    expect(isBindingValue({ from: 'node:t.selection' })).toBe(false)
    expect(isBindingValue([{ [BINDING_KEY]: 'node:t.selection' }])).toBe(false)
    expect(isBindingValue(null)).toBe(false)
    expect(isBindingValue('node:t.selection')).toBe(false)
  })

  it('reads a reference, with the item it takes where it takes one', () => {
    expect(parseBindingReference('node:t.selection')).toEqual({ sourceId: 't', outputId: 'selection' })
    expect(parseBindingReference('node:t.selection[0]')).toEqual({ sourceId: 't', outputId: 'selection', index: 0 })
    expect(parseBindingReference('node:a-1_b.selectionDetail[12]'))
      .toEqual({ sourceId: 'a-1_b', outputId: 'selectionDetail', index: 12 })
  })

  it.each([
    ['no source at all', 'node:.selection'],
    ['no output', 'node:t'],
    ['another scheme', 'entry:t.selection'],
    ['a path of its own', 'node:t.selection.first'],
    ['an item nothing bounds', 'node:t.selection[1000]'],
    ['a node id past the ceiling', `node:${'n'.repeat(33)}.selection`],
    ['an expression', 'node:t.selection.length > 0'],
  ])('reads nothing from a reference carrying %s', (_case, reference) => {
    expect(parseBindingReference(reference)).toBeUndefined()
  })

  it('reads a binding only where the property is one reference and nothing else', () => {
    expect(readBinding({ [BINDING_KEY]: 'node:t.selectionDetail' }))
      .toEqual({ sourceId: 't', outputId: 'selectionDetail' })
    expect(readBinding({ [BINDING_KEY]: 'node:t.selection', flex: 1 })).toBeUndefined()
    expect(readBinding({ [BINDING_KEY]: 42 })).toBeUndefined()
    expect(readBinding({ [BINDING_KEY]: 'selection' })).toBeUndefined()
    expect(readBinding([{ label: 'a', display: 'b' }])).toBeUndefined()
  })
})

describe('reading one call argument value', () => {
  it('reads a decoded argument record, the form Code Mode logs', () => {
    expect(readComponentCall({ id: 'budget', title: '预算', spec: { nodes: [] } }))
      .toEqual({ id: 'budget', title: '预算', spec: { nodes: [] } })
  })

  it('reads nothing from a value that is not an argument record', () => {
    expect(readComponentCall(null)).toBeUndefined()
    expect(readComponentCall('budget')).toBeUndefined()
    expect(readComponentCall([{ id: 'budget' }])).toBeUndefined()
  })

  it('reads raw argument JSON, the form a top-level call logs', () => {
    expect(parseComponentCall('{"id":"budget","title":"预算"}')).toEqual({ id: 'budget', title: '预算' })
  })

  it('reads nothing from a log line no reader can decode', () => {
    expect(parseComponentCall('{"id":')).toBeUndefined()
    expect(parseComponentCall('"budget"')).toBeUndefined()
  })
})
