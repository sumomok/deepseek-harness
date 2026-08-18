/**
 * Electron main process of the DSH desktop client: start the embedded
 * `dsh web` server from the app resources (bundled Node runtime + deployed
 * server closure), open the served UI in a native window, and tear the
 * server down with the app. The window is a plain browser surface — no
 * preload, no Node integration; everything the UI can do goes through the
 * same `/api` transport the browser uses.
 * @module @deepseek-ai/dsh-desktop/main
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { startServer, type ServerHandle, type ServerSpec } from './server.ts'

/**
 * Resolve where the server lives for this launch. Packaged builds use the
 * app resources; a source-tree launch (`pnpm --filter @deepseek-ai/dsh-desktop
 * exec electron lib/main.js`) uses the checkout's built CLI on the
 * development Node found in PATH.
 * @returns the launch spec.
 */
function resolveSpec(): ServerSpec {
  const home = app.getPath('home')
  if (app.isPackaged) {
    const resources = process.resourcesPath
    return {
      nodeBin: join(resources, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node'),
      entry: join(resources, 'server', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      cwd: home,
    }
  }
  return {
    nodeBin: process.env.DSH_DESKTOP_NODE ?? 'node',
    entry: join(app.getAppPath(), '..', 'cli', 'lib', 'bin.js'),
    cwd: home,
  }
}

let server: ServerHandle | undefined
let quitting = false

/** Append one chunk to the session's server log; the file is best-effort. */
function makeLogSink(): (chunk: string) => void {
  const dir = app.getPath('logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Logging must never block the app; a failed sink drops chunks only.
  }
  const file = join(dir, 'dsh-server.log')
  return (chunk) => {
    try {
      appendFileSync(file, chunk)
    } catch {
      // Same best-effort contract as above: the UI keeps running without logs.
    }
  }
}

/** Open one UI window over the served URL. */
function createWindow(url: string): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 900,
    backgroundColor: '#10131a',
    title: 'DSH Desktop',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
    },
  })
  // The UI is same-origin; anything else opens in the system browser.
  window.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault()
      void shell.openExternal(target)
    }
  })
  void window.loadURL(url)
}

const locked = app.requestSingleInstanceLock()
if (!locked) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const [window] = BrowserWindow.getAllWindows()
    if (window !== undefined) {
      if (window.isMinimized()) window.restore()
      window.focus()
    } else if (server !== undefined) {
      createWindow(server.url)
    }
  })

  app.on('window-all-closed', () => {
    // macOS keeps the app (and its server) alive in the Dock; elsewhere the
    // last window ends the app.
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server !== undefined) {
      createWindow(server.url)
    }
  })

  // Async teardown: hold the first quit, stop the server, then exit for real.
  app.on('before-quit', (event) => {
    if (quitting || server === undefined) return
    event.preventDefault()
    quitting = true
    void server.stop().finally(() => { app.exit(0) })
  })

  void app.whenReady().then(async () => {
    try {
      server = await startServer(resolveSpec(), makeLogSink())
      createWindow(server.url)
    } catch (error) {
      dialog.showErrorBox(
        'DSH Desktop could not start its server',
        `${error instanceof Error ? error.message : String(error)}\n\nFull log: ${join(app.getPath('logs'), 'dsh-server.log')}`,
      )
      app.exit(1)
    }
  })
}
