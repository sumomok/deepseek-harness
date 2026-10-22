/**
 * Web e2e scenario: `read_component` prints the key each row of a data page is
 * named by, and `act_component` presses a control the page draws once per row
 * in the one row a step names with that key.
 *
 * The composition is the data page rows of `component-surface-data-page.e2e.ts`
 * plus `content-frame`, whose shared content channel carries both calls to the
 * tab showing the session. The seed places one written-down view the way a
 * click on a configured view does — a `content-component/shown` record — so the
 * page opens writable: a modify button on each row, the page's own side card,
 * and its own add and modify forms switched off for the form page beside it,
 * which reads the page's `editing` output. The page's own card is kept rather
 * than an info card beside it, because the page reports an opened card while
 * the press runs and an info card reports it from a later render, which no step
 * marks.
 *
 * The backend answers in the browser, standing in for the reverse proxy a real
 * console has in front of it, and answers a query naming one record by its id
 * with that record alone, the way the deployment's own backend does. The form
 * and the card each fetch the record they draw that way, so what either draws
 * is the record the page published, and the request that fetched it names the
 * id the page published.
 *
 * The model is a committed script whose row keys are the fixture's own record
 * ids, written out. The pressed row is the middle one of three, so neither the
 * first nor the last row drawn stands in for the one named. The script's last
 * reply reads its step number and record name out of the notice the card's
 * report caused, so that reply exists only if that notice reached the model's
 * request.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the overlay's rows through are created here.
 */

