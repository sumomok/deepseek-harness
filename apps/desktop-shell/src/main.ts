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
 * @module @deepseek-ai/dsh-desktop-shell/main
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Notification, session, shell, systemPreferences, type DownloadItem } from 'electron'
import { appBootCss, restateAppBootPage } from './app-boot-text.ts'
import { pinAppIdentity } from './app-identity.ts'
import { KEPT_REPORTS, LOG_ROTATE_BYTES, pruneReports, rotateLog } from './log-retention.ts'
import { bootPage } from './boot-page.ts'
import { clearStaleAuthCookies } from './auth-cookies.ts'
import { reportUncaughtException, setupCrashLog, type CrashLogHost } from './crash-log.ts'
import { forgetServerPort, readState, recordRun, reportStateWritesTo, setServerPort } from './desktop-state.ts'
import { decideDownload, downloadOutcome, type DownloadAlert } from './download-policy.ts'
import { mainWindow, revealMainWindow } from './main-window.ts'
import { shellLanguage } from './menu-text.ts'
import { installMicrophonePermissions } from './microphone-permissions.ts'
import { isExternalNavigationTarget, isServerNavigation } from './navigation.ts'
import { setupNotifications } from './notifications.ts'
import { PNPM_LAUNCHER_ENV, pnpmLauncherEnv } from './pnpm-launcher.ts'
import {
  DESKTOP_PROFILE, describeSeed, profileDirectory, quarantineLoadFailureFromOutput, resolveHarnessHome, seedBuiltinBundles,
} from './profile-seed.ts'
import { acknowledgeSettingsMigrationNotices, migrateLegacySettings } from './settings-migration.ts'
import { RENDER_LIMITS, startRenderService, type RenderServiceHandle } from './render-service.ts'
import { renderInHiddenWindow } from './render-window.ts'
import { clearLoginSession, openLoginWindow } from './login-window.ts'
import {
  classifyStoppedDialogAnswer, initialSupervisorState, isRecoveryRelaunchInstance, RECOVERY_RELAUNCH_FLAG,
  runRecoveryLadder, STOPPED_DIALOG_BUTTONS, STOPPED_DIALOG_CANCEL_INDEX, type SupervisorState,
} from './server-supervision.ts'
import { SERVER_LOG_ENV, startServerWithQuarantine, sweepOrphanedServers, type ServerHandle, type ServerSpec } from './server.ts'
import { choosePort, isPortFree, startOnPort } from './server-port.ts'
import { rebindOnNewPort, respondToCrash, revealApp, stopForQuit } from './server-lifecycle.ts'
import { PALETTES, resolveAppearance } from './theme.ts'
import { storedLanguagePreference } from './theme-preference.ts'
import { guardWindowClose, setupTray } from './tray.ts'
import {
  ENDPOINT_ENV as UPDATE_ENDPOINT_ENV, startUpdateService,
  TOKEN_ENV as UPDATE_TOKEN_ENV, type UpdateServiceHandle,
} from './update-service.ts'
import { launchGate, setupUpdates, updateActions, type UpdateHost } from './updater.ts'
import { superviseAppLoad, type AppLoader } from './window-load.ts'

// First statement of the process: every directory below is derived from the
// application name, and the state of an existing installation lives under the
// name this package no longer carries.
pinAppIdentity(app)

/**
 * A server launch plus the shipped closure the built-in plugins are seeded
 * from. The environment additions are not part of it: they carry the render
 * and update services' addresses, which do not exist yet when the paths are
 * resolved.
 */
interface LaunchSpec extends Omit<ServerSpec, 'env'> {
  /** `node_modules` of the shipped server closure, holding the built-in plugin packages. */
  builtinModules: string
}

/**
 * Resolve where the server lives for this launch. Packaged builds use the
 * app resources; a source-tree launch (`pnpm --filter @deepseek-ai/dsh-desktop-shell
 * exec electron lib/main.js`) uses the checkout's built CLI on the
 * development Node found in PATH, with the built-in plugins coming from the
 * same `apps/desktop-server` closure the packaged payload is deployed from.
 * @param logDir - the desktop log directory, which also receives the server's
 * diagnostic reports.
 * @returns the launch spec.
 */
