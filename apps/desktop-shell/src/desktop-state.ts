/**
 * The desktop shell's own state file, `desktop-state.json` under the user data
 * directory. It holds what the shell must remember across launches but the
 * server knows nothing about: which build ran last, what closing the window
 * does, which update it last handed to the installer, and which port the
 * server last listened on.
 *
 * The user data directory is the only place a build can leave a note for its
 * successor — an update replaces the whole install directory, and the
 * uninstaller is invoked with `--updated`, which is what keeps this directory.
 *
 * Every read tolerates a missing or unreadable file and every write tolerates
 * failing: this file is a convenience the shell keeps for itself, never a
 * precondition for running.
 * @module @deepseek-ai/dsh-desktop-shell/desktop-state
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { StartedInstall } from './pending-cache.ts'
import { isListenPort } from './server-port.ts'
import { compareVersions } from './version-order.ts'

/** What closing the main window does when the user asked not to be asked again. */
export type CloseAction = 'tray' | 'quit'

/** What the state file holds; every field is absent until something writes it. */
export interface DesktopState {
  /** Version of the build that ran last, as `app.getVersion()` reported it. */
  lastRunVersion?: string
  /**
   * The remembered answer to the close dialog. Absent means the dialog runs on
   * every close, which is the state a fresh install starts in.
   */
  closeAction?: CloseAction
  /**
   * The update this build handed to the installer, written at the install
   * click and read by the first launch after it to empty the updater's
   * `pending` directory. Absent when no install is outstanding.
   */
  installedUpdate?: StartedInstall
  /**
   * The loopback port the last started server listened on, asked for again
   * by the next launch; see [[@deepseek-ai/dsh-desktop-shell/server-port]].
   */
  serverPort?: number
}


/** Absolute path of the state file. */
function stateFile(): string {
  return join(app.getPath('userData'), 'desktop-state.json')
}

/**
 * Read the state file.
 * @returns what it holds, or an empty state when there is no readable file.
 */
export function readState(): DesktopState {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf8')) as DesktopState
    const state: DesktopState = {}
    if (typeof parsed.lastRunVersion === 'string') state.lastRunVersion = parsed.lastRunVersion
    if (parsed.closeAction === 'tray' || parsed.closeAction === 'quit') state.closeAction = parsed.closeAction
    const installed = parsed.installedUpdate as Partial<Record<keyof StartedInstall, unknown>> | undefined
    if (typeof installed?.fromVersion === 'string' && typeof installed.fileName === 'string' && typeof installed.sha512 === 'string') {
      state.installedUpdate = { fromVersion: installed.fromVersion, fileName: installed.fileName, sha512: installed.sha512 }
    }
    if (isListenPort(parsed.serverPort)) state.serverPort = parsed.serverPort
    return state
  } catch {
    // No state yet, or it did not survive. Both mean the same thing to every
    // caller — nothing was remembered — and a launch must never fail over a
    // note the shell keeps for itself.
    return {}
  }
}

/**
 * Replace the file with `state`, dropping the write when the file cannot be
 * written. The content goes to `desktop-state.json.tmp` first and is renamed
 * over the file, so a process that dies mid-write leaves the previous file
 * whole: a truncated file reads as empty, and the next write would then drop
 * every field, `installedUpdate` included.
 */
function writeState(state: DesktopState): void {
  const file = stateFile()
  const temporary = `${file}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`)
    renameSync(temporary, file)
  } catch {
    // An unwritable state file costs the next launch its receipt and the user
    // their remembered close choice, and nothing else.
    removeTemporary(temporary)
  }
}

/** Remove a temporary file a failed write left, if it can be removed. */
function removeTemporary(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
    // Something other than a file holds the name, or it cannot be removed; the
    // next write tries the same name and fails the same way, which costs what
    // any unwritable state file costs.
  }
}

/**
 * Record that this build ran, and report the build that ran before it. The
 * caller uses that to confirm an update actually landed: a Windows update
 * restarts the app by itself, so without a word from the new build the whole
 * operation ends with a window that looks exactly like the one that closed.
 * @returns the version that ran before this one, when it was older than this
 * one; undefined on a first run, a re-run of the same build, or a downgrade.
 */
export function recordRun(): string | undefined {
  const state = readState()
  const previous = state.lastRunVersion
  writeState({ ...state, lastRunVersion: app.getVersion() })
  if (previous === undefined || compareVersions(previous, app.getVersion()) >= 0) return undefined
  return previous
}

/**
 * Remember — or forget — what closing the main window does.
 * @param action - the answer to remember, or undefined to ask again on the
 * next close.
 */
export function setCloseAction(action: CloseAction | undefined): void {
  const state = readState()
  if (action === undefined) delete state.closeAction
  else state.closeAction = action
  writeState(state)
}

/**
 * Remember — or forget — the install this build started.
 * @param installed - what was handed to the installer, or undefined once the
 * launch after it has dealt with the staged artifact.
 */
export function setInstalledUpdate(installed: StartedInstall | undefined): void {
  const state = readState()
  if (installed === undefined) delete state.installedUpdate
  else state.installedUpdate = installed
  writeState(state)
}

/**
 * Remember the port the running server listens on, for the next launch.
 * @param port - the port from the server's origin.
 */
export function setServerPort(port: number): void {
  writeState({ ...readState(), serverPort: port })
}