import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, ConsoleMessage, Locator, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { toolResults } from './content-column.ts'
import { launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { newEnglishContext, REPO_ROOT, saveFailureShot, writeComposerDraft } from './support.ts'

const MODE = webSnapshotMode()
const FIXTURE = fileURLToPath(new URL('../../../snapshots/web/fresh-round-trip/session.v4.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('./component-surface-rows.overlay.yml', import.meta.url))
/**
 * The six model answers of the prompt's turn, written by hand: a reading, three
 * `act_component` calls, a second reading, and the closing reply. The second
 * reading is one further channel round trip after the last press, so the
 * notices that press caused have reached the turn's inbox before the closing
 * request is composed.
 */
const REPLAY = fileURLToPath(new URL('./snapshots/component-surface-rows/replay.override.json', import.meta.url))
/** The hosted application `content-frame` serves; the overlay reads it from the environment. */
const APP_ROOT = join(REPO_ROOT, 'packages/experimental/content-frame/tests/fixtures/app')

/** Every experimental row the overlay inserts, as package name and source directory. */
const ROWS = [
  ['@deepseek-ai/dsh-experimental-server-layout', join(REPO_ROOT, 'packages/experimental/server-layout')],
  ['@deepseek-ai/dsh-experimental-content-surface', join(REPO_ROOT, 'packages/experimental/content-surface')],
  ['@deepseek-ai/dsh-experimental-content-column', join(REPO_ROOT, 'packages/experimental/content-column')],
  ['@deepseek-ai/dsh-experimental-content-frame', join(REPO_ROOT, 'packages/experimental/content-frame')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-auth-gate', join(REPO_ROOT, 'packages/experimental/auth-gate')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
] as const

/** Where the run's evidence lands. */
const ARTIFACTS = join(REPO_ROOT, '.artifacts')

const SESSION = 'component-surface-rows-web-e2e'

/** The stub login page's path, matching the `loginUrl` the overlay configures. */
const LOGIN_PATH = '/component-surface-rows-login/'

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

/** The three records every query that names none is answered with, as the deployment displays them. */
const RECORDS = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas_transport_vehicle_info', belong_map_topic: '公用专题' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', layer_id: 'element:gas_pipeline', belong_map_topic: '公用专题' },
  { int_id: '1134933624650219532', zh_label: '调压站', layer_id: 'element:gas_station', belong_map_topic: '专项专题' },
] as const

/** The record every step names: the middle one of the three. */
const NAMED = RECORDS[1]
/** Every record's id, in the order the page draws them. */
const RECORD_IDS = RECORDS.map(record => record.int_id)

/**
 * The table's stored query scheme: the name column drawn as the link that
 * opens a record's card, one more column shown, and one hidden.
 */
const GRID_ITEMS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1', relatedComponent: 'display_default' },
  { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: '1', isSortable: '0' },
  { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: '0', isSortable: '0' },
]

/**
 * One scheme row of the kind the page, the form or the card asks for, carrying
 * the smallest form and grid the page's own scheme check accepts.
 * @param schemaType - 1 for the query scheme, 2 and 3 for the add and modify schemes.
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

/** One request the page made, as the stub answered it. */
interface Seen {
  method: string
  path: string
  authorization?: string
  /** The body a POST carried, as text; empty for one that carried none. */
  body: string
}

/** One condition of a query, as the page's request layer writes it. */
interface QueryCondition {
  key?: unknown
  op?: unknown
  value?: unknown
}

/**
 * The record id a query names, where it names exactly one by `int_id`: the
 * query the form and the card fetch their record with.
 * @param body - the query's body, as text.
 * @returns the id, or `undefined` for a query naming none.
 */
function namedId(body: string): string | undefined {
  if (body === '') return undefined
  const parsed = JSON.parse(body) as { conditions?: readonly QueryCondition[] }
  const named = (parsed.conditions ?? []).find(condition => condition.key === 'int_id' && condition.op === 'EQ')
  return typeof named?.value === 'string' ? named.value : undefined
}

/**
 * Answer one request of the page's own request layer the way the deployment's
 * backend does, and refuse one not presenting the visitor's token.
 * @param route - the intercepted request.
 * @param seen - where every answered request is recorded.
 */
async function answerBackend(route: Route, seen: Seen[]): Promise<void> {
  const request = route.request()
  const url = new URL(request.url())
  const path = url.pathname
  const authorization = request.headers()['authorization']
  const body = request.postData() ?? ''
  seen.push({ method: request.method(), path, body, ...authorization === undefined ? {} : { authorization } })
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
        gridexp: 1, searchSetting: 1, advSearch: 1, showAsPass: 0, columns: ['zh_label', 'belong_map_topic'],
      },
    ] } } })
    return
  }
  if (request.method() === 'GET' && path.endsWith('/nrms-schema-manage/api/schema/schema')) {
    const asked = Number(url.searchParams.get('schemaType'))
    await answer({ code: 0, data: (asked > 0 ? [asked] : [1, 2, 3]).map(schemeRow) })
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
    const id = namedId(body)
    const rows = id === undefined ? RECORDS : RECORDS.filter(record => record.int_id === id)
    const page = { total: rows.length, currentPage: 1, pageSize: 20 }
    await answer({ code: 0, data: { rawValue: rows, displayValue: rows, ref: [], page } })
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

/** Where the card draws a table's icon from: the deployment's own static path on the shell's origin, outside the base path. */
const ICON_PREFIX = '/nrms-file/icon-res/'

/** The icon the stub serves for every table: one transparent pixel. */
const ICON = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')

/** The visitor may do everything on the table: without every write ability, the page draws no modify button. */
const ALL_ABILITIES = { create: true, update: true, delete: true, import: true, export: true }

/** The entry the seed places, as a click on a configured view would. */
const ENTRY_ID = 'layers'
const ENTRY_TITLE = '图层配置'

/**
 * The view's spec: the data page opened writable with its own two forms off and
 * its own card on, beside the form page its add and modify buttons open.
 */
const ROWS_SPEC = {
  nodes: [
    {
      id: 'page',
      component: 'toy.data-page',
      props: {
        relatedMeta: META,
        metaLabel: ENTRY_TITLE,
        selectMode: 'checkbox',
        readOnly: false,
        regions: { addForm: false, modifyForm: false },
        toolbarButtons: ['add', 'search', 'clear'],
        rowOperations: ['modify'],
      },
    },
    { id: 'form', component: 'toy.form-page', props: { relatedMeta: META, request: { $from: 'node:page.editing' } } },
  ],
  layout: {
    node: 'stack',
    dir: 'row',
    children: [{ node: 'component', id: 'page', flex: 2 }, { node: 'component', id: 'form', flex: 1 }],
  },
}

/** What the user asks. */
const PROMPT = 'Open 燃气管线 for editing and show me its card.'

/** The call that presses the row's opening cell and then its name link, whose id both presses' reports name. */
const ROW_CALL = 'call_00_rows000000000000000000000004'

/** The step failure a press of `modify` naming no row reports: one per row, so it lists the rows' keys. */
const NO_ROW_FAILURE = '- click on "modify": own key "modify" is carried by 3 drawn controls in the entry, one per row; '
  + `name the row with \`row\`: ${RECORD_IDS.join(', ')}.`
/** The step lines of the presses naming the row. */
const MODIFY_LINE = `- click on "modify" of row "${NAMED.int_id}": done`
const CELL_LINE = `- click on "cell-click" of row "${NAMED.int_id}": done`
const LINK_LINE = `- click on "card-open" of row "${NAMED.int_id}": done`

/** The cells a reported click on the named row carries: the columns the page draws. */
const NAMED_CELLS = { zh_label: NAMED.zh_label, belong_map_topic: NAMED.belong_map_topic }

/** The sentence a report the agent's own step caused opens with. */
const ownStep = (index: number): string =>
  `This report comes from step ${String(index)} of your own call acting on this entry, not from the user: `

/** The plugin kind the command posts its notices under. */
const NOTICE_PLUGIN: string = 'content-component'

/** The closing reply, whose step number and record name llm-replay read out of the request the card's notice was in. */
const MODEL_REPLY = `Step 2 opened the card of ${NAMED.zh_label}.`

/**
 * The composer of the open session.
 * @param page - the page under test.
 * @returns the composer input locator.
 */
function composerInput(page: Page): Locator {
  return page.locator('[data-composer-input]').first()
}

/** The component seat of the content column. */
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')

/**
 * Prepare a harness home whose profile fallback resolves every overlay row.
 * @returns the harness home the scaffold should adopt.
 */
async function harnessHomeWithRowLinks(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-component-surface-rows-'))
  const scope = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [packageName, dir] of ROWS) {
    await symlink(dir, join(scope, packageName.slice('@deepseek-ai/'.length)), 'dir')
  }
  return home
}