function resolveSpec(logDir: string): LaunchSpec {
  const home = app.getPath('home')
  if (app.isPackaged) {
    const modules = join(process.resourcesPath, 'server', 'node_modules')
    return {
      nodeBin: join(process.resourcesPath, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      entry: join(modules, '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      builtinModules: modules,
      cwd: home,
      reportDirectory: logDir,
    }
  }
  const apps = join(app.getAppPath(), '..')
  return {
    nodeBin: process.env.DSH_DESKTOP_NODE ?? 'node',
    entry: join(apps, 'cli', 'lib', 'bin.js'),
    builtinModules: join(apps, 'desktop-server', 'node_modules'),
    cwd: home,
    reportDirectory: logDir,
  }
}

let server: ServerHandle | undefined
let renderService: RenderServiceHandle | undefined
let updateService: UpdateServiceHandle | undefined
let quitting = false
/**
 * The desktop log sink. Until the log file is known there is nowhere durable
 * to write, so a line goes to stderr rather than nowhere — which is what
 * carries a launch-chain crash report that arrives before the file exists.
 */
let logLine: (chunk: string) => void = (chunk) => {
  try {
    process.stderr.write(chunk)
  } catch {
    // A packaged GUI process may have no usable stderr handle. Reporting must
    // never throw: this sink is what a crash report falls back to, and a throw
    // here would make that report the silence it exists to prevent.
  }
}
/** Set once the log file's own path is known, for the L2 "打开日志" button. */
let logFile = ''

// `logLine` is read at report time, so a write that fails before the file
// sink exists goes to stderr like every other early line.
reportStateWritesTo((line) => { logLine(line) })

/**
 * Where a crash report goes. `log` reads {@link logLine} at report time, not
 * at construction, so the same host serves both the handlers registered once
 * the file sink exists and the launch chain that can fail before it does.
 */
const CRASH_LOG_HOST: CrashLogHost = {
  log: (entry) => { logLine(entry) },
  showErrorBox: (title, content) => { dialog.showErrorBox(title, content) },
}

/**
 * The launch spec the running server was started (or last rebound) with —
 * paths, the loopback-service environment additions, and the port it listens
 * on. Recorded once the first startup succeeds; every automatic or manual
 * rebind reuses its paths and environment, since the loopback services it
 * points at keep running across a server-only crash, but not its port: see
 * [[performRebind]].
 */
let activeServerSpec: ServerSpec | undefined

/** The recovery ladder's own memory between unexpected server exits; see [[@deepseek-ai/dsh-desktop-shell/server-supervision]]. */
let supervisorState: SupervisorState = initialSupervisorState

/** Wall-clock ms this process started, for the L2 guard window. */
const processStartedAt = Date.now()

/** Whether this launch is L1's own relaunch after repeated server crashes. */
const isRecoveryRelaunch = isRecoveryRelaunchInstance(process.argv)

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
 * Stop the server for a quit, giving up after `STOP_TIMEOUT_MS`. The caller
 * exits either way; a stop that timed out leaves an orphan for the next launch
 * to sweep, which is recoverable, while waiting forever is not. The sign-in
 * cookies are removed first, within a short bound
 * ([[@deepseek-ai/dsh-desktop-shell/server-lifecycle]]).
 * @returns resolves when the server stopped or the deadline passed.
 */
async function stopServerBounded(): Promise<void> {
  const handle = server
  if (handle === undefined) return
  await stopForQuit({ stop: handle.stop, clearCookies: clearAuthCookies, log: logLine, timeoutMs: STOP_TIMEOUT_MS })
}

/**
 * Remove the served UI's sign-in cookies from the default session.
 * @returns the number removed.
 */
function clearAuthCookies(): Promise<number> {
  return clearStaleAuthCookies(session.defaultSession.cookies, logLine)
}

/**
 * Point every window showing the served UI at a new URL — the one holder the
 * ordinary reload path (`will-navigate`, `reveal`) does not cover on its own,
 * because both of those read `server.url` live and are already correct once
 * {@link server} itself is reassigned. `mainWindow`'s own discriminator
 * (`isResizable`) is what tells the served UI apart from the fixed-size
 * progress and login windows, which this must leave alone.
 * @param url - the rebound server's new authenticated URL.
 */
function retargetWindows(url: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isResizable() && !window.isDestroyed()) appLoaders.get(window)?.load(url)
  }
}

