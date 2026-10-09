// @vitest-environment jsdom
/**
 * The select field of a real data page, written by `act_component`.
 *
 * A select is the one field whose value lives in the component rather than in
 * the control the entry marks — element-ui's own input is read-only and only
 * shows the chosen label — so this is the page where a write that reported
 * success without the component taking it would have been possible. What the
 * cases here pin is the whole gesture: the add dialog's field is filled by
 * opening the list, choosing the option the value names, and the component's
 * own value changing; the list of a select in this row is drawn inside the
 * select, and so inside the entry `act_component` is confined to, rather than
 * on the document body; and a value no option carries is refused with the
 * value named while the component's value stays as it was.
 *
 * The backend is the shared stub on `XMLHttpRequest`, as in the data page's own
 * spec; nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { setBizBasePath } from '@sumomok/toy-crud-kit'
import { runActComponent, type ActComponentRun } from '@deepseek-ai/dsh-experimental-component-surface/src/client/act-executor.ts'
import { drawnEntry } from '@deepseek-ai/dsh-experimental-component-surface/src/client/entry-container.ts'
import { DataPageRenderer } from '../src/client/DataPageRenderer.tsx'
import { installElementUI } from '../src/client/element-ui.ts'
import { en } from '../src/client/locales.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'
import { drain, flush, settleProgress, STORED_TOKEN, StubRequest, defineTable } from './fixtures/crud-backend.client.ts'

/** The base path read, in force for every case here. */
vi.mock('../src/client/data-page-settings.ts', () => ({
  dataPageBasePathReady: (): Promise<string> => Promise.resolve('/probe-base/'),
  settleDataPageBasePath: (): Promise<string> => Promise.resolve('/probe-base/'),
}))

/** The abilities the node half answers with: every entrance kept. */
vi.mock('../src/client/data-page-abilities.ts', () => ({
  readAbilitiesFor: (): Promise<Record<string, boolean>> =>
    Promise.resolve({ create: true, update: true, delete: true, import: true, export: true }),
}))

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** The table every page here is opened on, with one text field and one select. */
const META = 'probe_select'

/** The two values the select's dictionary offers, by the label a step names. */
const DICT = [
  { key: 'hot', value: '核心' },
  { key: 'edge', value: '接入' },
]

defineTable(META, {
  gridItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  ],
  formItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, relatedComponentObj: { name: 'edit_input' }, op: 'LIKE' },
    {
      relatedMetaAttr: 'city',
      alias: '城市',
      isShow: 1,
      isEditable: 1,
      relatedComponentObj: { name: 'edit_select' },
      relatedDict: DICT,
      op: 'EQ',
    },
    {
      relatedMetaAttr: 'zone',
      alias: '区域',
      isShow: 1,
      isEditable: 1,
      relatedComponentObj: { name: 'edit_select_multi' },
      relatedDict: DICT,
      op: 'EQ',
    },
  ],
  rows: [{ int_id: '1', zh_label: '北京-核心-01', city: '北京' }],
})

beforeAll(() => {
  installElementUI()
  vi.stubGlobal('XMLHttpRequest', StubRequest)
  localStorage.setItem('accessToken', STORED_TOKEN)
  setBizBasePath('/probe-base/')
})

beforeEach(() => { localStorage.removeItem('userInfo') })

afterEach(async () => {
  cleanup()
  await drain()
})

afterAll(settleProgress)

/** One drawn data page inside the console shell the column would draw around it. */
interface Drawn {
  /** The entry's own container, which every step is confined to. */
  readonly entry: HTMLElement
  /** The rendered block. */
  readonly view: ReturnType<typeof render>
}

/**
 * Draw the console around one data page block and wait until its page is up.
 * @returns the entry container and the rendered block.
 */
async function draw(): Promise<Drawn> {
  document.body.innerHTML = `
    <nav data-content-surface-switcher>
      <button data-content-surface-entry="component demo" data-content-surface-selected>Demo</button>
    </nav>
    <div data-content-surface-seat="component" data-content-surface-active></div>
  `
  const seat = document.querySelector('[data-content-surface-seat="component"][data-content-surface-active]') as HTMLElement
  const entry = document.createElement('div')
  entry.setAttribute('data-component-surface', '')
  seat.appendChild(entry)
  const props = Object.freeze({ relatedMeta: META, metaLabel: '演示设备', readOnly: false })
  const view = render(
    <DataPageRenderer nodeId="page-1" props={props} state="idle" onAction={vi.fn()} onOutput={vi.fn()} t={t} />,
    { container: entry },
  )
  await vi.waitFor(() => { expect(entry.querySelector('[data-toy-crud-box]')).not.toBeNull() })
  await flush()
  return { entry, view }
}

