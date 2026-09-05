// @vitest-environment jsdom
/**
 * `toy.table`: that the vendored table draws the columns and rows a block
 * carries, that each of the four gestures it reports arrives as the action and
 * the payload the catalog declares, that every reported row is named by its
 * position in the list the block itself wrote, and that a block whose last
 * gesture is still travelling reports no further one.
 *
 * The row identities are the point of most of it. `TableDetail` hands the rows
 * back deep-cloned in its selection event and by reference everywhere else, so
 * what is pinned here is that a reported index counts into `displayValueList`
 * in every one of the four cases.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { installElementUI } from '../src/client/element-ui.ts'
import { TableDetailRenderer } from '../src/client/TableDetailRenderer.tsx'
import { en } from '../src/client/locales.ts'
import type { ComponentActionState, ComponentRendererProps } from '../src/client/renderer.ts'

beforeAll(installElementUI)
afterEach(cleanup)

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** Two rows and two columns, the shape every case here starts from. */
const ROWS = [
  { int_id: '1', zh_label: '一号站点', status: '在用' },
  { int_id: '2', zh_label: '二号站点', status: '停用' },
]

/** Both columns drawn as plain text, the name column sortable. */
const COLUMNS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isSortable: true, relatedComponent: 'display_default' },
  { relatedMetaAttr: 'status', alias: '状态', relatedComponent: 'display_default' },
]

/**
 * Let Vue finish. el-table registers its columns from each column component's
 * own `mounted`, so the header exists a tick after React's commit rather than
 * inside it.
 * @returns a promise settling after the queued Vue renders.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Draw one table block over the properties under test. */
async function draw(
  props: Record<string, unknown>,
  onAction = vi.fn(),
  state: ComponentActionState = 'idle',
): Promise<{ view: ReturnType<typeof render>; onAction: ReturnType<typeof vi.fn> }> {
  const view = render(
    <TableDetailRenderer nodeId="node-1" props={props} state={state} onAction={onAction} t={t} />,
  )
  await flush()
  return { view, onAction }
}

/** Every column heading the block drew, in order. */
function headings(container: HTMLElement): string[] {
  // The header wrapper only: the name column is fixed, so element-ui draws a
  // second copy of the header beside it.
  return [...container.querySelectorAll('.el-table__header-wrapper th .cell')]
    .map(cell => cell.textContent?.trim() ?? '')
}

/** Every drawn cell of one row, in order. */
function cells(container: HTMLElement, row: number): string[] {
  const tr = container.querySelectorAll('.el-table__body-wrapper tbody tr')[row] as HTMLElement
  return [...tr.querySelectorAll('td .cell')].map(cell => cell.textContent?.trim() ?? '')
}

