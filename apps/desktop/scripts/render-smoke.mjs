/**
 * Post-build smoke for the render service, run inside a real Electron main
 * process: `pnpm --filter @deepseek-ai/dsh-desktop run render-smoke`.
 *
 * The unit suite drives the protocol against an injected renderer, which is
 * everything except the part that needs a Chromium — so this is the check that
 * a hidden `BrowserWindow` actually paints, that `capturePage` returns the
 * requested viewport, that a full-page capture grows past it, that a request's
 * cookies reach every request the page makes while its headers reach only the
 * navigation, and that the `webRequest` hooks a timed-out render is described
 * from see a real page's real requests. It renders local files and pages from
 * listeners on this machine, so it needs no network, and it uses the shell's
 * own limits.
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
    const line = (await response.text()).trim()
    console.log(`      ${line}`)
    check(line.includes('load event not fired'), 'the 504 line says the load event never fired')
    check(line.includes(`[image] ${image}`), 'the 504 line names the image the page is still waiting for')
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
 * @returns {Promise<{ origin: string, observed: { path: string, cookie: boolean, header: boolean }[], close: () => Promise<void> }>} the origin it serves, what it received, and its shutdown.
 */
async function sessionSite() {
  /** @type {{ path: string, cookie: boolean, header: boolean }[]} */
  const observed = []
  const server = createHttpServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://site.invalid').pathname
    const cookie = (request.headers.cookie ?? '').includes('session=abc')
    const header = request.headers['x-session'] === 'abc'
    observed.push({ path, cookie, header })
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
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(path === NESTED.page
      ? NESTED_PAGE
      : `<!doctype html><meta charset="utf-8"><title>${signedIn ? 'issues' : 'sign in'}</title><p>${path}`)
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

    const withCookie = await post(service, { url: issues, ...VIEWPORT, cookies: { session: 'abc' } })
    check(withCookie.status === 200, `the same page with a cookie answered ${withCookie.status}`)
    check(withCookie.headers.get('x-dsh-render-landed-url') === null, 'a cookie reaches the request, so the render stays on the page it asked for')
    await withCookie.arrayBuffer()

    const withHeader = await post(service, { url: issues, ...VIEWPORT, headers: { 'x-session': 'abc' } })
    check(withHeader.status === 200, `the same page with a header answered ${withHeader.status}`)
    check(withHeader.headers.get('x-dsh-render-landed-url') === null, 'an extra header reaches the navigation too')
    await withHeader.arrayBuffer()
  } finally {
    await site.close()
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

    const withCookie = await post(service, { url: page, ...VIEWPORT, cookies: { session: 'abc' } })
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
    await hungImageCase(directory)
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
