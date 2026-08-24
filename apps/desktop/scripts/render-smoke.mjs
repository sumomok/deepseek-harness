/**
 * Post-build smoke for the render service, run inside a real Electron main
 * process: `pnpm --filter @deepseek-ai/dsh-desktop run render-smoke`.
 *
 * The unit suite drives the protocol against an injected renderer, which is
 * everything except the part that needs a Chromium — so this is the check that
 * a hidden `BrowserWindow` actually paints, that `capturePage` returns the
 * requested viewport, that a full-page capture grows past it, that a request's
 * cookies reach every request the page makes while its headers reach only the
 * navigation, that the next render starts from an empty cookie store because
 * each holds its own non-persistent partition, that a request's `userAgent`
 * reaches the document and its subresources while a render naming none reports
 * Electron, that the `did-navigate` and `webRequest` hooks a timed-out render
 * is described from see a real redirect and a real page's real requests, that a
 * deadline can answer with the pixels a real page had painted, that
 * `blockHosts` really cancels a request Chromium was about to make, and that a
 * real page's `console.error` reaches the report. It renders local files and
 * pages from listeners on this machine, so it needs no network, and it uses the
 * shell's own limits.
 *
 * Requires `pnpm --filter @deepseek-ai/dsh-desktop run build:ts` first: this
 * runs under Electron, which has no TypeScript loader, so it imports `lib/`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { RENDER_LIMITS, startRenderService } from '../lib/render-service.js'
import { renderInHiddenWindow } from '../lib/render-window.js'

/** The viewport every case renders at. */
const VIEWPORT = { width: 400, height: 300 }

/** The deadline the hung-image case runs on, so it does not hold the smoke for the shell's own 25 seconds. */
const HANG_TIMEOUT_MS = 2000

/** The page: a solid block taller than the viewport, so a full-page capture is visibly taller. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>render smoke</title>
<style>body { margin: 0 } .block { height: 900px; background: linear-gradient(#123, #abc) }</style>
<div class="block">render smoke</div>`

/**
 * The paths the subresource case serves: a page under a nested directory, an
 * image beside it, and an image under a different top-level path. The last is
 * the one a cookie scoped to the page's own directory never reaches, and it is
 * how an application that serves its pages from `/app/…` and its data from
 * `/api/…` is laid out.
 */
const NESTED = { page: '/app/issues/page', sibling: '/app/issues/sibling.png', api: '/api/pixel.png' }

/** The nested page, whose two images the load event waits for. */
const NESTED_PAGE = `<!doctype html><meta charset="utf-8"><title>nested</title>
<img src="${NESTED.api}" alt=""><img src="${NESTED.sibling}" alt="">`

/** A 1x1 PNG, the smallest subresource a page can make a server answer. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')

/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * The pixel size recorded in a PNG's IHDR chunk.
 * @param {Buffer} png - the encoded image.
 * @returns {{ width: number, height: number }} its pixel dimensions.
 */
