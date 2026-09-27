/**
 * electron-updater's download cache, written from outside electron-updater.
 *
 * A transfer the shell completed itself is installed by handing it to the
 * library rather than by driving the installer directly: `downloadUpdate()`
 * validates the cache before it opens a socket and returns the cached path when
 * it matches (`out/AppUpdater.js:604-608`), and the `done(false)` it takes from
 * there emits `update-downloaded` on both platforms with no network I/O. So the
 * whole handoff is a file in the right place with the right name and one small
 * JSON record beside it.
 *
 * What "the right place" means is entirely the library's private layout, read
 * out of the copy in `node_modules` rather than out of documentation:
 *
 * - the cache directory is `<baseCachePath>/<updaterCacheDirName>`, where
 *   `baseCachePath` is `~/Library/Caches` on macOS, `%LOCALAPPDATA%` on Windows
 *   and `$XDG_CACHE_HOME` or `~/.cache` elsewhere (`out/AppAdapter.js:6-20`,
 *   `out/ElectronAppAdapter.js:28-30`), and `updaterCacheDirName` comes from the
 *   `app-update.yml` inside the packaged app (`out/AppUpdater.js:545-550`);
 * - the artifact goes in the `pending` subdirectory
 *   (`out/DownloadedUpdateHelper.js:30-32`) under the name
 *   `getCacheUpdateFileName()` derives from the artifact URL
 *   (`out/AppUpdater.js:573-584`);
 * - `pending/update-info.json` holds exactly `fileName`, `sha512` and
 *   `isAdminRightsRequired` (`out/DownloadedUpdateHelper.js:53-66`,
 *   `:132-134`), and the `sha512` is the manifest's own base64 value, which is
 *   what the cache check compares (`:113-116`, `:123-128`).
 *
 * `pnpm patchedDependencies` pins the library at an exact version, so a bump
 * that moves any of this fails the install before it can reach a build.
 *
 * **The `.part` file of an unfinished transfer never lives in `pending`.** Any
 * failure inside electron-updater's own download empties that directory
 * (`out/AppUpdater.js:609-616`), which is exactly the failure the resumable
 * transfer exists to survive, so partial files are kept in the cache directory
 * root beside the differential baselines the library keeps there.
 *
 * Nothing here touches electron, so `tests/pending-cache.spec.ts` proves the
 * handoff against the library's own `DownloadedUpdateHelper`.
 * @module @deepseek-ai/dsh-desktop-shell/pending-cache
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { compareVersions } from './version-order.ts'

/** The subdirectory electron-updater takes a staged update from. */
const PENDING = 'pending'

/** The record electron-updater reads before it trusts a cached artifact. */
const UPDATE_INFO = 'update-info.json'

/** Prefix of every partial file this shell keeps, which is what makes a stale one identifiable. */
const PART_PREFIX = 'dsh-resume-'

/** What one staged artifact is recorded as, field for field as electron-updater writes it. */
interface DownloadedUpdateInfo {
  /** The artifact's file name inside `pending`. */
  fileName: string
  /** The manifest's base64 sha512 for that artifact. */
  sha512: string
  /** Whether the installer must be started elevated. */
  isAdminRightsRequired: boolean
}

/** Where one artifact is staged and what proves it is the right one. */
export interface PendingPlacement {
  /** The updater cache directory, whose `pending` subdirectory receives the artifact. */
  cacheDir: string
  /** The completed artifact to move in; it must already sit under [[cacheDir]]. */
  sourceFile: string
  /** The name electron-updater will look the artifact up by. */
  fileName: string
  /** The manifest's base64 sha512 for the artifact. */
  sha512: string
  /** Whether the manifest marks the artifact as needing an elevated installer. */
  isAdminRightsRequired: boolean
}

/**
 * The directory electron-updater puts its per-application cache under.
 * @param platform - the platform to answer for; this process's unless a test names another.
 * @param env - the environment to read; this process's unless a test names another.
 * @returns the base cache directory.
 */
export function appCacheDir(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform === 'win32') return env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  if (platform === 'darwin') return join(homedir(), 'Library', 'Caches')
  return env.XDG_CACHE_HOME ?? join(homedir(), '.cache')
}

/**
 * The `pending` subdirectory of one updater cache directory.
 * @param cacheDir - the updater cache directory.
 * @returns the directory a staged artifact is read from.
 */
export function pendingDir(cacheDir: string): string {
  return join(cacheDir, PENDING)
}

/**
 * Where the partial file of one artifact's transfer is kept.
 *
 * The name carries the version as well as the artifact name, so a feed that
 * moved on while a transfer was interrupted produces a different name and the
 * bytes of the version nobody will install are identifiable as stale.
 * @param cacheDir - the updater cache directory.
 * @param version - the version being transferred.
 * @param fileName - the artifact's name in the feed.
 * @returns the `.part` file path.
 */
export function partFileFor(cacheDir: string, version: string, fileName: string): string {
  return join(cacheDir, `${PART_PREFIX}${version}-${basename(fileName)}.part`)
}

/**
 * Delete every partial file in the cache directory except the one still being
 * transferred, along with whatever was recorded beside it.
 * @param cacheDir - the updater cache directory.
 * @param keep - the `.part` file the current transfer uses.
 */
export function discardStaleParts(cacheDir: string, keep: string): void {
  if (!existsSync(cacheDir)) return
  const kept = basename(keep)
  for (const entry of readdirSync(cacheDir)) {
    if (!entry.startsWith(PART_PREFIX) || entry === kept || entry.startsWith(kept)) continue
    rmSync(join(cacheDir, entry), { force: true, recursive: true })
  }
}

