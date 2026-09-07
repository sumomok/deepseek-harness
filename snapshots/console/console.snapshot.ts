import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll } from 'vitest'
import {
  defineAcpSnapshotSuite,
  parseSnapshotManifest,
  type Scenario,
  type SnapshotSuiteOptions,
} from '@deepseek-ai/dsh-session-snapshot'

/**
 * The console's snapshot suite: the assembled evidence for the model-visible
 * surface of `show_chart` and `show_component`, driven through the shipped
 * `dsh --profile acp` interface with this lane's own patch.
 * `dsh-session-snapshot`'s suite factory owns every compare/guard mechanic;
 * this file is the scenario table, the agent paths, and the fake data backend
 * the data-source scenarios read.
 *
 * What the pin covers is the point of the lane. `tool-schemas.expected.json`
 * carries both tools whole — each description, the deployment bounds and the
 * component catalog quoted into those descriptions, and every parameter
 * description — and `system-prompt.expected.md` carries `content-surface`'s
 * on-display section, so an edit to any of it shows up as a reviewed fixture
 * diff instead of reaching a model unnoticed. `stdout.expected.jsonl` and
 * `session.jsonl` carry the arguments each call recorded and the result text the
 * model reads back.
 *
 * Fixtures live under `snapshots/console/<name>/`;
 * `pnpm run test:snapshot:refresh` rewrites them keyless from the committed
 * model script. See the suite kit's README
 * (packages/test-support/session-snapshot) and this lane's README.
 * @module
 */

const corpusDir = fileURLToPath(new URL('./', import.meta.url))

/**
 * The deployment's API prefix. A standard install of the data backend publishes
 * under it, and the fake below serves under it too so the path this lane
 * exercises is the one a real deployment answers on — a base whose path segment
 * a naive URL join would drop.
 */
const API_PREFIX = '/ini-server'

/** The read endpoint, under that prefix. */
const SEARCH_PATH = `${API_PREFIX}/nrms-datamanagement/api/resources/SpaceLayer/_search`

/** The model-description endpoint, under that prefix. */
const META_PATH = `${API_PREFIX}/nrms-schema-manage/api/meta/resclass/SpaceLayer`

/** The stored-scheme endpoint, which a call that names no columns of its own is drawn from. */
const SCHEME_PATH = `${API_PREFIX}/nrms-schema-manage/api/schema/schema`

/**
 * A JWT-shaped stand-in for the visitor's access token. Nothing verifies it:
 * the gate accepts a token on its shape alone, and the fake backend below reads
 * only that both headers carry it.
 */
const FAKE_TOKEN = 'c25hcHNob3Q.eyJzdWIiOiJ2aXNpdG9yIn0.ZmFrZQ'

/**
 * Three rows of the reference resource model, keyed by the attribute names the
 * real backend answers with, and their two readings: `rawValue` as stored,
 * `displayValue` as the deployment shows them.
 */
const RAW_ROWS = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas_transport_vehicle_info', belong_map_topic: '947543009150173184' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', layer_id: 'element:gas_pipeline', belong_map_topic: '947543009150173184' },
  { int_id: '1134933624650219532', zh_label: '调压站', layer_id: 'element:gas_station', belong_map_topic: '947543009150173185' },
]

/** The same three rows as the deployment displays them: the translated columns carry text. */
const DISPLAY_ROWS = RAW_ROWS.map((row, index) => ({
  ...row,
  belong_map_topic: index === 2 ? '专项专题' : '公用专题',
}))

/** The attribute dictionary the read checks its column names against, in the backend's own order. */
const ATTRIBUTES = [
  { attributeEnName: 'int_id', attributeCnName: '唯一标识' },
  { attributeEnName: 'zh_label', attributeCnName: '名称' },
  { attributeEnName: 'layer_id', attributeCnName: '图层id' },
  { attributeEnName: 'belong_map_topic', attributeCnName: '所属地图主题' },
]

/**
 * The model's stored default query scheme: the columns this deployment's own
 * resource list opens `SpaceLayer` with. Its flags are the characters the real
 * schema service writes them with, and one column is hidden, so a call taking
 * these columns draws two of the three.
 */
