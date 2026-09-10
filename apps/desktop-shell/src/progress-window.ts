/**
 * The one window the update channel puts on screen: the standing notice macOS
 * shows while Squirrel installs. It is built the same way as the boot page — a
 * self-contained `data:` document driven by `executeJavaScript`, with no
 * preload and no IPC channel — and wears the same visual language, so every
 * moment the app speaks for itself looks like one product.
 *
 * The download has no window at all. It runs in the background, reports through
 * the update state the Settings entry reads, and becomes visible only once
 * there is something installable; a window that appeared while bytes moved
 * would be the update asking for attention it was not given.
 * @module @deepseek-ai/dsh-desktop-shell/progress-window
 */

import { BrowserWindow } from 'electron'
import { PALETTES, resolveAppearance, type Appearance } from './theme.ts'

/**
 * The install page: an indeterminate bar, because the installer reports nothing
 * that could fill a determinate one. Its whole job is the sentence about the
 * wait — macOS hands the screen to Squirrel for those seconds, and someone who
 * reads a frozen screen as a hang force-quits into the exact window where the
 * bundle is half replaced.
 * @param version - the version being installed.
 * @param appearance - which palette to paint.
 * @returns the `data:` URL to load.
 */
function installingPage(version: string, appearance: Appearance): string {
  const colors = PALETTES[appearance]
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>正在安装</title><style>
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
  .fill { height: 100%; width: 0; border-radius: 2px; background: ${colors.accent}; }
  .note { margin-top: 14px; font-size: 11px; color: ${colors.muted}; }
  .sweep { width: 40%; animation: sweep 1.5s ease-in-out infinite; }
  @keyframes sweep {
    0% { margin-left: -40%; } 100% { margin-left: 100%; }
  }
  @media (prefers-reduced-motion: reduce) {
    .sweep { animation: none; width: 100%; margin-left: 0; opacity: .5; }
  }
</style></head><body>
  <h1>正在安装 v${version}</h1>
  <div class="track"><div class="fill sweep"></div></div>
  <div class="note">通常要 15 秒上下,机器忙时更久。这期间屏幕可能一直没有反应,是正常的:
    不要强制退出,安装完成后应用会自己重新打开,你的会话记录都在。</div>
</body></html>`)
}

/** The open notice window, if any. */
let window: BrowserWindow | undefined

/**
 * Put the standing install notice on screen. Called on the click that installs,
 * so it is the last thing the app puts up before the installer takes the
 * screen.
 *
 * The window is never `closable: false`: a window that refuses to close cancels
 * `app.quit()`, and the install path quits the app.
 * @param version - the version being installed.
 */
export function showInstalling(version: string): void {
  const existing = window
  if (existing !== undefined && !existing.isDestroyed()) {
    existing.show()
    existing.focus()
    void existing.loadURL(installingPage(version, resolveAppearance()))
    return
  }
  const opened = new BrowserWindow({
    width: 440,
    height: 230,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    backgroundColor: PALETTES[resolveAppearance()].background,
    title: '正在安装更新',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  window = opened
  opened.setMenuBarVisibility(false)
  opened.on('closed', () => {
    if (window === opened) window = undefined
  })
  void opened.loadURL(installingPage(version, resolveAppearance()))
}
