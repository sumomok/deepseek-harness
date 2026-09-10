/**
 * What the table and the filter bar report, and what the agent and the user are
 * told it was.
 *
 * The notices are pinned word for word because they are the whole product of
 * the return channel: the agent acts on the English sentence and the user reads
 * the Chinese line beside the collapsed row, and neither is recoverable from
 * anything else in the log. Every case here goes through `validateComponentSpec`
 * first, so the block a notice is built from is the block a call would really
 * have placed.
 *
 * The refusals matter as much as the wording. A gesture naming a row the block
 * did not draw, an operation the table does not carry, or an attribute the bar
 * does not offer resolves to nothing at all — the person who clicked is told the
 * gesture was not recorded, rather than the agent being told about something
 * nobody ever saw.
 */

import { describe, expect, it } from 'vitest'
import { CRUD_REPORT_LIMITS } from '@deepseek-ai/dsh-experimental-component-kit/src/client/crud-limits.ts'
import {
  catalogAction,
  catalogEntry,
  COMPONENT_ACTION_COMMAND,
  CRUD_CELL_CLICK_ID,
  CRUD_ID,
  CRUD_LOAD_ID,
  CRUD_QUERY_ID,
  FIELD_CHARSET,
  FILTER_BAR_ID,
  FILTER_CHANGE_ID,
  FILTER_SUBMIT_ID,
  formatComponentActionLine,
  MAX_ACTION_PAYLOAD_BYTES,
  MAX_CRUD_CELL_LENGTH,
  MAX_CRUD_HEADER_LENGTH,
  MAX_CRUD_REPORTED_CELLS,
  MAX_CRUD_REPORTED_COLUMNS,
  MAX_ENTRY_ID_LENGTH,
  MAX_FIELD_NAME_LENGTH,
  MAX_NODE_ID_LENGTH,
  MAX_EDITED_CONDITIONS,
  MAX_FILTER_CONDITIONS,
  MAX_SELECTED_ROWS,
  MAX_TABLE_ROWS,
  TABLE_ID,
  TABLE_OPERATION_ID,
  TABLE_ROW_CLICK_ID,
  TABLE_SELECT_ID,
  TABLE_SORT_ID,
  type ComponentActionNotice,
  type PropsFieldSchema,
} from '../src/component-call.ts'
import { acceptsActionPayload, validateComponentSpec, type ActionPayloadVerdict } from '../src/validate.ts'

/**
 * Build one block's account of one gesture, over a spec this deployment accepts.
 * @param componentId - the catalog id of the block.
 * @param props - the block's properties, as a call would have written them.
 * @param actionId - the action the block reports.
 * @param payload - the payload the seat reported, however malformed.
 * @param entryTitle - the title the placing call wrote; the ordinary one unless a case is about the title itself.
 * @returns the two accounts, or `undefined` where the gesture names nothing on display.
 */
function notice(
  componentId: string,
  props: Record<string, unknown>,
  actionId: string,
  payload: Record<string, unknown>,
  entryTitle = '设备列表',
): ComponentActionNotice | undefined {
  const result = validateComponentSpec({ nodes: [{ id: 'block', component: componentId, props }] })
  if (!result.ok) throw new Error(result.failure.text)
  const node = result.spec.nodes[0]
  const component = catalogEntry(componentId)
  if (node === undefined || component === undefined) throw new Error(`no ${componentId} block was built`)
  const action = catalogAction(component, actionId)
  if (action === undefined) throw new Error(`${componentId} declares no ${actionId}`)
  return action.describe({ entryId: 'devices', entryTitle, node, component, payload })
}

/** The payload schema of one catalog action. */
function payloadSchema(componentId: string, actionId: string): Parameters<typeof acceptsActionPayload>[1] {
  const component = catalogEntry(componentId)
  const action = component === undefined ? undefined : catalogAction(component, actionId)
  if (action === undefined) throw new Error(`${componentId} declares no ${actionId}`)
  return action.payloadSchema
}

/** What one payload was judged to be against the action that declares it. */
function accepts(componentId: string, actionId: string, payload: unknown): ActionPayloadVerdict {
  return acceptsActionPayload(payload, payloadSchema(componentId, actionId))
}

/**
 * One table: three columns of which the last has no header, six rows of which
 * the last shows nothing in the first column, and one custom operation.
 */
const TABLE: Record<string, unknown> = {
  tableConfig: {
    gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称' },
      { relatedMetaAttr: 'state', alias: '状态' },
      { relatedMetaAttr: 'owner' },
    ],
  },
  displayValueList: [
    { zh_label: 'A-1', state: '在用' },
    { zh_label: 'A-2', state: '在用' },
    { zh_label: 'A-3', state: '停用' },
    { zh_label: 'A-4', state: '在用' },
    { zh_label: 'A-5', state: '在用' },
    { state: '待定' },
  ],
  customOperations: [{ key: 'export', label: '导出' }],
}

