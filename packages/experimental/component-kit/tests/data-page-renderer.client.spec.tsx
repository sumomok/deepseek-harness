// @vitest-environment jsdom
/**
 * `toy.data-page`: that the vendored data page mounts nothing before its base
 * path is in force, requests its table under that path with the token the
 * visitor has stored and no token the address bar carries, opens read-only
 * where the block arranged nothing, keeps its overlay and progress bar inside
 * its own box, leaves the shared element-ui defaults alone, and reports to the
 * agent exactly the bounded gestures the placement package's catalog declares —
 * the same load and query once per placing call, however often the block is
 * redrawn, a card only where the page draws it, and no value of a column the
 * table's scheme masks. And that it publishes what its add and modify buttons
 * and its names opened, withdrawing each value that names a record a delete
 * removed, and that a delete and a batch edit a person performs through the
 * page's own controls are reported by the counts, names and changed fields the
 * kit's own events carry.
 *
 * The backend is the shared stub on `XMLHttpRequest`, which is what the page's
 * own request layer uses under jsdom, serving the smallest scheme the page
 * accepts, its rows, and the two batch writes the page's own controls make.
 * Nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { reportedColumns, setBizBasePath } from '@sumomok/toy-crud-kit'
import { Vue as SuppliedVue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import { installElementUI } from '../src/client/element-ui.ts'
import { DataPageRenderer } from '../src/client/DataPageRenderer.tsx'
import { DATA_PAGE_REPORT_LIMITS } from '../src/client/data-page-limits.ts'
import { en } from '../src/client/locales.ts'
import type { ComponentActionHandler, ComponentOutputHandler, ComponentRendererProps } from '../src/client/renderer.ts'
import type { VueInstance } from '../src/client/vue-shim.ts'
import { NO_ABILITIES, type DataPageAbilityTable } from '../src/route.ts'
import { answers, defineTable, drain, flush, seen, settleProgress, STORED_TOKEN, StubRequest } from './fixtures/crud-backend.client.ts'
import { BASE_PATH, basePathRead } from './fixtures/base-path.client.ts'
import { instanceOf } from './fixtures/kit-blocks.client.ts'
import { MAX_READING_CHARS, MAX_READING_LINES } from '@deepseek-ai/dsh-experimental-component-surface/src/read-component-call.ts'
import { readComponentReportText } from '@deepseek-ai/dsh-experimental-component-surface/src/read-component-text.ts'
import { readComponentEntry } from '@deepseek-ai/dsh-experimental-component-surface/src/client/read-executor.ts'
import { clickTarget } from '@deepseek-ai/dsh-experimental-component-surface/src/client/targets.ts'

vi.mock('../src/client/data-page-settings.ts', () => import('./fixtures/base-path.client.ts'))

/** Every ability on: the verdict a case gets unless it is about the verdict. */
const ALL_ABILITIES: DataPageAbilityTable = { create: true, update: true, delete: true, import: true, export: true }

/** What the node half's verdict answers with, per case. */
let abilities: Promise<DataPageAbilityTable> = Promise.resolve(ALL_ABILITIES)

/** Every table the renderer asked the node half about. */
const abilityReads: string[] = []

vi.mock('../src/client/data-page-abilities.ts', () => ({
  readAbilitiesFor: (meta: string): Promise<DataPageAbilityTable> => {
    abilityReads.push(meta)
    return abilities
  },
}))

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** The table every page here is opened on. */
const META = 'probe_device'

/** Three drawn columns and one the scheme hides. */
const GRID_ITEMS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1' },
  { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  { relatedMetaAttr: 'state', alias: '状态' },
  { relatedMetaAttr: 'secret', alias: '隐藏列', isShow: '0' },
]

/** The three rows the stub answers every query with. */
const ROWS = [
  { int_id: '1', zh_label: '北京-核心-01', city: '北京', state: '在用', secret: 's1' },
  { int_id: '2', zh_label: '济南-接入-07', city: '济南', state: '在用', secret: 's2' },
  { int_id: '3', zh_label: '上海-汇聚-03', city: '上海', state: '停用', secret: 's3' },
]

defineTable(META, {
  gridItems: GRID_ITEMS,
  formItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
  ],
  rows: ROWS,
})

/**
 * A table whose scheme masks one of its drawn columns, in its columns and in
 * both of its forms, and draws each row's name as the link that opens the
 * record's card.
 */
const MASKED_META = 'probe_masked'

/** One row of {@link MASKED_META} whose first unmasked cell is empty, so a name read through the mask would be its code. */
const MASKED_ROW = { int_id: '1', code: 'C-1', zh_label: '', city: '北京' }

/** Another row of {@link MASKED_META}, named by a cell the scheme does not mask. */
const MASKED_NAMED_ROW = { int_id: '2', code: 'C-2', zh_label: '乙设备', city: '上海' }

defineTable(MASKED_META, {
  gridItems: [
    { relatedMetaAttr: 'code', alias: '编码', isShow: '1', showAsPass: 1 },
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', relatedComponent: 'display_default' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  ],
  formItems: [
    { relatedMetaAttr: 'code', alias: '编码', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ', showAsPass: 1 },
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
  ],
  rows: [MASKED_ROW, MASKED_NAMED_ROW],
})

/**
 * A table masking one of its drawn columns, the way {@link MASKED_META} does,
 * whose profile grants the visitor its city. The batch dialog draws the masked
 * code as a read-only 敏感数据 box whatever the profile grants, and takes a
 * value in the city field because the profile grants it, so a write through
 * the page's own controls reaches the backend with a masked column among its
 * ticked ones.
 */
const MASKED_WRITE_META = 'probe_masked_write'

defineTable(MASKED_WRITE_META, {
  gridItems: [
    { relatedMetaAttr: 'code', alias: '编码', isShow: '1', showAsPass: 1 },
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  ],
  formItems: [
    { relatedMetaAttr: 'code', alias: '编码', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ', showAsPass: 1 },
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
  ],
  rows: [
    { int_id: '1', code: 'C-1', zh_label: '北京-核心-01', city: '北京' },
    { int_id: '2', code: 'C-2', zh_label: '济南-接入-07', city: '济南' },
  ],
  modifiableColumns: ['city'],
})

/**
 * A table whose rows draw their names as the links that open each record's
 * card, keyed by nineteen-digit record ids, one of which no step could carry.
 */
const LINKED_META = 'probe_linked'

/** The rows of {@link LINKED_META}, in the order the page draws them. */
const LINKED_ROWS = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', city: '北京' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', city: '济南' },
  { int_id: '1134933624650219532', zh_label: '调压站', city: '上海' },
  { int_id: 'no id', zh_label: '无编号', city: '天津' },
]

defineTable(LINKED_META, {
  gridItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', relatedComponent: 'display_default' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  ],
  formItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
  ],
  rows: LINKED_ROWS,
})

/**
 * A table of twenty records whose relation column refers to a record in every
 * other row and is empty in the rest, so the page draws a relation link in
 * half the rows' scrolling body and none in the others.
 */
const RELATED_META = 'probe_related'

/** The rows of {@link RELATED_META}, in the order the page draws them. */
const RELATED_ROWS = Array.from({ length: 20 }, (_, at) => ({
  int_id: `r${String(at + 1).padStart(2, '0')}`,
  zh_label: `记录-${String(at + 1).padStart(2, '0')}`,
  city_id: at % 2 === 0 ? `城市-${String(at + 1)}` : '',
}))

defineTable(RELATED_META, {
  gridItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', relatedComponent: 'display_default' },
    { relatedMetaAttr: 'city_id', alias: '城市', isShow: '1', relatedComponent: 'display_default' },
  ],
  formItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
  ],
  rows: RELATED_ROWS,
  refs: RELATED_ROWS.map(row => (row.city_id === '' ? {} : { city_id: 'City' })),
})

/** A table of three records whose rows a case redraws by replacing the records the page displays. */
const REDRAWN_META = 'probe_redrawn'

defineTable(REDRAWN_META, {
  gridItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', relatedComponent: 'display_default' },
    { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  ],
  formItems: [
    { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
  ],
  rows: [
    { int_id: 'a1', zh_label: '甲', city: '北京' },
    { int_id: 'a2', zh_label: '乙', city: '上海' },
    { int_id: 'a3', zh_label: '丙', city: '天津' },
  ],
})

/** Every node appended straight under the document body, by id, while a case ran. */
const escaped: string[] = []

/** Every node appended anywhere under the page's box, by id, while a case ran. */
const contained: string[] = []

/** Record every element appended straight under the body, by id. */
function watchBody(): MutationObserver {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.id !== '') escaped.push(node.id)
      }
    }
  })
  observer.observe(document.body, { childList: true })
  return observer
}

let bodyWatch: MutationObserver | undefined

beforeAll(() => {
  installElementUI()
  vi.stubGlobal('XMLHttpRequest', StubRequest)
  localStorage.setItem('accessToken', STORED_TOKEN)
  setBizBasePath('/probe-base/')
})

beforeEach(() => {
  basePathRead.answer = Promise.resolve(BASE_PATH)
  abilities = Promise.resolve(ALL_ABILITIES)
  abilityReads.length = 0
  answers.userInfo = undefined
  // The request layer keeps the profile it fetched under this key and reuses
  // it while the stored token still matches, so a case that answers the
  // profile request differently has to start from nothing fetched.
  localStorage.removeItem('userInfo')
  seen.length = 0
  escaped.length = 0
  contained.length = 0
  bodyWatch = watchBody()
})