function pngSize(png) {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('response does not start with the PNG signature')
  if (png.subarray(12, 16).toString('ascii') !== 'IHDR') throw new Error('PNG does not open with an IHDR chunk')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

/**
 * POST one render request.
 * @param {{ endpoint: string, token: string }} service - the running service.
 * @param {Record<string, unknown>} body - the request body.
 * @param {string} [token] - the bearer token to send, defaulting to the real one.
 * @returns {Promise<Response>} the response, with its body unread.
 */
async function post(service, body, token = service.token) {
  return fetch(`${service.endpoint}/render`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * Fail the smoke unless `condition` holds.
 * @param {boolean} condition - what must be true.
 * @param {string} what - the line printed either way.
 */
function check(condition, what) {
  if (!condition) throw new Error(`FAILED: ${what}`)
  console.log(`  ok  ${what}`)
}

/**
 * The render report one answer carries.
 * @param {Response} response - the answer to read.
 * @returns {import('../lib/render-service.js').RenderReport} the parsed report.
 * @throws when the answer carries no report, which is itself the failure.
 */
function reportOf(response) {
  const header = response.headers.get('x-dsh-render-report')
  if (header === null) throw new Error('FAILED: the answer carries no x-dsh-render-report header')
  return JSON.parse(decodeURIComponent(header))
}

/**
 * A listener that completes the TCP handshake and then never answers — what a
 * blackholed third-party host looks like from inside a page, minus the wait for
 * a connect timeout.
 * @returns {Promise<{ port: number, close: () => Promise<void> }>} the port it accepted on, and its shutdown.
 */
async function hangingListener() {
  const held = new Set()
  const server = createServer((socket) => {
    held.add(socket)
    socket.on('close', () => held.delete(socket))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the hanging listener reported no TCP address')
  return {
    port: address.port,
    close: async () => {
      // The sockets are open by construction, so nothing closes the listener but this.
      for (const socket of held) socket.destroy()
      await new Promise((resolve) => { server.close(resolve) })
    },
  }
}

/**
 * A page whose only image never answers: the load event never fires, and the
 * 504 has to name that image rather than only the deadline. This is the one
 * case that proves the session's `webRequest` hooks reach the service's trace,
 * which no injected renderer can show.
 * @param {string} directory - the temporary directory the page is written into.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function hungImageCase(directory) {
  const listener = await hangingListener()
  const image = `http://127.0.0.1:${listener.port}/hang.png`
  const page = join(directory, 'hung.html')
  await writeFile(page, `<!doctype html><meta charset="utf-8"><title>hung image</title><img src="${image}" alt="">`)
  const service = await startRenderService({
    renderer: renderInHiddenWindow,
    limits: { ...RENDER_LIMITS, timeoutMs: HANG_TIMEOUT_MS },
  })
  try {
    const response = await post(service, { url: pathToFileURL(page).href, ...VIEWPORT })
    check(response.status === 504, `a page whose image never answers answered ${response.status}`)
    const report = reportOf(response)
    const line = (await response.text()).trim()
    console.log(`      ${line}`)
    check(line.includes('load event not fired'), 'the 504 line says the load event never fired')
    check(line.includes(`[image] ${image}`), 'the 504 line names the image the page is still waiting for')
    check(report.outcome === 'timeout' && report.capture === null, 'the 504 carries a report of a timeout that produced no pixels')
    check(report.pending[0]?.url === image, 'the report names that image too')
  } finally {
    await service.close()
    await listener.close()
  }
}

/**
 * A site that answers one page to a caller with a session and redirects
 * everyone else to its sign-in page — the case both `cookies` and `headers`
 * exist for, and the case a returned screenshot has to say something about
 * when the render lands on the sign-in page instead. It also serves
 * {@link NESTED}, and records what every request it received carried, which is
 * the only place the session a render actually sent can be observed.
 * @param {string} [hangingImage] - an image the sign-in page loads, so a render sent there never fires its load event.
 * @returns {Promise<{ origin: string, observed: { path: string, cookie: boolean, header: boolean, userAgent: string }[], close: () => Promise<void> }>} the origin it serves, what it received, and its shutdown.
 */
async function sessionSite(hangingImage) {
  /** @type {{ path: string, cookie: boolean, header: boolean, userAgent: string }[]} */
  const observed = []
  const server = createHttpServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://site.invalid').pathname
    const cookie = (request.headers.cookie ?? '').includes('session=abc')
    const header = request.headers['x-session'] === 'abc'
    observed.push({ path, cookie, header, userAgent: request.headers['user-agent'] ?? '' })
    const signedIn = cookie || header
    if (path.startsWith('/issues') && !signedIn) {
      response.writeHead(302, { location: '/login' })
      response.end()
      return
    }
    if (path.endsWith('.png')) {
      // The assertions are about requests reaching this handler, so nothing may
      // be answered out of a cache.
      response.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
      response.end(PIXEL)
      return
    }
    const hung = path === '/login' && hangingImage !== undefined ? `<img src="${hangingImage}" alt="">` : ''
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(path === NESTED.page
      ? NESTED_PAGE
      : `<!doctype html><meta charset="utf-8"><title>${signedIn ? 'issues' : 'sign in'}</title><p>${path}${hung}`)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('the session site reported no TCP address')
  return {
    origin: `http://127.0.0.1:${address.port}`,
    observed,
    close: async () => {
      server.closeAllConnections()
      await new Promise((resolve) => { server.close(resolve) })
    },
  }
}

/**
 * The session cookie {@link sessionSite} accepts, scoped to the origin it is
 * serving on. The domain is the cookie's own, not the page's, which is what the
 * service builds the URL it stores the cookie from.
 * @param {string} origin - the site's origin.
 * @returns {{ name: string, value: string, domain: string, path: string }} the cookie to send.
 */
function cookieFor(origin) {
  return { name: 'session', value: 'abc', domain: new URL(origin).hostname, path: '/' }
}

/**
 * A user agent with nothing of this shell in it, which is the point of the
 * field: Electron's default names Electron and the app to every page rendered.
 */
const CLEAN_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'

/**
 * Render a page behind a session three ways: without one, with a cookie, and
 * with a header. Only a real Chromium shows that the cookie store and the
 * navigation headers actually reach the request, and that `did-navigate`
 * reports the redirect the service turns into its landing header.
 * @param {{ endpoint: string, token: string }} service - the running service.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function sessionCase(service) {
  const site = await sessionSite()
  try {
    const issues = `${site.origin}/issues`

    const anonymous = await post(service, { url: issues, ...VIEWPORT })
    check(anonymous.status === 200, `a page behind a session answered ${anonymous.status} without one`)
    check(
      anonymous.headers.get('x-dsh-render-landed-url') === `${site.origin}/login`,
      `the reply says where the render actually landed: ${anonymous.headers.get('x-dsh-render-landed-url')}`,
    )
    await anonymous.arrayBuffer()

    const withCookie = await post(service, { url: issues, ...VIEWPORT, cookies: [cookieFor(site.origin)] })
    check(withCookie.status === 200, `the same page with a cookie answered ${withCookie.status}`)
    check(withCookie.headers.get('x-dsh-render-landed-url') === null, 'a cookie reaches the request, so the render stays on the page it asked for')
    await withCookie.arrayBuffer()

    // The same service, the next request: a render starts from an empty cookie
    // store however the one before it ended, because each holds its own
    // non-persistent partition and nothing outlives the window.
    const after = await post(service, { url: issues, ...VIEWPORT })
    check(after.status === 200, `the next render without a cookie answered ${after.status}`)
    check(
      after.headers.get('x-dsh-render-landed-url') === `${site.origin}/login`,
      "the render after a signed-in one is signed out again: the partition's cookies did not outlive it",
    )
    check(!lastRequest(site.observed, '/issues').cookie, 'and the site received no cookie on it')
    await after.arrayBuffer()

    const withHeader = await post(service, { url: issues, ...VIEWPORT, headers: { 'x-session': 'abc' } })
    check(withHeader.status === 200, `the same page with a header answered ${withHeader.status}`)
    check(withHeader.headers.get('x-dsh-render-landed-url') === null, 'an extra header reaches the navigation too')
    await withHeader.arrayBuffer()
  } finally {
    await site.close()
  }
}

/**
 * A render sent to a sign-in page that then never finishes loading: the one
 * case where the two halves of the 504 line meet, since only a real Chromium
 * both follows the redirect `did-navigate` reports and leaves the image the
 * pending list names in flight.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function redirectTimeoutCase() {
  const listener = await hangingListener()
  const site = await sessionSite(`http://127.0.0.1:${listener.port}/avatar.png`)
  const service = await startRenderService({
    renderer: renderInHiddenWindow,
    limits: { ...RENDER_LIMITS, timeoutMs: HANG_TIMEOUT_MS },
  })
  try {
    const response = await post(service, { url: `${site.origin}/issues`, ...VIEWPORT })
    check(response.status === 504, `a render redirected to a page that never loads answered ${response.status}`)
    const line = (await response.text()).trim()
    console.log(`      ${line}`)
    check(line.includes(`at ${site.origin}/login`), 'the 504 line says the render landed on the sign-in page')
    check(
      line.includes('pass cookies or headers to capture it with a session'),
      'the 504 line says what to send to reach the page that was asked for',
    )
  } finally {
    await service.close()
    await site.close()
    await listener.close()
  }
}

/**
 * What the last request the site received for one path carried.
 * @param {{ path: string, cookie: boolean, header: boolean }[]} observed - every request the site received, in order.
 * @param {string} path - the path asked about.
 * @returns {{ path: string, cookie: boolean, header: boolean }} that request's session markers.
 * @throws when the site never received a request for that path, which is itself the failure.
 */
function lastRequest(observed, path) {
  const seen = observed.findLast(entry => entry.path === path)
  if (seen === undefined) throw new Error(`FAILED: the site received no request for ${path}`)
  return seen
}

/**
 * Render a page served from a nested path whose subresources are under a
 * different top-level one, and check what the site saw rather than what came
 * back as pixels.
 *
 * `session.cookies.set` with no `path` applies RFC 6265's default-path — the
 * directory of the URL it is set from — so a cookie set from `/app/issues/…`
 * covers `/app/issues/` and reaches no `/api/…` request the page makes. The
 * render still succeeds and still looks signed in, which is why a case that
 * serves everything from one directory passes either way. The header half is
 * the counterpart: `extraHeaders` rides the main-frame navigation and reaches
 * no subresource at all, which is why a session belongs in `cookies`.
 * @param {{ endpoint: string, token: string }} service - the running service.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function subresourceCase(service) {
  const site = await sessionSite()
  try {
    const page = `${site.origin}${NESTED.page}`

    const withCookie = await post(service, { url: page, ...VIEWPORT, cookies: [cookieFor(site.origin)] })
    check(withCookie.status === 200, `a page under a nested path answered ${withCookie.status} with a cookie`)
    await withCookie.arrayBuffer()
    check(lastRequest(site.observed, NESTED.page).cookie, 'the cookie reaches the document')
    check(lastRequest(site.observed, NESTED.sibling).cookie, "the cookie reaches a subresource under the page's own directory")
    check(lastRequest(site.observed, NESTED.api).cookie, 'the cookie reaches a subresource under another top-level path')

    const withHeader = await post(service, { url: page, ...VIEWPORT, headers: { 'x-session': 'abc' } })
    check(withHeader.status === 200, `the same page answered ${withHeader.status} with a header`)
    await withHeader.arrayBuffer()
    check(lastRequest(site.observed, NESTED.page).header, 'an extra header reaches the navigation')
    check(!lastRequest(site.observed, NESTED.api).header, 'an extra header reaches no subresource')
  } finally {
    await site.close()
  }
}

/**
 * Render a page under a user agent the request names, and one under the shell's
 * own default.
 *
 * The assertion is about what the site received rather than what came back as
 * pixels: only a real Chromium shows that the override reaches the document,
 * the subresources under another path, and the page's own `navigator`, and that
 * a render naming none still says Electron.
 * @param {{ endpoint: string, token: string }} service - the running service.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function userAgentCase(service) {
  const site = await sessionSite()
  try {
    const page = `${site.origin}${NESTED.page}`

    const named = await post(service, { url: page, ...VIEWPORT, userAgent: CLEAN_USER_AGENT })
    check(named.status === 200, `a render naming a user agent answered ${named.status}`)
    await named.arrayBuffer()
    check(lastRequest(site.observed, NESTED.page).userAgent === CLEAN_USER_AGENT, 'the document is requested under the user agent that was named')
    check(lastRequest(site.observed, NESTED.api).userAgent === CLEAN_USER_AGENT, 'so is a subresource under another top-level path')
    check(
      !site.observed.some(entry => entry.userAgent.includes('Electron')),
      'no request of that render names Electron',
    )

    const byDefault = await post(service, { url: page, ...VIEWPORT })
    check(byDefault.status === 200, `a render naming none answered ${byDefault.status}`)
    await byDefault.arrayBuffer()
    const fallback = lastRequest(site.observed, NESTED.page).userAgent
    console.log(`      default user agent: ${fallback}`)
    check(fallback.includes('Electron'), 'a render that names none reports Electron, which is what the field exists to replace')
  } finally {
    await site.close()
  }
}

/**
 * A page whose only image hangs, rendered twice: once under a deadline it
 * cannot meet with `onTimeout: capture`, and once with that host in
 * `blockHosts`.
 *
 * Only a real Chromium shows the two halves this exists for — that
 * `capturePage` on a window whose page never finished loading returns the
 * frame it had painted, and that cancelling in `onBeforeRequest` really stops
 * the request the first render sat waiting for.
 * @param {{ endpoint: string, token: string }} service - the running service, on the shell's own deadline.
 * @param {string} directory - the temporary directory the page is written into.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function partialCaptureCase(service, directory) {
  const listener = await hangingListener()
  const image = `http://127.0.0.1:${listener.port}/hang.png`
  const page = join(directory, 'partial.html')
  await writeFile(page, `<!doctype html><meta charset="utf-8"><title>partial</title>
<style>body { margin: 0; background: #123 }</style><p>painted<img src="${image}" alt="">`)
  const url = pathToFileURL(page).href
  try {
    const partial = await post(service, { url, ...VIEWPORT, timeoutMs: HANG_TIMEOUT_MS, onTimeout: 'capture' })
    check(partial.status === 200, `a page whose image never answers, asked to capture, answered ${partial.status}`)
    const partialReport = reportOf(partial)
    const captured = pngSize(Buffer.from(await partial.arrayBuffer()))
    console.log(`      outcome=${partialReport.outcome} painted=${String(partialReport.firstPaint)} pending=${String(partialReport.requests.pending)} host=${partialReport.hosts[0]?.host ?? 'none'}`)
    check(partialReport.outcome === 'timeout', 'the report labels the capture a timeout')
    check(partialReport.capture?.partial === true, 'the report says the image is partial')
    check(partialReport.loadEventFired === false, 'the report says the load event never fired')
    check(
      captured.width === VIEWPORT.width && captured.height === VIEWPORT.height,
      `the partial capture is the requested viewport: ${captured.width}x${captured.height}`,
    )
    check(partialReport.requests.pending >= 1, `the report counts the request still in flight (${String(partialReport.requests.pending)})`)
    check(partialReport.hosts[0]?.host === '127.0.0.1', 'the report names the host the page is waiting on')

    const blocked = await post(service, { url, ...VIEWPORT, timeoutMs: HANG_TIMEOUT_MS, blockHosts: ['127.0.0.1'] })
    check(blocked.status === 200, `the same page with that host blocked answered ${blocked.status}`)
    const blockedReport = reportOf(blocked)
    await blocked.arrayBuffer()
    console.log(`      outcome=${blockedReport.outcome} blocked=${String(blockedReport.requests.blocked)} elapsed=${String(blockedReport.elapsedMs)}ms`)
    check(blockedReport.outcome === 'complete', 'blocking the host lets the render finish inside its deadline')
    check(blockedReport.requests.blocked >= 1, `the report counts what it cancelled (${String(blockedReport.requests.blocked)})`)
    check(blockedReport.loadEventFired === true, 'the load event fires once nothing is waiting on that host')
    check(blockedReport.capture?.partial === false, 'a complete render says its capture is not partial')
  } finally {
    await listener.close()
  }
}

/**
 * A page that logs an error, which is the only way to see that
 * `console-message` reaches the report at all.
 * @param {{ endpoint: string, token: string }} service - the running service.
 * @param {string} directory - the temporary directory the page is written into.
 * @returns {Promise<void>} resolves when the case passed; rejects when it did not.
 */
async function consoleCase(service, directory) {
  const page = join(directory, 'noisy.html')
  await writeFile(page, `<!doctype html><meta charset="utf-8"><title>noisy</title>
<script>console.error('smoke: the page said this'); console.warn('smoke: and this')</script><p>noisy`)
  const response = await post(service, { url: pathToFileURL(page).href, ...VIEWPORT })
  check(response.status === 200, `a page that logs an error answered ${response.status}`)
  const report = reportOf(response)
  await response.arrayBuffer()
  console.log(`      errors=${String(report.console.errors)} warnings=${String(report.console.warnings)} sample=${report.console.samples[0] ?? 'none'}`)
  check(report.console.errors >= 1, 'the report counts the error the page logged')
  check(report.console.samples[0]?.includes('the page said this') === true, 'the report quotes the message')
  check(report.console.warnings >= 1, 'the report counts the warning too')
  check(report.mainDocument?.title === 'noisy', `the report carries the page title: ${report.mainDocument?.title ?? 'none'}`)
}

/**
 * Render every case against a real Chromium.
 * @returns {Promise<void>} resolves when every case passed; rejects on the first that did not.
 */
async function run() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-render-smoke-'))
  const page = join(directory, 'page.html')
  await writeFile(page, PAGE)
  const url = pathToFileURL(page).href
  const service = await startRenderService({ renderer: renderInHiddenWindow, limits: RENDER_LIMITS })
  try {
    console.log(`render-smoke: service on ${service.endpoint}`)

    const viewport = await post(service, { url, ...VIEWPORT })
    check(viewport.status === 200, `viewport render answered ${viewport.status}`)
    check(viewport.headers.get('content-type') === 'image/png', 'viewport render is image/png')
    const viewportReport = reportOf(viewport)
    check(viewportReport.outcome === 'complete', 'the render report says the page completed')
    check(
      viewportReport.capture?.width === VIEWPORT.width && viewportReport.capture.height === VIEWPORT.height,
      `the report names the size it captured: ${String(viewportReport.capture?.width)}x${String(viewportReport.capture?.height)}`,
    )
    check(viewportReport.firstPaint, 'the report says the window painted')
    const captured = pngSize(Buffer.from(await viewport.arrayBuffer()))
    check(
      captured.width === VIEWPORT.width && captured.height === VIEWPORT.height,
      `capture is exactly the requested viewport: ${captured.width}x${captured.height}`,
    )

    const full = await post(service, { url, ...VIEWPORT, fullPage: true })
    check(full.status === 200, `full-page render answered ${full.status}`)
    const fullSize = pngSize(Buffer.from(await full.arrayBuffer()))
    check(fullSize.width === VIEWPORT.width, `full-page capture keeps the requested width (${fullSize.width})`)
    check(fullSize.height > captured.height, `full-page capture is taller: ${fullSize.height} > ${captured.height}`)

    const delayed = await post(service, { url, ...VIEWPORT, delayMs: 200 })
    check(delayed.status === 200, `delayed render answered ${delayed.status}`)
    await delayed.arrayBuffer()

    const missing = await post(service, { url: pathToFileURL(join(directory, 'absent.html')).href, ...VIEWPORT })
    check(missing.status === 500, `a page that cannot load answered ${missing.status}`)
    check((await missing.text()).includes('ERR_FILE_NOT_FOUND'), 'the load failure carries the Chromium error code')

    const unauthorized = await post(service, { url, ...VIEWPORT }, '0'.repeat(64))
    check(unauthorized.status === 401, `a wrong token answered ${unauthorized.status}`)
    await unauthorized.text()

    const unrenderable = await post(service, { url: 'data:text/html,<p>x', ...VIEWPORT })
    check(unrenderable.status === 422, `a data: URL answered ${unrenderable.status}`)
    await unrenderable.text()

    await sessionCase(service)
    await subresourceCase(service)
    await userAgentCase(service)
    await consoleCase(service, directory)
    await partialCaptureCase(service, directory)
    await hungImageCase(directory)
    await redirectTimeoutCase()
  } finally {
    await service.close()
    await rm(directory, { recursive: true, force: true })
  }
}

// A destroyed render window is the last window of the run on Windows and
// Linux, where that would end the app by default before the next case runs.
app.on('window-all-closed', () => {})

// A callback rather than a top-level await: Electron fires `ready` only after
// the entry module finishes evaluating, so awaiting `whenReady()` at the top
// level of an ESM main process deadlocks.
void app.whenReady().then(run).then(
  () => {
    console.log('render-smoke: PASS')
    app.exit(0)
  },
  (error) => {
    console.error(`render-smoke: ${error instanceof Error ? error.message : String(error)}`)
    app.exit(1)
  },
)
