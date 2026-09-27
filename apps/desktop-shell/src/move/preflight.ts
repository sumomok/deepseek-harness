/**
 * Checks run before the Harness home moves, while the server still runs and
 * nothing has changed: where the data may go, whether it fits, and whether the
 * target file system can hold it.
 *
 * Gathering and deciding are separate. {@link gatherPreflightFacts} reads the
 * disks through {@link PreflightProbes}, which tests replace;
 * {@link evaluatePreflight} is a pure function of the facts and returns every
 * reason the move is refused, so the Settings page can list them all at once.
 * The rules are the design doc's 3.4.
 *
 * The disk probes (device, free space, file-system type, capabilities) run in
 * the target's parent: the partial copy is made there and renamed to the
 * target, and a pre-existing empty target is replaced there by `rmdir` and
 * `rename`. {@link resolveMoveTarget} never picks a volume root as the target
 * itself, so the parent is on the target's volume.
 * @module @deepseek-ai/dsh-desktop-shell/move/preflight
 */

import { execFile } from 'node:child_process'
import {
  closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync,
  rmdirSync, statfsSync, statSync, symlinkSync, unlinkSync, writeSync,
} from 'node:fs'
import { dirname, join, posix, win32 } from 'node:path'
import { promisify } from 'node:util'
import { DATA_ID_FILENAME, hasHarnessStructure } from '../data-location.ts'
import type { PowerShellRunner } from '../terminal-env.ts'
import { isInsidePath, meaningfulNames, REBUILDABLE_ENTRIES, scanTree, type TreeScan } from './tree.ts'

/** Name of the folder a move creates inside the folder the person picked (design doc Q13). */
export const DATA_DIR_NAME = 'DSH-Data'
/** Space needed on another volume: the data times this ratio, plus {@link SPACE_RESERVE_BYTES} (design doc 3.4). */
export const SPACE_MARGIN_RATIO = 1.1
/** Space left free on the target volume after the copy (design doc 3.4). */
export const SPACE_RESERVE_BYTES = 500 * 1024 * 1024
/**
 * Characters a Windows path may reach, target root plus the longest relative
 * path, before the move warns: Node handles longer paths, pnpm and the Office
 * engine may not (design doc 3.4).
 */
export const WINDOWS_PATH_BUDGET = 250
/**
 * File systems that cannot hold the data, by the names `mount` (macOS) and
 * `DriveInfo.DriveFormat` (Windows) report: no hard links or reliable locks
 * (FAT, exFAT, network shares), or read-only (NTFS on macOS, optical media).
 */
export const REFUSED_FILE_SYSTEMS: Readonly<Partial<Record<NodeJS.Platform, readonly string[]>>> = {
  darwin: ['exfat', 'msdos', 'smbfs', 'nfs', 'webdav', 'afpfs', 'ntfs', 'cd9660', 'udf'],
  win32: ['fat', 'fat32', 'exfat', 'cdfs', 'udf'],
}

/** What is at the path the data would move to. */
export type TargetState = 'absent' | 'empty' | 'not-empty' | 'harness-data' | 'not-a-folder'

/** Where the data goes for a folder the person picked. */
export interface MoveTarget {
  /** The directory that will hold the data. */
  target: string
  /** Its parent, where the partial copy is made. */
  parent: string
  /** Whether `target` is an empty folder that exists already (it is replaced by the copy). */
  preexisting: boolean
}

/**
 * Inspect a path the data might move to, without following a link there.
 * @param path - the absolute path.
 * @returns what is there.
 */
export function inspectTarget(path: string): TargetState {
  let stats
  try {
    stats = lstatSync(path)
  } catch (error) {
    // ENOENT is the ordinary case of a folder the move creates; anything else
    // (EACCES, ENOTDIR) is a path the move cannot use either.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : 'not-a-folder'
  }
  if (!stats.isDirectory()) return 'not-a-folder'
  if (existsSync(join(path, DATA_ID_FILENAME)) || hasHarnessStructure(path)) return 'harness-data'
  return meaningfulNames(readdirSync(path)).length === 0 ? 'empty' : 'not-empty'
}

