/**
 * Web e2e scenario: 「指一下」 in the customer console. The console bundle's own
 * `content-point` row puts a button beside the composer's 「+」; a click starts
 * a pick over the console, and each place picked — a data page's column
 * header, its toolbar's 查询, a block point-anchor does not describe, a sidebar
 * view entry — becomes a reference chip above the composer. Sending the
 * message records the references on it, and before the step the message
 * enters, the row's host half appends one logged message writing each point's
 * key line, with no value of any row.
 *
 * The data page is the deployment's own, opened by a scripted `show_component`
 * call the user approves; its requests are answered in the browser under the
 * configured base path, as the reverse proxy in front of a real console would.
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here.
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rm } from 'node:fs/promises'
import type { Browser, Locator, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { CONSOLE_ROWS, harnessHomeWithRowLinks, launchConsole } from './console-launch.ts'
import { watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, writeComposerDraft, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./content-point.overlay.yml', import.meta.url))
/** The hand-written model answers, one entry per model call. */
const REPLAY = fileURLToPath(new URL('./snapshots/content-point/replay.override.json', import.meta.url))
/** Where the run's screenshots land. */
const SHOTS = process.env['DSH_CONTENT_POINT_SHOTS'] ?? join(REPO_ROOT, '.artifacts', 'content-point')

/** {@link CONSOLE_ROWS} plus the rows the deployment layer and the console bundle's `content-point` row need. */
const ROWS = [
  ...CONSOLE_ROWS,
  ['@deepseek-ai/dsh-experimental-content-point', join(REPO_ROOT, 'packages/experimental/content-point')],
  ['@deepseek-ai/dsh-experimental-vue2-echarts-poc', join(REPO_ROOT, 'packages/experimental/vue2-echarts-poc')],
  ['@deepseek-ai/dsh-experimental-component-kit', join(REPO_ROOT, 'packages/experimental/component-kit')],
  ['@deepseek-ai/dsh-experimental-component-surface', join(REPO_ROOT, 'packages/experimental/component-surface')],
  ['@deepseek-ai/dsh-experimental-auth-gate', join(REPO_ROOT, 'packages/experimental/auth-gate')],
] as const

/** The replay route the scenario's session selects. */
const ROUTE = { provider: 'deepseek-official', model: 'deepseek-v4-flash' } as const

const LOGIN_PATH = '/content-point-login/'
const API_PREFIX = '/ini-server'
const META = 'SpaceLayer'

/** Base64url, the way a JWT carries a segment. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** The one JWT the stub login page hands out; nothing verifies its signature. */
const TOKEN = [segment({ alg: 'none', typ: 'JWT' }), segment({ sub: 'e2e-visitor', exp: Math.floor(Date.now() / 1000) + 3600 }), 'c2ln'].join('.')
const STORED_TOKEN = `Bearer ${TOKEN}`

/** The rows the stub backend answers every query with. A value of any of them in a point's text would be a leak. */
const ROWS_SHOWN = [
  { int_id: '1134933624650219530', zh_label: '配送车-离线', layer_id: 'element:gas_transport_vehicle_info', belong_map_topic: '公用专题' },
  { int_id: '1134933624650219531', zh_label: '燃气管线', layer_id: 'element:gas_pipeline', belong_map_topic: '公用专题' },
]

/**
 * One scheme row the page asks for.
 * @param schemaType - 1 for the query scheme, 2 and 3 for the write schemes.
 * @returns the row.
 */
function schemeRow(schemaType: number): Record<string, unknown> {
  return {
    schemaType, isDefault: 1, schemaEnName: `${META}_${String(schemaType)}`, metaAlias: '图层', metaEnName: META, contentType: 'normal',
    form: [{ formType: 'normal', labelWidth: '100px', formItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'LIKE' },
      { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: 1, isEditable: 1, isRequired: 0, relatedComponent: 'edit_input', op: 'EQ' },
    ] }],
    grid: { gridItems: [
      { relatedMetaAttr: 'zh_label', alias: '名称', isShow: '1', isSortable: '1' },
      { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', isShow: '1', isSortable: '0' },
    ] },
  }
}

