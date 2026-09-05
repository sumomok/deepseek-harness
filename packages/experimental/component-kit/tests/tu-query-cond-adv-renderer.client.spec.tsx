// @vitest-environment jsdom
/**
 * `el.filter-bar`: that the vendored condition editor draws the attributes a
 * block carries, that the button drawn beside it sends what the user built,
 * that an edit is reported as it happens, that a block whose last gesture is
 * still travelling sends nothing further, and that a new call replaces the
 * attribute list rather than leaving the previous one on screen.
 *
 * The conditions are read off the mounted instance, because the component emits
 * nothing at all — which is what the bridge's `instanceRef` exists for. The
 * user's own editing is driven here through the component's `setData`, its
 * other documented instance method: element-ui's select needs a popper layout
 * jsdom cannot do, and what is under test is the reporting rather than
 * element-ui's dropdown.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { installElementUI } from '../src/client/element-ui.ts'
import { TuQueryCondAdvRenderer } from '../src/client/TuQueryCondAdvRenderer.tsx'
import { en, zh } from '../src/client/locales.ts'
import type { ComponentActionState, ComponentRendererProps } from '../src/client/renderer.ts'

beforeAll(installElementUI)
afterEach(cleanup)

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** One condition the mounted component holds, as `setData` takes it. */
interface Condition {
  /** The attribute. */
  readonly key: string
  /** The match strategy. */
  readonly op: string
  /** What the user typed. */
  readonly value: unknown
}

/** The two attributes every case here starts from. */
const ATTRIBUTES = [
  { attributeEnName: 'zh_label', alias: '名称' },
  { attributeEnName: 'status', alias: '状态' },
]

/** The minimum of the mounted component this suite drives and reads. */
interface FilterInstance {
  /** Fill the editor in, the way the user would. */
  setData(params: { conditions: readonly Condition[]; matchMode?: 'AND' | 'OR' }): void
}

/**
 * Let Vue finish, the way every mount of a vendored component here has to.
 * @returns a promise settling after the queued Vue renders.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** Draw one filter bar over the properties under test. */
async function draw(
  props: Record<string, unknown>,
  onAction = vi.fn(),
  state: ComponentActionState = 'idle',
  onOutput = vi.fn(),
): Promise<{
  view: ReturnType<typeof render>
  onAction: ReturnType<typeof vi.fn>
  onOutput: ReturnType<typeof vi.fn>
}> {
  const view = render(
    <TuQueryCondAdvRenderer nodeId="node-1" props={props} state={state} onAction={onAction} onOutput={onOutput} t={t} />,
  )
  await flush()
  return { view, onAction, onOutput }
}

/** The component instance behind the block, reached the way a devtool would. */
function instance(container: HTMLElement): FilterInstance {
  const host = container.querySelector('[data-component-block="el.filter-bar"] span') as HTMLElement
  return (host.firstElementChild as unknown as { __vue__: { $children: [FilterInstance] } }).__vue__.$children[0]
}

/**
 * What one of the condition row's own lists offers, in order.
 * @param container - the drawn block.
 * @param column - which list: `0` is the attributes, `1` the match strategies.
 * @returns every option in that list.
 */
function optionsOf(container: HTMLElement, column: number): string[] {
  const list = container.querySelectorAll('.query-row > .el-col')[column]
  return [...(list?.querySelectorAll('.el-select-dropdown__item span') ?? [])]
    .map(option => option.textContent ?? '')
}

/** The button this renderer draws beside the component. */
function submit(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-component-action="submit"]') as HTMLButtonElement
}