/**
 * The move target for a folder the person picked: the folder itself when it
 * is empty (files the file browser leaves, {@link IGNORABLE_NAMES}, do not
 * count), otherwise a {@link DATA_DIR_NAME} folder inside it (plan D6).
 *
 * A folder that is the root of a volume — a drive (`D:\`), or a disk mounted
 * at `/Volumes/USB` — is never the target itself, even when empty: the copy is
 * made beside the target and renamed into place, which cannot cross into or
 * replace a mount point, so the data goes into a folder inside it.
 * @param chosen - the absolute folder the person picked.
 * @param inspect - reads a path's state; {@link inspectTarget} in the app.
 * @param isVolumeRoot - whether a folder is the root of a volume; {@link isVolumeRootOnDisk} in the app.
 * @returns the target, its parent, and whether it exists already.
 */
export function resolveMoveTarget(
  chosen: string,
  inspect: (path: string) => TargetState = inspectTarget,
  isVolumeRoot: (path: string) => boolean | undefined = isVolumeRootOnDisk,
): MoveTarget {
  // A folder whose volume cannot be told is treated as a volume root; preflight refuses it anyway.
  if (inspect(chosen) === 'empty' && isVolumeRoot(chosen) === false) return { target: chosen, parent: dirname(chosen), preexisting: true }
  const target = join(chosen, DATA_DIR_NAME)
  return { target, parent: chosen, preexisting: inspect(target) === 'empty' }
}

/**
 * Whether a folder is the root of a volume: it has no parent, or its parent
 * lies on another device.
 * @param path - an existing absolute folder.
 * @returns true for a drive root or a mount point, false for an ordinary folder, `undefined` when it or its parent cannot be read.
 */
export function isVolumeRootOnDisk(path: string): boolean | undefined {
  if (dirname(path) === path) return true
  try {
    return statSync(path).dev !== statSync(dirname(path)).dev
  } catch {
    // ENOENT, EACCES, EPERM: the devices cannot be compared, so it cannot be told.
    return undefined
  }
}

/** A file system as the operating system names it. */
export interface FileSystemInfo {
  /** Lower-case type name: `apfs`, `exfat`, `ntfs`, `smbfs`, … */
  type: string
  /** Whether it is reached over a network. */
  network: boolean
}

/** A capability the target file system lacks, and the error that showed it. */
export type CapabilityFailure = {
  capability: 'write' | 'hard-link' | 'symbolic-link' | 'rename' | 'delete'
  code: string
  detail: string
}

/** What the capability probe found. */
export type CapabilityReport =
  | { ok: true; caseSensitive: boolean }
  | { ok: false; failure: CapabilityFailure }

/** Places the data may not go into. */
export interface ForbiddenPlaces {
  /** The installed application (and on macOS the `.app` bundle). */
  install: readonly string[]
  /** Electron's user-data directory, where the pointer and the move journal live. */
  userData: string
  /** The update download cache. */
  updateCache: string
  /** Every workspace folder; the agent may write anywhere inside one. */
  workspaces: readonly string[]
  /** Folders a sync client uploads (iCloud, OneDrive, …). */
  cloud: readonly string[]
}