afterEach(async () => {
  bodyWatch?.disconnect()
  cleanup()
  // Let whatever the torn-down page still had in flight arrive here rather
  // than in the next case: the request layer chains its profile, scheme and
  // query reads on the answers before them, so a page destroyed mid-chain can
  // still send the next request a turn later — and `seen` is reset per case.
  await drain()
})

// The last case's bar is still fading when the file ends, and jsdom is torn
// down right after: the removal would reach for a document that is gone.
afterAll(settleProgress)

/**
 * The block a call opens on the device table, ticking allowed. A fresh record
 * per case: the renderer remembers what one record's block reported, so a
 * shared one would make the second case's page a redraw of the first's.
 */
function pageProps(): Record<string, unknown> {
  return Object.freeze({ relatedMeta: META, metaLabel: '演示设备', selectMode: 'checkbox' })
}

/** Draw one page block over the properties under test, watching what lands inside its box. */
function draw(
  props: Record<string, unknown> = pageProps(),
  onAction = vi.fn<ComponentActionHandler>(),
  onOutput = vi.fn<ComponentOutputHandler>(),
) {
  const element = (next: Record<string, unknown>) =>
    <DataPageRenderer nodeId="page-1" props={next} state="idle" onAction={onAction} onOutput={onOutput} t={t} />
  const view = render(element(props))
  const boxWatch = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.id !== '' && node.closest('[data-toy-crud-box]') !== null) contained.push(node.id)
      }
    }
  })
  boxWatch.observe(view.container, { childList: true, subtree: true })
  return { view, onAction, onOutput, boxWatch, redraw: (next: Record<string, unknown>) => { view.rerender(element(next)) } }
}

/**
 * Wait until the page has reported its first query, which is the last thing a
 * mount does.
 * @param onAction - the block's action sink.
 */
async function loaded(onAction: ReturnType<typeof vi.fn>): Promise<void> {
  await vi.waitFor(() => {
    expect(onAction).toHaveBeenCalledWith('query', expect.anything())
  }, { timeout: 5000, interval: 20 })
  await flush()
}

/** The `DataPage` instance under one drawn block: where its events are raised. */
type PageInstance = VueInstance & {
  $props: Record<string, unknown>
  /**
   * The page's own handler for a relation link a person clicked, which opens
   * its side card. The demo device table's stub scheme draws no relation link,
   * so a case on that table that needs the card open calls the handler the
   * link's click would.
   */
  handleTableTransCellClick(payload: { readonly dataBase: unknown }): void
}

/** The `DataPage` instance under one drawn block, which is where its events are raised. */
function pageOf(container: HTMLElement): PageInstance {
  return instanceOf(container, 'ToyDataPage') as PageInstance
}

/**
 * Every button the block drew, in document order, as the text it carries and
 * the class an icon-only one is recognisable by.
 *
 * Nothing is filtered out: a page whose only *action* buttons are query and
 * clear still draws the pager's two arrows, and an assertion that dropped the
 * textless ones could not tell a new icon-only button from those.
 * @param container - the drawn block.
 * @returns one entry per button.
 */
function buttons(container: HTMLElement): { text: string; cls: string }[] {
  return [...container.querySelectorAll('button')]
    .map(button => ({ text: button.textContent?.trim() ?? '', cls: button.getAttribute('class') ?? '' }))
}

/**
 * The button a person finds by the text it shows.
 * @param scope - where to look.
 * @param text - the button's text.
 * @returns the button, or `undefined` where none shows that text.
 */
function buttonNamed(scope: ParentNode | null, text: string): Element | undefined {
  return [...scope?.querySelectorAll('button') ?? []].find(button => button.textContent?.trim() === text)
}

/**
 * The open dialog a person finds by its title.
 * @param container - the drawn block.
 * @param title - the dialog's title.
 * @returns the dialog, or `null` where none is drawn under that title.
 */
function dialogTitled(container: HTMLElement, title: string): Element | null {
  return container.querySelector(`[role="dialog"][aria-label="${title}"]`)
}

/**
 * One control a person finds in the row showing a name. el-table draws a row
 * once per wrapper and leaves the copies under a fixed column as `is-hidden`
 * placeholders, so the row is every wrapper's row at the same index, and only
 * its drawn cells are looked in.
 * @param container - the drawn block.
 * @param name - the row's name cell.
 * @param selector - the control, as it is drawn.
 * @param text - the text it shows, where several controls match the selector.
 * @returns the control, or `undefined` where the row draws none.
 */
function inRow(container: HTMLElement, name: string, selector: string, text?: string): Element | undefined {
  const cell = [...container.querySelectorAll('td:not(.is-hidden)')].find(td => td.textContent?.trim() === name)
  const row = cell?.closest('tr')
  if (row == null) throw new Error(`the table drew no row named "${name}"`)
  const index = [...row.parentElement?.children ?? []].indexOf(row)
  const controls = [...container.querySelectorAll('tbody')]
    .flatMap(body => [...body.children[index]?.querySelectorAll(`td:not(.is-hidden) ${selector}`) ?? []])
  return text === undefined ? controls[0] : controls.find(control => control.textContent?.trim() === text)
}

/**
 * The field input a person finds by its label, among the fields drawn now.
 * @param container - the drawn block.
 * @param label - the label the field shows.
 * @returns the column the input is marked with, `null` where it carries none.
 */
function fieldLabelled(container: HTMLElement, label: string): string | null | undefined {
  const item = [...container.querySelectorAll('.el-form-item')]
    .find(candidate => candidate.querySelector('label')?.textContent?.trim() === label)
  return item?.querySelector('input')?.getAttribute('data-component-field')
}

/**
 * One field of one open write dialog, as a person finds it by the label beside
 * it: the batch dialog's own item whose label reads `label`.
 * @param scope - where to look.
 * @param label - the label the field shows.
 * @returns the item, or `undefined` where no field shows that label.
 */
function fieldItem(scope: ParentNode, label: string): Element | undefined {
  return [...scope.querySelectorAll('.form-edit-item')]
    .find(candidate => candidate.querySelector('.el-form-item__label')?.textContent?.trim() === label)
}