/**
 * The served-UI loader of every app window, so a retarget after a rebind goes
 * through the same logged, retried load as the window's first one. Every
 * resizable window is created by [[createBootWindow]], which registers it.
 */
const appLoaders = new WeakMap<BrowserWindow, AppLoader>()

/**
 * Tell the user an L0 rebind is under way, on both platforms — the window
 * itself is showing whatever a dead backend renders as, which explains nothing.
 */
function notifyRecovering(): void {
  const body = '后台服务已停止,正在恢复…'
  logLine(`[desktop] notify: ${body}\n`)
  if (!Notification.isSupported()) return
  new Notification({ title: 'DSH Desktop', body }).show()
}

/**
 * Attempt one rebind of the embedded server: start it again from
 * {@link activeServerSpec} on a port the system picks, and on success
 * retarget every window and the notification streams, and resume supervising
 * the new child. Used both by the L0 ladder and by the L2 dialog's manual
 * retry. Why the port changes is in
 * [[@deepseek-ai/dsh-desktop-shell/server-lifecycle]].
 * @returns true once the server is back up.
 */
async function performRebind(): Promise<boolean> {
  const spec = activeServerSpec
  if (spec === undefined) return false
  try {
    const started = await rebindOnNewPort(spec, startEmbeddedServer, logLine)
    const handle = started.server
    server = handle
    rememberServerPort(started.spec)
    logLine(`[desktop] server rebind succeeded at ${handle.url}\n`)
    retargetWindows(handle.authenticatedUrl)
    setupNotifications({ log: logLine, reveal }, handle.authenticatedUrl)
    attachSupervision()
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logLine(`[desktop] rebind attempt failed: ${message}\n`)
    return false
  }
}

/**
 * Start the embedded server with the migrated-plugin quarantine, logging to the
 * current {@link logLine}.
 * @param spec - the launch.
 * @returns the running server.
 */
function startEmbeddedServer(spec: ServerSpec): Promise<ServerHandle> {
  return startServerWithQuarantine(spec, logLine, quarantineLoadFailureFromOutput, resolveHarnessHome())
}

/**
 * Record the spec a server was started with, and its port for the next launch.
 * @param spec - the spec [[startOnPort]] returned, carrying the port the server listens on.
 */
function rememberServerPort(spec: ServerSpec): void {
  activeServerSpec = spec
  if (spec.port !== undefined && spec.port !== 0) setServerPort(spec.port)
}

/**
 * Watch the current {@link server} for its own exit and log the autopsy line
 * for an unexpected one, then hand it to the recovery ladder. Called once
 * after the very first successful startup and again after every successful
 * rebind, because `onExit` fires once per child.
 */
function attachSupervision(): void {
  server?.onExit((info) => {
    if (info.expected) return
    const code = info.code === null ? 'null' : String(info.code)
    const signal = info.signal ?? 'null'
    logLine(`[desktop] server exited unexpectedly: code=${code} signal=${signal}\n${info.tail}\n`)
    void handleUnexpectedServerExit()
  })
}

/**
 * Run the recovery ladder for one unexpected server exit and carry out its
 * verdict: nothing further on a recovered rebind, a marked whole-app relaunch
 * on `relaunch`, or the L2 dialog on `stop`.
 */
async function handleUnexpectedServerExit(): Promise<void> {
  // The app is already on its way out through a deliberate stop; that exit is
  // `expected` and never reaches here, but a second, unrelated crash racing
  // the same teardown must not start a rebind the quit is about to undo.
  if (quitting) return
  // Before the ladder, whatever it decides: the dead server's port must not be
  // asked for again and its cookie must not be sent to it meanwhile.
  const { state, outcome } = await respondToCrash({
    forgetPort: forgetServerPort,
    clearCookies: clearAuthCookies,
    log: logLine,
    ladder: () => runRecoveryLadder(supervisorState, Date.now(), isRecoveryRelaunch, processStartedAt, {
      sleep: ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
      notifyRecovering,
      rebind: performRebind,
    }),
  })
  supervisorState = state
  if (outcome === 'relaunch') relaunchForRecovery()
  else if (outcome === 'stop') void runStoppedDialog()
}