/** Everything {@link evaluatePreflight} decides on. */
export interface PreflightFacts {
  platform: NodeJS.Platform
  /** The real path of the data directory. */
  source: string
  target: MoveTarget
  targetState: TargetState
  /**
   * Whether it could not be told if the picked folder is the root of a volume
   * (it or its parent could not be read), so where the copy would live is unknown.
   */
  chosenUnreadable: boolean
  /** Whether the target's parent is a directory. When false, the probes below were not run. */
  parentExists: boolean
  /** The target with its parent's real path, for comparisons with other real paths. */
  realTarget: string
  /** Whether the source and the target's parent are on one volume, so the move is a rename. */
  sameVolume: boolean
  /** Free bytes on the target's volume. */
  freeBytes: number
  fileSystem: FileSystemInfo | undefined
  capabilities: CapabilityReport
  scan: Pick<TreeScan, 'bytes' | 'allocatedBytes' | 'caseCollisions' | 'normalizationCollisions' | 'longestRelative'>
  /** Forbidden places, each resolved to its real path where it exists. */
  forbidden: ForbiddenPlaces
}

/** One reason a move is refused. */
export type PreflightRefusal =
  | { kind: 'parent-missing' }
  | { kind: 'folder-unreadable' }
  | { kind: 'inside-source' }
  | { kind: 'contains-source' }
  | { kind: 'inside-install' }
  | { kind: 'inside-user-data' }
  | { kind: 'inside-update-cache' }
  | { kind: 'inside-workspace'; workspace: string }
  | { kind: 'cloud-synced'; root: string }
  | { kind: 'not-empty' }
  | { kind: 'harness-data' }
  | { kind: 'not-a-folder' }
  | { kind: 'unsupported-file-system'; type: string }
  | { kind: 'network-location' }
  | { kind: 'no-permission'; detail: string }
  | { kind: 'capability-missing'; failure: CapabilityFailure }
  | { kind: 'not-enough-space'; needed: number; free: number }
  | { kind: 'case-collision'; paths: string[][] }
  | { kind: 'normalization-collision'; paths: string[][] }

/** Something the person is told that does not stop the move. */
export type PreflightWarning = { kind: 'long-paths'; length: number; budget: number }

/** The verdict. */
export interface PreflightResult {
  ok: boolean
  target: MoveTarget
  sameVolume: boolean
  /** Bytes the copy writes; zero for a rename on one volume. */
  copyBytes: number
  /** Bytes the target volume must have free. */
  neededBytes: number
  refusals: PreflightRefusal[]
  warnings: PreflightWarning[]
}

/**
 * Bytes a copy to another volume needs free.
 * @param bytes - the space the data takes, rounded up to whole blocks ({@link TreeScan.allocatedBytes}).
 * @returns the data with its margin and the reserve.
 */
export function requiredSpace(bytes: number): number {
  return Math.ceil(bytes * SPACE_MARGIN_RATIO) + SPACE_RESERVE_BYTES
}

/**
 * Decide whether the move may start.
 * @param facts - what the probes found.
 * @returns every refusal and warning; `ok` when there is no refusal.
 */
