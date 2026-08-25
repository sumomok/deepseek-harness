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
 * existing file is never rewritten, and syncing the `web` profile below is the
 * only thing here that writes a `dependencies` entry or replaces a file this
 * module wrote.
 *
 * The one thing a run removes on its own is a built-in this build withdrew — a
 * name in {@link WITHDRAWN_WEB_BUNDLES} that an earlier build seeded and this
 * payload no longer carries. `loadProfile` resolves every `dsh.profile.bundles`
 * entry and throws on one it cannot resolve, so an upgrade that just stopped
 * shipping a package would leave every profile it had seeded unbootable.
 *
 * **The plugins a user installed into the CLI's shared `web` profile stay in
 * step with the desktop profile on every launch**, because every build before
 * `desktop` existed composed that profile and nothing else ever wrote to it.
 * {@link MIGRATION_MARKER_FILENAME} inside the desktop profile is the shell's
 * own bookkeeping for this: which names it has migrated, which it has found
 * defective, and which it has tombstoned as removed. A name is linked, never
 * installed and never copied — the desktop profile's `node_modules` gets a
 * link to the package inside `profiles/web/node_modules`, so the web profile
 * stays the one place the package lives and a later `dsh plugin --profile web`
 * update reaches both. The machines this runs on have no package manager, so
 * nothing here may run an install.
 *
 * **A defective package never aborts the boot.** `loadProfile` resolves every
 * `dsh.profile.bundles` entry and ends the boot on one it cannot import, and a
 * package this shell admits from the `web` profile is user data this shell did
 * not build or vet — an unbuilt git install with no `lib/` and no `prepare`
 * script is a real field case. {@link bundleDefect} is the one predicate every
 * admission, every per-boot revalidation, and the plugin-admin service's own
 * repair routes read, and a defective name never reaches the bundle list: its
 * link is kept (so it stays inspectable and repairable) and it is recorded in
 * the marker's `defective` list instead, visible and disabled rather than
 * silently gone. Deleting the desktop link while the web profile still holds a
 * healthy copy tombstones the name into the marker's `removed` list instead of
 * dropping it outright, which is what keeps a plugin the user deliberately took
 * off the desktop from coming back on its own; a name whose web copy is also
 * gone is dropped with nothing left to show. A boot that still fails because a
 * migrated plugin's import throws — the case manifest-level admission cannot
 * catch — is `server.ts` and `main.ts`'s to quarantine from that boot's own
 * output, using {@link quarantineLoadFailureFromOutput} to move the blamed name
 * into `defective` and retry once.
 *
 * **Peer versions are not this module's problem.** A package installed under an
 * older host suits it or it does not: its unmet peers fall through to
 * `$DSH_HOME/profiles/node_modules`, which the running installation heals, so
 * it shares this build's cordis, but whether its code matches this build's API
 * is not a question a link can answer.
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

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
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
 * before {@link DESKTOP_PROFILE} existed. It is the source every synced plugin
 * comes from and is never written to.
 */
export const WEB_PROFILE = 'web'

/**
 * The shell's record of what it has synced out of the `web` profile, inside the
 * desktop profile directory.
 *
 * Its presence is what a fresh install has none of, and a first sync copies the
 * patch layer and pnpm settings verbatim only while it is still absent; every
 * later sync updates the three lists it holds without touching either file
 * again.
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
  /** User plugin names this run newly admitted from the `web` profile. */
  migrated: string[]
  /** Profile files this run copied verbatim out of the `web` profile, by filename. */
  copied: string[]
  /** One line per name this run recorded or updated as defective, each stating why. */
  disabled: string[]
  /** One line per name this run tombstoned into `removed`, each stating why. */
  removed: string[]
  /** One line per name this run stopped tracking altogether, each stating why. */
  dropped: string[]
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

/** Why a package cannot be mounted as a bundle layer, from {@link bundleDefect}. */
export type BundleDefectKind = 'missing' | 'not-a-bundle' | 'entry-missing'

