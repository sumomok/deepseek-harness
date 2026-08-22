/**
 * Update channel of the desktop client. Both platforms read the same
 * electron-builder `generic` feed — a static directory of installers plus a
 * `latest*.yml` manifest — and both install from it in place: Windows through
 * NSIS, macOS through Squirrel.Mac.
 *
 * macOS reaches Squirrel only from a code-signed build. Squirrel accepts a
 * replacement bundle only when it satisfies the **running** app's designated
 * requirement, and the two kinds of build differ in exactly that: a build
 * signed by this product's certificate (scripts/sign-mac.cjs) requires
 * `identifier "dev.dsh.desktop" and certificate root = H"<fingerprint>"`, which
 * every later build signed by the same certificate satisfies, while an unsigned
 * build carries the toolchain's ad-hoc linker signature, whose requirement
 * degrades to a `cdhash` naming that one binary and can never be satisfied
 * again. The certificate needs no trust on the machine being updated: it
 * travels inside the signature.
 *
 * So the channel has three tiers, and the first that holds is the one that runs:
 *
 * 1. **In place** — Windows always, macOS when [[macAppIsSigned]] holds.
 * 2. **Download page** — an unsigned macOS build (a local build, or a fork
 *    packaged without a certificate) detects the new version and hands the
 *    download to the system browser ([[checkGeneric]]).
 * 3. **Fallback** — an in-place path that fails while running (the check
 *    errors, Squirrel refuses the bundle, ShipIt fails) drops to tier 2 for the
 *    rest of the run and re-runs the same check there, rather than ending it in
 *    an error box. A download the network interrupted is not one of those: it
 *    is retried in place ([[download]]) and, if the retries run out, left for
 *    the next check on the same tier.
 *
 * The ordinary path runs in three stages and never interrupts what is running:
 * a silent check, one dialog offering the download, and — after the download
 * finishes in a window the user may close at any time — one dialog offering
 * the install. **No install happens without the user deciding it**, on quit or
 * anywhere else: the app replaces itself only in the seconds after someone
 * clicks the button that says so. What follows that click is neither silent nor
 * a wizard — one progress window, no question to answer, and the app comes back
 * by itself — because an install with no surface at all cannot report what it is
 * doing, and the wizard would only ask again what the click already answered. A
 * declined install stays on disk and is offered again on the next launch and on
 * demand from the menu, and nowhere else.
 *
 * Above that sits one mandatory layer, keyed on the feed's `minimumVersion`:
 * a build older than that line downloads without being asked, and at launch it
 * cannot reach the app until the update is installed. The rule is decided in
 * one place ([[isMandatory]]) and read from two.
 * @module @deepseek-ai/dsh-desktop/updater
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, shell, type MenuItemConstructorOptions, type MessageBoxOptions } from 'electron'
import { load } from 'js-yaml'
import { MacUpdater, NsisUpdater, type AppUpdater, type UpdateCheckResult } from 'electron-updater'
import { mainWindow } from './main-window.ts'
import { menuText } from './menu-text.ts'
import { compareVersions } from './version-order.ts'
import { closeProgress, progressVersion, showInstalling, showProgress, showRetrying, updateProgress } from './progress-window.ts'
import { CHECK_RETRY_DELAYS_MS, RETRY_DELAYS_MS, classifyDownloadError, describeDownloadError, withRetry } from './download-retry.ts'

/**
 * The published feed, and **the only URL literal this module may contain**.
 * Anything else — a local feed for an end-to-end test above all — arrives
 * through `DSH_UPDATE_FEED`, so a test endpoint cannot be committed by
 * forgetting to undo an edit. That failure mode is silent where it matters: a
 * build shipped pointing at a machine-local address reports nothing and simply
 * never finds an update again.
 *
 * There is no `app.isPackaged` guard around the override, because the only
 * builds that can exercise the macOS path at all are packaged and signed ones —
 * Squirrel replaces a bundle, so a source-tree launch has nothing to test with.
 * The exposure it adds is nil either way: setting an environment variable in
 * this app's session already requires owning the session.
 */
const FEED_DEFAULT = 'https://lhr.ink/dsh-updates'

/**
 * Base of the static update feed. The per-platform subdirectories match the
 * `publish` blocks in electron-builder.yml, which is what makes one
 * `scripts/publish-update.ts` run serve both platforms.
 */
