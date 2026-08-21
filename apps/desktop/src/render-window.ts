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
 * open refused.
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
 * @returns the encoded PNG.
 * @throws when the page fails to load, when the render is aborted, or when the capture fails.
 */
export const renderInHiddenWindow: Renderer = async (request, signal) => {
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
    const session = window.webContents.session
    // Both handlers: the asynchronous one covers a page that asks, and the
    // synchronous check is the path a page that merely queries goes down.
    session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    session.setPermissionCheckHandler(() => false)
    session.on('will-download', (event) => { event.preventDefault() })
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // Resolves on did-finish-load and rejects on did-fail-load, whose error
    // message carries the Chromium error code (`ERR_FILE_NOT_FOUND`).
    await window.loadURL(request.url)
    if (request.delayMs > 0) await delay(request.delayMs, signal)
    if (request.fullPage) {
      const height = await fullPageHeight(window, request)
      if (height !== request.height) {
        window.setContentSize(request.width, height)
        await delay(RESIZE_SETTLE_MS, signal)
      }
    }
    return (await window.webContents.capturePage()).toPNG()
  } finally {
    signal.removeEventListener('abort', destroy)
    destroy()
  }
}