const SCHEME_COLUMNS = [
  { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1' },
  { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: '1', isSortable: '0' },
  { relatedMetaAttr: 'layer_id', alias: '图层id', isShow: '0', isSortable: '0' },
]

/**
 * The environment every scenario runs with: the fake backend's base, filled in
 * once it is listening. The object is handed to the suite at collection time
 * and read when a scenario runs, so filling it in `beforeAll` is what gets the
 * chosen port to the child.
 */
const SHARED_ENV: NodeJS.ProcessEnv = {}

/**
 * The two data-source scenarios' own environments: the same backend, plus the
 * port each composition's HTTP host binds, because both reach the gate's token
 * route themselves before their model turn. One port each, since the scenarios
 * run in parallel.
 *
 * The refusing scenario posts a token as well as the granting one, so that what
 * it pins is the question being refused rather than the row finding out first
 * that no credential is held and never asking.
 */
const DATA_ENV: NodeJS.ProcessEnv = {}

/** @see DATA_ENV */
const REFUSE_ENV: NodeJS.ProcessEnv = {}

/** @see DATA_ENV */
const DEFAULT_COLUMNS_ENV: NodeJS.ProcessEnv = {}

/** @see DATA_ENV */
const EMPTY_ENV: NodeJS.ProcessEnv = {}

let backend: Server | undefined

/**
 * Answer one JSON document.
 * @param res - the response to write.
 * @param body - the document.
 */
function answer(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Whether one request presented the visitor's token the way the deployment's
 * own page presents it: the same bearer value in both headers.
 * @param req - the incoming request.
 * @returns true when both headers carry it.
 */
function presentsToken(req: IncomingMessage): boolean {
  const presented = `Bearer ${FAKE_TOKEN}`
  return req.headers.authorization === presented && req.headers.certificationtoken === presented
}

/**
 * Read one request body as the document a read posts.
 *
 * The body is read to completion so the child's request settles the way a real
 * answer settles it, and because a read's own conditions decide which of the
 * two answers below it gets.
 * @param req - the incoming request.
 * @returns the decoded document, empty where the request carried no body.
 */
async function readBody(req: IncomingMessage): Promise<{ conditions?: unknown[] }> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw === '' ? {} : (JSON.parse(raw) as { conditions?: unknown[] })
}

/**
 * Serve the two endpoints one read uses, and refuse everything else the way the
 * real backend refuses an unrecognized request.
 * @param req - the incoming request.
 * @param res - the response to write.
 */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '').split('?')[0]
  let body: { conditions?: unknown[] }
  try {
    body = await readBody(req)
  } catch {
    // Answered rather than thrown: this handler is started with `void`, so a
    // rejection here would end the test process instead of failing a case.
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 1, msg: 'unreadable request body' }))
    return
  }
  if (!presentsToken(req)) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: 3, msg: 'token invalid' }))
    return
  }
  if (req.method === 'GET' && path === META_PATH) {
    answer(res, { code: 0, msg: 'success', traceId: 'fake', data: { resClassEnName: 'SpaceLayer', attributes: ATTRIBUTES } })
    return
  }
  if (req.method === 'GET' && path === SCHEME_PATH) {
    answer(res, { code: 0, msg: 'success', traceId: 'fake', data: [{ schemaId: 'sc-1', schemaType: 1, isDefault: 1, grid: { gridItems: SCHEME_COLUMNS } }] })
    return
  }
  if (req.method === 'POST' && path === SEARCH_PATH) {
    // How this backend answers a read whose conditions matched nothing: both
    // row lists null and a null total, rather than two empty lists.
    if ((body.conditions ?? []).length > 0) {
      answer(res, {
        code: 0,
        msg: 'success',
        traceId: 'fake',
        data: { rawValue: null, displayValue: null, page: { currentPage: 1, pageSize: 200, total: null, pageCount: null } },
      })
      return
    }
    answer(res, {
      code: 0,
      msg: 'success',
      traceId: 'fake',
      data: {
        rawValue: RAW_ROWS,
        displayValue: DISPLAY_ROWS,
        page: { currentPage: 1, pageSize: 200, total: RAW_ROWS.length, pageCount: 1 },
      },
    })
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ code: 1, msg: 'no such endpoint' }))
}