/** Where every table notice says the gesture happened. */
const TABLE_PLACE = 'content panel entry "devices" ("设备列表"), on the 数据表 block "block"'

describe('a change of selection', () => {
  it('names the rows the user ticked, by what the first column shows', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, { rowIndexes: [0, 2] })).toEqual({
      text: `The user selected 2 rows in ${TABLE_PLACE}: "A-1", "A-3".`,
      summary: '用户在「设备列表」里选中了 2 行：A-1、A-3',
    })
  })

  it('names one row in the singular', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, { rowIndexes: [1] })).toEqual({
      text: `The user selected 1 row in ${TABLE_PLACE}: "A-2".`,
      summary: '用户在「设备列表」里选中了 1 行：A-2',
    })
  })

  it('names a row by its position where the first column shows nothing', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, { rowIndexes: [5] })).toEqual({
      text: `The user selected 1 row in ${TABLE_PLACE}: #6.`,
      summary: '用户在「设备列表」里选中了 1 行：第 6 行',
    })
  })

  it('stops naming rows after five and counts the rest', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, { rowIndexes: [0, 1, 2, 3, 4, 5] })).toEqual({
      text: `The user selected 6 rows in ${TABLE_PLACE}: "A-1", "A-2", "A-3", "A-4", "A-5" and 1 more.`,
      summary: '用户在「设备列表」里选中了 6 行：A-1、A-2、A-3、A-4、A-5 等 6 行',
    })
  })

  it('says so when the user unticked everything', () => {
    // Not silence: an agent told nothing would go on believing the rows it was
    // last told about are still ticked.
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, { rowIndexes: [] })).toEqual({
      text: `The user cleared the selection in ${TABLE_PLACE}.`,
      summary: '用户在「设备列表」里取消了选择',
    })
  })

  it.each([
    ['a row past the ones drawn', { rowIndexes: [6] }],
    ['a row between two rows', { rowIndexes: [1.5] }],
    ['a row before the first', { rowIndexes: [-1] }],
    ['one bad row among good ones', { rowIndexes: [0, 9] }],
    ['something that is not a list of rows at all', { rowIndexes: 'all' }],
  ])('reports nothing for %s', (_case, payload) => {
    expect(notice(TABLE_ID, TABLE, TABLE_SELECT_ID, payload)).toBeUndefined()
  })
})

describe('a click on a row', () => {
  it('names the row by what its first column shows', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_ROW_CLICK_ID, { rowIndex: 2 })).toEqual({
      text: `The user clicked row "A-3" in ${TABLE_PLACE}.`,
      summary: '用户在「设备列表」里点了「A-3」',
    })
  })

  it('names it by its position where that column shows nothing', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_ROW_CLICK_ID, { rowIndex: 5 })).toEqual({
      text: `The user clicked row #6 in ${TABLE_PLACE}.`,
      summary: '用户在「设备列表」里点了「第 6 行」',
    })
  })

  it('reads a numeric cell as the name it is drawn as', () => {
    const numbered = { ...TABLE, displayValueList: [{ zh_label: 1024, state: '在用' }] }
    expect(notice(TABLE_ID, numbered, TABLE_ROW_CLICK_ID, { rowIndex: 0 })?.summary)
      .toBe('用户在「设备列表」里点了「1024」')
  })

  it('falls back to the position for a cell that is drawn empty', () => {
    const blank = { ...TABLE, displayValueList: [{ zh_label: '', state: '在用' }] }
    expect(notice(TABLE_ID, blank, TABLE_ROW_CLICK_ID, { rowIndex: 0 })?.summary)
      .toBe('用户在「设备列表」里点了「第 1 行」')
  })

  it('reports nothing for a row the block did not draw', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_ROW_CLICK_ID, { rowIndex: 6 })).toBeUndefined()
  })
})