/**
 * Open the page's add dialog, where the select field is drawn.
 * @param drawn - the drawn page.
 */
async function openAddDialog(drawn: Drawn): Promise<void> {
  const add = [...drawn.entry.querySelectorAll('button')].find(button => button.textContent?.trim() === '新增')
  add?.click()
  await vi.waitFor(() => { expect(drawn.entry.querySelector('.crud-add-dialog .el-select')).not.toBeNull() })
  await flush()
}

/**
 * Run one call the way the seat does, against the entry in front.
 * @param steps - the steps to run.
 * @returns what the call ended as.
 */
function run(steps: { readonly action: 'set'; readonly node?: string; readonly name: string; readonly value: string }[]): Promise<ActComponentRun> {
  const drawn = drawnEntry(document)
  if (drawn === undefined) throw new Error('the case drew no entry')
  return runActComponent({ entry: 'demo', steps }, drawn, () => drawnEntry(document))
}

/** The select the add dialog draws for one column, by the field it carries. */
function dialogSelect(drawn: Drawn, field: string): HTMLElement {
  for (const select of drawn.entry.querySelectorAll('.crud-add-dialog .el-select')) {
    if (select.querySelector('input.el-input__inner')?.getAttribute('data-component-field') === field) return select as HTMLElement
  }
  throw new Error(`the add dialog drew no select for "${field}"`)
}

/** The value the component behind one select holds, read off its own instance. */
function modelOf(select: HTMLElement): unknown {
  return (select as unknown as { __vue__: { value: unknown } }).__vue__.value
}

describe('a select field on a real data page', () => {
  it('fills it by choosing the option, and the component\'s own value changes', async () => {
    const drawn = await draw()
    await openAddDialog(drawn)
    const select = dialogSelect(drawn, 'city')
    const input = select.querySelector('input.el-input__inner') as HTMLInputElement
    // The field the page marks for the column: the control the step resolves.
    expect(input.getAttribute('data-component-field')).toBe('city')
    expect(modelOf(select)).toBe('')

    const report = await run([{ action: 'set', node: 'page-1', name: 'city', value: '接入' }])
    expect(report.steps).toEqual([{ index: 1, status: 'ok' }])
    expect(report.status).toBe('done')
    // The component's own value is what the write was for: the option's value,
    // not the label, and the label is what the select displays.
    expect(modelOf(select)).toBe('edge')
    expect(input.value).toBe('接入')
  })

  it('draws the select\'s list inside the select, and so inside the entry, not on the body', async () => {
    const drawn = await draw()
    await openAddDialog(drawn)
    const select = dialogSelect(drawn, 'city')
    // A person opens the list: a click on the select is what element-ui's own
    // toggle listens for, and the list it draws is inside the select itself.
    const dropdown = select.querySelector('.el-select-dropdown') as HTMLElement
    expect(getComputedStyle(dropdown).display).toBe('none')
    ;(select.querySelector('input.el-input__inner') as HTMLElement).click()
    await flush()
    expect(getComputedStyle(dropdown).display).not.toBe('none')
    expect(select.contains(dropdown)).toBe(true)
    expect(dropdown.parentElement === document.body).toBe(false)
    expect(drawn.entry.contains(dropdown)).toBe(true)

    // With the list already open the step chooses from it without the click
    // that would toggle it shut.
    const report = await run([{ action: 'set', node: 'page-1', name: 'city', value: '核心' }])
    expect(report.status).toBe('done')
    expect(modelOf(select)).toBe('hot')
  })

  it('refuses a value no option carries, naming it, and leaves the component\'s value alone', async () => {
    const drawn = await draw()
    await openAddDialog(drawn)
    const select = dialogSelect(drawn, 'city')

    const report = await run([{ action: 'set', node: 'page-1', name: 'city', value: '不存在的城市' }])
    expect(report.status).toBe('failed')
    expect(report.steps).toEqual([{
      index: 1,
      status: 'failed',
      message: 'The field for "city" has no option "不存在的城市".',
    }])
    expect(modelOf(select)).toBe('')
  })

  it('fills a multiple select too, and the component takes the option\'s value in its list', async () => {
    const drawn = await draw()
    await openAddDialog(drawn)
    const select = dialogSelect(drawn, 'zone')
    expect(modelOf(select)).toEqual([])

    const report = await run([{ action: 'set', node: 'page-1', name: 'zone', value: '接入' }])
    expect(report.status).toBe('done')
    // A multiple select holds a list of values and draws each choice as a tag,
    // which is what the step's confirmation reads.
    expect(modelOf(select)).toEqual(['edge'])
    expect(select.querySelector('.el-select__tags-text')?.textContent).toBe('接入')
  })
})