describe('toy.table', () => {
  it('draws the columns and rows a block carries', async () => {
    const { view } = await draw({ tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS })
    const block = view.container.querySelector('[data-component-block="toy.table"]')
    expect(block?.getAttribute('data-component-node')).toBe('node-1')
    expect(headings(view.container)).toEqual(['名称', '状态'])
    expect(cells(view.container, 1)).toEqual(['二号站点', '停用'])
  })

  it('offers no selection column, and none of the component\'s own row buttons, until the call asks', async () => {
    const { view } = await draw({ tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS })
    expect(view.container.querySelector('.el-table-column--selection')).toBeNull()
    // `rightOperationVisiable` is written dead: the component's own modify and
    // delete buttons report through an event no action here carries.
    expect(view.container.querySelector('.operation-modify')).toBeNull()
    expect(view.container.querySelector('.operation-delete')).toBeNull()
  })

  it('reports the rows the user selected, by their position in the list the block wrote', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      selectMode: 'checkbox',
    })
    const boxes = view.container.querySelectorAll('.el-table__body-wrapper .el-checkbox__original')
    fireEvent.click(boxes[1] as HTMLElement)
    await flush()
    // The component's own event hands the rows back deep-cloned, so the index
    // is read off the instance rather than out of the event.
    expect(onAction).toHaveBeenCalledWith('select', { rowIndexes: [1] })
  })

  it('reports a single row when the block asks for one at a time', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      selectMode: 'radio',
    })
    const radios = view.container.querySelectorAll('.el-table__body-wrapper .el-radio__original')
    fireEvent.click(radios[0] as HTMLElement)
    await flush()
    expect(onAction).toHaveBeenCalledWith('select', { rowIndexes: [0] })
  })

  it('reports the row a cell click opened, once per click, where the call made rows openable', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      isNameClick: true,
    })
    const secondRow = view.container.querySelectorAll('.el-table__body-wrapper tbody tr')[1] as HTMLElement
    fireEvent.click(secondRow.querySelectorAll('td')[1] as HTMLElement)
    await flush()
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('row-click', { rowIndex: 1 })
  })

  it('reports nothing at all for a cell click on a table whose rows do not open', async () => {
    // The component draws no link and opens nothing without `isNameClick`, so
    // a click on one of its cells is the user touching the screen rather than a
    // gesture: reporting it would tell the agent a row was opened on a table
    // where nothing can be.
    const { view, onAction } = await draw({ tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS })
    const secondRow = view.container.querySelectorAll('.el-table__body-wrapper tbody tr')[1] as HTMLElement
    fireEvent.click(secondRow.querySelectorAll('td')[1] as HTMLElement)
    await flush()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('reports one row click for one click on the name, not two', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      isNameClick: true,
    })
    // The name link sits inside the cell el-table binds its own click on, so
    // the component emits `name-cell-click` and `table-cell-click` for one
    // gesture; the second is dropped.
    const link = view.container.querySelector('.el-table__body-wrapper a.trans') as HTMLElement
    fireEvent.click(link)
    await flush()
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('row-click', { rowIndex: 0 })

    // And the next ordinary cell click is still reported.
    fireEvent.click(view.container.querySelectorAll('.el-table__body-wrapper tbody td')[1] as HTMLElement)
    await flush()
    expect(onAction).toHaveBeenCalledTimes(2)
  })

  it('leaves the name a plain cell until the call makes it a link', async () => {
    const { view } = await draw({ tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS })
    expect(view.container.querySelector('.el-table__body-wrapper a.trans')).toBeNull()
  })

  it('reports each direction of a column sort, and the return to none', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      tableSortable: true,
    })
    const heading = view.container.querySelector('.el-table__header-wrapper th.is-sortable .cell') as HTMLElement
    for (const order of ['asc', 'desc', 'none']) {
      fireEvent.click(heading)
      await flush()
      expect(onAction).toHaveBeenLastCalledWith('sort', { prop: 'zh_label', order })
    }
  })

  it('sorts nothing when the block turns sorting off', async () => {
    const { view } = await draw({
      tableConfig: { gridItems: [{ ...COLUMNS[0], isSortable: true }] },
      displayValueList: ROWS,
      tableSortable: false,
    })
    expect(view.container.querySelector('.el-table__header-wrapper th.is-sortable')).toBeNull()
  })

  it('reports the button pressed on a row, and which row it was on', async () => {
    const { view, onAction } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      customOperations: [{ key: 'inspect', label: '查看' }],
      operationColumnWidth: 120,
    })
    const buttons = view.container.querySelectorAll('.el-table__body-wrapper .operation-custom a')
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1] as HTMLElement)
    await flush()
    // The button sits inside a cell, so el-table reports a cell click behind
    // it; a press is a press and not also an opened row.
    expect(onAction).toHaveBeenCalledTimes(1)
    expect(onAction).toHaveBeenCalledWith('operation', { opId: 'inspect', rowIndex: 1 })
  })

  it('reports no further press while the last one is still travelling, and says so', async () => {
    const { view, onAction } = await draw(
      {
        tableConfig: { gridItems: COLUMNS },
        displayValueList: ROWS,
        customOperations: [{ key: 'inspect', label: '查看' }],
      },
      vi.fn(),
      'sending',
    )
    fireEvent.click(view.container.querySelector('.el-table__body-wrapper .operation-custom a') as HTMLElement)
    await flush()
    expect(onAction).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-component-sent]')?.textContent).toBe('Sending…')
  })

  it('takes a press again once the last one was refused', async () => {
    const { view, onAction } = await draw(
      {
        tableConfig: { gridItems: COLUMNS },
        displayValueList: ROWS,
        customOperations: [{ key: 'inspect', label: '查看' }],
      },
      vi.fn(),
      'refused',
    )
    fireEvent.click(view.container.querySelector('.el-table__body-wrapper .operation-custom a') as HTMLElement)
    await flush()
    expect(onAction).toHaveBeenCalledWith('operation', { opId: 'inspect', rowIndex: 0 })
  })

  it('reports against the rows now drawn after a new call replaced them', async () => {
    const onAction = vi.fn()
    const { view } = await draw(
      { tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS, isNameClick: true },
      onAction,
    )
    view.rerender(
      <TableDetailRenderer
        nodeId="node-1"
        props={{ tableConfig: { gridItems: COLUMNS }, displayValueList: [ROWS[1], ROWS[0]], isNameClick: true }}
        state="idle"
        onAction={onAction}
        t={t}
      />,
    )
    await flush()
    fireEvent.click(view.container.querySelectorAll('.el-table__body-wrapper tbody tr')[0]?.querySelector('td') as HTMLElement)
    await flush()
    expect(onAction).toHaveBeenCalledWith('row-click', { rowIndex: 0 })
    expect(cells(view.container, 0)).toEqual(['二号站点', '停用'])
  })

  it('hides a column the block says not to draw', async () => {
    const { view } = await draw({
      tableConfig: { gridItems: [COLUMNS[0], { ...COLUMNS[1], isShow: false }] },
      displayValueList: ROWS,
    })
    expect(headings(view.container)).toEqual(['名称'])
  })

  it('draws a column the block says to draw, heading or no heading', async () => {
    const { view } = await draw({
      tableConfig: {
        gridItems: [
          { ...COLUMNS[0], isShow: true, relatedComponentObj: { color: '#00D27A' } },
          // Neither a heading nor a cell component: the column is drawn as
          // plain text under an empty heading.
          { relatedMetaAttr: 'status' },
        ],
      },
      displayValueList: ROWS,
    })
    expect(headings(view.container)).toEqual(['名称', ''])
    expect(cells(view.container, 0)).toEqual(['一号站点', '在用'])
  })

  it('drops a column that names no row property, a row that is not a record, and a button with no id or no text', async () => {
    const { view } = await draw({
      tableConfig: { gridItems: [{ ...COLUMNS[0], isSortable: false }, { alias: '无名' }, 'not-a-column'] },
      displayValueList: [ROWS[0], 'not-a-row', null, { zh_label: { nested: true } }],
      customOperations: [{ key: 'no-label' }, { label: '无 id' }, 'not-a-button', { key: 'ok', label: '看' }],
    })
    expect(headings(view.container)).toEqual(['名称', '操作'])
    expect(view.container.querySelector('.el-table__header-wrapper th.is-sortable')).toBeNull()
    // Two rows survive, so the one button that carries both an id and a text
    // is drawn twice and the three that carry neither are gone.
    expect([...view.container.querySelectorAll('.el-table__body-wrapper .operation-custom a')]
      .map(button => button.textContent)).toEqual(['看', '看'])
    // The row whose only value is not a scalar keeps its place and draws
    // nothing; the two that are not records at all are gone.
    expect(view.container.querySelectorAll('.el-table__body-wrapper tbody tr')).toHaveLength(2)
  })

  it('draws the rows when the block declares raw values of a different length', async () => {
    const { view } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      rawValueList: [ROWS[0]],
    })
    // Every column reads its raw value by row index, so a shorter list would
    // take the component past the end of it.
    expect(cells(view.container, 1)).toEqual(['二号站点', '停用'])
  })

  it('draws the rows against the raw values the block declares', async () => {
    const { view } = await draw({
      tableConfig: { gridItems: COLUMNS },
      displayValueList: ROWS,
      rawValueList: [{ ...ROWS[0], zh_label: '1' }, { ...ROWS[1], zh_label: '2' }],
    })
    expect(cells(view.container, 0)).toEqual(['一号站点', '在用'])
  })

  it('draws a table with nothing in it when the block carries no rows or columns at all', async () => {
    const { view } = await draw({ tableConfig: 'not-a-config', displayValueList: 'not-a-list' })
    expect(headings(view.container)).toEqual([])
    expect(view.container.querySelectorAll('.el-table__body-wrapper tbody tr')).toHaveLength(0)
  })

  it('removes the mounted component when the block goes away', async () => {
    const { view } = await draw({ tableConfig: { gridItems: COLUMNS }, displayValueList: ROWS })
    const host = view.container.querySelector('[data-component-block="toy.table"] > div')
    expect(host?.childElementCount).toBe(1)
    view.unmount()
    expect(host?.childElementCount).toBe(0)
  })
})
