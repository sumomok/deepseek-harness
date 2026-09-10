// @vitest-environment jsdom
/**
 * `toy.crud`: that the vendored data page mounts nothing before its base path
 * is in force, requests its table under that path with the token the visitor
 * has stored and no token the address bar carries, draws only the query and
 * clear buttons, keeps its overlay and progress bar inside its own box, leaves
 * the shared element-ui defaults alone, and reports to the agent exactly the
 * three bounded gestures the placement package's catalog declares — the same
 * load and query once per placing call, however often the block is redrawn.
 *
 * The backend is a stub on `XMLHttpRequest`, which is what the page's own
 * request layer uses under jsdom, serving the smallest scheme the page accepts
 * and three rows. Nothing here reaches a network.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { CRUD_READ_ONLY_PROPS, setBizBasePath } from '@sumomok/toy-crud-kit'
import { Vue as SuppliedVue } from '@deepseek-ai/dsh-experimental-vue2-echarts-poc/client'
import { installElementUI } from '../src/client/element-ui.ts'
import { CrudRenderer } from '../src/client/CrudRenderer.tsx'
import { CRUD_REPORT_LIMITS } from '../src/client/crud-limits.ts'
import { en } from '../src/client/locales.ts'
import type { ComponentActionHandler, ComponentRendererProps } from '../src/client/renderer.ts'
import type { VueInstance } from '../src/client/vue-shim.ts'

/** What the base-path read answers with, per case: a path, or a refusal. */
let basePath: Promise<string> = Promise.resolve('/probe-base/')

vi.mock('../src/client/crud-settings.ts', () => ({
  crudBasePathReady: (): Promise<string> => basePath,
  settleCrudBasePath: (): Promise<string> => basePath,
}))

const t: ComponentRendererProps['t'] = makeTranslate(en)

/** The table every page here is opened on. */
const META = 'probe_device'

/** The token the page carries, the way this deployment's login page leaves one. */
const STORED_TOKEN = 'Bearer aGVhZGVy.eyJzdWIiOiJ1LTEifQ.c2ln'

/** Three drawn columns and one the scheme hides. */
const GRID_ITEMS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1' },
  { relatedMetaAttr: 'city', alias: '城市', isShow: '1' },
  { relatedMetaAttr: 'state', alias: '状态' },
  { relatedMetaAttr: 'secret', alias: '隐藏列', isShow: '0' },
]

/** One scheme row of the three kinds the page asks for. */
function schemeRow(schemaType: number, schemaEnName: string): Record<string, unknown> {
  return {
    schemaType,
    isDefault: 1,
    schemaEnName,
    metaAlias: '演示设备',
    metaEnName: META,
    contentType: 'normal',
    form: [{
      formType: 'normal',
      labelWidth: '100px',
      formItems: [
        { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
        { relatedMetaAttr: 'city', alias: '城市', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
      ],
    }],
    grid: { gridItems: GRID_ITEMS },
  }
}

/** The three rows the stub answers every query with. */
const ROWS = [
  { int_id: '1', zh_label: '北京-核心-01', city: '北京', state: '在用', secret: 's1' },
  { int_id: '2', zh_label: '济南-接入-07', city: '济南', state: '在用', secret: 's2' },
  { int_id: '3', zh_label: '上海-汇聚-03', city: '上海', state: '停用', secret: 's3' },
]

/** One request the stub answered. */
interface Seen {
  method: string
  url: string
  authorization: string | undefined
}

/** Every request the stub answered, in order. */
const seen: Seen[] = []

/**
 * Answer one request the way the deployment's backend does.
 * @param method - the request method.
 * @param url - the request URL, query included.
 * @returns the status and the body.
 */
function route(method: string, url: string): [number, unknown] {
  const path = url.split('?')[0] ?? ''
  if (path.endsWith('/nrms-auth/api/auth/userinfo')) {
    return [200, { code: 0, data: { useraccount: 'probe', username: '探针用户', auth: { resclass: [
      {
        resclassenname: META, search: 1, add: 1, update: 1, delete: 1, imp: 1, exp: 1,
        gridexp: 1, searchSetting: 1, advSearch: 1, showAsPass: 0, columns: [],
      },
    ] } } }]
  }
  if (path.includes('/nrms-schema-manage/api/schema/schema')) {
    return [200, { code: 0, data: [schemeRow(1, `${META}_query`), schemeRow(2, `${META}_add`), schemeRow(3, `${META}_modify`)] }]
  }
  if (path.includes('/nrms-schema-manage/api/meta/resclass/')) {
    return [200, { code: 0, data: { metaEnName: META, metaAlias: '演示设备', attrs: [
      { relatedMetaAttr: 'zh_label', alias: '名称', dataType: 'string' },
      { relatedMetaAttr: 'city', alias: '城市', dataType: 'string' },
      { relatedMetaAttr: 'state', alias: '状态', dataType: 'string' },
      { relatedMetaAttr: 'secret', alias: '隐藏列', dataType: 'string' },
    ] } }]
  }
  if (method === 'POST' && path.endsWith('/_search')) {
    return [200, { code: 0, data: { rawValue: ROWS, displayValue: ROWS, ref: [], page: { total: 3, currentPage: 1, pageSize: 20 } } }]
  }
  return [200, { code: 0, data: null }]
}

/** The stub the page's request layer talks to under jsdom. */
class StubRequest {
  readyState = 0
  status = 0
  responseText = ''
  response = ''
  timeout = 0
  withCredentials = false
  responseType = ''
  onreadystatechange: (() => void) | null = null
  onload: (() => void) | null = null
  upload = { addEventListener: (): void => {} }
  private method = ''
  private url = ''
  private readonly headers: Record<string, string> = {}
  private readonly listeners: Record<string, (() => void)[]> = {}

  open(method: string, url: string): void {
    this.method = method
    this.url = url
    this.readyState = 1
  }

  setRequestHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value
  }

  getAllResponseHeaders(): string {
    return 'content-type: application/json\r\n'
  }

  addEventListener(type: string, listener: () => void): void {
    (this.listeners[type] ??= []).push(listener)
  }

  removeEventListener(): void {}

  abort(): void {}

  send(): void {
    seen.push({ method: this.method, url: this.url, authorization: this.headers['authorization'] })
    const [status, body] = route(this.method, this.url)
    setTimeout(() => {
      this.readyState = 4
      this.status = status
      this.responseText = JSON.stringify(body)
      this.response = this.responseText
      this.onreadystatechange?.()
      this.onload?.()
      for (const listener of this.listeners['load'] ?? []) listener()
      for (const listener of this.listeners['loadend'] ?? []) listener()
    }, 0)
  }
}

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

/**
 * The block a call opens on the device table, ticking allowed. A fresh record
 * per case: the renderer remembers what one record's block reported, so a
 * shared one would make the second case's page a redraw of the first's.
 */
function pageProps(): Record<string, unknown> {
  return Object.freeze({ relatedMeta: META, metaLabel: '演示设备', selectMode: 'checkbox' })
}

/**
 * Let Vue and the stub backend finish one round.
 * @returns a promise settling after the queued timers.
 */
function flush(): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, 20) })
}