/**
 * Put one completed artifact where electron-updater will find it and record
 * what it is.
 *
 * The artifact is moved before the record is written, so a run interrupted
 * between the two leaves a record naming a file that is not there — which the
 * library reports and ignores (`out/DownloadedUpdateHelper.js:118-121`) — never
 * a record vouching for a file that is only half written. The move is a rename
 * within one directory tree, so no reader ever sees a partial artifact under
 * the final name.
 * @param placement - the cache directory, the finished file, and what it is.
 * @returns the path the artifact now occupies.
 */
export function placeInPendingCache(placement: PendingPlacement): string {
  const directory = pendingDir(placement.cacheDir)
  mkdirSync(directory, { recursive: true })
  const staged = join(directory, basename(placement.fileName))
  renameSync(placement.sourceFile, staged)
  const record: DownloadedUpdateInfo = {
    fileName: basename(placement.fileName),
    sha512: placement.sha512,
    isAdminRightsRequired: placement.isAdminRightsRequired,
  }
  writeFileSync(join(directory, UPDATE_INFO), JSON.stringify(record))
  return staged
}

/** Which staged artifact one `pending/update-info.json` vouches for. */
export interface StagedArtifact {
  /** The artifact's file name inside `pending`. */
  fileName: string
  /** The manifest's base64 sha512 for that artifact. */
  sha512: string
}

/**
 * Read which artifact `pending` holds, from the record beside it.
 * @param cacheDir - the updater cache directory.
 * @returns the record's file name and sha512, or undefined when there is no
 * record, it cannot be read, or it lacks either field.
 */
export function readStagedArtifact(cacheDir: string): StagedArtifact | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(pendingDir(cacheDir), UPDATE_INFO), 'utf8'))
  } catch {
    // No record, or one electron-updater itself would refuse
    // (`out/DownloadedUpdateHelper.js:94-103`): either way `pending` vouches
    // for nothing this shell could match an install against.
    return undefined
  }
  const { fileName, sha512 } = (parsed ?? {}) as { fileName?: unknown; sha512?: unknown }
  if (typeof fileName !== 'string' || typeof sha512 !== 'string') return undefined
  return { fileName, sha512 }
}

/** One install a build started, as the launch after it recognizes it. */
export interface StartedInstall extends StagedArtifact {
  /** The version that was running when the install was started. */
  fromVersion: string
}

/** What one sweep of `pending` after an install did. */
export type InstalledPendingSweep =
  /** The running build is not newer than the one that started the install, so it did not land and the artifact is still to be installed. */
  | { kind: 'not-landed' }
  /** `pending` holds no record: nothing is staged, or the library already emptied it. */
  | { kind: 'absent' }
  /** `pending` now vouches for a different artifact, which is a later download to keep. */
  | { kind: 'replaced' }
  /** Every entry of `pending` was removed. */
  | { kind: 'emptied'; removed: string[] }
  /** Some entries could not be removed; the rest were. */
  | { kind: 'incomplete'; removed: string[]; failed: string[] }

/**
 * Empty `pending` once the artifact it holds is the one that was installed.
 *
 * electron-updater empties `pending` only when a download fails or the cached
 * record stops matching the feed (`out/DownloadedUpdateHelper.js:67-82`,
 * `:112-116`), never after an install succeeds, so without this the installed
 * artifact — the whole zip on macOS, the whole NSIS installer on Windows —
 * stays until the next update's download starts. Only `pending` is touched:
 * the differential baselines (`update.zip`, `installer.exe`, `package.7z`,
 * `current.blockmap`) live in the cache directory root, and the next update
 * downloads only the blocks that differ from them.
 *
 * The record decides: `pending` is emptied only while its record still names
 * `installed` by file name and sha512. Anything else there is a download made
 * after that install and is still worth handing to the library. Each entry is
 * removed on its own, so one the Windows installer still holds open is
 * reported without stopping the rest.
 *
 * Nothing is swept unless the running build is newer than the one that
 * started the install: the same version running again means the install did
 * not land, and the staged artifact is still the update it has yet to take.
 * @param cacheDir - the updater cache directory.
 * @param installed - what `pending` held when the install was started, and the version that started it.
 * @param runningVersion - the version of the build now running.
 * @returns what the sweep found and did.
 * @throws when `pending` holds a record but cannot be listed.
 */
export function sweepInstalledPending(cacheDir: string, installed: StartedInstall, runningVersion: string): InstalledPendingSweep {
  if (compareVersions(runningVersion, installed.fromVersion) <= 0) return { kind: 'not-landed' }
  const staged = readStagedArtifact(cacheDir)
  if (staged === undefined) return { kind: 'absent' }
  if (staged.fileName !== installed.fileName || staged.sha512 !== installed.sha512) return { kind: 'replaced' }
  const directory = pendingDir(cacheDir)
  const removed: string[] = []
  const failed: string[] = []
  // Name order, with the record last: a sweep that stops part-way still
  // leaves `pending` vouching for what it was, and the next launch sweeps again.
  const entries = readdirSync(directory).sort().sort((left, right) => Number(left === UPDATE_INFO) - Number(right === UPDATE_INFO))
  for (const entry of entries) {
    if (entry === UPDATE_INFO && failed.length > 0) {
      failed.push(entry)
      continue
    }
    try {
      rmSync(join(directory, entry), { force: true, recursive: true })
    } catch {
      // EBUSY/EPERM: on Windows the installer that relaunched this app can
      // still hold its own file open for a moment. The entry is named in the
      // result, and the record it keeps makes the next launch try again.
      failed.push(entry)
      continue
    }
    removed.push(entry)
  }
  return failed.length === 0 ? { kind: 'emptied', removed } : { kind: 'incomplete', removed, failed }
}