/**
 * Splice the record a click on the view writes into the recorded session,
 * before its turn ends: the seed must close on `turn/end`.
 * @param fixtureText - the committed seed fixture.
 * @returns the fixture text to seed.
 */
function withRowsView(fixtureText: string): string {
  const lines = fixtureText.split('\n')
  const closing = lines.findIndex(line => line.includes('"type":"turn/end"'))
  if (closing === -1) throw new Error('seed fixture has no turn/end to splice before')
  return [
    ...lines.slice(0, closing),
    JSON.stringify({
      type: 'content-component/shown',
      data: { entryId: ENTRY_ID, title: ENTRY_TITLE, spec: ROWS_SPEC, by: 'user' },
    }),
    ...lines.slice(closing),
  ].join('\n')
}

/**
 * The scenario session's log as the running host holds it.
 * @param scaffold - the booted scaffold.
 * @returns every event the session carries, in order.
 */
function liveEvents(scaffold: WebScaffold): readonly SessionEvent[] {
  const agent = scaffold.ctx.agents.get(SessionId(SESSION))
  if (agent === undefined) throw new Error(`no live agent for ${SESSION}`)
  return agent.session.snapshotEvents()
}

/** One `/component-action` run, as its arguments name the gesture. */
interface ActionRun {
  actionId: string
  payload: Record<string, unknown>
  step?: { call: string; index: number }
}

/**
 * Every gesture the session's `/component-action` command ran for, in log order.
 * @param events - the session's events.
 * @returns each run's arguments.
 */
function actionRuns(events: readonly SessionEvent[]): ActionRun[] {
  return events.flatMap(event => (
    event.type === 'command/run' && event.data.name === 'component-action'
      ? [JSON.parse(event.data.args ?? '{}') as ActionRun]
      : []
  ))
}