describe('toy.data-page', () => {
  it('mounts nothing before the base path is in force, and says so', async () => {
    let release: (path: string) => void = () => {}
    basePathRead.answer = new Promise((resolve) => { release = resolve })
    const { view, onAction } = draw()
    expect(view.container.querySelector('[data-page-stalled="preparing"]')?.textContent).toBe(en['dataPage.preparing'])
    expect(view.container.querySelector('[data-toy-crud-box]')).toBeNull()
    expect(seen).toEqual([])
    release('/probe-base/')
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    // The first mount in this file, so nothing the request layer caches
    // across mounts — the user's profile, the table's scheme — is cached yet:
    // every request a fresh page makes goes out here, under the base path.
    await loaded(onAction)
    expect(seen.map(request => request.url.split('?')[0])).toEqual(expect.arrayContaining([
      '/probe-base/nrms-auth/api/auth/userinfo',
      '/probe-base/nrms-schema-manage/api/schema/schema',
      `/probe-base/nrms-datamanagement/api/resources/${META}/_search`,
    ]))
  })

  it('lets the base path settle after the block is gone, either way, without touching it', async () => {
    let release: (path: string) => void = () => {}
    basePathRead.answer = new Promise((resolve) => { release = resolve })
    const gone = draw()
    gone.view.unmount()
    release('/probe-base/')
    await flush()
    let refuse: (reason: Error) => void = () => {}
    basePathRead.answer = new Promise((_resolve, reject) => { refuse = reject })
    const alsoGone = draw()
    alsoGone.view.unmount()
    refuse(new Error('component-kit: answered 503'))
    await flush()
    expect(seen).toEqual([])
    expect(gone.onAction).not.toHaveBeenCalled()
    expect(alsoGone.onAction).not.toHaveBeenCalled()
  })

  it('draws the line saying the page cannot open where the base path never arrived', async () => {
    basePathRead.answer = Promise.reject(new Error('component-kit: answered 503'))
    const { view, onAction } = draw()
    await vi.waitFor(() => {
      expect(view.container.querySelector('[data-page-stalled="address"]')?.textContent).toBe(en['dataPage.unavailable'])
    })
    expect(seen).toEqual([])
    expect(onAction).not.toHaveBeenCalled()
  })

  it('draws the line saying the block names no table, rather than the one about an address, and waits on nothing', async () => {
    // `relatedMeta` is required in the catalog that admits the block, so this
    // is a record no call wrote. The line names this cause and not the settings
    // read's, and it is drawn whatever the base path is doing.
    let release: (path: string) => void = () => {}
    basePathRead.answer = new Promise((resolve) => { release = resolve })
    const { view, onAction } = draw(Object.freeze({ metaLabel: '演示设备' }))
    expect(view.container.querySelector('[data-page-stalled="table"]')?.textContent).toBe(en['dataPage.noTable'])
    release('/probe-base/')
    await flush()
    expect(view.container.querySelector('[data-toy-crud-box]')).toBeNull()
    expect(seen).toEqual([])
    expect(onAction).not.toHaveBeenCalled()
  })

  it('keeps the box a box until the page has finished being destroyed', async () => {
    // React runs effect cleanups in the order the effects were declared, and
    // the page raises its last toasts while Vue is tearing it down: released
    // before the bridge destroys the page, the containment would be gone
    // exactly when the page still needs somewhere to put them.
    const { view, onAction } = draw()
    await loaded(onAction)
    const box = view.container.querySelector('[data-toy-crud-box]') as HTMLElement
    const page = pageOf(view.container)
    let containedAtDestroy: boolean | undefined
    page.$once('hook:beforeDestroy', () => { containedAtDestroy = box.hasAttribute('data-toy-crud-box') })
    view.unmount()
    expect(containedAtDestroy).toBe(true)
    expect(box.hasAttribute('data-toy-crud-box')).toBe(false)
  })

  it('requests its table under the configured base path with the token the page carries, inside a contained box', async () => {
    // A bar the previous case left fading is drawn on the body once its box is
    // gone; it is that case's, and this one starts once it has finished.
    await settleProgress()
    escaped.length = 0
    const { view, onAction, boxWatch } = draw()
    await loaded(onAction)
    const block = view.container.querySelector('[data-component-block="toy.data-page"]')
    expect(block?.getAttribute('data-component-node')).toBe('page-1')
    // Every request went where the deployment said, with the visitor's own token.
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) {
      expect(request.url.startsWith('/probe-base/')).toBe(true)
      expect(request.authorization).toBe(STORED_TOKEN)
    }
    // The query itself is never cached: every mount asks for its rows.
    expect(seen.map(request => request.url.split('?')[0])).toContain(`/probe-base/nrms-datamanagement/api/resources/${META}/_search`)
    // The request layer's progress bar and overlay landed in the box and
    // nowhere on the body. `containCrud` adopts a body-level node through an
    // observer of its own, so the box can take it a turn after the page has
    // reported the query this waited for.
    await vi.waitFor(() => { expect(contained).toContain('nprogress') })
    boxWatch.disconnect()
    expect(escaped.filter(id => id === 'nprogress' || id === 'is-loading-full-overlay')).toEqual([])
    // The shared runtime's element-ui defaults are the row's own, untouched.
    expect((SuppliedVue.prototype as Record<string, unknown>).$ELEMENT).toEqual({ size: 'small', zIndex: 300 })
  })

  it('sends the stored token and leaves it stored, whatever token the page URL carries', async () => {
    // The console is not this deployment's login page, so a `token` in its
    // address bar can only have come from a link someone sent the visitor.
    // The vendored request layer reads the stored credential and nothing
    // else: the one in the URL neither goes on the wire nor lands in
    // `accessToken`, which is the key the auth gate reads back as the
    // signed-in visitor and mirrors into the cookie the proxy forwards.
    const injected = 'Bearer aGVhZGVy.eyJzdWIiOiJpbnRydWRlciJ9.c2ln'
    const here = window.location.href
    window.history.replaceState({}, '', `/app/chat?token=${encodeURIComponent(injected)}`)
    try {
      const { onAction } = draw()
      await loaded(onAction)
      expect(seen.length).toBeGreaterThan(0)
      for (const request of seen) expect(request.authorization).toBe(STORED_TOKEN)
      expect(localStorage.getItem('accessToken')).toBe(STORED_TOKEN)
      // `setToken` writes this beside the token, so its absence says nothing wrote either.
      expect(localStorage.getItem('accessTokenTime')).toBeNull()
    } finally {
      window.history.replaceState({}, '', here)
    }
  })

  it('draws a read-only page: the query and clear buttons beside the pager, no write button, no dialog', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    // Every button on the page, in the order it draws them: the query panel's
    // two, and the pager's two arrows, which carry an icon and no text.
    expect(buttons(view.container)).toEqual([
      { text: '查询', cls: 'el-button query-btn el-button--default el-button--small' },
      { text: '清空', cls: 'el-button el-button--default el-button--small' },
      { text: '', cls: 'btn-prev' },
      { text: '', cls: 'btn-next' },
    ])
    expect(view.container.querySelector('.el-dialog')).toBeNull()
    const page = pageOf(view.container)
    // The block arranged nothing, so the page is holding its own defaults: it
    // refuses every write, and every region and toolbar button is on the table
    // it would draw if it could.
    expect(page.$props['readOnly']).toBe(true)
    expect(page.$props['regions']).toEqual({
      query: true, toolbar: true, table: true, operate: true, pagination: true, infoCard: true, addForm: true, modifyForm: true,
    })
    expect(page.$props['toolbarButtons']).toEqual(['add', 'exp', 'gridexp', 'batch', 'search', 'clear'])
    expect(page.$props['rowOperations']).toEqual(['modify', 'delete'])
    expect(page.$props['queryExpanded']).toBe(false)
    expect(page.$props['selectMode']).toBe('checkbox')
    expect(page.$props['relatedMeta']).toBe(META)
    // The card's name is the host's, and never reaches the page.
    expect(page.$props['metaLabel']).toBeUndefined()
  })

  it('draws the arrangement a written-down page wrote, and opens it for writing when that page says so', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      regions: {
        query: true, toolbar: true, table: true, operate: true, pagination: true, infoCard: true, addForm: true, modifyForm: true,
      },
      toolbarButtons: ['add', 'search', 'clear'],
      rowOperations: ['modify'],
      queryExpanded: false,
      pageSize: 20,
      pageSizes: [10, 20],
      readOnly: false,
    }))
    await loaded(onAction)
    const page = pageOf(view.container)
    expect(page.$props['readOnly']).toBe(false)
    expect(page.$props['toolbarButtons']).toEqual(['add', 'search', 'clear'])
    expect(page.$props['pageSizes']).toEqual([10, 20])
    // The rights the stub answered with left every write on, so the toolbar
    // draws 新增 beside the two query buttons — which is the backend's answer
    // rather than a decision anything here made.
    expect(buttons(view.container).map(button => button.text)).toEqual(['新增', '查询', '清空', '', ''])
  })

  it('draws the deployment\'s own refusal and fetches nothing for a table this account is not granted', async () => {
    // The stub's profile grants one table, and this block is opened on
    // another: the page reads that profile, finds no row for this table, and
    // stops there. What it draws is the deployment's own 无权限, inside the
    // box, at the height the box carries.
    const { view, onAction } = draw(Object.freeze({ relatedMeta: 'probe_other', metaLabel: '别的表' }))
    await vi.waitFor(
      () => { expect(onAction).toHaveBeenCalledWith('denied', { reason: 'no-row' }) },
      { timeout: 5000, interval: 20 },
    )
    await drain()
    const denial = view.container.querySelector('.toy-data-page.no-auth') as HTMLElement
    expect(denial.textContent?.trim()).toBe('无权限')
    expect(denial.closest('[data-toy-crud-box]')).not.toBeNull()
    // Nothing was fetched for the table: no scheme, no dictionary, no query.
    // Read by the table's own name rather than by counting requests, because
    // the page the previous case tore down can still have one in flight, and
    // this claim is about this page and not about how quiet the stub was.
    expect(seen.map(request => request.url).filter(url => url.includes('probe_other'))).toEqual([])
    // And the agent is told the one thing that happened, once.
    expect(onAction.mock.calls).toEqual([['denied', { reason: 'no-row' }]])
  })

  it('draws the same refusal, and names the other judgement, where the permissions cannot be obtained', async () => {
    // The deployment answered the profile request with a refusal of its own
    // rather than with a permission table, so the page can tell nothing about
    // this table — and the two are different things to say to the person, which
    // is the whole of what the reason carries.
    answers.userInfo = [200, { code: 1, msg: '用户没有资源权限!' }]
    // A table of its own, so what was fetched for it is read by its name the
    // way the case above reads its own: the page a previous case tore down can
    // still have a request in flight, and this claim is about this page.
    const { view, onAction } = draw(Object.freeze({ relatedMeta: 'probe_rights', metaLabel: '权限表' }))
    await vi.waitFor(
      () => { expect(onAction).toHaveBeenCalledWith('denied', { reason: 'no-rights-table' }) },
      { timeout: 5000, interval: 20 },
    )
    await drain()
    expect((view.container.querySelector('.toy-data-page.no-auth') as HTMLElement).textContent?.trim()).toBe('无权限')
    expect(seen.map(request => request.url).filter(url => url.includes('probe_rights'))).toEqual([])
    expect(onAction.mock.calls).toEqual([['denied', { reason: 'no-rights-table' }]])
  })

  it('reports a refusal once per placing call, and reports one naming another table to nobody', async () => {
    const props = Object.freeze({ relatedMeta: 'probe_other', metaLabel: '别的表' })
    const first = draw(props)
    await vi.waitFor(
      () => { expect(first.onAction).toHaveBeenCalledWith('denied', { reason: 'no-row' }) },
      { timeout: 5000, interval: 20 },
    )
    first.view.unmount()
    // The same property record: the column dropped the block and drew it
    // again, and the page judged the table again — the agent is told once.
    const again = draw(props, first.onAction)
    await drain()
    expect(again.onAction).toHaveBeenCalledTimes(1)
    // A refusal about a table this block was not opened on is not this block's.
    const page = pageOf(again.view.container)
    page.$emit('access-denied', { meta: 'probe_device', reason: 'no-row' })
    page.$emit('access-denied', {})
    expect(again.onAction).toHaveBeenCalledTimes(1)
  })

  it('reports a sign-in this deployment refused, with the answer it refused it with', async () => {
    // The deployment answered the page's first request by refusing the
    // credential the visitor had stored. The page stays where it is — nothing
    // navigates — and both signals arrive: the request layer's refusal of the
    // sign-in, and the page's own judgement, which cannot read a permission
    // table out of that answer either.
    answers.userInfo = [401, { code: 1, msg: '登录已失效' }]
    const here = window.location.href
    const { onAction } = draw()
    await vi.waitFor(
      () => { expect(onAction).toHaveBeenCalledWith('auth-failed', { status: 401, code: '1' }) },
      { timeout: 5000, interval: 20 },
    )
    await drain()
    expect(window.location.href).toBe(here)
    // Once per placing call, however many requests the page made and however
    // often the block is redrawn over the same call.
    expect(onAction.mock.calls.filter(([id]) => id === 'auth-failed')).toEqual([['auth-failed', { status: 401, code: '1' }]])
    expect(onAction).toHaveBeenCalledWith('denied', { reason: 'no-rights-table' })
  })

  it('reports no sign-in at all as the zero the page sends, and an answer it cannot state to nobody', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const page = pageOf(view.container)
    onAction.mockClear()
    page.$emit('auth-failed', { status: 0 })
    // The same one again: the request layer raises one per mount, and a block
    // redrawn over the same call judges the same answer again.
    page.$emit('auth-failed', { status: 0 })
    page.$emit('auth-failed', { status: 601 })
    page.$emit('auth-failed', {})
    expect(onAction.mock.calls).toEqual([['auth-failed', { status: 0 }]])
  })

  it('reports the drawn columns once loaded, and the counts of the first query', async () => {
    const { onAction } = draw()
    await loaded(onAction)
    expect(onAction).toHaveBeenCalledWith('load', {
      meta: META,
      columns: [{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }, { attr: 'state', alias: '状态' }],
      total: 3,
      // The block arranged nothing, so the page is read-only and the rights it
      // resolved are the page's own read-only record: it may read and export,
      // and it may write nothing.
      rights: ['search', 'exp', 'searchSetting'],
    })
    expect(onAction).toHaveBeenCalledWith('query', { total: 3, rows: 3, page: 1 })
    expect(onAction.mock.calls.map(call => call[0])).toEqual(['load', 'query'])
  })

  it('names the buttons the deployment\'s own rights left pressable once the page can be written in', async () => {
    const { onAction } = draw(Object.freeze({ relatedMeta: META, metaLabel: '演示设备', readOnly: false }))
    await loaded(onAction)
    const load = onAction.mock.calls.find(call => call[0] === 'load')?.[1] as { rights: readonly string[] }
    // The stub backend grants every right it knows about; what is named here is
    // that row, read back, and nothing this row decided.
    expect(load.rights).toEqual(expect.arrayContaining(['search', 'add', 'update', 'delete', 'imp', 'exp']))
  })

  it('reports what the user ticked, opened, saved and pressed, each bounded the way its report is', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      selectMode: 'checkbox',
      customOperations: [{ name: 'ping', label: '测试连通' }],
    }))
    await loaded(onAction)
    const page = pageOf(view.container)
    page.$emit('table-selection-change', ROWS, ROWS)
    expect(onAction).toHaveBeenLastCalledWith('select', { count: 3, names: ['北京-核心-01', '济南-接入-07', '上海-汇聚-03'] })
    page.$emit('info-card-open', { id: '1', name: '北京-核心-01', type: 'device' })
    expect(onAction).toHaveBeenLastCalledWith('card-open', { name: '北京-核心-01', type: 'device' })
    page.$emit('info-card-close')
    expect(onAction).toHaveBeenLastCalledWith('card-close', {})
    // The save answers with the record the backend wrote, key and hidden
    // attributes included; what is reported is the drawn cells of it, read
    // through the columns the load remembered, so `int_id`, `code` and the
    // scheme's hidden `secret_col` reach nobody.
    page.$emit('add-save-success', { code: 0, int_id: '4', zh_label: '新建-01', secret_col: 'x', city: '青岛' })
    expect(onAction).toHaveBeenLastCalledWith('added', { record: { zh_label: '新建-01', city: '青岛' } })
    page.$emit('modify-save-success', { int_id: '1' })
    expect(onAction).toHaveBeenLastCalledWith('modified', { record: {} })
    page.$emit('table-operation-custom', { $index: 0, row: ROWS[0] }, { name: 'ping', label: '测试连通' }, ROWS[0])
    expect(onAction).toHaveBeenLastCalledWith('operation', { opId: 'ping', row: { zh_label: '北京-核心-01', city: '北京', state: '在用' } })
    // The two exports report which of them the page submitted and the file
    // type the press named, and never the task number the backend answered
    // with: it names a task on the deployment's own task list, which is where
    // the file is collected and which nothing here can reach.
    page.$emit('export-task-created', { mode: 'excel', fileType: 'csv', uuid: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' })
    expect(onAction).toHaveBeenLastCalledWith('exported', { mode: 'excel', fileType: 'csv' })
    page.$emit('export-task-created', { mode: 'grid_csv', fileType: null, uuid: 'f47ac10b' })
    expect(onAction).toHaveBeenLastCalledWith('exported', { mode: 'grid_csv' })
    // A gesture naming something no report may carry reaches nobody, and a
    // selection larger than a report may count is one of them.
    const before = onAction.mock.calls.length
    page.$emit('info-card-open', { id: '', name: '', type: '' })
    page.$emit('table-operation-custom', { $index: 0, row: ROWS[0] }, { label: '没有 name' }, ROWS[0])
    page.$emit('table-selection-change', Array.from({ length: DATA_PAGE_REPORT_LIMITS.tickedRows + 1 }, () => ROWS[0]), [])
    page.$emit('export-task-created', { mode: 'pdf', fileType: null, uuid: 'f47ac10b' })
    expect(onAction.mock.calls).toHaveLength(before)
  })

  it('reports a clicked cell with the row\'s drawn cells, cut to what a report carries', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const page = pageOf(view.container)
    const long = 'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength + 5)
    page.$emit('table-cell-click', {
      row: { zh_label: '北京-核心-01', city: long, state: { nested: true }, secret: 's1' },
      column: { property: 'city', label: '城市' },
      cell: null,
      event: new Event('click'),
    })
    expect(onAction).toHaveBeenLastCalledWith('cell-click', {
      attr: 'city',
      label: '城市',
      row: { zh_label: '北京-核心-01', city: `${'x'.repeat(DATA_PAGE_REPORT_LIMITS.cellLength - 1)}…` },
    })
    // A click on a column the catalog would refuse is reported to nobody, and
    // a header the page has none of is stood in for by the attribute.
    const before = onAction.mock.calls.length
    page.$emit('table-cell-click', { row: ROWS[0], column: { property: '1st' }, cell: null, event: new Event('click') })
    expect(onAction.mock.calls).toHaveLength(before)
    page.$emit('table-cell-click', { row: ROWS[0], column: { property: 'state' }, cell: null, event: new Event('click') })
    expect(onAction).toHaveBeenLastCalledWith('cell-click', {
      attr: 'state',
      label: 'state',
      row: { zh_label: '北京-核心-01', city: '北京', state: '在用' },
    })
  })

  it('reports no query out of an answer carrying no counts a report may state', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const page = pageOf(view.container)
    const before = onAction.mock.calls.length
    page.$emit('query-success', { rawValue: [], displayValue: [], ref: [], page: { total: 3, currentPage: 0, pageSize: 20 } })
    page.$emit('query-success', { rawValue: [], displayValue: null, ref: [], page: { total: 3, currentPage: 1, pageSize: 20 } })
    expect(onAction.mock.calls).toHaveLength(before)
    // A different answer is a new query, reported once more.
    page.$emit('query-success', { rawValue: [], displayValue: [], ref: [], page: { total: 0, currentPage: 2, pageSize: 20 } })
    expect(onAction).toHaveBeenLastCalledWith('query', { total: 0, rows: 0, page: 2 })
  })

  it('reports the same load and query once per placing call, however often the block is redrawn', async () => {
    const props = pageProps()
    const first = draw(props)
    await loaded(first.onAction)
    expect(first.onAction).toHaveBeenCalledTimes(2)
    first.view.unmount()
    // The same property record: the column dropped the block and drew it again.
    const again = draw(props, first.onAction)
    await flush()
    await vi.waitFor(() => { expect(seen.map(request => request.url).filter(url => url.includes('_search'))).toHaveLength(2) }, { timeout: 5000 })
    await flush()
    expect(again.onAction).toHaveBeenCalledTimes(2)
    again.view.unmount()
    // A new record is a new call, and reports afresh.
    const fresh = draw(pageProps(), first.onAction)
    await vi.waitFor(() => { expect(fresh.onAction).toHaveBeenCalledTimes(4) }, { timeout: 5000 })
  })

  it('hands the page every property a call may choose, and nothing it may not', async () => {
    const { view } = draw({
      relatedMeta: META,
      metaLabel: '演示设备',
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'state', op: 'IN', value: ['在用', 3, true] }, { op: 'EQ', value: 1 }, 7],
      matchMode: 'OR',
      querySort: { desc: 'city' },
      isInitQuery: false,
    })
    // The page's root renders a comment rather than an element until its
    // scheme resolves, and `pageOf` walks the DOM to the instance.
    const page = await vi.waitFor(() => pageOf(view.container), { timeout: 5000, interval: 20 })
    expect(page.$props['conditions']).toEqual([{ key: 'city', op: 'EQ', value: '北京' }, { key: 'state', op: 'IN', value: ['在用', 3] }])
    expect(page.$props['matchMode']).toBe('OR')
    expect(page.$props['querySort']).toEqual({ desc: 'city' })
    expect(page.$props['isInitQuery']).toBe(false)
    // The block named neither, so the page's own defaults stand.
    expect(page.$props['selectMode']).toBe('checkbox')
    expect(page.$props['readOnly']).toBe(true)
  })

  it('draws every entrance it could remove removed until the verdict arrives, then changes them in place', async () => {
    let answer: (table: DataPageAbilityTable) => void = () => {}
    abilities = new Promise((resolve) => { answer = resolve })
    const { view, onAction } = draw(Object.freeze({ relatedMeta: META, metaLabel: '演示设备', readOnly: false }))
    await loaded(onAction)
    const page = pageOf(view.container)
    expect(abilityReads).toEqual([META])
    expect(page.$props['abilities']).toEqual(NO_ABILITIES)
    expect(buttons(view.container).map(button => button.text)).toEqual(['查询', '清空', '', ''])
    const searched = seen.filter(request => request.url.includes('_search')).length
    answer({ create: true, update: false, delete: false, import: false, export: true })
    await vi.waitFor(() => { expect(buttons(view.container).map(button => button.text)).toContain('新增') })
    // The same page, told once more: no remount and no second query.
    expect(pageOf(view.container)).toBe(page)
    expect(page.$props['abilities']).toEqual({ create: true, update: false, delete: false, import: false, export: true })
    await flush()
    expect(seen.filter(request => request.url.includes('_search')).length).toBe(searched)
  })

  it('removes the entrances the verdict turns off', async () => {
    abilities = Promise.resolve({ create: false, update: true, delete: true, import: true, export: true })
    const { view, onAction } = draw(Object.freeze({ relatedMeta: META, metaLabel: '演示设备', readOnly: false }))
    await loaded(onAction)
    expect(pageOf(view.container).$props['abilities']).toEqual({ create: false, update: true, delete: true, import: true, export: true })
    expect(buttons(view.container).map(button => button.text)).not.toContain('新增')
  })

  it('passes the host verdict whatever the block record carries under the same name', async () => {
    abilities = new Promise(() => {})
    const { view } = draw(Object.freeze({ ...pageProps(), readOnly: false, abilities: ALL_ABILITIES }))
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    await flush()
    expect(pageOf(view.container).$props['abilities']).toEqual(NO_ABILITIES)
  })

  it('drops a verdict that arrives after the block is gone', async () => {
    let answer: (table: DataPageAbilityTable) => void = () => {}
    abilities = new Promise((resolve) => { answer = resolve })
    const { view } = draw()
    await vi.waitFor(() => { expect(abilityReads).toEqual([META]) })
    view.unmount()
    answer(ALL_ABILITIES)
    await flush()
  })
  it('publishes what the add and modify buttons open, and withdraws what the output could not carry', async () => {
    const { view, onAction, onOutput } = draw(Object.freeze({ ...pageProps(), readOnly: false }))
    await loaded(onAction)
    // The page's own add button: the page raises what it opened, and this
    // block publishes it for a form page beside it.
    const add = [...view.container.querySelectorAll('button')].find(button => button.textContent?.trim() === '新增')
    add?.click()
    await vi.waitFor(() => { expect(onOutput).toHaveBeenLastCalledWith('editing', { mode: 'add', type: META }) })
    const page = pageOf(view.container)
    page.$emit('form-open', { mode: 'modify', type: META, id: 2, name: '济南-接入-07' })
    expect(onOutput).toHaveBeenLastCalledWith('editing', { mode: 'modify', type: META, id: '2', name: '济南-接入-07' })
    // A modify naming no row is not one the output may carry, so the row the
    // form page beside it was showing is withdrawn rather than left standing.
    page.$emit('form-open', { mode: 'modify', type: META })
    expect(onOutput).toHaveBeenLastCalledWith('editing', undefined)
    // Publishing is not reporting: the agent is told nothing about either.
    expect(onAction.mock.calls.map(([id]) => id)).toEqual(['load', 'query'])
  })

  it('publishes the record a name opens, and reports the card where the page draws it itself', async () => {
    const { view, onAction, onOutput } = draw()
    await loaded(onAction)
    const page = pageOf(view.container)
    page.$emit('info-card-open', { id: 41, name: '北京-核心-01', type: 'device_port' })
    expect(onOutput).toHaveBeenLastCalledWith('opened', { id: '41', name: '北京-核心-01', type: 'device_port' })
    expect(onAction).toHaveBeenLastCalledWith('card-open', { name: '北京-核心-01', type: 'device_port' })
    page.$emit('info-card-close')
    expect(onOutput).toHaveBeenLastCalledWith('opened', undefined)
    expect(onAction).toHaveBeenLastCalledWith('card-close', {})
    // An id longer than the output carries withdraws the record standing, and
    // the card the page drew is still reported by its name.
    page.$emit('info-card-open', { id: 'x'.repeat(65), name: '长编号', type: META })
    expect(onOutput).toHaveBeenLastCalledWith('opened', undefined)
    expect(onAction).toHaveBeenLastCalledWith('card-open', { name: '长编号', type: META })
  })

  it('only publishes and withdraws what a name opens where the view switched the page\'s own card off', async () => {
    // The info card block beside the page reports that card, so reporting it
    // here as well would tell the agent about one card twice.
    const { view, onAction, onOutput } = draw(Object.freeze({ ...pageProps(), regions: { infoCard: false }, infoCardLinks: true }))
    await loaded(onAction)
    const page = pageOf(view.container)
    onAction.mockClear()
    page.$emit('info-card-open', { id: '1', name: '北京-核心-01', type: META })
    page.$emit('info-card-close')
    expect(onOutput.mock.calls).toEqual([['opened', { id: '1', name: '北京-核心-01', type: META }], ['opened', undefined]])
    expect(onAction).not.toHaveBeenCalled()
  })

  it('hands the page what a view arranged for relation links and deletes', async () => {
    const { view } = draw(Object.freeze({ ...pageProps(), regions: { infoCard: false }, infoCardLinks: true, deleteGisResource: 2 }))
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    await flush()
    const page = pageOf(view.container)
    expect(page.$props['infoCardLinks']).toBe(true)
    expect(page.$props['deleteGisResource']).toBe(2)
  })

  it('reports a delete by its counts and names, and withdraws each value naming a record it removed', async () => {
    const { view, onAction, onOutput } = draw(Object.freeze({ ...pageProps(), readOnly: false }))
    await loaded(onAction)
    const page = pageOf(view.container)
    page.$emit('form-open', { mode: 'modify', type: META, id: 2, name: '济南-接入-07' })
    page.$emit('info-card-open', { id: '2', name: '济南-接入-07', type: META })
    onOutput.mockClear()
    page.$emit('delete-save-success', { meta: META, ids: ['2'], deleted: [{ zh_label: '济南-接入-07', city: '济南' }], failed: 1 })
    expect(onAction).toHaveBeenLastCalledWith('deleted', { succeeded: 1, failed: 1, names: ['济南-接入-07'] })
    expect(onOutput.mock.calls).toEqual([['editing', undefined], ['opened', undefined]])
  })

  it('leaves standing what names another record, a related table\'s record under a deleted id, or no record', async () => {
    const { view, onAction, onOutput } = draw(Object.freeze({ ...pageProps(), readOnly: false }))
    await loaded(onAction)
    const page = pageOf(view.container)
    page.$emit('form-open', { mode: 'modify', type: META, id: '3', name: '上海-汇聚-03' })
    page.$emit('info-card-open', { id: '2', name: '端口-2', type: 'device_port' })
    page.$emit('delete-save-success', { meta: META, ids: ['2'], deleted: [{ zh_label: '济南-接入-07' }], failed: 0 })
    page.$emit('form-open', { mode: 'add', type: META })
    page.$emit('delete-save-success', { meta: META, ids: ['3'], deleted: [{ zh_label: '上海-汇聚-03' }], failed: 0 })
    expect(onOutput.mock.calls.filter(([, value]) => value === undefined)).toEqual([])
    // A payload stating no count is not reported, and still withdraws nothing it does not name.
    const before = onAction.mock.calls.length
    page.$emit('delete-save-success', { meta: META, ids: ['9'], deleted: [], failed: 'one' })
    expect(onAction.mock.calls).toHaveLength(before)
  })

  it('withdraws after a redraw of the same call what it published before the redraw', async () => {
    // The placement package keeps a published value for the call rather than
    // for one mount, so the block drawn again still owns it.
    const props = Object.freeze({ ...pageProps(), readOnly: false })
    const first = draw(props)
    await loaded(first.onAction)
    pageOf(first.view.container).$emit('info-card-open', { id: '1', name: '北京-核心-01', type: META })
    first.view.unmount()
    const again = draw(props, first.onAction, first.onOutput)
    await vi.waitFor(() => { expect(again.view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    await flush()
    pageOf(again.view.container).$emit('delete-save-success', { meta: META, ids: ['1'], deleted: [{}], failed: 0 })
    expect(first.onOutput).toHaveBeenLastCalledWith('opened', undefined)
  })

  it('reports a batch edit by its count, the names of the records and the fields changed', async () => {
    const { view, onAction } = draw(Object.freeze({ ...pageProps(), readOnly: false }))
    await loaded(onAction)
    const page = pageOf(view.container)
    page.$emit('batch-modify-save-success', {
      meta: META,
      modified: [{ zh_label: '北京-核心-01', city: '北京' }, { zh_label: '济南-接入-07' }],
      attrs: ['state', 'state', '1st'],
    })
    expect(onAction).toHaveBeenLastCalledWith('batch-modified', {
      succeeded: 2,
      names: ['北京-核心-01', '济南-接入-07'],
      fields: ['state'],
    })
    const before = onAction.mock.calls.length
    page.$emit('batch-modify-save-success', { meta: META, modified: null, attrs: [] })
    expect(onAction.mock.calls).toHaveLength(before)
  })
})

describe('a column the table\'s scheme masks', () => {
  it('is named in the load, and its value reaches no record the page reports', async () => {
    const { view, onAction } = draw(Object.freeze({ relatedMeta: MASKED_META, metaLabel: '脱敏表', readOnly: false }))
    await loaded(onAction)
    expect(onAction).toHaveBeenCalledWith('load', expect.objectContaining({
      columns: [{ attr: 'code', alias: '编码' }, { attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }],
    }))
    const page = pageOf(view.container)
    // A save answers with the whole record the backend wrote.
    page.$emit('add-save-success', { ...MASKED_ROW, zh_label: '乙' })
    expect(onAction).toHaveBeenLastCalledWith('added', { record: { zh_label: '乙', city: '北京' } })
    page.$emit('modify-save-success', MASKED_ROW)
    expect(onAction).toHaveBeenLastCalledWith('modified', { record: { zh_label: '', city: '北京' } })
    // A deleted or changed record raised whole, masked cell and all, is named
    // by its first unmasked cell that shows anything, and a masked field it
    // changed is not named.
    page.$emit('delete-save-success', { meta: MASKED_META, ids: ['1'], deleted: [MASKED_ROW], failed: 0 })
    expect(onAction).toHaveBeenLastCalledWith('deleted', { succeeded: 1, failed: 0, names: ['北京'] })
    page.$emit('batch-modify-save-success', { meta: MASKED_META, modified: [MASKED_ROW], attrs: ['code', 'city'] })
    expect(onAction).toHaveBeenLastCalledWith('batch-modified', { succeeded: 1, names: ['北京'], fields: ['city'] })
    // The page registered its own columns before raising the load; the
    // narrower list this block reports values from is the one it trims its
    // own saves to, and the one a form page on the same table trims to.
    expect(reportedColumns(MASKED_META)).toEqual(['zh_label', 'city'])
  })

  it('reads no clicked, ticked or pressed row through it', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: MASKED_META,
      metaLabel: '脱敏表',
      customOperations: [{ name: 'ping', label: '测试连通' }],
    }))
    await loaded(onAction)
    const page = pageOf(view.container)
    // A click on the masked column itself names the column, whose header is
    // on screen, and carries no value of it.
    page.$emit('table-cell-click', { row: MASKED_ROW, column: { property: 'code', label: '编码' }, cell: null, event: new Event('click') })
    expect(onAction).toHaveBeenLastCalledWith('cell-click', { attr: 'code', label: '编码', row: { zh_label: '', city: '北京' } })
    page.$emit('table-selection-change', [MASKED_ROW], [MASKED_ROW])
    expect(onAction).toHaveBeenLastCalledWith('select', { count: 1, names: ['北京'] })
    page.$emit('table-operation-custom', { $index: 0, row: MASKED_ROW }, { name: 'ping', label: '测试连通' }, MASKED_ROW)
    expect(onAction).toHaveBeenLastCalledWith('operation', { opId: 'ping', row: { zh_label: '', city: '北京' } })
  })
})