/**
 * A name the marker records as unable to mount as a bundle layer.
 *
 * `missing` — no package at all — is never one of these: there is nothing here
 * to show as a residual, disabled plugin, so a name whose package disappears
 * entirely is dropped from the marker or tombstoned into `removed`, never
 * recorded as defective.
 */
export interface DefectiveEntry {
  /** The package name. */
  name: string
  /** Why it cannot be mounted; `load-failed` is a boot quarantine, not {@link bundleDefect}'s own answer. */
  kind: Exclude<BundleDefectKind, 'missing'> | 'load-failed'
  /** One plain English sentence: what a person reading it should do or expect. */
  detail: string
  /** `Date.now()` when this shell first recorded the defect, in epoch milliseconds. */
  at: number
}

/**
 * The shell's own record of what it has synced out of the `web` profile:
 * cross-component contract read by `@haoran/dsh-plugin-updates` as well as this
 * shell, so its field names and the meaning of each list are load-bearing.
 */
export interface MigrationMarker {
  /** The profile the names came from. */
  from: string
  /** Names currently linked, mounted, and in `dsh.profile.bundles`. */
  migrated: string[]
  /** Names linked but kept out of `dsh.profile.bundles` because they cannot mount. */
  defective: DefectiveEntry[]
  /** Names the desktop profile no longer links, whose web copy is still healthy — never re-synced on their own. */
  removed: string[]
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
export function ensureLink(link: string, target: string): boolean {
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
 * Remove a symbolic link this shell made, if one is there.
 *
 * Unconditional, unlike {@link ensureLink}'s own cleanup: this is for a caller
 * that has already decided the link should go — `/forget` on a defective or
 * removed name — rather than one repointing it. A real directory at that path,
 * or nothing at all, is left alone.
 * @param link - the link path.
 * @throws when the path is a symbolic link that cannot be removed.
 */
export function removeLink(link: string): void {
  let existing
  try {
    existing = lstatSync(link)
  } catch {
    // Nothing there, which is already the outcome this call wants.
    return
  }
  if (existing.isSymbolicLink()) unlinkSync(link)
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
    seeded: [], linked: [], pruned: [], unlinked: [], migrated: [], copied: [], disabled: [], removed: [],
    dropped: [], skipped: [], shadowed: [], created: false,
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
  syncWebBundles(spec, profileDir, report)
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
 * {@link seedBuiltinBundles} may not add to it directly.
 * @param profileDir - the profile directory.
 * @returns the declared names, sorted; empty for a profile whose manifest is absent or unreadable.
 */
export function profileDependencyNames(profileDir: string): string[] {
  const declared = dependenciesOf(tryReadManifest(join(profileDir, 'package.json')))
  return Object.keys(declared).filter(name => typeof declared[name] === 'string').sort()
}

/**
 * The version specifier a profile's manifest declares for one of its own
 * dependencies — the spec pnpm recorded when it was installed, and the one a
 * reinstall should ask pnpm for again.
 * @param profileDir - the profile directory.
 * @param name - the dependency name.
 * @returns the specifier, or undefined when the profile declares none for that name.
 */
export function profileDependencySpec(profileDir: string, name: string): string | undefined {
  const value = dependenciesOf(tryReadManifest(join(profileDir, 'package.json')))[name]
  return typeof value === 'string' ? value : undefined
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
 * composes, or undefined when it is a user plugin to sync.
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
 * Condition keys `entryCandidates` reads inside an `exports` target, in the
 * order Node itself prefers them.
 */
const ENTRY_CONDITIONS = ['default', 'import', 'require', 'node'] as const

/**
 * The string targets one `exports` value names, allowing exactly one level of
 * nested conditions.
 * @param value - the `exports` value to read — a string, a conditions object, or neither.
 * @param nested - whether a conditions object found here may itself hold conditions.
 * @returns the target paths named, in {@link ENTRY_CONDITIONS} order; empty when `value` names none.
 */
function conditionTargets(value: unknown, nested: boolean): string[] {
  if (typeof value === 'string') return [value]
  if (!nested || value === null || typeof value !== 'object' || Array.isArray(value)) return []
  const record = value as Record<string, unknown>
  const targets: string[] = []
  for (const key of ENTRY_CONDITIONS) {
    const inner = record[key]
    if (inner !== undefined) targets.push(...conditionTargets(inner, false))
  }
  return targets
}

/**
 * The `"."` entry an `exports` field names, or undefined when it names no root
 * entry at all — a subpath-only `exports` naming nothing for the bare package
 * specifier.
 * @param exportsField - the manifest's `exports` value.
 * @returns the root entry's own value, ready for {@link conditionTargets}.
 */
function rootExportEntry(exportsField: unknown): unknown {
  if (typeof exportsField === 'string') return exportsField
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return undefined
  const record = exportsField as Record<string, unknown>
  if ('.' in record) return record['.']
  // No `.` key and no subpath key either: the object itself is the condition
  // map for the root entry, the shorthand Node accepts for a package with no
  // subpath exports at all.
  return Object.keys(record).some(key => key.startsWith('.')) ? undefined : record
}

/**
 * Where a bundle's entry file could be, in the order Node itself resolves a
 * bare import of the package: `exports`'s root entry when the manifest
 * declares one, else `main`, else the bare default.
 * @param manifest - the package manifest.
 * @returns candidate paths relative to the package directory; empty only when
 * `exports` exists but names no root entry Node would ever reach.
 */
function entryCandidates(manifest: ProfileManifest): string[] {
  const exportsField = manifest['exports']
  if (exportsField !== undefined) {
    const root = rootExportEntry(exportsField)
    return root === undefined ? [] : conditionTargets(root, true)
  }
  const main = manifest['main']
  return typeof main === 'string' ? [main] : ['index.js']
}

/**
 * Whether none of a package's entry candidates exist on disk.
 * @param dir - the package directory.
 * @param manifest - its parsed manifest.
 * @returns true when every candidate {@link entryCandidates} names is absent —
 * including when there were no candidates to check at all.
 */
function hasMissingEntry(dir: string, manifest: ProfileManifest): boolean {
  return entryCandidates(manifest).every(candidate => !existsSync(join(dir, candidate)))
}

/**
 * Why the package at `dir` cannot be a bundle layer, or undefined when it can.
 *
 * The three defects are the three ways a bundle entry can end a boot:
 * `resolveBundleDir` finds no package, the package it finds declares no
 * `dsh.bundle`, or the package declares one but its own entry file was never
 * built — the field case is an unbuilt git install with `src/*.ts` and no
 * `lib/` at all. Every admission and revalidation in this module, and the
 * plugin-admin service's `/recheck` and `/repair` routes, read this one
 * function, so none of them can come to disagree about what the server
 * accepts.
 * @param dir - the package directory to inspect, which need not exist.
 * @returns which defect the package has, or undefined when it has none.
 */
export function bundleDefect(dir: string): BundleDefectKind | undefined {
  const manifest = tryReadManifest(join(dir, 'package.json'))
  if (manifest === undefined) return 'missing'
  if (manifest.dsh?.bundle === undefined) return 'not-a-bundle'
  return hasMissingEntry(dir, manifest) ? 'entry-missing' : undefined
}

/**
 * The one plain-English sentence a defect kind is reported with, for the
 * marker's `detail` field and the launch log.
 * @param kind - the defect {@link bundleDefect} found; `missing` is answered
 * for completeness, though no caller persists it as a `DefectiveEntry.kind`.
 * @param dir - the package directory the defect was found in.
 * @returns the sentence.
 */
export function defectDetail(kind: BundleDefectKind, dir: string): string {
  if (kind === 'missing') return `not installed (${dir})`
  if (kind === 'not-a-bundle') return 'the installed package declares no dsh.bundle, which the server refuses as a bundle layer'
  const manifest = tryReadManifest(join(dir, 'package.json'))
  const candidates = manifest === undefined ? [] : entryCandidates(manifest)
  return candidates.length === 0
    ? 'the installed package names no entry file the server could import'
    : `the installed package has no built entry file (looked for ${candidates.join(', ')} in ${dir}); its build script has not been run`
}

/** An empty marker, for a profile with no record yet. */
function emptyMarker(): MigrationMarker {
  return { from: WEB_PROFILE, migrated: [], defective: [], removed: [] }
}

/** Whether a value parses as a {@link DefectiveEntry} the marker file can carry. */
function isDefectiveEntry(value: unknown): value is DefectiveEntry {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['name'] === 'string' && typeof record['kind'] === 'string'
    && ['entry-missing', 'not-a-bundle', 'load-failed'].includes(record['kind'])
    && typeof record['detail'] === 'string' && typeof record['at'] === 'number'
}

/**
 * Read the migration marker, tolerating both an absent file and the pre-sync
 * format that carried only `from` and `migrated`.
 * @param path - the marker path inside a desktop profile.
 * @returns the marker with every list defaulted to empty, or undefined when the file does not exist at all.
 */
export function readMigrationMarker(path: string): MigrationMarker | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    // No marker at all on a profile that has never synced; an unreadable one
    // is still a marker, and existsSync is what tells the two apart.
    return existsSync(path) ? emptyMarker() : undefined
  }
  const raw = parsed as Partial<Record<keyof MigrationMarker, unknown>> | null
  return {
    from: typeof raw?.['from'] === 'string' ? raw['from'] : WEB_PROFILE,
    migrated: Array.isArray(raw?.['migrated']) ? raw['migrated'].filter((v): v is string => typeof v === 'string') : [],
    defective: Array.isArray(raw?.['defective']) ? raw['defective'].filter(isDefectiveEntry) : [],
    removed: Array.isArray(raw?.['removed']) ? raw['removed'].filter((v): v is string => typeof v === 'string') : [],
  }
}

/**
 * Replace the migration marker in one step.
 * @param path - the marker path inside a desktop profile.
 * @param marker - its new contents.
 * @throws when the file cannot be replaced.
 */
export function writeMigrationMarker(path: string, marker: MigrationMarker): void {
  writeAtomic(path, `${JSON.stringify(marker, undefined, 2)}\n`)
}

/**
 * Append one name to a profile manifest's `dsh.profile.bundles`, copying the
 * web profile's own dependency specifier for it when the manifest declares
 * none of its own. A name already listed is left exactly as it is.
 * @param profileDir - the profile directory whose manifest gains the name.
 * @param home - the Harness home, for the web profile's declared specifier.
 * @param name - the bundle name to add.
 * @throws when the manifest cannot be read as one with a bundle list, or cannot be replaced.
 */
export function addBundleName(profileDir: string, home: string, name: string): void {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = tryReadManifest(manifestPath)
  const listed = manifest?.dsh?.profile?.bundles
  if (manifest === undefined || !Array.isArray(listed)) {
    throw new Error(`${manifestPath}: unreadable, or declares no dsh.profile.bundles list`)
  }
  if (listed.includes(name)) return
  const webManifest = tryReadManifest(join(profileDirectory(home, WEB_PROFILE), 'package.json'))
  updateTrackedBundles(manifestPath, manifest, listed, [name], dependenciesOf(webManifest), [])
}

/**
 * Write a profile manifest's bundle list and dependency map in one pass:
 * `additions` appended and given the web profile's declared version where the
 * manifest names none of its own, `removals` dropped. Both may be empty; the
 * caller only calls this when at least one is not.
 * @param manifestPath - the manifest to replace.
 * @param manifest - its parsed contents, as read this run.
 * @param listed - the bundle list it currently declares.
 * @param additions - names to append, in order.
 * @param declaredVersions - the source profile's own `dependencies` map, read once for every addition.
 * @param removals - names to drop.
 * @throws when the manifest cannot be replaced.
 */
function updateTrackedBundles(
  manifestPath: string, manifest: ProfileManifest, listed: readonly string[], additions: readonly string[],
  declaredVersions: Record<string, unknown>, removals: readonly string[],
): void {
  const kept = listed.filter(name => !removals.includes(name))
  const dependencies = { ...dependenciesOf(manifest) }
  let dependenciesChanged = false
  for (const name of additions) {
    const specifier = declaredVersions[name]
    if (typeof specifier !== 'string' || dependencies[name] !== undefined) continue
    dependencies[name] = specifier
    dependenciesChanged = true
  }
  const updated: ProfileManifest = {
    ...manifest,
    dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...kept, ...additions] } },
  }
  if (dependenciesChanged) updated['dependencies'] = dependencies
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

