// @vitest-environment jsdom
/**
 * The readings behind `toy.data-page`: how a block's properties become the prop
 * record `DataPage` takes, and how each of the page's events is reduced to the
 * bounded report the placement package's catalog admits.
 */
import { describe, expect, it } from 'vitest'
import {
  DATA_PAGE_LAYOUT_PROPS,
  DATA_PAGE_MODEL_SETTABLE_PROPS,
  DATA_PAGE_ROW_OPERATIONS as PAGE_ROW_OPERATIONS,
  DATA_PAGE_TOOLBAR_BUTTONS as PAGE_TOOLBAR_BUTTONS,
  type CrudTableCellClickPayload,
} from '@sumomok/toy-crud-kit'
import {
  DATA_PAGE_MODEL_PROP_NAMES,
  DATA_PAGE_ROW_OPERATIONS,
  DATA_PAGE_TOOLBAR_BUTTONS,
  DATA_PAGE_VIEW_PROP_NAMES,
} from '@deepseek-ai/dsh-experimental-component-surface'
import { DATA_PAGE_REPORT_LIMITS } from '../src/client/data-page-limits.ts'
import {
  loadReport,
  readAccessDenied,
  readGrantedRights,
  readCardOpen,
  readCellClick,
  readDataPage,
  readExportTask,
  readLoadedColumns,
  readOperation,
  readQuery,
  readSaved,
  readSelection,
  type DataPageVueProps,
} from '../src/client/data-page-read.ts'

/**
 * One block's properties as `DataPage` takes them, for the cases about what a
 * reading keeps rather than about whether it happens at all.
 * @param props - the block's properties.
 * @returns the prop record.
 * @throws {Error} when the block names no table, which those cases never write.
 */
function page(props: Record<string, unknown>): DataPageVueProps {
  const read = readDataPage(props)
  if (read === undefined) throw new Error('the block under test names no table')
  return read
}

/** One clicked cell, as the page emits it. */
function click(row: Record<string, unknown>, column: CrudTableCellClickPayload['column']): CrudTableCellClickPayload {
  return { row, column, cell: null, event: new Event('click') }
}

