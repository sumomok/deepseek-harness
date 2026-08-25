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
 * prefer over a shell that will not launch. Both writes are idempotent: a name
 * already listed is not added twice, a correct link is left as it is, an
 * existing file is never rewritten, and the one-time migration below is the
 * only thing here that writes a `dependencies` entry or replaces a file this
 * module wrote.
 *
 * The one thing a run removes is a built-in this build withdrew — a name in
 * {@link WITHDRAWN_WEB_BUNDLES} that an earlier build seeded and this payload
 * no longer carries. `loadProfile` resolves every `dsh.profile.bundles` entry
 * and throws on one it cannot resolve, so an upgrade that just stopped
 * shipping a package would leave every profile it had seeded unbootable.
 *
 * The plugins a user installed into the CLI's shared `web` profile move across
 * once, because every desktop build before `desktop` existed composed that
 * profile and the switch left them behind. {@link MIGRATION_MARKER_FILENAME}
 * inside the desktop profile records that the migration ran and which names it
 * added, and the run is gated on that file rather than on creating the profile:
 * a home whose desktop profile an earlier build already created is migrated on
 * its first launch under this one.
 *
 * A migrated name is linked, never installed and never copied — the desktop
 * profile's `node_modules` gets a link to the package inside
 * `profiles/web/node_modules`, so the web profile stays the one place the
 * package lives and a later `dsh plugin --profile web` update reaches both.
 * The machines this runs on have no package manager, so nothing here may run an
 * install. Only a name that resolves once its link exists is added to
 * `dsh.profile.bundles`, and every later run takes back out a name that stopped
 * resolving: reinstalling or deleting the web profile must not leave a desktop
 * that will not boot.
 *
 * What the migration does not check is whether a package installed under an
 * older host suits this one. Its unmet peers fall through to
 * `$DSH_HOME/profiles/node_modules`, which the running installation heals, so
 * it shares this build's cordis; whether its code matches this build's API is
 * not a question a link can answer.
 *
 * The three template files are reproduced here rather than imported.
 * `apps/desktop` ships as an Electron app whose `node_modules` is packed into
 * `app.asar`, so depending on a harness package would pull the product closure
 * in a second time beside the payload that already holds it.
 * `tests/profile-seed.spec.ts` compares what this writes against what
 * `initProfile` writes, so an edit to either side fails there.
 *
 * Turning a shipped plugin off is a profile-level decision, not a shell one:
 * disable its row in `$DSH_HOME/profiles/desktop/cordis.patch.yml`. Deleting
 * the name from `dsh.profile.bundles` only lasts until the next launch.
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
  '@sumomok/dsh-quote-message', '@sumomok/dsh-balance', '@haoran/dsh-plugin-updates',
  '@haoran/dsh-default-model',
]

/**
 * Plugin packages an earlier build seeded and this payload no longer carries.
 *
 * A name here is one the shell put into a profile itself, which makes the shell
 * the only thing that can take it back out: the server resolves every
 * `dsh.profile.bundles` entry against the installation and the profile, and a
 * name that resolves in neither place fails the boot outright.
 *
 * A run removes such a name only where leaving it would be that failure, and
 * removes the flat-fallback link only where it is the one this shell would have
 * made. A copy the user installed themselves keeps both its link and its bundle
 * entry, under the ownership that put it there.
 *
 * An entry stays here while any build that seeded it may still be installed;
 * dropping one only stops repairing the profiles that still name it.
 */
export const WITHDRAWN_WEB_BUNDLES: readonly string[] = ['@sumomok/dsh-edit-rerun']

/**
 * The profile the desktop shell boots (`dsh --profile desktop`), which no other
 * dsh installation launches. The CLI's own `web` profile is left untouched.
 */
export const DESKTOP_PROFILE = 'desktop'

/**
 * The profile every `dsh web` shares, and the one the shell itself composed
 * before {@link DESKTOP_PROFILE} existed. It is the source of the one-time
 * migration and is never written to.
 */
export const WEB_PROFILE = 'web'

/**
 * The shell's record of the one-time migration out of the `web` profile, inside
 * the desktop profile directory.
 *
 * Its presence is what makes the migration run once, and the names it holds are
 * the entries a later run re-checks: they are the ones this shell put into a
 * profile pointing at a directory it does not own.
 */
export const MIGRATION_MARKER_FILENAME = 'web-migration.json'

/** Directory under the Harness home holding every profile (`PROFILES_DIR` in dsh-app-boot). */
const PROFILES_DIR = 'profiles'