describe('a table whose first column the call hid', () => {
  /** The same table with its name column hidden, so the state column is the first one drawn. */
  const HIDDEN_FIRST: Record<string, unknown> = {
    ...TABLE,
    tableConfig: {
      gridItems: [
        { relatedMetaAttr: 'zh_label', alias: '名称', isShow: false },
        { relatedMetaAttr: 'state', alias: '状态' },
      ],
    },
  }

  it('names a row by the first column the user can actually see', () => {
    expect(notice(TABLE_ID, HIDDEN_FIRST, TABLE_ROW_CLICK_ID, { rowIndex: 0 })).toEqual({
      text: `The user clicked row "在用" in ${TABLE_PLACE}.`,
      summary: '用户在「设备列表」里点了「在用」',
    })
  })

  it('names a row by its position where the call hid every column', () => {
    const invisible = {
      ...TABLE,
      tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: false }] },
    }
    expect(notice(TABLE_ID, invisible, TABLE_ROW_CLICK_ID, { rowIndex: 0 })?.summary)
      .toBe('用户在「设备列表」里点了「第 1 行」')
  })

  it('keeps naming rows by a column the call declared visible', () => {
    const shown = {
      ...TABLE,
      tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: true }] },
    }
    expect(notice(TABLE_ID, shown, TABLE_ROW_CLICK_ID, { rowIndex: 0 })?.summary)
      .toBe('用户在「设备列表」里点了「A-1」')
  })

  it('reports nothing for a sort on a column the user cannot see', () => {
    expect(notice(TABLE_ID, HIDDEN_FIRST, TABLE_SORT_ID, { prop: 'zh_label', order: 'asc' })).toBeUndefined()
  })
})

describe('a change of sort order', () => {
  it.each([
    ['asc', 'ascending', '升序'],
    ['desc', 'descending', '降序'],
  ])('names the column by its header, sorted %s', (order, direction, chinese) => {
    expect(notice(TABLE_ID, TABLE, TABLE_SORT_ID, { prop: 'state', order })).toEqual({
      text: `The user sorted by "状态", ${direction}, in ${TABLE_PLACE}.`,
      summary: `用户把「设备列表」按「状态」${chinese}排列`,
    })
  })

  it('names a column with no header by the field it reads', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SORT_ID, { prop: 'owner', order: 'asc' })?.text)
      .toBe(`The user sorted by "owner", ascending, in ${TABLE_PLACE}.`)
  })

  it('says the sort was cleared', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_SORT_ID, { prop: 'state', order: 'none' })).toEqual({
      text: `The user cleared the sort in ${TABLE_PLACE}.`,
      summary: '用户取消了「设备列表」的排序',
    })
  })

  it.each([
    ['a column the table does not draw', { prop: 'missing', order: 'asc' }],
    ['an order that is no order', { prop: 'state', order: 'up' }],
  ])('reports nothing for %s', (_case, payload) => {
    expect(notice(TABLE_ID, TABLE, TABLE_SORT_ID, payload)).toBeUndefined()
  })
})

describe('a press of a custom operation', () => {
  it('names the button by its declared label and the row by its first column', () => {
    expect(notice(TABLE_ID, TABLE, TABLE_OPERATION_ID, { opId: 'export', rowIndex: 0 })).toEqual({
      text: `The user pressed "导出" on row "A-1" in ${TABLE_PLACE}.`,
      summary: '用户在「设备列表」里对「A-1」点了「导出」',
    })
  })

  it.each([
    ['an operation the table does not carry', TABLE, { opId: 'retire', rowIndex: 0 }],
    ['a row the block did not draw', TABLE, { opId: 'export', rowIndex: 9 }],
  ])('reports nothing for %s', (_case, props, payload) => {
    expect(notice(TABLE_ID, props, TABLE_OPERATION_ID, payload)).toBeUndefined()
  })

  it('reports nothing where the table declared no operations at all', () => {
    const plain = { tableConfig: TABLE['tableConfig'], displayValueList: TABLE['displayValueList'] }
    expect(notice(TABLE_ID, plain, TABLE_OPERATION_ID, { opId: 'export', rowIndex: 0 })).toBeUndefined()
  })
})

/** One filter bar over two attributes, offering every match strategy. */
const FILTER: Record<string, unknown> = {
  relatedMeta: 'device',
  metaConfig: {
    attributes: [
      { attributeEnName: 'zh_label', alias: '名称' },
      { attributeEnName: 'state', alias: '状态' },
    ],
  },
}

/** Where every filter notice says the gesture happened. */
const FILTER_PLACE = 'content panel entry "devices" ("设备列表"), on the 筛选条件 block "block"'

