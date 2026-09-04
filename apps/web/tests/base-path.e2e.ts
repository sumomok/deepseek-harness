/**
 * Web e2e scenario: the whole shell published under a deployment path prefix,
 * behind a proxy that strips it — the shape the server line is deployed in.
 *
 * The composition is the shipped Web surface plus two rows: `server-base`,
 * which puts the prefix into the served index, and `auth-gate`, whose mirror
 * cookie is scoped to that prefix. In front of them stands the lane's
 * prefix-stripping proxy, so the harness keeps serving the root-absolute routes
 * it registers while the browser only ever sees prefixed ones.
 *
 * A prefix is the one deployment shape where a root-absolute URL and a
 * prefix-relative one stop being the same address, and every URL the page
 * builds is built by different code: the boot manifest's bundle rows, the two
 * parser-blocking preloads, the RPC uplink, the two WebSocket downlinks, the
 * plugins' own settings routes, the gate's three routes, and the session-log
 * export's HEAD probe. What this scenario asserts is that not one of them lands
 * off the prefix — an off-prefix request is one the deployment's nginx never
 * routes to this process, and it fails as a 404 the page swallows rather than
 * as anything a unit test would see.
 *
 * The last case is the negative one: through a proxy that forwards the prefix
 * instead of stripping it, the harness has no route for the document, answers
 * the RPC uplink from the static fallback, and refuses the WebSocket upgrade by
 * destroying the socket. That makes "the proxy must strip the prefix whole" a
 * mechanically observable rule rather than a note in a deployment guide.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * links the loader resolves both rows through are created here rather than by
 * `healProfilesModuleFallback`.
 */