describe('the prop record', () => {
  it('names the table and leaves every unwritten property to the page\'s own default', () => {
    // The page defaults to an arrangement holding everything and refusing every
    // write, so a block that named none of it must reach the page carrying none
    // of it: a second default written here would be a second place to change.
    expect(readDataPage({ relatedMeta: 'device' })).toEqual({
      relatedMeta: 'device',
      conditions: [],
      myStyle: 'width:100%;height:100%',
    })
  })

  it('reads every property a call may choose', () => {
    expect(readDataPage({
      relatedMeta: 'device',
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'n', op: 'IN', value: [1, 'x', Number.NaN, true] }],
      matchMode: 'OR',
      querySort: { asc: 'city', desc: 'state' },
      selectMode: 'radio',
      isInitQuery: true,
      customOperations: [{ name: 'ping', label: '测试连通' }],
    })).toMatchObject({
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'n', op: 'IN', value: [1, 'x'] }],
      matchMode: 'OR',
      querySort: { asc: 'city', desc: 'state' },
      selectMode: 'radio',
      isInitQuery: true,
      customOperations: [{ name: 'ping', label: '测试连通' }],
    })
    expect(page({ relatedMeta: 'device', querySort: { desc: 'state' } }).querySort).toEqual({ desc: 'state' })
    expect(page({ relatedMeta: 'device', querySort: { asc: 'city' } }).querySort).toEqual({ asc: 'city' })
  })

  it('reads every property a written-down page may arrange, including the one that opens it for writing', () => {
    expect(page({
      relatedMeta: 'device',
      regions: { query: true, infoCard: false, addForm: 'yes' },
      toolbarButtons: ['add', 'search'],
      rowOperations: ['modify'],
      queryExpanded: true,
      pageSize: 50,
      pageSizes: [10, 50],
      infoCardTabs: ['attributes'],
      readOnly: false,
    })).toMatchObject({
      regions: { query: true, infoCard: false },
      toolbarButtons: ['add', 'search'],
      rowOperations: ['modify'],
      queryExpanded: true,
      pageSize: 50,
      pageSizes: [10, 50],
      infoCardTabs: ['attributes'],
      readOnly: false,
    })
  })

  it('leaves out what the call wrote in a form the component cannot use', () => {
    const props = page({
      relatedMeta: 'device',
      conditions: [7, { op: 'EQ', value: 1 }, { key: 'a', value: 1 }, { key: 'a', op: 'EQ', value: null }, { key: 'a', op: 'EQ', value: Number.POSITIVE_INFINITY }],
      matchMode: 'XOR',
      querySort: { asc: '', desc: 3 },
      selectMode: 'all',
      customOperations: [{ name: 'ping' }, { label: '只有文字' }, 7],
      regions: 'all',
      pageSize: Number.NaN,
      pageSizes: [10, 'many'],
      queryExpanded: 'yes',
    })
    expect(props.conditions).toEqual([])
    expect(props).not.toHaveProperty('matchMode')
    expect(props).not.toHaveProperty('querySort')
    expect(props).not.toHaveProperty('selectMode')
    expect(props.customOperations).toEqual([])
    expect(props).not.toHaveProperty('regions')
    expect(props).not.toHaveProperty('pageSize')
    expect(props.pageSizes).toEqual([10])
    expect(props).not.toHaveProperty('queryExpanded')
    expect(page({ relatedMeta: 'device', querySort: 'asc' })).not.toHaveProperty('querySort')
  })

  it('reads the two groups the vendored page itself declares, and nothing else', () => {
    // The page's own two lists are what a call may choose and what a
    // written-down page may arrange; the catalog declares the same two, plus
    // the name on the approval card and the read-only flag, which stop on the
    // host side of the seam. A property on one side and not the other is a
    // property that reaches the page as nothing, with nothing failing.
    expect(DATA_PAGE_MODEL_PROP_NAMES.filter(name => name !== 'metaLabel')).toEqual([...DATA_PAGE_MODEL_SETTABLE_PROPS])
    expect(DATA_PAGE_VIEW_PROP_NAMES.filter(name => name !== 'readOnly')).toEqual([...DATA_PAGE_LAYOUT_PROPS])
    // And the reading passes on every one of them: a name the reader forgot
    // would be a property the user arranged and the page never received.
    const arranged = page({
      relatedMeta: 'device',
      metaLabel: '设备台账',
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }],
      matchMode: 'AND',
      querySort: { asc: 'city' },
      selectMode: 'checkbox',
      isInitQuery: false,
      customOperations: [{ name: 'ping', label: '测试连通' }],
      regions: { query: true },
      toolbarButtons: ['add'],
      rowOperations: ['modify'],
      queryExpanded: true,
      pageSize: 20,
      pageSizes: [20],
      infoCardTabs: ['attributes'],
      readOnly: false,
    })
    const reached = new Set(Object.keys(arranged))
    for (const name of [...DATA_PAGE_MODEL_SETTABLE_PROPS, ...DATA_PAGE_LAYOUT_PROPS, 'readOnly']) {
      expect(reached).toContain(name)
    }
    // `metaLabel` is the one property the host keeps: it is the name on the
    // card the user answered, and the page has no use for it.
    expect(reached).not.toContain('metaLabel')
  })

  it('offers the buttons and the row operations the vendored page itself accepts, value for value', () => {
    // The catalog admits these two lists and the page's own prop validator
    // admits those two; a view accepted here and refused there would be a
    // button nobody drew and nothing reported, and a view refused here and
    // accepted there would be a button this deployment could not ask for.
    expect(DATA_PAGE_TOOLBAR_BUTTONS).toEqual([...PAGE_TOOLBAR_BUTTONS])
    expect(DATA_PAGE_ROW_OPERATIONS).toEqual([...PAGE_ROW_OPERATIONS])
  })

  it('refuses a block that names no table rather than opening the page on nothing', () => {
    // `relatedMeta` is required in the catalog that admits the block, so this
    // is a record no call wrote; an empty table name would mount the page
    // against nothing and report that as a load.
    expect(readDataPage({ metaLabel: '演示设备' })).toBeUndefined()
    expect(readDataPage({ relatedMeta: '' })).toBeUndefined()
    expect(readDataPage({ relatedMeta: 7 })).toBeUndefined()
  })
})