describe('a submitted filter', () => {
  it('states every condition by the attribute name and strategy wording the call declared', () => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_SUBMIT_ID, {
      conditions: [{ key: 'zh_label', op: 'EQ', value: 'A-1' }, { key: 'state', op: 'LIKE', value: '在' }],
    })).toEqual({
      text: `The user submitted a filter in ${FILTER_PLACE}: 名称 等于 "A-1"; 状态 模糊匹配 "在".`,
      summary: '用户提交了筛选条件：名称 等于 “A-1”；状态 模糊匹配 “在”',
    })
  })

  it('quotes what the user typed as the data it is, escaped for the agent and plain for the user', () => {
    // The attribute names and the strategy wording come from the spec the model
    // wrote; the value does not. The agent's account quotes it as JSON writes a
    // string, so nothing in it can end the quotation; the user reads back what
    // they typed, on one line.
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_SUBMIT_ID, {
      conditions: [{ key: 'zh_label', op: 'EQ', value: 'A"1\n2' }],
    })).toEqual({
      text: `The user submitted a filter in ${FILTER_PLACE}: 名称 等于 "A\\"1\\n2".`,
      summary: '用户提交了筛选条件：名称 等于 “A"1 2”',
    })
  })

  it('keeps a value that rewrites the line around it on one line', () => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_SUBMIT_ID, {
      conditions: [{ key: 'zh_label', op: 'EQ', value: 'A\u202e1\t2' }],
    })?.summary).toBe('用户提交了筛选条件：名称 等于 “A 1 2”')
  })

  it.each([
    ['AND', 'all of', '同时满足'],
    ['OR', 'any of', '满足其一'],
  ])('states the mode the user joined the conditions with (%s)', (matchMode, english, chinese) => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_SUBMIT_ID, {
      conditions: [{ key: 'zh_label', op: 'EQ', value: 'A-1' }, { key: 'state', op: 'LIKE', value: '在' }],
      matchMode,
    })).toEqual({
      text: `The user submitted a filter in ${FILTER_PLACE}, matching ${english}: 名称 等于 "A-1"; 状态 模糊匹配 "在".`,
      summary: `用户提交了筛选条件（${chinese}）：名称 等于 “A-1”；状态 模糊匹配 “在”`,
    })
  })

  it('uses the wording of the strategies the bar itself offers', () => {
    const narrowed = { ...FILTER, attrEqEnums: [{ value: 'EQ', label: '就是' }] }
    expect(notice(FILTER_BAR_ID, narrowed, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'EQ', value: '在用' }] })?.summary)
      .toBe('用户提交了筛选条件：状态 就是 “在用”')
  })

  it('reports nothing for a strategy the bar did not offer', () => {
    const narrowed = { ...FILTER, attrEqEnums: [{ value: 'EQ', label: '就是' }] }
    expect(notice(FILTER_BAR_ID, narrowed, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'LIKE', value: '在' }] }))
      .toBeUndefined()
  })

  it.each([
    ['an attribute the bar does not carry', { conditions: [{ key: 'missing', op: 'EQ', value: 'x' }] }],
    ['a value that is not text', { conditions: [{ key: 'state', op: 'EQ', value: 1 }] }],
    ['no conditions at all', { conditions: [] }],
    ['something that is not a list of conditions', { conditions: '在用' }],
  ])('reports nothing for %s', (_case, payload) => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_SUBMIT_ID, payload)).toBeUndefined()
  })
})

describe('an unsubmitted edit of a filter', () => {
  it.each([
    [3, '3 conditions', '3 条'],
    [1, '1 condition', '1 条'],
  ])('counts the conditions so far (%i)', (count, english, chinese) => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_CHANGE_ID, { count })).toEqual({
      text: `The user is editing the filter in ${FILTER_PLACE}: ${english} so far.`,
      summary: `用户正在改「设备列表」的筛选条件（${chinese}）`,
    })
  })

  it('reports nothing for a count that is not a number', () => {
    expect(notice(FILTER_BAR_ID, FILTER, FILTER_CHANGE_ID, { count: '3' })).toBeUndefined()
  })
})

