/**
 * Web e2e scenario: the view a deployment writes to edit one table — the
 * table's data page, the form page its add and modify buttons open, and the
 * info card its names open — worked through by the user, with what the three
 * blocks report reaching the model.
 *
 * Nothing else drives the three blocks together. The component-surface and
 * component-kit specs judge the view and draw each block on its own over a
 * stub backend; the tarball's own browser probe wires the three Vue parts by
 * hand. Here the wiring is the shipped one: the view is opened by the command
 * the console's sidebar runs, the form and the card are fed by the data page's
 * `editing` and `opened` outputs through the seat's bindings, the page and the
 * form ask the node half which entrances this visitor's rights allow, and every
 * report travels the command channel and lands in the next model request.
 *
 * What the page, the form and the card request goes browser → the shell's own
 * origin under the configured base path, and this scenario answers those
 * requests in the browser, standing in for the reverse proxy a real console has
 * in front of it. The backend it stands in for keeps the rows it is written: an
 * added record is in the next query, a deleted one is not. The node half's one
 * read, the visitor's rights behind the ability route, goes to a fake data
 * backend this scenario starts.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the overlay's rows through are created here.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: the session-event merge every report the seat sends travels as.
import type {} from '@deepseek-ai/dsh-commands/types'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishContext, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./component-surface-crud-view.overlay.yml', import.meta.url))
/** The hand-written model answer: a whole-script `ReplayEntry[]` override, one entry per model call, read in place of a session log. */
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-crud-view/replay.override.json', import.meta.url))

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-auth-gate', join(REPO_ROOT, 'packages/experimental/auth-gate')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const

/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

/** The stub login page's path, matching the `loginUrl` the overlay configures. */
const LOGIN_PATH = '/component-surface-crud-view-login/'

/** The base path the overlay configures the blocks to request under, and the deployment's API prefix the fake backend serves. */
const API_PREFIX = '/ini-server'

/** The table the view edits. */
const META = 'SpaceLayer'

/** The view's id in the overlay, which is what the sidebar's command takes. */
const VIEW_ID = 'layer-edit'

/** The path this deployment serves a table's own icon under, which the info card draws. */
const ICON_PREFIX = '/nrms-file/'

/** The one-by-one PNG served there, so the card's icon answers instead of logging a 404. */
const ICON = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

/** The signed-in person's rights, which the node half reads for the ability route. */
const RIGHTS_PATH = `${API_PREFIX}/nrms-auth/api/auth/userinfo`

/**
 * The rights row both the page's own access check and the ability route read:
 * this account may add, change and delete on the table, and may write its two
 * shown columns.
 *
 * The row is written the way this deployment's backend writes one, as
 * `.agents/notes/implemented/architecture/2026-09-24-console-rights-judged-once.md`
 * records of it: the generator writes `true` for a flag it grants and `null`
 * for one it does not, and it writes `null` for `search`, `imp`, `exp` and
 * `gridexp` on every account, administrators included. Only `add`, `update` and
 * `delete` are written, which is also all this deployment's backend enforces.
 *
 * The four never-written flags are stated rather than left out because both
 * readers walk the row: the node half's ability route reads every key through
 * `readBackendFlag`, which states a flag as a JSON boolean or as one of the
 * characters `'1'` and `'0'` and publishes anything else — a number, say — as
 * unstated, and the page's own load report reads the row the same way. The
 * `columns` list is what this account may write: the page narrows the modify
 * form's editable fields to it, so a row naming none leaves every field
 * disabled and the form unwritable.
 */
const RIGHTS_ROW = {
  resclassenname: META,
  add: true, update: true, delete: true,
  search: null, imp: null, exp: null, gridexp: null,
  columns: ['zh_label', 'belong_map_topic'],
}

/** Base64url, the way a JWT carries a segment. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** The one JWT the stub login page hands out; nothing verifies its signature. */
const TOKEN = [
  segment({ alg: 'none', typ: 'JWT' }),
  segment({ sub: 'e2e-visitor', exp: Math.floor(Date.now() / 1000) + 3600 }),
  'c2ln',
].join('.')

/** What this deployment's login page stores, and what every request presents: the header value, scheme included. */
const STORED_TOKEN = `Bearer ${TOKEN}`

/** One stored row of the table. */
interface LayerRow {
  int_id: string
  zh_label: string
  belong_map_topic: string
  layer_id: string
}

/**
 * One stored row, by its position in the table.
 * @param index - the row's position, from 0.
 * @returns the row.
 */
