/**
 * Create the `desktop` profile and put the plugins the installer ships beside
 * the server closure into it, before the embedded server reads it.
 *
 * The shell boots a profile of its own rather than the `web` profile every
 * `dsh web` shares, so nothing it writes into `$DSH_HOME` can only be satisfied
 * from inside the installed application. That makes creating the directory a
 * precondition of the boot rather than an improvement on it: `desktop` is not
 * in `PROFILE_TEMPLATES`, so `loadProfile` answers a home this has not run
 * against with `profile "desktop" does not exist`.
 *
 * A profile is otherwise user data — `initProfile` writes it once and never
 * revisits an existing file — and the template names only the two in-box
 * bundles, so nothing in the server would ever mount the packages the desktop
 * payload carries. This module supplies the three facts the boot needs and
 * nothing else:
 *
 * - the profile directory holds the manifest, the user patch layer, and the
 *   pnpm settings, the same three files `initProfile` writes;
 * - the manifest's `dsh.profile.bundles` list carries every name in
 *   {@link BUILTIN_WEB_BUNDLES}, so `loadProfile` applies their
 *   `cordis.patch.yml` layers;
 * - `$DSH_HOME/profiles/node_modules/<name>` links to the payload directory,
 *   so the Loader — which resolves a plugin specifier against the profile
 *   directory as `baseUrl` — finds the package on the ordinary parent walk.
 *   `healProfilesModuleFallback` maintains that same directory for the CLI
 *   app's own dependency closure and leaves names outside it alone, so these
 *   links survive every boot.
 *
 * A run has two levels. Initializing the profile is required, and a failure is
 * reported in {@link SeedReport.failed}: the launch still starts the server,
 * which owns the diagnostic for a profile it cannot load. Naming the built-in
 * bundles and maintaining the links stay best-effort, because every failure
 * there leaves a usable app without those plugins, which is the outcome to
 * prefer over a shell that will not launch. Both writes are idempotent and
 * additive: a name already listed is not added twice, a correct link is left as
 * it is, an existing file is never rewritten, and no bundle entry, dependency,
 * or other manifest field is ever removed.
 *
 * The three template files are reproduced here rather than imported.
 * `apps/desktop` ships as an Electron app whose `node_modules` is packed into
 * `app.asar`, so depending on a harness package would pull the product closure
 * in a second time beside the payload that already holds it.
 * `tests/profile-seed.spec.ts` compares what this writes against what
 * `initProfile` writes, so an edit to either side fails there.
 *
 * Removing a seeded plugin for good is a profile-level decision, not a shell
 * one: disable its row in `$DSH_HOME/profiles/desktop/cordis.patch.yml`.
 * Deleting the name from `dsh.profile.bundles` only lasts until the next launch.
 * @module @deepseek-ai/dsh-desktop/profile-seed
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Plugin packages the desktop installer ships and mounts, in the order they
 * join the bundle stack. They are appended after the template's own bundles,
 * so the in-box web app composes first and these patch over it.
 *
 * A scoped name is an ordinary member: every path this module builds from one
 * — the payload directory, the manifest entry, the flat-fallback link — is
 * joined rather than concatenated, and the link's scope directory is created
 * with it.
 */
export const BUILTIN_WEB_BUNDLES: readonly string[] = [
  'dsh-at-file', 'dsh-better-sidebar', '@haoran/dsh-screenshot', '@haoran/dsh-llm-permission-gateway',
  '@sumomok/dsh-quote-message', '@sumomok/dsh-edit-rerun', '@sumomok/dsh-balance',
  '@haoran/dsh-default-model',
]

/**
 * The profile the desktop shell boots (`dsh --profile desktop`), which no other
 * dsh installation launches. The CLI's own `web` profile is left untouched.
 */
export const DESKTOP_PROFILE = 'desktop'

/** Directory under the Harness home holding every profile (`PROFILES_DIR` in dsh-app-boot). */
const PROFILES_DIR = 'profiles'

