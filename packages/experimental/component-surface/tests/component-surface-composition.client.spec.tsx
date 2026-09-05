// @vitest-environment jsdom
/**
 * The `component` seat drawing one call whose blocks feed each other: a table
 * beside the record of whichever row is ticked in it.
 *
 * The renderers are the real ones and so is the arrangement, because what is
 * being pinned only exists when both halves run. A tick reaches the record
 * block through the seat's own state and nowhere else — nothing about it is
 * reported, recorded, or sent — and the table it came out of has to still be
 * holding that tick afterwards, which is a fact about the object identity of
 * what its renderer was handed rather than about anything visible in the spec.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en } from '@deepseek-ai/dsh-experimental-component-kit/src/client/locales.ts'
import { installElementUI } from '@deepseek-ai/dsh-experimental-component-kit/src/client/element-ui.ts'
import { ComponentSurface, type ComponentSurfaceProps } from '../src/client/ComponentSurface.tsx'
import { RECORD_DETAIL_ID, TABLE_ID } from '../src/component-call.ts'

beforeAll(installElementUI)
afterEach(cleanup)

const t: ComponentSurfaceProps['t'] = makeTranslate(en)

/**
 * Let Vue finish: el-table draws its rows from each column component's own
 * `mounted`, a tick after React's commit.
 * @returns a promise settling after the queued Vue renders.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Two rows over two columns, ticked one at a time. */
const TABLE = {
  id: 't',
  component: TABLE_ID,
  props: {
    tableConfig: { gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称' }, { relatedMetaAttr: 'status', alias: '状态' }] },
    displayValueList: [
      { zh_label: '一号站点', status: '在用' },
      { zh_label: '二号站点', status: '停用' },
    ],
    selectMode: 'checkbox',
  },
}

/** The record beside it, drawn from whichever row is ticked. */
function detailsFrom(reference: string): Record<string, unknown> {
  return { id: 'd', component: RECORD_DETAIL_ID, props: { dataList: { $from: reference } } }
}

/** The two of them side by side, the table twice as wide. */
const SIDE_BY_SIDE = {
  node: 'stack',
  dir: 'row',
  gap: 'md',
  children: [{ node: 'component', id: 't', flex: 2 }, { node: 'component', id: 'd', flex: 1 }],
}

/** What one mounted seat hands back. */
interface Mounted {
  /** The rendered seat. */
  view: ReturnType<typeof render>
  /** Every gesture the seat reported, as the registration's face received it. */
  onAction: ReturnType<typeof vi.fn>
  /** Redraw the seat over another call. */
  show: (nodes: readonly unknown[], seq: number) => void
}

/** Draw the seat over one call. */
async function mount(nodes: readonly unknown[]): Promise<Mounted> {
  const onAction = vi.fn(() => Promise.resolve('dispatched'))
  const useSessions = ((selector: (snapshot: unknown) => unknown) => selector({ byId: {} })) as ComponentSurfaceProps['useSessions']
  const element = (drawn: readonly unknown[], seq: number) => (
    <ComponentSurface {...{
      sessionId: 'a',
      entry: { kind: 'component', entryId: 'sites', seq, title: 'Sites', payload: { spec: { nodes: drawn, layout: SIDE_BY_SIDE } } },
      useSessions,
      onAction,
      pending: new Map(),
      t,
    } as unknown as ComponentSurfaceProps} />
  )
  const view = render(element(nodes, 4))
  await flush()
  return { view, onAction, show: (drawn, seq) => { view.rerender(element(drawn, seq)) } }
}

/** Tick the first row of the drawn table. */
async function tickFirstRow(view: ReturnType<typeof render>): Promise<void> {
  const boxes = view.container.querySelectorAll('.el-table__body-wrapper .el-checkbox__original')
  fireEvent.click(boxes[0] as HTMLElement)
  await flush()
}

/** The line the seat draws in place of a block that is still waiting. */
function waiting(view: ReturnType<typeof render>): Element | null {
  return view.container.querySelector('[data-component-surface-awaiting="d"]')
}

/** The record block's element, or null while it is waiting. */
function record(view: ReturnType<typeof render>): Element | null {
  return view.container.querySelector(`[data-component-block="${RECORD_DETAIL_ID}"]`)
}

describe('one call whose blocks feed each other', () => {
  it('draws the waiting line until the block above has published, then the block itself', async () => {
    const { view } = await mount([TABLE, detailsFrom('node:t.selectionDetail')])
    expect(waiting(view)?.textContent).toBe(en['block.awaiting'])
    expect(record(view)).toBeNull()

    await tickFirstRow(view)
    expect(waiting(view)).toBeNull()
    expect(record(view)?.textContent).toContain('一号站点')
    // The heading the user is reading, not the field the data uses.
    expect(record(view)?.textContent).toContain('名称')
  })

  it('leaves the table holding the tick that fed the block beside it', async () => {
    const { view } = await mount([TABLE, detailsFrom('node:t.selectionDetail')])
    const before = view.container.querySelector(`[data-component-block="${TABLE_ID}"]`)
    await tickFirstRow(view)
    // The same element, and still ticked: the table was handed the properties
    // it already had, so el-table never saw a new row list to clear against.
    expect(view.container.querySelector(`[data-component-block="${TABLE_ID}"]`)).toBe(before)
    const box = view.container.querySelector('.el-table__body-wrapper .el-checkbox') as HTMLElement
    expect(box.classList.contains('is-checked')).toBe(true)
  })

  it('takes the record back to the waiting line when the user lets the row go', async () => {
    const { view } = await mount([TABLE, detailsFrom('node:t.selectionDetail')])
    await tickFirstRow(view)
    expect(record(view)?.textContent).toContain('一号站点')

    await tickFirstRow(view)
    // Published a second time under the same call, empty this time. The
    // record's own floor is one row, so what stands in its place is the
    // waiting line rather than an empty record or the row that is gone.
    expect(waiting(view)?.textContent).toBe(en['block.awaiting'])
    expect(record(view)).toBeNull()
  })

  it('keeps the block waiting when the item it reads is past the end of what was published', async () => {
    const { view } = await mount([TABLE, detailsFrom('node:t.selectionDetail[5]')])
    await tickFirstRow(view)
    // The table published; the fifth row of a one-row list is still nothing.
    expect(waiting(view)?.textContent).toBe(en['block.awaiting'])
    expect(record(view)).toBeNull()
  })

  it('sends nothing of what one block lent another', async () => {
    const { view, onAction } = await mount([TABLE, detailsFrom('node:t.selectionDetail')])
    await tickFirstRow(view)
    expect(record(view)?.textContent).toContain('一号站点')
    const sent = JSON.stringify(onAction.mock.calls)
    // The gesture names the row by its position, the way it always did. What
    // the record block was fed is a value this page assembled, and a document
    // carrying it would be model-visible input nothing recorded.
    expect(sent).toContain('rowIndexes')
    expect(sent).not.toContain('$from')
    expect(sent).not.toContain('一号站点')
  })

  it('starts a later call under the same id with nothing published', async () => {
    const { view, show } = await mount([TABLE, detailsFrom('node:t.selectionDetail')])
    await tickFirstRow(view)
    expect(record(view)).not.toBeNull()

    show([TABLE, detailsFrom('node:t.selectionDetail')], 9)
    await flush()
    // The agent placed the pair again; nothing in it has been ticked, and the
    // rows of a table that is gone are not what the new record block draws.
    expect(waiting(view)?.textContent).toBe(en['block.awaiting'])
  })
})