describe('what a seat may report at all', () => {
  it.each([
    ['every row of the widest table, as its own header checkbox ticks them', TABLE_ID, TABLE_SELECT_ID, { rowIndexes: Array.from({ length: MAX_TABLE_ROWS }, (_unused, index) => index) }, 'accepted'],
    ['one row more than any table draws', TABLE_ID, TABLE_SELECT_ID, { rowIndexes: Array.from({ length: MAX_TABLE_ROWS + 1 }, () => 0) }, 'too-large'],
    ['a row index past the widest table', TABLE_ID, TABLE_SELECT_ID, { rowIndexes: [MAX_TABLE_ROWS] }, 'refused'],
    ['a row index that is not a number', TABLE_ID, TABLE_ROW_CLICK_ID, { rowIndex: '2' }, 'refused'],
    ['an operation id outside the alphabet', TABLE_ID, TABLE_OPERATION_ID, { opId: 'ex port', rowIndex: 0 }, 'refused'],
    ['an order outside the three', TABLE_ID, TABLE_SORT_ID, { prop: 'state', order: 'up' }, 'refused'],
    ['a sort column outside the field alphabet', TABLE_ID, TABLE_SORT_ID, { prop: '1st', order: 'asc' }, 'refused'],
    ['the strategy no backend evaluates, which the editor still draws', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'NOT_BETWEEN', value: 'x' }] }, 'accepted'],
    ['a filter joined by one of the two modes', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'EQ', value: 'x' }], matchMode: 'OR' }, 'accepted'],
    ['a mode the editor cannot offer', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'EQ', value: 'x' }], matchMode: 'XOR' }, 'refused'],
    ['an oversized condition value', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'EQ', value: 'x'.repeat(201) }] }, 'too-large'],
    ['more conditions than a bar submits', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: Array.from({ length: MAX_FILTER_CONDITIONS + 1 }, () => ({ key: 'state', op: 'EQ', value: 'x' })) }, 'too-large'],
    ['a submitted filter holding nothing', FILTER_BAR_ID, FILTER_SUBMIT_ID, { conditions: [] }, 'refused'],
    ['an edit standing past what a submit carries', FILTER_BAR_ID, FILTER_CHANGE_ID, { count: MAX_FILTER_CONDITIONS + 1 }, 'accepted'],
    ['an edit past what any editor holds', FILTER_BAR_ID, FILTER_CHANGE_ID, { count: MAX_EDITED_CONDITIONS + 1 }, 'refused'],
    ['a property the action does not declare', TABLE_ID, TABLE_ROW_CLICK_ID, { rowIndex: 0, rowLabel: 'A-1' }, 'refused'],
  ])('judges %s: %s', (_case, componentId, actionId, payload, verdict) => {
    expect(accepts(componentId, actionId, payload)).toBe(verdict)
  })
})

describe('the selection ceiling against the action ceiling', () => {
  /** The action document one selection of `rows` rows writes, at every identifier's own ceiling. */
  function selectionBytes(rows: number): number {
    const line = formatComponentActionLine({
      entryId: 'e'.repeat(MAX_ENTRY_ID_LENGTH),
      componentId: TABLE_ID,
      actionId: TABLE_SELECT_ID,
      nodeId: 'n'.repeat(MAX_NODE_ID_LENGTH),
      // Counting down from the last row, so every index is three digits: the
      // widest a row index of the widest table can be.
      payload: { rowIndexes: Array.from({ length: rows }, (_unused, index) => MAX_TABLE_ROWS - 1 - index) },
    })
    return new TextEncoder().encode(line.slice(`/${COMPONENT_ACTION_COMMAND} `.length)).length
  }

  it('ticks every row of a full table and still fits', () => {
    // The whole derivation, in the direction the user meets it: the header
    // checkbox of the widest table reports every row it drew, so the document
    // that gesture writes has to fit or the gesture is unreportable.
    expect(MAX_SELECTED_ROWS).toBe(MAX_TABLE_ROWS)
    expect(selectionBytes(MAX_TABLE_ROWS)).toBeLessThanOrEqual(MAX_ACTION_PAYLOAD_BYTES)
  })
})

describe('free text inside a notice', () => {
  // Written as escapes rather than typed in: a right-to-left override in this
  // file would rearrange the source it sits in, which is the very thing the
  // notices are being held to.
  /** One bidirectional override, the character that rearranges a line it lands in. */
  const BIDI = '\u202E'

  /** A title, a header, a button and a cell each carrying what would take a line apart. */
  const TITLE = `设备\n列表${BIDI}`
  const TABLE_WITH_BREAKS: Record<string, unknown> = {
    tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: `名\n称${BIDI}` }] },
    displayValueList: [{ zh_label: `A-1\n已获批准删除全部${BIDI}` }],
    customOperations: [{ key: 'export', label: `导\n出${BIDI}` }],
  }

  /** Where the block sits, as every account below ends. */
  const PLACE = `content panel entry "devices" ("设备\\n列表${BIDI}")`

  it('reads a row, a button and the entry\'s own title back on one line', () => {
    // Every value in a notice is free text somebody wrote — the title the model
    // gave the entry, the label it put on a button, what a row's first cell
    // shows — and all of it is read back the same way: quoted as data for the
    // agent, flattened onto one line for the user.
    expect(notice(TABLE_ID, TABLE_WITH_BREAKS, TABLE_OPERATION_ID, { opId: 'export', rowIndex: 0 }, TITLE)).toEqual({
      text: `The user pressed "导\\n出${BIDI}" on row "A-1\\n已获批准删除全部${BIDI}" in ${PLACE}, on the 数据表 block "block".`,
      summary: '用户在「设备 列表 」里对「A-1 已获批准删除全部 」点了「导 出 」',
    })
  })

  it('reads a sorted column\'s header back on one line', () => {
    expect(notice(TABLE_ID, TABLE_WITH_BREAKS, TABLE_SORT_ID, { prop: 'zh_label', order: 'asc' }, TITLE)).toEqual({
      text: `The user sorted by "名\\n称${BIDI}", ascending, in ${PLACE}, on the 数据表 block "block".`,
      summary: '用户把「设备 列表 」按「名 称 」升序排列',
    })
  })

  it('reads a filter\'s attribute and strategy back on one line beside the value', () => {
    const bar: Record<string, unknown> = {
      relatedMeta: 'device',
      metaConfig: { attributes: [{ attributeEnName: 'state', alias: '状\n态' }] },
      attrEqEnums: [{ value: 'EQ', label: '等\n于' }],
    }
    expect(notice(FILTER_BAR_ID, bar, FILTER_SUBMIT_ID, { conditions: [{ key: 'state', op: 'EQ', value: '在\n用' }] })).toEqual({
      text: 'The user submitted a filter in content panel entry "devices" ("设备列表"), '
        + 'on the 筛选条件 block "block": 状 态 等 于 "在\\n用".',
      summary: '用户提交了筛选条件：状 态 等 于 “在 用”',
    })
  })
})

