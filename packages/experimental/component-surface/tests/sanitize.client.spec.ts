/**
 * The tightening pass, one rule at a time.
 *
 * Each rule is stated over a probe component rather than over whichever catalog
 * entry happens to declare it, because the rules outlive those components: a
 * rule seen only through one component is a rule nobody can see the shape of
 * until that component changes. The real catalog is then asked the two
 * questions the probe cannot answer — that the components declaring a reading
 * get it, and that the components declaring none are left alone.
 */

import { describe, expect, it } from 'vitest'
import {
  catalogEntry,
  CONFIRM_BAR_ID,
  METRIC_ID,
  RECORD_DETAIL_ID,
  TABLE_ID,
  type ComponentCatalogEntry,
} from '../src/component-call.ts'
import { sanitizeNodeProps } from '../src/sanitize.ts'

/** A component declaring one of every schema shape, and one of every tightened reading. */
const PROBE: ComponentCatalogEntry = {
  id: 'toy.probe',
  label: '探针',
  purpose: 'Sanitized, never placed.',
  propsSchema: {
    icon: { required: false, schema: { kind: 'string', maxLength: 200 } },
    accent: { required: false, schema: { kind: 'string', maxLength: 32 } },
    caption: { required: false, schema: { kind: 'string', maxLength: 32 } },
    width: { required: false, schema: { kind: 'number', min: 1, max: 10 } },
    dense: { required: false, schema: { kind: 'boolean' } },
    mode: { required: false, schema: { kind: 'enum', values: ['wide', 2] } },
    header: {
      required: false,
      schema: {
        kind: 'object',
        fields: {
          title: { required: false, schema: { kind: 'string', maxLength: 32 } },
          icon: { required: false, schema: { kind: 'string', maxLength: 200 } },
        },
      },
    },
    gridItems: {
      required: false,
      schema: {
        kind: 'array',
        minItems: 0,
        maxItems: 4,
        item: {
          kind: 'object',
          fields: {
            alias: { required: false, schema: { kind: 'string', maxLength: 32 } },
            relatedComponent: { required: false, schema: { kind: 'string', maxLength: 32 } },
          },
        },
      },
    },
    row: {
      required: false,
      schema: {
        kind: 'record',
        key: { kind: 'string', maxLength: 32 },
        maxKeys: 8,
        maxValueLength: 32,
        minValue: -10,
        maxValue: 10,
      },
    },
    cell: {
      required: false,
      schema: {
        kind: 'record',
        key: { kind: 'string', maxLength: 32 },
        maxKeys: 8,
        maxValueLength: 32,
        minValue: -10,
        maxValue: 10,
        sanitize: { accent: 'color' },
      },
    },
  },
  actions: [],
  sanitize: { icon: 'path', accent: 'color', relatedComponent: 'related-component' },
}

/** The probe's properties after the pass. */
function sanitized(props: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return sanitizeNodeProps(PROBE, props)
}

describe('a component declaring no tightened reading', () => {
  it.each([CONFIRM_BAR_ID, RECORD_DETAIL_ID])('leaves every property of %s as validation accepted it', (id) => {
    const component = catalogEntry(id)
    if (component === undefined) throw new Error(`the catalog no longer carries ${id}`)
    const props = id === CONFIRM_BAR_ID
      ? { title: '本月预算', message: '同意后立即生效。', buttons: [{ id: 'ok', label: '确认', tone: 'primary' }] }
      : { dataList: [{ label: '编号', display: 'A-1' }], labelWidth: 120, columnNum: 2 }
    expect(sanitizeNodeProps(component, props)).toEqual(props)
  })
})