/** Where {@link reviewMigrated} found a currently migrated name to stand. */
type MigratedReview =
  | { status: 'healthy' }
  | { status: 'defective'; kind: Exclude<BundleDefectKind, 'missing'>; detail: string }
  | { status: 'removed' }
  | { status: 'dropped' }

/**
 * Where a currently migrated name now stands: still mountable, mountable but
 * defective, gone from the desktop side while the web profile still holds a
 * healthy copy, or gone from both.
 *
 * Resolution reads the same three directories every other bundle name resolves
 * through, not just the web profile's own copy: a user who took the package
 * over — a copy under the desktop profile's own `node_modules`, a link they
 * repointed themselves, or a package this build started shipping — still
 * mounts, and none of those is this function's business to disturb.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param webDir - the web profile directory, the source a migrated link points at.
 * @param name - a name the marker's `migrated` list holds.
 * @returns which of the four the name is in.
 */
function reviewMigrated(spec: SeedSpec, profileDir: string, webDir: string, name: string): MigratedReview {
  const resolved = resolvedBundleDir(spec, profileDir, name)
  if (resolved !== undefined) {
    const defect = bundleDefect(resolved)
    if (defect === undefined || defect === 'missing') return { status: 'healthy' }
    return { status: 'defective', kind: defect, detail: defectDetail(defect, resolved) }
  }
  const webCopy = join(webDir, 'node_modules', name)
  return bundleDefect(webCopy) === undefined ? { status: 'removed' } : { status: 'dropped' }
}

