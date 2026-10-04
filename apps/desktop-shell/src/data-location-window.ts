/**
 * The Electron half of the data-location launch step: message boxes and the
 * folder picker parented on the boot window, the system's PowerShell on
 * Windows, and the login shell on macOS. The decisions themselves are in
 * [[@deepseek-ai/dsh-desktop-shell/data-location-boot]].
 * @module @deepseek-ai/dsh-desktop-shell/data-location-window
 */

import { app, dialog, shell, type BrowserWindow } from 'electron'
import { PRODUCT_NAME } from './brand.ts'
import { defaultHarnessHome, type DataLocationHost } from './data-location-boot.ts'
import { dataLocationText } from './data-location-text.ts'
import {
  LOGIN_SHELL_TIMEOUT_MS, readPersistentDshHome, systemPowerShell, windowsSystemRoot, writeTerminalDshHome, type TerminalEnvHost,
} from './terminal-env.ts'

/** Milliseconds one PowerShell run may take before it is killed. */
const POWERSHELL_TIMEOUT_MS = 15_000

/**
 * The host the launch step runs against in the app.
 * @param window - the boot window the boxes are parented on.
 * @param block - shows one sentence on the boot page while a box is open; an empty sentence clears it.
 * @param log - the desktop log sink.
 * @returns the host.
 */
export function appDataLocationHost(
  window: BrowserWindow, block: (message: string) => void, log: (line: string) => void,
): DataLocationHost {
  const locale = app.getLocale()
  const text = dataLocationText(locale)
  const title = PRODUCT_NAME[locale.startsWith('zh') ? 'zh' : 'en']
  const osHome = app.getPath('home')
  const terminal: TerminalEnvHost = {
    platform: process.platform,
    env: process.env,
    home: osHome,
    powershell: systemPowerShell(windowsSystemRoot(process.env), POWERSHELL_TIMEOUT_MS),
    shellTimeoutMs: LOGIN_SHELL_TIMEOUT_MS,
  }
  return {
    userData: app.getPath('userData'),
    defaultHome: defaultHarnessHome(osHome),
    osHome,
    platform: process.platform,
    env: process.env,
    text,
    log,
    readPersistentEnv: async () => await readPersistentDshHome(terminal),
    writeTerminalEnv: async value => await writeTerminalDshHome(terminal, value),
    ask: async (view) => {
      block(view.message)
      const answer = await dialog.showMessageBox(window, {
        type: 'warning',
        title,
        message: view.message,
        detail: view.detail,
        buttons: view.buttons.map(button => button.label),
        defaultId: 0,
        cancelId: view.cancelIndex,
        noLink: true,
      })
      block('')
      const chosen = view.buttons[answer.response] ?? view.buttons[view.cancelIndex]
      if (chosen === undefined) throw new Error('a data-location prompt has no cancel button')
      return chosen.answer
    },
    chooseFolder: async (title) => {
      const picked = await dialog.showOpenDialog(window, { title, properties: ['openDirectory', 'dontAddToRecent'] })
      return picked.canceled ? undefined : picked.filePaths[0]
    },
    reveal: (path) => { shell.showItemInFolder(path) },
    tell: async (message) => {
      await dialog.showMessageBox(window, { type: 'info', title, message, buttons: [text.ok] })
    },
  }
}
