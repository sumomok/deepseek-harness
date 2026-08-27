/**
 * Electron main process of the DSH desktop client: start the embedded
 * `dsh web` server from the app resources (bundled Node runtime + deployed
 * server closure), open the served UI in a native window, and tear the
 * server down with the app. The window is a plain browser surface — no
 * preload, no Node integration; everything the UI can do goes through the
 * same `/api` transport the browser uses.
 *
 * The window opens immediately on a boot page that names the three startup
 * phases and how long the current one has taken, and — on the first launch
 * after an update installed itself — which version this now is. Server output
 * goes to `dsh-server.log` only: on screen a failure shows one summary line and the
 * path of that file, because a scrolling command-line panel is diagnosis
 * material for the developer who receives the log, not for the person waiting.
 *
 * This module is also where the pieces that outlive the window are composed:
 * the update channel, the Windows tray that the close button can hide into,
 * and the notifier that watches the running server. All three reach the window
 * through [[reveal]], and all three quit through the same `before-quit`
 * teardown, so there is one way back in and one way out.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { recordRun } from './desktop-state.ts'
import { mainWindow, revealMainWindow } from './main-window.ts'
import { isExternalNavigationTarget } from './navigation.ts'
import { setupNotifications } from './notifications.ts'
import {
  ENDPOINT_ENV as PLUGIN_ADMIN_ENDPOINT_ENV, PLUGIN_ADMIN_LIMITS, resolvePnpmLauncher, spawnPnpm,
  startPluginAdminService, TOKEN_ENV as PLUGIN_ADMIN_TOKEN_ENV,
  type ConfirmRequest, type PluginAdminHandle,
} from './plugin-admin-service.ts'
import { describeSeed, quarantineLoadFailureFromOutput, resolveHarnessHome, seedBuiltinBundles } from './profile-seed.ts'
import { RENDER_LIMITS, startRenderService, type RenderServiceHandle } from './render-service.ts'
import { renderInHiddenWindow } from './render-window.ts'
import { clearLoginSession, openLoginWindow } from './login-window.ts'
import { startServerWithQuarantine, sweepOrphanedServers, type ServerHandle, type ServerSpec } from './server.ts'
import { PALETTES, resolveAppearance, type Appearance } from './theme.ts'
import { guardWindowClose, setupTray } from './tray.ts'
import { launchGate, setupUpdates } from './updater.ts'

/**
 * A server launch plus the shipped closure the built-in plugins are seeded
 * from. The environment additions are not part of it: they carry the two
 * loopback services' addresses, which do not exist yet when the paths are
 * resolved.
 */
interface LaunchSpec extends Omit<ServerSpec, 'env'> {
  /** `node_modules` of the shipped server closure, holding the built-in plugin packages. */
  builtinModules: string
}

/**
 * Resolve where the server lives for this launch. Packaged builds use the
 * app resources; a source-tree launch (`pnpm --filter @deepseek-ai/dsh-desktop
 * exec electron lib/main.js`) uses the checkout's built CLI on the
 * development Node found in PATH, with the built-in plugins coming from the
 * same `apps/desktop-server` closure the packaged payload is deployed from.
 * @returns the launch spec.
 */
function resolveSpec(): LaunchSpec {
  const home = app.getPath('home')
  if (app.isPackaged) {
    const modules = join(process.resourcesPath, 'server', 'node_modules')
    return {
      nodeBin: join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      entry: join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      builtinModules: modules,
      cwd: home,
    }
  }
  const apps = join(app.getAppPath(), '..')
  return {
    nodeBin: process.env.DSH_DESKTOP_NODE ?? 'node',
    entry: join(apps, 'cli', 'lib', 'bin.js'),
    builtinModules: join(apps, 'desktop-server', 'node_modules'),
    cwd: home,
  }
}

let server: ServerHandle | undefined
let renderService: RenderServiceHandle | undefined
let pluginAdminService: PluginAdminHandle | undefined
let quitting = false
/** Set once the log file is known; before that there is nowhere to write. */
let logLine: (chunk: string) => void = () => {}