/** Draw one page block over the properties under test, watching what lands inside its box. */
function draw(props: Record<string, unknown> = pageProps(), onAction = vi.fn<ComponentActionHandler>()) {
  const view = render(<CrudRenderer nodeId="page-1" props={props} state="idle" onAction={onAction} onOutput={vi.fn()} t={t} />)
  const boxWatch = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof HTMLElement && node.id !== '' && node.closest('[data-toy-crud-box]') !== null) contained.push(node.id)
      }
    }
  })
  boxWatch.observe(view.container, { childList: true, subtree: true })
  return { view, onAction, boxWatch }
}

/**
 * Wait until the stub backend has been quiet for three rounds, or forty rounds
 * have passed, whichever comes first.
 * @returns a promise settling once nothing new has been requested.
 */
async function drain(): Promise<void> {
  let quiet = 0
  for (let round = 0; round < 40 && quiet < 3; round += 1) {
    const before = seen.length
    await flush()
    quiet = seen.length === before ? quiet + 1 : 0
  }
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

/** The `Crud` instance under one drawn block. */
function crudOf(container: HTMLElement): VueInstance & { $props: Record<string, unknown> } {
  const box = container.querySelector('[data-toy-crud-box]') as HTMLElement
  const rootEl = box.firstElementChild?.firstElementChild as HTMLElement & { __vue__?: VueInstance }
  let instance = rootEl.__vue__ as VueInstance
  while (instance.$options.name !== 'Crud') instance = instance.$children[0] as VueInstance
  return instance as VueInstance & { $props: Record<string, unknown> }
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

describe('toy.crud', () => {
  it('mounts nothing before the base path is in force, and says so', async () => {
    let release: (path: string) => void = () => {}
    basePath = new Promise((resolve) => { release = resolve })
    const { view, onAction } = draw()
    expect(view.container.querySelector('[data-crud-stalled="preparing"]')?.textContent).toBe(en['crud.preparing'])
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
      expect(view.container.querySelector('[data-crud-stalled="address"]')?.textContent).toBe(en['crud.unavailable'])
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
    expect(view.container.querySelector('[data-crud-stalled="table"]')?.textContent).toBe(en['crud.noTable'])
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
    const crud = crudOf(view.container)
    let containedAtDestroy: boolean | undefined
    crud.$once('hook:beforeDestroy', () => { containedAtDestroy = box.hasAttribute('data-toy-crud-box') })
    view.unmount()
    expect(containedAtDestroy).toBe(true)
    expect(box.hasAttribute('data-toy-crud-box')).toBe(false)
  })

  it('requests its table under the configured base path with the token the page carries, inside a contained box', async () => {
    const { view, onAction, boxWatch } = draw()
    await loaded(onAction)
    const block = view.container.querySelector('[data-component-block="toy.crud"]')
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
    const crud = crudOf(view.container)
    expect(crud.$props['isReadOnly']).toBe(true)
    expect(crud.$props['type']).toBe('default')
    expect(crud.$props['urlConfig']).toBeNull()
    expect(crud.$props['hideButton']).toEqual(CRUD_READ_ONLY_PROPS.hideButton)
    expect(crud.$props['hideComp']).toEqual({ menu: true, card: true })
    expect(crud.$props['selectMode']).toBe('checkbox')
    expect(crud.$props['relatedMeta']).toBe(META)
    // The card's name is the host's, and never reaches the page.
    expect(crud.$props['metaLabel']).toBeUndefined()
  })

  it('reports the drawn columns once loaded, and the counts of the first query', async () => {
    const { onAction } = draw()
    await loaded(onAction)
    expect(onAction).toHaveBeenCalledWith('load', {
      meta: META,
      columns: [{ attr: 'zh_label', alias: '名称' }, { attr: 'city', alias: '城市' }, { attr: 'state', alias: '状态' }],
      total: 3,
    })
    expect(onAction).toHaveBeenCalledWith('query', { total: 3, rows: 3, page: 1 })
    expect(onAction.mock.calls.map(call => call[0])).toEqual(['load', 'query'])
  })

  it('reports a clicked cell with the row\'s drawn cells, cut to what a report carries', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const crud = crudOf(view.container)
    const long = 'x'.repeat(CRUD_REPORT_LIMITS.cellLength + 5)
    crud.$emit('table-cell-click', {
      row: { zh_label: '北京-核心-01', city: long, state: { nested: true }, secret: 's1' },
      column: { property: 'city', label: '城市' },
      cell: null,
      event: new Event('click'),
    })
    expect(onAction).toHaveBeenLastCalledWith('cell-click', {
      attr: 'city',
      label: '城市',
      row: { zh_label: '北京-核心-01', city: `${'x'.repeat(CRUD_REPORT_LIMITS.cellLength - 1)}…` },
    })
    // A click on a column the catalog would refuse is reported to nobody, and
    // a header the page has none of is stood in for by the attribute.
    const before = onAction.mock.calls.length
    crud.$emit('table-cell-click', { row: ROWS[0], column: { property: '1st' }, cell: null, event: new Event('click') })
    expect(onAction.mock.calls).toHaveLength(before)
    crud.$emit('table-cell-click', { row: ROWS[0], column: { property: 'state' }, cell: null, event: new Event('click') })
    expect(onAction).toHaveBeenLastCalledWith('cell-click', {
      attr: 'state',
      label: 'state',
      row: { zh_label: '北京-核心-01', city: '北京', state: '在用' },
    })
  })

  it('reports no query out of an answer carrying no counts a report may state', async () => {
    const { view, onAction } = draw()
    await loaded(onAction)
    const crud = crudOf(view.container)
    const before = onAction.mock.calls.length
    crud.$emit('query-success', { rawValue: [], displayValue: [], ref: [], page: { total: 3, currentPage: 0, pageSize: 20 } })
    crud.$emit('query-success', { rawValue: [], displayValue: null, ref: [], page: { total: 3, currentPage: 1, pageSize: 20 } })
    expect(onAction.mock.calls).toHaveLength(before)
    // A different answer is a new query, reported once more.
    crud.$emit('query-success', { rawValue: [], displayValue: [], ref: [], page: { total: 0, currentPage: 2, pageSize: 20 } })
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
      isExpandQuery: true,
      isInitQuery: false,
    })
    await vi.waitFor(() => { expect(view.container.querySelector('[data-toy-crud-box]')).not.toBeNull() })
    await flush()
    const crud = crudOf(view.container)
    expect(crud.$props['conditions']).toEqual([{ key: 'city', op: 'EQ', value: '北京' }, { key: 'state', op: 'IN', value: ['在用', 3] }])
    expect(crud.$props['matchMode']).toBe('OR')
    expect(crud.$props['querySort']).toEqual({ desc: 'city' })
    expect(crud.$props['isExpandQuery']).toBe(true)
    expect(crud.$props['isInitQuery']).toBe(false)
    expect(crud.$props['selectMode']).toBeNull()
    // No first query was asked for, so nothing was searched and nothing counted.
    await flush()
    expect(seen.map(request => request.url).filter(url => url.includes('_search'))).toEqual([])
    expect(onAction).not.toHaveBeenCalledWith('query', expect.anything())
  })
})