/**
 * Escalate to L1: relaunch the whole app once, marked so the next instance
 * knows it is this relaunch (the L2 guard reads it). `quitting` is raised
 * first so the tray's close guard stands aside, which also makes the
 * `before-quit` handler return at once: nothing is left for it to do, since
 * the server already exited and [[handleUnexpectedServerExit]] forgot its port
 * and removed the cookies before the ladder chose this, and the loopback
 * services close with the process.
 */
function relaunchForRecovery(): void {
  logLine('[desktop] escalating to a full relaunch after repeated server crashes\n')
  quitting = true
  const args = process.argv.includes(RECOVERY_RELAUNCH_FLAG)
    ? process.argv.slice(1)
    : [...process.argv.slice(1), RECOVERY_RELAUNCH_FLAG]
  app.relaunch({ args })
  app.quit()
}

/**
 * Escalate to L2: put the decision in front of the user instead of trying
 * again automatically. 「重试」makes exactly one more manual rebind attempt
 * and, on failure, shows the dialog again — repeatable, but never on a timer.
 * 「打开日志」reveals the log file and reshows the dialog, since the user asked
 * for information, not to end anything. 「关闭」ends the dialog loop and
 * returns with the backend left down and nothing further attempted
 * automatically; {@link STOPPED_DIALOG_CANCEL_INDEX} routes Esc and every
 * other way of dismissing the dialog to the same button, so a user who
 * cannot fix the crash always has a way out that is not quitting the whole
 * app.
 */