describe('the components that do declare one', () => {
  /** One catalog entry's properties after the pass. */
  function realBlock(id: string, props: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const component = catalogEntry(id)
    if (component === undefined) throw new Error(`the catalog no longer carries ${id}`)
    return sanitizeNodeProps(component, props)
  }

  /** One table around one column. */
  function withColumn(column: Record<string, unknown>): Record<string, unknown> {
    return { tableConfig: { gridItems: [column] }, displayValueList: [{ zh_label: 'A-1' }] }
  }

  it('falls the table back to the plain cell renderer rather than leaving a cell undrawn', () => {
    const props = realBlock(TABLE_ID, withColumn({ relatedMetaAttr: 'state', relatedComponent: 'display_download' }))
    const columns = (props['tableConfig'] as { gridItems: Record<string, unknown>[] }).gridItems
    expect(columns[0]?.['relatedComponent']).toBe('display_default')
  })

  it('drops a cell colour the browser would have read as something else', () => {
    const props = realBlock(TABLE_ID, withColumn({
      relatedMetaAttr: 'state',
      relatedComponent: 'display_tag',
      relatedComponentObj: { color: 'var(--danger)', size: 20 },
    }))
    const columns = (props['tableConfig'] as { gridItems: Record<string, unknown>[] }).gridItems
    expect(columns[0]?.['relatedComponentObj']).toEqual({ size: 20 })
  })

  it('leaves a table row alone whose own field is called colour', () => {
    // The rule the record-level declaration buys: `color` is a configuration key
    // of a cell renderer and a perfectly ordinary column of somebody's data.
    const props = realBlock(TABLE_ID, {
      tableConfig: { gridItems: [{ relatedMetaAttr: 'color' }] },
      displayValueList: [{ color: '红色' }],
    })
    expect(props['displayValueList']).toEqual([{ color: '红色' }])
  })

  it('keeps the metric ball\'s colours and drops the ones that are not colours', () => {
    expect(realBlock(METRIC_ID, {
      process: 72,
      background: '#00D27A',
      borderColor: 'rgba(0,210,122,0.4)',
      pointColor: 'url(/x.png)',
    })).toEqual({ process: 72, background: '#00D27A', borderColor: 'rgba(0,210,122,0.4)' })
  })
})

describe('a property the component does not declare', () => {
  it('is dropped whole rather than trimmed', () => {
    // Unreachable through validation, which refuses such a call outright so the
    // model learns it misspelled something. This is the reading a stored record
    // gets, where there is no model left to tell.
    expect(sanitized({ caption: '在用', onClick: 'function(){}', style: { color: 'red' } }))
      .toEqual({ caption: '在用' })
  })

  it('is dropped at every level, not only the top one', () => {
    expect(sanitized({
      header: { title: '设备', script: 'alert(1)' },
      gridItems: [{ alias: '编号', render: 'function(){}' }],
    })).toEqual({ header: { title: '设备' }, gridItems: [{ alias: '编号' }] })
  })
})

describe('a path property', () => {
  it.each([
    ['a rooted path', '/assets/icon.svg'],
    ['a rooted path carrying a query and a fragment', '/api/records?id=1#top'],
    ['the root itself', '/'],
  ])('keeps %s', (_case, icon) => {
    expect(sanitized({ icon })).toEqual({ icon })
  })

  it.each([
    ['a protocol-relative address', '//evil.example/icon.svg'],
    ['a backslash-relative address', '/\\evil.example/icon.svg'],
    ['an absolute URL', 'https://evil.example/icon.svg'],
    ['a scheme with a payload', 'javascript:alert(1)'],
    ['a relative path', 'assets/icon.svg'],
    ['a path carrying a quote', '/assets/"onload=alert(1)'],
    ['a path carrying a space', '/assets/ icon.svg'],
    ['a value that is not a string', 42],
  ])('drops %s', (_case, icon) => {
    expect(sanitized({ icon })).toEqual({})
  })
})

describe('a color property', () => {
  it.each([
    ['a three-digit hex', '#fff'],
    ['a six-digit hex', '#A1B2C3'],
    ['rgb() with spaces', 'rgb(12, 34, 56)'],
    ['rgba() with a fraction', 'rgba(12,34,56,0.5)'],
    ['percentages', 'rgb(10%, 20%, 30%)'],
  ])('keeps %s', (_case, accent) => {
    expect(sanitized({ accent })).toEqual({ accent })
  })

  it.each([
    ['a named color', 'red'],
    ['a four-digit hex', '#ffff'],
    ['a custom property', 'var(--danger)'],
    ['another color space', 'hsl(1, 2%, 3%)'],
    ['too few channels', 'rgb(12, 34)'],
    ['a url behind a color', 'url(/x.png)'],
  ])('drops %s', (_case, accent) => {
    expect(sanitized({ accent })).toEqual({})
  })
})

