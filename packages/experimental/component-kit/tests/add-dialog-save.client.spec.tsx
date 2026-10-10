// @vitest-environment jsdom
/**
 * What the data page's own add dialog does when its confirm is pressed.
 *
 * The block validates the form before it writes: a required column left empty
 * ends the save inside the component — no request leaves, nothing is reported,
 * and the dialog stays open showing the field's own error. That is the fact a
 * step pressing the confirm has to live with: the press runs the block's
 * handler either way, and only a form the block accepts produces a request and
 * a reported save. The other half is the same dialog filled in: the request
 * leaves and the block reports the save.
 *
 * The backend is the shared stub on `XMLHttpRequest`, as in the data page's own
 * spec; nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { setBizBasePath } from '@sumomok/toy-crud-kit'
import { DataPageRenderer } from '../src/client/DataPageRenderer.tsx'
import { installElementUI } from '../src/client/element-ui.ts'
import { en } from '../src/client/locales.ts'
import type { ComponentRendererProps } from '../src/client/renderer.ts'
import { drain, flush, seen, settleProgress, STORED_TOKEN, StubRequest, defineTable } from './fixtures/crud-backend.client.ts'

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

/** The table every page here is opened on: one column the add form requires. */
const META = 'probe_add_save'

defineTable(META, {
  gridItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' }],
  formItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, relatedComponentObj: { name: 'edit_input' }, op: 'LIKE' }],
  addFormItems: [{ relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 1, relatedComponentObj: { name: 'edit_input' }, op: 'LIKE' }],
  rows: [],
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

/** Every request the stub saw for one table's add endpoint, which is what a save is. */
function addRequests(): { method: string; url: string }[] {
  return seen.filter(request => request.method === 'POST' && request.url.includes(`/api/resources/${META}`))
}

/**
 * Draw the page and open its add dialog.
 * @param onAction - the block's action sink, for what the page reports.
 * @returns the entry container and the rendered block.
 */
async function drawAndOpen(): Promise<{ entry: HTMLElement; onAction: ReturnType<typeof vi.fn> }> {
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
  const onAction = vi.fn()
  const props = Object.freeze({ relatedMeta: META, metaLabel: '演示设备', readOnly: false })
  render(<DataPageRenderer nodeId="page-1" props={props} state="idle" onAction={onAction} onOutput={vi.fn()} t={t} />, { container: entry })
  await vi.waitFor(() => { expect(entry.querySelector('[data-toy-crud-box]')).not.toBeNull() })
  await drain()
  const add = [...entry.querySelectorAll('button')].find(button => button.textContent?.trim() === '新增')
  add?.click()
  await vi.waitFor(() => { expect(entry.querySelector('.crud-add-dialog .dialog-footer .center .el-button--primary')).not.toBeNull() })
  await flush()
  return { entry, onAction }
}

/** The add dialog's own confirm, the control the block marks `added`. */
function confirm(): HTMLElement {
  const button = document.querySelector('.crud-add-dialog .dialog-footer .center .el-button--primary')
  if (button === null) throw new Error('the add dialog drew no confirm')
  return button as HTMLElement
}

/** The add dialog's field input for one column. */
function fieldInput(node: string): HTMLInputElement {
  const input = document.querySelector(`.crud-add-dialog input.el-input__inner[data-component-field="${node}"]`)
  if (input === null) throw new Error(`the add dialog drew no field for "${node}"`)
  return input as HTMLInputElement
}

describe('the add dialog\'s own confirm', () => {
  it('writes nothing and reports nothing while a required field is empty, and the dialog stays open', async () => {
    const { onAction } = await drawAndOpen()
    seen.length = 0
    confirm().click()
    await drain()
    expect(addRequests()).toEqual([])
    expect(onAction.mock.calls.filter(([id]) => id === 'added')).toEqual([])
    // The block drew the field's own validation error and left the dialog up.
    // The dialog's own wrapper is the element carrying the class, as the mark
    // pass reads it.
    expect(document.querySelector('.crud-add-dialog')).not.toBeNull()
    expect(document.querySelector('.crud-add-dialog .el-form-item__error')).not.toBeNull()
  })

  it('saves a form the block accepts: the request leaves, the save is reported, the dialog closes', async () => {
    const { onAction } = await drawAndOpen()
    const input = fieldInput('zh_label')
    input.value = '大屏演示图层_临时'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    seen.length = 0
    confirm().click()
    await drain()
    expect(addRequests().map(request => request.url.split('?')[0])).toEqual([`/probe-base/nrms-datamanagement/api/resources/${META}`])
    expect(onAction.mock.calls.filter(([id]) => id === 'added').length).toBe(1)
    expect(document.querySelector('.crud-add-dialog')).toBeNull()
  })
})
