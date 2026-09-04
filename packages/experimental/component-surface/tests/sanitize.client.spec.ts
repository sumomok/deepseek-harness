/**
 * The tightening pass, one rule at a time.
 *
 * Every case is stated over a probe component rather than over the deployment's
 * catalog, because the rules outlive the components that use them: no catalog
 * entry today declares a path, a color, or a renderer name, and a rule that were
 * only exercised through whichever component happens to declare it would be a
 * rule nobody could see the shape of until that component landed.
 *
 * What the real catalog is asked here is the negative: it declares no tightened
 * reading at all, so the pass over a real block returns the block's properties
 * unchanged.
 */

import { describe, expect, it } from 'vitest'
import { catalogEntry, CONFIRM_BAR_ID, RECORD_DETAIL_ID, type ComponentCatalogEntry } from '../src/component-call.ts'
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

describe('the shapes the pass descends through', () => {
  it('keeps a number and an enumerated value as they are', () => {
    expect(sanitized({ width: 4, mode: 2 })).toEqual({ width: 4, mode: 2 })
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
