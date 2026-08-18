/**
 * Electron main process of the DSH desktop client: start the embedded
 * `dsh web` server from the app resources (bundled Node runtime + deployed
 * server closure), open the served UI in a native window, and tear the
 * server down with the app. The window is a plain browser surface — no
 * preload, no Node integration; everything the UI can do goes through the
 * same `/api` transport the browser uses.
 *
 * Startup is observable by design: the window opens immediately on a boot
 * console that live-tails the main process's preflight checks and every
 * server output line (the same stream `dsh-server.log` persists), and a
 * failed start keeps that console on screen instead of exiting, so a
 * machine-specific fault arrives as a copyable log, not a guess.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
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

/** The boot console shown (and live-updated) until the server URL loads. */
const BOOT_PAGE = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><title>DSH Desktop</title><style>
  body { margin: 0; height: 100vh; display: flex; flex-direction: column; background: #10131a; color: #e6ebf5; font: 14px/1.6 system-ui, sans-serif; }
  header { padding: 22px 26px 10px; }
  .dot { display: inline-block; width: 8px; height: 8px; margin-right: 8px; border-radius: 50%; background: #3bc8ff; animation: p 1.2s infinite ease-in-out; vertical-align: 1px; }
  @keyframes p { 0%, 80%, 100% { opacity: .25 } 40% { opacity: 1 } }
  #status { display: inline; }
  .failed .dot { background: #ff5470; animation: none; }
  #log { flex: 1; margin: 8px 26px 10px; padding: 12px 14px; overflow: auto; background: #0b0e15; border: 1px solid #232a3a; border-radius: 8px; font: 12px/1.55 ui-monospace, Menlo, Consolas, monospace; color: #aeb7c9; white-space: pre-wrap; word-break: break-all; }
  footer { padding: 0 26px 16px; color: #8b93a7; font-size: 12px; user-select: text; }
</style></head><body>
<header><span class="dot"></span><span id="status">正在启动 dsh 服务…</span></header>
<pre id="log"></pre>
<footer id="meta"></footer>
<script>
  const logEl = document.getElementById('log')
  window.__dsh = {
    status(text, failed) {
      document.getElementById('status').textContent = text
      document.body.classList.toggle('failed', !!failed)
    },
    log(text) {
      const stick = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 8
      logEl.textContent = (logEl.textContent + text).slice(-60000)
      if (stick) logEl.scrollTop = logEl.scrollHeight
    },
    meta(text) { document.getElementById('meta').textContent = text },
  }
</script></body></html>`)

/** One window whose boot console the main process can push updates into. */
interface BootView {
  window: BrowserWindow
  /** Append raw log text to the console (no-op after the app UI loaded). */
  log: (text: string) => void
  /** Replace the status line; `failed: true` switches the indicator to red. */
  status: (text: string, failed?: boolean) => void
  /** Set the footer line (log-file location). */
  meta: (text: string) => void
  /** Stop pushing and load the served UI. */
  showApp: (url: string) => void
}

/** Open the window on the boot console and return its update handle. */
function createBootWindow(): BootView {
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
  void window.loadURL(BOOT_PAGE)
  let booting = true
  const push = (script: string): void => {
    if (!booting || window.isDestroyed()) return
    window.webContents.executeJavaScript(script).catch(() => {
      // The page may still be loading or already gone; the log file has
      // everything this push carried.
    })
  }
  return {
    window,
    log: (text) => { push(`window.__dsh.log(${JSON.stringify(text)})`) },
    status: (text, failed = false) => { push(`window.__dsh.status(${JSON.stringify(text)}, ${String(failed)})`) },
    meta: (text) => { push(`window.__dsh.meta(${JSON.stringify(text)})`) },
    showApp: (url) => {
      booting = false
      if (!window.isDestroyed()) void window.loadURL(url)
    },
  }
}

/** Open a plain window directly on the served UI (reopen path). */
function createAppWindow(url: string): void {
  const view = createBootWindow()
  view.showApp(url)
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
      createAppWindow(server.url)
    }
  })

  app.on('window-all-closed', () => {
    // macOS keeps the app (and its server) alive in the Dock; elsewhere the
    // last window ends the app.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server !== undefined) {
      createAppWindow(server.url)
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
    const view = createBootWindow()
    const logDir = app.getPath('logs')
    const logFile = join(logDir, 'dsh-server.log')
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // Logging must never block the app; a failed sink drops chunks only.
    }
    // One stream, two sinks: the durable file and the live boot console.
    const sink = (chunk: string): void => {
      try {
        appendFileSync(logFile, chunk)
      } catch {
        // Same best-effort contract: the UI keeps running without the file.
      }
      view.log(chunk)
    }
    view.meta(`日志文件: ${logFile}`)
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      view.status(`正在启动 dsh 服务…(${String(Math.round((Date.now() - startedAt) / 1000))}s;首次启动会被系统安全扫描拖慢)`)
    }, 1000)
    const spec = resolveSpec()
    sink(`[desktop] ${new Date().toISOString()} packaged=${String(app.isPackaged)} platform=${process.platform} arch=${process.arch}\n`)
    sink(`[desktop] node runtime: ${spec.nodeBin} (exists: ${String(existsSync(spec.nodeBin) || spec.nodeBin === 'node')})\n`)
    sink(`[desktop] server entry: ${spec.entry} (exists: ${String(existsSync(spec.entry))})\n`)
    sink(`[desktop] server cwd: ${spec.cwd}\n`)
    try {
      server = await startServer(spec, sink)
      clearInterval(ticker)
      sink(`[desktop] server ready at ${server.url}\n`)
      view.showApp(server.url)
    } catch (error) {
      clearInterval(ticker)
      const message = error instanceof Error ? error.message : String(error)
      sink(`[desktop] startup failed: ${message}\n`)
      // Keep the console on screen: the log above is the diagnosis surface.
      view.status('dsh 服务启动失败——完整输出在下方与日志文件中,可全选复制', true)
    }
  })
}
