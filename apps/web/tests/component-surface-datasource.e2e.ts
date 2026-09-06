/**
 * Web e2e scenario: a `show_component` call that reads its own rows out of the
 * deployment's data backend, from the question the user is asked to the row
 * that user ticks reaching the model.
 *
 * Everything on this path exists in exactly one place, and this is the only
 * lane where all of them are the shipped ones at once: the gate holding a
 * visitor's access token, the two requests that token is spent on, the approval
 * panel the question is drawn in, the seat that draws the rows, and the return
 * channel a tick leaves through. The snapshot lane covers what a model sees of
 * it — the parameter, the question, and the result line — but it drives ACP,
 * which has neither an approval surface a person answers nor a command method a
 * tick could arrive through.
 *
 * The credential is real in the only sense that matters here: the stub login
 * page below stores it the way this deployment's own login page does, and the
 * gate's browser half posts it to the node half unchanged. What the fake data
 * backend then checks is that both headers carried `Bearer <token>` — the
 * deployment's own two-header reading — so the bytes this scenario puts on the
 * wire are the bytes a real backend would receive.
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
import type { Browser, ConsoleMessage, Locator, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports: the two session-event merges this scenario reads by type.
import type {} from '@deepseek-ai/dsh-user-approval'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishContext, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./component-surface-datasource.overlay.yml', import.meta.url))
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-datasource/session.jsonl', import.meta.url))

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
 * why it is addressed by its own attribute rather than as a form control. The
 * placeholder is deliberately not part of it: the same surface reads one way on
 * a blank draft and another once the conversation has a turn in it.
 * @param page - the page under test.
 * @returns the composer input locator.
 */
function composerInput(page: Page): Locator {
  return page.locator('[data-composer-input]').first()
}

/** The stub login page's path, matching the `loginUrl` the overlay configures. */
const LOGIN_PATH = '/component-surface-datasource-login/'

/** The deployment's API prefix, which the fake backend serves under and the read must keep. */
const API_PREFIX = '/ini-server'

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

/** What this deployment's login page stores: the header value, scheme included. */
const STORED_TOKEN = `Bearer ${TOKEN}`

/** The three rows the fake backend answers with, as it stores them. */
const RAW_ROWS = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas_transport_vehicle_info', belong_map_topic: '947543009150173184' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', layer_id: 'element:gas_pipeline', belong_map_topic: '947543009150173184' },
  { int_id: '1134933624650219532', zh_label: '调压站', layer_id: 'element:gas_station', belong_map_topic: '947543009150173185' },
]

/** The same three rows as it displays them. */
const DISPLAY_ROWS = RAW_ROWS.map((row, index) => ({
  ...row,
  belong_map_topic: index === 2 ? '专项专题' : '公用专题',
}))

/** The attribute dictionary, which is also where the two unwritten headers come from. */
const ATTRIBUTES = [
  { attributeEnName: 'int_id', attributeCnName: '唯一标识' },
  { attributeEnName: 'zh_label', attributeCnName: '名称' },
  { attributeEnName: 'layer_id', attributeCnName: '图层id' },
  { attributeEnName: 'belong_map_topic', attributeCnName: '所属地图主题' },
]

/** The two sentences of the approval card this scenario reads back word for word. */
const CARD_PROMISE = '您在表里勾选的行，会作为您的选择告诉小助手'
const CARD_META = '数据表：SpaceLayer'
const CARD_OPENING = '用您的账号查一份数据：从「图层配置」里取最多 200 条'

/** The prompt that opens the reading turn, and the one that carries the tick to the model. */
const PROMPT = 'Show me the deployment\'s 图层配置 table.'
const TICK_PROMPT = 'Go ahead with that one.'

/** The words the ticked row earns, once the user's next message carries the inbox to the model. */
const TICK_REPLY = `Starting with ${DISPLAY_ROWS[0]?.zh_label ?? ''} — I will export those rows.`

/** The fake data backend, and what it saw. */
interface FakeBackend {
  origin: string
  /** Every request it answered, as method, path, and the two credential headers. */
  seen: { method: string; path: string; authorization?: string; certificationToken?: string }[]
  close(): Promise<void>
}

/**
 * Start the fake data backend under the deployment's API prefix.
 *
 * It refuses anything not presenting the visitor's token in both headers, which
 * is what makes the header assertion an outcome rather than an inspection: a
 * gate sending one header, or the bare JWT, draws no rows at all.
 * @returns the running fake.
 */