/**
 * Answer one request of the page's own request layer as the deployment's backend does.
 * @param route - the intercepted request.
 */
async function answerBackend(route: Route): Promise<void> {
  const request = route.request()
  const path = new URL(request.url()).pathname
  const answer = (document: unknown, status = 200): Promise<void> =>
    route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(document) })
  if (request.headers()['authorization'] !== STORED_TOKEN) return await answer({ code: 3, msg: 'token invalid' }, 401)
  if (path.endsWith('/nrms-auth/api/auth/userinfo')) {
    return await answer({ code: 0, data: { useraccount: 'e2e-visitor', username: '访客', auth: { resclass: [{
      resclassenname: META, search: 1, add: 1, update: 1, delete: 1, imp: 1, exp: 1, gridexp: 1,
      searchSetting: 1, advSearch: 1, showAsPass: 0, columns: [],
    }] } } })
  }
  if (path.endsWith('/nrms-schema-manage/api/schema/schema')) return await answer({ code: 0, data: [schemeRow(1), schemeRow(2), schemeRow(3)] })
  if (path.endsWith(`/nrms-schema-manage/api/meta/resclass/${META}`)) {
    return await answer({ code: 0, data: { metaEnName: META, metaAlias: '图层', attrs: [
      { relatedMetaAttr: 'zh_label', alias: '名称', dataType: 'string' },
      { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', dataType: 'string' },
    ] } })
  }
  if (path.endsWith(`/nrms-datamanagement/api/resources/${META}/_search`)) {
    const page = { total: ROWS_SHOWN.length, currentPage: 1, pageSize: 20 }
    return await answer({ code: 0, data: { rawValue: ROWS_SHOWN, displayValue: ROWS_SHOWN, ref: [], page } })
  }
  if (path.includes('/nrms-resourcehistory/api/log/frontevent')) return await answer({ code: 0, data: null })
  await answer({ code: 1, msg: 'no such endpoint' }, 404)
}

/** The stub login page: stores the header value and returns where it was sent from. */
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>
  var hash = location.hash;
  var back = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('redirect');
  localStorage.setItem('accessToken', ${JSON.stringify(STORED_TOKEN)});
  location.href = back;
