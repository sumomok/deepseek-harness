/**
 * The LibreOffice engine the desktop downloads on request instead of shipping.
 *
 * The payload carries `@deepseek-ai/libreoffice-kit`, the entry package
 * `@deepseek-ai/dsh-office-to-pdf` imports, and none of its engine packages
 * (`@deepseek-ai/libreoffice-kit-<platform>-<arch>`): each is a whole
 * LibreOffice build of 145 MB or more once unpacked. The kit resolves its
 * engine with `createRequire(import.meta.url)` from its own directory and takes
 * no path from configuration, so an engine installed anywhere else reaches it
 * through `NODE_PATH` alone. On macOS and Windows a missing engine is an error
 * the converter reports; the kit falls back to its WASM build on Linux only.
 *
 * This module owns the facts that follow from that:
 *
 * - **Which engine.** {@link readEngineRequirement} reads the package name and
 *   the exact version from the shipped kit's own `optionalDependencies`, the
 *   same pair the kit's resolver checks every engine against, so a kit upgrade
 *   moves the download with it once {@link ENGINE_DOWNLOADS} registers the
 *   engine version the new kit declares.
 * - **Where it lives.** One directory per version under
 *   {@link officeEngineRoot}, which is a function of the data directory it is
 *   given rather than of the home directory, so a relocated data directory
 *   carries its engine with it.
 * - **Which versions stay.** {@link versionsToKeep} names the version the kit
 *   declares and, while that one is not installed, a complete engine of
 *   another version ({@link supersededEngine}): the engine an earlier kit
 *   declared, which only a confirmed download, or an upgrade from one, put
 *   there. {@link pruneEngineRoot} removes every other version.
 * - **How the server finds it.** {@link engineServerEnv} names the current
 *   version's `node_modules` in `NODE_PATH` whether or not it exists yet. Node
 *   reads `NODE_PATH` once at startup and caches only resolutions that
 *   succeed, so an engine installed while the server runs is found on the next
 *   conversion without a restart.
 * - **How it arrives.** {@link installEngine} runs the package manager this
 *   shell ships into a staging directory beside the version directory and
 *   renames it into place only once the engine on disk is the one asked for.
 *   The package manager checks the tarball against the integrity the registry
 *   metadata lists, filters by `os` and `cpu`, keeps the executable bits the
 *   kit checks for, and reads the user's own `.npmrc`, so a registry mirror or
 *   proxy configured there applies. Before the rename the shell compares the
 *   integrity the run recorded in its lockfile with the sha512 in
 *   {@link ENGINE_DOWNLOADS}, so metadata that names another tarball is
 *   refused. The download never goes through Electron's session, which would
 *   mark every file it writes with macOS's quarantine attribute.
 * @module @deepseek-ai/dsh-desktop-shell/office-engine
 */

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { PnpmInvocation } from './pnpm-launcher.ts'
import { augmentedEnv } from './server.ts'
import { compareVersions } from './version-order.ts'

/** The kit's entry package; each engine is `<entry>-<target>`. */
export const OFFICE_KIT = '@deepseek-ai/libreoffice-kit'

/**
 * The packages the server closure reaches the kit through, each resolved from
 * the one before it. The same chain holds in the hoisted payload, where every
 * name is a top-level directory, and in a development checkout, where each is
 * a workspace link.
 */
const KIT_RESOLUTION_CHAIN = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-office-to-pdf', OFFICE_KIT] as const

/**
 * Environment variable naming the engine directory this shell appended to the
 * server's `NODE_PATH`, set on the server child alone. The host half of
 * `@haoran/dsh-office-preview-notice` removes that entry from its own
 * `process.env.NODE_PATH`, so the processes the server starts do not inherit
 * it; the server itself keeps resolving through it, because Node read the
 * variable when it started.
 */
export const ENGINE_MODULES_ENV = 'DSH_DESKTOP_OFFICE_ENGINE_MODULES'

