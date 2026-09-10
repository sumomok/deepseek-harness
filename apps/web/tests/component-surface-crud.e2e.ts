/**
 * Web e2e scenario: a `show_component` call that opens the deployment's own
 * full data page for one table, from the question the user is asked to the
 * cell that user clicks reaching the model.
 *
 * Everything on this path exists in exactly one place, and this is the only
 * lane where all of them are the shipped ones at once: the gate that signs the
 * visitor in, the approval panel the question is drawn in, the seat that
 * mounts the vendored page inside its contained box, the page's own request
 * layer spending the visitor's token from the browser, and the return channel
 * a click leaves through. The snapshot lane covers what a model sees of it —
 * the offer, the question, and the result line — but it drives ACP, which has
 * neither an approval surface a person answers, nor a browser that could load
 * the page, nor a command method a click could arrive through.
 *
 * The host reads nothing for this kind. What the page requests goes browser →
 * the shell's own origin under the configured base path, and this scenario
 * answers those requests in the browser itself, standing in for the reverse
 * proxy a real console has in front of it. What it checks of each is that it
 * carried the token the stub login page stored, and that not one of them was
 * made before the person whose token it is had answered.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the overlay's rows through are created here.
 */

import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type import: the session-event merge this scenario reads a press's record by type through.
import type {} from '@deepseek-ai/dsh-user-approval'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishContext, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./component-surface-crud.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-crud/session.jsonl', import.meta.url))

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

/**
 * The live composer of the open session — a contenteditable surface, which is
 * why it is addressed by its own attribute rather than as a form control.
 * @param page - the page under test.
 * @returns the composer input locator.
 */
function composerInput(page: Page): Locator {
  return page.locator('[data-composer-input]').first()
}

/** The stub login page's path, matching the `loginUrl` the overlay configures. */
const LOGIN_PATH = '/component-surface-crud-login/'

/** The base path the overlay configures the page to request under, on the shell's own origin. */
const API_PREFIX = '/ini-server'

/** The table the page is opened on. */
const META = 'SpaceLayer'

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

/** What this deployment's login page stores, and what the page's request layer presents: the header value, scheme included. */
const STORED_TOKEN = `Bearer ${TOKEN}`

/** The three rows the stub backend answers every query with, as the deployment displays them. */
const ROWS_SHOWN = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas_transport_vehicle_info', belong_map_topic: '公用专题' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', layer_id: 'element:gas_pipeline', belong_map_topic: '公用专题' },
  { int_id: '1134933624650219532', zh_label: '调压站', layer_id: 'element:gas_station', belong_map_topic: '专项专题' },
]

/**
 * The table's stored query scheme, as the schema service writes one: two
 * columns shown, one hidden, so what the page draws is not simply the whole
 * scheme — and what it reports to the model is the shown two.
 */
const GRID_ITEMS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1' },
  { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: '1', isSortable: '0' },
  { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: '0', isSortable: '0' },
]

/** The headers the page draws: the selection column, then the scheme's two shown columns. */
const HEADERS = ['', '名称', '所属地图主题']

/**
 * One scheme row of the three kinds the page asks for, carrying the smallest
 * form and grid the page's own scheme check accepts.
 * @param schemaType - 1 for the query scheme, 2 and 3 for the write schemes the page never opens.
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

/**
 * The approval card this scenario reads back word for word, as the panel draws
 * it: the reason is written with the identifier on a line of its own, and the
 * panel draws that break, so the identifier stands on a line of its own beneath
 * the sentence, at the same size as the sentence rather than smaller.
 * Read out of `innerText`, which is the rendered text rather than the
 * written one — a panel that collapsed the break would answer with a space here
 * and fail. Asserting the whole of it in one string is what pins the table's
 * own name to the sentence it belongs to rather than to somewhere else on the
 * panel, and what would catch the written form and the drawn form changing
 * apart.
 */
const CARD = '用您的账号打开「图层配置」的完整数据页，可以在里面查询、翻页、排序；'
  + '小助手看不到表里的内容，只会知道有哪些列、每次查到多少条，以及您点到的那一行。'
  + `\n数据表：${META}`

/** What the result line tells the model once the page has reported its columns. */
const RESULT_COLUMNS = 'it has loaded and shows 2 columns: 名称 (zh_label), 所属地图主题 (belong_map_topic)'

/** The prompt that opens the page, and the word the scripted turn ends on. */
const PROMPT = 'Open the deployment\'s own 图层配置 data page.'
const OPENED_REPLY = 'OPENED'

/** The prompt that carries the click to the model, and the sentence the model can only write from the notice. */
const CLICK_PROMPT = 'Which one did I click?'
const CLICK_REPLY = `You clicked ${ROWS_SHOWN[0]?.zh_label ?? ''} — noted.`

/** One request the page made, as the stub answered it. */
interface Seen {
  method: string
  path: string
  authorization?: string
}

