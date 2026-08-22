/**
 * Post-build smoke for the render service, run inside a real Electron main
 * process: `pnpm --filter @deepseek-ai/dsh-desktop run render-smoke`.
 *
 * The unit suite drives the protocol against an injected renderer, which is
 * everything except the part that needs a Chromium — so this is the check that
 * a hidden `BrowserWindow` actually paints, that `capturePage` returns the
 * requested viewport, and that a full-page capture grows past it. It renders a
 * local file, so it needs no network, and it uses the shell's own limits.
 *
 * Requires `pnpm --filter @deepseek-ai/dsh-desktop run build:ts` first: this
 * runs under Electron, which has no TypeScript loader, so it imports `lib/`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { RENDER_LIMITS, startRenderService } from '../lib/render-service.js'
import { renderInHiddenWindow } from '../lib/render-window.js'

/** The viewport every case renders at. */
const VIEWPORT = { width: 400, height: 300 }

/** The page: a solid block taller than the viewport, so a full-page capture is visibly taller. */
const PAGE = `<!doctype html><meta charset="utf-8"><title>render smoke</title>
<style>body { margin: 0 } .block { height: 900px; background: linear-gradient(#123, #abc) }</style>
<div class="block">render smoke</div>`

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
    const scale = captured.width / VIEWPORT.width
    check(Number.isInteger(scale) && scale >= 1, `capture is ${captured.width}x${captured.height} at scale ${scale}`)
    check(captured.height === VIEWPORT.height * scale, 'capture height is the requested viewport height')

    const full = await post(service, { url, ...VIEWPORT, fullPage: true })
    check(full.status === 200, `full-page render answered ${full.status}`)
    const fullSize = pngSize(Buffer.from(await full.arrayBuffer()))
    check(fullSize.width === captured.width, `full-page capture keeps the width (${fullSize.width})`)
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