describe('the loaded columns', () => {
  it('keeps the drawn columns in order, cuts a long header, and leaves out a hidden or unnameable one', () => {
    const long = '头'.repeat(DATA_PAGE_REPORT_LIMITS.headerLength + 3)
    expect(readLoadedColumns({ authButton: {}, schemaConfig: { query: { grid: { gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' },
      { relatedMetaAttr: 'city', alias: long },
      { relatedMetaAttr: 'state', isShow: true },
      { relatedMetaAttr: 'secret', alias: '隐藏', isShow: '0' },
      { relatedMetaAttr: '1st', alias: '数字开头' },
      { relatedMetaAttr: 'a'.repeat(65), alias: '太长' },
      { relatedMetaAttr: '', alias: '空' },
    ] } } } })).toEqual([
      { attr: 'zh_label', alias: '名称' },
      { attr: 'city', alias: `${'头'.repeat(DATA_PAGE_REPORT_LIMITS.headerLength - 1)}…` },
      { attr: 'state' },
    ])
  })

  it('reads no column out of a scheme with no grid', () => {
    expect(readLoadedColumns({ authButton: {}, schemaConfig: {} })).toEqual([])
    expect(readLoadedColumns({ authButton: {}, schemaConfig: { query: { grid: {} } } })).toEqual([])
  })

  it('reports an attribute the scheme draws twice once, under the header it draws first', () => {
    // The catalog admits one entry per attribute, so a second one would make
    // the whole load a report the agent never receives.
    expect(readLoadedColumns({ authButton: {}, schemaConfig: { query: { grid: { gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称' },
      { relatedMetaAttr: 'city', alias: '城市' },
      { relatedMetaAttr: 'zh_label', alias: '名称（副）' },
    ] } } } })).toEqual([{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }])
  })

  it('names the first columns in a load and counts them all', () => {
    const columns = Array.from({ length: DATA_PAGE_REPORT_LIMITS.columns + 2 }, (_unused, index) => ({ attr: `c${index}` }))
    expect(loadReport('device', columns, ['add'])).toEqual({
      meta: 'device',
      columns: columns.slice(0, DATA_PAGE_REPORT_LIMITS.columns),
      total: columns.length,
      rights: ['add'],
    })
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
    ['a total wider than a report carries', { displayValue: [], page: { total: DATA_PAGE_REPORT_LIMITS.number + 1, currentPage: 1 } }],
  ])('is not reported for %s', (_case, payload) => {
    expect(readQuery({ rawValue: [], ref: [], ...payload } as never)).toBeUndefined()
  })
})

describe('a clicked cell', () => {
  const COLUMNS = [{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }, { attr: 'count' }, { attr: 'flag' }, { attr: 'nested' }]

  it('carries the column, its header, and the row read through the drawn columns', () => {
    const long = 'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength + 1)
    expect(readCellClick(click({ zh_label: long, city: '北京', count: 3, flag: true, nested: { a: 1 }, secret: 's' }, { property: 'city', label: '城市' }), COLUMNS))
      .toEqual({
        attr: 'city',
        label: '城市',
        row: { zh_label: `${'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength - 1)}…`, city: '北京', count: 3, flag: true },
      })
  })

  it('stands the attribute in for a header the page drew none of, and cuts a long one', () => {
    expect(readCellClick(click({}, { property: 'city' }), [])).toEqual({ attr: 'city', label: 'city', row: {} })
    const long = '头'.repeat(DATA_PAGE_REPORT_LIMITS.headerLength + 1)
    expect(readCellClick(click({}, { property: 'city', label: long }), [])?.label).toBe(`${'头'.repeat(DATA_PAGE_REPORT_LIMITS.headerLength - 1)}…`)
  })

  it('reports at most the first drawn columns of a wide row', () => {
    const columns = Array.from({ length: DATA_PAGE_REPORT_LIMITS.cells + 1 }, (_unused, index) => ({ attr: `c${index}` }))
    const row = Object.fromEntries(columns.map(column => [column.attr, 1]))
    expect(Object.keys(readCellClick(click(row, { property: 'c0' }), columns)?.row ?? {})).toHaveLength(DATA_PAGE_REPORT_LIMITS.cells)
  })

  it('leaves out a cell whose number is wider than a report carries, and keeps one at the edge', () => {
    // `JSON.parse` has already rounded a nineteen-digit backend id by the time
    // it reaches here, and the catalog refuses a record carrying one, so the
    // cell goes rather than the whole click report.
    const row = { zh_label: 'A-1', city: DATA_PAGE_REPORT_LIMITS.number + 1, count: -DATA_PAGE_REPORT_LIMITS.number - 2, flag: DATA_PAGE_REPORT_LIMITS.number }
    expect(readCellClick(click(row, { property: 'zh_label', label: '名称' }), COLUMNS)?.row)
      .toEqual({ zh_label: 'A-1', flag: DATA_PAGE_REPORT_LIMITS.number })
  })

  it('is not reported for a column the catalog would refuse', () => {
    expect(readCellClick(click({}, { property: '1st' }), COLUMNS)).toBeUndefined()
    expect(readCellClick(click({}, {}), COLUMNS)).toBeUndefined()
  })
})