/**
 * Where one profile's directory is, under a Harness home.
 *
 * The same join `loadProfile` performs, exported so nothing else in the shell
 * spells this path itself.
 * @param home - the Harness home, from {@link resolveHarnessHome}.
 * @param profile - the profile name.
 * @returns the absolute profile directory.
 */
export function profileDirectory(home: string, profile: string): string {
  return join(home, PROFILES_DIR, profile)
}

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
  /** Withdrawn built-ins whose name this run removed from `dsh.profile.bundles`. */
  pruned: string[]
  /** Withdrawn built-ins whose flat-fallback link this run removed. */
  unlinked: string[]
  /** User plugin names this run brought over from the `web` profile. */
  migrated: string[]
  /** Profile files this run copied verbatim out of the `web` profile, by filename. */
  copied: string[]
  /** One line per migrated name this run took back out, each stating why. */
  staleMigrations: string[]
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
  dsh?: { profile?: { bundles?: string[] }; bundle?: unknown }
  [key: string]: unknown
}

/** The shell's own record of what the one-time `web` migration put into this profile. */
interface MigrationMarker {
  /** The profile the names came from, so the file says what it is. */
  from: string
  /** The bundle names this shell added, in the order it added them. */
  migrated: string[]
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
 * @param content - its new contents; bytes rather than text for a file copied verbatim.
 */
function writeAtomic(path: string, content: string | Uint8Array): void {
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
  const report: SeedReport = {
    seeded: [], linked: [], pruned: [], unlinked: [], migrated: [], copied: [], staleMigrations: [],
    skipped: [], shadowed: [], created: false,
  }
  const bundles = spec.bundles ?? BUILTIN_WEB_BUNDLES
  const available: string[] = []
  for (const name of bundles) {
    const dir = join(spec.serverModules, name)
    if (existsSync(join(dir, 'package.json'))) available.push(name)
    else report.skipped.push(`${name}: not in the shipped server closure (${dir})`)
  }

  const profileDir = profileDirectory(spec.home, DESKTOP_PROFILE)
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
  migrateWebBundles(spec, profileDir, report)
  dropStaleMigrations(spec, profileDir, report)
  pruneWithdrawnBundles(spec, profileDir, report)
  return report
}

/**
 * Read and parse a profile manifest, or answer undefined when there is none to
 * read. Absent and unparsable are the same answer here: both are a profile
 * whose composition this run cannot reason about, and the pass that owns the
 * diagnostic for an unparsable desktop manifest has already reported it.
 * @param path - the manifest path.
 * @returns the parsed manifest, or undefined.
 */
function tryReadManifest(path: string): ProfileManifest | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as ProfileManifest
  } catch {
    // Absent on every home without that profile, malformed on one whose owner
    // edited it by hand; neither is a state this module repairs.
    return undefined
  }
}

/**
 * A manifest's `dependencies` map, or an empty one when the field is absent or
 * holds something other than a JSON object. The values stay `unknown`: a
 * hand-edited manifest may carry anything there, and only a string is copied.
 * @param manifest - the manifest to read, if there is one.
 * @returns the dependency map.
 */
