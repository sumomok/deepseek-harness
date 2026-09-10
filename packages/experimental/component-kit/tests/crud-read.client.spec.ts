// @vitest-environment jsdom
/**
 * The readings behind `toy.crud`: how a block's properties become the prop
 * record `Crud` takes, and how each of the page's three events is reduced to
 * the bounded report the placement package's catalog admits.
 */
import { describe, expect, it } from 'vitest'
import { CRUD_READ_ONLY_PROPS, type CrudTableCellClickPayload } from '@sumomok/toy-crud-kit'
import { CRUD_REPORT_LIMITS } from '../src/client/crud-limits.ts'
import {
  loadReport,
  readCellClick,
  readCrud,
  readLoadedColumns,
  readQuery,
  type CrudVueProps,
} from '../src/client/crud-read.ts'

/**
 * One block's properties as `Crud` takes them, for the cases about what a
 * reading keeps rather than about whether it happens at all.
 * @param props - the block's properties.
 * @returns the prop record.
 * @throws {Error} when the block names no table, which those cases never write.
 */
function crud(props: Record<string, unknown>): CrudVueProps {
  const read = readCrud(props)
  if (read === undefined) throw new Error('the block under test names no table')
  return read
}

/** One clicked cell, as the page emits it. */
function click(row: Record<string, unknown>, column: CrudTableCellClickPayload['column']): CrudTableCellClickPayload {
  return { row, column, cell: null, event: new Event('click') }
}

describe('the prop record', () => {
  it('carries the host-fixed properties over whatever the call wrote, and the component\'s own defaults elsewhere', () => {
    expect(readCrud({ relatedMeta: 'device', isReadOnly: false, hideButton: {}, type: 'other' })).toEqual({
      relatedMeta: 'device',
      conditions: [],
      selectMode: null,
      myStyle: 'width:100%;height:100%',
      ...CRUD_READ_ONLY_PROPS,
    })
  })

  it('reads every property a call may choose', () => {
    expect(readCrud({
      relatedMeta: 'device',
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'n', op: 'IN', value: [1, 'x', Number.NaN, true] }],
      matchMode: 'OR',
      querySort: { asc: 'city', desc: 'state' },
      selectMode: 'radio',
      isExpandQuery: false,
      isInitQuery: true,
    })).toMatchObject({
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'n', op: 'IN', value: [1, 'x'] }],
      matchMode: 'OR',
      querySort: { asc: 'city', desc: 'state' },
      selectMode: 'radio',
      isExpandQuery: false,
      isInitQuery: true,
    })
    expect(crud({ relatedMeta: 'device', querySort: { desc: 'state' } }).querySort).toEqual({ desc: 'state' })
    expect(crud({ relatedMeta: 'device', querySort: { asc: 'city' } }).querySort).toEqual({ asc: 'city' })
  })

  it('leaves out what the call wrote in a form the component cannot use', () => {
    const props = crud({
      relatedMeta: 'device',
      conditions: [7, { op: 'EQ', value: 1 }, { key: 'a', value: 1 }, { key: 'a', op: 'EQ', value: null }, { key: 'a', op: 'EQ', value: Number.POSITIVE_INFINITY }],
      matchMode: 'XOR',
      querySort: { asc: '', desc: 3 },
      selectMode: 'all',
      isExpandQuery: 'yes',
    })
    expect(props.conditions).toEqual([])
    expect(props).not.toHaveProperty('matchMode')
    expect(props).not.toHaveProperty('querySort')
    expect(props.selectMode).toBeNull()
    expect(props).not.toHaveProperty('isExpandQuery')
    expect(crud({ relatedMeta: 'device', querySort: 'asc' })).not.toHaveProperty('querySort')
  })

  it('refuses a block that names no table rather than opening the page on nothing', () => {
    // `relatedMeta` is required in the catalog that admits the block, so this
    // is a record no call wrote; an empty table name would mount the page
    // against nothing and report that as a load.
    expect(readCrud({ metaLabel: '演示设备' })).toBeUndefined()
    expect(readCrud({ relatedMeta: '' })).toBeUndefined()
    expect(readCrud({ relatedMeta: 7 })).toBeUndefined()
  })
})

