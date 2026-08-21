/**
 * Put the plugins the installer ships beside the server closure into the web
 * profile, before the embedded `dsh web` server reads it.
 *
 * The desktop payload carries `dsh-at-file` and `dsh-better-sidebar` inside
 * `resources/server/node_modules` (declared by `apps/desktop-server`), but a
 * profile is user data: `initProfile` writes `$DSH_HOME/profiles/web/` once
 * from the shipped template and never touches an existing file again, and the
 * template names only the two in-box bundles. So nothing in the server would
 * ever mount them. This module supplies the two facts the boot needs and
 * nothing else:
 *
 * - the profile manifest's `dsh.profile.bundles` list carries both names, so
 *   `loadProfile` applies their `cordis.patch.yml` layers;
 * - `$DSH_HOME/profiles/node_modules/<name>` links to the payload directory,
 *   so the Loader — which resolves a plugin specifier against the profile
 *   directory as `baseUrl` — finds the package on the ordinary parent walk.
 *   `healProfilesModuleFallback` maintains that same directory for the CLI
 *   app's own dependency closure and leaves names outside it alone, so these
 *   two links survive every boot.
 *
 * Both writes are idempotent and additive. A name already listed is not added
 * twice, a correct link is left as it is, and no existing bundle entry,
 * dependency, or other manifest field is ever removed or rewritten. Nothing
 * here is fatal: the seed reports what it could not do and the launch
 * continues, because a shell that refuses to start over a profile it does not
 * recognize is worse than one whose sidebar is missing.
 *
 * Removing a seeded plugin for good is a profile-level decision, not a shell
 * one: disable its row in `$DSH_HOME/profiles/web/cordis.patch.yml`. Deleting
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
 */
export const BUILTIN_WEB_BUNDLES: readonly string[] = ['dsh-at-file', 'dsh-better-sidebar']

/** The profile the desktop shell boots (`dsh web` is `--profile web`). */
const WEB_PROFILE = 'web'

/** Directory under the Harness home holding every profile (`PROFILES_DIR` in dsh-app-boot). */
const PROFILES_DIR = 'profiles'

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
  /** True when the run created the profile manifest rather than editing one. */
  created: boolean
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

/**
 * The manifest `initProfile` writes for a fresh `web` profile. Kept byte-identical
 * in structure to `initProfile` (`packages/boot/app-boot/src/profile.ts`) so a
 * profile seeded here and one the server initialized are the same file; the rest
 * of the directory (`cordis.patch.yml`, `pnpm-workspace.yaml`) is left to the
 * server, which writes it on the same boot.
 */
function templateManifest(bundles: readonly string[]): ProfileManifest {
  return {
    name: `dsh-profile-${WEB_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }
}

/** The shipped template's own bundle list (`PROFILE_TEMPLATES.web` in dsh-app-boot). */
const WEB_TEMPLATE_BUNDLES: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

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
    if (readlinkSync(link) === target) return false
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
 * Make the shipped built-in plugins part of the web profile.
 *
 * Runs before the server starts, so the profile the server reads already names
 * them. Returns what changed instead of throwing: every failure mode here —
 * an unparsable manifest, a plugin missing from the payload, a profile
 * directory that cannot be written — leaves a usable app without the built-in
 * plugins, which is the outcome to prefer over a shell that will not launch.
 * @param spec - the Harness home, the shipped closure, and the names to seed.
 * @returns what was seeded, linked, and skipped.
 */
export function seedBuiltinBundles(spec: SeedSpec): SeedReport {
  const report: SeedReport = { seeded: [], linked: [], skipped: [], created: false }
  const bundles = spec.bundles ?? BUILTIN_WEB_BUNDLES
  const available: string[] = []
  for (const name of bundles) {
    const dir = join(spec.serverModules, name)
    if (existsSync(join(dir, 'package.json'))) available.push(name)
    else report.skipped.push(`${name}: not in the shipped server closure (${dir})`)
  }
  if (available.length === 0) return report

  const profileDir = join(spec.home, PROFILES_DIR, WEB_PROFILE)
  const manifestPath = join(profileDir, 'package.json')
  try {
    if (existsSync(manifestPath)) seedExistingManifest(manifestPath, available, report)
    else {
      mkdirSync(profileDir, { recursive: true })
      writeAtomic(manifestPath, `${JSON.stringify(templateManifest([...WEB_TEMPLATE_BUNDLES, ...available]), undefined, 2)}\n`)
      report.created = true
      report.seeded.push(...available)
    }
  } catch (error) {
    report.skipped.push(`${manifestPath}: ${String(error)}`)
    return report
  }

  const modulesDir = join(spec.home, PROFILES_DIR, 'node_modules')
  for (const name of available) {
    try {
      if (ensureLink(join(modulesDir, name), join(spec.serverModules, name))) report.linked.push(name)
    } catch (error) {
      report.skipped.push(`${join(modulesDir, name)}: ${String(error)}`)
    }
  }
  return report
}

/**
 * Append the missing names to an existing manifest's bundle list. A manifest
 * that does not parse, or that declares no bundle list at all, is left exactly
 * as it is: the first is something the server reports with the diagnostic it
 * owns, and the second is a composition written by hand, where appending two
 * names would produce a profile that mounts the built-in plugins and nothing
 * else.
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
  if (report.seeded.length > 0) {
    parts.push(`${report.created ? 'created with' : 'seeded'} built-in bundles ${report.seeded.join(', ')}`)
  }
  if (report.linked.length > 0) parts.push(`linked ${report.linked.join(', ')}`)
  for (const line of report.skipped) parts.push(`skipped ${line}`)
  if (parts.length === 0) return undefined
  return `[desktop] profile ${WEB_PROFILE}: ${parts.join('; ')}\n`
}