describe('a delete and a batch edit a person performs on the page', () => {
  it('reports a row deleted through the row\'s own bubble by its count and names, and withdraws the record its name opened', async () => {
    const { view, onAction, onOutput } = draw(Object.freeze({
      relatedMeta: MASKED_META,
      metaLabel: '脱敏表',
      readOnly: false,
      toolbarButtons: ['search', 'clear'],
      rowOperations: ['delete'],
      selectMode: 'checkbox',
      regions: { infoCard: false },
      infoCardLinks: true,
    }))
    await loaded(onAction)
    const name = await vi.waitFor(() => {
      const found = inRow(view.container, '乙设备', 'a.trans')
      if (found === undefined) throw new Error('the row drew no name link')
      return found
    })
    fireEvent.click(name)
    await vi.waitFor(() => {
      expect(onOutput).toHaveBeenLastCalledWith('opened', { id: '2', name: '乙设备', type: MASKED_META })
    }, { timeout: 5000, interval: 20 })
    const remove = await vi.waitFor(() => {
      const found = inRow(view.container, '乙设备', 'i.el-icon-delete')
      if (found === undefined) throw new Error('the row drew no delete control')
      return found
    })
    fireEvent.click(remove)
    // The bubble is drawn inside the row while it is closed and moves into the
    // box when the icon opens it, so what is answered is the open one.
    const bubble = await vi.waitFor(() => {
      const open = [...view.container.querySelectorAll<HTMLElement>('.el-popover')].find(
        popover => popover.style.display !== 'none' && buttonNamed(popover, '确定') !== undefined)
      if (open === undefined) throw new Error('the row drew no open confirmation bubble')
      return open
    }, { timeout: 5000, interval: 20 })
    onAction.mockClear()
    fireEvent.click(buttonNamed(bubble, '确定') as HTMLElement)
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('deleted', { succeeded: 1, failed: 0, names: ['乙设备'] })
    }, { timeout: 5000, interval: 20 })
    // The record the name opened is the one deleted, so it is withdrawn rather
    // than left naming a record now gone.
    expect(onOutput).toHaveBeenLastCalledWith('opened', undefined)
    // The scheme masks the row's code, and nothing the block reports carries it.
    expect(JSON.stringify(onAction.mock.calls)).not.toContain('C-2')
  }, 20_000)

  it('reports a batch edit saved through the batch dialog by its count, names and changed fields, and no value', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: MASKED_WRITE_META,
      metaLabel: '脱敏表',
      readOnly: false,
      toolbarButtons: ['batch', 'search', 'clear'],
      rowOperations: ['modify'],
      selectMode: 'checkbox',
    }))
    await loaded(onAction)
    for (const name of ['北京-核心-01', '济南-接入-07']) {
      const tick = await vi.waitFor(() => {
        const found = inRow(view.container, name, 'input[type="checkbox"]')
        if (found === undefined) throw new Error(`the table drew no tick beside "${name}"`)
        return found
      })
      fireEvent.click(tick)
      await flush()
    }
    // The batch menu opens on hover; its items are drawn hidden until it does.
    const trigger = view.container.querySelector('button[aria-haspopup="list"]')
    if (trigger === null) throw new Error('the toolbar drew no batch menu trigger')
    fireEvent.mouseEnter(trigger)
    const batchEdit = await vi.waitFor(() => {
      const menu = [...view.container.querySelectorAll<HTMLElement>('.el-dropdown-menu')]
        .find(candidate => candidate.style.display !== 'none')
      const item = menu === undefined
        ? undefined
        : [...menu.querySelectorAll('li')].find(candidate => candidate.textContent?.trim() === '批量修改')
      if (item === undefined) throw new Error('the batch menu is not open')
      return item
    }, { timeout: 5000, interval: 20 })
    fireEvent.click(batchEdit)
    const dialog = await vi.waitFor(() => {
      const found = dialogTitled(view.container, '【演示设备】批量修改（2条）')
      if (found === null) throw new Error('the batch dialog did not open')
      return found
    }, { timeout: 5000, interval: 20 })
    // Ticking a field's 改变 box opens it to a value only where the profile
    // grants its column and the scheme does not mask it: the masked code stays
    // a read-only 敏感数据 box, and the city field takes a value.
    const code = fieldItem(dialog, '编码')
    const city = fieldItem(dialog, '城市')
    if (code === undefined || city === undefined) throw new Error('the batch dialog draws no code and city fields')
    fireEvent.click(code.querySelector('.checkbox-div input[type="checkbox"]') as HTMLElement)
    fireEvent.click(city.querySelector('.checkbox-div input[type="checkbox"]') as HTMLElement)
    const value = await vi.waitFor(() => {
      const input = city.querySelector('input.el-input__inner')
      if (!(input instanceof HTMLInputElement) || input.disabled) throw new Error('the city field takes no value')
      return input
    }, { timeout: 5000, interval: 20 })
    fireEvent.input(value, { target: { value: '上海' } })
    await flush()
    onAction.mockClear()
    fireEvent.click(buttonNamed(dialog, '确 定') as HTMLElement)
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('batch-modified', { succeeded: 2, names: ['北京-核心-01', '济南-接入-07'], fields: ['city'] })
    }, { timeout: 5000, interval: 20 })
    // The value the person typed left with the write, and the write carried
    // both ticked fields: the kit writes a ticked field it holds no value for
    // as an empty string, so the masked code goes out as ''. The report names
    // the unmasked field alone and none of their values.
    const put = seen.find(request => request.method === 'PUT')
    if (put === undefined) throw new Error('the page sent no batch write')
    const body: unknown = JSON.parse(put.body)
    expect(body).toEqual({
      resclassenname: MASKED_WRITE_META,
      resObjList: [
        { rawValue: { int_id: '1', zh_label: '北京-核心-01', code: '', city: '上海' } },
        { rawValue: { int_id: '2', zh_label: '济南-接入-07', code: '', city: '上海' } },
      ],
    })
    expect(JSON.stringify(onAction.mock.calls)).not.toContain('上海')
  }, 20_000)
})

