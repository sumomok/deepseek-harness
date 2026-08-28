/**
 * Web e2e scenario: the deployment's own single sign-on in front of a dsh Web
 * surface, end to end.
 *
 * The composition is the shipped Web surface plus this package's row, so what
 * runs is the real loader chain and the real webserver routes. A stub login
 * page stands in for the deployment's — served into the same origin by the
 * browser itself, because only a same-origin page can write the token where the
 * gate reads it. It answers in two ways: the first phase's stub records the
 * return address and stays put, so where an unauthenticated visitor is sent can
 * be read without racing the trip back; the second phase's stores the token and
 * follows the return address, which is what the deployment's own page does.
 *
 * The rest is what only a real browser can answer: that the mirror reloads once
 * and then stops, that the token reaches the node half well enough to be spent
 * on an MCP request, and that a signed-in load is quiet. The load count is read
 * out of `sessionStorage`, which survives a reload of the same tab — the loop
 * this scenario guards against would show up there as a fourth load rather than
 * as a failed assertion anywhere else.
 *
 * An experimental package cannot be a dependency of `apps/web`, so the profile
 * link the loader resolves the row through is created here rather than by
 * `healProfilesModuleFallback`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, ConsoleMessage, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  acknowledgeReloadConnectionLoss,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, REPO_ROOT, saveFailureShot } from './support.ts'

const MODE = webSnapshotMode()
const GATE_DIR = join(REPO_ROOT, 'packages/experimental/auth-gate')
const GATE_PACKAGE = '@deepseek-ai/dsh-experimental-auth-gate'

/** The deployment's login page, in the hash-routed shape the real one has. */
const LOGIN_URL = '/auth-gate-e2e-login/#/'
/** Its path, which is all the browser requests — the fragment never leaves the tab. */
const LOGIN_PATH = '/auth-gate-e2e-login/'
const COOKIE_NAME = 'accessToken'
/** The forwarding route the configured upstream claims. */
const MCP_ROUTE = '/auth-gate/mcp/fixture'
/** Where the load counter keeps its tally, for this tab. */
const LOAD_KEY = 'dsh-auth-gate-loads'
/** The landing control of a world with no workspace yet — the signal that the shell is up. */
const WORKSPACE_PICKER = 'Choose workspace'

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

/**
 * The stub login page's body, in the two behaviors this scenario needs.
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
    localStorage.setItem('accessToken', ${JSON.stringify(TOKEN)});
    location.href = back;
  }
</script></body></html>`
}

/** Counts each load of the shell itself, across the reload the gate performs. */
const LOAD_COUNTER = `
  if (location.pathname === '/') {
    var key = ${JSON.stringify(LOAD_KEY)};
    sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) || '0') + 1));
  }`

/** The MCP server the deployment forwards to, standing in for a real one. */
interface FixtureUpstream {
  origin: string
  /** The `Authorization` header of every request that reached it. */
  credentials: (string | undefined)[]
  close(): Promise<void>
}

/**
 * Start the fixture upstream.
 * @returns the running fixture.
 */
async function startUpstream(): Promise<FixtureUpstream> {
  const credentials: (string | undefined)[] = []
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    credentials.push(req.headers.authorization)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', result: 'ok' }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    credentials,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections()
      server.close(() => { resolve() })
    }),
  }
}

/**
 * Prepare a harness home whose profile fallback resolves the gate row, and
 * write the overlay that composes it against the fixture upstream.
 * @param upstreamUrl - where the forwarding route sends requests.
 * @returns the harness home and the overlay path to launch with.
 */
async function stageComposition(upstreamUrl: string): Promise<{ harnessHome: string; overlayPath: string }> {
  const harnessHome = await mkdtemp(join(tmpdir(), 'dsh-auth-gate-'))
  const scope = join(harnessHome, 'profiles', 'node_modules', '@deepseek-ai')
  await mkdir(scope, { recursive: true })
  await symlink(GATE_DIR, join(scope, GATE_PACKAGE.slice('@deepseek-ai/'.length)), 'dir')
  // The shipped overlay names a deployment's own login page and forwards to
  // nothing; this scenario needs the fixture's assigned port, which exists only
  // once the fixture is listening.
  const overlayPath = join(harnessHome, 'auth-gate.e2e.patch.yml')
  await writeFile(overlayPath, [
    '- insert:',
    '    - id: auth-gate',
    `      name: '${GATE_PACKAGE}'`,
    '      config:',
    `        loginUrl: '${LOGIN_URL}'`,
    `        cookieName: ${COOKIE_NAME}`,
    '        refreshMarginSeconds: 300',
    '        mcpUpstreams:',
    `          fixture: '${upstreamUrl}'`,
    '',
  ].join('\n'))
  return { harnessHome, overlayPath }
}