describe('the loaded columns', () => {
  it('keeps the drawn columns in order, cuts a long header, and leaves out a hidden or unnameable one', () => {
    const long = '头'.repeat(CRUD_REPORT_LIMITS.headerLength + 3)
    expect(readLoadedColumns({ schemaConfig: { query: { grid: { gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' },
      { relatedMetaAttr: 'city', alias: long },
      { relatedMetaAttr: 'state', isShow: true },
      { relatedMetaAttr: 'secret', alias: '隐藏', isShow: '0' },
      { relatedMetaAttr: '1st', alias: '数字开头' },
      { relatedMetaAttr: 'a'.repeat(65), alias: '太长' },
      { relatedMetaAttr: '', alias: '空' },
    ] } } } })).toEqual([
      { attr: 'zh_label', alias: '名称' },
      { attr: 'city', alias: `${'头'.repeat(CRUD_REPORT_LIMITS.headerLength - 1)}…` },
      { attr: 'state' },
    ])
  })

  it('reads no column out of a scheme with no grid', () => {
    expect(readLoadedColumns({ schemaConfig: {} })).toEqual([])
    expect(readLoadedColumns({ schemaConfig: { query: { grid: {} } } })).toEqual([])
  })

  it('reports an attribute the scheme draws twice once, under the header it draws first', () => {
    // The catalog admits one entry per attribute, so a second one would make
    // the whole load a report the agent never receives.
    expect(readLoadedColumns({ schemaConfig: { query: { grid: { gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称' },
      { relatedMetaAttr: 'city', alias: '城市' },
      { relatedMetaAttr: 'zh_label', alias: '名称（副）' },
    ] } } } })).toEqual([{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }])
  })

  it('names the first columns in a load and counts them all', () => {
    const columns = Array.from({ length: CRUD_REPORT_LIMITS.columns + 2 }, (_unused, index) => ({ attr: `c${index}` }))
    expect(loadReport('device', columns)).toEqual({ meta: 'device', columns: columns.slice(0, CRUD_REPORT_LIMITS.columns), total: columns.length })
  })
})

describe('an answered query', () => {
  it('is three counts', () => {
    expect(readQuery({ rawValue: [], displayValue: [{}, {}], ref: [], page: { total: 89, currentPage: 3, pageSize: 20 } }))
      .toEqual({ total: 89, rows: 2, page: 3 })
  })

  it.each([
    ['a page counted from zero', { displayValue: [], page: { total: 1, currentPage: 0 } }],
    ['a fractional total', { displayValue: [], page: { total: 1.5, currentPage: 1 } }],
    ['a total that is not a number', { displayValue: [], page: { total: '3', currentPage: 1 } }],
    ['no page at all', { displayValue: [] }],
    ['no row list', { displayValue: null, page: { total: 3, currentPage: 1 } }],
    ['a total wider than a report carries', { displayValue: [], page: { total: CRUD_REPORT_LIMITS.number + 1, currentPage: 1 } }],
  ])('is not reported for %s', (_case, payload) => {
    expect(readQuery({ rawValue: [], ref: [], ...payload } as never)).toBeUndefined()
  })
})

describe('a clicked cell', () => {
  const COLUMNS = [{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }, { attr: 'count' }, { attr: 'flag' }, { attr: 'nested' }]

  it('carries the column, its header, and the row read through the drawn columns', () => {
    const long = 'x'.repeat(CRUD_REPORT_LIMITS.cellLength + 1)
    expect(readCellClick(click({ zh_label: long, city: '北京', count: 3, flag: true, nested: { a: 1 }, secret: 's' }, { property: 'city', label: '城市' }), COLUMNS))
      .toEqual({
        attr: 'city',
        label: '城市',
        row: { zh_label: `${'x'.repeat(CRUD_REPORT_LIMITS.cellLength - 1)}…`, city: '北京', count: 3, flag: true },
      })
  })

  it('stands the attribute in for a header the page drew none of, and cuts a long one', () => {
    expect(readCellClick(click({}, { property: 'city' }), [])).toEqual({ attr: 'city', label: 'city', row: {} })
    const long = '头'.repeat(CRUD_REPORT_LIMITS.headerLength + 1)
    expect(readCellClick(click({}, { property: 'city', label: long }), [])?.label).toBe(`${'头'.repeat(CRUD_REPORT_LIMITS.headerLength - 1)}…`)
  })

  it('reports at most the first drawn columns of a wide row', () => {
    const columns = Array.from({ length: CRUD_REPORT_LIMITS.cells + 1 }, (_unused, index) => ({ attr: `c${index}` }))
    const row = Object.fromEntries(columns.map(column => [column.attr, 1]))
    expect(Object.keys(readCellClick(click(row, { property: 'c0' }), columns)?.row ?? {})).toHaveLength(CRUD_REPORT_LIMITS.cells)
  })

  it('leaves out a cell whose number is wider than a report carries, and keeps one at the edge', () => {
    // `JSON.parse` has already rounded a nineteen-digit backend id by the time
    // it reaches here, and the catalog refuses a record carrying one, so the
    // cell goes rather than the whole click report.
    const row = { zh_label: 'A-1', city: CRUD_REPORT_LIMITS.number + 1, count: -CRUD_REPORT_LIMITS.number - 2, flag: CRUD_REPORT_LIMITS.number }
    expect(readCellClick(click(row, { property: 'zh_label', label: '名称' }), COLUMNS)?.row)
      .toEqual({ zh_label: 'A-1', flag: CRUD_REPORT_LIMITS.number })
  })

  it('is not reported for a column the catalog would refuse', () => {
    expect(readCellClick(click({}, { property: '1st' }), COLUMNS)).toBeUndefined()
    expect(readCellClick(click({}, {}), COLUMNS)).toBeUndefined()
  })
})
