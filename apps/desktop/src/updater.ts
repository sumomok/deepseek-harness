/**
 * Update channel of the desktop client. Both platforms read the same
 * electron-builder `generic` feed — a static directory of installers plus a
 * `latest*.yml` manifest — but they end differently: Windows downloads and
 * installs through electron-updater, while macOS only detects the new version
 * and hands the download to the system browser, because Squirrel.Mac refuses
 * to stage an update whose app is unsigned and no certificate is configured
 * for these builds.
 *
 * The ordinary path runs in three stages and never interrupts what is running:
 * a silent check, one dialog offering the download, and — after the download
 * finishes in a window the user may close at any time — one dialog offering
 * the install. **No install happens without the user deciding it**, on quit or
 * anywhere else: the app replaces itself only in the seconds after someone
 * clicks the button that says so. What follows that click runs without further
 * prompts and the app reopens by itself — the installer's wizard would only ask
 * again what the click already answered. A declined install stays on disk and is
 * offered again on the next launch and on demand from the menu, and nowhere else.
 *
 * Above that sits one mandatory layer, keyed on the feed's `minimumVersion`:
 * a build older than that line downloads without being asked, and at launch it
 * cannot reach the app until the update is installed. The rule is decided in
 * one place ([[isMandatory]]) and read from two.
 * @module @deepseek-ai/dsh-desktop/updater
 */

import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { load } from 'js-yaml'
import { NsisUpdater } from 'electron-updater'
import { compareVersions } from './version-order.ts'
import { closeProgress, progressVersion, showProgress, updateProgress } from './progress-window.ts'

/**
 * Base of the static update feed. The per-platform subdirectories match the
 * `publish` blocks in electron-builder.yml, which is what makes one
 * `scripts/publish-update.ts` run serve both platforms.
 */
const FEED_BASE = 'https://lhr.ink/dsh-updates'

/** Windows feed: `latest.yml` plus the NSIS installer and its blockmap. */
const FEED_WIN = `${FEED_BASE}/win`

/** macOS feed: `latest-mac.yml` plus the zipped app. */
const FEED_MAC = `${FEED_BASE}/mac`

/**
 * The one channel this product publishes, set explicitly on both ends: the
 * default derives it from the running version's prerelease tag, which would
 * make an `0.1.0-rc.N` build look for `rc.yml` and rename the channel at every
 * stage of the release cycle. Must match `publish.channel` in electron-builder.yml.
 */
const FEED_CHANNEL = 'latest'

/** Delay between app ready and the first silent check; the server boot owns the first seconds. */
const FIRST_CHECK_DELAY_MS = 15_000

/** Period of the recurring silent check. */
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000

/** How long the macOS feed fetch may take before the check is abandoned. */
const MAC_FEED_TIMEOUT_MS = 20_000

/**
 * How long the launch gate waits for the feed. An unreachable feed must never
 * hold the app shut, so the gate opens on timeout and the mandatory line is
 * enforced on a later launch that can reach the server.
 */
const GATE_TIMEOUT_MS = 15_000

/**
 * Why a check is running. It decides only who may be interrupted: `startup`
 * and `manual` may open the macOS hand-off dialog, `scheduled` may not,
 * because a session in progress did not ask about updates.
 */
type CheckReason = 'startup' | 'scheduled' | 'manual'

/** What the updater — and the application menu it builds — needs from the app. */
export interface UpdateHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /**
   * Open `dsh-server.log` in whatever the system uses for it. The boot page
   * stopped printing the path, so the menu item backed by this is the only
   * route to the log a user can be told to take.
   */
  openLog: () => void
  /**
   * Mark the app as quitting and tear the embedded server down. Resolves once
   * the server process tree is gone, which is the precondition for handing
   * control to an installer that replaces the app directory.
   */
  prepareQuit: () => Promise<void>
}

/** One entry of the `files` list in a `latest*.yml` manifest. */
interface FeedFile {
  /** Artifact name relative to the feed directory. */
  url: string
}

