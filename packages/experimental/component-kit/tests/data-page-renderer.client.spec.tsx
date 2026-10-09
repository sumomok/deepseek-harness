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
 * removed.
 *
 * The backend is the shared stub on `XMLHttpRequest`, which is what the page's
 * own request layer uses under jsdom, serving the smallest scheme the page
 * accepts and its rows. Nothing here reaches a network.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
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

/** What the base-path read answers with, per case: a path, or a refusal. */
let basePath: Promise<string> = Promise.resolve('/probe-base/')

vi.mock('../src/client/data-page-settings.ts', () => ({
  dataPageBasePathReady: (): Promise<string> => basePath,
  settleDataPageBasePath: (): Promise<string> => basePath,
}))

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

/** A table whose scheme masks one of its drawn columns, in its columns and in both of its forms. */
const MASKED_META = 'probe_masked'

/** One row of {@link MASKED_META} whose first unmasked cell is empty, so a name read through the mask would be its code. */
const MASKED_ROW = { int_id: '1', code: 'C-1', zh_label: '', city: '北京' }

defineTable(MASKED_META, {
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
  rows: [MASKED_ROW],
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
  basePath = Promise.resolve('/probe-base/')
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
  const view = render(<DataPageRenderer nodeId="page-1" props={props} state="idle" onAction={onAction} onOutput={onOutput} t={t} />)
  const boxWatch = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.id !== '' && node.closest('[data-toy-crud-box]') !== null) contained.push(node.id)
      }
    }
  })
  boxWatch.observe(view.container, { childList: true, subtree: true })
  return { view, onAction, onOutput, boxWatch }
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

/** The `DataPage` instance under one drawn block: where its events are raised, and its two save handlers. */
type PageInstance = VueInstance & {
  $props: Record<string, unknown>
  /** The page's own handler for a delete that removed at least one record. */
  handleDeleteSuccess(finished: readonly unknown[]): void
  /** The page's own handler for a batch edit that changed every record. */
  handleModifyBatchSuccess(finished: readonly unknown[], batch: unknown): void
}

/** The `DataPage` instance under one drawn block, which is where its events are raised. */
function pageOf(container: HTMLElement): PageInstance {
  const box = container.querySelector('[data-toy-crud-box]') as HTMLElement
  const rootEl = box.firstElementChild?.firstElementChild as HTMLElement & { __vue__?: VueInstance }
  let instance = rootEl.__vue__ as VueInstance
  while (instance.$options.name !== 'ToyDataPage') instance = instance.$children[0] as VueInstance
  return instance as PageInstance
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

describe('toy.data-page', () => {
  it('mounts nothing before the base path is in force, and says so', async () => {
    let release: (path: string) => void = () => {}
    basePath = new Promise((resolve) => { release = resolve })
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
    basePath = new Promise((resolve) => { release = resolve })
    const gone = draw()
    gone.view.unmount()
    release('/probe-base/')
    await flush()
    let refuse: (reason: Error) => void = () => {}
    basePath = new Promise((_resolve, reject) => { refuse = reject })
    const alsoGone = draw()
    alsoGone.view.unmount()
    refuse(new Error('component-kit: answered 503'))
    await flush()
    expect(seen).toEqual([])
    expect(gone.onAction).not.toHaveBeenCalled()
    expect(alsoGone.onAction).not.toHaveBeenCalled()
  })

  it('draws the line saying the page cannot open where the base path never arrived', async () => {
    basePath = Promise.reject(new Error('component-kit: answered 503'))
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
    basePath = new Promise((resolve) => { release = resolve })
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
    const { view, onAction } = draw({
      relatedMeta: META,
      metaLabel: '演示设备',
      conditions: [{ key: 'city', op: 'EQ', value: '北京' }, { key: 'state', op: 'IN', value: ['在用', 3, true] }, { op: 'EQ', value: 1 }, 7],
      matchMode: 'OR',
      querySort: { desc: 'city' },
      isInitQuery: false,
    })
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    // The page renders its content only once its scheme has resolved; until
    // then its root renders the empty vnode, a comment rather than an element,
    // and `pageOf` walks the DOM to the instance. Wait for the drawn page
    // rather than for the box it lands in.
    const page = await vi.waitFor(() => pageOf(view.container), { timeout: 5000, interval: 20 })
    expect(page.$props['conditions']).toEqual([{ key: 'city', op: 'EQ', value: '北京' }, { key: 'state', op: 'IN', value: ['在用', 3] }])
    expect(page.$props['matchMode']).toBe('OR')
    expect(page.$props['querySort']).toEqual({ desc: 'city' })
    expect(page.$props['isInitQuery']).toBe(false)
    // The block named neither, so the page's own defaults stand.
    expect(page.$props['selectMode']).toBe('checkbox')
    expect(page.$props['readOnly']).toBe(true)
    // The block told the page not to query on mount; the vendored container
    // queries anyway, one 100 ms debounce later.
    //
    // The container mounts a query panel and a toolbar, and the toolbar's own
    // mount is reported to it as a press of 查询 (`CrudAction.vue`'s `mounted`
    // emits `action-click: 'query'`, which `handleToolbarAction` hands to
    // `handleActionClick` once the query panel's mount has already set
    // `firstQueryDone`). That path reaches `queryData()` with the mount flag
    // off, so the container's `isInitQuery` check in `getQueryParams` never
    // runs — with the toolbar drawn, `isInitQuery: false` changes nothing.
    // Both the reading and the container are the vendored kit's, and this line
    // reads the other way once the kit honors the property.
    //
    // This case draws this page alone, so every `_search` the stub has seen
    // since the case began belongs to it: waiting for its report and then for
    // the layer to fall quiet states the count over the whole of what it
    // searched — the one debounced first query.
    await vi.waitFor(() => {
      expect(onAction).toHaveBeenCalledWith('query', expect.anything())
    }, { timeout: 5000, interval: 20 })
    await drain()
    expect(seen.map(request => request.url).filter(url => url.includes('_search'))).toHaveLength(1)
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
      failed: 0,
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
    // The page's own handlers trim a deleted or changed record before raising
    // it; the record is named by its first unmasked cell that shows anything.
    page.handleDeleteSuccess([{ type: 'success', rawValue: MASKED_ROW }])
    expect(onAction).toHaveBeenLastCalledWith('deleted', { succeeded: 1, failed: 0, names: ['北京'] })
    page.handleModifyBatchSuccess([{ type: 'success', rawValue: MASKED_ROW }], { checkedAttr: [{ name: 'city' }] })
    expect(onAction).toHaveBeenLastCalledWith('batch-modified', { succeeded: 1, failed: 0, names: ['北京'], fields: ['city'] })
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