const FEED_BASE = process.env.DSH_UPDATE_FEED ?? FEED_DEFAULT

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

/** The single updater instance; its event listeners must be registered once. */
let updater: AppUpdater | undefined

/**
 * Whether this macOS bundle carries a real signature, resolved once because the
 * answer cannot change while the app runs.
 */
let macSigned: boolean | undefined

/**
 * Set when the macOS in-place path failed while running. Every later check in
 * this run takes the download-page path instead, and the next launch tries the
 * in-place path again.
 *
 * What demotes is a failure that says this build cannot install this update:
 * a check that could not read the feed, a Squirrel refusal, a signature or
 * checksum verdict. A download the network interrupted does not, because the
 * tier it would abandon is the one that will work on the next attempt.
 */
let macInstallUnavailable = false

/** Version of the update already downloaded and waiting to be installed. */
let stagedVersion: string | undefined

/** Release notes of the staged update, for the install dialog. */
let stagedNotes: string | undefined

/**
 * Whether a download is in flight, which stays true across a retry's wait: the
 * transfer is still the current one, and the `error` listener reads this to
 * tell a download's failure — owned by [[download]] — from a failure anywhere
 * else in the updater.
 */
let downloading = false

/**
 * Whether a check is in flight, which stays true across a retry's wait. The
 * `error` listener reads this to leave a check's failure to whoever called
 * [[checkFeedWithRetry]]: every failed attempt raises the event, and demoting
 * on the first would take the in-place tier away before the retry that would
 * have answered.
 */
let checkInFlight = false

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
 * Whether this macOS bundle is code signed, which is what decides between the
 * first two tiers.
 *
 * The probe is the presence of `Contents/_CodeSignature/CodeResources`: signing
 * a bundle seals its resources and writes that file, while the ad-hoc linker
 * signature an unsigned Electron build carries seals nothing and writes
 * nothing (`Sealed Resources=none`). A `codesign` subprocess would answer the
 * same question, and this runs on every launch's first check — an `existsSync`
 * is the version of the question that costs nothing.
 * @returns true when the bundle was signed with a certificate.
 */
function macAppIsSigned(): boolean {
  // getPath('exe') is <App>.app/Contents/MacOS/<exe>; two levels up is Contents.
  macSigned ??= existsSync(join(dirname(dirname(app.getPath('exe'))), '_CodeSignature', 'CodeResources'))
  return macSigned
}

/**
 * Whether this build can replace itself where it stands, which is what decides
 * between [[checkInPlace]] and [[checkGeneric]] and between the two shapes of
 * the mandatory launch block.
 * @returns true when the update can be installed without leaving the app.
 */
function canInstallInPlace(): boolean {
  if (process.platform === 'win32') return true
  if (process.platform !== 'darwin') return false
  return macAppIsSigned() && !macInstallUnavailable
}

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
 * Ask for the user's attention before a dialog they did not open. An update
 * dialog arrives while the app is in the background as often as not, and a
 * window-modal dialog that the user cannot see is worse than a floating one:
 * on Windows the taskbar button flashes until the window is focused, on macOS
 * the Dock icon bounces once.
 * @param window - the window the dialog will be attached to, if any.
 */
function requestAttention(window: BrowserWindow | undefined): void {
  if (process.platform === 'darwin') {
    if (BrowserWindow.getFocusedWindow() === null) app.dock?.bounce('informational')
    return
  }
  if (window === undefined || window.isFocused()) return
  window.flashFrame(true)
  window.once('focus', () => {
    if (!window.isDestroyed()) window.flashFrame(false)
  })
}

/**
 * Show one dialog, attached to the app's own window on Windows and standing on
 * its own on macOS.
 *
 * On Windows a parentless `showMessageBox` opens an independent top-level
 * window, which the shell is free to place behind whatever the user is working
 * in — the update prompt then exists without being seen. Attaching it makes it
 * window-modal, so it rides on top of the window it belongs to, and a window
 * sitting in the tray is brought back first, because a window-modal dialog
 * owned by a hidden window can be neither seen nor found.
 *
 * On macOS attaching it is what must not happen. A parented dialog is an NSAlert
 * **sheet**, and a sheet ends when anything raises its parent —
 * `BrowserWindow.focus()` is enough — reporting button index 0 as if it had been
 * clicked. Every route back into the app calls [[revealMainWindow]] (the Dock
 * icon, a clicked notification, a second launch), so a sheet here would let a
 * click on the Dock answer 「重启安装」 and install an update nobody agreed to.
 * A parentless dialog on macOS is an app-modal alert panel: it comes forward
 * with the app, and only a button ends it.
 * @param options - the dialog to show.
 * @returns the index of the button the user chose.
 */