/** The subset of a `latest*.yml` manifest this module reads. */
interface Feed {
  /** The published version. */
  version: string
  /** Artifacts of the published version, most preferred first. */
  files?: FeedFile[]
  /** Release notes written by `scripts/publish-update.ts`. */
  releaseNotes?: string
  /** Publisher's red line: a build below this version must update to stay usable. */
  minimumVersion?: string
}

/** The single NsisUpdater instance; its event listeners must be registered once. */
let nsisUpdater: NsisUpdater | undefined

/** Version of the update already downloaded and waiting to be installed. */
let stagedVersion: string | undefined

/** Release notes of the staged update, for the install dialog. */
let stagedNotes: string | undefined

/** Whether a download is in flight. */
let downloading = false

/** Version whose download offer was declined during this run. */
let declinedVersion: string | undefined

/** Version whose install offer was postponed during this run. */
let postponedVersion: string | undefined

/**
 * Set once the launch gate found a mandatory update. Every ordinary check
 * stands down afterwards: the blocking path owns the app from that point.
 */
let blocking = false

/** Version the feed offers, known from a check before any download finished. */
let offeredVersion: string | undefined

/** The macOS manifest the gate already fetched, so the blocking path does not refetch. */
let macFeed: Feed | undefined

/**
 * Whether this build is below the publisher's red line. The feed's
 * `minimumVersion` is the only input, and an absent field means no red line —
 * so a feed that never sets one behaves exactly as it did before the field
 * existed.
 * @param minimumVersion - the feed's `minimumVersion`, if it carries one.
 * @returns true when the running build must update before it can be used.
 */
function isMandatory(minimumVersion: string | undefined): boolean {
  return minimumVersion !== undefined && compareVersions(app.getVersion(), minimumVersion) < 0
}

/**
 * Read the feed's `minimumVersion` off a manifest electron-updater parsed.
 * The field is this product's own addition, so it is absent from the library's
 * `UpdateInfo` type but survives its js-yaml parse.
 * @param info - the parsed manifest.
 * @returns the red line, or undefined when the feed sets none.
 */
function minimumOf(info: unknown): string | undefined {
  const value = (info as { minimumVersion?: unknown } | null | undefined)?.minimumVersion
  return typeof value === 'string' ? value : undefined
}

/**
 * Absolute URL of one feed artifact. electron-builder leaves spaces unencoded
 * in the manifest's `url` field, so the name is encoded here; an already
 * encoded name is passed through, and both spellings resolve to one address.
 * @param base - the platform feed directory.
 * @param entryUrl - the `url` field of the manifest entry.
 * @returns the absolute download URL.
 */
function feedFileUrl(base: string, entryUrl: string): string {
  return `${base}/${entryUrl.includes('%') ? entryUrl : encodeURI(entryUrl)}`
}

/** Release notes trimmed to what a dialog can show without becoming a wall of text. */
function notesDetail(notes: string | undefined): string {
  const text = (notes ?? '').trim()
  if (text === '') return ''
  return text.split('\n').slice(0, 12).join('\n')
}

/** Fetch and parse one platform manifest. */
async function fetchFeed(url: string): Promise<Feed> {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(MAC_FEED_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`更新源返回 ${String(response.status)} ${response.statusText}(${url})`)
  const feed = load(await response.text()) as Feed | undefined
  if (feed?.version === undefined) throw new Error(`更新源缺少 version 字段(${url})`)
  return feed
}

/**
 * Wire the update channel: build the application menu, run the delayed and
 * recurring silent checks, and expose the manual check the menu triggers.
 * Unpackaged launches skip the whole channel — a source-tree run has no
 * installer to replace and no version the feed could outrank.
 * @param host - logging and quit coordination from the main process.
 */