import { request as httpRequest } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, BrowserContext, Page, Request, Response, WebSocket } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { startPrefixProxy, type PrefixProxy } from './prefix-proxy.ts'
import { connectFreshWorkspace, newEnglishContext, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const BASE_DIR = join(REPO_ROOT, 'packages/experimental/server-base')
const BASE_PACKAGE = '@deepseek-ai/dsh-experimental-server-base'
const GATE_DIR = join(REPO_ROOT, 'packages/experimental/auth-gate')
const GATE_PACKAGE = '@deepseek-ai/dsh-experimental-auth-gate'

/** The deployment prefix the shell is published under, leading and trailing slash included. */
const PREFIX = '/console/'
/** The deployment's login page, hash-routed and configured with the prefix already in it. */
const LOGIN_URL = `${PREFIX}base-path-e2e-login/#/`
/** Its path, which is all the browser requests — the fragment never leaves the tab. */
const LOGIN_PATH = `${PREFIX}base-path-e2e-login/`
/** A blank same-origin page for the second tab, which must run no gate of its own. */
const SCRATCH_PATH = `${PREFIX}base-path-e2e-scratch/`
const COOKIE_NAME = 'accessToken'
/** The landing control of a world with no workspace yet — the signal that the shell is up. */
const WORKSPACE_PICKER = 'Choose workspace'
/** Host routes whose prefix-free form proves the page addressed the origin root. */
const ROOT_ROUTES = /^\/(api|plugins|auth-gate)(\/|$)/

/** Base64url, the way a JWT carries a segment. */
function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

/** The one JWT the stub login page hands out; nothing verifies its signature. */
const TOKEN = [
  segment({ alg: 'none', typ: 'JWT' }),
  segment({ sub: 'base-path-visitor', exp: Math.floor(Date.now() / 1000) + 3600 }),
  'c2ln',
].join('.')

/**
 * The stub login page's body.
 * @param signIn - whether the page stores the token and follows the return
 * address, the way the deployment's own page does.
 * @returns the page source.
 */
function loginPage(signIn: boolean): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>stub login</title></head>
<body><h1 id="stub-login">stub login</h1>
<script>
  var hash = location.hash;
  var back = new URLSearchParams(hash.slice(hash.indexOf('?'))).get('redirect');
  document.getElementById('stub-login').dataset.redirect = back;
  if (${String(signIn)}) {
    localStorage.setItem('accessToken', ${JSON.stringify(`Bearer ${TOKEN}`)});
    location.href = back;
  }
</script></body></html>`
}

/**
 * Prepare a harness home whose profile fallback resolves both experimental
 * rows, and write the overlay that composes them.
 * @returns the harness home and the overlay path to launch with.
 */
async function stageComposition(): Promise<{ harnessHome: string; overlayPath: string }> {
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-base-path-'))
  const scope = join(harnessHome, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  for (const [dir, name] of [[BASE_DIR, BASE_PACKAGE], [GATE_DIR, GATE_PACKAGE]] as const) {
    await symlink(dir, join(scope, name.slice('@deepseek-ai/'.length)), 'dir')
  }
  const overlayPath = join(harnessHome, 'base-path.e2e.patch.yml')
  // The gate's loginUrl carries the prefix itself: the browser assigns it to
  // location.href as written, and a root-absolute assignment ignores the
  // document's base element. It is deployment data, like content-frame's page
  // urls, not a route the page resolves.
  await writeFile(overlayPath, [
    '- insert:',
    '    - id: server-base',
    `      name: '${BASE_PACKAGE}'`,
    '      config:',
    `        basePath: '${PREFIX}'`,
    '    - id: auth-gate',
    `      name: '${GATE_PACKAGE}'`,
    '      config:',
    `        loginUrl: '${LOGIN_URL}'`,
    `        cookieName: ${COOKIE_NAME}`,
    '        refreshMarginSeconds: 300',
    '        mcpUpstreams: {}',
    '',
  ].join('\n'))
  return { harnessHome, overlayPath }
}

/**
 * Ask an origin for one path with a WebSocket handshake and report how it was
 * answered, without a WebSocket library: only the three outcomes matter here.
 * @param origin - scheme and authority to ask.
 * @param path - request path, prefix included.
 * @returns `upgraded`, `http-<status>`, or `refused` when the socket died first.
 */
async function probeUpgrade(origin: string, path: string): Promise<string> {
  const { hostname, host, port } = new URL(origin)
  return await new Promise<string>((resolve) => {
    const req = httpRequest({
      host: hostname,
      port,
      path,
      headers: {
        host,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': Buffer.from('base-path-probe0').toString('base64'),
        'sec-websocket-version': '13',
      },
    })
    req.on('upgrade', (_res, socket) => { socket.destroy(); resolve('upgraded') })
    req.on('response', (res) => { res.resume(); resolve(`http-${String(res.statusCode ?? 0)}`) })
    req.on('error', () => { resolve('refused') })
    req.on('close', () => { resolve('refused') })
    req.end()
  })
}

describe.skipIf(MODE === 'record')('web e2e: the shell published under a deployment prefix', () => {
  let scaffold: WebScaffold
  let proxy: PrefixProxy
  let browser: Browser
  // Own context, not the default one a bare `browser.newPage()` opens: the
  // sign-out case removes the token from a second tab, which has to share this
  // page's origin storage.
  let context: BrowserContext
  let page: Page
  let harnessHome: string
  /** Whether the stub login page signs the visitor in, or only records where it was asked to send them. */
  let stubSignsIn = false
  /** Every request the tab issued, and the status each was answered with. */
  const requested: Request[] = []
  const statuses = new Map<string, number>()
  const sockets: WebSocket[] = []

  beforeAll(async () => {
    const staged = await stageComposition()
    harnessHome = staged.harnessHome
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: staged.overlayPath })
    proxy = await startPrefixProxy({
      targetPort: Number(new URL(scaffold.baseUrl).port),
      prefix: PREFIX,
    })

    browser = await chromium.launch()
    context = await newEnglishContext(browser)
    page = await context.newPage()
    // The deployment's login page, served into the shell's own origin: only a
    // same-origin page can leave the token where the gate reads it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage(stubSignsIn) }))
    page.on('request', (request: Request) => { requested.push(request) })
    page.on('response', (response: Response) => { statuses.set(response.url(), response.status()) })
    page.on('websocket', (socket: WebSocket) => { sockets.push(socket) })
  }, 180_000)

  afterAll(async () => {
    await context?.close()
    await browser?.close()
    await proxy?.close()
    await scaffold?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  /** The paths of every collected request that went to the proxied origin. */
  function shellPaths(): string[] {
    return requested
      .map(request => new URL(request.url()))
      .filter(url => url.origin === proxy.origin)
      .map(url => url.pathname)
  }

  it('sends a visitor with no token to the login page, carrying the prefixed return address', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-base-path-redirect'))
    await page.goto(proxy.baseUrl, { waitUntil: 'load' })
    // The gate leaves during boot, so the settled URL is the assertion. This
    // stub stays put, so nothing races the read.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe(LOGIN_PATH)
    // The address the visitor is sent back to is the prefixed one they were on,
    // not the origin root the shell would have assumed before.
    expect(page.url()).toBe(`${proxy.origin}${LOGIN_PATH}#/?redirect=${encodeURIComponent(proxy.baseUrl)}`)
    expect(await page.locator('#stub-login').getAttribute('data-redirect')).toBe(proxy.baseUrl)
  }, 120_000)

  it('boots the whole shell under the prefix and asks for nothing off it', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-base-path-boot'))
    stubSignsIn = true
    requested.length = 0
    statuses.clear()
    sockets.length = 0

    await page.goto(proxy.baseUrl, { waitUntil: 'load' })
    await page.getByRole('textbox', { name: WORKSPACE_PICKER }).waitFor({ timeout: 30_000 })

    // Nothing addressed the origin root. Each of these three prefixes belongs
    // to a different URL-building path — the carrier, the module loader, and
    // the gate — so an unprefixed one names which half regressed.
    expect(shellPaths().filter(path => ROOT_ROUTES.test(path))).toEqual([])
    // And the prefixed forms were actually exercised, so the assertion above is
    // not vacuously satisfied by a page that asked for nothing at all.
    for (const route of [`${PREFIX}api/`, `${PREFIX}plugins/`, `${PREFIX}auth-gate/`]) {
      expect(shellPaths().filter(path => path.startsWith(route)).length).toBeGreaterThan(0)
    }

    // Both WebSocket downlinks live under the prefix; the harness registers
    // them as exact upgrade paths, so a prefix left on or stripped twice is a
    // destroyed socket rather than a 404. Distinct paths, because the boot
    // reconnects each downlink as the graph settles.
    await expect.poll(() => [...new Set(sockets.map(socket => new URL(socket.url()).pathname))].sort(), {
      timeout: 30_000,
    }).toEqual([`${PREFIX}api/events.host`, `${PREFIX}api/events.mux`])

    // Every plugin bundle — the two parser-blocking preloads the Host injects
    // and the rows the module loader fetches itself — resolved through the
    // page's base and was served.
    const bundles = [...statuses].filter(([url]) => new URL(url).pathname.startsWith(`${PREFIX}plugins/`))
    expect(bundles.filter(([, status]) => status !== 200)).toEqual([])
    expect(bundles.length).toBeGreaterThan(2)
    const preloaded = await page.evaluate(() =>
      [...document.querySelectorAll('head script[src]')].map(script => script.getAttribute('src') ?? ''))
    expect(preloaded.filter(src => src.startsWith('plugins/')).length).toBe(2)
    expect(preloaded.filter(src => src.startsWith('/'))).toEqual([])

    // The mirror cookie is scoped to the prefix, not to the whole origin: the
    // page's own requests all carry it, and nothing else on the host does.
    const mirrored = (await context.cookies()).find(cookie => cookie.name === COOKIE_NAME)
    expect({ value: mirrored?.value, path: mirrored?.path }).toEqual({ value: TOKEN, path: PREFIX })
  }, 180_000)

  it('probes the session-log export through the prefixed carrier route', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-base-path-export'))
    // A world with a workspace: connecting one births the blank session whose
    // live composer accepts the slash line the export controller listens for.
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
    const input = page.locator('textarea').first()
    await input.waitFor({ timeout: 30_000 })
    await input.fill('/export')
    await input.press('Enter')

    // The export builds its own URL — neither through the RPC channel nor
    // through the carrier's unary leg — and hands the resolved absolute URL to
    // the browser's download manager, which resolves nothing against the page.
    await expect.poll(() => requested
      .filter(request => new URL(request.url()).pathname === `${PREFIX}api/session.export`)
      .map(request => request.method()), { timeout: 60_000 })
      .toContain('HEAD')
  }, 180_000)

  it('gives the token up and returns to the login page still under the prefix', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-base-path-sign-out'))
    // The stub stays put again: a page that signed the visitor straight back in
    // would undo the effects this case exists to observe.
    stubSignsIn = false
    // A `storage` event reaches every document of the origin except the one
    // that wrote, so the removal has to come from a second tab in the same
    // context — a blank same-origin page, which runs no gate of its own.
    const other = await context.newPage()
    await other.route(url => url.pathname === SCRATCH_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><title>scratch</title>' }))
    await other.goto(`${proxy.origin}${SCRATCH_PATH}`, { waitUntil: 'load' })
    await other.evaluate(() => { localStorage.removeItem('accessToken') })

    // The prefix-scoped cookie is cleared by a line that has to name the same
    // Path the mirror used; a mismatch leaves a second, empty cookie behind and
    // the token in place.
    await expect.poll(async () => (await context.cookies()).some(cookie => cookie.name === COOKIE_NAME), {
      timeout: 30_000,
    }).toBe(false)
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe(LOGIN_PATH)
    expect(page.url().startsWith(`${proxy.origin}${PREFIX}`)).toBe(true)
    await other.close()
  }, 120_000)

  it('cannot be reached at all through a proxy that forwards the prefix instead of stripping it', async () => {
    // The same harness, fronted by an identity proxy: the prefix arrives intact
    // at a process whose routes are all registered at the root.
    const passthrough = await startPrefixProxy({
      targetPort: Number(new URL(scaffold.baseUrl).port),
      prefix: '/',
    })
    try {
      // The shell itself: frontend-static renders the index for `/` and
      // `/index.html` only, so a prefixed document request is simply missing.
      const shell = await fetch(`${passthrough.origin}${PREFIX}`)
      await shell.arrayBuffer()
      expect(shell.status).toBe(404)

      // RPC: the api prefix route never matches, so the uplink every browser
      // leg shares falls through to the static handler, which refuses the
      // method it was never asked to serve. The same request through the
      // stripping proxy reaches the bridge, which is what makes the prefix —
      // and not the request itself — the reason for the refusal.
      const rpcBody = {
        method: 'POST' as const,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'probe', payload: {} }),
      }
      const unstripped = await fetch(`${passthrough.origin}${PREFIX}api/session.list`, rpcBody)
      await unstripped.arrayBuffer()
      const stripped = await fetch(`${proxy.origin}${PREFIX}api/session.list`, rpcBody)
      await stripped.arrayBuffer()
      expect({ unstripped: unstripped.status, stripped: stripped.status })
        .toEqual({ unstripped: 405, stripped: 200 })

      // The downlinks are matched by exact pathname and there is no status code
      // to read: an unmatched upgrade is a destroyed socket. The same probe
      // against the stripping proxy is what proves it is the prefix that did it.
      expect(await probeUpgrade(passthrough.origin, `${PREFIX}api/events.mux`)).toBe('refused')
      expect(await probeUpgrade(proxy.origin, `${PREFIX}api/events.mux`)).toBe('upgraded')
    } finally {
      await passthrough.close()
    }
  }, 120_000)
})
