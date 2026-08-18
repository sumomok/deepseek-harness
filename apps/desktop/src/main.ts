/**
 * Electron main process of the DSH desktop client: start the embedded
 * `dsh web` server from the app resources (bundled Node runtime + deployed
 * server closure), open the served UI in a native window, and tear the
 * server down with the app. The window is a plain browser surface — no
 * preload, no Node integration; everything the UI can do goes through the
 * same `/api` transport the browser uses.
 *
 * The window opens immediately on a boot page that names the three startup
 * phases and how long the current one has taken. Server output goes to
 * `dsh-server.log` only: on screen a failure shows one summary line and the
 * path of that file, because a scrolling command-line panel is diagnosis
 * material for the developer who receives the log, not for the person waiting.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, shell } from 'electron'
import { startServer, type ServerHandle, type ServerSpec } from './server.ts'
import { launchGate, setupUpdates } from './updater.ts'

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

/** The window background, matched to the boot page so no white frame flashes. */
const WINDOW_BACKGROUND = '#0b101f'

/**
 * The boot page: a self-contained `data:` document (no external resource, no
 * preload) that the main process drives through `window.__dsh`. It shows one
 * phase at a time — the one actually running — because a checklist of things
 * that have not happened yet is a list of ways to wonder what went wrong.
 * @param version - the app version shown at the bottom of the page.
 * @returns the `data:` URL to load.
 */