/**
 * Answer one request of the page's own request layer the way the deployment's
 * backend does, and refuse one not presenting the visitor's token — which is
 * what makes the token assertion an outcome rather than an inspection: a page
 * sending the bare JWT, or nothing, draws no rows at all.
 * @param route - the intercepted request.
 * @param seen - where every answered request is recorded.
 */
async function answerBackend(route: Route, seen: Seen[]): Promise<void> {
  const request = route.request()
  const path = new URL(request.url()).pathname
  const authorization = request.headers()['authorization']
  seen.push({ method: request.method(), path, ...authorization === undefined ? {} : { authorization } })
  const answer = (document: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(document) })
  if (authorization !== STORED_TOKEN) {
    await answer({ code: 3, msg: 'token invalid' }, 401)
    return
  }
  if (request.method() === 'GET' && path.endsWith('/nrms-auth/api/auth/userinfo')) {
    await answer({ code: 0, data: { useraccount: 'e2e-visitor', username: '访客', auth: { resclass: [
      {
        resclassenname: META, search: 1, add: 1, update: 1, delete: 1, imp: 1, exp: 1,
        gridexp: 1, searchSetting: 1, advSearch: 1, showAsPass: 0, columns: [],
      },
    ] } } })
    return
  }
  if (request.method() === 'GET' && path.endsWith('/nrms-schema-manage/api/schema/schema')) {
    await answer({ code: 0, data: [schemeRow(1), schemeRow(2), schemeRow(3)] })
    return
  }
  if (request.method() === 'GET' && path.endsWith(`/nrms-schema-manage/api/meta/resclass/${META}`)) {
    await answer({ code: 0, data: { metaEnName: META, metaAlias: '图层', attrs: [
      { relatedMetaAttr: 'zh_label', alias: '名称', dataType: 'string' },
      { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', dataType: 'string' },
      { relatedMetaAttr: 'layer_id', alias: '图层id', dataType: 'string' },
    ] } })
    return
  }
  if (request.method() === 'POST' && path.endsWith(`/nrms-datamanagement/api/resources/${META}/_search`)) {
    const page = { total: ROWS_SHOWN.length, currentPage: 1, pageSize: 20 }
    await answer({ code: 0, data: { rawValue: ROWS_SHOWN, displayValue: ROWS_SHOWN, ref: [], page } })
    return
  }
  if (request.method() === 'POST' && path.includes('/nrms-resourcehistory/api/log/frontevent')) {
    await answer({ code: 0, data: null })
    return
  }
  await answer({ code: 1, msg: 'no such endpoint' }, 404)
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
 * Installed before any page script runs: records every progress bar and
 * loading overlay the page's request layer inserts anywhere in the document,
 * and whether it landed inside a contained box. The two ids are the request
 * layer's own; nothing else on the page uses them.
 *
 * The observed node is `document` rather than `document.documentElement`,
 * which is null at the moment an init script runs — observing it would throw
 * there, leaving an empty record that reads as containment holding.
 */
const WATCH_CONTAINMENT = `
  window.__crudNodes = [];
  new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i += 1) {
      var added = records[i].addedNodes;
      for (var j = 0; j < added.length; j += 1) {
        var node = added[j];
        if (node.nodeType !== 1) continue;
        if (node.id !== 'nprogress' && node.id !== 'is-loading-full-overlay') continue;
        window.__crudNodes.push({ id: node.id, inBox: node.closest('[data-toy-crud-box]') !== null });
      }
    }
  }).observe(document, { childList: true, subtree: true });
`

/** What the containment watch recorded. */
interface WatchedNode {
  id: string
  inBox: boolean
}

/**
 * Prepare a harness home whose profile fallback resolves every overlay row.
 * @returns the harness home.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-crud-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [name, dir] of ROWS) {
    await symlink(dir, join(scope, name.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')

describe.skipIf(MODE === 'record')('web e2e: a call that opens the deployment\'s own data page', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const sessionEvents: SessionEvent[] = []
  const seen: Seen[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })

    browser = await chromium.launch()
    const context = await newEnglishContext(browser)
    page = await context.newPage()
    await page.addInitScript(WATCH_CONTAINMENT)
    // Served into the shell's own origin: only a same-origin page can leave the
    // token where the gate's browser half and the page's request layer read it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage() }))
    // The deployment's backend, under the base path the overlay configures and
    // on the shell's own origin — where a reverse proxy would answer.
    await page.route(url => url.pathname.startsWith(`${API_PREFIX}/`), route => answerBackend(route, seen))
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
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  /** Every event this run's session has committed, in order. */
  function liveEvents(): readonly SessionEvent[] {
    return sessionEvents
  }

  it('asks the user before the page requests anything, then draws the page inside its own box', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud'))
    const input = composerInput(page)
    await input.waitFor({ timeout: 30_000 })
    await writeComposerDraft(page, input, PROMPT)
    await page.keyboard.press('Enter')

    // The approval panel takes the composer over while the tool waits, and it
    // is a stable waiting state, so waiting for it is race-free.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    const asked = await panel.innerText()
    expect(asked).toContain(CARD)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-card.png'), fullPage: true })

    // Nothing has been requested yet: the page is not on screen, and the host
    // reads nothing for this kind at all.
    expect(seen).toEqual([])
    expect(await seat(page).locator('[data-component-block="toy.crud"]').count()).toBe(0)

    await panel.getByRole('button', { name: 'Allow once' }).click()

    const block = seat(page).locator('[data-component-block="toy.crud"]')
    await block.waitFor({ timeout: 60_000 })
    const box = block.locator('[data-toy-crud-box]')
    await box.waitFor({ timeout: 30_000 })
    // element-ui's own body wrapper, so reading the rows out of it is the
    // assertion that the vendored page drew the backend's rows.
    await expect.poll(
      async () => await block.locator('.el-table__body-wrapper tbody tr').count(),
      { timeout: 30_000 },
    ).toBe(ROWS_SHOWN.length)
    for (const row of ROWS_SHOWN) {
      expect(await block.getByText(row.zh_label, { exact: true }).count()).toBeGreaterThan(0)
    }
    // The headers are the scheme's, hidden column left out, behind the
    // selection column the call asked for.
    await expect.poll(
      async () => await block.locator('.el-table__header-wrapper th .cell').allTextContents(),
      { timeout: 15_000 },
    ).toEqual(HEADERS)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-page.png'), fullPage: true })

    // Read-only: no write button and no dialog. Every button in the box is
    // listed, icon-only ones included — the query panel's two, and the pager's
    // two arrows — so a new button carrying an icon and no text cannot pass as
    // nothing.
    const drawn = await block.locator('button').evaluateAll(nodes =>
      nodes.map(node => ({ text: node.textContent?.trim() ?? '', cls: node.getAttribute('class') ?? '' })))
    expect(drawn).toEqual([
      { text: '查询', cls: 'el-button query-btn el-button--default el-button--small' },
      { text: '清空', cls: 'el-button el-button--default el-button--small' },
      { text: '', cls: 'btn-prev' },
      { text: '', cls: 'btn-next' },
    ])
    expect(await block.locator('.el-dialog').count()).toBe(0)

    // Every request went under the configured base path with the visitor's
    // own token, and the page's whole mount is in the list.
    expect(seen.length).toBeGreaterThan(0)
    for (const request of seen) {
      expect(request.path.startsWith(`${API_PREFIX}/`)).toBe(true)
      expect(request.authorization).toBe(STORED_TOKEN)
    }
    expect(seen.map(request => `${request.method} ${request.path}`)).toEqual(expect.arrayContaining([
      `GET ${API_PREFIX}/nrms-auth/api/auth/userinfo`,
      `GET ${API_PREFIX}/nrms-schema-manage/api/schema/schema`,
      `POST ${API_PREFIX}/nrms-datamanagement/api/resources/${META}/_search`,
    ]))

    // The request layer's progress bar and overlay were seen, and every one of
    // them landed inside the box rather than on the document.
    const watched = await page.evaluate(() => (window as unknown as { __crudNodes: WatchedNode[] }).__crudNodes)
    expect(watched.map(node => node.id)).toContain('nprogress')
    expect(watched.filter(node => !node.inBox)).toEqual([])

    // The call's result line carries the columns the page reported, once the
    // scripted turn has ended on the word that follows the tool result.
    await expect.poll(async () => await page.getByText(OPENED_REPLY, { exact: true }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    const results = liveEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(JSON.stringify(results[0])).toContain(RESULT_COLUMNS)

    // And the record the column replays from carries the spec the user agreed
    // to, nothing fetched, and no credential. Compared as a string: the merge
    // that declares this event lives in an experimental package, which
    // `apps/web` may not depend on, so this program does not know the type.
    const resolved = liveEvents().filter(event => (event.type as string) === 'content-component/resolved')
    expect(resolved).toHaveLength(1)
    const recorded = JSON.stringify(resolved[0])
    expect(recorded).toContain('"fetched":[]')
    expect(recorded).toContain(`"relatedMeta":"${META}"`)
    expect(recorded).not.toContain(TOKEN)
    expect(recorded).not.toContain('Bearer')
  }, 180_000)

  it('carries the cell the user clicks to the model with their next message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-crud-click'))
    const block = seat(page).locator('[data-component-block="toy.crud"]')
    // The name column is fixed, so element-ui draws it twice; the topic column
    // is drawn once, in the body that takes a click.
    await block.locator('.el-table__body-wrapper tbody tr').first().locator('td').nth(2).click()
    await expect.poll(
      () => liveEvents().filter(event => event.type === 'command/run'
        && event.data.args?.includes('"actionId":"cell-click"') === true).length,
      { timeout: 30_000 },
    ).toBe(1)

    // The scripted reply is not a fixed string: llm-replay resolves its head
    // against the live request, so the sentence below can only be produced at
    // all if the notice naming the clicked row was in that request.
    const input = composerInput(page)
    await writeComposerDraft(page, input, CLICK_PROMPT)
    await page.keyboard.press('Enter')
    await expect.poll(async () => await page.getByText(CLICK_REPLY, { exact: false }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-crud-click.png'), fullPage: true })
  }, 180_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
