/**
 * Closing the window on Windows without ending the session.
 *
 * A `dsh` session is a running agent with a running server behind it, so the
 * window's close button asks a question the operating system cannot answer for
 * us: put the app in the notification area and keep working, or stop
 * everything. The first close asks; 「记住我的选择」 writes the answer into
 * `desktop-state.json`, and the tray menu takes it back.
 *
 * **Windows only.** macOS already has this behavior and a different name for
 * it: closing the window leaves the app in the Dock, `window-all-closed` does
 * not quit there, and `activate` opens the window again — a menu-bar icon
 * beside the Dock icon would be a second control for one state. Linux desktop
 * targets are unbuilt.
 *
 * Quitting always goes through `app.quit()` and therefore through the
 * `before-quit` teardown that stops the embedded server: this module never
 * destroys a window itself, because a window destroyed behind that chain's
 * back leaves the server process tree running.
 * @module @deepseek-ai/dsh-desktop/tray
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog, Menu, nativeImage, Tray, type BrowserWindow } from 'electron'
import { readState, setCloseAction, type CloseAction } from './desktop-state.ts'
import { menuText } from './menu-text.ts'

/** What the tray needs from the main process. */
export interface TrayHost {
  /** Append one line to the desktop log sink (the `dsh-server.log` stream). */
  log: (line: string) => void
  /**
   * Bring the app window back, creating it when the app has none. The tray
   * cannot do this itself: only the main process knows the served URL.
   */
  reveal: () => void
  /** Run the manual update check, the same one 帮助 → 检查更新 runs. */
  checkForUpdates: () => void
  /**
   * Whether a quit is already under way. The close handler must stand aside
   * then — the windows are being closed *by* the teardown, and intercepting
   * that would hold the app open forever.
   */
  isQuitting: () => boolean
}

/** The tray icon, once created. Undefined on every platform but Windows. */
let tray: Tray | undefined

/** Set by [[setupTray]]; the close handler and the menu both run against it. */
let host: TrayHost | undefined

/**
 * The tray icon image, taken from the same `.ico` the installer and the
 * executable wear. The file is a single 256px frame, so it is resized here
 * rather than left to the shell's own downscale of a notification-area icon.
 * @returns the 16px icon, or undefined when the file is not there — a
 * development launch that never ran `pnpm run gen-icons`.
 */
function trayIcon(): Electron.NativeImage | undefined {
  const file = app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(app.getAppPath(), 'build', 'icon.ico')
  if (!existsSync(file)) return undefined
  return nativeImage.createFromPath(file).resize({ width: 16, height: 16 })
}

/**
 * Build (or rebuild) the context menu. It is rebuilt rather than mutated
 * because 「关闭时询问」 reflects `desktop-state.json`, which the close dialog
 * also writes.
 */
function refreshMenu(): void {
  if (tray === undefined || host === undefined) return
  const text = menuText()
  const bound = host
  const remembered = readState().closeAction
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${text.open} ${app.getName()}`, click: () => { bound.reveal() } },
    { label: text.checkUpdate, click: () => { bound.checkForUpdates() } },
    { type: 'separator' },
    {
      label: text.askOnClose,
      type: 'checkbox',
      // Checked means "no answer is remembered", so the only transition this
      // item can perform is clearing one. Disabling it when nothing is
      // remembered keeps the checkbox from being toggled into a state it
      // cannot express, which would flip back on the next rebuild.
      checked: remembered === undefined,
      enabled: remembered !== undefined,
      click: () => {
        setCloseAction(undefined)
        refreshMenu()
      },
    },
    { type: 'separator' },
    { label: text.quit, click: () => { app.quit() } },
  ]))
}

/**
 * Create the tray icon and register its lifetime. A launch that cannot find
 * the icon file says so and runs without a tray, which also means the close
 * button keeps its ordinary behavior.
 * @param trayHost - what the tray needs from the main process.
 */
export function setupTray(trayHost: TrayHost): void {
  if (process.platform !== 'win32') return
  const icon = trayIcon()
  if (icon === undefined) {
    trayHost.log('[desktop] no tray icon file; closing the window quits as usual\n')
    return
  }
  // Set with the tray and not before it: the close handler reads both, and a
  // launch with no tray must find no decision to apply either.
  host = trayHost
  tray = new Tray(icon)
  tray.setToolTip(app.getName())
  tray.on('click', () => { trayHost.reveal() })
  refreshMenu()
  app.once('before-quit', () => {
    // The icon belongs to a process that is leaving. Windows removes it when
    // the process dies, but only once something touches the notification area.
    tray?.destroy()
    tray = undefined
  })
}

/**
 * Intercept one window's close button, when there is a tray to close into.
 * Called for every app window the shell opens.
 * @param window - the window to guard.
 */
export function guardWindowClose(window: BrowserWindow): void {
  window.on('close', (event) => {
    const bound = host
    if (tray === undefined || bound === undefined || bound.isQuitting()) return
    event.preventDefault()
    const remembered = readState().closeAction
    if (remembered !== undefined) {
      applyCloseAction(remembered, window)
      return
    }
    void askCloseAction(window)
  })
}

/**
 * Carry out one close answer.
 * @param action - what the user chose, or chose once and had remembered.
 * @param window - the window that was asked to close.
 */
function applyCloseAction(action: CloseAction, window: BrowserWindow): void {
  if (action === 'quit') {
    // Not `window.destroy()`: the teardown that stops the embedded server
    // hangs off `before-quit`, and only `app.quit()` reaches it.
    app.quit()
    return
  }
  // `hide()` — not `minimize()` — is what takes the taskbar button with it.
  window.hide()
}

/**
 * Ask what closing should do, and remember the answer when asked to.
 * @param window - the window that was asked to close; the dialog's parent.
 */
async function askCloseAction(window: BrowserWindow): Promise<void> {
  const answer = await dialog.showMessageBox(window, {
    type: 'question',
    title: '关闭窗口',
    message: '关闭窗口后要怎么做?',
    detail: '最小化到托盘后应用继续在后台运行,正在跑的任务不会中断。'
      + '退出应用会停掉内置的 dsh 服务,没跑完的任务也会一起停下。',
    buttons: ['最小化到托盘', '退出应用'],
    defaultId: 0,
    // Dismissing the dialog picks the answer that loses nothing.
    cancelId: 0,
    checkboxLabel: '记住我的选择',
    checkboxChecked: false,
  })
  const action: CloseAction = answer.response === 0 ? 'tray' : 'quit'
  if (answer.checkboxChecked) {
    setCloseAction(action)
    refreshMenu()
    host?.log(`[desktop] closing the window now means: ${action}\n`)
  }
  // A quit started from the tray menu while this dialog was open destroys the
  // window under it; there is then nothing left to hide and nothing to quit.
  if (window.isDestroyed()) return
  applyCloseAction(action, window)
}