export function evaluatePreflight(facts: PreflightFacts): PreflightResult {
  const { platform, forbidden } = facts
  const refusals: PreflightRefusal[] = []
  const warnings: PreflightWarning[] = []
  const copyBytes = facts.sameVolume ? 0 : facts.scan.bytes
  const neededBytes = facts.sameVolume ? 0 : requiredSpace(facts.scan.allocatedBytes)
  const result = (): PreflightResult => ({
    ok: refusals.length === 0, target: facts.target, sameVolume: facts.sameVolume, copyBytes, neededBytes, refusals, warnings,
  })
  const inside = (root: string): boolean => isInsidePath(facts.realTarget, root, platform)
  if (inside(facts.source)) refusals.push({ kind: 'inside-source' })
  else if (isInsidePath(facts.source, facts.realTarget, platform)) refusals.push({ kind: 'contains-source' })
  if (forbidden.install.some(inside)) refusals.push({ kind: 'inside-install' })
  if (inside(forbidden.userData)) refusals.push({ kind: 'inside-user-data' })
  if (inside(forbidden.updateCache)) refusals.push({ kind: 'inside-update-cache' })
  const workspace = forbidden.workspaces.find(inside)
  if (workspace !== undefined) refusals.push({ kind: 'inside-workspace', workspace })
  const cloud = forbidden.cloud.find(inside)
  if (cloud !== undefined) refusals.push({ kind: 'cloud-synced', root: cloud })
  switch (facts.targetState) {
    case 'absent':
    case 'empty':
      break
    case 'not-empty':
      refusals.push({ kind: 'not-empty' })
      break
    case 'harness-data':
      refusals.push({ kind: 'harness-data' })
      break
    case 'not-a-folder':
      refusals.push({ kind: 'not-a-folder' })
      break
    default:
      facts.targetState satisfies never
  }
  if (facts.chosenUnreadable) refusals.push({ kind: 'folder-unreadable' })
  if (!facts.parentExists) {
    refusals.push({ kind: 'parent-missing' })
    return result()
  }
  if (platform === 'win32' && win32.toNamespacedPath(facts.realTarget).startsWith('\\\\?\\UNC\\')) {
    refusals.push({ kind: 'network-location' })
  } else if (facts.fileSystem !== undefined) {
    if (facts.fileSystem.network) refusals.push({ kind: 'network-location' })
    else if ((REFUSED_FILE_SYSTEMS[platform] ?? []).includes(facts.fileSystem.type)) {
      refusals.push({ kind: 'unsupported-file-system', type: facts.fileSystem.type })
    }
  }
  const capabilities = facts.capabilities
  if (!capabilities.ok) {
    const { failure } = capabilities
    const denied = failure.capability === 'write' && (failure.code === 'EPERM' || failure.code === 'EACCES')
    if (denied) refusals.push({ kind: 'no-permission', detail: failure.detail })
    else refusals.push({ kind: 'capability-missing', failure })
  }
  if (!facts.sameVolume) {
    if (neededBytes > facts.freeBytes) refusals.push({ kind: 'not-enough-space', needed: neededBytes, free: facts.freeBytes })
    const caseSensitive = capabilities.ok && capabilities.caseSensitive
    if (!caseSensitive && facts.scan.caseCollisions.length > 0) refusals.push({ kind: 'case-collision', paths: facts.scan.caseCollisions })
    if (facts.scan.normalizationCollisions.length > 0) {
      refusals.push({ kind: 'normalization-collision', paths: facts.scan.normalizationCollisions })
    }
  }
  if (platform === 'win32') {
    const length = facts.target.target.length + 1 + facts.scan.longestRelative
    if (length > WINDOWS_PATH_BUDGET) warnings.push({ kind: 'long-paths', length, budget: WINDOWS_PATH_BUDGET })
  }
  return result()
}

/**
 * Folders sync clients upload. On macOS: iCloud Drive and the File Provider
 * root every other client (OneDrive, Dropbox, Google Drive) mounts under, plus
 * Desktop and Documents while iCloud syncs them. On Windows: the OneDrive
 * roots the client exports. Other sync clients that keep their folder
 * elsewhere (a Dropbox folder in the home directory, Google Drive for desktop
 * on Windows, Nextcloud, Seafile) are not recognized.
 * @param input - the platform, the home directory, the environment, and whether iCloud syncs Desktop and Documents.
 * @returns absolute folder paths.
 */
export function cloudRoots(input: {
  platform: NodeJS.Platform
  home: string
  env: NodeJS.ProcessEnv
  iCloudDesktopAndDocuments: boolean
}): string[] {
  const { platform, home, env } = input
  if (platform === 'darwin') {
    const roots = [join(home, 'Library', 'Mobile Documents'), join(home, 'Library', 'CloudStorage')]
    if (input.iCloudDesktopAndDocuments) roots.push(join(home, 'Desktop'), join(home, 'Documents'))
    return roots
  }
  if (platform === 'win32') {
    return ['OneDrive', 'OneDriveCommercial', 'OneDriveConsumer']
      .map(name => env[name])
      .filter((value): value is string => value !== undefined && value.trim().length > 0)
  }
  return []
}