/**
 * A bare exact version. The version is joined into a package spec handed to
 * the package manager and into a directory name, so a range, a tag, a URL, or
 * anything carrying a path separator is refused rather than installed.
 */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/** Prefix of the directories an install stages into; only this module creates them. */
const STAGING_PREFIX = '.staging-'

/** Directory name, inside a staging directory, of the package store that install uses and then removes. */
const STAGING_STORE = '.pnpm-store'

/** One published engine tarball. */
export interface EngineDownload {
  /** Its size in bytes, as the registry reports it (`content-range` of the tarball URL). */
  bytes: number
  /** Its `dist.integrity`, as `npm view <package>@<version> dist.integrity` reports it. */
  integrity: string
}

/**
 * Every engine this desktop offers, by `<package>@<version>`. A version the
 * kit declares that this table lacks is not offered. The download prompt
 * quotes `bytes` before anything is fetched, the progress bar uses it when the
 * registry sends no length, and an install whose lockfile records another
 * integrity than `integrity` is refused.
 *
 * Each target is registered at every kit version a desktop build carries.
 * The workspace installs the kit at the version `pnpm-lock.yaml` pins
 * (0.1.1), which a development launch and `tests/office-engine.spec.ts`
 * read. The packaged server closure, which the packaged app reads, comes from
 * the legacy hoisted `pnpm deploy`. It does not take the lockfile's pin: it
 * resolves the kit's `^0.1.1` range to the highest release that is at least
 * pnpm's `minimumReleaseAge` (one day unless configured) old when the deploy
 * runs, so a later deploy can stage a newer kit. The staging deployed on
 * 2026-10-01 holds 0.1.3, and a deploy run after 2026-10-02 01:18 UTC, when
 * 0.1.5 turned one day old, stages 0.1.5. The spec fails when the workspace
 * kit declares an engine for either desktop target that this table does not
 * carry, and `scripts/office-engine-gate.ts` fails a package run whose staged
 * kit does.
 */
export const ENGINE_DOWNLOADS: Readonly<Record<string, EngineDownload>> = {
  '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1': {
    bytes: 66_711_287,
    integrity: 'sha512-D6NBvtoNpm9pOgBXGQTdxpds1tYMeiFKhGJgnXF/SE0124ZM8j0AOXI7cZ8CErHctqIoVYP+gKWCrnQl4we41A==',
  },
  '@deepseek-ai/libreoffice-kit-win32-x64@0.1.1': {
    bytes: 71_367_891,
    integrity: 'sha512-03CUYg9j2qJ7Q6K27xFCvTLa7FgawOZ1DtE6NlEYttF6TxGuyHEv358vBGc3cwlR1yG1Vfj+pa4e5MdPGpy8mA==',
  },
  '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.3': {
    bytes: 67_259_060,
    integrity: 'sha512-HinPGEyUNZUhBceN9kL9EeiFHo6bfhuY7D1uNBEdwJOzB+QJZVwWmbtc2A6Ds//bOukg9V+7FQEcOnjbqdRTUw==',
  },
  '@deepseek-ai/libreoffice-kit-win32-x64@0.1.3': {
    bytes: 71_374_248,
    integrity: 'sha512-PrUb4ykkI6fJBJ6MX40XgctY0mOUfO4yPWdWB5QdQSw5seq3fulBv0BcrJMTGw2ZT81wwB181MQja4AfOMWg2A==',
  },
  '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.5': {
    bytes: 67_261_855,
    integrity: 'sha512-SjeXmyaTevEq2TxK7reb1rhCrQZ4QOXmXt/qEwfQD5Fx3odU0ILx2uiXN+nphSCQ95LFCzrElHGgv2c7a824yg==',
  },
  '@deepseek-ai/libreoffice-kit-win32-x64@0.1.5': {
    bytes: 71_367_942,
    integrity: 'sha512-uKuDGZdofxuW4iRmUh8b3+XWU28JeOCYMTAONzo7tEHIq00DV2cARcgUYiTP7gUH49tH4A/RyPMOVEBzK7qjjw==',
  },
}