function dependenciesOf(manifest: ProfileManifest | undefined): Record<string, unknown> {
  const value = manifest?.['dependencies']
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

/**
 * The package names one profile's manifest declares as its own dependencies.
 *
 * These are the packages the profile installed, as opposed to the bundles it
 * merely lists: a built-in the shell seeded is named in `dsh.profile.bundles`
 * and resolves from the installation, so it never appears here. That makes this
 * set the one a package manager may act on for this profile, and the reason
 * {@link seedBuiltinBundles} may not add to it.
 * @param profileDir - the profile directory.
 * @returns the declared names, sorted; empty for a profile whose manifest is absent or unreadable.
 */
export function profileDependencyNames(profileDir: string): string[] {
  const declared = dependenciesOf(tryReadManifest(join(profileDir, 'package.json')))
  return Object.keys(declared).filter(name => typeof declared[name] === 'string').sort()
}

/** Whether `link` is a symbolic link this shell would have made, resolving to `target`. */
function linksTo(link: string, target: string): boolean {
  try {
    return lstatSync(link).isSymbolicLink() && sameLinkTarget(readlinkSync(link), target, dirname(link))
  } catch {
    // Absent, or a real directory whose readlink fails: neither is this
    // shell's link, which is the only thing the answer is about.
    return false
  }
}

/**
 * Why a name in the `web` profile's bundle list is one this build already
 * composes, or undefined when it is a user plugin to bring across.
 *
 * The two in-box bundles are not among these. They are in the desktop template
 * and in every web profile ever created, so passing over them says nothing
 * about the profile being read and is left out of the log.
 * @param name - the bundle package name from the web profile.
 * @returns the reason to log, or undefined.
 */
function migrationRefusal(name: string): string | undefined {
  if (BUILTIN_WEB_BUNDLES.includes(name)) return 'covered by built-in'
  if (WITHDRAWN_WEB_BUNDLES.includes(name)) return 'withdrawn, not migrated'
  return undefined
}

/**
 * Why the package at `dir` cannot be a bundle layer, or undefined when it can.
 *
 * The two defects are the two ways `loadProfile` ends a boot over one entry:
 * `resolveBundleDir` finds no package, or the package it finds declares no
 * `dsh.bundle`. Both the check that admits a name and the check that takes one
 * back out read this, so neither can come to disagree with the other about what
 * the server accepts.
 * @param dir - the package directory to inspect, which need not exist.
 * @returns which defect the package has, or undefined when it has neither.
 */
function bundleDefect(dir: string): 'missing' | 'not-a-bundle' | undefined {
  const manifest = tryReadManifest(join(dir, 'package.json'))
  if (manifest === undefined) return 'missing'
  return manifest.dsh?.bundle === undefined ? 'not-a-bundle' : undefined
}

/**
 * Why the package a `web` bundle name points at cannot be mounted from the
 * desktop profile, or undefined when it can.
 * @param dir - where the web profile holds the package.
 * @returns the reason to log, or undefined.
 */
function migrationAdmission(dir: string): string | undefined {
  switch (bundleDefect(dir)) {
    case 'missing': return `not installed in the web profile (${dir})`
    case 'not-a-bundle': return 'declares no dsh.bundle, which the server refuses as a bundle layer'
    default: return undefined
  }
}

/**
 * Bring the plugins a user installed into the shared `web` profile across,
 * once, and record what was brought.
 *
 * The record — not the profile's absence — is what makes this run once, so the
 * homes this matters most for are reached: a desktop profile an earlier build
 * created holds the built-ins and nothing the user ever added, and its owner
 * lost those plugins on the launch that switched profiles.
 *
 * A name is linked into the desktop profile's own `node_modules` and only then
 * added to `dsh.profile.bundles`, so no entry this writes is one the server
 * cannot resolve. The link points at the web profile's path rather than at what
 * that path resolves to: the web profile stays the copy that is updated, and a
 * later `dsh plugin --profile web` reaches the desktop through it.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param report - the run's report, extended with what was migrated and refused.
 */
function migrateWebBundles(spec: SeedSpec, profileDir: string, report: SeedReport): void {
  const markerPath = join(profileDir, MIGRATION_MARKER_FILENAME)
  if (existsSync(markerPath)) return
  const manifestPath = join(profileDir, 'package.json')
  const manifest = tryReadManifest(manifestPath)
  const listed = manifest?.dsh?.profile?.bundles
  if (manifest === undefined || !Array.isArray(listed)) return
  const webDir = profileDirectory(spec.home, WEB_PROFILE)
  const webManifest = tryReadManifest(join(webDir, 'package.json'))
  const candidates = webManifest?.dsh?.profile?.bundles
  // Every name the marker records, and the subset this run put in the manifest.
  const recorded: string[] = []
  const added: string[] = []
  for (const name of Array.isArray(candidates) ? candidates : []) {
    if (recorded.includes(name) || WEB_TEMPLATE_BUNDLES.includes(name)) continue
    const source = join(webDir, 'node_modules', name)
    const refusal = migrationRefusal(name)
    if (refusal !== undefined) {
      report.skipped.push(`${name}: ${refusal}`)
      continue
    }
    if (listed.includes(name)) {
      // A name already listed whose link is this shell's own is a migration
      // whose record was lost, not a plugin the user installed themselves:
      // recording it again restores the repair below without changing anything.
      if (linksTo(join(profileDir, 'node_modules', name), source)) recorded.push(name)
      else report.skipped.push(`${name}: already in the desktop profile`)
      continue
    }
    const admission = migrationAdmission(source)
    if (admission !== undefined) {
      report.skipped.push(`${name}: ${admission}`)
      continue
    }
    try {
      ensureLink(join(profileDir, 'node_modules', name), source)
    } catch (error) {
      report.skipped.push(`${name}: ${String(error)}`)
      continue
    }
    recorded.push(name)
    added.push(name)
  }
  if (added.length > 0) {
    try {
      recordMigratedBundles(manifestPath, manifest, listed, added, webManifest)
    } catch (error) {
      // The links are made and nothing names them, which is the state the next
      // launch retries from; writing no marker is what lets it.
      report.skipped.push(`${manifestPath}: ${String(error)}`)
      return
    }
    copyPristineProfileFile(webDir, profileDir, PROFILE_PATCH_FILENAME, PROFILE_PATCH_TEMPLATE, added, report)
    copyPristineProfileFile(webDir, profileDir, PROFILE_WORKSPACE_FILENAME, PROFILE_PNPM_WORKSPACE, added, report)
  }
  writeMigrationMarker(markerPath, recorded, report)
  report.migrated.push(...added)
}

/**
 * Add the migrated names to the desktop manifest's bundle list, and give each
 * one the version specifier the web profile declared for it.
 *
 * The specifier is what a later `dsh plugin --profile desktop install` would
 * reconcile against; a name the web manifest declares no dependency for, and
 * one the desktop manifest already declares, are both left as they are.
 * @param manifestPath - the desktop profile manifest.
 * @param manifest - its parsed contents, as read this run.
 * @param listed - the bundle list it currently declares.
 * @param names - the migrated names, in bundle order.
 * @param webManifest - the web profile's manifest, if it parsed.
 * @throws when the manifest cannot be replaced.
 */
function recordMigratedBundles(
  manifestPath: string, manifest: ProfileManifest, listed: readonly string[], names: readonly string[],
  webManifest: ProfileManifest | undefined,
): void {
  const declared = dependenciesOf(webManifest)
  const dependencies = { ...dependenciesOf(manifest) }
  let copied = false
  for (const name of names) {
    const specifier = declared[name]
    if (typeof specifier !== 'string' || dependencies[name] !== undefined) continue
    dependencies[name] = specifier
    copied = true
  }
  const updated: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...listed, ...names] } },
  }
  if (copied) updated['dependencies'] = dependencies
  writeAtomic(manifestPath, `${JSON.stringify(updated, undefined, 2)}\n`)
}

