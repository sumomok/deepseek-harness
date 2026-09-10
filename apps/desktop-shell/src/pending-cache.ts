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

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

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