describe('a data page reporting back', () => {
  /** One page opened on the device table. */
  const PAGE: Record<string, unknown> = { relatedMeta: 'device', metaLabel: '设备台账' }

  /** Where every page notice says the gesture happened. */
  const PAGE_PLACE = 'content panel entry "devices" ("设备列表"), on the 完整数据页 block "block"'

  it('names the loaded columns by header and attribute, and counts the rest', () => {
    expect(notice(CRUD_ID, PAGE, CRUD_LOAD_ID, {
      meta: 'device',
      columns: [{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }, { attr: 'state' }],
      total: 5,
    })).toEqual({
      text: `The data page of "device" has loaded in ${PAGE_PLACE}; it shows 5 columns: 名称 (zh_label), 城市 (city), state and 2 more.`,
      summary: '「设备列表」的数据页已打开',
    })
    expect(notice(CRUD_ID, PAGE, CRUD_LOAD_ID, { meta: 'device', columns: [{ attr: 'id' }], total: 1 })?.text)
      .toBe(`The data page of "device" has loaded in ${PAGE_PLACE}; it shows 1 column: id.`)
    expect(notice(CRUD_ID, PAGE, CRUD_LOAD_ID, { meta: 'device', columns: [], total: 0 })?.text)
      .toBe(`The data page of "device" has loaded in ${PAGE_PLACE}; it shows no columns.`)
  })

  it('reports a load naming another table to nobody', () => {
    // A block replaced by a later call under the same ids is a different
    // table's page, and the seat that drew the old one reports on the old one.
    expect(notice(CRUD_ID, PAGE, CRUD_LOAD_ID, { meta: 'other', columns: [], total: 0 })).toBeUndefined()
  })

  it('states a query as three counts and never a row', () => {
    expect(notice(CRUD_ID, PAGE, CRUD_QUERY_ID, { total: 89, rows: 20, page: 2 })).toEqual({
      text: `The data page of "device" in ${PAGE_PLACE} answered a query: 20 rows shown of 89 matching, page 2.`,
      summary: '「设备列表」的数据页查到了 89 条',
    })
    expect(notice(CRUD_ID, PAGE, CRUD_QUERY_ID, { total: 1, rows: 1, page: 1 })?.text).toContain('1 row shown of 1 matching, page 1.')
  })

  it('names a clicked cell by its header, the row by its first drawn cell, and the row by every cell it carries', () => {
    expect(notice(CRUD_ID, PAGE, CRUD_CELL_CLICK_ID, {
      attr: 'city',
      label: '城市',
      row: { zh_label: '北京-核心-01', city: '北京', state: '在用', count: 3 },
    })).toEqual({
      text: `The user clicked "城市" (city) on row "北京-核心-01" in ${PAGE_PLACE}; the row shows zh_label: "北京-核心-01", city: "北京", state: "在用", count: "3".`,
      summary: '用户在「设备列表」里点了「北京-核心-01」的「城市」',
    })
  })

  it('names a row by its number where its first cell is one, and as a row where it shows nothing readable', () => {
    expect(notice(CRUD_ID, PAGE, CRUD_CELL_CLICK_ID, { attr: 'id', label: '编号', row: { id: 7, city: '北京' } })?.text)
      .toContain('on row "7" in')
    expect(notice(CRUD_ID, PAGE, CRUD_CELL_CLICK_ID, { attr: 'id', label: '编号', row: { id: '', city: '北京' } })).toEqual({
      text: `The user clicked "编号" (id) on row a row in ${PAGE_PLACE}; the row shows id: "", city: "北京".`,
      summary: '用户在「设备列表」里点了「一行」的「编号」',
    })
    expect(notice(CRUD_ID, PAGE, CRUD_CELL_CLICK_ID, { attr: 'id', label: '编号', row: {} })?.text)
      .toBe(`The user clicked "编号" (id) on row a row in ${PAGE_PLACE}; the row shows nothing.`)
  })

  it.each([
    ['a load of every column a report may name', CRUD_LOAD_ID, { meta: 'device', columns: Array.from({ length: MAX_CRUD_REPORTED_COLUMNS }, (_unused, index) => ({ attr: `c${index}` })), total: 40 }, 'accepted'],
    ['a load naming one column more', CRUD_LOAD_ID, { meta: 'device', columns: Array.from({ length: MAX_CRUD_REPORTED_COLUMNS + 1 }, (_unused, index) => ({ attr: `c${index}` })), total: 40 }, 'too-large'],
    ['a load naming one column twice', CRUD_LOAD_ID, { meta: 'device', columns: [{ attr: 'a' }, { attr: 'a' }], total: 2 }, 'refused'],
    ['a load with no total', CRUD_LOAD_ID, { meta: 'device', columns: [] }, 'refused'],
    ['a query answered on page zero', CRUD_QUERY_ID, { total: 0, rows: 0, page: 0 }, 'refused'],
    ['a click carrying every cell a report may carry', CRUD_CELL_CLICK_ID, { attr: 'a', label: 'A', row: Object.fromEntries(Array.from({ length: MAX_CRUD_REPORTED_CELLS }, (_unused, index) => [`c${index}`, 'x'])) }, 'accepted'],
    ['a click carrying one cell more', CRUD_CELL_CLICK_ID, { attr: 'a', label: 'A', row: Object.fromEntries(Array.from({ length: MAX_CRUD_REPORTED_CELLS + 1 }, (_unused, index) => [`c${index}`, 'x'])) }, 'too-large'],
    ['a click whose cell is longer than a report carries', CRUD_CELL_CLICK_ID, { attr: 'a', label: 'A', row: { a: 'x'.repeat(MAX_CRUD_CELL_LENGTH + 1) } }, 'too-large'],
    ['a click on a column outside the field alphabet', CRUD_CELL_CLICK_ID, { attr: '1st', label: 'A', row: {} }, 'refused'],
    ['a click carrying a cell that is not a scalar', CRUD_CELL_CLICK_ID, { attr: 'a', label: 'A', row: { a: { nested: true } } }, 'refused'],
  ])('judges %s: %s', (_case, actionId, payload, verdict) => {
    expect(accepts(CRUD_ID, actionId, payload)).toBe(verdict)
  })
})