</script></body></html>`

const sidebar = (page: Page): Locator => page.locator('[data-server-sidebar]')
const seat = (page: Page): Locator => page.locator('[data-content-surface-seat="component"]')
const composer = (page: Page): Locator => page.locator('[data-composer-input]').first()
const pointButton = (page: Page): Locator => page.locator('[data-content-point-button]')
const chips = (page: Page): Promise<(string | null)[]> =>
  page.getByRole('group', { name: '待发送附件' }).locator('[data-reference-chip]').evaluateAll(nodes => nodes.map(node => node.getAttribute('title')))

describe.skipIf(MODE === 'record')('web e2e: 「指一下」 in the customer console', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  const events: SessionEvent[] = []

  beforeAll(async () => {
    harnessHome = await harnessHomeWithRowLinks(ROWS)
    scaffold = await launchConsole(harnessHome, OVERLAY, 'home', { replayOverride: REPLAY, replayFixture: REPLAY })
    scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { events.push(event) })
    await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE, colorScheme: 'light' })
    watchConsole(page)
    await page.route(url => url.pathname === LOGIN_PATH, route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: LOGIN_PAGE }))
    await page.route(url => url.pathname.startsWith(`${API_PREFIX}/`), route => answerBackend(route))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await sidebar(page).waitFor({ timeout: 60_000 })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  it('points at a column header, a toolbar button, a whole block and a sidebar entry, and the model is told each one\'s key line and no row value', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-content-point'))
    await sidebar(page).locator('[data-server-sidebar-section="workbench"]').click()
    const input = composer(page)
    await input.waitFor({ timeout: 30_000 })
    const workbench = (): string | undefined => (scaffold.ctx.settings.describe()
      .find(form => form.ns === ('server-sidebar' as SettingsNamespace))?.value as { workbenchSessionId?: string } | undefined)?.workbenchSessionId
    await expect.poll(workbench, { timeout: 15_000 }).toBeDefined()
    const sessionId = SessionId(workbench() ?? '')
    await expect.poll(() => scaffold.ctx.agents.get(sessionId) !== undefined, { timeout: 15_000 }).toBe(true)
    await scaffold.ctx.sessionController.selectModel({ sessionId, ...ROUTE })

    // The button sits beside the composer's 「+」.
    const row = page.locator('[data-composer-card]').first()
    await pointButton(page).waitFor({ timeout: 15_000 })
    await row.screenshot({ path: join(SHOTS, '01-composer-row.png') })

    await writeComposerDraft(page, input, '打开图层配置的数据页')
    await page.keyboard.press('Enter')
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await panel.getByRole('button', { name: '允许一次' }).click()
    const block = seat(page).locator('[data-component-block="toy.data-page"]')
    await expect.poll(async () => await block.locator('.el-table__body-wrapper tbody tr').count(), { timeout: 60_000 }).toBe(ROWS_SHOWN.length)
    await expect.poll(async () => await page.getByText('OPENED', { exact: true }).count(), { timeout: 60_000 }).toBeGreaterThan(0)

    // A column header.
    await pointButton(page).click()
    const header = block.locator('.el-table__header-wrapper th .cell', { hasText: '名称' }).first()
    await header.hover()
    // The picker draws its box and words on the next animation frame after the pointer moves.
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '02-hover-header.png') })
    await header.click()
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(1)

    // The toolbar's 查询.
    await pointButton(page).click()
    await block.locator('button.query-btn').click()
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(2)

    // A block point-anchor does not describe: the metric beside the page.
    await pointButton(page).click()
    const metric = seat(page).locator('[data-component-block="el.metric"]')
    await metric.hover()
    // The picker draws its box and words on the next animation frame after the pointer moves.
    await page.waitForTimeout(300)
    await page.screenshot({ path: join(SHOTS, '03-hover-block.png') })
    await metric.click()
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(3)

    // A sidebar view entry.
    await pointButton(page).click()
    await sidebar(page).locator('[data-server-sidebar-nav-entry="space-layer-rate"]').click()
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(4)
    await row.screenshot({ path: join(SHOTS, '04-four-chips.png') })

    const settled = scaffold.whenTurnSettled(60_000)
    await writeComposerDraft(page, input, '这几处分别是什么')
    await page.keyboard.press('Enter')
    await settled
    await page.screenshot({ path: join(SHOTS, '05-sent.png') })

    const messages = events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    const sent = messages.find(event => JSON.stringify(event.data.content).includes('这几处分别是什么'))
    const references = (sent?.data.source as { references?: { source: string; label: string; data: unknown }[] }).references ?? []
    expect(references.map(reference => reference.source)).toEqual(['content-point', 'content-point', 'content-point', 'content-point'])
    const notices = messages.filter(event => event.data.source.kind === 'content-point')
    expect(notices).toHaveLength(1)
    const text = JSON.stringify(notices[0]?.data.content)
    expect(text).toContain(`data-page model=${META} region=table part=header column=zh_label`)
    expect(text).toContain('block seat=component component=el.metric node=rate')
    expect(text).toContain('nav nav=view id=space-layer-rate')
    for (const shown of ROWS_SHOWN) for (const value of Object.values(shown)) expect(text).not.toContain(value)
    expect(JSON.stringify(references)).not.toContain(ROWS_SHOWN[0]?.zh_label)
  }, 240_000)
})