/** The engine package and exact version the kit declares for this host. */
export interface DeclaredEngine {
  /** The engine package name. */
  name: string
  /** The exact version the kit declares for it. */
  version: string
}

/** The engine this launch's kit requires. */
export interface EngineRequirement extends DeclaredEngine {
  /** The kit's target name, `<platform>-<arch>`. */
  target: string
  /** The published tarball size, from {@link ENGINE_DOWNLOADS}. */
  downloadBytes: number
  /** The published tarball's sha512 integrity, from {@link ENGINE_DOWNLOADS}. */
  integrity: string
}

/**
 * The outcome of reading the requirement: the engine, or why this launch can
 * offer none. `declared` is the engine the kit declares when
 * {@link ENGINE_DOWNLOADS} does not register its version, and absent for every
 * other refusal.
 */
export type RequirementResult =
  | { ok: true; requirement: EngineRequirement }
  | { ok: false; reason: string; declared?: DeclaredEngine }

/**
 * The kit's target name for a host, as the kit itself computes it for macOS
 * and Windows.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns `<platform>-<arch>`, or undefined for a host the kit builds no native engine for.
 */
export function officeEngineTarget(platform: NodeJS.Platform, arch: string): string | undefined {
  if (platform !== 'darwin' && platform !== 'win32') return undefined
  if (arch !== 'arm64' && arch !== 'x64') return undefined
  return `${platform}-${arch}`
}

/**
 * Locate the kit manifest the server closure resolves.
 * @param serverModules - `node_modules` of the shipped server closure.
 * @returns the absolute path of the kit's `package.json`.
 * @throws when a package on the chain does not resolve.
 */
export function kitManifestPath(serverModules: string): string {
  let from = join(dirname(serverModules), 'package.json')
  for (const name of KIT_RESOLUTION_CHAIN) {
    from = createRequire(from).resolve(`${name}/package.json`)
  }
  return from
}

/**
 * Read which engine this launch's kit requires.
 * @param serverModules - `node_modules` of the shipped server closure.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the engine, or the sentence saying why there is none to offer.
 */