/**
 * How long a quit waits for the server to stop before exiting regardless.
 *
 * Without a deadline a stop that never settles holds the process open forever,
 * and a windowless zombie is exactly what blocks the next Windows update. The
 * two platforms bound it differently because the constraint differs:
 *
 * - Windows must beat the updater's installer, which allows the old app about
 *   7.6 s to disappear — 300 ms + 1 s before its first kill, then two rounds of
 *   1 s + 2 s — before it gives up and shows "cannot be closed"
 *   (app-builder-lib `templates/nsis/include/allowOnlyOneInstallerInstance.nsh`,
 *   `_CHECK_APP_RUNNING`). Teardown there is one `taskkill /T /F`, so 4 s is
 *   already generous, and being late costs the user a dialog.
 * - POSIX must outlast `STOP_GRACE_MS`, the server's SIGTERM-to-SIGKILL window,
 *   or the deadline would cut in before the escalation and orphan the very
 *   process it is trying to reap.
 */
const STOP_TIMEOUT_MS = process.platform === 'win32' ? 4_000 : 10_000

/**
 * Stop the server, giving up after `STOP_TIMEOUT_MS`. The caller exits either
 * way; a stop that timed out leaves an orphan for the next launch to sweep,
 * which is recoverable, while waiting forever is not.
 * @returns resolves when the server stopped or the deadline passed.
 */
async function stopServerBounded(): Promise<void> {
  const handle = server
  if (handle === undefined) return
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => { resolve('timeout') }, STOP_TIMEOUT_MS)
  })
  const outcome = await Promise.race([handle.stop().then(() => 'stopped' as const), deadline])
  clearTimeout(timer)
  if (outcome === 'timeout') {
    logLine(`[desktop] server did not stop within ${String(STOP_TIMEOUT_MS)}ms; exiting anyway\n`)
  }
}

/**
 * Start the loopback render service and return what the server child needs to
 * reach it.
 *
 * The shell is a Chromium, and lending it to the embedded server is what lets
 * a screenshot happen on a machine with no browser installed. Failing to open
 * a loopback listener is not a reason to refuse the launch: a server told
 * nothing falls back to whatever browser the machine has, which is what every
 * non-desktop install already does.
 * @param log - the server log sink; receives one line either way, never the token.
 * @returns the environment additions for the server process, empty when the service did not start.
 */