/**
 * Whether iCloud syncs Desktop and Documents: while it does, iCloud Drive
 * holds a `Desktop` or `Documents` folder at its top level.
 * @param home - the home directory.
 * @param exists - tests a path; `existsSync` in the app.
 * @returns true when either folder is there.
 */
export function iCloudSyncsDesktopAndDocuments(home: string, exists: (path: string) => boolean = existsSync): boolean {
  const drive = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')
  return exists(join(drive, 'Desktop')) || exists(join(drive, 'Documents'))
}

/** One mount from the macOS `mount` listing. */
export interface MountEntry {
  mountPoint: string
  type: string
  local: boolean
}

/**
 * Parse the macOS `mount` listing: `/dev/disk3s1 on / (apfs, local, journaled)`.
 * @param output - what `/sbin/mount` printed.
 * @returns one entry per line that parses.
 */
export function parseDarwinMounts(output: string): MountEntry[] {
  const entries: MountEntry[] = []
  for (const line of output.split('\n')) {
    const match = / on (.+) \(([^,)]+)((?:, [^,)]+)*)\)$/.exec(line.trim())
    if (match === null) continue
    const options = (match[3] ?? '').split(',').map(option => option.trim())
    entries.push({ mountPoint: match[1] ?? '', type: (match[2] ?? '').toLowerCase(), local: options.includes('local') })
  }
  return entries
}

/**
 * The mount holding `path`: the one whose mount point is its longest prefix.
 * @param mounts - the parsed listing.
 * @param path - a real absolute path.
 * @returns the file system, or `undefined` when no mount covers the path.
 */
export function fileSystemOf(mounts: readonly MountEntry[], path: string): FileSystemInfo | undefined {
  let best: MountEntry | undefined
  for (const mount of mounts) {
    if (!isInsidePath(path, mount.mountPoint, 'darwin')) continue
    if (best === undefined || mount.mountPoint.length > best.mountPoint.length) best = mount
  }
  return best === undefined ? undefined : { type: best.type, network: !best.local }
}

/** Environment variable carrying the drive letter to the Windows file-system probe. */
export const PROBE_DRIVE_ENV = 'DSH_DATA_MOVE_DRIVE'

/** PowerShell that reports a drive's format and type as one JSON object. */
export const WINDOWS_DRIVE_SCRIPT = [
  `$d = [System.IO.DriveInfo]::new($env:${PROBE_DRIVE_ENV})`,
  '@{ format = [string]$d.DriveFormat; type = [string]$d.DriveType } | ConvertTo-Json -Compress',
].join('; ')

/**
 * Read a Windows drive's file system.
 * @param run - runs PowerShell.
 * @param path - an absolute drive-letter path.
 * @returns the file system, or `undefined` when it cannot be read.
 */