async function runStoppedDialog(): Promise<void> {
  logLine('[desktop] automatic recovery stopped after repeated crashes; asking the user\n')
  for (;;) {
    const window = mainWindow()
    const options = {
      type: 'error' as const,
      title: 'DSH Desktop',
      message: '后台服务多次崩溃,已停止自动恢复',
      buttons: [...STOPPED_DIALOG_BUTTONS],
      defaultId: 0,
      cancelId: STOPPED_DIALOG_CANCEL_INDEX,
    }
    const answer = window === undefined ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options)
    const outcome = classifyStoppedDialogAnswer(answer.response)
    if (outcome === 'retry') {
      if (await performRebind()) return
      continue
    }
    if (outcome === 'open-log') {
      void shell.openPath(logFile).then((failure) => {
        if (failure !== '') shell.showItemInFolder(logFile)
      })
      continue
    }
    logLine('[desktop] user dismissed the crash dialog; backend stays down\n')
    return
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
 * Start the loopback update service and return what the server child needs to
 * reach it.
 *
 * The shell owns the update channel and the embedded server draws the Settings
 * window, so the one place a user can act on an update is on the far side of
 * this listener. Failing to open it is not a reason to refuse the launch: a
 * server told nothing reports the capability unavailable and shows no update
 * entry, and the channel keeps checking and downloading either way — only the
 * click that installs is out of reach until the next launch.
 * @param host - logging and quit coordination the update channel already uses.
 * @param log - the server log sink; receives one line either way, never the token.
 * @returns the environment additions for the server process, empty when the service did not start.
 */
async function startUpdateForServer(host: UpdateHost, log: (chunk: string) => void): Promise<Record<string, string>> {
  let started: UpdateServiceHandle
  try {
    started = await startUpdateService(updateActions(host))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`[desktop] update service unavailable (${message}); the Settings window shows no update entry\n`)
    return {}
  }
  updateService = started
  log(`[desktop] update service on ${started.endpoint}\n`)
  return { [UPDATE_ENDPOINT_ENV]: started.endpoint, [UPDATE_TOKEN_ENV]: started.token }
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

/** One window whose boot page the main process can drive. */
interface BootView {
  window: BrowserWindow
  /** Show `index` as the running phase and hide every other one. */
  phase: (index: number) => void
  /** Update the seconds suffix on the running phase. */
  elapsed: (seconds: number) => void
  /**
   * Fail the running phase and show the error summary. Once the served UI has
   * replaced the boot page, the boot page is loaded again with the failure
   * shown on its last phase.
   */
  fail: (message: string) => void
  /** Replace the hint line with why the app is holding at this phase. */
  block: (message: string) => void
  /** Stop driving the boot page and load the served UI, through the window's [[AppLoader]]. */
  showApp: (url: string) => void
}

/**
 * Show the settings migration's notices on the app window, one after another,
 * then record them as shown. A window closed before the last one is dismissed
 * leaves them all in the marker for the next launch.
 * @param window - the app window, with the served UI loaded.
 * @param notices - the messages, in order.
 * @param profileDir - the desktop profile directory, holding the marker.
 * @returns once the last notice is dismissed and recorded, or the window is gone.
 */
async function showSettingsNotices(window: BrowserWindow, notices: readonly string[], profileDir: string): Promise<void> {
  for (const notice of notices) {
    if (window.isDestroyed()) return
    await dialog.showMessageBox(window, { type: 'info', message: notice, buttons: ['知道了'] })
  }
  acknowledgeSettingsMigrationNotices(profileDir)
}

/**
 * Tell the user a download they agreed to did not arrive.
 *
 * Attached to the app's own window, like every other dialog this module puts
 * up: the message answers something the user just did in that window, and an
 * unparented box is free to open behind whatever they moved on to. It carries
 * one button, so nothing is decided by dismissing it.
 * @param alert - what to say, from {@link downloadOutcome}.
 */
function reportDownloadFailure(alert: DownloadAlert): void {
  const options = { type: 'error' as const, title: 'DSH Desktop', message: alert.message, detail: alert.detail }
  const window = mainWindow()
  // Nothing waits on the answer: the transfer is over either way, and the
  // `done` handler this runs in must not hold the download session open.
  void (window === undefined ? dialog.showMessageBox(options) : dialog.showMessageBox(window, options))
}

/**
 * Ask where to put what the served UI downloads, then show where it went.
 *
 * The window is a browser surface without a browser's download manager, so
 * Electron answers a download with a Save As sheet that explains nothing —
 * while the page that started it has already said it started, the session-log
 * export announcing 「Session 导出已开始下载」 the moment the transfer begins.
 * A transfer from the embedded server therefore gets a dialog that names the
 * file and opens on a free name in the downloads folder, and when it completes
 * the file is selected in the system file manager: the shell shows the result
 * rather than announcing it, because a notification the platform never posts
 * is the same as saying nothing.
 *
 * Every other origin keeps Electron's default, sheet and all — a file the
 * shell did not serve is not the shell's to place.
 * @param window - the app window whose session the downloads arrive on.
 */
function attachDownloadHandling(window: BrowserWindow): void {
  // The default session: this window names no partition, and neither does any
  // window opened after it, so all of them share this one.
  const windowSession = window.webContents.session
  const onWillDownload = (_event: Electron.Event, item: DownloadItem): void => {
    if (server === undefined) return
    const decision = decideDownload({
      urls: item.getURLChain(),
      serverOrigin: server.url,
      filename: item.getFilename(),
      downloadsDir: app.getPath('downloads'),
      exists: existsSync,
    })
    if (decision.kind === 'default') return
    item.setSaveDialogOptions(decision.dialog)
    item.once('done', (_doneEvent, state) => {
      const outcome = downloadOutcome(state, item.getSavePath(), item.getFilename())
      logLine(outcome.line)
      if (outcome.reveal !== undefined) shell.showItemInFolder(outcome.reveal)
      if (outcome.alert !== undefined) reportDownloadFailure(outcome.alert)
    })
  }
  windowSession.on('will-download', onWillDownload)
  // The session outlives the window, so the listener is removed with the
  // window rather than left to accumulate one copy per window the user closes
  // and reopens — which on macOS is every trip through the Dock.
  window.once('closed', () => { windowSession.off('will-download', onWillDownload) })
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
    if (server === undefined || !isServerNavigation(target, server.url)) {
      event.preventDefault()
      if (isExternalNavigationTarget(target)) void shell.openExternal(target)
    }
  })
  guardWindowClose(window)
  attachDownloadHandling(window)
  // The language chosen in the settings, else the system's, as the menus use.
  restateAppBootPage(window.webContents, () => appBootCss(storedLanguagePreference(resolveHarnessHome()) ?? shellLanguage()))
  void window.loadURL(bootPage(app.getVersion(), appearance, receipt))
  let booting = true
  const showFailure = (message: string): void => {
    if (window.isDestroyed()) return
    window.loadURL(bootPage(app.getVersion(), appearance, undefined, { phase: 2, message })).catch(() => {
      // The failure page is a `data:` document with nothing to fetch; a
      // rejection means the window was closed while it loaded.
    })
  }
  // `logLine` is read at call time: the file sink replaces it after this
  // window already exists.
  const loader = superviseAppLoad(window.webContents, { log: (line) => { logLine(line) }, giveUp: (summary) => { view.fail(summary) } })
  appLoaders.set(window, loader)
  const push = (script: string): void => {
    if (!booting || window.isDestroyed()) return
    window.webContents.executeJavaScript(script).catch(() => {
      // The page may still be loading or already gone; every phase this push
      // carried is also in the log file.
    })
  }
  const view: BootView = {
    window,
    phase: (index) => { push(`window.__dsh.phase(${String(index)})`) },
    elapsed: (seconds) => { push(`window.__dsh.elapsed(${String(seconds)})`) },
    fail: (message) => {
      if (booting) push(`window.__dsh.fail(${JSON.stringify(message)})`)
      else showFailure(message)
    },
    block: (message) => { push(`window.__dsh.block(${JSON.stringify(message)})`) },
    showApp: (url) => {
      booting = false
      loader.load(url)
    },
  }
  return view
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
 * tray, minimized, merely behind something, or gone. Once a quit has begun it
 * does nothing.
 */