async function ask(options: MessageBoxOptions): Promise<number> {
  const parent = mainWindow()
  if (parent !== undefined && !parent.isVisible()) parent.show()
  requestAttention(parent)
  const answer = parent === undefined || process.platform === 'darwin'
    ? await dialog.showMessageBox(options)
    : await dialog.showMessageBox(parent, options)
  return answer.response
}

/**
 * Wire the update channel: build the application menu, run the delayed and
 * recurring silent checks, and expose the manual check the menu triggers.
 * Unpackaged launches skip the whole channel — a source-tree run has no
 * installer to replace and no version the feed could outrank.
 * @param host - logging and quit coordination from the main process.
 * @returns the manual check, so the tray menu offers the same 检查更新 the
 * help menu does rather than a second entry point with its own rules.
 */
export function setupUpdates(host: UpdateHost): () => void {
  const check = app.isPackaged
    ? (reason: CheckReason): void => { void runCheck(host, reason) }
    : (reason: CheckReason): void => {
      host.log('[updater] skipped: development launches have no installed app to replace\n')
      if (reason === 'manual') {
        void ask({
          type: 'info',
          message: '开发模式不检查更新',
          detail: '当前是从源码启动的开发实例,更新只对安装后的应用生效。',
          buttons: ['好'],
        })
      }
    }
  const manual = (): void => { check('manual') }
  // Built before the packaged check: 「查看日志」 is exactly as useful in a
  // development launch, where startup problems are just as likely.
  buildMenu(manual, host.openLog)
  if (!app.isPackaged) return manual
  const first = setTimeout(() => { check('startup') }, FIRST_CHECK_DELAY_MS)
  const recurring = setInterval(() => { check('scheduled') }, CHECK_INTERVAL_MS)
  app.once('before-quit', () => {
    clearTimeout(first)
    clearInterval(recurring)
  })
  return manual
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
    if (canInstallInPlace()) {
      onBlock('这是必须安装的更新,正在下载新版本…')
      void blockWithInstaller(host)
    } else {
      onBlock('这是必须安装的更新,请下载新版本后继续。')
      void blockOnDownloadPage(host)
    }
    return true
  } catch (error) {
    // An unreachable or malformed feed opens the gate: the red line is
    // enforced on a later launch that can read it.
    host.log(`[updater] launch gate skipped: ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  }
}

/**
 * Ask the feed whether this build is below the red line. The verdict is read
 * through whichever path will act on it, so the gate and the block agree on
 * what they saw.
 * @param host - logging and quit coordination from the main process.
 * @returns true when this build may not open the app.
 */
async function resolveGate(host: UpdateHost): Promise<boolean> {
  if (canInstallInPlace()) {
    try {
      const result = await checkFeedWithRetry(host, ensureUpdater(host))
      const minimum = minimumOf(result?.updateInfo)
      if (!isMandatory(minimum)) return false
      stagedNotes = typeof result?.updateInfo.releaseNotes === 'string' ? result.updateInfo.releaseNotes : undefined
      offeredVersion = result?.updateInfo.version
      host.log(`[updater] mandatory: ${app.getVersion()} is below the feed's minimumVersion ${String(minimum)}\n`)
      return true
    } catch (error) {
      if (process.platform !== 'darwin') throw error
      // A check the retries could not get through says nothing about whether
      // this build can replace itself, so the tier survives it and the raw
      // manifest read below still decides this launch.
      if (classifyDownloadError(error) === 'fatal') demoteMac(host, error)
    }
  }
  const feed = await fetchFeed(`${FEED_MAC}/latest-mac.yml`)
  if (!isMandatory(feed.minimumVersion)) return false
  host.log(`[updater] mandatory: ${app.getVersion()} is below the feed's minimumVersion ${String(feed.minimumVersion)}\n`)
  macFeed = feed
  offeredVersion = feed.version
  return true
}

/**
 * Drop macOS to the download-page tier for the rest of this run and say why.
 * One failure reaches this from both sides — the `error` event and the caller's
 * own catch — so only the first is reported; the rest are the same failure.
 * @param host - logging and quit coordination from the main process.
 * @param error - what the in-place path failed with.
 */