describe('the controls one data page marks for the act tool', () => {
  /**
   * The arrangement every case here draws: every toolbar button, one custom
   * operation, tickable rows. A fresh record per case: the renderer remembers
   * what one record's block reported, so a shared one would make the later
   * case's page a redraw of the first's and report nothing.
   * @returns the block's properties.
   */
  function arranged(): Record<string, unknown> {
    return Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      readOnly: false,
      toolbarButtons: ['add', 'exp', 'gridexp', 'search', 'clear'],
      rowOperations: ['modify'],
      customOperations: [{ name: 'ping', label: '测试连通' }],
      selectMode: 'checkbox',
    })
  }

  /**
   * The action and key one control carries, as the act tool reads them.
   * @param el - the control, as a person finds it on the page.
   * @returns the two marks, either `null` where absent, or `null` for a control the page did not draw.
   */
  function marksOn(el: Element | null | undefined): { action: string | null; key: string | null } | null {
    return el == null ? null : { action: el.getAttribute('data-component-action'), key: el.getAttribute('data-component-key') }
  }

  it('marks the toolbar, the table and its fields with the actions and keys the catalog declares', async () => {
    const { view, onAction } = draw(arranged())
    await loaded(onAction)
    await vi.waitFor(() => { expect(marksOn(buttonNamed(view.container, '查询'))).toEqual({ action: 'query', key: 'search' }) })
    const row = (selector: string, text?: string): Element | undefined => inRow(view.container, '北京-核心-01', selector, text)
    await vi.waitFor(() => { expect(row('a', '测试连通')).not.toBeUndefined() })
    expect([
      marksOn(buttonNamed(view.container, '新增')),
      marksOn(buttonNamed(view.container, '清空')),
      marksOn(buttonNamed(view.container, '模板导出')),
      marksOn(buttonNamed(view.container, '表格导出')),
      marksOn(row('i.el-icon-edit')),
      marksOn(row('a', '测试连通')),
      marksOn(row('input[type="checkbox"]')),
    ]).toEqual([
      // Opening the add form and clearing the query report nothing by
      // themselves: the page reports what either produced, so these two carry
      // the toolbar key the arrangement names them by and no action.
      { action: null, key: 'add' },
      { action: null, key: 'clear' },
      { action: 'exported', key: 'exp' },
      { action: 'exported', key: 'gridexp' },
      { action: 'operation', key: 'modify' },
      { action: 'operation', key: 'ping' },
      { action: 'select', key: null },
    ])
    // The query form's fields are named after the columns they write.
    await vi.waitFor(() => {
      expect([fieldLabelled(view.container, '名称'), fieldLabelled(view.container, '城市')]).toEqual(['zh_label', 'city'])
    }, { timeout: 3000, interval: 20 })
  })

  it('marks a write dialog\'s save button with the action it reports once that dialog is open', async () => {
    const { view, onAction } = draw(arranged())
    await loaded(onAction)
    await vi.waitFor(() => { expect(buttonNamed(view.container, '新增')).not.toBeUndefined() })
    // No dialog is drawn yet, so the write it saves with has no control to mark.
    expect(dialogTitled(view.container, '【演示设备】新增')).toBeNull()
    fireEvent.click(buttonNamed(view.container, '新增') as HTMLElement)
    await vi.waitFor(() => {
      expect(marksOn(buttonNamed(dialogTitled(view.container, '【演示设备】新增'), '确 定'))).toEqual({ action: 'added', key: null })
    }, { timeout: 5000, interval: 20 })
    // The page's own startup is the wait's whole cost here: a full file's
    // cases run these pages back to back, so the default deadline is short.
  }, 20_000)

  it('marks the modify dialog\'s save button with the write it reports', async () => {
    const { view, onAction } = draw(arranged())
    await loaded(onAction)
    const edit = await vi.waitFor(() => {
      const found = inRow(view.container, '北京-核心-01', 'i.el-icon-edit')
      if (found === undefined) throw new Error('the row drew no modify control')
      return found
    })
    fireEvent.click(edit)
    // The dialog draws its form a turn after it opens, and the footer with it,
    // so the save button is marked after that turn rather than with the click.
    await vi.waitFor(() => {
      expect(marksOn(buttonNamed(dialogTitled(view.container, '【演示设备】修改'), '确 定'))).toEqual({ action: 'modified', key: null })
    }, { timeout: 5000, interval: 20 })
  }, 20_000)

  it('marks no modify control where the arrangement keeps no such operation', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      readOnly: false,
      rowOperations: [],
      selectMode: 'checkbox',
    }))
    await loaded(onAction)
    await vi.waitFor(() => { expect(view.container.querySelector('.el-table__body-wrapper tbody tr')).not.toBeNull() })
    expect(view.container.querySelector('[data-component-key="modify"]')).toBeNull()
  })

  it('marks the row delete control, the batch menu and the batch dialogs with what they carry', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      readOnly: false,
      toolbarButtons: ['add', 'batch', 'search', 'clear'],
      rowOperations: ['modify', 'delete'],
      selectMode: 'checkbox',
    }))
    await loaded(onAction)
    const row = (selector: string, text?: string): Element | undefined => inRow(view.container, '北京-核心-01', selector, text)
    await vi.waitFor(() => { expect(row('i.el-icon-delete')).not.toBeUndefined() })
    await flush()
    // The row's own delete control opens the page's confirmation bubble, and
    // the button that answers the bubble is what a delete is reported from —
    // the same split the toolbar's add button and the add dialog's save have.
    expect(marksOn(row('i.el-icon-delete'))).toEqual({ action: null, key: 'delete' })
    expect(marksOn(row('button', '确定'))).toEqual({ action: 'deleted', key: null })
    // The batch button is the toolbar's own `batch`, and the clear button is
    // the one beside the query button: nothing else carries either key.
    expect(marksOn(view.container.querySelector('button[aria-haspopup="list"]'))).toEqual({ action: null, key: 'batch' })
    expect(marksOn(buttonNamed(view.container, '清空'))).toEqual({ action: null, key: 'clear' })
    expect(marksOn(buttonNamed(view.container, '查询'))).toEqual({ action: 'query', key: 'search' })
    const item = (text: string): Element | undefined =>
      [...view.container.querySelectorAll('li')].find(candidate => candidate.textContent?.trim() === text)
    expect([marksOn(item('批量修改')), marksOn(item('批量删除'))])
      .toEqual([{ action: null, key: 'batch-update' }, { action: null, key: 'batch-delete' }])
    // The item opens the batch edit; the dialog's own save button performs it.
    fireEvent.click(row('input[type="checkbox"]') as HTMLElement)
    await flush()
    fireEvent.click(item('批量修改') as HTMLElement)
    await vi.waitFor(() => {
      expect(marksOn(buttonNamed(dialogTitled(view.container, '【演示设备】批量修改（1条）'), '确 定')))
        .toEqual({ action: 'batch-modified', key: null })
    }, { timeout: 5000, interval: 20 })
    // A batch delete is confirmed inside the page's own delete dialog.
    fireEvent.click(item('批量删除') as HTMLElement)
    await vi.waitFor(() => {
      expect(marksOn(buttonNamed(dialogTitled(view.container, 'dialog'), '确定'))).toEqual({ action: null, key: 'batch-delete-confirm' })
    }, { timeout: 5000, interval: 20 })
  }, 20_000)

  it('marks the closer of the card the page draws for an opened record', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const closer = (): Element | null => view.container.querySelector('.crud-small-card .icon-close')
    expect(closer()).toBeNull()
    // What opens the page's own side card is its row interaction; until one
    // is taken there is no card and no closer to mark.
    pageOf(view.container).handleTableTransCellClick({ dataBase: { id: '1', name: '北京-核心-01', type: META } })
    await vi.waitFor(() => { expect(marksOn(closer())).toEqual({ action: 'card-close', key: null }) }, { timeout: 5000, interval: 20 })
  }, 20_000)

  it('keys every copy of each row by its record\'s id, and marks one opening cell and the name link per record', async () => {
    const { view, onAction } = draw(Object.freeze({
      relatedMeta: LINKED_META,
      metaLabel: '链接',
      readOnly: false,
      rowOperations: ['modify', 'delete'],
      selectMode: 'checkbox',
    }))
    await loaded(onAction)
    const ids = LINKED_ROWS.map(row => row.int_id)
    // The scrolling body and both fixed layers draw every record; each copy
    // carries the id, and the record whose id no step could carry carries none.
    await vi.waitFor(() => {
      expect([...view.container.querySelectorAll('.crud-table tbody')]
        .map(body => [...body.querySelectorAll('tr.el-table__row')].map(row => row.getAttribute('data-component-row'))))
        .toEqual([0, 1, 2].map(() => [...ids.slice(0, 3), null]))
    }, { timeout: 3000, interval: 20 })
    // One cell per record opens it: the name cell the left fixed layer draws.
    const opening = [...view.container.querySelectorAll('[data-component-action="cell-click"]')]
    expect(opening.map(cell => cell.textContent?.trim())).toEqual(LINKED_ROWS.map(row => row.zh_label))
    expect(opening.every(cell => cell.closest('.el-table__fixed') !== null)).toBe(true)
    // The name link inside that cell opens the record's card, named by its column.
    const links = [...view.container.querySelectorAll('[data-component-action="card-open"]')]
    expect(links.map(link => [link.textContent?.trim(), link.getAttribute('data-component-key')]))
      .toEqual(LINKED_ROWS.map(row => [row.zh_label, 'zh_label']))
    expect(links.every(link => link.closest('.el-table__fixed') !== null)).toBe(true)
    // Each row's own controls stand inside the row its key is written on.
    const modify = [...view.container.querySelectorAll('[data-component-key="modify"]')]
    expect(modify.map(control => control.closest('[data-component-row]')?.getAttribute('data-component-row') ?? null))
      .toEqual([...ids.slice(0, 3), null])
    const ticks = [...view.container.querySelectorAll('[data-component-action="select"]')]
    expect(ticks.map(tick => tick.closest('[data-component-row]')?.getAttribute('data-component-row') ?? null))
      .toEqual([...ids.slice(0, 3), null])
  }, 20_000)

  it('reports a cell the user clicks whichever cell it is, and both reports for the name link', async () => {
    const { view, onAction, onOutput } = draw(Object.freeze({ relatedMeta: LINKED_META, metaLabel: '链接', selectMode: 'checkbox' }))
    await loaded(onAction)
    await vi.waitFor(() => { expect(view.container.querySelector('[data-component-action="card-open"]')).not.toBeNull() })
    // The city cell opens nothing the act tool presses, and a person clicking
    // it is still reported: the report is the page's own event for the click.
    const city = [...view.container.querySelectorAll('.el-table__body-wrapper tbody td:not(.is-hidden)')]
      .find(cell => cell.textContent?.trim() === '济南') as HTMLElement
    expect(city.getAttribute('data-component-action')).toBeNull()
    fireEvent.click(city)
    expect(onAction).toHaveBeenLastCalledWith('cell-click', { attr: 'city', label: '城市', row: { zh_label: '燃气管线', city: '济南' } })
    // The name link opens the card, and its click reaches the row's own cell
    // click on the way up, so the page reports both, card first.
    onAction.mockClear()
    const link = inRow(view.container, '燃气管线', '[data-component-action="card-open"]') as HTMLElement
    fireEvent.click(link)
    expect(onAction.mock.calls.map(call => call[0])).toEqual(['card-open', 'cell-click'])
    expect(onAction).toHaveBeenCalledWith('card-open', { name: '燃气管线', type: LINKED_META })
    expect(onOutput).toHaveBeenLastCalledWith('opened', { id: '1134933624650219531', name: '燃气管线', type: LINKED_META })
  }, 20_000)

  it('reads every record of a page whose relation column links only some rows, each under its own key, within the bounds', async () => {
    const onAction = vi.fn<ComponentActionHandler>()
    const view = render(
      <div data-reading-entry="">
        <div data-component-node="page">
          <DataPageRenderer
            nodeId="page"
            props={Object.freeze({ relatedMeta: RELATED_META, metaLabel: '关联', readOnly: false, rowOperations: ['modify'], selectMode: 'checkbox' })}
            state="idle"
            onAction={onAction}
            onOutput={vi.fn()}
            t={t}
          />
        </div>
      </div>,
    )
    await loaded(onAction)
    await vi.waitFor(() => {
      expect(view.container.querySelectorAll('[data-component-action="card-open"][data-component-key="city_id"]')).toHaveLength(10)
    }, { timeout: 3000, interval: 20 })
    const within = view.container.querySelector('[data-reading-entry]') as Element
    const reading = readComponentEntry({ entry: 'related' }, { entryId: 'related', title: '关联', container: within })
    const keys = RELATED_ROWS.map(row => row.int_id)
    expect(reading.blocks[0]?.rows?.named.map(row => row.key)).toEqual(keys)
    const text = readComponentReportText(reading)
    expect(text.length).toBeLessThanOrEqual(MAX_READING_CHARS)
    expect(text.split('\n').length).toBeLessThanOrEqual(MAX_READING_LINES)
    // A row whose relation is empty draws one control fewer, so no one list
    // of what a row draws stands for every row: each is listed with its own,
    // which is this page's reading rather than a fold that failed.
    expect(text).not.toContain('Each row draws:')
    expect(text).toContain('      - "r02": "记录-02":')
    expect(text).not.toContain('no row key')
    for (const key of keys) expect(text).toContain(`        - "${key}": `)
    // The key printed for a row with no relation is the one a step presses it by.
    const named = clickTarget(within, { action: 'click', key: 'modify', row: 'r02' }, within)
    expect(named.kind === 'one' ? named.target.closest('tr')?.getAttribute('data-component-row') : named.kind).toBe('r02')
  }, 20_000)

  it('marks each record\'s name cell as its row\'s name and no relation cell, so a reading names the record itself', async () => {
    const onAction = vi.fn<ComponentActionHandler>()
    const view = render(
      <div data-reading-entry="">
        <div data-component-node="page">
          <DataPageRenderer
            nodeId="page"
            props={Object.freeze({ relatedMeta: RELATED_META, metaLabel: '关联', selectMode: 'checkbox' })}
            state="idle"
            onAction={onAction}
            onOutput={vi.fn()}
            t={t}
          />
        </div>
      </div>,
    )
    await loaded(onAction)
    const named = (): Element[] => [...view.container.querySelectorAll('[data-component-row-name]')]
    await vi.waitFor(() => { expect(named()).toHaveLength(RELATED_ROWS.length) }, { timeout: 3000, interval: 20 })
    expect(named().map(cell => cell.textContent?.trim())).toEqual(RELATED_ROWS.map(row => row.zh_label))
    expect(named().every(cell => cell.closest('.el-table__fixed') !== null)).toBe(true)
    // The relation links stand in cells no row is named by.
    const relations = [...view.container.querySelectorAll('[data-component-action="card-open"][data-component-key="city_id"]')]
    expect(relations).toHaveLength(10)
    expect(relations.every(link => link.closest('[data-component-row-name]') === null)).toBe(true)
    const within = view.container.querySelector('[data-reading-entry]') as Element
    const rows = readComponentEntry({ entry: 'related' }, { entryId: 'related', title: '关联', container: within }).blocks[0]?.rows
    expect(rows?.named.map(row => [row.key, row.name])).toEqual(RELATED_ROWS.map(row => [row.int_id, row.zh_label]))
  }, 20_000)

  it('writes no key a pass run between new records landing and the rows being redrawn would put on the wrong row', async () => {
    const { view, onAction } = draw(Object.freeze({ relatedMeta: REDRAWN_META, metaLabel: '重画', selectMode: 'checkbox' }))
    await loaded(onAction)
    // The scrolling body's rows, then the fixed layer's copies of them.
    const rows = (): (Element & { readonly __vue__?: { readonly row?: { readonly int_id?: unknown } } })[] =>
      [...view.container.querySelectorAll('.crud-table tbody tr.el-table__row')]
    /** Every drawn row whose key names a record other than the one it draws. */
    const misplaced = (): string[] => rows()
      .filter(row => row.hasAttribute('data-component-row') && row.getAttribute('data-component-row') !== row.__vue__?.row?.int_id)
      .map(row => `${row.getAttribute('data-component-row') ?? ''} on ${String(row.__vue__?.row?.int_id)}`)
    await vi.waitFor(() => { expect(rows().map(row => row.getAttribute('data-component-row'))).toEqual(['a1', 'a2', 'a3', 'a1', 'a2', 'a3']) })
    const seenMisplaced: string[] = []
    const watch = new MutationObserver(() => { seenMisplaced.push(...misplaced()) })
    watch.observe(view.container, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-component-row'] })
    const page = pageOf(view.container) as PageInstance & { resultData: Readonly<Record<string, unknown>> }
    /**
     * Replace the records the page displays the way an answer does, after a
     * change below the box: the mark pass that change queues runs before Vue
     * redraws the rows, with the new records and the old rows.
     */
    const replaceWith = async (records: readonly Readonly<Record<string, unknown>>[]): Promise<void> => {
      view.container.querySelector('.crud-table')?.appendChild(document.createElement('span'))
      Object.assign(page, { resultData: Object.freeze({ ...page.resultData, rawValue: records, displayValue: records }) })
      await drain()
    }
    // As many records, other ones.
    await replaceWith([{ int_id: 'b1', zh_label: '丁', city: '甲' }, { int_id: 'b2', zh_label: '戊', city: '乙' }, { int_id: 'b3', zh_label: '己', city: '丙' }])
    expect(rows().map(row => row.getAttribute('data-component-row'))).toEqual(['b1', 'b2', 'b3', 'b1', 'b2', 'b3'])
    // As many records, the same ids in another order, as new objects.
    await replaceWith([{ int_id: 'b2', zh_label: '戊', city: '乙' }, { int_id: 'b1', zh_label: '丁', city: '甲' }, { int_id: 'b3', zh_label: '己', city: '丙' }])
    expect(rows().map(row => row.getAttribute('data-component-row'))).toEqual(['b2', 'b1', 'b3', 'b2', 'b1', 'b3'])
    watch.disconnect()
    expect(seenMisplaced).toEqual([])
  }, 20_000)

  it('marks a control a redraw adds by the key the call now declares', async () => {
    // The operations are the placing call's, and a call may be replaced
    // without the block being taken down: the pass that marks the row then
    // has to name the controls as the call declares them now, not as the
    // mount it started with did.
    const { view, onAction, redraw } = draw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      readOnly: false,
      customOperations: [{ name: 'ping', label: '测试连通' }],
    }))
    await loaded(onAction)
    const link = (text: string): Element | undefined => inRow(view.container, '北京-核心-01', 'a', text)
    await vi.waitFor(() => { expect(marksOn(link('测试连通'))).toEqual({ action: 'operation', key: 'ping' }) })
    redraw(Object.freeze({
      relatedMeta: META,
      metaLabel: '演示设备',
      readOnly: false,
      customOperations: [{ name: 'ping', label: '测试连通' }, { name: 'pong', label: '测一下' }],
    }))
    await vi.waitFor(() => { expect(marksOn(link('测一下'))).toEqual({ action: 'operation', key: 'pong' }) }, { timeout: 3000, interval: 20 })
    expect(marksOn(link('测试连通'))).toEqual({ action: 'operation', key: 'ping' })
  })
})