function reveal(): void {
  revealApp({
    quitting: () => quitting,
    revealExisting: () => {
      if (mainWindow() === undefined) return false
      revealMainWindow()
      return true
    },
    openWindow: () => { if (server !== undefined) createAppWindow(server.authenticatedUrl) },
  })
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
    void updateService?.close()
    if (server === undefined) return
    event.preventDefault()
    void stopServerBounded().finally(() => { app.exit(0) })
  })

  void app.whenReady().then(async () => {
    app.setAppUserModelId(APP_USER_MODEL_ID)
    // Before the first window, so no page ever runs under the default policy.
    installMicrophonePermissions(session.defaultSession, {
      primary: () => mainWindow()?.webContents,
      serverOrigin: () => server?.url,
      platform: process.platform,
      microphoneStatus: () => systemPreferences.getMediaAccessStatus('microphone'),
      askForMicrophone: () => systemPreferences.askForMediaAccess('microphone'),
    })
    const upgradedFrom = recordRun()
    const view = createBootWindow(upgradedFrom === undefined ? undefined : `已更新到 v${app.getVersion()}`)
    const logDir = app.getPath('logs')
    logFile = join(logDir, 'dsh-server.log')
    try {
      mkdirSync(logDir, { recursive: true })
    } catch {
      // Logging must never block the app; a failed sink drops chunks only.
    }
    // Before the first write, so nothing holds the file while it is renamed.
    const retention = [rotateLog(logFile, LOG_ROTATE_BYTES), pruneReports(logDir, KEPT_REPORTS)]
    // Every server byte lands in the file; the boot page shows phases only.
    const sink = (chunk: string): void => {
      try {
        appendFileSync(logFile, chunk)
      } catch {
        // Same best-effort contract: the UI keeps running without the file.
      }
    }
    logLine = sink
    for (const line of retention) if (line !== undefined) sink(line)
    // Before the updater and the server: from here on a main-process
    // exception is in the file the user is asked to send, rather than only in
    // the box Electron opens over it.
    setupCrashLog(CRASH_LOG_HOST)
    const startedAt = Date.now()
    const ticker = setInterval(() => {
      view.elapsed(Math.round((Date.now() - startedAt) / 1000))
    }, 1000)
    const spec = resolveSpec(logDir)
    sink(`[desktop] ${new Date().toISOString()} version=${app.getVersion()} packaged=${String(app.isPackaged)} platform=${process.platform} arch=${process.arch}\n`)
    sink(`[desktop] node runtime: ${spec.nodeBin} (exists: ${String(existsSync(spec.nodeBin) || spec.nodeBin === 'node')})\n`)
    sink(`[desktop] server entry: ${spec.entry} (exists: ${String(existsSync(spec.entry))})\n`)
    sink(`[desktop] server cwd: ${spec.cwd}\n`)
    sink(`[desktop] server diagnostic reports: ${spec.reportDirectory}\n`)
    if (upgradedFrom !== undefined) sink(`[desktop] first run after updating from ${upgradedFrom}\n`)
    if (isRecoveryRelaunch) sink('[desktop] this launch is an automatic recovery relaunch after repeated server crashes\n')
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
      // Once per process and before the spawn: every `dsh-auth-*` cookie on
      // the host is an earlier launch's, so none of them can be this one's.
      await clearStaleAuthCookies(session.defaultSession.cookies, sink)
      // Before the server reads the profile, not after: `initProfile` writes a
      // profile once and never revisits it, so a name added later would not
      // reach this launch's composition.
      const seeded = describeSeed(seedBuiltinBundles({
        home: resolveHarnessHome(),
        serverModules: spec.builtinModules,
      }))
      if (seeded !== undefined) sink(seeded)
      // After the seeding, whose permission-row retirement the gateway step
      // waits for (the migration reads its record in web-migration.json, so a
      // seeding that stopped before recording it defers that step), and before
      // the server whose settings import this prepares.
      const desktopProfileDir = profileDirectory(resolveHarnessHome(), DESKTOP_PROFILE)
      const settingsMigration = migrateLegacySettings(resolveHarnessHome(), desktopProfileDir)
      for (const line of settingsMigration.lines) sink(`[desktop] settings migration: ${line}\n`)
      // Before the spawn, because the address and token reach the server as
      // environment variables of that child and of nothing else.
      const renderEnv = await startRenderServiceForServer(sink)
      const updateEnv = await startUpdateForServer(host, sink)
      const pnpmEnv = pnpmLauncherEnv({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, platform: process.platform })
      const launcher = pnpmEnv[PNPM_LAUNCHER_ENV]
      sink(launcher === undefined
        ? '[desktop] pnpm launcher: none in a development launch; plugin installs use pnpm on PATH\n'
        : `[desktop] pnpm launcher: ${launcher} (exists: ${String(existsSync(launcher))})\n`)
      // The server appends its own logger records to the same file, as one
      // write per record, rather than printing them into the streams above.
      // After the orphan sweep and the loopback services: an orphan can still
      // hold the remembered port, and a service bound to port 0 can land on it.
      const port = await choosePort(readState().serverPort, isPortFree)
      sink(port.line)
      const started = await startOnPort(
        { ...spec, env: { ...renderEnv, ...updateEnv, ...pnpmEnv, [SERVER_LOG_ENV]: logFile }, port: port.port },
        startEmbeddedServer, sink,
      )
      server = started.server
      rememberServerPort(started.spec)
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
      setupNotifications({ log: sink, reveal }, server.authenticatedUrl)
      attachSupervision()
      view.showApp(server.authenticatedUrl)
      // Over the loaded app rather than the boot page, so the message sits on
      // the window it is about. The marker keeps a notice until it has been
      // dismissed there, so a launch that never gets this far shows it next time.
      if (settingsMigration.notices.length > 0) {
        void showSettingsNotices(view.window, settingsMigration.notices, desktopProfileDir).catch((error: unknown) => {
          sink(`[desktop] settings migration: could not show or record its notices: ${String(error)}\n`)
        })
      }
    } catch (error) {
      clearInterval(ticker)
      const message = error instanceof Error ? error.message : String(error)
      sink(`[desktop] startup failed: ${message}\n`)
      // The page keeps the log path on screen; the file carries the output.
      view.fail(message.split('\n')[0] ?? message)
    }
  }).catch((error: unknown) => {
    // Everything above the try — the boot window, the log directory, the tray
    // — throws into this rejection rather than into `uncaughtException`, and
    // Electron 43 runs a main-process rejection in `warn-with-error-code`
    // mode: unreported, such a launch stops with an empty boot page, no box
    // and no line anywhere. The report goes to the file sink when there is one
    // and to stderr before that.
    reportUncaughtException(CRASH_LOG_HOST, error)
  })
}