function demoteMac(host: UpdateHost, error: unknown): void {
  if (macInstallUnavailable) return
  macInstallUnavailable = true
  const message = error instanceof Error ? error.message : String(error)
  host.log(`[updater] in-place update unavailable (${message}); this run falls back to the download page\n`)
}

/**
 * Ask the feed for its manifest, repeating a check the network interrupted.
 *
 * A check transfers one small manifest, so an interruption costs a request and
 * the retries are worth spending before anything downgrades: the tier is what a
 * failed check used to cost, and it is not recoverable until the next launch.
 * [[checkInFlight]] is held for the whole plan so the `error` event each failed
 * attempt raises is left to this function's caller, which sees the failure once
 * the retries are spent and classifies it there.
 * @param host - logging and quit coordination from the main process.
 * @param instance - the updater to ask.
 * @returns what electron-updater answered, or null when it answered nothing.
 */
async function checkFeedWithRetry(host: UpdateHost, instance: AppUpdater): Promise<UpdateCheckResult | null> {
  checkInFlight = true
  try {
    return await withRetry(async () => instance.checkForUpdates(), CHECK_RETRY_DELAYS_MS, {
      sleep: async (ms) => { await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, ms) }) },
      onRetry: (attempt, total, delayMs, error) => {
        host.log(`[updater] check interrupted (${describeDownloadError(error)}); retry ${String(attempt)}/${String(total)} in ${String(Math.round(delayMs / 1000))}s\n`)
      },
    })
  } finally {
    checkInFlight = false
  }
}

/**
 * Transfer one update, absorbing the interruptions a transfer of this size
 * meets on a working connection.
 *
 * The progress window, the taskbar progress and [[downloading]] are opened and
 * closed here, so the three places that start a download differ only in what
 * they log and what they do with the answer. Each attempt is a whole download:
 * electron-updater sends no `Range` header and deletes the partial file on
 * every failure, so nothing of the interrupted transfer is reused.
 *
 * A transient failure that outlives [[RETRY_DELAYS_MS]] returns false and
 * demotes nothing — a dropped connection says nothing about whether this build
 * can replace itself, so macOS stays on the in-place tier and the next check
 * starts over. A fatal failure — a signature refusal, a checksum mismatch, any
 * `ERR_UPDATER_*` — is thrown after demoting macOS, which is what drops the
 * caller's check to the download page.
 * @param host - logging and quit coordination from the main process.
 * @param version - the version being transferred, for the progress window.
 * @param run - performs one whole download.
 * @returns true when the download finished.
 */
async function download(host: UpdateHost, version: string, run: () => Promise<void>): Promise<boolean> {
  downloading = true
  showProgress(version)
  try {
    await withRetry(run, RETRY_DELAYS_MS, {
      sleep: async (ms) => { await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, ms) }) },
      onRetry: (attempt, total, delayMs, error) => {
        host.log(`[updater] download interrupted (${describeDownloadError(error)}); retry ${String(attempt)}/${String(total)} in ${String(Math.round(delayMs / 1000))}s\n`)
        showRetrying(attempt, total, delayMs)
      },
    })
    return true
  } catch (error) {
    downloading = false
    closeProgress()
    mainWindow()?.setProgressBar(-1)
    const detail = describeDownloadError(error)
    if (classifyDownloadError(error) === 'fatal') {
      host.log(`[updater] download failed: ${detail}\n`)
      if (process.platform === 'darwin') demoteMac(host, error)
      throw error
    }
    host.log(`[updater] download gave up after ${String(RETRY_DELAYS_MS.length)} retries: ${detail}\n`)
    return false
  }
}

/**
 * Tell whoever asked for this check that the transfer did not get through.
 * Only a manual check gets it: a silent one was not asked for, and the next
 * check starts the download over anyway.
 */
async function reportDownloadFailed(): Promise<void> {
  await ask({
    type: 'warning',
    message: '更新下载失败',
    detail: '网络多次中断,下载没有完成。稍后再试,或从「帮助 → 检查更新」重新开始。',
    buttons: ['好'],
  })
}

/**
 * Launch block with an in-place installer: download without asking, then offer
 * the only way forward. A failed download must still leave a way out, so it
 * offers a retry beside quitting — never a state that can neither proceed nor
 * exit. The dialog comes after [[download]] has run its own retries, so the
 * button is offered for a fault that outlasted them rather than for the first
 * dropped packet.
 * @param host - logging and quit coordination from the main process.
 */
