// @vitest-environment jsdom
/**
 * `toy.record`: that the vendored Vue component draws the rows a block carries,
 * that a new call redraws them, and what the renderer does with properties that
 * do not carry what the catalog declares.
 *
 * The last part is not a hostile-input test: the renderer table is one type for
 * every component, so a block's properties reach every renderer as
 * `Record<string, unknown>` and each one narrows what it declared. What is
 * pinned here is the narrowing, not a defense.
 *
 * One line of that narrowing is the empty value, which is a value: only a row
 * naming nothing, or carrying something that is not text at all, is dropped.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { installElementUI } from '../src/client/element-ui.ts'
import { TcFormDetailRenderer } from '../src/client/TcFormDetailRenderer.tsx'
import { en } from '../src/client/locales.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'

// The component's labels sit in element-ui form items and tooltips, so the row
// installs its UI library before any block is drawn.
beforeAll(installElementUI)
afterEach(cleanup)

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** Draw one record block over the properties under test. */
function draw(props: Record<string, unknown>): ReturnType<typeof render> {
  return render(
    <TcFormDetailRenderer nodeId="node-1" props={props} state="idle" onAction={vi.fn()} onOutput={vi.fn()} t={t} />,
  )
}

/** Every value cell the block drew, in order. */
function values(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.form-item-content')].map(cell => cell.textContent ?? '')
}

/** Every row the block drew, named by its label, in order. */
function labels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.el-form-item__label')].map(cell => cell.textContent?.trim() ?? '')
}

describe('toy.record', () => {
  it('draws the rows a block carries', () => {
    const { container } = draw({
      dataList: [
        { label: '名称', display: '一号站点' },
        { label: '状态', display: '在用' },
      ],
    })
    const block = container.querySelector('[data-component-block="toy.record"]')
    expect(block?.getAttribute('data-component-node')).toBe('node-1')
    expect(block?.querySelector('.form-detail')).not.toBeNull()
    expect(container.textContent).toContain('名称')
    expect(values(container)).toEqual(['一号站点', '在用'])
  })

  it('redraws when the block\'s properties change', async () => {
    const { container, rerender } = draw({ dataList: [{ label: '名称', display: '一号站点' }] })
    rerender(
      <TcFormDetailRenderer
        nodeId="node-1"
        props={{ dataList: [{ label: '名称', display: '二号站点' }] }}
        state="idle"
        onAction={vi.fn()}
        onOutput={vi.fn()}
        t={t}
      />,
    )
    await Promise.resolve()
    expect(values(container)).toEqual(['二号站点'])
  })

  it('takes the label width and column count the block declares', () => {
    const { container } = draw({
      dataList: [{ label: '名称', display: '一号站点' }],
      labelWidth: 90,
      columnNum: 3,
    })
    expect(container.querySelector<HTMLElement>('.el-form-item__label')?.style.width).toBe('90px')
    // Three columns across a 24-unit row.
    expect(container.querySelector('.el-col-8')).not.toBeNull()
  })

  it('leaves an absent option to the component\'s own default', () => {
    const { container } = draw({ dataList: [{ label: '名称', display: '一号站点' }] })
    expect(container.querySelector<HTMLElement>('.el-form-item__label')?.style.width).toBe('150px')
    expect(container.querySelector('.el-col-12')).not.toBeNull()
  })

  it('shows a numeric or boolean value as its own text', () => {
    const { container } = draw({
      dataList: [
        { label: '数量', display: 0 },
        { label: '启用', display: false },
      ],
    })
    // `0` and `false` are values a record still has to show.
    expect(values(container)).toEqual(['0', 'false'])
  })

  it('draws the label of a row whose value is empty, with nothing beside it', () => {
    const { container } = draw({
      dataList: [
        { label: '名称', display: '一号站点' },
        { label: '备注', display: '' },
      ],
    })
    // An attribute a record has but does not fill is the component's own case:
    // its `v-if` drops the value cell and leaves the label standing.
    expect(labels(container)).toEqual(['名称', '备注'])
    expect(values(container)).toEqual(['一号站点'])
  })

  it('drops a row that names nothing or carries a value the component cannot draw', () => {
    const { container } = draw({
      dataList: [
        { label: '名称', display: '一号站点' },
        { label: '', display: '无名' },
        { display: '无标签' },
        { label: '对象值', display: { nested: true } },
        '不是一行',
        null,
      ],
    })
    expect(labels(container)).toEqual(['名称'])
    expect(values(container)).toEqual(['一号站点'])
  })

  it('leaves a width the component cannot use to its own default', () => {
    // The catalog admits 40 to 240, so none of these reaches a live call; what
    // is pinned is that a stored record written by another build cannot put a
    // length of its own into the component's style.
    for (const labelWidth of [0, -20, Number.POSITIVE_INFINITY, '90px', null]) {
      const { container } = draw({ dataList: [{ label: '名称', display: '一号站点' }], labelWidth })
      expect(container.querySelector<HTMLElement>('.el-form-item__label')?.style.width).toBe('150px')
      cleanup()
    }
  })

  it('draws an empty record when the block carries no rows at all', () => {
    const { container } = draw({ dataList: '不是数组', columnNum: 0, labelWidth: '90px' })
    expect(container.querySelector('.form-detail')).not.toBeNull()
    expect(values(container)).toEqual([])
    expect(container.querySelector<HTMLElement>('.el-form-item__label')).toBeNull()
  })

  it('removes the mounted component when the block goes away', () => {
    const { container, unmount } = draw({ dataList: [{ label: '名称', display: '一号站点' }] })
    const block = container.querySelector('[data-component-block="toy.record"]')
    expect(block?.childElementCount).toBe(1)
    unmount()
    expect(block?.childElementCount).toBe(0)
  })
})