/**
 * Bring the plugins a user installed into the shared `web` profile across, and
 * keep the desktop composition in step with what the web profile currently
 * holds, on every launch.
 *
 * Every recorded name is revalidated first, against the same {@link
 * bundleDefect} its own admission read: one still healthy is left alone, one
 * now defective is taken out of `dsh.profile.bundles` and recorded in the
 * marker's `defective` list with its link kept, one whose desktop link is gone
 * while the web copy is still healthy is tombstoned into `removed`, and one
 * gone from both sides is dropped with nothing left to track. A name already
 * in `defective` or `removed` is left exactly where it is — only `/recheck`,
 * `/repair`, and `/enable` on the plugin-admin service move one of those back.
 *
 * Every name the web profile's own bundle list now carries and this marker has
 * not yet seen is admitted next: linked, and — when {@link bundleDefect} finds
 * nothing wrong — added to `dsh.profile.bundles` with the web profile's
 * declared version copied into `dependencies`; a defective one keeps its link
 * and is recorded in `defective` instead. The wholesale copy of the patch layer
 * and pnpm settings only ever happens on the very first sync a profile ever
 * runs, so a later launch never overwrites edits either profile's owner has
 * made since.
 * @param spec - the run's home and shipped closure.
 * @param profileDir - the desktop profile directory.
 * @param report - the run's report, extended with what was migrated, disabled, removed, dropped, and refused.
 */
