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
 * Reads tolerate a missing or unreadable file. Writes report failure to the
 * caller: startup remains available, but the installer must not run unless its
 * receipt was durably recorded.
 * @module @deepseek-ai/dsh-desktop-shell/desktop-state
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { StartedInstall } from './pending-cache.ts'
import { isSameBuild, parseReleaseIdentity, type ReleaseIdentity } from './release-identity.ts'
import { isListenPort } from './server-port.ts'
import { compareVersions } from './version-order.ts'

/** What closing the main window does when the user asked not to be asked again. */
export type CloseAction = 'tray' | 'quit'

/**
 * The install one build handed to the installer, in build-identity terms.
 *
 * The earlier [[StartedInstall]] names only the version that started the
 * install, which cannot tell two builds of one version apart and cannot name
 * the build that was to land. A receipt holds both identities, so the launch
 * after the install answers one of three ways: the running build is the
 * target (the install landed), it is `from` (it did not), or it is neither
 * (the outcome is unknown and no cache may be cleaned on a guess).
 */
export interface InstallReceipt {
  /** Always 2; a reader refuses any other protocol version. */
  readonly schemaVersion: 2
  /** The build that was running when the install was started. */
  readonly from: ReleaseIdentity
  /** The build the staged artifact installs. */
  readonly target: ReleaseIdentity
  /** The artifact's file name inside the updater's `pending` directory. */
  readonly fileName: string
  /** The manifest's base64 SHA-512 for those bytes. */
  readonly sha512: string
}

/** What the state file holds; every field is absent until something writes it. */
export interface DesktopState {
  /** Version of the build that ran last, as `app.getVersion()` reported it. */
  lastRunVersion?: string
  /**
   * The complete identity of the build that ran last, when that build
   * declares one ([[@deepseek-ai/dsh-desktop-shell/release-identity]]). The
   * version alone cannot tell two builds of one upstream version apart, so
   * this is what tells the launch after an install which build it is.
   */
  lastRunBuild?: ReleaseIdentity
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
   * The install this build handed to the installer, with both build
   * identities. Separate from [[installedUpdate]], whose version-only record
   * cannot be promoted into this one: no launch may read the old field as
   * evidence that an install landed.
   */
  installedUpdateV2?: InstallReceipt
  /**
   * The loopback port the last started server listened on, asked for again
   * by the next launch; see [[@deepseek-ai/dsh-desktop-shell/server-port]].
   * An unexpected server exit keeps it while the shell holds that port, and
   * removes it otherwise ([[@deepseek-ai/dsh-desktop-shell/server-lifecycle]]).
   */
  serverPort?: number
}

/** Absolute path of the state file. */
function stateFile(): string {
  return join(app.getPath('userData'), 'desktop-state.json')
}

/**
 * Read one property of a value from the state file without asserting its
 * object type.
 * @param value - the parsed file, or one value inside it.
 * @param key - the property name.
 * @returns the property's value, or undefined when the value has no such property.
 */
function storedField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined
  return Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined
}

/**
 * Read the install the earlier protocol recorded, field by field.
 * @param value - the value stored under `installedUpdate`.
 * @returns the record, or undefined when a field is missing or mistyped.
 */
function storedInstall(value: unknown): StartedInstall | undefined {
  const fromVersion = storedField(value, 'fromVersion')
  const fileName = storedField(value, 'fileName')
  const sha512 = storedField(value, 'sha512')
  if (typeof fromVersion !== 'string' || typeof fileName !== 'string' || typeof sha512 !== 'string') return undefined
  return { fromVersion, fileName, sha512 }
}

/**
 * Read one build identity the state file recorded.
 * @param value - the value stored under the field.
 * @returns the identity, or undefined when it is missing or any part of it fails validation.
 */
function storedIdentity(value: unknown): ReleaseIdentity | undefined {
  try {
    return parseReleaseIdentity(value)
  } catch {
    // The file is not trusted input: a record this build cannot verify means
    // no identity was remembered, and no caller may treat it as one.
    return undefined
  }
}

/**
 * Read the install receipt the state file recorded.
 * @param value - the value stored under `installedUpdateV2`.
 * @returns the receipt, or undefined when a field is missing, mistyped, or the
 * record is not protocol 2. A record missing any part is not usable as a
 * receipt, because a partial one cannot tell a landed install from another.
 */
