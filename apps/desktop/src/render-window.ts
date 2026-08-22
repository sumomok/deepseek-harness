/**
 * The Electron half of the render service: one hidden `BrowserWindow` per
 * request, destroyed before the reply is written.
 *
 * Everything here is deliberately thin, because none of it can run outside a
 * live Electron main process — the protocol, its validation and its bounds
 * live in [[@deepseek-ai/dsh-desktop/render-service]], which is what the unit
 * suite drives. What this module owns is the isolation each render runs under:
 * a fresh in-memory session per request (no `persist:` prefix), so a page can
 * neither read nor write the cookies, storage, or caches of the window the
 * user is working in; no Node integration, no `webview`, no devtools; every
 * permission request denied; every download and every window the page tries to
 * open refused; no dialogs and no audio.
 *
 * The last two are about the machine rather than the page's data. `alert()`,
 * `confirm()`, and `prompt()` open a native modal attached to a window with
 * `show: false`, which the user sees as a system dialog from nowhere that
 * nothing on screen explains, and the page's main thread blocks until it is
 * dismissed — which is also what strands `fullPage`'s `executeJavaScript`.
 * Electron's default `autoplayPolicy` is `no-user-gesture-required`, so an
 * `<audio autoplay>` on a rendered page plays out of the user's speakers; a
 * capture wants pixels only, so muting costs the render nothing.
 *
 * It also feeds the service's [[RenderTrace]] with where the render got to,
 * where the main frame landed, and which requests are still in flight, from
 * `did-navigate` and the session's non-blocking `webRequest` hooks. Those
 * observe; the blocking hooks hold each request until their callback runs, so
 * a diagnostic built on them would change the timing it reports.
 * @module @deepseek-ai/dsh-desktop/render-window
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { RenderRequest, Renderer } from './render-service.ts'

/**
 * The tallest full-page capture produced. A document with an infinite scroller
 * reports a height that grows while it is measured, and a window sized to it
 * is a bitmap large enough to exhaust the machine's memory; the capture is
 * truncated at this height instead.
 */
const MAX_FULL_PAGE_HEIGHT = 8192

/**
 * How long a resized window is given to produce a frame at its new size.
 * `setContentSize` returns before the compositor has drawn anything, and
 * `capturePage` would otherwise return the previous size. A fixed wait rather
 * than a `requestAnimationFrame` round trip, because a window that is never
 * shown is exactly the case where the renderer may not schedule frames.
 */
const RESIZE_SETTLE_MS = 150

/**
 * Wait, or fail as soon as the render is abandoned.
 * @param ms - how long to wait.
 * @param signal - the render's abort signal.
 * @returns resolves after `ms`; rejects immediately when the render is aborted.
 */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, ms)
  const abort = (): void => { reject(new Error('render aborted')) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    await promise
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/**
 * The content height a full-page capture should use.
 * @param window - the loaded window to measure.
 * @param request - the accepted request, whose height is the floor and the fallback.
 * @returns the height in CSS pixels, never below the viewport and never above {@link MAX_FULL_PAGE_HEIGHT}.
 */
async function fullPageHeight(window: BrowserWindow, request: RenderRequest): Promise<number> {
  const measured = await window.webContents.executeJavaScript('document.documentElement.scrollHeight') as unknown
  if (typeof measured !== 'number' || !Number.isFinite(measured)) return request.height
  return Math.min(Math.max(Math.ceil(measured), request.height), MAX_FULL_PAGE_HEIGHT)
}

/**
 * Render one page in a hidden window and encode what it shows.
 *
 * The window is destroyed on every exit — the reply, a load failure, and the
 * service's abort — because it is an operating-system resource that nothing
 * else in this process holds a reference to.
 * @param request - the accepted request.
 * @param signal - aborted when the service's deadline passes.
 * @param trace - fed the phase this render is in, the main frame's landing, and the requests still in flight.
 * @returns the encoded PNG.
 * @throws when the page fails to load, when the render is aborted, or when the capture fails.
 */
export const renderInHiddenWindow: Renderer = async (request, signal, trace) => {
  const window = new BrowserWindow({
    show: false,
    // The requested size is the viewport, not the window frame around it.
    useContentSize: true,
    width: request.width,
    height: request.height,
    // A full-page capture is routinely taller than the display, which macOS
    // refuses for an ordinary window.
    enableLargerThanScreen: true,
    // What makes a window that is never shown paint at all.
    paintWhenInitiallyHidden: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      devTools: false,
      // `alert()`, `confirm()`, and `prompt()` become no-ops instead of a
      // native modal the user cannot account for and a blocked page thread.
      disableDialogs: true,
      // A hidden window is a background window, and a throttled one stops
      // painting — which is the frame this render is here to capture.
      backgroundThrottling: false,
      // No `persist:` prefix: the session lives in memory and dies with the
      // window, so nothing a rendered page stores outlives the request or
      // reaches the session the user's own window runs in.
      partition: `render:${randomUUID()}`,
    },
  })
  const destroy = (): void => {
    if (!window.isDestroyed()) window.destroy()
  }
  signal.addEventListener('abort', destroy, { once: true })
  try {
    // Before the load, so a page that starts playing on load is already silent.
    window.webContents.setAudioMuted(true)
    const session = window.webContents.session
    // Both handlers: the asynchronous one covers a page that asks, and the
    // synchronous check is the path a page that merely queries goes down.
    session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event) => { event.preventDefault() })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Where the main frame ended up, which is how a redirect to a login page
    // becomes visible in the line a timed-out render is answered with.
    // `httpResponseCode` is -1 for a navigation that carried no HTTP response.
    window.webContents.on('did-navigate', (_event, url, httpResponseCode) => {
      trace.mainDocument(url, httpResponseCode)
    })
    // The non-blocking hooks only. `onBeforeRequest` and the other blocking
    // ones hold each request until their callback runs, so a diagnostic built
    // on them would change the timing it is here to report; these three
    // observe. `onSendHeaders` fires before the connection is made, so a
    // request stuck in TCP connect counts as pending — which is the case this
    // exists for. A response served from the cache reaches `onCompleted`
    // without ever having sent headers, so the ids the hooks see are not the
    // same set; settling an id that was never started is a no-op.
    session.webRequest.onSendHeaders((details) => {
      trace.requestStarted(details.id, details.url, details.resourceType)
    })
    session.webRequest.onCompleted((details) => { trace.requestSettled(details.id) })
    session.webRequest.onErrorOccurred((details) => { trace.requestSettled(details.id) })
    trace.enter('navigating')
    // Resolves on did-finish-load and rejects on did-fail-load, whose error
    // message carries the Chromium error code (`ERR_FILE_NOT_FOUND`).
    await window.loadURL(request.url)
    trace.enter('loaded')
    if (request.delayMs > 0) {
      trace.enter('delaying')
      await delay(request.delayMs, signal)
    }
    if (request.fullPage) {
      trace.enter('measuring')
      const height = await fullPageHeight(window, request)
      if (height !== request.height) {
        trace.enter('resizing')
        window.setContentSize(request.width, height)
        await delay(RESIZE_SETTLE_MS, signal)
      }
    }
    trace.enter('capturing')
    return (await window.webContents.capturePage()).toPNG()
  } finally {
    signal.removeEventListener('abort', destroy)
    destroy()
  }
}
