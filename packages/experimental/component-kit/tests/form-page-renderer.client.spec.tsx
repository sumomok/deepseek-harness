// @vitest-environment jsdom
/**
 * `toy.form-page`: that the vendored form mounts nothing before its base path
 * is in force, says where the form comes from and requests nothing while the
 * data page beside it has opened nothing, opens the form it is asked to with
 * the host's verdict on this visitor, reports a saved record as `added` or
 * `modified`, an added one with no field any of the table's schemes masks,
 * and reads no credential of its own.
 *
 * The backend is the shared stub on `XMLHttpRequest` the data page's own spec
 * draws against. Nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { noteReportedColumns, setBizBasePath } from '@sumomok/toy-crud-kit'
import { installElementUI } from '../src/client/element-ui.ts'
import { FormPageRenderer } from '../src/client/FormPageRenderer.tsx'
import { en } from '../src/client/locales.ts'
import type { ComponentActionHandler, ComponentRendererProps } from '../src/client/renderer.ts'
import type { VueInstance } from '../src/client/vue-shim.ts'
import type { DataPageAbilityTable } from '../src/route.ts'
import { defineTable, drain, flush, seen, settleProgress, STORED_TOKEN, StubRequest } from './fixtures/crud-backend.client.ts'
import { BASE_PATH, basePathRead } from './fixtures/base-path.client.ts'
import { instanceOf } from './fixtures/kit-blocks.client.ts'

vi.mock('../src/client/data-page-settings.ts', () => import('./fixtures/base-path.client.ts'))

/** Every ability on: the verdict a case gets unless it is about the verdict. */
const ALL_ABILITIES: DataPageAbilityTable = { create: true, update: true, delete: true, import: true, export: true }

/** What the node half's verdict answers with, per case. */
let abilities: Promise<DataPageAbilityTable> = Promise.resolve(ALL_ABILITIES)