function syncWebBundles(spec: SeedSpec, profileDir: string, report: SeedReport): void {
  const manifestPath = join(profileDir, 'package.json')
  const manifest = tryReadManifest(manifestPath)
  const listed = manifest?.dsh?.profile?.bundles
  if (manifest === undefined || !Array.isArray(listed)) return

  const markerPath = join(profileDir, MIGRATION_MARKER_FILENAME)
  const firstSync = !existsSync(markerPath)
  const marker = readMigrationMarker(markerPath) ?? emptyMarker()
  const webDir = profileDirectory(spec.home, WEB_PROFILE)
  const webManifest = tryReadManifest(join(webDir, 'package.json'))
  const candidateNames = webManifest?.dsh?.profile?.bundles
  const declaredVersions = dependenciesOf(webManifest)

  const migrated = new Set(marker.migrated)
  const defective = new Map(marker.defective.map(entry => [entry.name, entry]))
  const removed = new Set(marker.removed)
  const bundleAdditions: string[] = []
  const bundleRemovals: string[] = []

  for (const name of marker.migrated) {
    const review = reviewMigrated(spec, profileDir, webDir, name)
    if (review.status === 'healthy') continue
    migrated.delete(name)
    bundleRemovals.push(name)
    if (review.status === 'defective') {
      defective.set(name, { name, kind: review.kind, detail: review.detail, at: Date.now() })
      report.disabled.push(`${name}: ${review.detail}`)
    } else if (review.status === 'removed') {
      removed.add(name)
      report.removed.push(`${name}: no longer linked in the desktop profile; still installed in the web profile, so it will not return on its own`)
    } else {
      // Nothing tracks this name any more and nothing resolves through its
      // link either, so the link itself is now cruft this shell made and
      // nobody else has any reason to keep: `removeLink` takes it only if it
      // is still the symbolic link this shell left, and leaves a real
      // directory — the user's own copy — untouched.
      try {
        removeLink(join(profileDir, 'node_modules', name))
      } catch (error) {
        report.skipped.push(`${join(profileDir, 'node_modules', name)}: ${String(error)}`)
      }
      report.dropped.push(`${name}: no longer resolves in the web profile`)
    }
  }

  for (const name of Array.isArray(candidateNames) ? candidateNames : []) {
    if (WEB_TEMPLATE_BUNDLES.includes(name)) continue
    if (migrated.has(name) || defective.has(name) || removed.has(name)) continue
    const refusal = migrationRefusal(name)
    if (refusal !== undefined) { report.skipped.push(`${name}: ${refusal}`); continue }
    const source = join(webDir, 'node_modules', name)
    const defect = bundleDefect(source)
    if (defect === 'missing') { report.skipped.push(`${name}: not installed in the web profile (${source})`); continue }
    const link = join(profileDir, 'node_modules', name)
    const alreadyListed = listed.includes(name)
    if (alreadyListed) {
      // A migration whose bundle entry survived a lost or deleted record: only
      // this shell's own link recovers it, never a name the profile lists for
      // some other reason.
      if (!linksTo(link, source)) { report.skipped.push(`${name}: already in the desktop profile`); continue }
      if (defect === undefined) migrated.add(name)
      else { defective.set(name, { name, kind: defect, detail: defectDetail(defect, source), at: Date.now() }); bundleRemovals.push(name) }
      continue
    }
    try {
      ensureLink(link, source)
    } catch (error) {
      report.skipped.push(`${name}: ${String(error)}`)
      continue
    }
    if (defect === undefined) {
      migrated.add(name)
      bundleAdditions.push(name)
      report.migrated.push(name)
    } else {
      defective.set(name, { name, kind: defect, detail: defectDetail(defect, source), at: Date.now() })
    }
    if (defect !== undefined) report.disabled.push(`${name}: ${defectDetail(defect, source)}`)
  }

  if (bundleAdditions.length > 0 || bundleRemovals.length > 0) {
    try {
      updateTrackedBundles(manifestPath, manifest, listed, bundleAdditions, declaredVersions, bundleRemovals)
    } catch (error) {
      // The links are made (or already were) and nothing names the change;
      // writing no marker either is what lets the next launch retry from here.
      report.skipped.push(`${manifestPath}: ${String(error)}`)
      return
    }
  }
  if (firstSync && report.migrated.length > 0) {
    copyPristineProfileFile(webDir, profileDir, PROFILE_PATCH_FILENAME, PROFILE_PATCH_TEMPLATE, report.migrated, report)
    copyPristineProfileFile(webDir, profileDir, PROFILE_WORKSPACE_FILENAME, PROFILE_PNPM_WORKSPACE, report.migrated, report)
  }
  const nextMarker: MigrationMarker = {
    from: WEB_PROFILE, migrated: [...migrated], defective: [...defective.values()], removed: [...removed],
  }
  if (JSON.stringify(nextMarker) !== JSON.stringify(marker)) {
    try {
      writeMigrationMarker(markerPath, nextMarker)
    } catch (error) {
      report.skipped.push(`${markerPath}: ${String(error)}`)
    }
  }
}