async function startBackend(): Promise<FakeBackend> {
  const seen: FakeBackend['seen'] = []
  const presented = `Bearer ${TOKEN}`
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    seen.push({
      method: req.method ?? '',
      path,
      ...req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization },
      ...typeof req.headers.certificationtoken === 'string' ? { certificationToken: req.headers.certificationtoken } : {},
    })
    req.resume()
    const answer = (body: unknown, status = 200): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== presented || req.headers.certificationtoken !== presented) {
      answer({ code: 3, msg: 'token invalid' }, 401)
      return
    }
    if (req.method === 'GET' && path === `${API_PREFIX}/nrms-schema-manage/api/meta/resclass/SpaceLayer`) {
      answer({ code: 0, msg: 'success', data: { resClassEnName: 'SpaceLayer', attributes: ATTRIBUTES } })
      return
    }
    if (req.method === 'POST' && path === `${API_PREFIX}/nrms-datamanagement/api/resources/SpaceLayer/_search`) {
      answer({
        code: 0,
        msg: 'success',
        data: {
          rawValue: RAW_ROWS,
          displayValue: DISPLAY_ROWS,
          page: { currentPage: 1, pageSize: 200, total: RAW_ROWS.length, pageCount: 1 },
        },
      })
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
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-datasource-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [name, dir] of ROWS) {
    await symlink(dir, join(scope, name.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')

describe.skipIf(MODE === 'record')('web e2e: a call that reads the deployment\'s own rows', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let backend: FakeBackend
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const sessionEvents: SessionEvent[] = []

  beforeAll(async () => {
    backend = await startBackend()
    // Read by the overlay's `!!js` expression when the loader composes the row,
    // which happens inside this process during the launch below.
    process.env.DSH_E2E_BIZ_UPSTREAM = `${backend.origin}${API_PREFIX}/`
    harnessHome = await harnessHomeWithRowLinks()
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })

    browser = await chromium.launch()
    const context = await newEnglishContext(browser)
    page = await context.newPage()
    // Served into the shell's own origin: only a same-origin page can leave the
    // token where the gate's browser half reads it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage() }))
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
    // The first load finds no token and leaves for the login page, which stores
    // one and comes back; the shell then mirrors it and reloads once more.
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 60_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    // Signing in navigates away twice — once to the login page, once for the
    // mirror reload — and every request in flight when a document goes away is
    // reported as a console error by the browser. What has to be clean is the
    // signed-in session the tests below drive, so the collectors start there.
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

  /** Every event this run's session has committed, in order. */
  function liveEvents(): readonly SessionEvent[] {
    return sessionEvents
  }

  it('asks the user in their own words, reads the rows, and draws them', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-datasource'))
    const input = composerInput(page)
    await input.waitFor({ timeout: 30_000 })
    await writeComposerDraft(page, input, PROMPT)
    await page.keyboard.press('Enter')

    // The approval panel takes the composer over while the tool waits, and it
    // is a stable waiting state, so waiting for it is race-free.
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    const asked = await panel.innerText()
    expect(asked).toContain(CARD_OPENING)
    // The line that must always be there: a ticked row does reach the model, so
    // a card promising otherwise would promise something this path does not do.
    expect(asked).toContain(CARD_PROMISE)
    expect(asked).toContain(CARD_META)
    // The card is the user's own language throughout: the backend's attribute
    // names are in the request, never on the question.
    expect(asked).not.toContain('layer_id')
    expect(asked).not.toContain('belong_map_topic')
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-datasource-card.png'), fullPage: true })

    // Nothing has been read yet: the question comes before the credential is
    // spent, and the fake backend has seen no request at all.
    expect(backend.seen).toEqual([])

    await panel.getByRole('button', { name: 'Allow once' }).click()

    const block = seat(page).locator('[data-component-block="toy.table"]')
    await block.waitFor({ timeout: 60_000 })
    // element-ui's own header and body wrappers, so reading the cells out of
    // them is the assertion that the vendored table drew the backend's rows.
    await expect.poll(
      async () => await block.locator('.el-table__body-wrapper tbody tr').count(),
      { timeout: 30_000 },
    ).toBe(DISPLAY_ROWS.length)
    for (const row of DISPLAY_ROWS) {
      expect(await block.getByText(row.zh_label, { exact: true }).count()).toBeGreaterThan(0)
    }
    // Two of the three headers were never written by the call: they come from
    // the backend's own dictionary, read after the user answered.
    await expect.poll(
      async () => await block.locator('.el-table__header-wrapper th .cell').allTextContents(),
      { timeout: 15_000 },
    ).toEqual(['', '名称', '图层id', '所属地图主题'])
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-datasource-table.png'), fullPage: true })

    // What went out: the description first, then the read, both under the
    // deployment's API prefix and both carrying the same bearer value twice.
    expect(backend.seen.map(request => `${request.method} ${request.path}`)).toEqual([
      `GET ${API_PREFIX}/nrms-schema-manage/api/meta/resclass/SpaceLayer`,
      `POST ${API_PREFIX}/nrms-datamanagement/api/resources/SpaceLayer/_search`,
    ])
    for (const request of backend.seen) {
      expect(request.authorization).toBe(STORED_TOKEN)
      expect(request.certificationToken).toBe(STORED_TOKEN)
    }

    // And the record the column replays from carries the rows and no credential.
    // Compared as a string: the merge that declares this event lives in an
    // experimental package, which `apps/web` may not depend on, so this program
    // does not know the type by name.
    const resolved = liveEvents().filter(event => (event.type as string) === 'content-component/resolved')
    expect(resolved).toHaveLength(1)
    const recorded = JSON.stringify(resolved[0])
    expect(recorded).toContain(DISPLAY_ROWS[0]?.zh_label ?? '')
    expect(recorded).not.toContain(TOKEN)
    expect(recorded).not.toContain('Bearer')
    expect(recorded).not.toContain(backend.origin)
  }, 180_000)

  it('carries the row the user ticks to the model with their next message', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-datasource-tick'))
    const block = seat(page).locator('[data-component-block="toy.table"]')
    // The name column is fixed, so element-ui draws the body twice and only the
    // visible copy takes a click.
    await block.locator('.el-checkbox__inner:visible').first().click()
    await expect.poll(
      () => liveEvents().filter(event => event.type === 'command/run'
        && event.data.args?.includes('"actionId":"select"') === true).length,
      { timeout: 30_000 },
    ).toBe(1)

    // The scripted reply is not a fixed string: llm-replay resolves its head
    // against the live request, so the sentence below can only be produced at
    // all if the notice naming the ticked row was in that request.
    const input = composerInput(page)
    await writeComposerDraft(page, input, TICK_PROMPT)
    await page.keyboard.press('Enter')
    await expect.poll(async () => await page.getByText(TICK_REPLY, { exact: false }).count(), { timeout: 60_000 })
      .toBeGreaterThan(0)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-datasource-tick.png'), fullPage: true })
  }, 180_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