export async function windowsFileSystem(run: PowerShellRunner, path: string): Promise<FileSystemInfo | undefined> {
  const drive = /^[A-Za-z]:/.exec(path)?.[0]
  if (drive === undefined) return undefined
  const result = await run(WINDOWS_DRIVE_SCRIPT, { [PROBE_DRIVE_ENV]: drive })
  if (result.code !== 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    // Not JSON: the probe printed something else, and the type stays unknown;
    // the capability probe still runs.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const { format, type } = parsed as Record<string, unknown>
  if (typeof format !== 'string' || typeof type !== 'string') return undefined
  return { type: format.toLowerCase(), network: type === 'Network' }
}

/**
 * Try, in a temporary folder inside `dir`, every file-system operation the
 * data needs: create and flush a file, hard-link it (the session store's first
 * write), make a directory link (a junction on Windows), rename, and delete.
 * The folder is removed again whatever happens.
 * @param dir - the folder the target is created in.
 * @param platform - which kind of directory link to make.
 * @returns the first operation that failed, or whether the volume tells names apart by case.
 */
export function probeCapabilities(dir: string, platform: NodeJS.Platform): CapabilityReport {
  let probe: string
  try {
    probe = mkdtempSync(join(dir, '.dsh-probe-'))
  } catch (error) {
    return failed('write', error)
  }
  const file = join(probe, 'Case')
  const hard = join(probe, 'hard')
  const renamed = join(probe, 'renamed')
  const sub = join(probe, 'sub')
  const link = join(probe, 'link')
  const steps: Array<[CapabilityFailure['capability'], () => void]> = [
    ['write', () => {
      const fd = openSync(file, 'wx', 0o600)
      try {
        writeSync(fd, 'probe')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    }],
    ['hard-link', () => { linkSync(file, hard) }],
    ['symbolic-link', () => {
      mkdirSync(sub)
      symlinkSync(sub, link, platform === 'win32' ? 'junction' : 'dir')
    }],
    ['rename', () => { renameSync(hard, renamed) }],
    ['delete', () => { removeProbe(probe, [link, file, hard, renamed], [sub]) }],
  ]
  let caseSensitive = true
  for (const [capability, step] of steps) {
    try {
      step()
    } catch (error) {
      try {
        removeProbe(probe, [link, file, hard, renamed], [sub])
      } catch {
        // What cannot be removed after a failed step stays as a `.dsh-probe-*`
        // folder; the failure reported below already explains why.
      }
      return failed(capability, error)
    }
    if (capability === 'write') caseSensitive = !existsSync(join(probe, 'cASE'))
  }
  return { ok: true, caseSensitive }
}

/**
 * Remove the probe folder: its links and files one by one with `unlink`, then
 * its directories, so nothing is ever followed through the directory link.
 * @param probe - the probe folder.
 * @param entries - the links and files it may hold.
 * @param dirs - the directories it may hold.
 * @throws when an entry that exists cannot be removed.
 */
function removeProbe(probe: string, entries: readonly string[], dirs: readonly string[]): void {
  for (const path of entries) {
    try {
      lstatSync(path)
    } catch {
      // ENOENT: the step that makes this entry never ran, or it was renamed.
      continue
    }
    unlinkSync(path)
  }
  for (const path of [...dirs, probe]) {
    if (existsSync(path)) rmdirSync(path)
  }
}

/**
 * A capability failure from a thrown error.
 * @param capability - the step that failed.
 * @param error - what it threw.
 * @returns the failure.
 */
function failed(capability: CapabilityFailure['capability'], error: unknown): CapabilityReport {
  const code = (error as NodeJS.ErrnoException).code ?? 'UNKNOWN'
  return { ok: false, failure: { capability, code, detail: String(error) } }
}

/** The disk reads {@link gatherPreflightFacts} makes; tests replace them. */
export interface PreflightProbes {
  realpath: (path: string) => string
  /** Device number of a path, following links. */
  device: (path: string) => number
  freeBytes: (dir: string) => number
  fileSystem: (dir: string) => Promise<FileSystemInfo | undefined>
  capabilities: (dir: string) => CapabilityReport
  inspect: (path: string) => TargetState
  isVolumeRoot: (path: string) => boolean | undefined
  scan: (source: string) => Promise<TreeScan>
}

/**
 * The real disk reads on `platform`.
 * @param platform - the running platform.
 * @param powerShell - runs PowerShell on Windows.
 * @returns the probes.
 */
export function nodePreflightProbes(platform: NodeJS.Platform, powerShell?: PowerShellRunner): PreflightProbes {
  return {
    // The native call returns the letter case stored on disk, so a path typed
    // in another case compares equal to the real one.
    realpath: path => realpathSync.native(path),
    device: path => statSync(path).dev,
    freeBytes: (dir) => {
      const stats = statfsSync(dir)
      return stats.bavail * stats.bsize
    },
    fileSystem: async (dir) => {
      if (platform === 'darwin') return fileSystemOf(parseDarwinMounts(await execText('/sbin/mount', [])), dir)
      if (platform === 'win32' && powerShell !== undefined) return windowsFileSystem(powerShell, dir)
      return undefined
    },
    capabilities: dir => probeCapabilities(dir, platform),
    inspect: inspectTarget,
    isVolumeRoot: isVolumeRootOnDisk,
    scan: source => scanTree(source, { exclude: REBUILDABLE_ENTRIES }),
  }
}

/**
 * Run a program and collect its standard output.
 * @param file - the program.
 * @param args - its arguments.
 * @returns what it printed.
 */
async function execText(file: string, args: readonly string[]): Promise<string> {
  const { stdout } = await promisify(execFile)(file, [...args], { encoding: 'utf8', timeout: 10_000 })
  return stdout
}

/** What {@link gatherPreflightFacts} is asked about. */
export interface PreflightRequest {
  platform: NodeJS.Platform
  /** The data directory as the shell resolved it; may be a path through a link. */
  source: string
  /** The folder the person picked. */
  chosen: string
  forbidden: ForbiddenPlaces
}

/**
 * The real path of `path`, or of its nearest existing ancestor with the rest
 * appended, so paths that do not exist yet compare with real ones.
 * @param path - an absolute path.
 * @param realpath - resolves an existing path.
 * @param platform - whose path rules apply.
 * @returns the path with every existing link resolved.
 */
export function realPathOf(path: string, realpath: (path: string) => string, platform: NodeJS.Platform): string {
  const api = platform === 'win32' ? win32 : posix
  const rest: string[] = []
  for (let entry = path; ; entry = api.dirname(entry)) {
    try {
      return api.join(realpath(entry), ...rest.reverse())
    } catch {
      // ENOENT (or unreachable): try the parent and keep this name.
      if (api.dirname(entry) === entry) return path
      rest.push(api.basename(entry))
    }
  }
}

/**
 * Read everything {@link evaluatePreflight} needs.
 * @param request - the source, the picked folder, and the forbidden places.
 * @param probes - the disk reads.
 * @returns the facts.
 * @throws when the source cannot be resolved or scanned.
 */
export async function gatherPreflightFacts(request: PreflightRequest, probes: PreflightProbes): Promise<PreflightFacts> {
  const { platform } = request
  const source = probes.realpath(request.source)
  const target = resolveMoveTarget(request.chosen, probes.inspect, probes.isVolumeRoot)
  const chosenUnreadable = probes.isVolumeRoot(request.chosen) === undefined
  const real = (path: string): string => realPathOf(path, probes.realpath, platform)
  const forbidden: ForbiddenPlaces = {
    install: request.forbidden.install.map(real),
    userData: real(request.forbidden.userData),
    updateCache: real(request.forbidden.updateCache),
    workspaces: request.forbidden.workspaces.map(real),
    cloud: request.forbidden.cloud.map(real),
  }
  const scan = await probes.scan(source)
  let parentExists: boolean
  try {
    parentExists = lstatSync(probes.realpath(target.parent)).isDirectory()
  } catch {
    // ENOENT or unreachable: the move cannot create its target there.
    parentExists = false
  }
  const base = {
    platform, source, target, targetState: probes.inspect(target.target), realTarget: real(target.target), scan, forbidden,
    chosenUnreadable,
  }
  if (!parentExists) {
    return {
      ...base, parentExists, sameVolume: false, freeBytes: 0, fileSystem: undefined,
      capabilities: { ok: false, failure: { capability: 'write', code: 'ENOENT', detail: `${target.parent} does not exist` } },
    }
  }
  const device = probes.device(target.parent)
  return {
    ...base,
    parentExists,
    sameVolume: probes.device(source) === device && probes.device(dirname(source)) === device,
    freeBytes: probes.freeBytes(target.parent),
    fileSystem: await probes.fileSystem(probes.realpath(target.parent)),
    capabilities: probes.capabilities(target.parent),
  }
}