/** The user patch layer inside a profile directory (`PROFILE_PATCH_FILENAME` in dsh-app-boot). */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** The pnpm settings file inside a profile directory. */
const PROFILE_WORKSPACE_FILENAME = 'pnpm-workspace.yaml'

/** What one seeding run was asked to do. */
export interface SeedSpec {
  /** The Harness home for this launch, from {@link resolveHarnessHome}. */
  home: string
  /** The shipped server closure's `node_modules`, where the built-in plugins live. */
  serverModules: string
  /** Bundle package names to seed, in bundle order; defaults to {@link BUILTIN_WEB_BUNDLES}. */
  bundles?: readonly string[]
}

/** What one seeding run changed, and what it declined to do. */
export interface SeedReport {
  /** Bundle names appended to `dsh.profile.bundles` this run. */
  seeded: string[]
  /** Flat-fallback links created or re-pointed this run. */
  linked: string[]
  /** One line per name or file the run left alone, each stating why. */
  skipped: string[]
  /** One line per built-in the profile's own `node_modules` shadows with another version. */
  shadowed: string[]
  /** True when the run created the profile manifest rather than editing one. */
  created: boolean
  /**
   * Why the profile directory could not be initialized, when it could not be.
   * The one failure a launch cannot absorb: the server refuses to boot a
   * profile that does not exist.
   */
  failed?: string
}

/** The manifest fields this module reads and writes; every other key is carried through verbatim. */
interface ProfileManifest {
  dsh?: { profile?: { bundles?: string[] } }
  [key: string]: unknown
}

/**
 * Resolve the Harness home the embedded server will resolve.
 *
 * Same two rules as `resolveDshHome` in `@deepseek-ai/dsh-home-paths`, which
 * the shell cannot import: `apps/desktop` ships as an Electron app whose
 * `node_modules` is packed into `app.asar`, and depending on a harness package
 * would pull the product closure in a second time beside the payload that
 * already holds it. A blank `DSH_HOME` counts as unset, so an empty override
 * never resolves the home to the working directory.
 * @param env - the environment to read `DSH_HOME` from.
 * @returns the absolute Harness home.
 */
export function resolveHarnessHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['DSH_HOME']
  if (configured !== undefined && configured.trim().length > 0) return resolve(expandHome(configured))
  return join(homedir(), '.dsh')
}

