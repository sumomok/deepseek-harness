/**
 * Electron main process of the DSH desktop client: start the embedded
 * `dsh web` server from the app resources (bundled Node runtime + deployed
 * server closure), open the served UI in a native window, and tear the
 * server down with the app. The window is a plain browser surface — no
 * preload, no Node integration; everything the UI can do goes through the
 * same `/api` transport the browser uses.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { startServer, type ServerHandle, type ServerSpec } from './server.ts'

/**
 * Resolve where the server lives for this launch. Packaged builds use the
 * app resources; a source-tree launch (`pnpm --filter @deepseek-ai/dsh-desktop
 * exec electron lib/main.js`) uses the checkout's built CLI on the
 * development Node found in PATH.
 * @returns the launch spec.
 */
function resolveSpec(): ServerSpec {
  const home = app.getPath('home')
  if (app.isPackaged) {
    const resources = process.resourcesPath
    return {
      nodeBin: join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      entry: join(resources, 'server', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      cwd: home,
    }
  }
  return {
    nodeBin: process.env.DSH_DESKTOP_NODE ?? 'node',
    entry: join(app.getAppPath(), '..', 'cli', 'lib', 'bin.js'),
    cwd: home,
  }
}

let server: ServerHandle | undefined
let quitting = false

/** Append one chunk to the session's server log; the file is best-effort. */
function makeLogSink(): (chunk: string) => void {
  const dir = app.getPath('logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Logging must never block the app; a failed sink drops chunks only.
  }
  const file = join(dir, 'dsh-server.log')
  return (chunk) => {
    try {
      appendFileSync(file, chunk)
    } catch {
      // Same best-effort contract as above: the UI keeps running without logs.
    }
  }
}

/** The boot page shown while the embedded server is still starting. */
const BOOT_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>DSH Desktop</title><style>
  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #10131a; color: #e6ebf5; font: 15px/1.6 system-ui, sans-serif; }
  .card { text-align: center; }
  .dot { display: inline-block; width: 9px; height: 9px; margin: 0 3px; border-radius: 50%; background: #3bc8ff; animation: p 1.2s infinite ease-in-out; }
  .dot:nth-child(2) { animation-delay: .2s } .dot:nth-child(3) { animation-delay: .4s }
  @keyframes p { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
  .hint { color: #8b93a7; font-size: 13px; margin-top: 10px }
</style></head><body><div class="card">
  <div><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>
  <div style="margin-top:14px">正在启动 dsh 服务…</div>
  <div class="hint">首次启动可能较慢(系统正在扫描新文件)</div>
</div></body></html>`)

/** Open one UI window; it shows the boot page until a server URL is loaded into it. */
function createWindow(url: string | undefined): BrowserWindow {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    backgroundColor: '#10131a',
    title: 'DSH Desktop',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  // The UI is same-origin; anything else opens in the system browser.
  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (server === undefined || !target.startsWith(server.url)) {
      event.preventDefault()
      if (target.startsWith('http')) void shell.openExternal(target)
    }
  })
  void window.loadURL(url ?? BOOT_PAGE)
  return window
}

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window !== undefined) {
      if (window.isMinimized()) window.restore()
      window.focus()
    } else if (server !== undefined) {
      createWindow(server.url)
    }
  })

  app.on('window-all-closed', () => {
    // macOS keeps the app (and its server) alive in the Dock; elsewhere the
    // last window ends the app.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server !== undefined) {
      createWindow(server.url)
    }
  })

  // Async teardown: hold the first quit, stop the server, then exit for real.
  app.on('before-quit', (event) => {
    if (quitting || server === undefined) return
    event.preventDefault()
    quitting = true
    void server.stop().finally(() => { app.exit(0) })
  })

  void app.whenReady().then(async () => {
    // The window opens immediately on the boot page: a cold Windows start can
    // sit in antivirus scanning for a while, and a silent delay reads as a
    // broken install.
    const window = createWindow(undefined)
    try {
      server = await startServer(resolveSpec(), makeLogSink())
      if (!window.isDestroyed()) void window.loadURL(server.url)
      else createWindow(server.url)
    } catch (error) {
      dialog.showErrorBox(
        'DSH Desktop could not start its server',
        `${error instanceof Error ? error.message : String(error)}\n\nFull log: ${join(app.getPath('logs'), 'dsh-server.log')}`,
      )
      app.exit(1)
    }
  })
}