describe('a renderer name', () => {
  it.each(['display_default', 'display_yesno', 'display_progress', 'display_circle', 'display_tag'])(
    'keeps %s, which this build has',
    (relatedComponent) => {
      expect(sanitized({ gridItems: [{ relatedComponent }] })).toEqual({ gridItems: [{ relatedComponent }] })
    },
  )

  it.each([
    ['a renderer this build does not have', 'display_download'],
    ['a renderer that is not one at all', 'function(){}'],
  ])('falls back to the plain renderer for %s', (_case, relatedComponent) => {
    // A drop would leave the cell with nothing to draw it, so this is the one
    // reading that answers with a value of its own rather than an absence.
    expect(sanitized({ gridItems: [{ relatedComponent }] }))
      .toEqual({ gridItems: [{ relatedComponent: 'display_default' }] })
  })

  it('drops a renderer name that is not a string', () => {
    expect(sanitized({ gridItems: [{ relatedComponent: 3 }] })).toEqual({ gridItems: [{}] })
  })
})

describe('a record whose keys are the caller\'s own', () => {
  it('keeps every scalar it carries, whatever the keys are called', () => {
    expect(sanitized({ row: { zh_label: 'A-1', state: 0, spare: false } }))
      .toEqual({ row: { zh_label: 'A-1', state: 0, spare: false } })
  })

  it('drops a key whose value is not a scalar, keeping the rest', () => {
    expect(sanitized({ row: { zh_label: 'A-1', nested: { text: 'A-1' }, listed: ['A-1'], missing: null } }))
      .toEqual({ row: { zh_label: 'A-1' } })
  })

  it('reads a key the record itself declares as narrower than text', () => {
    expect(sanitized({ cell: { accent: '#67C23A', size: 20 } })).toEqual({ cell: { accent: '#67C23A', size: 20 } })
    expect(sanitized({ cell: { accent: 'var(--danger)', size: 20 } })).toEqual({ cell: { size: 20 } })
  })

  it('leaves the same key name alone in a record that declares no reading for it', () => {
    // The whole reason a record declares its own readings rather than sharing
    // the component's: a field of the caller's data that happens to be called
    // what a configuration key is called is still data.
    expect(sanitized({ row: { accent: '红色' } })).toEqual({ row: { accent: '红色' } })
  })

  it('drops a record-valued property carrying something that is not a record', () => {
    expect(sanitized({ row: ['A-1'], caption: '在用' })).toEqual({ caption: '在用' })
  })

  it('freezes what it answers with, so a Vue renderer cannot observe a row', () => {
    const result = sanitized({ row: { zh_label: 'A-1' } })
    expect(Object.isFrozen(result['row'])).toBe(true)
  })
})

describe('the shapes the pass descends through', () => {
  it('keeps a number, a yes-or-no and an enumerated value as they are', () => {
    expect(sanitized({ width: 4, dense: false, mode: 2 })).toEqual({ width: 4, dense: false, mode: 2 })
  })

  it.each([
    ['a list', ['设备']],
    ['a string', '设备'],
    ['nothing at all', null],
  ])('drops a record-valued property carrying %s', (_case, header) => {
    expect(sanitized({ header, caption: '在用' })).toEqual({ caption: '在用' })
  })

  it('drops a list-valued property that is not a list', () => {
    expect(sanitized({ gridItems: { alias: '编号' }, caption: '在用' })).toEqual({ caption: '在用' })
  })

  it('drops the one item of a list that is not a record, keeping the rest', () => {
    expect(sanitized({ gridItems: [{ alias: '编号' }, '状态', { alias: '状态' }] }))
      .toEqual({ gridItems: [{ alias: '编号' }, { alias: '状态' }] })
  })

  it('answers with a new record rather than the one it was handed', () => {
    const props = { caption: '在用', header: { title: '设备' } }
    const result = sanitized(props)
    expect(result).not.toBe(props)
    expect(result['header']).not.toBe(props.header)
  })
})

describe('what the pass answers with', () => {
  it('is frozen to the bottom, so a renderer may read it and no framework may rewrite it', () => {
    const props = {
      caption: '在用',
      header: { title: '设备' },
      gridItems: [{ alias: '编号' }, { alias: '状态' }],
    }
    const result = sanitized(props)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result['header'])).toBe(true)
    expect(Object.isFrozen(result['gridItems'])).toBe(true)
    expect(Object.isFrozen((result['gridItems'] as readonly unknown[])[0])).toBe(true)
  })

  it('leaves the record it was handed writable, having copied rather than frozen it', () => {
    const props = { caption: '在用', header: { title: '设备' } }
    sanitized(props)
    expect(Object.isFrozen(props)).toBe(false)
    expect(Object.isFrozen(props.header)).toBe(false)
  })
})
