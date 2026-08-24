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
 * The isolation is also what makes a request's own headers and cookies safe to
 * honour: they are set on this window's in-memory session, so a caller renders
 * a page as whoever it has credentials for without either the credential or
 * anything the page stores reaching the session the user is signed in to.
 *
 * A capture is returned at the CSS-pixel size the request asked for. The
 * window keeps the display's own scale factor — forcing one is a process-wide
 * switch that would reach the user's visible window — so a 2x capture is
 * downsampled here instead, which is why the same request produces the same
 * image on any display.
 *
 * It also feeds the service's [[RenderTrace]] with everything the render's
 * report is built from — where the render got to, where the main frame landed
 * and what it was called, whether anything painted, what the page logged, what
 * became of the render process, and every request the page made — all from
 * main-process events and the session's non-blocking `webRequest` hooks. Those
 * observe; the blocking hooks hold each request until their callback runs, so a
 * diagnostic built on them would change the timing it reports. The one blocking
 * hook here is registered only for a request that carries `blockHosts`, where
 * cancelling is the point rather than a side effect, so a render that names
 * none is timed exactly as it was before.
 *
 * The window is also lent to the service as a capture it can take at any
 * moment, which is what lets a deadline answer with the pixels a page had
 * already painted instead of only a 504.
 * @module @deepseek-ai/dsh-desktop/render-window
 */

import { randomUUID } from 'node:crypto'
import { BrowserWindow } from 'electron'
import type { NativeImage, Session } from 'electron'
import { blockedByPattern } from './render-service.ts'
import type { Capture, RenderRequest, Renderer } from './render-service.ts'

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
 * The extra-header string `loadURL` takes: one `Name: value` per line.
 * @param headers - the accepted request's headers.
 * @returns the joined value, which the service has already checked carries no newline.
 */
function extraHeaders(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join('\n')
}

/**
 * Put the request's cookies on this render's own session before the load.
 *
 * They are set through the cookie store rather than sent as a header because
 * that is what makes them reach the page's subresources too: a signed-in page
 * whose images all 401 is not the page the caller asked to see.
 *
 * `path` is given explicitly because Chromium otherwise applies RFC 6265's
 * default-path, which is the *directory* of `url` rather than the site: a
 * cookie set for `/app/issues/list` would cover `/app/issues/` and reach none
 * of the `/api/…` requests the page makes. The caller named a cookie for the
 * site rather than for a directory, and a real session cookie is issued with
 * `Path=/`. A site-wide cookie reaches no further than this render either way:
 * the session is the window's own in-memory one loading a single page, and it
 * is gone when the window is. No `domain` is set, which keeps the cookie
 * host-only — the caller supplied a credential for this host and no other.
 * @param session - the render's own session.
 * @param url - the page being rendered, whose host the cookies are scoped to.
 * @param cookies - the accepted request's cookies, by name.
 * @returns resolves once every cookie is stored.
 * @throws when Chromium refuses a cookie for this URL.
 */
async function applyCookies(session: Session, url: string, cookies: Record<string, string>): Promise<void> {
  for (const [name, value] of Object.entries(cookies)) {
    await session.cookies.set({ url, name, value, path: '/' })
  }
}

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
 * Bring a capture to the CSS-pixel size that was asked for.
 *
 * `capturePage` returns a bitmap at the display's scale factor, so the same
 * request produces 900x700 on a 1x display and 1800x1400 on a Retina one —
 * neither the number the caller asked for nor a fact about the page. The
 * window keeps its native scale, because forcing one would apply to every
 * window in the process including the user's own; the capture is downsampled
 * instead, which loses nothing a 1x render would have had.
 * @param image - what `capturePage` returned.
 * @param width - the requested viewport width in CSS pixels.
 * @param height - the content height the window was set to, in CSS pixels.
 * @returns the image at exactly that size, or the original when it is already that size.
 */
function atRequestedSize(image: NativeImage, width: number, height: number): NativeImage {
  const captured = image.getSize()
  if (captured.width === width && captured.height === height) return image
  return image.resize({ width, height, quality: 'best' })
}

/**
 * Render one page in a hidden window and encode what it shows.
 *
 * The window is destroyed on every exit — the reply, a load failure, and the
 * service's abort — because it is an operating-system resource that nothing
 * else in this process holds a reference to.
 * @param request - the accepted request.
 * @param signal - aborted when the service's deadline passes.
 * @param trace - fed everything the render's report is built from: its phase, the main frame's landing and
 * title, what the page logged, and every request it made.
 * @param offerCapture - handed the capture this window can take at any moment, which is what a deadline
 * carrying `onTimeout: 'capture'` answers with.
 * @returns the capture, at the CSS-pixel size the request asked for.
 * @throws when the page fails to load, when the render is aborted, or when the capture fails.
 */