/**
 * Replace one of the profile files this module writes a template for with the
 * web profile's own, while the desktop copy is still that template byte for
 * byte and the web copy is not.
 *
 * The file is copied rather than merged. A patch layer carries comments and
 * `!!js` tags that only the loader's own YAML schema reads, so parsing one to
 * combine it with another would be a second implementation of that schema; an
 * edited desktop copy is therefore left alone with the names to carry over
 * named in the log.
 * @param webDir - the web profile directory.
 * @param profileDir - the desktop profile directory.
 * @param filename - the file to copy, the same name in both profiles.
 * @param template - the contents this module writes for a fresh profile.
 * @param names - the migrated names, for the line that says what to carry by hand.
 * @param report - the run's report, extended with the decision.
 */
function copyPristineProfileFile(
  webDir: string, profileDir: string, filename: string, template: string, names: readonly string[],
  report: SeedReport,
): void {
  const target = join(profileDir, filename)
  let bytes
  try {
    bytes = readFileSync(join(webDir, filename))
  } catch {
    // No web profile, or a profile whose owner deleted the file: either way
    // there is nothing of theirs to carry over.
    return
  }
  if (bytes.toString('utf8') === template) return
  try {
    if (readFileSync(target, 'utf8') !== template) {
      report.skipped.push(
        `${filename}: the desktop copy is already edited; carry the web profile's rows for ${names.join(', ')} over by hand`,
      )
      return
    }
    writeAtomic(target, bytes)
  } catch (error) {
    report.skipped.push(`${target}: ${String(error)}`)
    return
  }
  report.copied.push(filename)
}

/**
 * Write the migration record. A failure is reported rather than thrown: the
 * profile is already migrated and usable, and the next launch rebuilds the
 * record from the links it finds.
 * @param path - the marker path inside the desktop profile.
 * @param migrated - every name this shell has migrated into the profile.
 * @param report - the run's report, extended with a failure to write.
 */
function writeMigrationMarker(path: string, migrated: readonly string[], report: SeedReport): void {
  const marker: MigrationMarker = { from: WEB_PROFILE, migrated: [...migrated] }
  try {
    writeAtomic(path, `${JSON.stringify(marker, undefined, 2)}\n`)
  } catch (error) {
    report.skipped.push(`${path}: ${String(error)}`)
  }
}