function layerRow(index: number): LayerRow {
  return {
    int_id: `11349336246502195${String(30 + index)}`,
    zh_label: `图层-${String(index + 1).padStart(2, '0')}`,
    belong_map_topic: index % 2 === 0 ? '公用专题' : '专项专题',
    layer_id: `element:layer_${String(index + 1)}`,
  }
}

/** Twenty-five rows, so the page draws two pages at its default twenty. */
const INITIAL_ROWS: readonly LayerRow[] = Array.from({ length: 25 }, (_unused, index) => layerRow(index))

/** Row A of the scenario: the first row of the first page. */
const ROW_A = layerRow(0)

/** The record the user adds through the form page. */
const ADDED_NAME = 'E2E-新图层'

/**
 * The table's columns, as the schema service writes them: two shown, one
 * hidden, so what the page reports is not simply the whole scheme.
 *
 * Each names `display_default`, the display component this deployment's own
 * schemes write for a plain column. It is also what makes the name column's
 * cells links: the vendored table draws `a.trans` only for a column whose
 * `relatedComponent` is `display_default` and whose attribute is `zh_label`,
 * and a view that switched the page's own card off (`regions.infoCard: false`)
 * needs those links — they are what raises the `info-card-open` the info card
 * block beside the page reads.
 */
const GRID_ITEMS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1', relatedComponent: 'display_default' },
  { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: '1', isSortable: '0', relatedComponent: 'display_default' },
  { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: '0', isSortable: '0', relatedComponent: 'display_default' },
]

/**
 * One scheme row of the three kinds the page and the form ask for, carrying the
 * smallest form and grid the page's own scheme check accepts.
 * @param schemaType - 1 for the query scheme, 2 for the add form, 3 for the modify form.
 * @returns the row.
 */
