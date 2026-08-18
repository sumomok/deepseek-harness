/**
 * The desktop shell's own state file, `desktop-state.json` under the user data
 * directory. It holds what the shell must remember across launches but the
 * server knows nothing about: which build ran last, and what closing the
 * window does.
 *
 * The user data directory is the only place a build can leave a note for its
 * successor — an update replaces the whole install directory, and the
 * uninstaller is invoked with `--updated`, which is what keeps this directory.
 *
 * Every read tolerates a missing or unreadable file and every write tolerates
 * failing: this file is a convenience the shell keeps for itself, never a
 * precondition for running.
 * @module @deepseek-ai/dsh-desktop/desktop-state
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
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
    return state
  } catch {
    // No state yet, or it did not survive. Both mean the same thing to every
    // caller — nothing was remembered — and a launch must never fail over a
    // note the shell keeps for itself.
    return {}
  }
}

/** Replace the file with `state`, dropping the write when the file cannot be written. */
function writeState(state: DesktopState): void {
  try {
    writeFileSync(stateFile(), `${JSON.stringify(state)}\n`)
  } catch {
    // An unwritable state file costs the next launch its receipt and the user
    // their remembered close choice, and nothing else.
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
