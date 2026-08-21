/**
 * The window the update channel speaks through while it is working: a
 * determinate bar for the download, and — on macOS only — a standing notice
 * while Squirrel installs. Both are built the same way as the boot page — a
 * self-contained `data:` document driven by `executeJavaScript`, with no
 * preload and no IPC channel — and wear the same visual language, so every
 * moment the app speaks for itself looks like one product.
 *
 * The window is a view, never a controller: closing it does not cancel the
 * download, and the download does not depend on it being open. That is why it
 * owns no updater state and exposes only "show these numbers", "say the
 * transfer was interrupted", and "go away".
 * @module @deepseek-ai/dsh-desktop/progress-window
 */

import { BrowserWindow } from 'electron'
import { PALETTES, resolveAppearance, type Appearance } from './theme.ts'

/** One `download-progress` sample, in the units the event reports. */
export interface DownloadProgress {
  /** Completion from 0 to 100. */
  percent: number
  /** Bytes received so far. */
  transferred: number
  /** Total bytes of the artifact. */
  total: number
  /** Current rate in bytes per second. */
  bytesPerSecond: number
}

/**
 * The chrome both pages share: the palette, the layout, and the heading. Only
 * the body below the heading differs.
 * @param title - the window document's title.
 * @param heading - the line at the top of the page.
 * @param appearance - which palette to paint, matching the boot page.
 * @param body - the markup and script below the heading.
 * @returns the `data:` URL to load.
 */