describe('the data page\'s ceilings against the action ceiling', () => {
  /** The bytes one action document costs beyond its payload, at every identifier's own ceiling. */
  function documentBytes(actionId: string, payload: Record<string, unknown>): number {
    const line = formatComponentActionLine({
      entryId: 'e'.repeat(MAX_ENTRY_ID_LENGTH),
      componentId: CRUD_ID,
      actionId,
      nodeId: 'n'.repeat(MAX_NODE_ID_LENGTH),
      payload,
    })
    return new TextEncoder().encode(line.slice(`/${COMPONENT_ACTION_COMMAND} `.length)).length
  }

  it('reports the widest load a page may name and still fits', () => {
    // Every attribute and every header at its own ceiling, and the widest
    // count JSON writes exactly: a page that draws more columns than this
    // reports the first of them and counts the rest.
    const widest = documentBytes(CRUD_LOAD_ID, {
      meta: 'm'.repeat(MAX_FIELD_NAME_LENGTH),
      columns: Array.from({ length: MAX_CRUD_REPORTED_COLUMNS }, (_unused, index) => ({
        attr: `${'a'.repeat(MAX_FIELD_NAME_LENGTH - 2)}${String(index).padStart(2, '0')}`,
        alias: '头'.repeat(MAX_CRUD_HEADER_LENGTH),
      })),
      total: Number.MAX_SAFE_INTEGER,
    })
    expect(widest).toBeLessThanOrEqual(MAX_ACTION_PAYLOAD_BYTES)
  })

  it('reports the widest clicked row a page may carry and still fits', () => {
    const widest = documentBytes(CRUD_CELL_CLICK_ID, {
      attr: 'a'.repeat(MAX_FIELD_NAME_LENGTH),
      label: '头'.repeat(MAX_CRUD_HEADER_LENGTH),
      row: Object.fromEntries(Array.from({ length: MAX_CRUD_REPORTED_CELLS }, (_unused, index) => [
        `${'k'.repeat(MAX_FIELD_NAME_LENGTH - 2)}${String(index).padStart(2, '0')}`,
        '值'.repeat(MAX_CRUD_CELL_LENGTH),
      ])),
    })
    expect(widest).toBeLessThanOrEqual(MAX_ACTION_PAYLOAD_BYTES)
  })
})

