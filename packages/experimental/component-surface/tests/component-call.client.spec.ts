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
  catalogEntry,
  catalogLabels,
  COMPONENT_CATALOG,
  COMPONENT_KIND,
  CONFIRM_BAR_ID,
  describeCatalog,
  FILTER_BAR_ID,
  MATCH_OPERATORS,
  MAX_SPEC_DEPTH,
  maxSpecDepthOf,
  METRIC_ID,
  RECORD_DETAIL_ID,
  parseComponentCall,
  readComponentCall,
  SHOW_COMPONENT_TOOL_NAME,
  TABLE_ID,
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
    expect(describeCatalog(COMPONENT_CATALOG).split('\n')).toHaveLength(2 * COMPONENT_CATALOG.length)
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
    return { id: 'toy.probe', label: '探针', purpose: 'Measured, never placed.', propsSchema: schema, actions: [] }
  }

  it('leaves room for the deepest document this deployment declares as legal', () => {
    // spec, nodes, one node, its props, the table's tableConfig, its gridItems
    // list, one column, and that column's renderer configuration.
    expect(MAX_SPEC_DEPTH).toBe(8)
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
    expect(maxSpecDepthOf([...COMPONENT_CATALOG, nested])).toBe(MAX_SPEC_DEPTH)
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