export function setupUpdates(host: UpdateHost): void {
  const check = app.isPackaged
    ? (reason: CheckReason): void => { void runCheck(host, reason) }
    : (reason: CheckReason): void => {
      host.log('[updater] skipped: development launches have no installed app to replace\n')
      if (reason === 'manual') {
        void dialog.showMessageBox({
          type: 'info',
          message: '开发模式不检查更新',
          detail: '当前是从源码启动的开发实例,更新只对安装后的应用生效。',
          buttons: ['好'],
        })
      }
    }
  // Built before the packaged check: 「查看日志」 is exactly as useful in a
  // development launch, where startup problems are just as likely.
  buildMenu(() => { check('manual') }, host.openLog)
  if (!app.isPackaged) return
  const first = setTimeout(() => { check('startup') }, FIRST_CHECK_DELAY_MS)
  const recurring = setInterval(() => { check('scheduled') }, CHECK_INTERVAL_MS)
  app.once('before-quit', () => {
    clearTimeout(first)
    clearInterval(recurring)
  })
}

/**
 * Decide at launch whether this build may open the app at all, and take over
 * when it may not. The verdict is bounded by [[GATE_TIMEOUT_MS]] and defaults
 * to letting the app open, because a feed that cannot be reached must never
 * lock someone out of their own machine.
 *
 * Runs concurrently with the server boot; the caller awaits it only when the
 * server is ready, so on the ordinary path it costs no wall-clock time.
 * @param host - logging and quit coordination from the main process.
 * @param onBlock - called with the message to show on the boot page when the
 * launch is blocked.
 * @returns true when the app must not open.
 */