function storedReceipt(value: unknown): InstallReceipt | undefined {
  if (storedField(value, 'schemaVersion') !== 2) return undefined
  const from = storedIdentity(storedField(value, 'from'))
  const target = storedIdentity(storedField(value, 'target'))
  if (from === undefined || target === undefined) return undefined
  const fileName = storedField(value, 'fileName')
  const sha512 = storedField(value, 'sha512')
  if (typeof fileName !== 'string' || fileName === '' || typeof sha512 !== 'string' || sha512 === '') return undefined
  return { schemaVersion: 2, from, target, fileName, sha512 }
}

/**
 * Read the state file.
 *
 * Every field is projected one at a time: a value that is missing, mistyped,
 * or not something this build can verify is read as not remembered, and one
 * bad field never hides the others. The file comes from disk and may have
 * been written by an older or a newer build, so nothing in it is trusted as a
 * whole.
 * @returns what it holds, or an empty state when there is no readable file.
 */
export function readState(): DesktopState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), 'utf8'))
    const state: DesktopState = {}
    const lastRunVersion = storedField(parsed, 'lastRunVersion')
    if (typeof lastRunVersion === 'string') state.lastRunVersion = lastRunVersion
    const lastRunBuild = storedIdentity(storedField(parsed, 'lastRunBuild'))
    if (lastRunBuild !== undefined) state.lastRunBuild = lastRunBuild
    const closeAction = storedField(parsed, 'closeAction')
    if (closeAction === 'tray' || closeAction === 'quit') state.closeAction = closeAction
    const installed = storedInstall(storedField(parsed, 'installedUpdate'))
    if (installed !== undefined) state.installedUpdate = installed
    const receipt = storedReceipt(storedField(parsed, 'installedUpdateV2'))
    if (receipt !== undefined) state.installedUpdateV2 = receipt
    const port = storedField(parsed, 'serverPort')
    if (isListenPort(port)) state.serverPort = port
    return state
  } catch {
    // No state yet, or it did not survive. Both mean the same thing to every
    // caller — nothing was remembered — and a launch must never fail over a
    // note the shell keeps for itself.
    return {}
  }
}

/**
 * Where a failed write is reported. The shell's log sink by the time
 * `main.ts` calls [[reportStateWritesTo]]; nowhere before that.
 */
let reportWrite: (line: string) => void = () => {}

/**
 * Report failed state-file writes to `log`.
 * @param log - receives one line per failed write, ending in a newline.
 */
export function reportStateWritesTo(log: (line: string) => void): void {
  reportWrite = log
}

/**
 * How many times a rename refused with a sharing error is tried, and how long
 * apart. On Windows an antivirus scanner or the search indexer can hold the
 * state file open for a moment, and `rename` over it then fails with `EPERM`,
 * `EBUSY` or `EACCES` until they let go.
 */
export const RENAME_ATTEMPTS = 5
/** The pause between rename attempts, in ms; see [[RENAME_ATTEMPTS]]. */
export const RENAME_RETRY_MS = 50

/** Error codes a rename is retried for. */
const SHARING_ERRORS = new Set(['EPERM', 'EBUSY', 'EACCES'])

/**
 * Block the calling thread for `ms`. The state file is written synchronously
 * by every caller, and only a refused rename waits at all.
 * @param ms - how long to wait.
 */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * Rename `from` over `to`, retrying a sharing error up to [[RENAME_ATTEMPTS]] times.
 * @param from - the temporary file.
 * @param to - the state file.
 * @throws the last error when every attempt failed, or the first one that is not a sharing error.
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= RENAME_ATTEMPTS || code === undefined || !SHARING_ERRORS.has(code)) throw error
    }
    pause(RENAME_RETRY_MS)
  }
}

/**
 * Write `content` to `path` and flush it to the disk before returning, so the
 * rename that follows never exposes a file whose data has not been written.
 * @param path - the temporary file.
 * @param content - the whole file.
 */