function bootPage(version: string): string {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH Desktop</title><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: linear-gradient(135deg, #0B101F 0%, #111A33 100%);
    color: #F2F6FF; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
  }
  /* Dot grid and vignette, both purely decorative and both behind the column. */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background-image: radial-gradient(circle, rgba(255,255,255,.02) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 180px 40px rgba(4, 7, 16, .55);
  }
  main { position: relative; width: 100%; max-width: 460px; padding: 0 32px; }
  .glow {
    position: absolute; left: 4px; top: -88px; width: 320px; height: 320px;
    pointer-events: none; transform-origin: center;
    background: radial-gradient(circle, rgba(59, 200, 255, .08) 0%, rgba(59, 200, 255, 0) 68%);
    animation: breathe 8s ease-in-out infinite;
  }
  @keyframes breathe {
    0%, 100% { transform: scale(1); opacity: .75; }
    50% { transform: scale(1.12); opacity: 1; }
  }
  .enter { opacity: 0; animation: enter .32s ease-out forwards; }
  @keyframes enter { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .wordmark { position: relative; font-size: 40px; font-weight: 700; line-height: 1.15; animation-delay: 0ms; }
  /* The Chinese glyphs take a real CJK face; only the caret stays monospace,
     which is the one character a mono stack renders better than a text face. */
  .wordmark .zh {
    font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif;
    color: #F2F6FF; letter-spacing: .02em;
  }
  .caret {
    display: inline-block; margin-left: 8px; color: #3BC8FF;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
    animation: blink 1.1s steps(2) infinite;
  }
  @keyframes blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0; } }
  /* Fixed height and stacked rows: one phase replaces another without the
     column below it moving. */
  .phases { position: relative; height: 30px; margin-top: 36px; }
  .phase {
    position: absolute; inset: 0; display: flex; align-items: baseline; gap: 10px;
    font: 13px/2.1 ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
    color: #F2F6FF; opacity: 0; transition: opacity .28s ease;
  }
  .phase.showing { opacity: 1; }
  .mark { flex: none; width: 1em; color: #3BC8FF; animation: pulse 1.6s ease-in-out infinite; }
  .phase.failed .mark { color: #FF5470; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
  .label { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif; }
  .elapsed { color: #8B93A7; }
  .hint { position: relative; margin-top: 16px; font-size: 11px; color: #8B93A7; }
  .failure { position: relative; margin-top: 16px; display: none; }
  body.failed .failure { display: block; }
  .summary {
    font-size: 13px; color: #F2F6FF; word-break: break-all; user-select: text;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
  }
  .lead { margin-top: 12px; font-size: 13px; color: #8B93A7; }
  footer {
    position: fixed; left: 0; right: 0; bottom: 24px; text-align: center;
    font-size: 11px; color: #8B93A7;
    font-family: ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
  }
  @media (prefers-reduced-motion: reduce) {
    .glow, .caret, .mark, .enter { animation: none; }
    .enter { opacity: 1; }
  }
</style></head><body>
<main>
  <div class="glow"></div>
  <div class="wordmark enter"><span class="zh">从这里开始</span><span class="caret">▮</span></div>
  <div class="phases" id="phases">
    <div class="phase" data-phase="0"><span class="mark">◇</span><span class="label">校验运行环境</span><span class="elapsed"></span></div>
    <div class="phase" data-phase="1"><span class="mark">◇</span><span class="label">启动 dsh 服务</span><span class="elapsed"></span></div>
    <div class="phase" data-phase="2"><span class="mark">◇</span><span class="label">连接界面</span><span class="elapsed"></span></div>
  </div>
  <div class="hint" id="hint" hidden>首次启动会被系统安全扫描拖慢,通常最多一两分钟</div>
  <div class="failure" id="failure">
    <div class="summary" id="summary"></div>
    <div class="lead">完整日志:菜单 帮助 → 查看日志</div>
  </div>
</main>
<footer>v${version}</footer>
<script>
  const rows = [...document.querySelectorAll('.phase')]
  let current = 0
  setTimeout(() => { document.getElementById('hint').hidden = false }, 8000)
  window.__dsh = {
    phase(index) {
      current = index
      rows.forEach((row, position) => {
        row.classList.toggle('showing', position === index)
        if (position !== index) row.querySelector('.elapsed').textContent = ''
      })
    },
    elapsed(seconds) {
      const cell = rows[current]?.querySelector('.elapsed')
      if (cell) cell.textContent = seconds < 3 ? '' : ' · ' + seconds + 's'
    },
    fail(message) {
      const row = rows[current]
      if (row) {
        row.classList.add('failed')
        row.querySelector('.mark').textContent = '✕'
        row.querySelector('.elapsed').textContent = ''
      }
      document.getElementById('hint').hidden = true
      document.getElementById('summary').textContent = message
      document.body.classList.add('failed')
    },
    block(message) {
      const hint = document.getElementById('hint')
      hint.textContent = message
      hint.hidden = false
    },
  }
  window.__dsh.phase(0)
</script></body></html>`)
}

/** One window whose boot page the main process can drive. */
interface BootView {
  window: BrowserWindow
  /** Show `index` as the running phase and hide every other one. */
  phase: (index: number) => void
  /** Update the seconds suffix on the running phase. */
  elapsed: (seconds: number) => void
  /** Fail the running phase and show the error summary. */
  fail: (message: string) => void
  /** Replace the hint line with why the app is holding at this phase. */
  block: (message: string) => void
  /** Stop driving the boot page and load the served UI. */
  showApp: (url: string) => void
}

/** Open the window on the boot page and return its update handle. */
function createBootWindow(): BootView {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    backgroundColor: WINDOW_BACKGROUND,
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
  void window.loadURL(bootPage(app.getVersion()))
  let booting = true
  const push = (script: string): void => {
    if (!booting || window.isDestroyed()) return
    window.webContents.executeJavaScript(script).catch(() => {
      // The page may still be loading or already gone; every phase this push
      // carried is also in the log file.
    })
  }
  return {
    window,
    phase: (index) => { push(`window.__dsh.phase(${String(index)})`) },
    elapsed: (seconds) => { push(`window.__dsh.elapsed(${String(seconds)})`) },
    fail: (message) => { push(`window.__dsh.fail(${JSON.stringify(message)})`) },
    block: (message) => { push(`window.__dsh.block(${JSON.stringify(message)})`) },
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
    // Every server byte lands in the file; the boot page shows phases only.
    const sink = (chunk: string): void => {
      try {
        appendFileSync(logFile, chunk)
      } catch {
        // Same best-effort contract: the UI keeps running without the file.
      }
    }
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      view.elapsed(Math.round((Date.now() - startedAt) / 1000))
    }, 1000)
    const spec = resolveSpec()
    sink(`[desktop] ${new Date().toISOString()} version=${app.getVersion()} packaged=${String(app.isPackaged)} platform=${process.platform} arch=${process.arch}\n`)
    sink(`[desktop] node runtime: ${spec.nodeBin} (exists: ${String(existsSync(spec.nodeBin) || spec.nodeBin === 'node')})\n`)
    sink(`[desktop] server entry: ${spec.entry} (exists: ${String(existsSync(spec.entry))})\n`)
    sink(`[desktop] server cwd: ${spec.cwd}\n`)
    view.phase(1)
    const host = {
      log: sink,
      openLog: () => {
        // The boot page no longer prints the path, so this menu item is the
        // only way to reach the log; a directory reveal still gets the user
        // there when no application is registered for `.log`.
        void shell.openPath(logFile).then((failure) => {
          if (failure !== '') shell.showItemInFolder(logFile)
        })
      },
      prepareQuit: async () => {
        quitting = true
        await server?.stop()
      },
    }
    setupUpdates(host)
    // Runs alongside the server boot, so on the ordinary path its verdict is
    // already in by the time the UI would be shown and it costs nothing.
    const gate = launchGate(host, (message) => { view.block(message) })
    try {
      server = await startServer(spec, sink)
      clearInterval(ticker)
      sink(`[desktop] server ready at ${server.url}\n`)
      view.phase(2)
      if (await gate) {
        // A build below the feed's minimumVersion may not reach the UI. The
        // server goes down with it, so nothing here is usable until the
        // update the updater is now driving has been installed.
        sink('[desktop] launch blocked: a mandatory update must be installed first\n')
        await server.stop()
        server = undefined
        return
      }
      view.showApp(server.url)
    } catch (error) {
      clearInterval(ticker)
      const message = error instanceof Error ? error.message : String(error)
      sink(`[desktop] startup failed: ${message}\n`)
      // The page keeps the log path on screen; the file carries the output.
      view.fail(message.split('\n')[0] ?? message)
    }
  })
}