export const renderInHiddenWindow: Renderer = async (request, signal, trace, offerCapture) => {
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
  // The CSS-pixel height a capture is brought back to: the viewport, or what a
  // full-page render measured and resized the window to. A capture taken at the
  // deadline reads whatever it is at that moment, which for a page that never
  // reached the measurement is the viewport the request asked for.
  let contentHeight = request.height
  /**
   * Take the window as it stands.
   * @returns the encoded PNG and the CSS-pixel size it is at.
   */
  const captureNow = async (): Promise<Capture> => {
    const image = atRequestedSize(await window.webContents.capturePage(), request.width, contentHeight)
    return { png: image.toPNG(), width: request.width, height: contentHeight }
  }
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
    window.webContents.on('did-redirect-navigation', (details) => {
      if (details.isMainFrame) trace.mainDocumentRedirected()
    })
    window.webContents.on('page-title-updated', (_event, title) => { trace.pageTitle(title) })
    // Electron exposes no first-paint event; `ready-to-show` is the frame it
    // has, and it fires for a window that is never shown only because
    // `paintWhenInitiallyHidden` is set. It is what says whether a capture
    // taken at the deadline can carry anything at all.
    window.once('ready-to-show', () => { trace.firstPaint() })
    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame) trace.mainFrameFailed(errorCode, errorDescription)
    })
    // The deprecated positional arguments beside `details` carry the same
    // message with a numeric level; `details.level` is the named one.
    window.webContents.on('console-message', (details) => { trace.consoleMessage(details.level, details.message) })
    window.webContents.on('render-process-gone', (_event, details) => { trace.rendererGone(details.reason) })
    window.webContents.on('unresponsive', () => { trace.rendererUnresponsive() })
    // The one blocking hook, and only for a request that asked for it.
    // `onBeforeRequest` holds every request until its callback runs, so a
    // render that named no `blockHosts` registers nothing and keeps the timing
    // the rest of these hooks report. Cancelling here is before the connection
    // is made, so a blocked host costs the render nothing at all.
    if (request.blockHosts !== undefined) {
      const patterns = request.blockHosts
      session.webRequest.onBeforeRequest((details, callback) => {
        const cancel = blockedByPattern(patterns, details.url)
        if (cancel) trace.requestBlocked(details.url)
        callback({ cancel })
      })
    }
    // The non-blocking hooks. These three observe rather than hold, which is
    // what keeps them out of the timing they report. `onSendHeaders` fires
    // before the connection is made, so a request stuck in TCP connect counts
    // as pending — which is the case this exists for. A response served from
    // the cache reaches `onCompleted` without ever having sent headers, and a
    // request cancelled above reaches `onErrorOccurred` the same way, so the
    // ids the hooks see are not the same set; settling an id that was never
    // started is a no-op.
    session.webRequest.onSendHeaders((details) => {
      trace.requestStarted(details.id, details.url, details.resourceType)
    })
    session.webRequest.onCompleted((details) => { trace.requestCompleted(details.id, details.statusCode) })
    session.webRequest.onErrorOccurred((details) => { trace.requestFailed(details.id, details.error) })
    offerCapture(captureNow)
    // Before the navigation, so the first request already carries the session.
    if (request.cookies !== undefined) await applyCookies(session, request.url, request.cookies)
    trace.enter('navigating')
    // Resolves on did-finish-load and rejects on did-fail-load, whose error
    // message carries the Chromium error code (`ERR_FILE_NOT_FOUND`).
    await window.loadURL(request.url, request.headers === undefined ? {} : { extraHeaders: extraHeaders(request.headers) })
    trace.enter('loaded')
    // A page that set its title before the listener above was registered still
    // has it here, and a `file:` page whose title Chromium synthesized has one
    // at all only through this read.
    trace.pageTitle(window.webContents.getTitle())
    if (request.delayMs > 0) {
      trace.enter('delaying')
      await delay(request.delayMs, signal)
    }
    if (request.fullPage) {
      trace.enter('measuring')
      contentHeight = await fullPageHeight(window, request)
      if (contentHeight !== request.height) {
        trace.enter('resizing')
        window.setContentSize(request.width, contentHeight)
        await delay(RESIZE_SETTLE_MS, signal)
      }
    }
    trace.enter('capturing')
    return await captureNow()
  } finally {
    signal.removeEventListener('abort', destroy)
    destroy()
  }
}