async function startRenderServiceForServer(log: (chunk: string) => void): Promise<Record<string, string>> {
  let started: RenderServiceHandle
  try {
    started = await startRenderService({
      renderer: renderInHiddenWindow,
      openLogin: openLoginWindow,
      clearLoginSession,
      limits: RENDER_LIMITS,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[desktop] render service unavailable (${message}); screenshots fall back to a browser on this machine\n`)
    return {}
  }
  renderService = started
  log(`[desktop] render service on ${started.endpoint}\n`)
  return { DSH_DESKTOP_RENDER_ENDPOINT: started.endpoint, DSH_DESKTOP_RENDER_TOKEN: started.token }
}

/**
 * Put one plugin-admin confirmation on screen.
 *
 * A native modal rather than anything the web UI draws: the page asking for an
 * install is the page a compromised plugin would draw its own confirmation in,
 * and this window is the one it cannot paint over. It is parented to the main
 * window when there is one, so it is modal to the app rather than a dialog the
 * user can lose behind it.
 * @param request - what the service wants asked.
 * @returns true when the user chose the confirming button.
 */
async function confirmPluginAdmin(request: ConfirmRequest): Promise<boolean> {
  const options = {
    type: 'question' as const,
    title: request.title,
    message: request.message,
    ...request.detail === undefined ? {} : { detail: request.detail },
    buttons: [request.confirmLabel, request.cancelLabel],
    defaultId: 0,
    // Dismissing the dialog installs nothing and restarts nothing.
    cancelId: 1,
  }
  const window = mainWindow()
  const answer = window === undefined
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(window, options)
  return answer.response === 0
}

/**
 * Start the loopback plugin-admin service and return what the server child
 * needs to reach it.
 *
 * The shell ships a package manager the machine does not have, and lending it
 * is what lets a plugin be updated from the Settings window. Failing to open a
 * loopback listener is not a reason to refuse the launch: a server told nothing
 * reports the capability unavailable and hides the tab, which is what every
 * non-desktop install already does.
 * @param spec - this launch's paths, for the pnpm the packaged build ships.
 * @param log - the server log sink; receives one line either way, never the token.
 * @returns the environment additions for the server process, empty when the service did not start.
 */
async function startPluginAdminForServer(spec: LaunchSpec, log: (chunk: string) => void): Promise<Record<string, string>> {
  const launcher = resolvePnpmLauncher({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    nodeBin: spec.nodeBin,
  })
  let started: PluginAdminHandle
  try {
    started = await startPluginAdminService({
      home: resolveHarnessHome(),
      run: spawnPnpm(launcher),
      confirm: confirmPluginAdmin,
      relaunch: () => {
        app.relaunch()
        app.quit()
      },
      limits: PLUGIN_ADMIN_LIMITS,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[desktop] plugin admin service unavailable (${message}); plugin updates are not offered\n`)
    return {}
  }
  pluginAdminService = started
  log(`[desktop] plugin admin service on ${started.endpoint}, pnpm: ${[launcher.command, ...launcher.prefixArgs].join(' ')}\n`)
  return { [PLUGIN_ADMIN_ENDPOINT_ENV]: started.endpoint, [PLUGIN_ADMIN_TOKEN_ENV]: started.token }
}

/**
 * Windows groups taskbar buttons, jump lists, and — the reason it is set here —
 * **toast notifications** by an Application User Model ID. A process without
 * one gets whatever the shortcut that launched it carried, and a launch that
 * bypassed the shortcut gets nothing, at which point notifications are silently
 * dropped. The value must be the `appId` from electron-builder.yml, which is
 * what the installer writes onto the shortcut it creates; the two are the same
 * fact in the two places that need it, exactly like the update feed URL.
 * A no-op on every other platform.
 */
const APP_USER_MODEL_ID = 'dev.dsh.desktop'

/**
 * The boot page: a self-contained `data:` document (no external resource, no
 * preload) that the main process drives through `window.__dsh`. It shows one
 * phase at a time — the one actually running — because a checklist of things
 * that have not happened yet is a list of ways to wonder what went wrong.
 * @param version - the app version shown at the bottom of the page.
 * @param appearance - which palette to paint.
 * @param receipt - one line confirming an update, when this launch is the first
 * of a new version. It is baked into the document rather than pushed into it,
 * because the push path tolerates a page that has not finished loading by
 * dropping what it carries, which is right for a phase and wrong for this.
 * @returns the `data:` URL to load.
 */
function bootPage(version: string, appearance: Appearance, receipt: string | undefined): string {
  const colors = PALETTES[appearance]
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>DSH Desktop</title><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; overflow: hidden;
    display: flex; align-items: center; justify-content: center;
    background: ${colors.gradient};
    color: ${colors.text}; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
  }
  /* Dot grid and vignette, both purely decorative and both behind the column. */
  body::before {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    background-image: radial-gradient(circle, ${colors.grid} 1px, transparent 1px);
    background-size: 24px 24px;
  }
  body::after {
    content: ""; position: fixed; inset: 0; pointer-events: none;
    box-shadow: inset 0 0 180px 40px ${colors.vignette};
  }
  main { position: relative; width: 100%; max-width: 460px; padding: 0 32px; }
  .glow {
    position: absolute; left: 4px; top: -88px; width: 320px; height: 320px;
    pointer-events: none; transform-origin: center;
    background: radial-gradient(circle, ${colors.glow} 0%, transparent 68%);
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
    color: ${colors.text}; letter-spacing: .02em;
  }
  .caret {
    display: inline-block; margin-left: 8px; color: ${colors.accent};
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
    color: ${colors.text}; opacity: 0; transition: opacity .28s ease;
  }
  .phase.showing { opacity: 1; }
  .mark { flex: none; width: 1em; color: ${colors.accent}; animation: pulse 1.6s ease-in-out infinite; }
  .phase.failed .mark { color: ${colors.danger}; animation: none; }
  @keyframes pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
  .label { font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif; }
  .elapsed { color: ${colors.muted}; }
  .receipt { position: relative; margin-top: 16px; font-size: 11px; color: ${colors.accent}; }
  .hint { position: relative; margin-top: 16px; font-size: 11px; color: ${colors.muted}; }
  .failure { position: relative; margin-top: 16px; display: none; }
  body.failed .failure { display: block; }
  .summary {
    font-size: 13px; color: ${colors.text}; word-break: break-all; user-select: text;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden;
  }
  .lead { margin-top: 12px; font-size: 13px; color: ${colors.muted}; }
  footer {
    position: fixed; left: 0; right: 0; bottom: 24px; text-align: center;
    font-size: 11px; color: ${colors.muted};
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
  ${receipt === undefined ? '' : `<div class="receipt">${receipt}</div>`}
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

/**
 * Open the window on the boot page and return its update handle.
 * @param receipt - the update confirmation line, when there is one to show.
 */
function createBootWindow(receipt?: string): BootView {
  // Chosen before the window exists: `backgroundColor` is what paints while the
  // page loads, so resolving the theme here is what prevents a flash of the
  // opposite one.
  const appearance = resolveAppearance()
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    backgroundColor: PALETTES[appearance].background,
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
      if (isExternalNavigationTarget(target)) void shell.openExternal(target)
    }
  })
  guardWindowClose(window)
  void window.loadURL(bootPage(app.getVersion(), appearance, receipt))
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