/**
 * The names the migration record holds, or undefined on a profile that has not
 * been migrated.
 *
 * A marker that exists but does not parse answers with no names: its presence
 * is what says the migration ran, and a record this cannot read is one it
 * cannot repair from either.
 * @param path - the marker path inside the desktop profile.
 * @returns the recorded names, or undefined when there is no record.
 */
function readMigratedNames(path: string): string[] | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No marker at all on a home that has not migrated; an unreadable one is
    // still a marker, and existsSync is what tells the two apart.
    return existsSync(path) ? [] : undefined
  }
  const migrated = (parsed as MigrationMarker | null)?.migrated
  return Array.isArray(migrated) ? migrated.filter(name => typeof name === 'string') : []
}

/**
 * Take back out a migrated name the server would now refuse, on every run.
 *
 * The migration points the desktop profile at a package the user owns and keeps
 * changing: emptying or reinstalling the `web` profile leaves the links this
 * shell made dangling, and updating the package there can replace it with a
 * version that is no longer a bundle at all. `loadProfile` ends the whole boot
 * on either, and a `dsh plugin --profile web` reconcile repairs the web
 * manifest and never this one. The names the record holds are exactly the
 * entries whose package is outside this installation, so they are exactly the
 * ones to re-check, against the same {@link bundleDefect} the migration admits
 * a name by.
 *
 * A name that still mounts from anywhere — the user's own copy in the desktop
 * profile, a link they made themselves, a package this build now ships — is
 * left alone with its entry. A name that goes is not brought back: the record
 * is what makes the migration a one-time move, and re-adding the plugin is
 * `dsh plugin --profile desktop add`.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param report - the run's report, extended with what this removed.
 */
function dropStaleMigrations(spec: SeedSpec, profileDir: string, report: SeedReport): void {
  const markerPath = join(profileDir, MIGRATION_MARKER_FILENAME)
  const recorded = readMigratedNames(markerPath)
  if (recorded === undefined) return
  const stale = new Map<string, string>()
  for (const name of recorded) {
    const reason = migrationDefect(spec, profileDir, name)
    if (reason !== undefined) stale.set(name, reason)
  }
  if (stale.size === 0) return
  const webModules = join(profileDirectory(spec.home, WEB_PROFILE), 'node_modules')
  for (const name of stale.keys()) {
    const link = join(profileDir, 'node_modules', name)
    try {
      removeSeededLink(link, join(webModules, name))
    } catch (error) {
      report.skipped.push(`${link}: ${String(error)}`)
    }
  }
  const manifestPath = join(profileDir, 'package.json')
  try {
    dropBundleNames(manifestPath, [...stale.keys()])
  } catch (error) {
    // The entry stays, and so does the record that will retry it next launch.
    report.skipped.push(`${manifestPath}: ${String(error)}`)
    return
  }
  writeMigrationMarker(markerPath, recorded.filter(name => !stale.has(name)), report)
  for (const [name, reason] of stale) report.staleMigrations.push(`${name}: ${reason}`)
}

/**
 * Why a migrated name would now end the boot, or undefined while it still
 * mounts.
 *
 * The two answers are separate lines in the log because they are separate
 * things for a user to do something about: one says the package left the web
 * profile, the other says the version now installed there is not a plugin the
 * server can mount.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param name - a bundle name the migration record holds.
 * @returns the reason to log, or undefined.
 */
function migrationDefect(spec: SeedSpec, profileDir: string, name: string): string | undefined {
  const dir = resolvedBundleDir(spec, profileDir, name)
  if (dir === undefined) return 'no longer resolves in the web profile'
  return bundleDefect(dir) === undefined ? undefined : 'its installed version no longer declares dsh.bundle'
}

/**
 * Take the built-ins this build withdrew back out of a profile an earlier build
 * seeded them into.
 *
 * A name this payload still carries is not withdrawn on this build whatever
 * {@link WITHDRAWN_WEB_BUNDLES} says, and needs no repair: it still resolves
 * from the installation.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param report - the run's report, extended with what this removed.
 */