async function blockWithInstaller(host: UpdateHost): Promise<void> {
  const blocked = ensureUpdater(host)
  try {
    if (await download(host, offeredVersion ?? '', async () => { await blocked.downloadUpdate() })) return
  } catch (error) {
    // [[download]] logged the failure and cleaned up after it; what the
    // blocking path adds is that this one has no tier to fall back to.
    host.log(`[updater] mandatory download cannot proceed: ${describeDownloadError(error)}\n`)
  }
  const answer = await ask({
    type: 'error',
    title: '更新下载失败',
    message: '必须安装的更新没有下载成功',
    detail: '检查网络后重试,或退出应用稍后再启动。',
    buttons: ['重试', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer === 0) {
    await blockWithInstaller(host)
    return
  }
  app.quit()
}

/**
 * Launch block without an in-place installer: the only paths are downloading
 * the replacement in a browser or quitting.
 * @param host - logging and quit coordination from the main process.
 */
async function blockOnDownloadPage(host: UpdateHost): Promise<void> {
  const feed = macFeed
  const artifact = feed?.files?.[0]?.url
  const answer = await ask({
    type: 'warning',
    title: `必须更新到 ${feed?.version ?? ''}`,
    message: `当前版本 ${app.getVersion()} 需要更新后才能继续使用`,
    detail: notesDetail(feed?.releaseNotes) || `请下载并替换为 ${feed?.version ?? '新版本'}。`,
    buttons: ['去下载', '退出应用'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer === 0 && artifact !== undefined) {
    await openDownloadPage(host, artifact)
  }
  app.quit()
}

/**
 * Hand one feed artifact to the system browser and say what to do with it. The
 * two paths that give up on installing in place end here, so the instructions
 * are written once.
 * @param host - logging and quit coordination from the main process.
 * @param artifact - the manifest's `url` for the artifact to download.
 */
async function openDownloadPage(host: UpdateHost, artifact: string): Promise<void> {
  const target = feedFileUrl(FEED_MAC, artifact)
  host.log(`[updater] opening ${target}\n`)
  await shell.openExternal(target)
  await ask({
    type: 'info',
    message: '下载完成后替换应用',
    detail: '解压得到的 DSH Desktop.app 拖进「应用程序」覆盖旧版本。'
      + '这些构建没有经过 Apple 公证,替换后第一次打开要右键点图标选「打开」,系统才允许运行。',
    buttons: ['好'],
  })
}

/**
 * Run one update check on whichever tier this build can use, falling back one
 * tier when the in-place path fails part-way through. The fallback re-runs the
 * same check rather than deferring it, so one check still ends in one answer.
 *
 * A download the network alone defeated never reaches this catch: [[download]]
 * absorbs it and ends the check where it stands, because the tier is still the
 * right one and re-running the check on the download-page tier would answer a
 * question nobody asked.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function runCheck(host: UpdateHost, reason: CheckReason): Promise<void> {
  if (blocking) return
  try {
    if (canInstallInPlace()) {
      try {
        await checkInPlace(host, reason)
        return
      } catch (error) {
        if (process.platform !== 'darwin') throw error
        // Same rule as the gate: a transient failure that outlived the retries
        // costs this check, which [[checkGeneric]] answers below, not the tier
        // for the rest of the run.
        if (classifyDownloadError(error) === 'fatal') demoteMac(host, error)
      }
    }
    await checkGeneric(host, reason)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    host.log(`[updater] check failed: ${message}\n`)
    if (reason === 'manual') {
      await ask({
        type: 'warning',
        message: '无法检查更新',
        detail: `${message}\n\n稍后再试,或到发布页手动下载新版本。`,
        buttons: ['好'],
      })
    }
  }
}

/**
 * In-place tier, stage one: compare against the feed. What the check finds
 * decides which of the later stages the user sees, and a manual check re-enters
 * whichever stage the update is already in rather than starting over.
 * @param host - logging and quit coordination from the main process.
 * @param reason - what started this check.
 */
async function checkInPlace(host: UpdateHost, reason: CheckReason): Promise<void> {
  const checking = ensureUpdater(host)
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
  const result = await checkFeedWithRetry(host, checking)
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
    host.log(`[updater] mandatory ${version}: downloading without asking\n`)
    void ask({
      type: 'warning',
      title: `必须更新到 ${version}`,
      message: '这是必须安装的更新,已开始后台下载',
      detail: notesDetail(notes) || '下载完成后可以立即重启安装,也可以在下次启动时完成。',
      buttons: ['好'],
    })
    const transferred = await download(host, version, async () => { await checking.downloadUpdate() })
    if (!transferred && reason === 'manual') await reportDownloadFailed()
    return
  }
  if (reason !== 'manual' && declinedVersion === version) {
    host.log(`[updater] ${version} was declined this run; not asking again\n`)
    return
  }
  await offerDownload(host, version, notes, reason)
}

/**
 * In-place tier, stage two: offer the download. Nothing has been transferred
 * yet, so this is the point where an update can be declined at no cost.
 * @param host - logging and quit coordination from the main process.
 * @param version - the version the feed offers.
 * @param notes - release notes from the manifest.
 * @param reason - what started this check, which decides whether a download
 * that never got through is reported or only logged.
 */
async function offerDownload(host: UpdateHost, version: string, notes: string | undefined, reason: CheckReason): Promise<void> {
  const answer = await ask({
    type: 'info',
    title: `发现新版本 ${version}`,
    message: `发现新版本 ${version}`,
    detail: notesDetail(notes) || `当前版本 ${app.getVersion()}。下载在后台进行,完成后再决定什么时候重启。`,
    buttons: ['下载更新', '稍后'],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer !== 0) {
    declinedVersion = version
    host.log(`[updater] user declined ${version}\n`)
    return
  }
  host.log(`[updater] downloading ${version}\n`)
  const started = ensureUpdater(host)
  const transferred = await download(host, version, async () => { await started.downloadUpdate() })
  if (!transferred && reason === 'manual') await reportDownloadFailed()
}

/**
 * Build this platform's updater and register its lifetime listeners. The two
 * classes differ only in which feed and which installer they drive:
 * `download-progress`, `error` and `update-downloaded` carry the same payloads
 * from both, so one set of listeners serves both.
 *
 * `autoInstallOnAppQuit` stays off: this app never replaces itself on the way
 * out, only in the seconds after someone clicks 「重启安装」. On macOS the flag
 * has a second effect — it is also what would let Squirrel pre-fetch the staged
 * bundle from electron-updater's local proxy during the download instead of
 * after the click ([[offerInstall]] documents what that costs).
 * @param host - logging and quit coordination from the main process.
 * @returns the configured updater.
 */
function ensureUpdater(host: UpdateHost): AppUpdater {
  if (updater !== undefined) return updater
  const built: AppUpdater = process.platform === 'darwin'
    ? new MacUpdater({ provider: 'generic', url: FEED_MAC, channel: FEED_CHANNEL })
    : new NsisUpdater({ provider: 'generic', url: FEED_WIN, channel: FEED_CHANNEL })
  built.autoDownload = false
  built.autoInstallOnAppQuit = false
  built.logger = {
    info: (message?: unknown) => { host.log(`[updater] ${String(message)}\n`) },
    warn: (message?: unknown) => { host.log(`[updater] warn: ${String(message)}\n`) },
    error: (message?: unknown) => { host.log(`[updater] error: ${String(message)}\n`) },
    debug: (message: string) => { host.log(`[updater] debug: ${message}\n`) },
  }
  built.on('download-progress', (progress) => {
    updateProgress(progress)
    mainWindow()?.setProgressBar(progress.percent / 100)
  })
  built.on('error', (error) => {
    host.log(`[updater] error: ${error.message}\n`)
    // A failure while a download is in flight is delivered twice: here, and to
    // whoever awaited downloadUpdate(). [[download]] owns that one — it decides
    // whether to retry, keeps the progress window for the retry to write to,
    // and demotes only for a failure that installing again cannot fix. Acting
    // on it here would tear both down for a dropped packet.
    if (downloading) return
    // The same ownership for a check: [[checkFeedWithRetry]] is mid-plan and
    // its caller decides once the retries are spent.
    if (checkInFlight) return
    closeProgress()
    mainWindow()?.setProgressBar(-1)
    // On macOS this listener is the only place a failure inside Squirrel
    // surfaces — the staging and the install run after the promises this module
    // awaits have already settled.
    if (process.platform === 'darwin') demoteMac(host, error)
  })
  built.on('update-downloaded', (info) => {
    // On macOS this is the end of electron-updater's own download, not the end
    // of the install: Squirrel is handed the file at [[offerInstall]].
    downloading = false
    stagedVersion = info.version
    stagedNotes = typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined
    closeProgress()
    mainWindow()?.setProgressBar(-1)
    host.log(`[updater] downloaded ${info.version}; waiting for an explicit install\n`)
    void offerInstall(host, info.version, blocking)
  })
  updater = built
  return built
}

/**
 * What the install click leads to, which is not the same experience on the two
 * platforms and is the one thing the dialog must not get wrong.
 *
 * Windows hands over to the NSIS installer, which paints its own progress bar
 * within a second. macOS hands over to Squirrel, and the click is answered by
 * nothing for around fifteen seconds: about five to stop the server, fetch the
 * staged zip back from electron-updater's local proxy, unpack it and validate
 * its signature, then the rest with a bare screen while ShipIt swaps the
 * bundles — it cannot start until every process of this bundle id has exited,
 * so nothing of this app can be on screen to say so. Measured 14, 16 and 18
 * seconds on an idle machine and 42 with the disk saturated, which is why the
 * wording promises a range and admits it can be longer. Saying it at all is the
 * only defence: a force-quit during those seconds lands exactly in the window
 * where the bundle is half replaced.
 */
const INSTALL_PROMISE = process.platform === 'darwin'
  ? '点击后应用会关闭,安装通常要 15 秒上下(机器忙时更久),期间屏幕可能一直没有反应;完成后会自动重新打开,你的会话记录都在。'
  : '点击后应用会关闭并显示安装进度,完成后自动重新打开;你的会话记录都在。'

/**
 * In-place tier, stage three: the update is on disk and the only question left
 * is when to install it. The default button is 「暂不」 so a reflexive Enter never
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
  const detail = notes === ''
    ? `当前版本 ${app.getVersion()},安装后为 ${version}。\n\n${INSTALL_PROMISE}`
    : `更新内容:\n${notes}\n\n${INSTALL_PROMISE}`
  const answer = await ask({
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
  if (answer !== 0) {
    host.log(`[updater] ${version} stays downloaded; it installs when the user says so\n`)
    return
  }
  if (process.platform === 'darwin') {
    // Put the notice up before the teardown, so nothing about the next fifteen
    // seconds is left to be guessed at. The main window goes with the server it
    // is showing: leaving it up would leave a dead page on screen for the whole
    // install. Windows gets neither, because the installer's own window is up
    // within a second of the same click.
    mainWindow()?.hide()
    showInstalling(version)
  }
  host.log(`[updater] stopping the server before installing ${version}\n`)
  await host.prepareQuit()
  if (process.platform === 'darwin') {
    // MacUpdater.quitAndInstall takes no arguments — it declares the two the
    // base class has and ignores both. It returns immediately, and what follows
    // is Squirrel's: fetch the staged zip from the local proxy electron-updater
    // is still serving, unpack it, check it against this app's designated
    // requirement, then run ShipIt, which waits for this process to exit before
    // it swaps the bundles. The relaunch is Squirrel's `open`, so the new
    // process inherits neither this one's argv nor its environment.
    host.log(`[updater] handing ${version} to Squirrel\n`)
    updater?.quitAndInstall()
    return
  }
  // (isSilent, isForceRunAfter) → the installer's `/S` and `--force-run`.
  //
  // isSilent is false on purpose: an install that shows nothing is
  // indistinguishable from one that failed, and the one surface a silent NSIS
  // run does still put on screen is its error box — `handleUninstallResult`'s
  // MessageBox carries no `/SD`, so 「Failed to uninstall old application
  // files…」 appears even under `/S`, arriving out of nowhere with no window
  // that could explain it. Visible does not mean a wizard here: the directory
  // page skips itself for an `--updated` run (`skipPageIfUpdated`, the
  // template's own macro), `build/installer.nsh` skips the finish page the same
  // way, and MUI's own `SetAutoClose true` closes the progress window when the
  // section ends — what is left is one progress bar that needs no click.
  //
  // isForceRunAfter is passed for the shape of the call rather than its effect:
  // `quitAndInstall` forwards it only when isSilent is true and substitutes
  // `autoRunAppAfterInstall` (default true) otherwise (`BaseUpdater.js`), and
  // the template's own relaunch is `${if} ${isForceRun} ${andIf} ${Silent}`
  // (`installSection.nsh`), which a visible run never satisfies whatever is
  // passed. The relaunch is therefore done by `customFinishPage`, which starts
  // the app through `ExecShellAsUser` so it drops the installer's elevated
  // token.
  //
  // `$INSTDIR` comes from the registry's InstallLocation, read in `.onInit`
  // before any page exists, so neither mode can land anywhere but the directory
  // the app already occupies.
  updater?.quitAndInstall(false, true)
}

/**
 * The download-page tier: read the feed directly and, when it is ahead, open
 * the download in the system browser. This is where an unsigned macOS build
 * lives — it can see a new version but not replace itself with one — and where
 * a signed build lands after its in-place path failed. The dialog is confined
 * to startup and manual checks — a scheduled check mid-session only logs,
 * unless the feed's red line makes the update mandatory.
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
  const answer = await ask({
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
  if (answer !== 0) {
    host.log(`[updater] user postponed ${version}\n`)
    return
  }
  await openDownloadPage(host, artifact)
}

/** Confirm to a manual checker that the installed version is current. */
async function reportUpToDate(): Promise<void> {
  await ask({
    type: 'info',
    message: '已是最新版本',
    detail: `当前版本 ${app.getVersion()}。`,
    buttons: ['好'],
  })
}

/**
 * Install the application menu. The standard roles carry the editing and
 * window shortcuts a browser surface needs (copy, paste, zoom, reload), each
 * with a label of its own; the help submenu holds what the app can be asked
 * for directly.
 * @param onCheck - runs the manual update check.
 * @param onOpenLog - opens the server log file.
 */
function buildMenu(onCheck: () => void, onOpenLog: () => void): void {
  const text = menuText()
  const onAbout = (): void => { void showAbout(text.about) }
  const appName = app.getName()
  const first: MenuItemConstructorOptions = process.platform === 'darwin'
    ? {
      label: appName,
      submenu: [
        { label: `${text.about} ${appName}`, click: onAbout },
        { type: 'separator' },
        { role: 'services', label: text.services },
        { type: 'separator' },
        { role: 'hide', label: `${text.hide} ${appName}` },
        { role: 'hideOthers', label: text.hideOthers },
        { role: 'unhide', label: text.unhide },
        { type: 'separator' },
        { role: 'quit', label: `${text.quit} ${appName}` },
      ],
    }
    : { label: text.file, submenu: [{ role: 'quit', label: text.quit }] }
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    first,
    {
      label: text.edit,
      submenu: [
        { role: 'undo', label: text.undo },
        { role: 'redo', label: text.redo },
        { type: 'separator' },
        { role: 'cut', label: text.cut },
        { role: 'copy', label: text.copy },
        { role: 'paste', label: text.paste },
        { role: 'selectAll', label: text.selectAll },
      ],
    },
    {
      label: text.view,
      submenu: [
        { role: 'reload', label: text.reload },
        { role: 'forceReload', label: text.forceReload },
        { role: 'toggleDevTools', label: text.devTools },
        { type: 'separator' },
        { role: 'resetZoom', label: text.resetZoom },
        { role: 'zoomIn', label: text.zoomIn },
        { role: 'zoomOut', label: text.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text.fullscreen },
      ],
    },
    {
      label: text.window,
      submenu: process.platform === 'darwin'
        ? [
          { role: 'minimize', label: text.minimize },
          { role: 'zoom', label: text.fullscreen },
          { type: 'separator' },
          { role: 'front', label: text.front },
        ]
        : [
          { role: 'minimize', label: text.minimize },
          { role: 'close', label: text.close },
        ],
    },
    {
      role: 'help',
      label: text.help,
      submenu: [
        { label: text.checkUpdate, click: onCheck },
        { label: text.openLog, click: onOpenLog },
        { type: 'separator' },
        { label: text.about, click: onAbout },
      ],
    },
  ]))
}

/**
 * The About dialog: what this is, which build, and where its updates come from.
 * @param title - the localized word for "about", used as the dialog title.
 */
async function showAbout(title: string): Promise<void> {
  await ask({
    type: 'info',
    title,
    message: `${app.getName()} ${app.getVersion()}`,
    detail: `DeepSeek Harness 的桌面客户端,内置 dsh web 服务。\n更新来自 ${FEED_BASE}。`,
    buttons: ['好'],
  })
}