function page(title: string, heading: string, appearance: Appearance, body: string): string {
  const colors = PALETTES[appearance]
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; padding: 26px 28px;
    display: flex; flex-direction: column; justify-content: center;
    background: ${colors.gradient};
    color: ${colors.text}; font: 13px/1.6 system-ui, -apple-system, "PingFang SC", sans-serif;
    user-select: none;
  }
  h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: .01em; }
  .track { margin: 18px 0 12px; height: 4px; border-radius: 2px; background: ${colors.track}; overflow: hidden; }
  .fill { height: 100%; width: 0; border-radius: 2px; background: ${colors.accent}; transition: width .2s linear; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .percent {
    font: 700 20px/1.2 ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
    color: ${colors.text};
  }
  .stats {
    text-align: right; color: ${colors.muted};
    font: 12px/1.5 ui-monospace, "SF Mono", "Cascadia Code", Consolas, Menlo, monospace;
  }
  .note { margin-top: 14px; font-size: 11px; color: ${colors.muted}; }
  .status { margin-top: 10px; font-size: 12px; color: ${colors.text}; min-height: 1.6em; }
  .sweep { width: 40%; animation: sweep 1.5s ease-in-out infinite; }
  @keyframes sweep {
    0% { margin-left: -40%; } 100% { margin-left: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sweep { animation: none; width: 100%; margin-left: 0; opacity: .5; }
  }
</style></head><body>
  <h1>${heading}</h1>
  ${body}
</body></html>`)
}

/**
 * The download page. Static except for the numbers and the status line pushed
 * into it, so the document is built once per download and never rebuilt.
 *
 * The status line is the only part of the page that is not the transfer's own
 * numbers: an interrupted download is retried without closing this window, and
 * a bar that stops moving with nothing said about it reads as a hang. The next
 * sample clears the line, so a resumed download needs no separate call to take
 * the notice back down.
 * @param version - the version being downloaded, shown in the heading.
 * @param appearance - which palette to paint.
 * @returns the `data:` URL to load.
 */
function progressPage(version: string, appearance: Appearance): string {
  return page('正在下载', `正在下载 v${version}`, appearance, `
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="row">
    <div class="percent" id="percent">0%</div>
    <div class="stats"><span id="size">0.0 / 0.0 MB</span><br><span id="speed">0.0 MB/s</span></div>
  </div>
  <div class="status" id="status"></div>
  <div class="note">关掉这个窗口不会中断下载,下载完成后会询问你什么时候重启。</div>
<script>
  const mb = (bytes) => (bytes / 1048576).toFixed(1)
  window.__dshProgress = (percent, transferred, total, bytesPerSecond) => {
    document.getElementById('fill').style.width = percent.toFixed(1) + '%'
    document.getElementById('percent').textContent = Math.floor(percent) + '%'
    document.getElementById('size').textContent = mb(transferred) + ' / ' + mb(total) + ' MB'
    document.getElementById('speed').textContent = mb(bytesPerSecond) + ' MB/s'
    document.getElementById('status').textContent = ''
  }
  window.__dshStatus = (text) => {
    document.getElementById('status').textContent = text
  }
</script>`)
}

/**
 * The install page: the same surface with an indeterminate bar, because the
 * installer reports nothing that could fill a determinate one. Its whole job is
 * the sentence about the wait — macOS hands the screen to Squirrel for those
 * seconds, and someone who reads a frozen screen as a hang force-quits into the
 * exact window where the bundle is half replaced.
 * @param version - the version being installed.
 * @param appearance - which palette to paint.
 * @returns the `data:` URL to load.
 */
function installingPage(version: string, appearance: Appearance): string {
  return page('正在安装', `正在安装 v${version}`, appearance, `
  <div class="track"><div class="fill sweep"></div></div>
  <div class="note">通常要 15 秒上下,机器忙时更久。这期间屏幕可能一直没有反应,是正常的:
    不要强制退出,安装完成后应用会自己重新打开,你的会话记录都在。</div>`)
}

/** The open progress window, if any. */
let window: BrowserWindow | undefined

/** The version being downloaded, so a reopened window carries the right heading. */
let shownVersion: string | undefined

/** The last sample, so a reopened window starts from the current numbers. */
let lastSample: DownloadProgress | undefined

/**
 * The standing status line, so a reopened window carries it. The next sample
 * clears it, because a sample is what a resumed download produces.
 */
let lastStatus: string | undefined

/**
 * Evaluate one statement in the open page. Nothing happens when no window is
 * open: the download runs without one, and the state kept here is what a later
 * window is rebuilt from.
 * @param statement - the JavaScript to evaluate.
 */
function push(statement: string): void {
  if (window === undefined || window.isDestroyed()) return
  window.webContents.executeJavaScript(statement).catch(() => {
    // The page may still be loading or the window may be closing; neither a
    // progress sample nor a retry notice is information worth retrying for,
    // and the next call lands a moment later.
  })
}

/**
 * Put one line of standing text under the bar and remember it.
 * @param text - what to show.
 */
function setStatus(text: string): void {
  lastStatus = text
  push(`window.__dshStatus(${JSON.stringify(text)})`)
}

/**
 * The window both pages share, created on first use and reused afterwards. It
 * is never `closable: false`, whatever it is showing: a window that refuses to
 * close cancels `app.quit()`, and the install path quits the app.
 * @param title - the window's own title.
 * @param height - the height this page's text needs.
 * @returns the window, raised and focused.
 */
function raise(title: string, height: number): BrowserWindow {
  const existing = window
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.setTitle(title)
    existing.setContentSize(440, height)
    existing.show()
    existing.focus()
    return existing
  }
  const opened = new BrowserWindow({
    width: 440,
    height,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: PALETTES[resolveAppearance()].background,
    title,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  window = opened
  opened.setMenuBarVisibility(false)
  opened.on('closed', () => {
    // Only the view is gone; the download keeps running and the taskbar keeps
    // showing it, which is why nothing here touches the updater.
    if (window === opened) window = undefined
  })
  return opened
}

/**
 * Open the download window, or focus it when it is already open. A window
 * already showing this download is only raised, so a manual check mid-download
 * rejoins the numbers on screen instead of resetting them to zero.
 * @param version - the version being downloaded.
 */
export function showProgress(version: string): void {
  const rejoining = shownVersion === version && window !== undefined && !window.isDestroyed()
  shownVersion = version
  const opened = raise('正在下载更新', 200)
  if (rejoining) return
  void opened.loadURL(progressPage(version, resolveAppearance()))
  opened.webContents.once('did-finish-load', () => {
    const status = lastStatus
    if (lastSample !== undefined) updateProgress(lastSample)
    if (status !== undefined) setStatus(status)
  })
}

/**
 * Say that the download was interrupted and is about to be attempted again.
 * The window stays open across the retry — the transfer restarts from zero, so
 * closing and reopening it would be the only thing on screen that looked like
 * progress — and the notice is replaced by the numbers as soon as bytes arrive
 * again.
 * @param attempt - which retry this is, counting from 1.
 * @param total - how many retries the plan allows.
 * @param delayMs - the wait before this retry.
 */
export function showRetrying(attempt: number, total: number, delayMs: number): void {
  setStatus(`下载中断,${String(Math.round(delayMs / 1000))} 秒后重试(${String(attempt)}/${String(total)})…`)
}

/**
 * Replace whatever is on screen with the standing install notice. Called on the
 * click that installs, so it is the last thing the app puts up before the
 * installer takes the screen.
 * @param version - the version being installed.
 */
export function showInstalling(version: string): void {
  shownVersion = undefined
  lastSample = undefined
  lastStatus = undefined
  void raise('正在安装更新', 230).loadURL(installingPage(version, resolveAppearance()))
}

/**
 * Push one sample into the window when it is open, and remember it so a
 * reopened window does not start from zero. Bytes arriving is also what takes
 * a standing retry notice back down.
 * @param progress - the latest `download-progress` sample.
 */
export function updateProgress(progress: DownloadProgress): void {
  lastSample = progress
  lastStatus = undefined
  push(`window.__dshProgress(${String(progress.percent)}, ${String(progress.transferred)}, ${String(progress.total)}, ${String(progress.bytesPerSecond)})`)
}

/** Close the progress window and forget the download it was showing. */
export function closeProgress(): void {
  lastSample = undefined
  lastStatus = undefined
  shownVersion = undefined
  if (window !== undefined && !window.isDestroyed()) window.close()
  window = undefined
}

/** Whether a download is being shown, which is what makes reopening meaningful. */
export function progressVersion(): string | undefined {
  return shownVersion
}