describe('the rights a load reports', () => {
  it('names the keys this deployment left on, in the record\'s own order and however it spells yes', () => {
    expect(readGrantedRights({ schemaConfig: {}, authButton: { add: 1, update: '1', exp: true, imp: 0, batch: '0', gridexp: false } }))
      .toEqual(['add', 'update', 'exp'])
  })

  it('leaves out what a report may not carry, and stops at the ceiling', () => {
    // The rights arrive as the deployment's own row, with its own bookkeeping
    // columns beside the buttons, so a key a report cannot carry goes rather
    // than the whole load.
    expect(readGrantedRights({ schemaConfig: {}, authButton: { resclassenname: 'device', '1st': 1, ['b'.repeat(25)]: 1, add: 1 } }))
      .toEqual(['add'])
    const many = Object.fromEntries(Array.from({ length: DATA_PAGE_REPORT_LIMITS.rights + 3 }, (_unused, index) => [`b${index}`, 1]))
    expect(readGrantedRights({ schemaConfig: {}, authButton: many })).toHaveLength(DATA_PAGE_REPORT_LIMITS.rights)
  })

  it('names nothing where the page reported no rights at all', () => {
    expect(readGrantedRights({ schemaConfig: {}, authButton: null as never })).toEqual([])
  })
})

describe('a change of ticked rows', () => {
  const COLUMNS = [{ attr: 'zh_label', alias: '名称' }, { attr: 'city' }]

  it('counts them and names the first few by their first drawn cell', () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => ({ zh_label: `A-${index}`, city: '北京' }))
    expect(readSelection(rows, COLUMNS)).toEqual({
      count: 9,
      names: ['A-0', 'A-1', 'A-2', 'A-3', 'A-4'],
    })
    expect(readSelection([], COLUMNS)).toEqual({ count: 0, names: [] })
  })

  it('falls through to the next drawn column for a row whose first cell shows nothing', () => {
    expect(readSelection([{ zh_label: '', city: '北京' }, { zh_label: null, city: 7 }], COLUMNS))
      .toEqual({ count: 2, names: ['北京', '7'] })
    // A row no drawn column holds anything readable for is counted and not named.
    expect(readSelection([{ zh_label: '', city: '' }], COLUMNS)).toEqual({ count: 1, names: [] })
  })

  it('is not reported at all past the count a report may carry', () => {
    const rows = Array.from({ length: DATA_PAGE_REPORT_LIMITS.tickedRows + 1 }, () => ({ zh_label: 'A' }))
    expect(readSelection(rows, COLUMNS)).toBeUndefined()
    expect(readSelection(rows.slice(1), COLUMNS)?.count).toBe(DATA_PAGE_REPORT_LIMITS.tickedRows)
  })
})

describe('an opened side card', () => {
  it('names the row the page named, and falls back to the id it carries', () => {
    expect(readCardOpen({ id: '41', name: '北京-核心-01', type: 'device' })).toEqual({ name: '北京-核心-01' })
    expect(readCardOpen({ id: '41', name: '', type: 'device' })).toEqual({ name: '41' })
    expect(readCardOpen({ id: '', name: '', type: '' })).toBeUndefined()
  })

  it('cuts a name longer than a report carries', () => {
    const long = 'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength + 1)
    expect(readCardOpen({ id: '41', name: long, type: 'device' })?.name)
      .toBe(`${'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength - 1)}…`)
  })
})

describe('a saved record', () => {
  const COLUMNS = [{ attr: 'zh_label', alias: '名称' }, { attr: 'city' }]

  it('keeps the drawn cells that name it, in the page\'s own order, and stops at the ceiling', () => {
    const drawn = Array.from({ length: DATA_PAGE_REPORT_LIMITS.savedFields + 2 }, (_unused, index) => ({ attr: `f${index}` }))
    const answer = Object.fromEntries(drawn.map(({ attr }, index) => [attr, index]))
    expect(Object.keys(readSaved(answer, drawn).record)).toHaveLength(DATA_PAGE_REPORT_LIMITS.savedFields)
    expect(readSaved({ city: '北京', zh_label: '新建-01' }, COLUMNS).record).toEqual({ zh_label: '新建-01', city: '北京' })
  })

  it('leaves out an attribute the page draws no column for, whatever the endpoint answered', () => {
    // The endpoint answers with the record, which carries the row's key and
    // every attribute the scheme hides from the table; only the drawn cells
    // are the user's own screen, so only those are reported.
    expect(readSaved({ int_id: '41', zh_label: '新建-01', secret_col: 's1' }, COLUMNS).record)
      .toEqual({ zh_label: '新建-01' })
  })

  it('leaves out what a report may not carry, and still reports the save', () => {
    expect(readSaved({ zh_label: { a: 1 }, city: '北京' }, COLUMNS).record).toEqual({ city: '北京' })
    expect(readSaved({ int_id: 41 }, COLUMNS).record).toEqual({})
    expect(readSaved('OK', COLUMNS).record).toEqual({})
    expect(readSaved(undefined, COLUMNS).record).toEqual({})
    expect(readSaved({ zh_label: '新建-01' }, []).record).toEqual({})
  })
})