/**
 * Reserve one port nothing else holds, by binding it and letting go.
 * @returns the port.
 */
async function freePort(): Promise<number> {
  const probe = createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address() as { port: number }
  await new Promise<void>(resolve => probe.close(() => { resolve() }))
  return port
}

beforeAll(async () => {
  backend = createServer((req, res) => { void serve(req, res) })
  backend.listen(0, '127.0.0.1')
  await once(backend, 'listening')
  const { port } = backend.address() as { port: number }
  const base = `http://127.0.0.1:${String(port)}${API_PREFIX}/`
  SHARED_ENV.DSH_CONSOLE_BIZ_UPSTREAM = base
  for (const env of [DATA_ENV, REFUSE_ENV, DEFAULT_COLUMNS_ENV, EMPTY_ENV]) {
    env.DSH_CONSOLE_BIZ_UPSTREAM = base
    env.DSH_CONSOLE_HTTP_PORT = String(await freePort())
  }
})

afterAll(async () => {
  const server = backend
  if (server !== undefined) await new Promise<void>(resolve => server.close(() => { resolve() }))
})

/**
 * Post the visitor's access token to the gate, the way that visitor's browser
 * would, and wait for the composition to be up enough to take it.
 *
 * The gate holds no token until one is posted, and a row holding none refuses
 * before it asks anybody, so without this both scenarios would pin the same
 * `unauthenticated` sentence instead of the question and its answer. It runs
 * after the child spawned and before the first input step, which is the whole
 * reason the harness offers a post-spawn hook.
 * @param env - the scenario's environment, naming the port its host bound.
 */
async function postToken(env: NodeJS.ProcessEnv): Promise<void> {
  const url = `http://127.0.0.1:${env.DSH_CONSOLE_HTTP_PORT ?? ''}/auth-gate/token`
  const deadline = Date.now() + 30_000
  for (;;) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: FAKE_TOKEN }),
      })
      if (res.status === 204) return
      throw new Error(`the gate answered ${String(res.status)}`)
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`content-console: the gate never took the token: ${String(error)}`)
      await new Promise<void>((resolve) => { setTimeout(resolve, 50) })
    }
  }
}

// The shipped `dsh` CLI, this lane's profile patch, and the repo-root tsconfig
// — all ABSOLUTE: the subprocess cwd is a temp dir outside the repo. The
// launcher applies `cordis.yml` over the `acp` profile, and swaps in the
// sibling `cordis.snapshot.yml` under replay.
const AGENT = {
  binScript: fileURLToPath(new URL('../../apps/cli/src/bin.ts', import.meta.url)),
  configPath: join(corpusDir, 'cordis.yml'),
  profile: 'acp',
  tsconfigPath: fileURLToPath(new URL('../../tsconfig.json', import.meta.url)),
}