describe.skipIf(MODE === 'record')('web e2e: single sign-on in front of the shell', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let harnessHome: string
  let upstream: FixtureUpstream
  let tripwire: ReturnType<typeof watchConsole>
  const consoleErrors: string[] = []
  /** Whether the stub login page signs the visitor in, or only records where it was asked to send them. */
  let stubSignsIn = false

  beforeAll(async () => {
    upstream = await startUpstream()
    const staged = await stageComposition(`${upstream.origin}/mcp`)
    harnessHome = staged.harnessHome
    scaffold = await launchWebScaffold({ harnessHome, extraOverlayPath: staged.overlayPath })

    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.addInitScript(LOAD_COUNTER)
    // The deployment's login page, served into the shell's own origin: only a
    // same-origin page can leave the token where the gate reads it.
    await page.route(url => url.pathname === LOGIN_PATH, route =>
      route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: loginPage(stubSignsIn) }))
    tripwire = watchConsole(page)
    page.on('console', (message: ConsoleMessage) => {
      if (message.type() === 'error') consoleErrors.push(message.text())
    })
  }, 180_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await upstream?.close()
    await rm(harnessHome, { recursive: true, force: true })
  })

  /** How many times the shell itself has loaded in this tab. */
  async function shellLoads(): Promise<number> {
    return await page.evaluate(key => Number(sessionStorage.getItem(key) ?? '0'), LOAD_KEY)
  }

  it('sends a visitor with no token to the login page, carrying where they were', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-gate-redirect'))
    await page.goto(`${scaffold.baseUrl}/`, { waitUntil: 'load' })
    // The gate leaves during boot, so the settled URL is the assertion. This
    // stub stays put, so nothing races the read.
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 30_000 }).toBe(LOGIN_PATH)
    // The return address rides inside the fragment, which is where a hash
    // router reads it, and it is encoded rather than pasted.
    expect(page.url()).toBe(`${scaffold.baseUrl}${LOGIN_PATH}#/?redirect=${encodeURIComponent(`${scaffold.baseUrl}/`)}`)
    expect(await page.locator('#stub-login').getAttribute('data-redirect')).toBe(`${scaffold.baseUrl}/`)
  }, 120_000)

  it('mirrors the token into a cookie and reloads exactly once on the way back', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-gate-mirror'))
    // Same tab, same origin: the tally resets here so this phase's loads are
    // the only ones counted.
    await page.evaluate((key) => { sessionStorage.setItem(key, '0') }, LOAD_KEY)
    stubSignsIn = true

    await page.goto(`${scaffold.baseUrl}/`, { waitUntil: 'load' })
    await expect.poll(async () => {
      // Unfiltered: a `Secure` cookie is stored for a loopback origin but would
      // not be sent to an `http://` URL, so a URL-filtered read returns nothing.
      const cookies = await page.context().cookies()
      return cookies.find(cookie => cookie.name === COOKIE_NAME)?.value
    }, { timeout: 30_000 }).toBe(TOKEN)

    const mirrored = (await page.context().cookies()).find(cookie => cookie.name === COOKIE_NAME)
    expect({ path: mirrored?.path, sameSite: mirrored?.sameSite, secure: mirrored?.secure, httpOnly: mirrored?.httpOnly })
      .toEqual({ path: '/', sameSite: 'Lax', secure: true, httpOnly: false })

    // Three loads of the shell: the one that found no token and left, the one
    // the login page returned to, and the one the mirror asked for. A gate that
    // decided to mirror again would keep going.
    await expect.poll(shellLoads, { timeout: 30_000 }).toBe(3)
    await page.getByRole('textbox', { name: WORKSPACE_PICKER }).waitFor({ timeout: 30_000 })
    expect(await shellLoads()).toBe(3)
  }, 120_000)

  it('spends the token the browser found on the MCP request it forwards', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-gate-forward'))
    // The push happens on the settled load; wait for the node half to hold a
    // token rather than answering 503.
    await expect.poll(async () => {
      const response = await fetch(`${scaffold.baseUrl}${MCP_ROUTE}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
      })
      await response.arrayBuffer()
      return response.status
    }, { timeout: 30_000 }).toBe(200)
    expect(upstream.credentials.at(-1)).toBe(`Bearer ${TOKEN}`)
  }, 120_000)

  it('boots a signed-in visitor without leaving the page or logging anything', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-auth-gate-settled'))
    // The phases above navigate away mid-boot three times by design, and a
    // request cancelled that way reports as a console error. What has to be
    // clean is the load a signed-in visitor actually gets, so the collectors
    // start over here.
    consoleErrors.length = 0
    tripwire.pageErrors.length = 0
    const warningStart = tripwire.warnings.length

    await page.reload({ waitUntil: 'load' })
    await page.getByRole('textbox', { name: WORKSPACE_PICKER }).waitFor({ timeout: 30_000 })
    // The cookie is in step, so this load neither redirects nor reloads.
    expect(page.url()).toBe(`${scaffold.baseUrl}/`)
    expect(await shellLoads()).toBe(4)

    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(tripwire.pageErrors).toEqual([])
    expect(consoleErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 120_000)
})