/**
 * Put the app in front of the user: uncover the window it already has, or open
 * one on the served UI when it has none. Every route back into the app — the
 * tray icon, a clicked notification, a second launch, the macOS Dock — ends
 * here, so all of them behave the same whether the window is hidden in the
 * tray, minimized, merely behind something, or gone.
 */
function reveal(): void {
  if (mainWindow() !== undefined) {
    revealMainWindow()
    return
  }
  if (server !== undefined) createAppWindow(server.url)
}

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => { reveal() })

  app.on('window-all-closed', () => {
    // macOS keeps the app (and its server) alive in the Dock; elsewhere the
    // last window ends the app. A window hidden into the Windows tray was
    // never closed, so this does not fire for it.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => { reveal() })

  // Async teardown: hold the first quit, stop the server, then exit for real.
  // The stop is bounded, so this path always reaches `app.exit`.
  //
  // `quitting` is raised before the server check, not after it, because the
  // flag is what tells the tray's close handler to let windows go. A quit with
  // no server to stop — a launch whose server never came up — must still set
  // it, or the handler intercepts the close, calls `app.quit()` again, and the
  // two hold each other in a loop the user cannot get out of.
  app.on('before-quit', (event) => {
    if (quitting) return
    quitting = true
    // Best-effort and unawaited: the listener dies with the process anyway, and
    // this quit must not wait on a render that is still running.
    void renderService?.close()
    void pluginAdminService?.close()
    if (server === undefined) return
    event.preventDefault()
    void stopServerBounded().finally(() => { app.exit(0) })
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    const upgradedFrom = recordRun()
    const view = createBootWindow(upgradedFrom === undefined ? undefined : `已更新到 v${app.getVersion()}`)
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
    logLine = sink
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      view.elapsed(Math.round((Date.now() - startedAt) / 1000))
    }, 1000)
    const spec = resolveSpec()
    sink(`[desktop] ${new Date().toISOString()} version=${app.getVersion()} packaged=${String(app.isPackaged)} platform=${process.platform} arch=${process.arch}\n`)
    sink(`[desktop] node runtime: ${spec.nodeBin} (exists: ${String(existsSync(spec.nodeBin) || spec.nodeBin === 'node')})\n`)
    sink(`[desktop] server entry: ${spec.entry} (exists: ${String(existsSync(spec.entry))})\n`)
    sink(`[desktop] server cwd: ${spec.cwd}\n`)
    if (upgradedFrom !== undefined) sink(`[desktop] first run after updating from ${upgradedFrom}\n`)
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
        await stopServerBounded()
      },
    }
    const checkForUpdates = setupUpdates(host)
    setupTray({ log: sink, reveal, checkForUpdates, isQuitting: () => quitting })
    // Runs alongside the server boot, so on the ordinary path its verdict is
    // already in by the time the UI would be shown and it costs nothing.
    const gate = launchGate(host, (message) => { view.block(message) })
    try {
      // Before starting a new server, take down any left by a run that could
      // not finish its teardown: they hold the files this install occupies.
      await sweepOrphanedServers(spec.nodeBin, sink)
      // Before the server reads the profile, not after: `initProfile` writes a
      // profile once and never revisits it, so a name added later would not
      // reach this launch's composition.
      const seeded = describeSeed(seedBuiltinBundles({
        home: resolveHarnessHome(),
        serverModules: spec.builtinModules,
      }))
      if (seeded !== undefined) sink(seeded)
      // Before the spawn, because the address and token reach the server as
      // environment variables of that child and of nothing else.
      const renderEnv = await startRenderServiceForServer(sink)
      const pluginAdminEnv = await startPluginAdminForServer(spec, sink)
      server = await startServerWithQuarantine(
        { ...spec, env: { ...renderEnv, ...pluginAdminEnv } }, sink, quarantineLoadFailureFromOutput, resolveHarnessHome(),
      )
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
      // After the gate, so a launch that must update first never subscribes to
      // a server it is about to take down.
      setupNotifications({ log: sink, reveal }, server.url)
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