function writeDurably(path: string, content: string): void {
  const fd = openSync(path, 'w')
  try {
    writeSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/**
 * Replace the file with `state`. The content goes to `desktop-state.json.tmp`,
 * is flushed, and is renamed over the file, so a process that dies mid-write
 * leaves the previous file whole: a truncated file reads as empty, and the
 * next write would then drop every field, `installedUpdate` included. A write
 * that still fails is reported through [[reportStateWritesTo]] and dropped.
 * @param state - the whole state the file is to hold.
 * @returns whether the file now holds `state`; false when any step of the
 * write, the flush, or the rename failed.
 */
function writeState(state: DesktopState): boolean {
  const file = stateFile()
  const temporary = `${file}.tmp`
  try {
    writeDurably(temporary, `${JSON.stringify(state)}\n`)
    renameWithRetry(temporary, file)
    return true
  } catch (error) {
    // Callers retain the previous durable state and decide whether their action may continue.
    reportWrite(`[desktop] could not write ${file}: ${String(error)}\n`)
    removeTemporary(temporary)
    return false
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
 * caller uses that to say what the window is now showing: a Windows update
 * restarts the app by itself, so without a word from the new build the whole
 * operation ends with a window that looks exactly like the one that closed.
 *
 * A version that moved forward is not evidence that an install landed. Two
 * builds of one version are indistinguishable here, and only the
 * [[InstallReceipt]] the install wrote can confirm the build it named.
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
 * Confirm the first launch of the exact build named by the install receipt.
 * Recording a different build or application version alone confirms nothing.
 * The receipt remains available to the pending-cache owner until its cleanup.
 * @param running - complete identity embedded in the running installation.
 * @param state - state read before this launch records itself.
 * @returns the confirmed receipt once per recorded build, otherwise undefined.
 */
export function confirmedInstallOnLaunch(
  running: ReleaseIdentity | undefined,
  state: DesktopState = readState(),
): InstallReceipt | undefined {
  const receipt = state.installedUpdateV2
  if (running === undefined || receipt === undefined || !isSameBuild(running, receipt.target)) return undefined
  if (state.lastRunBuild !== undefined && isSameBuild(state.lastRunBuild, running)) return undefined
  return receipt
}

/**
 * Record the build that is running now and report the build recorded before
 * it. Recording that this build started is not a verdict on the last install:
 * only the [[InstallReceipt]] the install wrote says whether the build it
 * named landed, and a changed identity alone can also mean a downgrade or a
 * build installed by hand.
 * @param build - the identity read from this installation's own package, or
 * undefined for a launch that carries none (a development start, or a package
 * without the embedded identity).
 * @returns the build recorded before this one when it is a different build;
 * undefined on a first run, when the same build runs again, and always when
 * `build` is undefined, because nothing is recorded then.
 */
export function recordBuildRun(build: ReleaseIdentity | undefined): ReleaseIdentity | undefined {
  if (build === undefined) return undefined
  const state = readState()
  const previous = state.lastRunBuild
  writeState({ ...state, lastRunBuild: build })
  return previous !== undefined && !isSameBuild(previous, build) ? previous : undefined
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
 * Remember — or forget — the install this build handed to the installer, with
 * both build identities.
 *
 * The write result is the caller's to act on: an install whose receipt never
 * reached the disk cannot be recognized by the launch after it, so the caller
 * must stop the handoff rather than start an installer whose result nothing
 * records, and keeps the downloaded candidate for a retry.
 * @param receipt - what was handed to the installer, or undefined once the
 * launch after it has dealt with the staged artifact.
 * @returns whether the file now records the receipt; false when the write did
 * not reach the disk.
 */
export function setInstalledUpdateV2(receipt: InstallReceipt | undefined): boolean {
  const state = readState()
  if (receipt === undefined) delete state.installedUpdateV2
  else state.installedUpdateV2 = receipt
  return writeState(state)
}

/**
 * Remember the port the running server listens on, for the next launch.
 * @param port - the port from the server's origin.
 */
export function setServerPort(port: number): void {
  writeState({ ...readState(), serverPort: port })
}

/**
 * Forget the remembered server port, so the next launch lets the system pick
 * one. Called after an unexpected server exit when the shell does not hold the
 * port, and before a held socket is released after a failed handoff in a
 * crash rebind: from then on another process can take the port.
 */
export function forgetServerPort(): void {
  const state = readState()
  delete state.serverPort
  writeState(state)
}