describe('el.filter-bar', () => {
  it('draws the attributes a block carries, and a button in this row\'s own words', async () => {
    const { view } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    const block = view.container.querySelector('[data-component-block="el.filter-bar"]')
    expect(block?.getAttribute('data-component-node')).toBe('node-1')
    expect(optionsOf(view.container, 0)).toEqual(['名称(zh_label)', '状态(status)'])
    expect(submit(view.container).textContent).toBe(en['filterBar.submit'])
    expect(zh['filterBar.submit']).toBe('查询')
  })

  it('sends the conditions the user built', async () => {
    const { view, onAction } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    instance(view.container).setData({ conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }] })
    await flush()
    fireEvent.click(submit(view.container))
    expect(onAction).toHaveBeenLastCalledWith('submit', {
      conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }],
    })
  })

  it('sends nothing at all when the user built no complete condition', async () => {
    const { view, onAction } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    // The bar starts holding one empty row, so this is the first press a user
    // can make: a filter nobody built is not a filter the host can record.
    fireEvent.click(submit(view.container))
    expect(onAction).not.toHaveBeenCalled()
  })

  it('drops a condition whose value is not one the user could have typed', async () => {
    const { view, onAction } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    instance(view.container).setData({
      conditions: [
        { key: 'zh_label', op: 'LIKE', value: '一号' },
        { key: 'status', op: 'EQ', value: { nested: true } },
        { key: 'status', op: 'GREATER_THAN', value: 7 },
      ],
    })
    await flush()
    fireEvent.click(submit(view.container))
    expect(onAction).toHaveBeenLastCalledWith('submit', {
      conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }],
    })
  })

  it('reports how many conditions stand as the user edits them', async () => {
    const { view, onAction } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    instance(view.container).setData({
      conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }, { key: 'status', op: 'EQ', value: '在用' }],
    })
    await waitFor(() => { expect(onAction).toHaveBeenCalledWith('change', { count: 2 }) })
  })

  it('publishes nothing for the blocks beside it', async () => {
    // No component in this row takes a condition list as a property, so an edit
    // reaches the agent as its count and reaches no block at all.
    const onAction = vi.fn()
    const { view, onOutput } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } }, onAction)
    instance(view.container).setData({ conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }] })
    await waitFor(() => { expect(onAction).toHaveBeenCalledWith('change', { count: 1 }) })
    expect(onOutput).not.toHaveBeenCalled()
  })

  it('sends nothing further while the last gesture is still travelling, and says so', async () => {
    const { view, onAction } = await draw(
      { relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } },
      vi.fn(),
      'sending',
    )
    expect(submit(view.container).disabled).toBe(true)
    fireEvent.click(submit(view.container))
    expect(onAction).not.toHaveBeenCalled()
    expect(view.container.querySelector('[data-component-sent]')?.textContent).toBe('Sending…')
  })

  it('takes a gesture again once the last one was refused', async () => {
    const { view, onAction } = await draw(
      { relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } },
      vi.fn(),
      'refused',
    )
    expect(submit(view.container).disabled).toBe(false)
    instance(view.container).setData({ conditions: [{ key: 'status', op: 'EQ', value: '在用' }] })
    await flush()
    fireEvent.click(submit(view.container))
    expect(onAction).toHaveBeenCalledWith('submit', {
      conditions: [{ key: 'status', op: 'EQ', value: '在用' }],
    })
  })

  it('offers the attributes of the call now on display, not the previous one\'s', async () => {
    const onAction = vi.fn()
    const { view } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } }, onAction)
    view.rerender(
      <TuQueryCondAdvRenderer
        nodeId="node-1"
        props={{ relatedMeta: 'device', metaConfig: { attributes: [{ attributeEnName: 'ip', alias: '地址' }] } }}
        state="idle"
        onAction={onAction}
        onOutput={vi.fn()}
        t={t}
      />,
    )
    await flush()
    // The component copies the attribute list into its own data when it is
    // created and never watches it, so a new call is a new mount.
    expect(optionsOf(view.container, 0)).toEqual(['地址(ip)'])
    instance(view.container).setData({ conditions: [{ key: 'ip', op: 'EQ', value: '10.0.0.1' }] })
    await flush()
    fireEvent.click(submit(view.container))
    expect(onAction).toHaveBeenLastCalledWith('submit', {
      conditions: [{ key: 'ip', op: 'EQ', value: '10.0.0.1' }],
    })
  })

  it('takes the match strategies and the layout the block declares', async () => {
    const { view } = await draw({
      relatedMeta: 'site',
      metaConfig: { attributes: ATTRIBUTES },
      attrEqEnums: [{ value: 'EQ', label: '等于' }, { value: 'nope' }, 'not-a-strategy'],
      confStyle: { gutter: 20, showMatchMode: false },
    })
    expect(optionsOf(view.container, 0)).toEqual(['名称(zh_label)', '状态(status)'])
    expect(optionsOf(view.container, 1)).toEqual(['等于'])
    expect(view.container.querySelector('.el-radio')).toBeNull()
    expect(view.container.querySelector<HTMLElement>('.query-row')?.style.marginLeft).toBe('-10px')
  })

  it('types a value into the control its attribute\'s kind asks for', async () => {
    const { view } = await draw({
      relatedMeta: 'site',
      metaConfig: {
        attributes: [{ attributeEnName: 'built_at', alias: '启用时间', dataType: 'date' }],
      },
    })
    instance(view.container).setData({ conditions: [{ key: 'built_at', op: 'EQ', value: '' }] })
    await flush()
    const control = view.container.querySelectorAll('.query-row > .el-col')[2]
    // The component only reads the kind for an attribute the renderer also
    // marks as a plain field, so this is the flag written dead beside it.
    expect(control?.querySelector('.el-date-editor')).not.toBeNull()
    expect(control?.querySelector('input')?.disabled).toBe(false)
  })

  it('fills in the rest of a layout the block only half declared', async () => {
    const { view } = await draw({
      relatedMeta: 'site',
      metaConfig: { attributes: ATTRIBUTES },
      attrEqEnums: 'not-a-list',
      confStyle: { gutter: 'wide' },
    })
    // The component reads every field of the layout without a guard, so a
    // partial one would draw a row of columns with no width at all.
    expect(view.container.querySelector('.query-row > .el-col-6')).not.toBeNull()
    // And the AND/OR choice is off until a block asks for it.
    expect(view.container.querySelector('.el-radio')).toBeNull()
    // And the component's own sixteen strategies are still on offer.
    expect(optionsOf(view.container, 1)).toHaveLength(16)
  })

  it('offers the AND/OR choice when the block asks for it, and sends what the user picked', async () => {
    const { view, onAction } = await draw({
      relatedMeta: 'site',
      metaConfig: { attributes: ATTRIBUTES },
      confStyle: { showMatchMode: true },
    })
    expect(view.container.querySelectorAll('.title-options .el-radio')).toHaveLength(2)
    instance(view.container).setData({
      conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }],
      matchMode: 'OR',
    })
    await flush()
    fireEvent.click(submit(view.container))
    expect(onAction).toHaveBeenLastCalledWith('submit', {
      conditions: [{ key: 'zh_label', op: 'LIKE', value: '一号' }],
      matchMode: 'OR',
    })
  })

  it('reports an edit when the user leaves the value box they were typing in', async () => {
    const { view, onAction } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    instance(view.container).setData({ conditions: [{ key: 'zh_label', op: 'LIKE', value: '' }] })
    await flush()
    await waitFor(() => { expect(onAction).toHaveBeenCalledWith('change', { count: 1 }) })
    const typed = onAction.mock.calls.length
    const box = view.container.querySelector('.query-row > .el-col:nth-child(3) input') as HTMLInputElement
    // The value box reports its edit when the user commits it, not as they
    // type, so keystrokes reach the block's own state and nothing else.
    fireEvent.input(box, { target: { value: '一号' } })
    await flush()
    expect(onAction.mock.calls.length).toBe(typed)
    fireEvent.change(box, { target: { value: '一号' } })
    await waitFor(() => { expect(onAction.mock.calls.length).toBeGreaterThan(typed) })
    expect(onAction).toHaveBeenLastCalledWith('change', { count: 1 })
  })

  it('drops an attribute that names nothing in the data', async () => {
    const { view } = await draw({
      relatedMeta: 'site',
      metaConfig: {
        attributes: [ATTRIBUTES[0], { attributeEnName: 'ip' }, { alias: '无名' }, 'not-an-attribute'],
      },
    })
    // An attribute with no name of its own is offered under its data name.
    expect(optionsOf(view.container, 0)).toEqual(['名称(zh_label)', 'undefined(ip)'])
  })

  it('draws an editor with nothing to filter on when the block names none', async () => {
    const { view } = await draw({ metaConfig: 'not-a-config', confStyle: 'not-a-style' })
    // Never a fetch: without an attribute list the component would go and get
    // one, and the vendored build answers that by throwing.
    expect(optionsOf(view.container, 0)).toEqual([])
    expect(optionsOf(view.container, 1)).toHaveLength(16)
  })

  it('removes the mounted component when the block goes away', async () => {
    const { view } = await draw({ relatedMeta: 'site', metaConfig: { attributes: ATTRIBUTES } })
    const host = view.container.querySelector('[data-component-block="el.filter-bar"] span')
    expect(host?.childElementCount).toBe(1)
    view.unmount()
    expect(host?.childElementCount).toBe(0)
  })
})