function pruneWithdrawnBundles(spec: SeedSpec, profileDir: string, report: SeedReport): void {
  const modulesDir = join(spec.home, PROFILES_DIR, 'node_modules')
  const orphaned: string[] = []
  for (const name of WITHDRAWN_WEB_BUNDLES) {
    if (existsSync(join(spec.serverModules, name, 'package.json'))) continue
    const link = join(modulesDir, name)
    try {
      if (removeSeededLink(link, join(spec.serverModules, name))) report.unlinked.push(name)
    } catch (error) {
      report.skipped.push(`${link}: ${String(error)}`)
    }
    if (!resolvesForProfile(spec, profileDir, name)) orphaned.push(name)
  }
  if (orphaned.length === 0) return
  const manifestPath = join(profileDir, 'package.json')
  try {
    report.pruned.push(...dropBundleNames(manifestPath, orphaned))
  } catch (error) {
    report.skipped.push(`${manifestPath}: ${String(error)}`)
  }
}

/**
 * Remove a flat-fallback link this shell made for a package it no longer ships.
 *
 * Only two links qualify: one that no longer resolves to anything, and one that
 * points exactly where this build's closure would hold the package — between
 * them, every link an earlier launch of this shell left behind. Anything else
 * at that path, a real directory included, belongs to whoever created it.
 * @param link - the flat-fallback path for the withdrawn name.
 * @param shipped - where this build's closure would hold that package.
 * @returns true when the link was removed.
 * @throws when the path cannot be unlinked.
 */
function removeSeededLink(link: string, shipped: string): boolean {
  let existing
  try {
    existing = lstatSync(link)
  } catch {
    // Absent, which is every home that never installed a build shipping it.
    return false
  }
  if (!existing.isSymbolicLink()) return false
  // existsSync follows the link, so this is false exactly when it dangles.
  if (existsSync(link) && !sameLinkTarget(readlinkSync(link), shipped, dirname(link))) return false
  unlinkSync(link)
  return true
}

/**
 * Where the server would resolve a bundle name for this profile, or undefined
 * when it would resolve nowhere.
 *
 * The three directories `resolveBundleDir` reaches through its two anchors, in
 * its own order: the installation's own closure, the profile's `node_modules`,
 * and the flat fallback beside it. `existsSync` follows symbolic links, so a
 * dangling one counts as the absence it is.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param name - the bundle package name.
 * @returns the directory the server would read the package from, or undefined.
 */
function resolvedBundleDir(spec: SeedSpec, profileDir: string, name: string): string | undefined {
  return [
    join(spec.serverModules, name),
    join(profileDir, 'node_modules', name),
    join(spec.home, PROFILES_DIR, 'node_modules', name),
  ].find(dir => existsSync(join(dir, 'package.json')))
}

/**
 * Whether the server could still resolve a bundle name for this profile.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param name - the bundle package name.
 * @returns true when at least one of the three directories holds the package.
 */
function resolvesForProfile(spec: SeedSpec, profileDir: string, name: string): boolean {
  return resolvedBundleDir(spec, profileDir, name) !== undefined
}

/**
 * Drop bundle names from an existing manifest's list, leaving every other field.
 * @param manifestPath - the profile manifest.
 * @param names - the names to remove.
 * @returns the names that were in the list and are no longer.
 * @throws when the manifest cannot be replaced.
 */
export function dropBundleNames(manifestPath: string, names: readonly string[]): string[] {
  const manifest = tryReadManifest(manifestPath)
  // Unreadable: either this run wrote it and it parses, or the seeding pass
  // above read the same file and already reported it for the server.
  if (manifest === undefined) return []
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) return []
  const dropped = bundles.filter(name => names.includes(name))
  if (dropped.length === 0) return []
  const updated: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: bundles.filter(name => !names.includes(name)) } },
  }
  writeAtomic(manifestPath, `${JSON.stringify(updated, undefined, 2)}\n`)
  return dropped
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
  if (report.migrated.length > 0) parts.push(`migrated ${report.migrated.join(', ')} from the web profile`)
  if (report.copied.length > 0) parts.push(`copied ${report.copied.join(', ')} from the web profile`)
  if (report.pruned.length > 0) parts.push(`dropped withdrawn built-in ${report.pruned.join(', ')}`)
  if (report.unlinked.length > 0) parts.push(`unlinked ${report.unlinked.join(', ')}`)
  for (const line of report.staleMigrations) parts.push(`dropped migrated ${line}`)
  for (const line of report.skipped) parts.push(`skipped ${line}`)
  for (const line of report.shadowed) parts.push(`warning: ${line}`)
  if (parts.length === 0) return undefined
  return `[desktop] profile ${DESKTOP_PROFILE}: ${parts.join('; ')}\n`
}