function schemeRow(schemaType: number): Record<string, unknown> {
  return {
    schemaType,
    isDefault: 1,
    schemaEnName: `${META}_${String(schemaType)}`,
    metaAlias: '图层',
    metaEnName: META,
    contentType: 'normal',
    form: [{
      formType: 'normal',
      labelWidth: '100px',
      formItems: [
        { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
        { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
      ],
    }],
    grid: { gridItems: GRID_ITEMS },
  }
}

/** One request a block made, as the stub answered it. */
interface Seen {
  method: string
  path: string
  authorization?: string
  body?: Record<string, unknown>
}

/** The rows the stub backend currently stores, and every request it answered. */
interface StubState {
  rows: LayerRow[]
  seen: Seen[]
  /** Paths the stub has no answer of its own for. */
  unknown: string[]
}

/**
 * Read a request body the page's request layer sent as JSON.
 * @param route - the intercepted request.
 * @returns the decoded body, or `undefined` where it carried none.
 */
function jsonBody(route: Route): Record<string, unknown> | undefined {
  const text = route.request().postData()
  if (text === null || text === '') return undefined
  return JSON.parse(text) as Record<string, unknown>
}

/** The `rawValue` records a delete request names, as the page's request layer sends them. */
function deletedIds(body: Record<string, unknown> | undefined): string[] {
  const list = Array.isArray(body?.['resObjList']) ? (body['resObjList'] as { rawValue?: { int_id?: unknown } }[]) : []
  return list.map(item => String(item.rawValue?.int_id))
}

/**
 * Answer one request of a block's own request layer the way the deployment's
 * backend does, and refuse one not presenting the visitor's token.
 * @param route - the intercepted request.
 * @param state - the stored rows, and where every answered request is recorded.
 */
async function answerBackend(route: Route, state: StubState): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname
  const method = request.method()
  const authorization = request.headers()['authorization']
  const body = method === 'GET' ? undefined : jsonBody(route)
  state.seen.push({ method, path, ...authorization === undefined ? {} : { authorization }, ...body === undefined ? {} : { body } })
  const answer = (document: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(document) })
  if (authorization !== STORED_TOKEN) {
    await answer({ code: 3, msg: 'token invalid' }, 401)
    return
  }
  if (method === 'GET' && path.endsWith('/nrms-auth/api/auth/userinfo')) {
    await answer({ code: 0, data: { useraccount: 'e2e-visitor', username: '访客', auth: { resclass: [RIGHTS_ROW] } } })
    return
  }
  if (method === 'GET' && path.endsWith('/nrms-schema-manage/api/schema/schema')) {
    // A page opened for a view names no scheme: it asks with `schemaType` empty
    // and takes the default of each kind out of what comes back, so an empty
    // value is every kind rather than none.
    const wanted = url.searchParams.get('schemaType') ?? ''
    const rows = [schemeRow(1), schemeRow(2), schemeRow(3)]
    await answer({ code: 0, data: wanted === '' ? rows : rows.filter(row => String(row['schemaType']) === wanted) })
    return
  }
  if (method === 'GET' && path.endsWith(`/nrms-schema-manage/api/meta/resclass/${META}`)) {
    await answer({ code: 0, data: {
      metaEnName: META,
      metaAlias: '图层',
      resClassEnName: META,
      resClassCnName: '图层',
      attrs: GRID_ITEMS.map(item => ({ relatedMetaAttr: item.relatedMetaAttr, alias: item.alias, dataType: 'string' })),
      attributes: GRID_ITEMS.map(item => ({ attributeEnName: item.relatedMetaAttr, attributeCnName: item.alias, isNull: item.isShow === '0' })),
    } })
    return
  }
  if (method === 'POST' && path.endsWith(`/nrms-datamanagement/api/resources/${META}/_search`)) {
    // The card reads its one record through the same search, by `int_id`.
    const conditions = Array.isArray(body?.['conditions']) ? (body['conditions'] as { key?: unknown; op?: unknown; value?: unknown }[]) : []
    const byId = conditions.find(condition => condition.key === 'int_id' && condition.op === 'EQ')
    const matched = byId === undefined ? state.rows : state.rows.filter(row => row.int_id === String(byId.value))
    const asked = (body?.['page'] ?? {}) as { currentPage?: number; pageSize?: number }
    const currentPage = asked.currentPage ?? 1
    const pageSize = asked.pageSize ?? 20
    const slice = matched.slice((currentPage - 1) * pageSize, currentPage * pageSize)
    await answer({ code: 0, data: {
      rawValue: slice, displayValue: slice, ref: slice.map(() => ({})), page: { total: matched.length, currentPage, pageSize },
    } })
    return
  }
  if (method === 'POST' && path.endsWith(`/nrms-datamanagement/api/batchresources/delete/${META}`)) {
    const ids = deletedIds(body)
    state.rows = state.rows.filter(row => !ids.includes(row.int_id))
    const list = Array.isArray(body?.['resObjList']) ? (body['resObjList'] as unknown[]) : []
    await answer({ code: 0, data: { resObjList: list, globalFailedInfo: null } })
    return
  }
  if ((method === 'POST' || method === 'PUT') && new RegExp(`/nrms-datamanagement/api/resources/${META}(/[^/]+)?$`).test(path)) {
    const written = (body?.['rawValue'] ?? {}) as Partial<LayerRow>
    if (method === 'POST') {
      const row: LayerRow = {
        int_id: `11349336246502196${String(10 + state.rows.length)}`,
        zh_label: written.zh_label ?? '',
        belong_map_topic: written.belong_map_topic ?? '',
        layer_id: '',
      }
      state.rows = [...state.rows, row]
      await answer({ code: 0, data: row })
      return
    }
    await answer({ code: 0, data: written })
    return
  }
  if (method === 'POST' && path.includes('/nrms-resourcehistory/api/log/frontevent')) {
    await answer({ code: 0, data: null })
    return
  }
  state.unknown.push(`${method} ${path}`)
  await answer({ code: 0, data: null })
}

/** The fake data backend the node half reads the visitor's rights from, and what it saw. */
interface FakeBackend {
  origin: string
  /** Every request it answered, as method and path. */
  seen: string[]
  close(): Promise<void>
}

/**
 * Start the fake data backend under the deployment's API prefix. It answers
 * the rights read and nothing else, and refuses a request not presenting the
 * visitor's token in both headers.
 * @returns the running fake.
 */
