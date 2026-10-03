/**
 * The Electron half of the data move: the move's own window, which shows the
 * progress and the move's pages, and the terminal effects the executor asks
 * the main process to run. The window is a self-contained `data:` document
 * with no preload and no Node integration; its buttons are `dsh-move://`
 * links that `will-navigate` intercepts and never loads (plan D7, confirmed
 * with a real Electron 43 probe). The decisions are in
 * [[@deepseek-ai/dsh-desktop-shell/move-flow]].
 * @module @deepseek-ai/dsh-desktop-shell/move-window
 */

import { app, BrowserWindow, shell } from 'electron'
import { appDataLocationHost } from './data-location-window.ts'
import { defaultHarnessHome } from './data-location-boot.ts'
import type { MoveFlowDeps, MoveUi } from './move-flow.ts'
import { moveText } from './move-text.ts'
import { nameLocale } from './move/names.ts'
import { pageDocument, parseMoveLink, progressDocument, type MoveLink, type MovePage, type ProgressView } from './move-page.ts'
import type { MoveText } from './move-text.ts'
import type { ExecutorBefore, MainEffects } from './move/executor.ts'
import { moveDir } from './move/journal.ts'
import type { LockSelf } from './move/lock.ts'
import { nodeLockProbes } from './process-tree.ts'
import { systemPowerShell, windowsSystemRoot } from './terminal-env.ts'
import { restoreTerminal } from './terminal-restore.ts'
import { syncMoveTerminal } from './terminal-sync-record.ts'
import { PALETTES, resolveAppearance } from './theme.ts'

/** Milliseconds one PowerShell run may take before it is killed. */
const POWERSHELL_TIMEOUT_MS = 15_000

/** The move's window, as the flow drives it. */
export interface MoveWindow extends MoveUi {
  window: BrowserWindow
  /** Ask the move to cancel, as the cancel button does (a quit during the move). */
  requestCancel: () => void
  /** Close the window without asking anything more of it. */
  close: () => void
}

/**
 * Open the move's window on the progress page.
 * @param text - the sentence set.
 * @param log - the desktop log sink.
 * @returns the window and its drive.
 */
export function openMoveWindow(text: MoveText, log: (line: string) => void): MoveWindow {
  const appearance = resolveAppearance()
  const window = new BrowserWindow({
    width: 560,
    height: 340,
    resizable: false,
    maximizable: false,
    backgroundColor: PALETTES[appearance].background,
    title: 'DSH Desktop',
    webPreferences: { sandbox: true, contextIsolation: true },
  })
  const cancel = new AbortController()
  let page: MovePage | undefined
  let answer: ((link: Exclude<MoveLink, { kind: 'reveal' }>) => void) | undefined
  let progress = true
  let closing = false
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    const link = parseMoveLink(url)
    if (link === undefined) return
    switch (link.kind) {
      case 'cancel':
        log('[desktop] data move: the person asked to cancel\n')
        cancel.abort()
        break
      case 'reveal': {
        const path = page?.reveal[link.index]
        if (path !== undefined) shell.showItemInFolder(path)
        break
      }
      case 'choose':
      case 'quit':
      case 'discard-lock':
      case 'confirm':
      case 'back':
      case 'abandon':
      case 'retry':
      case 'roll-back':
        answer?.(link)
        answer = undefined
        break
      default:
        link satisfies never
    }
  })
  window.on('close', (event) => {
    if (closing) return
    if (progress) {
      // Closing the progress window asks to cancel; a move past its copy runs to its end, where the app relaunches.
      event.preventDefault()
      cancel.abort()
      return
    }
    answer?.({ kind: 'quit' })
    answer = undefined
  })
  void window.loadURL(progressDocument(text, appearance))
  return {
    window,
    cancel: cancel.signal,
    showProgress: (view: ProgressView) => {
      if (!progress || window.isDestroyed()) return
      window.webContents.executeJavaScript(`window.__move.show(${JSON.stringify(view)})`).catch(() => {
        // The page may still be loading; the next report carries the same state.
      })
    },
    showPage: (next) => {
      page = next
      progress = false
      if (!window.isDestroyed()) void window.loadURL(pageDocument(next, appearance))
      return new Promise((resolve) => { answer = resolve })
    },
    requestCancel: () => { cancel.abort() },
    close: () => {
      closing = true
      if (!window.isDestroyed()) window.close()
    },
  }
}

/**
 * The terminal effects of a move in the app: the launch's own terminal sync
 * (write, then read back) for the switch, recorded for the launches that
 * finish the move ({@link syncMoveTerminal}), and the snapshot restore for a
 * rollback.
 * @param window - the window the launch prompts would be parented on.
 * @param dir - the move directory, for the journal's identity and the value last seen before the move.
 * @param log - the desktop log sink.
 * @returns the effects.
 */
export function appMoveMainEffects(window: BrowserWindow, dir: string, log: (line: string) => void): MainEffects {
  const host = appDataLocationHost(window, () => undefined, log)
  const powershell = systemPowerShell(windowsSystemRoot(process.env), POWERSHELL_TIMEOUT_MS)
  return {
    syncTerminal: target => syncMoveTerminal(host, dir, app.getPath('userData'), target),
    restoreTerminal: async (snapshot) => {
      try {
        log(`[desktop] data move: terminal restored: ${await restoreTerminal(snapshot, powershell)}\n`)
      } catch (error) {
        log(`[desktop] data move: could not put the terminal setting back; the rollback finishes without it: ${String(error)}\n`)
        throw error
      }
    },
  }
}

/**
 * Everything a move flow needs in the app, for the move recorded under this
 * installation's user data.
 * @param window - the window the terminal and launch prompts are parented on.
 * @param ui - the windows the flow shows (the move's window, or none for a background cleanup).
 * @param log - the desktop log sink.
 * @param lockSelf - this installation and process, as the move lock records them.
 * @param before - a step the worker takes before carrying the move on (a failed health check), if any.
 * @returns the flow's dependencies.
 */
export function appMoveFlowDeps(
  window: BrowserWindow, ui: MoveUi, log: (line: string) => void, lockSelf: LockSelf, before?: ExecutorBefore,
): MoveFlowDeps {
  const userData = app.getPath('userData')
  const dir = moveDir(userData)
  const locale = nameLocale(app.getLocale())
  return {
    request: {
      dir, userData, defaultHome: defaultHarnessHome(app.getPath('home')), platform: process.platform, locale, pid: process.pid, lockSelf,
      ...before === undefined ? {} : { before },
    },
    main: appMoveMainEffects(window, dir, log),
    ui,
    text: moveText(app.getLocale()),
    locale,
    abandoned: appDataLocationHost(window, () => undefined, log),
    log,
    now: () => new Date(),
    lockProbes: nodeLockProbes(process.platform),
  }
}