vi.mock('../src/client/data-page-abilities.ts', () => ({
  readAbilitiesFor: (): Promise<DataPageAbilityTable> => abilities,
}))

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** The form items every table here is served with: `code` is masked by the scheme. */
const FORM_ITEMS = [
  { relatedMetaAttr: 'code', alias: '编码', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ', showAsPass: 1 },
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
  { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
]

/**
 * Serve a table of its own to one case: the request layer caches a table's
 * schemes across mounts, and the kit remembers which columns of a table were
 * reported and which are masked for the life of the page.
 * @param meta - the table's name.
 * @returns the name.
 */
function table(meta: string): string {
  defineTable(meta, {
    gridItems: FORM_ITEMS.map(({ relatedMetaAttr, alias }) => ({ relatedMetaAttr, alias, isShow: '1' })),
    formItems: FORM_ITEMS,
    rows: [{ int_id: '1', code: 'C-1', zh_label: '甲', city: '北京' }],
  })
  return meta
}

beforeAll(() => {
  installElementUI()
  vi.stubGlobal('XMLHttpRequest', StubRequest)
  localStorage.setItem('accessToken', STORED_TOKEN)
  setBizBasePath('/probe-base/')
})

beforeEach(() => {
  basePathRead.answer = Promise.resolve(BASE_PATH)
  abilities = Promise.resolve(ALL_ABILITIES)
  localStorage.removeItem('userInfo')
  seen.length = 0
})

afterEach(async () => {
  cleanup()
  vi.restoreAllMocks()
  await drain()
})

// The last case's bar is still fading when the file ends, and jsdom is torn
// down right after: the removal would reach for a document that is gone.
afterAll(settleProgress)

/**
 * Draw one form page block.
 * @param props - the block's properties.
 * @param onAction - the block's action sink.
 * @returns the rendered view and the sink.
 */
function draw(props: Record<string, unknown>, onAction = vi.fn<ComponentActionHandler>()) {
  const element = (next: Record<string, unknown>) =>
    <FormPageRenderer nodeId="form-1" props={next} state="idle" onAction={onAction} onOutput={vi.fn()} t={t} />
  const view = render(element(props))
  return { view, onAction, redraw: (next: Record<string, unknown>) => { view.rerender(element(next)) } }
}

/** The kit's form under one drawn block. */
type FormInstance = VueInstance & {
  $props: Record<string, unknown>
  /** What the form is doing: `idle`, `pending`, `ready`, or why it did not open. */
  state: string
}

/**
 * The kit's form under one drawn block.
 * @param container - the drawn block.
 * @returns the instance.
 */
function formOf(container: HTMLElement): FormInstance {
  return instanceOf(container, 'ToyFormPage') as FormInstance
}

/**
 * Wait until the drawn form has opened.
 * @param container - the drawn block.
 * @returns the instance.
 */
async function opened(container: HTMLElement): Promise<FormInstance> {
  await vi.waitFor(() => { expect(container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
  await vi.waitFor(() => { expect(formOf(container).state).toBe('ready') }, { timeout: 5000, interval: 20 })
  return formOf(container)
}

/**
 * Type one value into the drawn form's field for one column, as a person does.
 * @param container - the drawn block.
 * @param field - the column the field is marked with.
 * @param value - what to type.
 */
async function typeInto(container: HTMLElement, field: string, value: string): Promise<void> {
  const input = await vi.waitFor(() => {
    const found = container.querySelector(`.toy-form-page input[data-component-field="${field}"]`)
    if (!(found instanceof HTMLInputElement)) throw new Error(`the form drew no field for "${field}"`)
    return found
  })
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('toy.form-page', () => {
  it('says where the form comes from, and requests and reads nothing, while the data page has opened nothing', async () => {
    const cookie = vi.spyOn(Document.prototype, 'cookie', 'get')
    const stored = vi.spyOn(Storage.prototype, 'getItem')
    const { view, onAction } = draw({ relatedMeta: table('probe_form_idle') })
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    await drain()
    expect(view.container.querySelector('[data-part-line="idle"]')?.textContent).toBe(en['formPage.idle'])
    // The form is mounted all the same, holding no request, so the first one
    // the data page publishes opens it in place.
    expect(formOf(view.container).$props['request']).toBeUndefined()
    expect(formOf(view.container).state).toBe('idle')
    expect(seen).toEqual([])
    expect(cookie).not.toHaveBeenCalled()
    expect(stored).not.toHaveBeenCalled()
    expect(onAction).not.toHaveBeenCalled()
  })

  it('opens the form the data page asked for, with the host\'s verdict spread last, reading only the request layer\'s own credential', async () => {
    const meta = table('probe_form_add')
    const cookie = vi.spyOn(Document.prototype, 'cookie', 'get')
    const stored = vi.spyOn(Storage.prototype, 'getItem')
    const request = { mode: 'add', type: meta }
    const { view } = draw(Object.freeze({ relatedMeta: meta, request, abilities: { create: false } }))
    const form = await opened(view.container)
    expect(view.container.querySelector('[data-part-line="idle"]')).toBeNull()
    expect(form.$props['relatedMeta']).toBe(meta)
    expect(form.$props['request']).toEqual(request)
    expect(form.$props['abilities']).toEqual(ALL_ABILITIES)
    expect(view.container.textContent).toContain('【演示设备】新增')
    // Every request went under the base path with the visitor's own token.
    expect(seen.length).toBeGreaterThan(0)
    for (const sent of seen) {
      expect(sent.url.startsWith('/probe-base/')).toBe(true)
      expect(sent.authorization).toBe(STORED_TOKEN)
    }
    // The request layer's own cross-site check reads the cookie jar once per
    // request it sends, and nothing else reads it. Every storage read is that
    // layer's too: the stored token and its two timestamps, the two profiles it
    // caches, and its cache of the table's form scheme.
    expect(cookie).toHaveBeenCalledTimes(seen.length)
    expect(new Set(stored.mock.calls.map(([key]) => key))).toEqual(new Set([
      'accessToken',
      'accessTokenTime',
      'accessTokenRenewalTime',
      'userInfo',
      'loginUserInfo',
      `localforage//_schemadefault_${meta}_2`,
    ]))
  })

  it('leaves out the save button for a mode the host\'s verdict turns off', async () => {
    abilities = Promise.resolve({ ...ALL_ABILITIES, create: false })
    const meta = table('probe_form_denied')
    const { view } = draw(Object.freeze({ relatedMeta: meta, request: { mode: 'add', type: meta } }))
    const form = await opened(view.container)
    await vi.waitFor(() => { expect(form.$props['abilities']).toEqual({ ...ALL_ABILITIES, create: false }) })
    await flush()
    const buttons = [...view.container.querySelectorAll('button')].map(button => button.textContent?.trim())
    expect(buttons).toContain('取 消')
    expect(buttons).not.toContain('确 定')
  })

  it('keeps the same form while the request changes, and draws the line again once it is withdrawn', async () => {
    const meta = table('probe_form_switch')
    const { view, redraw } = draw(Object.freeze({ relatedMeta: meta, request: { mode: 'add', type: meta } }))
    const form = await opened(view.container)
    redraw(Object.freeze({ relatedMeta: meta }))
    await vi.waitFor(() => { expect(view.container.querySelector('[data-part-line="idle"]')).not.toBeNull() })
    expect(formOf(view.container)).toBe(form)
    expect(form.state).toBe('idle')
  })

  it('reports a saved record as added or modified by the form\'s mode, held to what a report carries', async () => {
    const meta = table('probe_form_saved')
    const { view, onAction } = draw(Object.freeze({ relatedMeta: meta, request: { mode: 'add', type: meta } }))
    const form = await opened(view.container)
    form.$emit('form-saved', { mode: 'add', meta, record: { zh_label: '乙', '1st': 'x' } })
    expect(onAction).toHaveBeenLastCalledWith('added', { record: { zh_label: '乙' } })
    form.$emit('form-saved', { mode: 'modify', meta, record: {} })
    expect(onAction).toHaveBeenLastCalledWith('modified', { record: {} })
    form.$emit('form-saved', { mode: 'copy', meta, record: {} })
    expect(onAction).toHaveBeenCalledTimes(2)
  })

  it('keeps a column any of the table\'s schemes masks out of a record a person saves', async () => {
    const meta = table('probe_form_masked')
    // As a data page on the same table would have: every drawn column reported,
    // the masked one included, so what leaves it out is the form's own scheme.
    noteReportedColumns(meta, ['code', 'zh_label', 'city'])
    const { view, onAction } = draw(Object.freeze({ relatedMeta: meta, request: { mode: 'add', type: meta } }))
    await opened(view.container)
    await typeInto(view.container, 'code', 'C-9')
    await typeInto(view.container, 'zh_label', '乙')
    await typeInto(view.container, 'city', '上海')
    await flush()
    const save = view.container.querySelector('.toy-form-page [data-component-action="added"]')
    if (!(save instanceof HTMLElement)) throw new Error('the form drew no save control')
    save.click()
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenLastCalledWith('added', { record: { zh_label: '乙', city: '上海' } })
    }, { timeout: 5000, interval: 20 })
  }, 20_000)

  it('marks the save control with the action saving reports, and follows the form\'s mode', async () => {
    const meta = table('probe_form_marks')
    const { view, redraw } = draw(Object.freeze({ relatedMeta: meta, request: { mode: 'add', type: meta } }))
    await opened(view.container)
    const save = () => view.container.querySelector('.toy-form-page .dialog-footer .center .el-button--primary')
    await vi.waitFor(() => { expect(save()?.getAttribute('data-component-action')).toBe('added') }, { timeout: 5000, interval: 20 })
    expect(save()?.textContent?.trim()).toBe('确 定')
    // The form's fields are named after the columns their labels carry, so a
    // step names the column it wants written rather than the alias drawn.
    await vi.waitFor(() => {
      expect([...view.container.querySelectorAll('.toy-form-page input.el-input__inner')]
        .map(input => input.getAttribute('data-component-field'))).toEqual(['code', 'zh_label', 'city'])
    }, { timeout: 3000, interval: 20 })
    // The same form redrawn on a modify request saves an edit, and the mark
    // says so rather than reporting the mount's own mode.
    redraw(Object.freeze({ relatedMeta: meta, request: { mode: 'modify', type: meta, id: '1', name: '甲' } }))
    await vi.waitFor(() => { expect(save()?.getAttribute('data-component-action')).toBe('modified') }, { timeout: 5000, interval: 20 })
  }, 20_000)

  it('draws the line saying the block names no table, and mounts nothing', async () => {
    const { view } = draw({ request: { mode: 'add', type: 'probe_form_none' } })
    await flush()
    expect(view.container.querySelector('[data-part-line="table"]')?.textContent).toBe(en['formPage.noTable'])
    expect(view.container.querySelector('[data-toy-crud-box]')).toBeNull()
  })

  it('mounts nothing before the base path is in force, and says so either way', async () => {
    let release: (path: string) => void = () => {}
    basePathRead.answer = new Promise((resolve) => { release = resolve })
    const waiting = draw({ relatedMeta: table('probe_form_wait') })
    expect(waiting.view.container.querySelector('[data-part-line="preparing"]')?.textContent).toBe(en['formPage.preparing'])
    expect(waiting.view.container.querySelector('[data-toy-crud-box]')).toBeNull()
    release('/probe-base/')
    await vi.waitFor(() => { expect(waiting.view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    cleanup()
    basePathRead.answer = Promise.reject(new Error('component-kit: answered 503'))
    const failed = draw({ relatedMeta: table('probe_form_fail'), request: { mode: 'add', type: 'probe_form_fail' } })
    await vi.waitFor(() => {
      expect(failed.view.container.querySelector('[data-part-line="address"]')?.textContent).toBe(en['formPage.unavailable'])
    })
    await flush()
    // Read by the block's own table: a form a previous case drew can still
    // have a cached scheme's refresh in flight.
    expect(seen.filter(sent => sent.url.includes('probe_form_fail'))).toEqual([])
  })
})
