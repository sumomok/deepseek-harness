/**
 * Finding the app's own window among the windows the shell may have open.
 *
 * The shell opens exactly two kinds of window: the app window, which carries
 * the boot page and then the served UI, and the download progress popup, which
 * is fixed-size. `isResizable()` is therefore the discriminator — the popup
 * declares `resizable: false` and the app window never does.
 * @module @deepseek-ai/dsh-desktop/main-window
 */

import { BrowserWindow } from 'electron'

/**
 * The app's own window.
 * @returns the window, or undefined when it is closed (macOS keeps the app
 * running without one) or not yet created.
 */
export function mainWindow(): BrowserWindow | undefined {
  return BrowserWindow.getAllWindows().find(candidate => candidate.isResizable())
}

/**
 * Bring the app window back from wherever it went — hidden in the tray,
 * minimized, or merely behind something else. Does nothing when there is no
 * window; the caller that can create one handles that case itself.
 */
export function revealMainWindow(): void {
  const window = mainWindow()
  if (window === undefined) return
  if (window.isMinimized()) window.restore()
  if (!window.isVisible()) window.show()
  window.focus()
}
