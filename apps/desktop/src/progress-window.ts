/**
 * The download progress window shown while an update downloads. It is built
 * the same way as the boot page — a self-contained `data:` document driven by
 * `executeJavaScript`, with no preload and no IPC channel — and wears the same
 * visual language, so the two moments the app speaks for itself look like one
 * product.
 *
 * The window is a view, never a controller: closing it does not cancel the
 * download, and the download does not depend on it being open. That is why it
 * owns no updater state and exposes only "show these numbers" and "go away".
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
 * The progress page. Static except for the numbers pushed into it, so the
 * document is built once per download and never rebuilt.
 * @param version - the version being downloaded, shown in the heading.
 * @param appearance - which palette to paint, matching the boot page.
 * @returns the `data:` URL to load.
 */
function progressPage(version: string, appearance: Appearance): string {
  const colors = PALETTES[appearance]
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>正在下载</title><style>
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
</style></head><body>
  <h1>正在下载 v${version}</h1>
  <div class="track"><div class="fill" id="fill"></div></div>
  <div class="row">
    <div class="percent" id="percent">0%</div>
    <div class="stats"><span id="size">0.0 / 0.0 MB</span><br><span id="speed">0.0 MB/s</span></div>
  </div>
  <div class="note">关掉这个窗口不会中断下载,下载完成后会询问你什么时候重启。</div>
<script>
  const mb = (bytes) => (bytes / 1048576).toFixed(1)
  window.__dshProgress = (percent, transferred, total, bytesPerSecond) => {
    document.getElementById('fill').style.width = percent.toFixed(1) + '%'
    document.getElementById('percent').textContent = Math.floor(percent) + '%'
    document.getElementById('size').textContent = mb(transferred) + ' / ' + mb(total) + ' MB'
    document.getElementById('speed').textContent = mb(bytesPerSecond) + ' MB/s'
  }
</script></body></html>`)
}

/** The open progress window, if any. */
let window: BrowserWindow | undefined

/** The version being downloaded, so a reopened window carries the right heading. */
let shownVersion: string | undefined

/** The last sample, so a reopened window starts from the current numbers. */
let lastSample: DownloadProgress | undefined

/**
 * Open the progress window, or focus it when it is already open.
 * @param version - the version being downloaded.
 */
export function showProgress(version: string): void {
  shownVersion = version
  if (window !== undefined && !window.isDestroyed()) {
    window.show()
    window.focus()
    return
  }
  const appearance = resolveAppearance()
  window = new BrowserWindow({
    width: 440,
    height: 200,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: PALETTES[appearance].background,
    title: '正在下载更新',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  window.setMenuBarVisibility(false)
  const opened = window
  void opened.loadURL(progressPage(version, appearance))
  opened.webContents.once('did-finish-load', () => {
    if (lastSample !== undefined) updateProgress(lastSample)
  })
  opened.on('closed', () => {
    // Only the view is gone; the download keeps running and the taskbar keeps
    // showing it, which is why nothing here touches the updater.
    if (window === opened) window = undefined
  })
}

/**
 * Push one sample into the window when it is open, and remember it so a
 * reopened window does not start from zero.
 * @param progress - the latest `download-progress` sample.
 */
export function updateProgress(progress: DownloadProgress): void {
  lastSample = progress
  if (window === undefined || window.isDestroyed()) return
  window.webContents.executeJavaScript(
    `window.__dshProgress(${String(progress.percent)}, ${String(progress.transferred)}, ${String(progress.total)}, ${String(progress.bytesPerSecond)})`,
  ).catch(() => {
    // The page may still be loading or the window may be closing; the next
    // sample lands a moment later and progress is not information worth
    // retrying for.
  })
}

/** Close the progress window and forget the download it was showing. */
export function closeProgress(): void {
  lastSample = undefined
  shownVersion = undefined
  if (window !== undefined && !window.isDestroyed()) window.close()
  window = undefined
}

/** Whether a download is being shown, which is what makes reopening meaningful. */
export function progressVersion(): string | undefined {
  return shownVersion
}
