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

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { InstallReceipt } from './desktop-state.ts'
import { ensurePathContainment, validateFeedFileName } from './feed-validation.ts'
import { isSameBuild, releaseKey, type ReleaseIdentity } from './release-identity.ts'

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
 * The name carries a digest of the complete build identity as well as the
 * artifact name. The version alone cannot key this file: two builds publish
 * under one version whenever a fix ships as the next build of the same
 * upstream version, and a bridge build carries a higher application version
 * than the build that follows it, so a version-keyed name would have one
 * transfer resume into another build's bytes, or discard a partial file that
 * belongs to the frozen candidate the operation still holds. The identity is
 * hashed to a fixed-length key so no value from the feed reaches the path
 * verbatim.
 * @param cacheDir - the updater cache directory.
 * @param identity - the build being transferred.
 * @param fileName - the artifact's name in the feed.
 * @returns the `.part` file path.
 * @throws when the file name is invalid or the path would escape the cache
 * directory.
 */
export function partFileFor(cacheDir: string, identity: ReleaseIdentity, fileName: string): string {
  const validatedFileName = validateFeedFileName(fileName)
  const identityKey = identityToCacheKey(identity)
  const safeName = basename(validatedFileName)
  const partFile = join(cacheDir, `${PART_PREFIX}${identityKey.substring(0, 16)}-${safeName}.part`)
  ensurePathContainment(cacheDir, partFile)
  return partFile
}

/**
 * Hash one build identity to the fixed-length key its cache files use.
 * @param identity - the build to key.
 * @returns the hex SHA-256 of the canonical identity key.
 */
function identityToCacheKey(identity: ReleaseIdentity): string {
  return createHash('sha256').update(releaseKey(identity), 'utf8').digest('hex')
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
 * @throws when the file name is invalid or paths would escape the cache directory.
 */
export function placeInPendingCache(placement: PendingPlacement): string {
  const validatedFileName = validateFeedFileName(placement.fileName)
  const directory = pendingDir(placement.cacheDir)
  mkdirSync(directory, { recursive: true })
  const safeName = basename(validatedFileName)
  const staged = join(directory, safeName)
  ensurePathContainment(placement.cacheDir, staged)
  ensurePathContainment(placement.cacheDir, placement.sourceFile)
  renameSync(placement.sourceFile, staged)
  const record: DownloadedUpdateInfo = {
    fileName: safeName,
    sha512: placement.sha512,
    isAdminRightsRequired: placement.isAdminRightsRequired,
  }
  const infoPath = join(directory, UPDATE_INFO)
  ensurePathContainment(placement.cacheDir, infoPath)
  writeFileSync(infoPath, JSON.stringify(record))
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

/**
 * What one sweep of `pending` after an install did.
 *
 * The first two entries are about the running build rather than the cache:
 * only a running build equal to the receipt's `target` may sweep anything, and
 * a build equal to neither identity says nothing about the install at all.
 *
 * A union rather than one interface because the `removed` and `failed` lists
 * exist only for the two outcomes that removed something: the caller switches
 * on the discriminant with no case left unchecked.
 */
export type InstalledBuildSweep =
  /**
   * The running build is the receipt's `from`: the install did not land and
   * the artifact is still the update it has yet to take.
   */
  | { kind: 'not-landed' }
  /**
   * The running build is neither `from` nor `target`: the outcome of that
   * install is unknown, so nothing was removed and no success is claimed.
   */
  | { kind: 'unconfirmed' }
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
 * The running build decides first, by identity and never by version order:
 * comparing versions would treat a higher version as a landed install even
 * when it is a build the user installed another way, and would treat a bridge
 * build that lowered the application version as no install at all. A build
 * equal to the receipt's `target` is the build the artifact installs; a build
 * equal to `from` means the install did not land, and the artifact is still
 * the update it has yet to take; a build equal to neither leaves the outcome
 * unknown, and an unknown result is never cleaned up as if it had succeeded.
 *
 * The record decides second: `pending` is emptied only while its record still
 * names the receipt's artifact by file name and sha512. Anything else there is
 * a download made after that install and is still worth handing to the
 * library. Each entry is removed on its own, so one the Windows installer
 * still holds open is reported without stopping the rest, and the record goes
 * last so a partial sweep leaves `pending` vouching for what it held and the
 * next launch tries again.
 * @param cacheDir - the updater cache directory.
 * @param receipt - what the install wrote: both build identities and the artifact it takes.
 * @param running - the identity of the build running now.
 * @returns what the sweep found and did.
 * @throws when `pending` holds a record but cannot be listed.
 */
export function sweepInstalledBuildPending(cacheDir: string, receipt: InstallReceipt, running: ReleaseIdentity): InstalledBuildSweep {
  if (!isSameBuild(running, receipt.target)) {
    return isSameBuild(running, receipt.from) ? { kind: 'not-landed' } : { kind: 'unconfirmed' }
  }
  const staged = readStagedArtifact(cacheDir)
  if (staged === undefined) return { kind: 'absent' }
  if (staged.fileName !== receipt.fileName || staged.sha512 !== receipt.sha512) return { kind: 'replaced' }
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