/**
 * The loader's own message for one entry it failed to import, matched exactly
 * so a message shaped differently is left for the ordinary failure page rather
 * than parsed loosely: `failed to import loader entry <id> (<module>): <why>`.
 */
const LOAD_FAILURE_LINE = /failed to import loader entry \S+ \(([^()]+)\):\s*(.+)/

/**
 * Move the first migrated bundle a failed boot's output blames into the
 * marker's `defective` list, so a retried boot does not carry it back into the
 * loader.
 *
 * Reads {@link MIGRATION_MARKER_FILENAME} straight from disk rather than trust
 * anything carried over from earlier in the same launch: the caller runs this
 * only after the server has already exited, and the marker on disk is the only
 * record left of what this shell migrated.
 * @param home - the Harness home for this launch.
 * @param output - the boot attempt's whole collected stdout and stderr.
 * @returns the quarantined name and the loader's own detail line; undefined
 * when nothing in the output names a plugin this shell migrated, or the
 * profile manifest could not be rewritten.
 */
export function quarantineLoadFailureFromOutput(home: string, output: string): { name: string; detail: string } | undefined {
  const profileDir = profileDirectory(home, DESKTOP_PROFILE)
  const markerPath = join(profileDir, MIGRATION_MARKER_FILENAME)
  const marker = readMigrationMarker(markerPath)
  if (marker === undefined) return undefined
  for (const line of output.split('\n')) {
    const match = LOAD_FAILURE_LINE.exec(line)
    const name = match?.[1]
    const detail = match?.[2]?.trim()
    if (name === undefined || detail === undefined || detail === '' || !marker.migrated.includes(name)) continue
    try {
      dropBundleNames(join(profileDir, 'package.json'), [name])
    } catch {
      // The manifest could not be rewritten; retrying would carry the same
      // name into the loader again, so this boot is not one to retry.
      return undefined
    }
    writeMigrationMarker(markerPath, {
      ...marker,
      migrated: marker.migrated.filter(existing => existing !== name),
      defective: [...marker.defective, { name, kind: 'load-failed', detail, at: Date.now() }],
    })
    return { name, detail }
  }
  return undefined
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
  for (const line of report.disabled) parts.push(`disabled migrated ${line}`)
  for (const line of report.removed) parts.push(`removed ${line}`)
  for (const line of report.dropped) parts.push(`dropped migrated ${line}`)
  for (const line of report.skipped) parts.push(`skipped ${line}`)
  for (const line of report.shadowed) parts.push(`warning: ${line}`)
  if (parts.length === 0) return undefined
  return `[desktop] profile ${DESKTOP_PROFILE}: ${parts.join('; ')}\n`
}