/** Expand the `~` prefixes `resolveDshHome` expands, so both agree on the same override. */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** The manifest `initProfile` writes for a fresh profile, with this profile's name and layers. */
function templateManifest(bundles: readonly string[]): ProfileManifest {
  return {
    name: `dsh-profile-${DESKTOP_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }
}

/** The shipped template's own bundle list (`PROFILE_TEMPLATES.web` in dsh-app-boot). */
const WEB_TEMPLATE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** The empty user patch layer (`PROFILE_PATCH_TEMPLATE` in dsh-app-boot). */
const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/**
 * The pnpm settings (`PROFILE_PNPM_WORKSPACE` in dsh-app-boot). `hoisted` is
 * what lets a peer an out-of-tree plugin does not install fall through to the
 * healed flat fallback, so a plugin the user adds later shares the
 * installation's one cordis instead of resolving a copy of its own.
 */
const PROFILE_PNPM_WORKSPACE = `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`

/**
 * Replace a file's contents in one step: write a sibling temporary file, then
 * rename it over the target. A launch interrupted mid-write then leaves the
 * previous manifest intact rather than a truncated one the server cannot parse.
 * @param path - the file to replace.
 * @param content - its new contents.
 */
function writeAtomic(path: string, content: string): void {
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, content)
  try {
    renameSync(temporary, path)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
}

/**
 * Write whichever of `initProfile`'s three files are absent, leaving every one
 * that is already there.
 * @param dir - the profile directory.
 * @param bundles - the bundle list a manifest written by this call declares.
 * @returns true when this call wrote the manifest, false when one was already there.
 * @throws when the directory or any of the three files cannot be written.
 */
function initDesktopProfile(dir: string, bundles: readonly string[]): boolean {
  mkdirSync(dir, { recursive: true })
  const manifestPath = join(dir, 'package.json')
  const created = !existsSync(manifestPath)
  if (created) writeAtomic(manifestPath, `${JSON.stringify(templateManifest(bundles), undefined, 2)}\n`)
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  if (!existsSync(patchPath)) writeAtomic(patchPath, PROFILE_PATCH_TEMPLATE)
  const workspacePath = join(dir, PROFILE_WORKSPACE_FILENAME)
  if (!existsSync(workspacePath)) writeAtomic(workspacePath, PROFILE_PNPM_WORKSPACE)
  return created
}

/**
 * Whether a link Windows or POSIX reported already resolves to `target`.
 *
 * `readlinkSync` does not return the string that created the link. Windows
 * reads a junction back in its extended-length form — `\\?\C:\dir\`, with the
 * prefix and a trailing separator `target` never carries — so a plain string
 * comparison is false for a correct link and the launch deletes and rebuilds it
 * every time. A relative read resolves against the link's own directory, which
 * is what a symbolic link means.
 * @param read - what `readlinkSync` returned for the link.
 * @param target - the directory the link is supposed to resolve to.
 * @param linkDir - the directory holding the link, the base of a relative read.
 * @returns true when the existing link already points at `target`.
 */
export function sameLinkTarget(read: string, target: string, linkDir: string): boolean {
  const canonical = (path: string): string =>
    resolve(linkDir, path.startsWith('\\\\?\\') ? path.slice(4) : path)
  return canonical(read) === canonical(target)
}

/**
 * Point `link` at `target`, replacing a link that points elsewhere. A real
 * directory at that path belongs to whoever created it and is reported instead
 * of removed.
 * @param link - the link path to maintain.
 * @param target - the directory it must resolve to.
 * @returns `true` when the link was created or re-pointed, `false` when it was already correct.
 * @throws when the path exists as something other than a symbolic link.
 */
function ensureLink(link: string, target: string): boolean {
  let existing
  try {
    existing = lstatSync(link)
  } catch {
    // Absent on a first launch, which is the ordinary case; every other lstat
    // failure resurfaces from symlinkSync below with the same path in it.
    existing = undefined
  }
  if (existing !== undefined) {
    if (!existing.isSymbolicLink()) throw new Error(`${link} exists and is not a symlink`)
    if (sameLinkTarget(readlinkSync(link), target, dirname(link))) return false
    // unlink removes the reparse point itself on Windows; rmSync would treat a
    // junction as a directory and refuse it.
    unlinkSync(link)
  }
  mkdirSync(dirname(link), { recursive: true })
  // 'junction' is what makes this work on Windows without developer mode; it is
  // ignored on POSIX, where an ordinary symlink is created.
  symlinkSync(target, link, 'junction')
  return true
}

/**
 * Make the desktop profile exist and mount the shipped built-in plugins in it.
 *
 * Runs before the server starts, so the profile the server reads already exists
 * and already names them.
 * @param spec - the Harness home, the shipped closure, and the names to seed.
 * @returns what was created, seeded, linked, and skipped.
 */
export function seedBuiltinBundles(spec: SeedSpec): SeedReport {
  const report: SeedReport = { seeded: [], linked: [], skipped: [], shadowed: [], created: false }
  const bundles = spec.bundles ?? BUILTIN_WEB_BUNDLES
  const available: string[] = []
  for (const name of bundles) {
    const dir = join(spec.serverModules, name)
    if (existsSync(join(dir, 'package.json'))) available.push(name)
    else report.skipped.push(`${name}: not in the shipped server closure (${dir})`)
  }

  const profileDir = join(spec.home, PROFILES_DIR, DESKTOP_PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  try {
    report.created = initDesktopProfile(profileDir, [...WEB_TEMPLATE_BUNDLES, ...available])
  } catch (error) {
    report.failed = `${profileDir}: ${String(error)}`
    return report
  }
  if (report.created) report.seeded.push(...available)
  else {
    try {
      seedExistingManifest(manifestPath, available, report)
    } catch (error) {
      report.skipped.push(`${manifestPath}: ${String(error)}`)
      return report
    }
  }

  const modulesDir = join(spec.home, PROFILES_DIR, 'node_modules')
  for (const name of available) {
    try {
      if (ensureLink(join(modulesDir, name), join(spec.serverModules, name))) report.linked.push(name)
    } catch (error) {
      report.skipped.push(`${join(modulesDir, name)}: ${String(error)}`)
    }
    reportShadowing(spec, profileDir, name, report)
  }
  return report
}

/**
 * Report a copy of a built-in the profile installed for itself at another
 * version. Node resolves the profile's own `node_modules` before the flat
 * fallback, so that copy is the code the Loader imports, while
 * `resolveBundleDir` still reads the patch layer from the installation — the
 * row and the module then come from different versions. Reported, never acted
 * on: the profile's dependencies belong to whoever installed them.
 */
function reportShadowing(spec: SeedSpec, profileDir: string, name: string, report: SeedReport): void {
  const local = join(profileDir, 'node_modules', name, 'package.json')
  if (!existsSync(local)) return
  const versionOf = (path: string): string | undefined => {
    try {
      return (JSON.parse(readFileSync(path, 'utf8')) as { version?: string }).version
    } catch {
      // An unreadable manifest says nothing about a version mismatch, and this
      // diagnostic must never be the thing that fails a launch.
      return undefined
    }
  }
  const installed = versionOf(local)
  const shipped = versionOf(join(spec.serverModules, name, 'package.json'))
  if (installed === undefined || shipped === undefined || installed === shipped) return
  report.shadowed.push(
    `profile copy ${name}@${installed} shadows the shipped ${shipped} module; patch layer comes from the shipped copy`,
  )
}

/**
 * Append the missing names to an existing manifest's bundle list. A manifest
 * that does not parse, or that declares no bundle list at all, is left exactly
 * as it is: the first is something the server reports with the diagnostic it
 * owns, and the second is a composition written by hand, where appending the
 * built-in names would produce a profile that mounts them and nothing else.
 */
function seedExistingManifest(manifestPath: string, available: readonly string[], report: SeedReport): void {
  let manifest: ProfileManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ProfileManifest
  } catch (error) {
    report.skipped.push(`${manifestPath}: unreadable, left for the server to report (${String(error)})`)
    return
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) {
    report.skipped.push(`${manifestPath}: declares no dsh.profile.bundles list; not rewriting a hand-composed profile`)
    return
  }
  const missing = available.filter(name => !bundles.includes(name))
  if (missing.length === 0) return
  const updated: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles, ...missing] } },
  }
  writeAtomic(manifestPath, `${JSON.stringify(updated, undefined, 2)}\n`)
  report.seeded.push(...missing)
}

/**
 * The one log line a seeding run is worth, or nothing when it changed nothing.
 * @param report - what {@link seedBuiltinBundles} did.
 * @returns the line to append to the server log, or undefined when there is nothing to say.
 */
export function describeSeed(report: SeedReport): string | undefined {
  const parts: string[] = []
  if (report.failed !== undefined) parts.push(`could not initialize the profile: ${report.failed}`)
  if (report.seeded.length > 0) {
    parts.push(`${report.created ? 'created with' : 'seeded'} built-in bundles ${report.seeded.join(', ')}`)
  }
  if (report.linked.length > 0) parts.push(`linked ${report.linked.join(', ')}`)
  for (const line of report.skipped) parts.push(`skipped ${line}`)
  for (const line of report.shadowed) parts.push(`warning: ${line}`)
  if (parts.length === 0) return undefined
  return `[desktop] profile ${DESKTOP_PROFILE}: ${parts.join('; ')}\n`
}