export function readEngineRequirement(serverModules: string, platform: NodeJS.Platform, arch: string): RequirementResult {
  const target = officeEngineTarget(platform, arch)
  if (target === undefined) return { ok: false, reason: `no LibreOffice engine is built for ${platform}-${arch}` }
  let manifest: { optionalDependencies?: Record<string, unknown> }
  try {
    manifest = JSON.parse(readFileSync(kitManifestPath(serverModules), 'utf8')) as typeof manifest
  } catch (error) {
    return { ok: false, reason: `the LibreOffice kit could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
  const name = `${OFFICE_KIT}-${target}`
  const version = manifest.optionalDependencies?.[name]
  if (typeof version !== 'string' || !EXACT_VERSION.test(version)) {
    return { ok: false, reason: `the LibreOffice kit declares no exact version of ${name}` }
  }
  const download = ENGINE_DOWNLOADS[`${name}@${version}`]
  if (download === undefined) {
    return { ok: false, reason: `this version of the preview component is not registered yet (${name}@${version})`, declared: { name, version } }
  }
  return { ok: true, requirement: { target, name, version, downloadBytes: download.bytes, integrity: download.integrity } }
}

/**
 * The directory every engine version lives under.
 * @param dataDir - the data directory this launch uses.
 * @returns `<dataDir>/engines/office`.
 */
export function officeEngineRoot(dataDir: string): string {
  return join(dataDir, 'engines', 'office')
}

/**
 * The `node_modules` one engine version is installed into, which is what
 * `NODE_PATH` names.
 * @param root - {@link officeEngineRoot}.
 * @param version - the engine version.
 * @returns `<root>/<version>/node_modules`.
 */
export function engineModulesDir(root: string, version: string): string {
  return join(root, version, 'node_modules')
}

/**
 * The environment additions that let the server's kit resolve the engine.
 * @param root - {@link officeEngineRoot}.
 * @param requirement - the engine this launch's kit requires.
 * @param inherited - the `NODE_PATH` the shell itself was started with, kept after the engine entry.
 * @returns `NODE_PATH` and {@link ENGINE_MODULES_ENV}.
 */
export function engineServerEnv(root: string, requirement: EngineRequirement, inherited: string | undefined): Record<string, string> {
  const modules = engineModulesDir(root, requirement.version)
  const rest = (inherited ?? '').split(delimiter).filter(entry => entry !== '' && entry !== modules)
  return { NODE_PATH: [modules, ...rest].join(delimiter), [ENGINE_MODULES_ENV]: modules }
}

/**
 * Read one JSON file of an engine package.
 * @param path - the file.
 * @returns the parsed value, or undefined when it is absent or not JSON.
 */
function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // Absent before an install and half-written after an interrupted one;
    // neither is part of an installed engine.
    return undefined
  }
}

/**
 * Whether a `node_modules` holds an engine, complete: the version the kit
 * checks for, the engine manifest it reads next, and the executable that
 * manifest names, which the kit requires to be a file with an execute bit
 * outside Windows.
 * @param modules - the `node_modules` to look in.
 * @param engine - the engine package and version to look for.
 * @returns true when the package directory carries that version, its `prebuilds.json`, and a runnable executable.
 */
function holdsEngine(modules: string, engine: DeclaredEngine): boolean {
  const dir = join(modules, engine.name)
  const manifest = readJson(join(dir, 'package.json')) as { version?: unknown } | null | undefined
  if (manifest?.version !== engine.version) return false
  const prebuilds = readJson(join(dir, 'prebuilds.json')) as { engine?: { executable?: unknown } } | null | undefined
  const executable = prebuilds?.engine?.executable
  if (typeof executable !== 'string') return false
  let mode: number
  try {
    const status = statSync(join(dir, executable))
    if (!status.isFile()) return false
    mode = status.mode
  } catch {
    // A missing executable is an engine removed or cut short by hand.
    return false
  }
  return process.platform === 'win32' || (mode & 0o111) !== 0
}

/**
 * Whether the required engine is installed where {@link engineServerEnv}
 * points. An engine whose executable is gone or has lost its execute bit is
 * not, so the download is offered again.
 * @param root - {@link officeEngineRoot}.
 * @param requirement - the engine to look for.
 * @returns true when the version directory holds it, complete.
 */
export function engineInstalled(root: string, requirement: EngineRequirement): boolean {
  return holdsEngine(engineModulesDir(root, requirement.version), requirement)
}

/**
 * The highest version, other than the declared one, whose directory under the
 * root holds a complete engine of the declared package. Only an install the
 * person confirmed, or an upgrade from one, puts such a directory there, so
 * finding one is the record that they agreed to keep the engine; a kit that
 * declares another version makes it unusable, because the kit accepts its own
 * exact version only.
 * @param root - {@link officeEngineRoot}.
 * @param declared - the engine the kit declares.
 * @returns the version directory's name, or undefined when no other version directory holds a complete engine.
 */
export function supersededEngine(root: string, declared: DeclaredEngine): string | undefined {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    // No root yet: nothing was ever installed.
    return undefined
  }
  let highest: string | undefined
  for (const name of names) {
    if (name === declared.version || !EXACT_VERSION.test(name)) continue
    if (!holdsEngine(engineModulesDir(root, name), { name: declared.name, version: name })) continue
    if (highest === undefined || compareVersions(name, highest) > 0) highest = name
  }
  return highest
}

/** The engine versions one launch's prune keeps. */
export interface KeptVersions {
  /** The version the kit declares, registered or not; undefined when the kit declares no exact version for this host or cannot be read. */
  declared?: string
  /**
   * The {@link supersededEngine} while the declared version is not installed:
   * kept until the declared version replaces it, and undefined once that
   * version is installed or when no other version holds a complete engine.
   */
  superseded?: string
}

/**
 * The engine versions a launch's prune keeps: the version the kit declares,
 * whether or not {@link ENGINE_DOWNLOADS} registers it, and, while that
 * version is not installed, the complete engine of another version that a
 * confirmed download, or an upgrade from one, left.
 * @param root - {@link officeEngineRoot}.
 * @param result - this launch's {@link readEngineRequirement}.
 * @returns the version directories {@link pruneEngineRoot} must not remove.
 */
export function versionsToKeep(root: string, result: RequirementResult): KeptVersions {
  const declared = result.ok ? result.requirement : result.declared
  if (declared === undefined) return {}
  if (holdsEngine(engineModulesDir(root, declared.version), declared)) return { declared: declared.version }
  const superseded = supersededEngine(root, declared)
  return superseded === undefined ? { declared: declared.version } : { declared: declared.version, superseded }
}

/** What one prune removed and what it could not. */
export interface PruneResult {
  /** Entry names removed from the root. */
  removed: string[]
  /** Entry names that matched and could not be removed, each with the reason. */
  failed: string[]
}

/**
 * Remove every engine version but the ones named, and every staging directory
 * an interrupted install left behind.
 *
 * Only names this module creates are touched — an exact version or the
 * staging prefix — so anything else a person put under the root stays. Call
 * it when no install is running: a staging directory in use is removed too.
 * @param root - {@link officeEngineRoot}.
 * @param keep - the versions to keep; an undefined entry keeps nothing, and none keeps no version.
 * @returns what was removed and what could not be.
 */
export function pruneEngineRoot(root: string, ...keep: readonly (string | undefined)[]): PruneResult {
  const result: PruneResult = { removed: [], failed: [] }
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    // No root yet: nothing was ever installed, so nothing is stale.
    return result
  }
  for (const name of names) {
    if (keep.includes(name)) continue
    if (!EXACT_VERSION.test(name) && !name.startsWith(STAGING_PREFIX)) continue
    try {
      rmSync(join(root, name), { recursive: true, force: true })
      result.removed.push(name)
    } catch (error) {
      result.failed.push(`${name} (${error instanceof Error ? error.message : String(error)})`)
    }
  }
  return result
}

/** Progress one install reports, in bytes. */
export interface InstallProgress {
  /** Bytes of the engine tarball received so far. */
  transferredBytes: number
  /** The tarball's size, as the registry or {@link ENGINE_DOWNLOADS} says. */
  totalBytes?: number
}

/** What one install is given. */
export interface InstallSpec {
  /** {@link officeEngineRoot}. */
  root: string
  /** The engine to install. */
  requirement: EngineRequirement
  /** How to run the package manager. */
  pnpm: PnpmInvocation
  /** Aborting it stops the package manager and removes the staging directory. */
  signal: AbortSignal
  /** Wall-clock budget for the package manager run. */
  timeoutMs: number
  /** Receives every progress change. */
  onProgress: (progress: InstallProgress) => void
}

/** How one install ended. */
export type InstallOutcome = { ok: true } | { ok: false; cancelled: boolean; reason: string }

/** Lines of package-manager output a failure quotes. */
const FAILURE_LINES = 3

/** Characters of one quoted failure line. */
const FAILURE_LINE_CHARS = 300

/**
 * Read one ndjson line of the package manager's reporter into progress.
 *
 * `pnpm:fetching-progress` reports a tarball's size when its download starts
 * and the running byte count while it continues; every other record is
 * ignored.
 * @param line - one line of the reporter's output.
 * @param requirement - the engine being installed, whose tarball is the one reported.
 * @returns the byte fields this line carries, or undefined when it carries none.
 */
export function readProgressLine(line: string, requirement: EngineRequirement): { size?: number; downloaded?: number } | undefined {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    // The reporter writes one JSON object per line; anything else is a
    // warning the package manager printed around it, and carries no bytes.
    return undefined
  }
  if (typeof record !== 'object' || record === null) return undefined
  const fields = record as Record<string, unknown>
  if (fields.name !== 'pnpm:fetching-progress') return undefined
  if (typeof fields.packageId !== 'string' || !fields.packageId.includes(`${requirement.name}@${requirement.version}`)) return undefined
  if (fields.status === 'started' && typeof fields.size === 'number') return { size: fields.size }
  if (fields.status === 'in_progress' && typeof fields.downloaded === 'number') return { downloaded: fields.downloaded }
  return undefined
}

/**
 * The error lines of the reporter's output, for a failure's reason.
 * @param line - one line of the reporter's output.
 * @returns the message of an error-level record, or undefined for anything else.
 */
function errorMessage(line: string): string | undefined {
  let record: unknown
  try {
    record = JSON.parse(line)
  } catch {
    // Output outside the reporter's records; see readProgressLine.
    return line.trim() === '' ? undefined : line.trim()
  }
  if (typeof record !== 'object' || record === null) return undefined
  const fields = record as Record<string, unknown>
  if (fields.level !== 'error') return undefined
  const err = fields.err as { message?: unknown } | undefined
  if (typeof err?.message === 'string') return err.message
  return typeof fields.message === 'string' ? fields.message : undefined
}

/** The lockfile a package-manager run writes in the directory it runs in. */
const LOCKFILE = 'pnpm-lock.yaml'

/**
 * The integrity a package-manager run recorded for the engine.
 * @param staging - the directory the run ran in.
 * @param requirement - the engine it installed.
 * @returns `packages["<name>@<version>"].resolution.integrity` of its lockfile, or undefined when the file or the record is missing.
 */
function lockedIntegrity(staging: string, requirement: EngineRequirement): string | undefined {
  let lock: unknown
  try {
    lock = parseYaml(readFileSync(join(staging, LOCKFILE), 'utf8'))
  } catch {
    // A missing or unreadable lockfile records nothing; the caller refuses the
    // install for it the same way as for a record naming another integrity.
    return undefined
  }
  const packages = (lock as { packages?: Record<string, { resolution?: { integrity?: unknown } } | undefined> } | null)?.packages
  const integrity = packages?.[`${requirement.name}@${requirement.version}`]?.resolution?.integrity
  return typeof integrity === 'string' ? integrity : undefined
}

/**
 * Rename, retrying a Windows `EPERM`/`EBUSY`: an on-access scanner holds files
 * it has just seen being written, and a rename fails while it does.
 * @param from - the staging directory.
 * @param to - the version directory.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= 9 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/**
 * Install one engine version.
 *
 * The package manager runs in a staging directory created inside `root`, so
 * the final rename stays on one volume and is atomic: the version directory
 * {@link engineServerEnv} names either does not exist or holds the complete
 * engine, and a converter never meets a half-written one. The run uses a
 * package store inside that staging directory and removes it before the
 * rename, so the engine is on disk once rather than once more in the user's
 * global store. `--ignore-workspace` keeps a `pnpm-workspace.yaml` above the
 * data directory from turning the install into someone else's workspace,
 * `--ignore-scripts` means nothing the package declares runs, and
 * `--config.lockfile=true` keeps a user's `.npmrc` from suppressing the
 * lockfile whose recorded integrity is compared with
 * `requirement.integrity` before anything is moved into place.
 * @param spec - where, what, how, and the abort and progress hooks.
 * @returns how it ended; it never throws.
 */
export async function installEngine(spec: InstallSpec): Promise<InstallOutcome> {
  const { root, requirement } = spec
  let staging: string
  try {
    mkdirSync(root, { recursive: true })
    staging = mkdtempSync(join(root, STAGING_PREFIX))
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ name: 'dsh-office-engine', private: true })}\n`)
  } catch (error) {
    return { ok: false, cancelled: false, reason: `the engine directory could not be prepared: ${error instanceof Error ? error.message : String(error)}` }
  }
  const discard = (): void => {
    try {
      rmSync(staging, { recursive: true, force: true })
    } catch {
      // Left for the next launch's prune, which removes every staging
      // directory; a failed cleanup must not replace the outcome being reported.
    }
  }
  const run = await runPnpm(spec, staging)
  if (!run.ok) {
    discard()
    return run
  }
  const locked = lockedIntegrity(staging, requirement)
  if (locked !== requirement.integrity) {
    discard()
    return {
      ok: false,
      cancelled: false,
      reason: locked === undefined
        ? `the package manager finished, but recorded no integrity for ${requirement.name}@${requirement.version}`
        : `the downloaded ${requirement.name}@${requirement.version} is not the published one: its integrity is ${locked}, and ${requirement.integrity} was expected`,
    }
  }
  const modules = join(staging, 'node_modules')
  if (!holdsEngine(modules, requirement)) {
    discard()
    return { ok: false, cancelled: false, reason: `the package manager finished, but ${requirement.name}@${requirement.version} is not complete on disk` }
  }
  try {
    rmSync(join(staging, STAGING_STORE), { recursive: true, force: true })
    rmSync(join(root, requirement.version), { recursive: true, force: true })
    await renameWithRetry(staging, join(root, requirement.version))
  } catch (error) {
    discard()
    return { ok: false, cancelled: false, reason: `the engine could not be moved into place: ${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true }
}

/**
 * Run the package manager for one install.
 * @param spec - the install being run.
 * @param staging - the directory it runs in.
 * @returns ok, or how it failed.
 */
async function runPnpm(spec: InstallSpec, staging: string): Promise<InstallOutcome> {
  const { requirement, pnpm } = spec
  if (spec.signal.aborted) return { ok: false, cancelled: true, reason: 'cancelled' }
  const args = [
    ...pnpm.prefixArgs,
    'add', `${requirement.name}@${requirement.version}`,
    '--ignore-workspace', '--ignore-scripts', '--reporter=ndjson',
    '--config.node-linker=hoisted', '--config.lockfile=true', `--store-dir=${join(staging, STAGING_STORE)}`,
  ]
  const env = augmentedEnv(process.env)
  if (pnpm.pathPrefix !== undefined) env.PATH = [pnpm.pathPrefix, env.PATH ?? ''].filter(part => part !== '').join(delimiter)
  return new Promise<InstallOutcome>((resolve) => {
    const child = spawn(pnpm.command, args, { cwd: staging, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let totalBytes = requirement.downloadBytes
    const errors: string[] = []
    let settled = false
    let ending: InstallOutcome | undefined
    const stop = (outcome: InstallOutcome): void => {
      ending ??= outcome
      child.kill()
    }
    const onAbort = (): void => { stop({ ok: false, cancelled: true, reason: 'cancelled' }) }
    spec.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      stop({ ok: false, cancelled: false, reason: `the download did not finish within ${String(Math.ceil(spec.timeoutMs / 60_000))} minutes` })
    }, spec.timeoutMs)
    const settle = (outcome: InstallOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      spec.signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const onLine = (line: string): void => {
      const progress = readProgressLine(line, requirement)
      if (progress?.size !== undefined) {
        totalBytes = progress.size
        spec.onProgress({ transferredBytes: 0, totalBytes })
      } else if (progress?.downloaded !== undefined) {
        spec.onProgress({ transferredBytes: progress.downloaded, totalBytes })
      }
      const message = errorMessage(line)
      if (message !== undefined) {
        errors.push(message.slice(0, FAILURE_LINE_CHARS))
        if (errors.length > FAILURE_LINES) errors.shift()
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      let pending = ''
      stream.on('data', (chunk: Buffer) => {
        const lines = (pending + chunk.toString()).split('\n')
        pending = lines.pop() ?? ''
        for (const line of lines) onLine(line)
      })
      stream.on('end', () => {
        if (pending !== '') onLine(pending)
      })
    }
    child.once('error', (error) => {
      settle({ ok: false, cancelled: false, reason: `the package manager could not be started: ${error.message}` })
    })
    child.once('close', (code) => {
      if (ending !== undefined) settle(ending)
      else if (code === 0) settle({ ok: true })
      else settle({ ok: false, cancelled: false, reason: `the package manager exited with ${String(code)}${errors.length === 0 ? '' : `: ${errors.join(' / ')}`}` })
    })
  })
}
