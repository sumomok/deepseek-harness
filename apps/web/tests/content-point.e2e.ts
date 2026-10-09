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
 * The same call places a completion-rate metric beside it, as the prompt asks:
 * point-anchor does not describe `el.metric`, so that block is the one this
 * scenario points at as a whole.
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves the rows through are created here.
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { Browser, Locator, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-workspace'
import { CONSOLE_ROWS, harnessHomeWithRowLinks, launchConsole } from './console-launch.ts'
import { watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()
const OVERLAY = fileURLToPath(new URL('./content-point.overlay.yml', import.meta.url))
/**
 * The prompt that opens the page, and the one that asks about the points. The
 * composer takes them with `fill`: typed with the keyboard, a draft that starts
 * with a CJK character reaches the log without that character.
 */
const OPEN_PROMPT = '打开图层配置的数据页，旁边放一个图层完成率指标'
const ASK_PROMPT = '这几处分别是什么'

/**
 * The hand-written model answers, one entry per model call: the
 * `show_component` call placing the page and the metric, then two replies.
 */
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

/** How many row queries the page has made; a pick that reached 查询 would make one more. */
let searchesSeen = 0

/** What the stub backend answers one request with. */
interface BackendAnswer {
  readonly status: number
  readonly document: unknown
}

/**
 * What the deployment's backend answers one request of the page's own request
 * layer with; a request not presenting the visitor's token is refused.
 * @param path - the request's path.
 * @param authorization - its `Authorization` header.
 * @returns the status and the JSON document.
 */
function backendAnswer(path: string, authorization: string | undefined): BackendAnswer {
  if (authorization !== STORED_TOKEN) return { status: 401, document: { code: 3, msg: 'token invalid' } }
  if (path.endsWith('/nrms-auth/api/auth/userinfo')) {
    return { status: 200, document: { code: 0, data: { useraccount: 'e2e-visitor', username: '访客', auth: { resclass: [{
      resclassenname: META, search: 1, add: 1, update: 1, delete: 1, imp: 1, exp: 1, gridexp: 1,
      searchSetting: 1, advSearch: 1, showAsPass: 0, columns: [],
    }] } } } }
  }
  if (path.endsWith('/nrms-schema-manage/api/schema/schema')) return { status: 200, document: { code: 0, data: [schemeRow(1), schemeRow(2), schemeRow(3)] } }
  if (path.endsWith(`/nrms-schema-manage/api/meta/resclass/${META}`)) {
    return { status: 200, document: { code: 0, data: { metaEnName: META, metaAlias: '图层', attrs: [
      { relatedMetaAttr: 'zh_label', alias: '名称', dataType: 'string' },
      { relatedMetaAttr: 'belong_map_topic', alias: '所属地图主题', dataType: 'string' },
    ] } } }
  }
  if (path.endsWith(`/nrms-datamanagement/api/resources/${META}/_search`)) {
    searchesSeen += 1
    const page = { total: ROWS_SHOWN.length, currentPage: 1, pageSize: 20 }
    return { status: 200, document: { code: 0, data: { rawValue: ROWS_SHOWN, displayValue: ROWS_SHOWN, ref: [], page } } }
  }
  if (path.includes('/nrms-resourcehistory/api/log/frontevent')) return { status: 200, document: { code: 0, data: null } }
  return { status: 404, document: { code: 1, msg: 'no such endpoint' } }
}

/**
 * Answer one request of the page's own request layer as the deployment's backend does.
 * @param route - the intercepted request.
 */
async function answerBackend(route: Route): Promise<void> {
  const request = route.request()
  const { status, document } = backendAnswer(new URL(request.url()).pathname, request.headers()['authorization'])
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(document) })
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

/**
 * Start a point from the button, once the guard the previous pick leaves on the page has ended: for a moment after a pick
 * the page swallows clicks, the button's among them.
 * @param page - the page.
 */
async function startPoint(page: Page): Promise<void> {
  await page.waitForTimeout(800)
  await pointButton(page).click()
  await expect.poll(() => pointButton(page).getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
}

/**
 * Point at the middle of an element with the mouse, as a user does: over whatever the page draws on top there, with no
 * scrolling on the way. Hovering waits for the picker's box and words, which it draws on an animation frame.
 * @param page - the page.
 * @param target - the element.
 * @param shot - where to save a screenshot of the hover, if anywhere.
 */
async function pointAt(page: Page, target: Locator, shot?: string): Promise<void> {
  const box = await target.boundingBox()
  if (box === null) throw new Error('the place to point at is not laid out')
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y, { steps: 4 })
  await page.waitForTimeout(300)
  if (shot !== undefined) await page.screenshot({ path: shot })
  await page.mouse.click(x, y)
}

/**
 * Bring two chips of the attachment row into view inside the row, the page itself left where it is.
 * @param page - the page.
 * @param first - the 0-based index of the first of the two.
 */
async function chipsShown(page: Page, first: number): Promise<void> {
  await page.getByRole('group', { name: '待发送附件' }).locator('[data-reference-chip]').nth(first).evaluate((chip) => {
    // The nearest ancestor that overflows sideways is the row's own scroller; no other element is scrolled.
    let scroller = chip.parentElement
    while (scroller !== null && scroller.scrollWidth <= scroller.clientWidth) scroller = scroller.parentElement
    if (scroller !== null) scroller.scrollLeft += chip.getBoundingClientRect().left - scroller.getBoundingClientRect().left
  })
  await page.waitForTimeout(150)
}

describe.skipIf(MODE === 'record')('web e2e: 「指一下」 in the customer console', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  const events: SessionEvent[] = []

  beforeAll(async () => {
    await mkdir(SHOTS, { recursive: true })
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

  it('points at a header, a toolbar button, a cell, a row operation, a whole block and a sidebar entry, and the model is told each one\'s key line and no row value', async () => {
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
    // What stands between 「+」 and the button: the children of the row both sit in, and the gap the row draws.
    const between = await pointButton(page).evaluate((button) => {
      const add = button.closest('[data-composer-card]')?.querySelector('button[aria-haspopup="listbox"]')
      let tools: Element | null = button.parentElement
      while (tools !== null && add !== null && add !== undefined && !tools.contains(add)) tools = tools.parentElement
      const children = [...tools?.children ?? []].map(child => ({
        tag: child.localName,
        cls: child.getAttribute('class') ?? '',
        width: child.getBoundingClientRect().width,
        display: getComputedStyle(child).display,
        holdsAdd: add !== null && add !== undefined && child.contains(add),
        holdsPoint: child.contains(button),
        html: child.outerHTML.slice(0, 400),
      }))
      const gap = tools === null ? '' : getComputedStyle(tools).columnGap
      const distance = add === null || add === undefined ? -1 : button.getBoundingClientRect().left - add.getBoundingClientRect().right
      return { gap, distance, children }
    })
    await writeFile(join(SHOTS, '01-composer-row.json'), `${JSON.stringify(between, undefined, 2)}\n`)
    // Nothing visible stands between 「+」 and the button.
    const shown = between.children.filter(child => child.width > 0 || child.holdsPoint)
    expect(shown.findIndex(child => child.holdsPoint)).toBe(shown.findIndex(child => child.holdsAdd) + 1)
    // One gap of the row from 「+」, as between any two of its tools.
    expect(`${String(between.distance)}px`).toBe(between.gap)

    await input.fill(OPEN_PROMPT)
    await page.keyboard.press('Enter')
    const panel = page.locator('[data-approval-key]')
    await panel.waitFor({ timeout: 60_000 })
    await panel.getByRole('button', { name: '允许一次' }).click()
    const block = seat(page).locator('[data-component-block="toy.data-page"]')
    await expect.poll(async () => await block.locator('.el-table__body-wrapper tbody tr').count(), { timeout: 60_000 }).toBe(ROWS_SHOWN.length)
    await expect.poll(async () => await page.getByText('OPENED', { exact: true }).count(), { timeout: 60_000 }).toBeGreaterThan(0)

    // A second click on the button while a point runs cancels it, and reports nothing.
    await startPoint(page)
    await pointButton(page).click()
    await expect.poll(() => pointButton(page).getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('false')
    expect(await page.getByText('这一处指不了', { exact: false }).count()).toBe(0)
    expect(await chips(page)).toEqual([])

    // A column header, hovered first: the picker draws its box and words over the place a click would take.
    await startPoint(page)
    const header = block.locator('.el-table__header-wrapper th .cell', { hasText: '名称' }).first()
    await pointAt(page, header, join(SHOTS, '02-hover-header.png'))
    await expect.poll(() => chips(page), { timeout: 15_000 }).toEqual(['列「名称」'])

    // The toolbar's 查询, which the pick swallows: the page runs no query.
    const searches = searchesSeen
    await startPoint(page)
    await pointAt(page, block.locator('button.query-btn'))
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(2)
    expect(searchesSeen).toBe(searches)

    // A cell of the second row, and the second row's custom operation: named by column and operation, never by the row.
    await startPoint(page)
    const secondRow = block.locator('.el-table__body-wrapper tbody tr').nth(1)
    await pointAt(page, secondRow.locator('td', { hasText: ROWS_SHOWN[1]?.zh_label ?? '' }).first())
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(3)
    await startPoint(page)
    await pointAt(page, block.locator('.el-table__fixed-right .operation-custom').nth(1))
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(4)

    // A block point-anchor does not describe: the metric the call placed beside the page for this case.
    await startPoint(page)
    await pointAt(page, seat(page).locator('[data-component-block="el.metric"]'), join(SHOTS, '03-hover-block.png'))
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(5)

    // The question typed first, then one more point: the composer keeps the focus through it, and Enter sends.
    await input.fill(ASK_PROMPT)
    await startPoint(page)
    await pointAt(page, sidebar(page).locator('[data-server-sidebar-nav-entry="space-layer-rate"]'))
    await expect.poll(() => chips(page), { timeout: 15_000 }).toHaveLength(6)
    // The row shows about two chips at a time: one shot per pair.
    for (const first of [0, 2, 4]) {
      await chipsShown(page, first)
      await row.screenshot({ path: join(SHOTS, `04-chips-${String(first + 1)}-${String(first + 2)}.png`) })
    }
    await page.screenshot({ path: join(SHOTS, '04-chips-page.png') })

    // The last pick's guard swallows a key for a moment after it ends, as it does a click.
    await page.waitForTimeout(800)
    const settled = scaffold.whenTurnSettled(60_000)
    await page.keyboard.press('Enter')
    await settled
    await page.screenshot({ path: join(SHOTS, '05-sent.png') })

    const userMessages = (): SessionEvent<'user/message'>[] =>
      events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    await expect.poll(() => userMessages().some(event => (event.data.source.kind as string) === 'content-point'), { timeout: 15_000 }).toBe(true)
    const messages = userMessages()
    const sent = messages.find(event => 'references' in event.data.source)
    expect(sent?.data.content).toEqual([{ type: 'text', text: ASK_PROMPT }])
    expect(messages.find(event => event.data.source.kind === 'user')?.data.content).toEqual([{ type: 'text', text: OPEN_PROMPT }])
    const references = (sent?.data.source as { references?: { source: string; label: string; data: unknown }[] }).references ?? []
    expect(references.map(reference => reference.source)).toEqual(Array.from({ length: 6 }, () => 'content-point'))
    // Compared as a string: the merge declaring this source kind lives in an experimental package, which `apps/web` may not depend on.
    const notices = messages.filter(event => (event.data.source.kind as string) === 'content-point')
    expect(notices).toHaveLength(1)
    // The notice names the message it answers, and the log holds it right after that message.
    expect((notices[0]?.data.source as { message?: string }).message).toBe(sent?.data.id)
    expect(events[events.indexOf(sent as SessionEvent) + 1]).toBe(notices[0])
    const text = JSON.stringify(notices[0]?.data.content)
    // The logged message as the session log holds it, drawn on a page of its own for the evidence.
    const logged = JSON.stringify({ promptSource: sent?.data.source, notice: notices[0]?.data }, undefined, 2)
    await writeFile(join(SHOTS, '06-logged.json'), `${logged}\n`)
    const logPage = await browser.newPage({ viewport: { width: 1200, height: 900 } })
    await logPage.setContent(`<pre style="font: 13px/1.5 monospace; white-space: pre-wrap; margin: 16px">${logged.replace(/[&<>]/g, c => `&#${String(c.charCodeAt(0))};`)}</pre>`)
    await logPage.screenshot({ path: join(SHOTS, '06-logged-message.png'), fullPage: true })
    await logPage.close()
    // Data page, fine-grained: the column header and the toolbar button by their structure.
    expect(text).toContain(`data-page model=${META} region=table part=header column=zh_label`)
    expect(text).toMatch(new RegExp(`data-page model=${META} region=\\w+ part=button button=search`))
    expect(text).toContain(`data-page model=${META} region=table part=cell column=zh_label`)
    expect(text).toContain(`data-page model=${META} region=table part=rowOperation operation=custom:locate`)
    // Block-level: the component the view draws and the node id, and nothing the block shows.
    expect(text).toContain('block seat=component component=el.metric node=rate')
    expect(text).not.toContain('72')
    expect(text).toContain('nav nav=view id=space-layer-rate')
    // No value of either row in the references, the notice, or anything else the session logged (plan §1.6, step 3).
    const log = JSON.stringify(events)
    for (const shown of ROWS_SHOWN) {
      for (const value of Object.values(shown)) {
        expect(text, value).not.toContain(value)
        expect(JSON.stringify(references), value).not.toContain(value)
        expect(log, value).not.toContain(value)
      }
    }
  }, 240_000)
})