async function startBackend(): Promise<FakeBackend> {
  const seen: string[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    seen.push(`${req.method ?? ''} ${path}`)
    const answer = (document: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(document))
    }
    if (req.headers.authorization !== STORED_TOKEN || req.headers.certificationtoken !== STORED_TOKEN) {
      answer({ code: 3, msg: 'token invalid' }, 401)
      return
    }
    if (req.method === 'GET' && path === RIGHTS_PATH) {
      answer({ code: 0, msg: 'success', data: { auth: { resclass: [RIGHTS_ROW] } } })
      return
    }
    answer({ code: 1, msg: 'no such endpoint' }, 404)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/**
 * The stub login page, which signs the visitor in the way this deployment's own
 * page does: it stores the header value and returns where it was sent from.
 * @returns the page source.
 */
function loginPage(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>stub login</title></head>
<body><h1 id="stub-login">stub login</h1>
<script>
  var hash = location.hash;
  var back = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('redirect');
  localStorage.setItem('accessToken', ${JSON.stringify(STORED_TOKEN)});
  location.href = back;
</script></body></html>`
}

/**
 * Prepare a harness home whose profile fallback resolves every overlay row.
 * @returns the harness home.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-crud-view-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [name, dir] of ROWS) {
    await symlink(dir, join(scope, name.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * The live composer of the open session — a contenteditable surface, which is
 * why it is addressed by its own attribute rather than as a form control.
 * @param page - the page under test.
 * @returns the composer input locator.
 */
function composerInput(page: Page): Locator {
  return page.locator('[data-composer-input]').first()
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')
/** The data page block. */
const pageBlock = (page: Page): Locator => seat(page).locator('[data-component-block="toy.data-page"]')
/** The form page block. */
const formBlock = (page: Page): Locator => seat(page).locator('[data-component-block="toy.form-page"]')
/** The info card block. */
const cardBlock = (page: Page): Locator => seat(page).locator('[data-component-block="toy.info-card"]')

/**
 * The first row of the page's right-hand fixed column, which is where element-ui
 * draws the clickable copy of a row's operation icons.
 * @param page - the page under test.
 * @returns the row.
 */
function firstOperationRow(page: Page): Locator {
  return pageBlock(page).locator('.el-table__fixed-right .el-table__body tbody tr').first()
}

/**
 * The name link of the first row, in the left-hand fixed column that carries
 * the name column's clickable copy.
 * @param page - the page under test.
 * @returns the link.
 */
function firstNameLink(page: Page): Locator {
  return pageBlock(page).locator('.el-table__fixed .el-table__body a.trans').first()
}

/**
 * The form page's input for one field, found by its label.
 * @param page - the page under test.
 * @param label - the field's label as the scheme writes it.
 * @returns the text input.
 */
function formInput(page: Page, label: string): Locator {
  const item = formBlock(page).locator('.toy-form-page .el-form-item', {
    has: page.locator('.el-form-item__label', { hasText: new RegExp(`^\\s*${label}\\s*$`) }),
  })
  return item.locator('input').first()
}

/** The model's one answer, which it can only write from the notices the three blocks left in its request. */
const PROMPT = 'What happened on the layer table?'
const REPLY_ADDED = `Added ${ADDED_NAME}.`
const REPLY_CARD = 'block "card" no longer shows a record.'
const REPLY_DELETED = 'Deleted 1 record.'

describe.skipIf(MODE === 'record')('web e2e: a written-down view editing one table, its three blocks wired by the seat', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let backend: FakeBackend
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const sessionEvents: SessionEvent[] = []
  const stub: StubState = { rows: [...INITIAL_ROWS], seen: [], unknown: [] }

  beforeAll(async () => {
    backend = await startBackend()
    // Read by the overlay's `!!js` expression when the loader composes the row,
    // which happens inside this process during the launch below.
    process.env.DSH_E2E_BIZ_UPSTREAM = `${backend.origin}${API_PREFIX}/`
    harnessHome = await harnessHomeWithRowLinks()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY, replayOverride: REPLAY })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })

    browser = await chromium.launch()
    const context = await newEnglishContext(browser, 1100)
    page = await context.newPage()
    // Served into the shell's own origin: only a same-origin page can leave the
    // token where the gate's browser half and the blocks' request layer read it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage() }))
    await page.route(url => url.pathname.startsWith(`${API_PREFIX}/`), route => answerBackend(route, stub))
    // The info card draws this deployment's icon for the table it shows, from
    // the path that icon is served under rather than from the API prefix, so a
    // real console answers it and this one has to as well: an unanswered image
    // is a 404 the browser logs as a console error.
    await page.route(url => url.pathname.startsWith(ICON_PREFIX), route =>
      route.fulfill({ status: 200, contentType: 'image/png', body: ICON }))
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    // The first load finds no token and leaves for the login page, which stores
    // one and comes back; the shell then mirrors it and reloads once more.
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    // Signing in navigates away twice, and every request in flight when a
    // document goes away is reported as a console error by the browser. What
    // has to be clean is the signed-in session the tests below drive.
    consoleErrors.length = 0
    tripwire.pageErrors.length = 0
    tripwire.warnings.length = 0
  }, 180_000)

  afterAll(async () => {
    Reflect.deleteProperty(process.env, 'DSH_E2E_BIZ_UPSTREAM')
    await browser?.close()
    await scaffold?.close()
    await backend?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  /**
   * How many times one block has reported one action so far, counted on the
   * durable command records the seat's reports travel as.
   * @param componentId - the reporting block's component.
   * @param actionId - the action.
   * @returns the count.
   */
  function reported(componentId: string, actionId: string): number {
    return sessionEvents.filter(event => event.type === 'command/run'
      && event.data.args?.includes(`"componentId":"${componentId}"`) === true
      && event.data.args.includes(`"actionId":"${actionId}"`)).length
  }

  /** The searches the page and the card have made so far. */
  function searches(): Seen[] {
    return stub.seen.filter(request => request.method === 'POST' && request.path.endsWith(`/resources/${META}/_search`))
  }

  /** The writes the blocks have made so far: adds, edits and deletes. */
  function writes(): Seen[] {
    return stub.seen.filter(request => (request.method === 'POST' || request.method === 'PUT')
      && /\/(batch)?resources\//.test(request.path) && !request.path.endsWith('/_search'))
  }

  it('opens the view by the sidebar\'s command, drawing the page writable and the form and the card waiting', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-open'))
    const input = composerInput(page)
    await input.waitFor({ timeout: 30_000 })
    await writeComposerDraft(page, input, `/show-content-view ${VIEW_ID}`)
    const suggestions = page.getByRole('listbox')
    if (await suggestions.count() > 0) {
      await input.press('Escape')
      await expect.poll(() => suggestions.count()).toBe(0)
    }
    await input.press('Enter')

    await pageBlock(page).waitFor({ timeout: 60_000 })
    await expect.poll(
      async () => await pageBlock(page).locator('.el-table__body-wrapper tbody tr').count(),
      { timeout: 30_000 },
    ).toBe(20)
    await formBlock(page).locator('[data-form-page-idle]').waitFor({ timeout: 30_000 })
    await cardBlock(page).locator('[data-info-card-idle]').waitFor({ timeout: 30_000 })
    // The add button is drawn only once the ability route has answered that
    // this visitor may add: the page and the form fail closed until then.
    await pageBlock(page).locator('.crud-action button', { hasText: '新增' }).waitFor({ timeout: 30_000 })
    expect(backend.seen).toContain(`GET ${RIGHTS_PATH}`)
    expect(writes()).toEqual([])
    for (const request of stub.seen) expect(request.authorization).toBe(STORED_TOKEN)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-view-open.png'), fullPage: true })
  }, 180_000)

  it('adds a record in the form page, and the data page draws it without being asked to query', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-add'))
    await pageBlock(page).locator('.crud-action button', { hasText: '新增' }).click()
    const name = formInput(page, '名称')
    await name.waitFor({ timeout: 30_000 })
    expect(await name.inputValue()).toBe('')
    await name.fill(ADDED_NAME)
    const searchesBefore = searches().length
    await formBlock(page).locator('.toy-form-page .dialog-footer .el-button--primary').click()

    await expect.poll(() => writes().length, { timeout: 30_000 }).toBe(1)
    const added = writes()[0]
    expect(added?.method).toBe('POST')
    expect((added?.body?.['rawValue'] as Partial<LayerRow> | undefined)?.zh_label).toBe(ADDED_NAME)
    await expect.poll(() => reported('toy.form-page', 'added'), { timeout: 30_000 }).toBe(1)
    // The kit's own save notice makes the page query again; nobody pressed 查询.
    await expect.poll(() => searches().length > searchesBefore, { timeout: 30_000 }).toBe(true)
    await expect.poll(
      async () => await pageBlock(page).locator('.el-pagination__total').innerText(),
      { timeout: 30_000 },
    ).toContain(String(INITIAL_ROWS.length + 1))
    expect(reported('toy.data-page', 'added')).toBe(0)
  }, 120_000)

  it('keeps the form on A when A is modified, the edit is cancelled, and A is modified again', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-modify'))
    await firstOperationRow(page).locator('.operation-modify').click()
    const name = formInput(page, '名称')
    await expect.poll(async () => await name.inputValue(), { timeout: 30_000 }).toBe(ROW_A.zh_label)

    await name.fill('改了一半')
    expect(await name.inputValue()).toBe('改了一半')
    await formBlock(page).locator('.toy-form-page .dialog-footer button', { hasText: '取 消' }).click()
    await expect.poll(async () => await formInput(page, '名称').inputValue(), { timeout: 30_000 }).toBe(ROW_A.zh_label)

    await firstOperationRow(page).locator('.operation-modify').click()
    // The same row published again: the form stays on A rather than emptying or reloading.
    await page.waitForTimeout(1500)
    expect(await formInput(page, '名称').inputValue()).toBe(ROW_A.zh_label)
    expect(writes()).toHaveLength(1)
    expect(reported('toy.form-page', 'modified')).toBe(0)
  }, 120_000)

  it('shows A on the card when A\'s name is clicked, and reports it once when it is clicked again', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-card'))
    await firstNameLink(page).click()
    const card = cardBlock(page).locator('.small-card')
    await card.waitFor({ timeout: 30_000 })
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain(ROW_A.zh_label)
    await expect.poll(() => reported('toy.info-card', 'card-open'), { timeout: 30_000 }).toBe(1)

    await firstNameLink(page).click()
    await page.waitForTimeout(1500)
    expect(await card.innerText()).toContain(ROW_A.zh_label)
    expect(reported('toy.info-card', 'card-open')).toBe(1)
    // One source: the page draws no card of its own, so it reports none.
    expect(reported('toy.data-page', 'card-open')).toBe(0)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-view-card.png'), fullPage: true })
  }, 120_000)

  it('keeps the card through a query, and empties it on a page turn, reported by the card block alone', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-page-turn'))
    const searchesBefore = searches().length
    await pageBlock(page).locator('button.query-btn').click()
    await expect.poll(() => searches().length > searchesBefore, { timeout: 30_000 }).toBe(true)
    await page.waitForTimeout(1000)
    expect(await cardBlock(page).locator('.small-card').innerText()).toContain(ROW_A.zh_label)
    expect(reported('toy.info-card', 'card-close')).toBe(0)

    await pageBlock(page).locator('.el-pager li', { hasText: /^2$/ }).click()
    await cardBlock(page).locator('[data-info-card-idle]').waitFor({ timeout: 30_000 })
    await expect.poll(() => reported('toy.info-card', 'card-close'), { timeout: 30_000 }).toBe(1)
    expect(reported('toy.data-page', 'card-close')).toBe(0)
  }, 120_000)

  it('empties the form and the card when the record both of them show is deleted', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-delete'))
    await pageBlock(page).locator('.el-pager li', { hasText: /^1$/ }).click()
    await expect.poll(async () => await firstNameLink(page).innerText(), { timeout: 30_000 }).toBe(ROW_A.zh_label)
    await firstNameLink(page).click()
    await expect.poll(async () => await cardBlock(page).locator('.small-card').innerText(), { timeout: 30_000 })
      .toContain(ROW_A.zh_label)
    await firstOperationRow(page).locator('.operation-modify').click()
    await expect.poll(async () => await formInput(page, '名称').inputValue(), { timeout: 30_000 }).toBe(ROW_A.zh_label)

    await firstOperationRow(page).locator('.operation-delete').click()
    await page.locator('.el-popover:visible .el-button--primary').click()
    await expect.poll(() => writes().length, { timeout: 30_000 }).toBe(2)
    expect(deletedIds(writes()[1]?.body)).toEqual([ROW_A.int_id])
    await expect.poll(() => reported('toy.data-page', 'deleted'), { timeout: 30_000 }).toBe(1)
    // The page withdrew both outputs naming A, so both blocks are back to waiting.
    await formBlock(page).locator('[data-form-page-idle]').waitFor({ timeout: 30_000 })
    await cardBlock(page).locator('[data-info-card-idle]').waitFor({ timeout: 30_000 })
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-view-deleted.png'), fullPage: true })
  }, 120_000)

  it('tells the model what was added, what the card stopped showing, and what was deleted, with the user\'s next message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-view-reply'))
    // The scripted reply is not a fixed string: llm-replay resolves each of its
    // placeholders against the live request and fails the turn where one
    // matches nothing, so the sentence below can only be produced at all if the
    // three notices were in that request.
    const input = composerInput(page)
    await writeComposerDraft(page, input, PROMPT)
    await page.keyboard.press('Enter')
    for (const sentence of [REPLY_ADDED, REPLY_CARD, REPLY_DELETED]) {
      await expect.poll(async () => await page.getByText(sentence, { exact: false }).count(), { timeout: 60_000 })
        .toBeGreaterThan(0)
    }
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-view-reply.png'), fullPage: true })
  }, 180_000)

  it('leaves the console clean and asks the stub backend nothing it has no answer for', () => {
    expect(stub.unknown).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