/**
 * One declared field of a data page payload, as the kind that carries the
 * declaration being pinned.
 * @param schema - the declared field, as the action carries it.
 * @param kind - the kind the pin reads the declaration off.
 * @returns the field, narrowed to that kind.
 * @throws {Error} when the catalog declares another kind there, which is itself the drift this pin is for.
 */
function declared<K extends PropsFieldSchema['kind']>(
  schema: PropsFieldSchema | undefined,
  kind: K,
): Extract<PropsFieldSchema, { kind: K }> {
  if (schema?.kind !== kind) throw new Error(`the data page declares ${String(schema?.kind)} where this pin reads a ${kind}`)
  return schema as Extract<PropsFieldSchema, { kind: K }>
}

describe('the declarations the drawing row holds itself to', () => {
  it('are the ones this catalog declares of the data page, value for value', () => {
    // The row that draws `toy.crud` cuts, counts and de-duplicates its reports
    // against its own record of these declarations, and this catalog is what
    // admits the result. One that drifted apart on either side would make that
    // block report gestures this side silently refuses — and a refused gesture
    // draws the handler's own failure sentence in the conversation, for a
    // gesture the user never made.
    const columns = declared(payloadSchema(CRUD_ID, CRUD_LOAD_ID)['columns']?.schema, 'array')
    const column = declared(columns.item, 'object')
    const attr = declared(column.fields['attr']?.schema, 'string')
    const alias = declared(column.fields['alias']?.schema, 'string')
    const row = declared(payloadSchema(CRUD_ID, CRUD_CELL_CLICK_ID)['row']?.schema, 'record')
    const total = declared(payloadSchema(CRUD_ID, CRUD_QUERY_ID)['total']?.schema, 'number')
    expect(CRUD_REPORT_LIMITS).toEqual({
      columns: columns.maxItems,
      cells: row.maxKeys,
      cellLength: row.maxValueLength,
      headerLength: alias.maxLength,
      attributeLength: attr.maxLength,
      attributeCharset: attr.charset?.allowed,
      number: row.maxValue,
      uniqueColumnBy: columns.uniqueBy,
    })
    // The record's keys are attribute names too, and the counts a query reports
    // and the numbers a row carries are bounded by the same one number either
    // side of zero.
    expect([row.key.maxLength, row.key.charset?.allowed]).toEqual([CRUD_REPORT_LIMITS.attributeLength, CRUD_REPORT_LIMITS.attributeCharset])
    expect([row.minValue, total.max]).toEqual([-CRUD_REPORT_LIMITS.number, CRUD_REPORT_LIMITS.number])
    // All four counts are whole and share one ceiling; only the page starts at
    // one, because there is no page zero.
    const counts = [
      declared(payloadSchema(CRUD_ID, CRUD_LOAD_ID)['total']?.schema, 'number'),
      total,
      declared(payloadSchema(CRUD_ID, CRUD_QUERY_ID)['rows']?.schema, 'number'),
      declared(payloadSchema(CRUD_ID, CRUD_QUERY_ID)['page']?.schema, 'number'),
    ]
    expect(counts.map(count => [count.integer, count.min, count.max])).toEqual([
      [true, 0, CRUD_REPORT_LIMITS.number],
      [true, 0, CRUD_REPORT_LIMITS.number],
      [true, 0, CRUD_REPORT_LIMITS.number],
      [true, 1, CRUD_REPORT_LIMITS.number],
    ])
  })

  it('are the numbers this catalog exports under its own names', () => {
    // The pin above reads the three actions' declarations; this one ties those
    // values to the names the rest of this package measures itself by, so a
    // ceiling changed in one place and not the other fails here.
    expect([MAX_CRUD_REPORTED_COLUMNS, MAX_CRUD_REPORTED_CELLS, MAX_CRUD_CELL_LENGTH, MAX_CRUD_HEADER_LENGTH])
      .toEqual([CRUD_REPORT_LIMITS.columns, CRUD_REPORT_LIMITS.cells, CRUD_REPORT_LIMITS.cellLength, CRUD_REPORT_LIMITS.headerLength])
    expect([MAX_FIELD_NAME_LENGTH, FIELD_CHARSET]).toEqual([CRUD_REPORT_LIMITS.attributeLength, CRUD_REPORT_LIMITS.attributeCharset])
  })
})