describe.skipIf(MODE === 'record')('web e2e: act_component presses a per-row control in the row a step names', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  const seen: Seen[] = []
  const inheritedAppRoot = process.env.DSH_CONTENT_APP_ROOT

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks()
    // The overlay's `!!js` expression resolves against this process, which is
    // where the scaffold runs the loader.
    process.env.DSH_CONTENT_APP_ROOT = APP_ROOT
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: OVERLAY, replayFixture: REPLAY, replayOverride: REPLAY })
    await seedSession(scaffold, withRowsView(await readFile(FIXTURE, 'utf8')), SESSION)

    browser = await chromium.launch()
    const context = await newEnglishContext(browser)
    page = await context.newPage()
    // Served into the shell's own origin: only a same-origin page can leave the
    // token where the gate's browser half and the page's request layer read it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage() }))
    await page.route(url => url.pathname.startsWith(`${API_PREFIX}/`), route => answerBackend(route, seen))
    // No `bizUpstream` composes no ability route, so the verdict the node half
    // would give is answered here, granting every ability.
    await page.route(url => url.pathname === '/component-kit/abilities', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ALL_ABILITIES) }))
    // The record card draws its table's icon from this path, which the reverse
    // proxy in front of a real console serves.
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
    // The workspace group row precedes its sessions; expanding it lists them.
    await page.locator('[role="treeitem"]').first().click()
    const row = page.locator('[role="treeitem"]').nth(1)
    await row.waitFor({ timeout: 15_000 })
    await row.click()
    await composerInput(page).waitFor({ timeout: 15_000 })
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
    if (inheritedAppRoot === undefined) delete process.env.DSH_CONTENT_APP_ROOT
    else process.env.DSH_CONTENT_APP_ROOT = inheritedAppRoot
  })

  it('reads each row\'s key, refuses a per-row press naming no row, and presses the named row\'s controls', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-rows'))
    const block = seat(page).locator('[data-component-block="toy.data-page"]')
    const drawnRows = block.locator('.el-table__body-wrapper tbody tr.el-table__row')
    // Every drawn row carries its record's id, and the named record is drawn
    // neither first nor last.
    await expect.poll(
      async () => await drawnRows.evaluateAll(rows => rows.map(row => row.getAttribute('data-component-row'))),
      { timeout: 60_000 },
    ).toEqual(RECORD_IDS)
    expect(RECORD_IDS.indexOf(NAMED.int_id)).toBe(1)
    // A step acts on the entry in front, so the page must be on display before
    // the turn starts.
    await expect.poll(async () => (await seat(page).boundingBox())?.width ?? 0, { timeout: 15_000 }).toBeGreaterThan(200)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-surface-rows-page.png'), fullPage: true })

    let turnOver = false
    const settled = scaffold.whenTurnSettled(150_000).then(
      (id) => { turnOver = true; return id },
      (error: unknown) => { turnOver = true; throw error },
    )
    await writeComposerDraft(page, composerInput(page), PROMPT)
    await page.keyboard.press('Enter')
    // Neither tool asks for approval of its own; a panel the composition's
    // approval policy raises anyway is answered, because what this scenario
    // pins is what the steps did, not the policy.
    const answerApprovals = async (): Promise<void> => {
      while (!turnOver) {
        const panel = page.locator('[data-approval-key]').first()
        const shown = await panel.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)
        if (!shown) continue
        await panel.getByRole('button', { name: 'Allow once' }).click()
        await panel.waitFor({ state: 'detached', timeout: 30_000 }).then(() => undefined, () => undefined)
      }
    }
    await Promise.all([answerApprovals(), settled])

    const events = liveEvents(scaffold)
    // The reading names every row by the key a click names it by.
    const readings = toolResults(events, 'read_component')
    expect(readings.length).toBe(2)
    expect(readings[0]).toContain('Named rows (`row` key: name):')
    for (const record of RECORDS) expect(readings[0]).toContain(`- "${record.int_id}": "${record.zh_label}"`)

    const answers = toolResults(events, 'act_component')
    expect(answers.length).toBe(3)
    // The modify button is drawn once per row, so a press naming no row
    // presses nothing and lists the keys that tell the rows apart.
    expect(answers[0]).toContain(NO_ROW_FAILURE)
    expect(answers[1]).toContain(MODIFY_LINE)
    expect(answers[2]).toContain(CELL_LINE)
    expect(answers[2]).toContain(LINK_LINE)

    // The row's opening cell reports the named row's cells, as step 1; the
    // name link opens the card and reaches the row's own cell click on the way
    // up, so step 2 reports both. Nothing else a step caused was reported.
    // Compared as a set: each report reaches the host as a command of its own.
    const runs = actionRuns(events)
    const stepped = runs.flatMap(run => (run.step === undefined ? [] : [run.step]))
    expect(new Set(stepped.map(step => step.call))).toEqual(new Set([ROW_CALL]))
    expect(runs.flatMap(run => (run.step === undefined ? [] : [`${run.actionId} at step ${String(run.step.index)}`])).sort())
      .toEqual(['card-open at step 2', 'cell-click at step 1', 'cell-click at step 2'])
    for (const run of runs.filter(each => each.actionId === 'cell-click')) {
      expect(run.payload).toEqual({ attr: 'zh_label', label: '名称', row: NAMED_CELLS })
    }
    expect(runs.find(run => run.actionId === 'card-open')?.payload).toEqual({ name: NAMED.zh_label, type: META })

    // The form page opened the record the page published as `editing`, and the
    // card the one it published as `opened`: each fetched its record by the id
    // the page published, and the backend answers that query with that record
    // alone.
    const fetchedIds = seen.flatMap((request) => {
      const id = request.method === 'POST' && request.path.endsWith('/_search') ? namedId(request.body) : undefined
      return id === undefined ? [] : [id]
    })
    expect(fetchedIds.length).toBeGreaterThanOrEqual(2)
    expect(new Set(fetchedIds)).toEqual(new Set([NAMED.int_id]))
    const form = seat(page).locator('[data-component-block="toy.form-page"]')
    await expect.poll(async () => await form.locator('input[data-component-field="zh_label"]').inputValue(), { timeout: 30_000 })
      .toBe(NAMED.zh_label)
    expect(await form.locator('input[data-component-field="belong_map_topic"]').inputValue()).toBe(NAMED.belong_map_topic)
    const card = block.locator('.crud-small-card')
    await expect.poll(async () => await card.innerText(), { timeout: 30_000 }).toContain(NAMED.zh_label)
    const cardText = await card.innerText()
    for (const other of RECORDS.filter(record => record !== NAMED)) expect(cardText).not.toContain(other.zh_label)
    await page.screenshot({ path: join(ARTIFACTS, 'web-e2e-component-surface-rows.png'), fullPage: true })
  }, 300_000)

  it('tells the agent each report came from its own call\'s step, in the turn it ran in', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-component-surface-rows-report'))
    const events = liveEvents(scaffold)
    const own = events.flatMap((event) => {
      if (event.type !== 'user/message' || event.data.source.kind !== NOTICE_PLUGIN) return []
      const text = event.data.content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join('')
      return text.startsWith('This report comes from step ') ? [{ seq: event.seq, text }] : []
    })
    const clicked = `You clicked "名称" (zh_label) on row "${NAMED.zh_label}"`
    const opened = `You opened the side card of "${NAMED.zh_label}" (table "${META}")`
    expect(own.length).toBe(3)
    for (const opening of [`${ownStep(1)}${clicked}`, `${ownStep(2)}${clicked}`, `${ownStep(2)}${opened}`]) {
      expect(own.filter(notice => notice.text.startsWith(opening)).length).toBe(1)
    }

    // No turn of their own: the seed closed turn 1 and the prompt opened turn 2,
    // which claimed the notices before it ended.
    const started = events.filter(event => event.type === 'turn/start')
    const ended = events.filter(event => event.type === 'turn/end')
    expect(started.length).toBe(2)
    expect(ended.length).toBe(2)
    for (const notice of own) {
      expect(notice.seq).toBeGreaterThan(started[1]?.seq ?? Infinity)
      expect(notice.seq).toBeLessThan(ended[1]?.seq ?? 0)
    }

    // The closing reply's step number and record name were read out of the
    // request the card's notice was in.
    await expect.poll(async () => await page.getByText(MODEL_REPLY, { exact: false }).count(), { timeout: 30_000 })
      .toBe(1)
  }, 120_000)

  it('leaves the console clean', () => {
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