/**
 * Every scenario composes the same cordis.yml, so they are one header class and
 * `show-chart-turn` pins it for all of them: its `tool-schemas.expected.json`
 * carries every tool the console offers, `show_component` included, and its
 * `system-prompt.expected.md` carries the composed prompt. Each scenario still
 * owns its own stdout and session log, which is where a tool's result text is.
 *
 * The `show_component` scenarios are one per component whose arguments are a
 * shape of their own, because what a placed block costs a model is the arguments
 * it has to get right: `show-component-turn` places the one that asks a
 * question, `show-record-turn` the one that only displays, `show-table-turn` the
 * one whose properties nest a column list inside a configuration object and
 * whose rows are records the model chooses the field names of, and
 * `show-filter-turn` the one whose properties are an attribute table and a
 * narrowed list of match strategies. The metric ball has no scenario: its
 * properties are seven scalars, which the description already states and no
 * other scenario would exercise differently.
 *
 * Two more scenarios are about the call rather than one component's arguments.
 * `show-view-turn` places two blocks and arranges them — a table above a record
 * whose `dataList` is `{"$from": "node:sites.selectionDetail"}` — so the
 * fixture carries the `layout` and the binding as the model wrote them, in the
 * `tool/call` the `contentSurface` fold reads its entry out of, and carries the
 * result naming both drawn blocks. `reject-view-turn` sends the same call with
 * a layout naming a block it never placed, so the fixture carries the sentence
 * the model reads back, which names the path it has to fix.
 *
 * The last four are the data-source half, which is the only path here that asks
 * the user a question, spends a credential, and appends a record of its own.
 * `show-datasource-turn` posts the visitor's token to the gate before its turn,
 * answers the approval `allow_once`, and its `session.jsonl` therefore carries
 * the question the user was asked, the `content-component/resolved` holding the
 * rows the fake backend answered with, and the result line counting them — the
 * whole assembled account of one read. `refuse-datasource-turn` answers the same
 * question `reject_once`, so its log carries the question and nothing after it:
 * no event, no entry, and the sentence the model reads back.
 * `show-default-columns-turn` sends a call whose table names no columns at all,
 * so its log carries the scheme-built question, the columns the deployment's own
 * default query scheme chose, and the result line naming them.
 * `empty-datasource-turn` sends a filtered read the fake backend matches no row
 * for, so its log carries the sentence a model reads when its conditions matched
 * nothing rather than one saying the data source could not be read.
 *
 * What none of them carries is a gesture. `/component-action` reaches the host
 * through `remote.commands` and the ACP protocol has no command method, so this
 * lane pins the placement and the description that promises a gesture comes
 * back, and `apps/web/tests/component-surface.e2e.ts` pins the gesture itself
 * against a real browser and the shipped bundles.
 *
 * Every manifest declares `recording: authored` because no browser can answer
 * this composition under ACP: a chart's verdict deadline always lapses and a
 * placed block is never looked at, so the live API would only re-decide which
 * chart or which wording the model sends, never which code path the fixture
 * exercises. Refresh replays the committed scripts and needs no key. A
 * key-holder who wants a live transcript sets one manifest to
 * `recording: live` and runs `pnpm run test:snapshot:record -t <name>`.
 */
const CONTROLLER_CASES: readonly { readonly name: string, readonly env: NodeJS.ProcessEnv }[] = [
  { name: 'show-chart-turn', env: SHARED_ENV },
  { name: 'show-component-turn', env: SHARED_ENV },
  { name: 'show-record-turn', env: SHARED_ENV },
  { name: 'show-table-turn', env: SHARED_ENV },
  { name: 'show-filter-turn', env: SHARED_ENV },
  { name: 'show-view-turn', env: SHARED_ENV },
  { name: 'reject-view-turn', env: SHARED_ENV },
  { name: 'show-datasource-turn', env: DATA_ENV },
  { name: 'refuse-datasource-turn', env: REFUSE_ENV },
  { name: 'show-default-columns-turn', env: DEFAULT_COLUMNS_ENV },
  { name: 'empty-datasource-turn', env: EMPTY_ENV },
] as const

/** The scenarios that must hold the visitor's token before their model turn. */
const TOKEN_HOLDERS = new Set(['show-datasource-turn', 'refuse-datasource-turn', 'show-default-columns-turn', 'empty-datasource-turn'])

const SCENARIOS: Scenario[] = CONTROLLER_CASES.map((controller) => {
  const manifestPath = join(corpusDir, controller.name, 'snapshot.yml')
  const manifest = parseSnapshotManifest(readFileSync(manifestPath, 'utf8'), manifestPath)
  if (manifest.recording === undefined || manifest.header === undefined) {
    throw new Error(`${controller.name}: console snapshot manifest lacks recording or header metadata`)
  }
  return {
    name: controller.name,
    env: controller.env,
    hasModelTurn: true,
    recorded: manifest.recording === 'live',
    headerClass: manifest.header.class,
    ...(manifest.header.pin === true ? { pinsHeader: true } : {}),
    ...(TOKEN_HOLDERS.has(controller.name) ? { afterSpawn: () => postToken(controller.env) } : {}),
  }
})

/**
 * Map `$DSH_SNAPSHOT` onto the factory's mode.
 * @param value The raw environment value.
 * @returns The suite mode.
 */
function snapshotMode(value: string | undefined): SnapshotSuiteOptions['mode'] {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

defineAcpSnapshotSuite({
  agent: AGENT,
  snapshotsDir: corpusDir,
  scenarios: SCENARIOS,
  mode: snapshotMode(process.env.DSH_SNAPSHOT),
})