describe('a pressed row operation', () => {
  const COLUMNS = [{ attr: 'zh_label', alias: '名称' }]

  it('carries the operation the page handed back and the row it was pressed on', () => {
    expect(readOperation({ name: 'ping', label: '测试连通' }, { zh_label: 'A-1', secret: 's' }, COLUMNS))
      .toEqual({ opId: 'ping', row: { zh_label: 'A-1' } })
  })

  it('is not reported where the operation or the row is one the catalog would refuse', () => {
    expect(readOperation({ name: '1st' }, { zh_label: 'A-1' }, COLUMNS)).toBeUndefined()
    expect(readOperation({}, { zh_label: 'A-1' }, COLUMNS)).toBeUndefined()
    expect(readOperation({ name: 'ping' }, undefined, COLUMNS)).toBeUndefined()
  })
})

describe('a submitted export', () => {
  it('names which of the two exports it was and the file type the press named', () => {
    expect(readExportTask({ mode: 'excel', fileType: 'csv', uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
      .toEqual({ mode: 'excel', fileType: 'csv' })
    expect(readExportTask({ mode: 'grid_csv', fileType: 'qrcode', uuid: '41' })).toEqual({ mode: 'grid_csv', fileType: 'qrcode' })
  })

  it('never carries the task the backend queued', () => {
    // The task number names a row of the deployment's own task list, which is
    // where the file is collected and which nothing on this side can reach, so
    // the agent is told the export was submitted and no more.
    expect(readExportTask({ mode: 'excel', fileType: null, uuid: 'f47ac10b' })).not.toHaveProperty('uuid')
  })

  it('reports the export alone where the press named no file type a report may carry', () => {
    // A press on the button's own body names none at all, and a type outside
    // the alphabet or past the ceiling an attribute is read by is left out
    // rather than taking the export with it: that an export was submitted is
    // the fact the agent needs.
    expect(readExportTask({ mode: 'excel', fileType: null, uuid: '41' })).toEqual({ mode: 'excel' })
    expect(readExportTask({ mode: 'excel', fileType: '1st', uuid: '41' })).toEqual({ mode: 'excel' })
    expect(readExportTask({ mode: 'excel', fileType: 'c'.repeat(DATA_PAGE_REPORT_LIMITS.attributeLength + 1), uuid: '41' }))
      .toEqual({ mode: 'excel' })
    expect(readExportTask({ mode: 'grid_csv', fileType: 7 as unknown as string, uuid: '41' })).toEqual({ mode: 'grid_csv' })
  })

  it('is not reported at all for an export neither this row nor the catalog knows', () => {
    expect(readExportTask({ mode: 'pdf' as unknown as 'excel', fileType: null, uuid: '41' })).toBeUndefined()
    expect(readExportTask({ mode: '' as unknown as 'excel', fileType: 'csv', uuid: '41' })).toBeUndefined()
  })
})

describe('a page this account is not granted', () => {
  it('reports the refusal, and nothing of the profile it was judged against', () => {
    expect(readAccessDenied({ meta: 'device' }, 'device')).toEqual({})
  })

  it('carries nothing the page added beside the table', () => {
    // The payload is the page's, and this row reports what the catalog admits
    // of it rather than what arrives: a build that started naming the user or
    // the permissions it read would have them dropped here rather than
    // delivered.
    expect(readAccessDenied(
      { meta: 'device', user: 'probe', resclass: [{ resclassenname: 'other' }] } as unknown as { meta: string },
      'device',
    )).toEqual({})
  })

  it('is not this block\'s refusal where the payload names another table', () => {
    expect(readAccessDenied({ meta: 'other' }, 'device')).toBeUndefined()
  })

  it('is not reported where the payload names no table at all', () => {
    expect(readAccessDenied({ meta: '' }, 'device')).toBeUndefined()
    expect(readAccessDenied({} as { meta: string }, 'device')).toBeUndefined()
    expect(readAccessDenied({ meta: 7 as unknown as string }, 'device')).toBeUndefined()
    expect(readAccessDenied(undefined as unknown as { meta: string }, 'device')).toBeUndefined()
    expect(readAccessDenied(['device'] as unknown as { meta: string }, 'device')).toBeUndefined()
  })
})