export async function launchGate(host: UpdateHost, onBlock: (message: string) => void): Promise<boolean> {
  if (!app.isPackaged) return false
  try {
    const verdict = await Promise.race([
      resolveGate(host),
      new Promise<false>((resolvePromise) => { setTimeout(() => { resolvePromise(false) }, GATE_TIMEOUT_MS) }),
    ])
    if (!verdict) return false
    blocking = true
    if (process.platform === 'win32') {
      onBlock('这是必须安装的更新,正在下载新版本…')
      void blockOnWindows(host)
    } else {
      onBlock('这是必须安装的更新,请下载新版本后继续。')
      void blockOnMac(host)
    }
    return true
  } catch (error) {
    // An unreachable or malformed feed opens the gate: the red line is
    // enforced on a later launch that can read it.
    host.log(`[updater] launch gate skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  }
}

/** Ask the feed whether this build is below the red line. */
async function resolveGate(host: UpdateHost): Promise<boolean> {
  if (process.platform === 'win32') {
    const result = await ensureNsisUpdater(host).checkForUpdates()
    const minimum = minimumOf(result?.updateInfo)
    if (!isMandatory(minimum)) return false
    stagedNotes = typeof result?.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined
    offeredVersion = result?.updateInfo.version
    host.log(`[updater] mandatory: ${app.getVersion()} is below the feed's minimumVersion ${String(minimum)}\n`)
    return true
  }
  const feed = await fetchFeed(`${FEED_MAC}/latest-mac.yml`)
  if (!isMandatory(feed.minimumVersion)) return false
  host.log(`[updater] mandatory: ${app.getVersion()} is below the feed's minimumVersion ${String(feed.minimumVersion)}\n`)
  macFeed = feed
  offeredVersion = feed.version
  return true
}

/**
 * Windows launch block: download without asking, then offer the only way
 * forward. A failed download must still leave a way out, so it offers a retry
 * beside quitting — never a state that can neither proceed nor exit.
 * @param host - logging and quit coordination from the main process.
 */
async function blockOnWindows(host: UpdateHost): Promise<void> {
  const updater = ensureNsisUpdater(host)
  showProgress(offeredVersion ?? '')
  downloading = true
  try {
    await updater.downloadUpdate()
  } catch (error) {
    downloading = false
    closeProgress()
    host.log(`[updater] mandatory download failed: ${error instanceof Error ? error.message : String(error)}\n`)
    const answer = await dialog.showMessageBox({
      type: 'error',
      title: '更新下载失败',
      message: '必须安装的更新没有下载成功',
      detail: '检查网络后重试,或退出应用稍后再启动。',
      buttons: ['重试', '退出应用'],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response === 0) {
      await blockOnWindows(host)
      return
    }
    app.quit()
  }
}

/**
 * macOS launch block: an unsigned build cannot install itself, so the only
 * paths are downloading the replacement or quitting.
 * @param host - logging and quit coordination from the main process.
 */
async function blockOnMac(host: UpdateHost): Promise<void> {
  const feed = macFeed
  const artifact = feed?.files?.[0]?.url
  const answer = await dialog.showMessageBox({
    type: 'warning',
    title: `必须更新到 ${feed?.version ?? ''}`,
    message: `当前版本 ${app.getVersion()} 需要更新后才能继续使用`,
    detail: notesDetail(feed?.releaseNotes) || `请下载并替换为 ${feed?.version ?? '新版本'}。`,
    buttons: ['去下载', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response === 0 && artifact !== undefined) {
    const target = feedFileUrl(FEED_MAC, artifact)
    host.log(`[updater] opening ${target}\n`)
    await shell.openExternal(target)
    await dialog.showMessageBox({
      type: 'info',
      message: '下载完成后替换应用',
      detail: '解压得到的 DSH Desktop.app 拖进「应用程序」覆盖旧版本。'
        + '这些构建未经签名,替换后第一次打开要右键点图标选「打开」,系统才允许运行。',
      buttons: ['好'],
    })
  }
  app.quit()
}

/**
 * Run one update check on the current platform.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function runCheck(host: UpdateHost, reason: CheckReason): Promise<void> {
  if (blocking) return
  try {
    if (process.platform === 'win32') await checkWindows(host, reason)
    else await checkGeneric(host, reason)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    host.log(`[updater] check failed: ${message}\n`)
    if (reason === 'manual') {
      await dialog.showMessageBox({
        type: 'warning',
        message: '无法检查更新',
        detail: `${message}\n\n稍后再试,或到发布页手动下载新版本。`,
        buttons: ['好'],
      })
    }
  }
}

/**
 * Windows, stage one: compare against the feed. What the check finds decides
 * which of the later stages the user sees, and a manual check re-enters
 * whichever stage the update is already in rather than starting over.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function checkWindows(host: UpdateHost, reason: CheckReason): Promise<void> {
  const updater = ensureNsisUpdater(host)
  if (stagedVersion !== undefined) {
    if (reason === 'manual') await offerInstall(host, stagedVersion, true)
    return
  }
  if (downloading) {
    // The download already has a surface; a manual check reopens it instead of
    // stacking a dialog on top.
    if (reason === 'manual') showProgress(progressVersion() ?? '')
    return
  }
  const result = await updater.checkForUpdates()
  const version = result?.updateInfo.version
  if (version === undefined || compareVersions(version, app.getVersion()) <= 0) {
    host.log(`[updater] no update: installed ${app.getVersion()}, feed ${version ?? 'unavailable'}\n`)
    if (reason === 'manual') await reportUpToDate()
    return
  }
  const notes = typeof result?.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined
  stagedNotes = notes
  offeredVersion = version
  if (isMandatory(minimumOf(result?.updateInfo))) {
    // Mid-session mandatory: start immediately, but let the work in progress
    // finish — the next launch is where the gate stops being negotiable.
    downloading = true
    showProgress(version)
    host.log(`[updater] mandatory ${version}: downloading without asking\n`)
    void dialog.showMessageBox({
      type: 'warning',
      title: `必须更新到 ${version}`,
      message: '这是必须安装的更新,已开始后台下载',
      detail: notesDetail(notes) || '下载完成后可以立即重启安装,也可以在下次启动时完成。',
      buttons: ['好'],
    })
    await updater.downloadUpdate()
    return
  }
  if (reason !== 'manual' && declinedVersion === version) {
    host.log(`[updater] ${version} was declined this run; not asking again\n`)
    return
  }
  await offerDownload(host, version, notes)
}

/**
 * Windows, stage two: offer the download. Nothing has been transferred yet, so
 * this is the point where an update can be declined at no cost.
 * @param host - logging and quit coordination from the main process.
 * @param version - the version the feed offers.
 * @param notes - release notes from the manifest.
 */
async function offerDownload(host: UpdateHost, version: string, notes: string | undefined): Promise<void> {
  const answer = await dialog.showMessageBox({
    type: 'info',
    title: `发现新版本 ${version}`,
    message: `发现新版本 ${version}`,
    detail: notesDetail(notes) || `当前版本 ${app.getVersion()}。下载在后台进行,完成后再决定什么时候重启。`,
    buttons: ['下载更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response !== 0) {
    declinedVersion = version
    host.log(`[updater] user declined ${version}\n`)
    return
  }
  downloading = true
  showProgress(version)
  host.log(`[updater] downloading ${version}\n`)
  await nsisUpdater?.downloadUpdate()
}

/**
 * Build the Windows updater and register its lifetime listeners.
 * `autoInstallOnAppQuit` stays off: this app never replaces itself on the way
 * out, only in the seconds after someone clicks 「重启安装」.
 * @param host - logging and quit coordination from the main process.
 * @returns the configured updater.
 */
function ensureNsisUpdater(host: UpdateHost): NsisUpdater {
  if (nsisUpdater !== undefined) return nsisUpdater
  const updater = new NsisUpdater({ provider: 'generic', url: FEED_WIN, channel: FEED_CHANNEL })
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.logger = {
    info: (message?: unknown) => { host.log(`[updater] ${String(message)}\n`) },
    warn: (message?: unknown) => { host.log(`[updater] warn: ${String(message)}\n`) },
    error: (message?: unknown) => { host.log(`[updater] error: ${String(message)}\n`) },
    debug: (message: string) => { host.log(`[updater] debug: ${message}\n`) },
  }
  updater.on('download-progress', (progress) => {
    updateProgress(progress)
    mainWindow()?.setProgressBar(progress.percent / 100)
  })
  updater.on('error', (error) => {
    // A failed download stays silent on the ordinary path: the next scheduled
    // check retries it. The blocking path reports it through its own dialog.
    downloading = false
    closeProgress()
    mainWindow()?.setProgressBar(-1)
    host.log(`[updater] error: ${error.message}\n`)
  })
  updater.on('update-downloaded', (info) => {
    downloading = false
    stagedVersion = info.version
    stagedNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    closeProgress()
    mainWindow()?.setProgressBar(-1)
    host.log(`[updater] downloaded ${info.version}; waiting for an explicit install\n`)
    void offerInstall(host, info.version, blocking)
  })
  nsisUpdater = updater
  return updater
}

/**
 * Windows, stage three: the update is on disk and the only question left is
 * when to install it. The default button is 「暂不」 so a reflexive Enter never
 * ends a session — except on the blocking path, where restarting is the only
 * way forward and the dialog says exactly that.
 * @param host - logging and quit coordination from the main process.
 * @param version - the downloaded version.
 * @param force - ask again even though this version was already postponed this
 * run; true for a manual check and for the blocking path.
 */
async function offerInstall(host: UpdateHost, version: string, force: boolean): Promise<void> {
  if (!force && postponedVersion === version) return
  postponedVersion = version
  const notes = notesDetail(stagedNotes)
  const promise = '点击后应用会关闭,自动完成安装并重新打开;你的会话记录都在。'
  const detail = notes === ''
    ? `当前版本 ${app.getVersion()},安装后为 ${version}。\n\n${promise}`
    : `更新内容:\n${notes}\n\n${promise}`
  const answer = await dialog.showMessageBox({
    type: 'info',
    title: '新版本已下载完毕',
    message: blocking
      ? `v${version} 已下载完毕。重启安装后即可继续使用。`
      : `v${version} 已下载完毕,可以安装。现在重启安装吗?`,
    detail,
    buttons: blocking ? ['重启安装'] : ['重启安装', '暂不'],
    defaultId: blocking ? 0 : 1,
    cancelId: blocking ? 0 : 1,
  })
  if (answer.response !== 0) {
    host.log(`[updater] ${version} stays downloaded; it installs when the user says so\n`)
    return
  }
  host.log(`[updater] stopping the server before installing ${version}\n`)
  await host.prepareQuit()
  // (isSilent, isForceRunAfter). Both matter, and only together: electron-updater
  // turns them into the installer's `/S` and `--force-run`. `/S` is what makes
  // the click mean what it says — an assisted (oneClick: false) installer
  // otherwise replays its install-mode, progress, and finish pages, which reads
  // as a reinstall rather than an update. `$INSTDIR` still comes from the
  // registry's InstallLocation, read in .onInit before any page, so the silent
  // run lands in the same directory the app is installed in. `--force-run` is
  // then required for the relaunch: the assisted installer's auto-start branch
  // is `${if} ${isForceRun} ${andIf} ${Silent}`, so (true, false) would install
  // and leave the user staring at nothing.
  nsisUpdater?.quitAndInstall(true, true)
}

/**
 * macOS and every other platform without an in-place installer: read the feed
 * directly and, when it is ahead, open the download in the system browser.
 * Squirrel.Mac only stages updates for a signed app, so an unsigned build can
 * detect a new version but cannot install one. The dialog is confined to
 * startup and manual checks — a scheduled check mid-session only logs, unless
 * the feed's red line makes the update mandatory.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function checkGeneric(host: UpdateHost, reason: CheckReason): Promise<void> {
  const feed = await fetchFeed(`${FEED_MAC}/latest-mac.yml`)
  const version = feed.version
  if (compareVersions(version, app.getVersion()) <= 0) {
    host.log(`[updater] no update: installed ${app.getVersion()}, feed ${version}\n`)
    if (reason === 'manual') await reportUpToDate()
    return
  }
  const artifact = feed.files?.[0]?.url
  if (artifact === undefined) throw new Error(`更新源缺少 files[].url(${FEED_MAC}/latest-mac.yml)`)
  const mandatory = isMandatory(feed.minimumVersion)
  if (reason === 'scheduled' && !mandatory) {
    host.log(`[updater] ${version} is available; not interrupting the session\n`)
    return
  }
  const answer = await dialog.showMessageBox({
    type: mandatory ? 'warning' : 'info',
    title: mandatory ? `必须更新到 ${version}` : `发现新版本 ${version}`,
    message: mandatory
      ? `当前版本 ${app.getVersion()} 需要更新后才能继续使用`
      : `发现新版本 ${version}`,
    detail: notesDetail(feed.releaseNotes)
      || (mandatory ? '下次启动时需要完成更新才能进入应用。' : `当前版本 ${app.getVersion()}。`),
    buttons: ['去下载', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response !== 0) {
    host.log(`[updater] user postponed ${version}\n`)
    return
  }
  const target = feedFileUrl(FEED_MAC, artifact)
  host.log(`[updater] opening ${target}\n`)
  await shell.openExternal(target)
  await dialog.showMessageBox({
    type: 'info',
    message: '下载完成后替换应用',
    detail: '解压得到的 DSH Desktop.app 拖进「应用程序」覆盖旧版本。'
      + '这些构建未经签名,替换后第一次打开要右键点图标选「打开」,系统才允许运行。',
    buttons: ['好'],
  })
}

/** Confirm to a manual checker that the installed version is current. */
async function reportUpToDate(): Promise<void> {
  await dialog.showMessageBox({
    type: 'info',
    message: '已是最新版本',
    detail: `当前版本 ${app.getVersion()}。`,
    buttons: ['好'],
  })
}

/** The window that carries the taskbar progress: the app's own, not the progress popup. */
function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(candidate => candidate.isResizable())
}

/**
 * Install the application menu. The standard roles carry the editing and
 * window shortcuts a browser surface needs (copy, paste, zoom, reload); the
 * help submenu holds the two things the app can be asked for directly.
 * @param onCheck - runs the manual update check.
 * @param onOpenLog - opens the server log file.
 */
function buildMenu(onCheck: () => void, onOpenLog: () => void): void {
  const platformMenu: MenuItemConstructorOptions = process.platform === 'darwin'
    ? { role: 'appMenu' }
    : { role: 'fileMenu' }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    platformMenu,
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: '检查更新', click: onCheck },
        { label: '查看日志', click: onOpenLog },
      ],
    },
  ]))
}
