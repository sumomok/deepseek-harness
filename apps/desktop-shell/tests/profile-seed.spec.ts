/**
 * Seeding the desktop profile: what the shell writes on a fresh home, that it
 * writes the same three files `initProfile` writes, what it appends to a
 * profile it finds, what it brings over from the `web` profile once and takes
 * back out when that profile stops holding it, what it takes back out when a
 * built-in is withdrawn, and the profiles it declines to touch.
 * @module
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { initProfile, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addBundleName, BUILTIN_WEB_BUNDLES, bundleDefect, DESKTOP_PROFILE, describeSeed, dropBundleNames, ensureLink,
  MIGRATION_MARKER_FILENAME, type MigrationMarker, profileDependencySpec, quarantineLoadFailureFromOutput,
  readMigrationMarker, removeLink, resolveHarnessHome, sameLinkTarget, seedBuiltinBundles, type SeedReport,
  WEB_PROFILE, WITHDRAWN_WEB_BUNDLES, writeMigrationMarker,
} from '../src/profile-seed.ts'

/** A report of a run that changed nothing, for the cases that name one field at a time. */
function nothingHappened(): SeedReport {
  return {
    seeded: [], linked: [], pruned: [], unlinked: [], migrated: [], copied: [], retired: [], disabled: [],
    removed: [], dropped: [], skipped: [], shadowed: [], created: false,
  }
}

let root: string
let home: string
let serverModules: string

/** Stage a shipped closure holding `names` as bundle packages at `version`, each with a built `index.js`. */
function shipPlugins(names: readonly string[], version = '1.0.0'): void {
  for (const name of names) {
    const dir = join(serverModules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
    writeFileSync(join(dir, 'index.js'), '')
  }
}

/** Put a built copy of `name` in the profile's own node_modules, as `dsh plugin add` would. */
function installIntoProfile(name: string, version: string): void {
  const dir = join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
  writeFileSync(join(dir, 'index.js'), '')
}

/** Write a profile manifest verbatim. */
function writeProfile(content: string): string {
  const dir = join(home, 'profiles', DESKTOP_PROFILE)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'package.json')
  writeFileSync(path, content)
  return path
}

/** The parsed profile manifest. */
function readProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, 'package.json'), 'utf8')) as Record<string, unknown>
}

/** Every built-in but `dsh-at-file`, which several cases pre-list or block on its own. */
const withoutAtFile = BUILTIN_WEB_BUNDLES.filter(name => name !== 'dsh-at-file')

/** The bundle list the profile manifest now declares. */
function bundlesNow(): unknown {
  return (readProfile()['dsh'] as { profile?: { bundles?: unknown } }).profile?.bundles
}

/** The two names the shipped `web` template lists, which every web profile carries. */
const webTemplate = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

/** A user plugin name and version this suite installs into the `web` profile. */
const userPlugin = 'dsh-hello-world'

/** The desktop profile's link path for `name`, the one the migration maintains. */
function migratedLink(name: string): string {
  return join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', name)
}

/** Where the `web` profile holds `name`, which is what that link points at. */
function webPackage(name: string): string {
  return join(home, 'profiles', WEB_PROFILE, 'node_modules', name)
}

/**
 * Stage the `web` profile `dsh plugin --profile web add` would leave: the three
 * files `initProfile` writes, `names` listed as bundles after the template's
 * own two and declared as dependencies, and a package behind each of them.
 */
function writeWebProfile(names: readonly string[], options: { install?: readonly string[] } = {}): void {
  const dir = join(home, 'profiles', WEB_PROFILE)
  initProfile(dir, [...webTemplate, ...names])
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  manifest['dependencies'] = Object.fromEntries(names.map(name => [name, '^1.2.3']))
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  for (const name of options.install ?? names) installIntoWeb(name)
}

/**
 * Put a bundle package for `name` where the `web` profile's hoisted linker
 * puts one, with a built `index.js` beside it unless `builtEntry` is false —
 * the shape an unbuilt git install (`src/*.ts`, no `lib/`) leaves it in.
 */
function installIntoWeb(
  name: string, manifest: Record<string, unknown> = { dsh: { bundle: { patch: './cordis.patch.yml' } } },
  builtEntry = true,
): void {
  const dir = webPackage(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', ...manifest }))
  if (builtEntry) writeFileSync(join(dir, 'index.js'), '')
}

/**
 * Stage the desktop profile an rc.17-to-rc.22 build left: the manifest that
 * build's seed wrote, its three files, and no migration record.
 */
function desktopProfileFromAnEarlierBuild(): void {
  initProfile(join(home, 'profiles', DESKTOP_PROFILE), [...webTemplate, ...BUILTIN_WEB_BUNDLES])
}

/** The marker path inside the desktop profile this suite stages. */
function markerPath(): string {
  return join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME)
}

/** The names the migration record holds, or undefined when there is no record. */
function migratedNow(): unknown {
  if (!existsSync(markerPath())) return undefined
  return (JSON.parse(readFileSync(markerPath(), 'utf8')) as { migrated?: unknown }).migrated
}

/** The marker's `defective` list, or undefined when there is no record. */
function defectiveNow(): unknown {
  if (!existsSync(markerPath())) return undefined
  return (JSON.parse(readFileSync(markerPath(), 'utf8')) as { defective?: unknown }).defective
}

/** The marker's `removed` list, or undefined when there is no record. */
function removedNow(): unknown {
  if (!existsSync(markerPath())) return undefined
  return (JSON.parse(readFileSync(markerPath(), 'utf8')) as { removed?: unknown }).removed
}

/**
 * Resolve every name the desktop profile lists the way the server does, so a
 * profile this suite calls bootable is one `loadProfile` would not throw on.
 */
function unresolvableBundles(): string[] {
  // The in-box bundles the real installation always carries beside the payload.
  shipPlugins(webTemplate)
  const installAnchor = join(root, 'server', 'package.json')
  writeFileSync(installAnchor, JSON.stringify({ name: 'dsh' }))
  const profileDir = join(home, 'profiles', DESKTOP_PROFILE)
  return (bundlesNow() as string[]).filter((name) => {
    try {
      resolveBundleDir('dsh', name, installAnchor, profileDir)
      return false
    } catch {
      // The one failure this is about: `loadProfile` throws it and the boot ends.
      return true
    }
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-seed-'))
  home = join(root, 'home')
  serverModules = join(root, 'server', 'node_modules')
  shipPlugins(BUILTIN_WEB_BUNDLES)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('seedBuiltinBundles on a home with no profile', () => {
  it('writes the template manifest with the built-in bundles appended', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.created).toBe(true)
    expect(report.seeded).toEqual([...BUILTIN_WEB_BUNDLES])
    expect(report.skipped).toEqual([])
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUILTIN_WEB_BUNDLES])
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop-shell', private: true, dependencies: {} })
  })

  it('links each built-in into the shared flat fallback the Loader walks to', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.linked).toEqual([...BUILTIN_WEB_BUNDLES])
    for (const name of BUILTIN_WEB_BUNDLES) {
      const link = join(home, 'profiles', 'node_modules', name)
      expect(lstatSync(link).isSymbolicLink()).toBe(true)
      expect(readlinkSync(link)).toBe(join(serverModules, name))
    }
  })

  it('writes the user patch layer and the pnpm settings, which nothing else will', () => {
    seedBuiltinBundles({ home, serverModules })
    const dir = join(home, 'profiles', DESKTOP_PROFILE)
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
  })

  it('writes byte for byte what initProfile writes', () => {
    // The shell reproduces these three templates rather than importing a
    // harness package into an Electron app, so this is the gate that keeps the
    // copy and the original one text. Same directory basename and same layer
    // list, so every byte upstream writes is a byte the seed must write.
    const webTemplate = PROFILE_TEMPLATES['web']
    expect(webTemplate?.bundles).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    expect(webTemplate?.patchReload).toBe('live')
    seedBuiltinBundles({ home, serverModules })
    const upstream = join(root, 'upstream', DESKTOP_PROFILE)
    initProfile(upstream, [...(webTemplate?.bundles ?? []), ...BUILTIN_WEB_BUNDLES], webTemplate?.patchReload)
    const seeded = join(home, 'profiles', DESKTOP_PROFILE)
    for (const name of ['package.json', PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml']) {
      expect(readFileSync(join(seeded, name), 'utf8')).toBe(readFileSync(join(upstream, name), 'utf8'))
    }
  })
})

describe('seedBuiltinBundles on an initialized profile', () => {
  it('appends only the missing names, after everything already listed', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: { 'dsh-at-file': '0.6.5' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file'] } },
    }, undefined, 2))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.created).toBe(false)
    expect(report.seeded).toEqual(withoutAtFile)
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file', ...withoutAtFile])
  })

  it('gives a profile from an earlier build the bundle that build did not ship', () => {
    // A profile from an earlier build, and the state every machine that
    // installed it is in: the manifest names built-ins that build shipped and
    // this one ships too, and its patch layer is whatever its owner has
    // written there since.
    const shippedThen = ['dsh-at-file', '@haoran/dsh-screenshot', '@haoran/dsh-llm-permission-gateway']
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...shippedThen] } },
    }, undefined, 2))
    const patch = join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME)
    const written = '# mine\n- id: at-file\n  disabled: true\n'
    writeFileSync(patch, written)

    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.seeded).toEqual(BUILTIN_WEB_BUNDLES.filter(name => !shippedThen.includes(name)))
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...shippedThen, ...report.seeded])
    // The patch layer is the user's own file; a new built-in never edits it.
    expect(readFileSync(patch, 'utf8')).toBe(written)
  })

  it('carries dependencies and unknown fields through untouched', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: { '@haoran/gateway': 'file:../gateway.tgz' },
      packageManager: 'pnpm@11.7.0',
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'], someday: true } },
    }, undefined, 2))
    seedBuiltinBundles({ home, serverModules })
    const manifest = readProfile()
    expect(manifest['dependencies']).toEqual({ '@haoran/gateway': 'file:../gateway.tgz' })
    expect(manifest['packageManager']).toBe('pnpm@11.7.0')
    expect((manifest['dsh'] as { profile: { someday: boolean } }).profile.someday).toBe(true)
  })

  it('writes nothing when every name is already listed', () => {
    const path = writeProfile(JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...BUILTIN_WEB_BUNDLES] } },
    }, undefined, 2))
    const before = readFileSync(path, 'utf8')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.seeded).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(before)
  })

  it('re-points a link left behind by a moved installation', () => {
    const link = join(home, 'profiles', 'node_modules', 'dsh-at-file')
    mkdirSync(join(home, 'profiles', 'node_modules'), { recursive: true })
    writeFileSync(join(root, 'stale'), '')
    symlinkSync(join(root, 'stale'), link, 'junction')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.linked).toContain('dsh-at-file')
    expect(readlinkSync(link)).toBe(join(serverModules, 'dsh-at-file'))
  })

  it('reports a correct link as unchanged on the second run', () => {
    seedBuiltinBundles({ home, serverModules })
    const again = seedBuiltinBundles({ home, serverModules })
    expect(again).toEqual(nothingHappened())
  })
})

describe('seedBuiltinBundles on a profile it must not rewrite', () => {
  it('leaves an unparsable manifest for the server to report', () => {
    const path = writeProfile('{ "dsh": ')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(path, 'utf8')).toBe('{ "dsh": ')
    expect(report.seeded).toEqual([])
    expect(report.skipped.join('\n')).toContain('unreadable')
  })

  it('leaves a manifest that declares no bundle list alone', () => {
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop-shell', dependencies: {} }, undefined, 2))
    const before = readFileSync(path, 'utf8')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(report.skipped.join('\n')).toContain('declares no dsh.profile.bundles')
  })

  it('reports a real directory sitting where a link belongs, and keeps the other links', () => {
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-at-file'), { recursive: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.linked).toEqual(withoutAtFile)
    expect(report.skipped.join('\n')).toContain('is not a symlink')
  })

  it('does not name a bundle the shipped closure does not hold', async () => {
    await rm(join(serverModules, '@haoran', 'dsh-screenshot'), { recursive: true, force: true })
    const shipped = BUILTIN_WEB_BUNDLES.filter(name => name !== '@haoran/dsh-screenshot')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.seeded).toEqual(shipped)
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...shipped])
    expect(report.skipped.join('\n')).toContain('not in the shipped server closure')
  })

  it('still creates the profile when the closure holds no plugin at all', async () => {
    await rm(join(root, 'server'), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report).toMatchObject({ seeded: [], linked: [], created: true })
    expect(report.skipped).toHaveLength(BUILTIN_WEB_BUNDLES.length)
    // Without the directory the server refuses to boot the profile at all, so
    // the app would be gone rather than short of its plugins.
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  })
})

describe('WITHDRAWN_WEB_BUNDLES', () => {
  it('names at least one bundle, so the cases below run against a real one', () => {
    expect(WITHDRAWN_WEB_BUNDLES.length).toBeGreaterThan(0)
  })
})

describe.each(WITHDRAWN_WEB_BUNDLES)('seedBuiltinBundles on the withdrawn built-in %s', (gone) => {
  /** The flat-fallback link an earlier launch of this shell made for it. */
  const linkPath = (): string => join(home, 'profiles', 'node_modules', gone)

  /** The profile an earlier build left: the withdrawn name listed, and its link into that build's closure. */
  function profileFromTheBuildThatShippedIt(target: string): void {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUILTIN_WEB_BUNDLES, gone] } },
    }, undefined, 2))
    mkdirSync(join(home, 'profiles', 'node_modules', gone, '..'), { recursive: true })
    symlinkSync(target, linkPath(), 'junction')
  }

  it('is no longer a built-in, so every path below is exercised for real', () => {
    expect(BUILTIN_WEB_BUNDLES).not.toContain(gone)
  })

  it('drops the name and the link an upgrade in place would leave dangling', () => {
    // The payload the link pointed into was replaced by this build, which no
    // longer holds the package: the target is gone, and the name the manifest
    // still carries would fail the boot at `resolveBundleDir`.
    profileFromTheBuildThatShippedIt(join(serverModules, gone))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.pruned).toEqual([gone])
    expect(report.unlinked).toEqual([gone])
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUILTIN_WEB_BUNDLES])
    expect(existsSync(linkPath())).toBe(false)
    expect(lstatSync(linkPath(), { throwIfNoEntry: false })).toBeUndefined()
  })

  it('drops a link an installation that moved left pointing at nothing', () => {
    profileFromTheBuildThatShippedIt(join(root, 'an-old-app', 'server', 'node_modules', gone))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.unlinked).toEqual([gone])
    expect(report.pruned).toEqual([gone])
  })

  it('says both in the one line the launch logs', () => {
    profileFromTheBuildThatShippedIt(join(serverModules, gone))
    const line = describeSeed(seedBuiltinBundles({ home, serverModules }))
    expect(line).toContain(`dropped withdrawn built-in ${gone}`)
    expect(line).toContain(`unlinked ${gone}`)
  })

  it('keeps the bundle entry when the profile installed a copy of its own', () => {
    // `dsh plugin --profile desktop-shell add` puts the package under the profile's
    // own node_modules, where `resolveBundleDir` still finds it. The shell's
    // own link goes; the plugin the user installed keeps working.
    profileFromTheBuildThatShippedIt(join(serverModules, gone))
    installIntoProfile(gone, '0.2.1')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.unlinked).toEqual([gone])
    expect(report.pruned).toEqual([])
    expect(bundlesNow()).toContain(gone)
  })

  it('leaves a link into anything but this build\'s closure alone, and keeps the name with it', () => {
    const elsewhere = join(root, 'checkout', gone)
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'package.json'), JSON.stringify({ name: gone, version: '9.9.9' }))
    profileFromTheBuildThatShippedIt(elsewhere)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.unlinked).toEqual([])
    expect(report.pruned).toEqual([])
    expect(readlinkSync(linkPath())).toBe(elsewhere)
    expect(bundlesNow()).toContain(gone)
  })

  it('leaves a real directory where the link belongs, and the name that resolves through it', () => {
    const dir = join(home, 'profiles', 'node_modules', gone)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: gone, version: '0.2.1' }))
    writeProfile(JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', ...BUILTIN_WEB_BUNDLES, gone] } },
    }, undefined, 2))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report).toMatchObject({ pruned: [], unlinked: [] })
    expect(bundlesNow()).toContain(gone)
  })

  it('repairs nothing on a home that never had it', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report).toMatchObject({ pruned: [], unlinked: [] })
  })

  it('leaves it alone while the payload still carries it', () => {
    // The two lists disagreeing is a build error, not a profile to repair: the
    // name still resolves from the installation, so nothing is broken.
    shipPlugins([gone])
    profileFromTheBuildThatShippedIt(join(serverModules, gone))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report).toMatchObject({ pruned: [], unlinked: [] })
    expect(bundlesNow()).toContain(gone)
  })

  it('leaves a hand-composed manifest that lists no bundles alone', () => {
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop-shell', dependencies: {} }, undefined, 2))
    const before = readFileSync(path, 'utf8')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.pruned).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(before)
  })
})

describe('seedBuiltinBundles migrating the web profile', () => {
  it('brings a user plugin across on a home whose desktop profile does not exist yet', () => {
    writeWebProfile([userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.created).toBe(true)
    expect(report.migrated).toEqual([userPlugin])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin])
    expect(readlinkSync(migratedLink(userPlugin))).toBe(webPackage(userPlugin))
    expect(migratedNow()).toEqual([userPlugin])
    expect(describeSeed(report)).toContain(`migrated ${userPlugin} from the web profile`)
  })

  it('migrates into a desktop profile an earlier build already created', () => {
    // The field case every machine upgrading from rc.17 through rc.22 is in:
    // the desktop profile exists and holds the built-ins, nothing has recorded
    // a migration, and the plugins its owner installed are still only in the
    // profile the shell stopped booting.
    desktopProfileFromAnEarlierBuild()
    writeWebProfile([userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.created).toBe(false)
    expect(report.migrated).toEqual([userPlugin])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin])
    expect(unresolvableBundles()).toEqual([])
  })

  it('composes the migrated plugin where the server looks for it', () => {
    // `resolveBundleDir` is what `loadProfile` calls for every name in the
    // list, so a name it answers is a name the boot gets past.
    desktopProfileFromAnEarlierBuild()
    writeWebProfile([userPlugin])
    seedBuiltinBundles({ home, serverModules })
    shipPlugins(webTemplate)
    const installAnchor = join(root, 'server', 'package.json')
    writeFileSync(installAnchor, JSON.stringify({ name: 'dsh' }))
    const resolved = resolveBundleDir('dsh', userPlugin, installAnchor, join(home, 'profiles', DESKTOP_PROFILE))
    expect(readFileSync(join(resolved, 'package.json'), 'utf8')).toContain('"version":"1.2.3"')
  })

  it('runs once, and leaves the launch after it nothing to do', () => {
    writeWebProfile([userPlugin])
    seedBuiltinBundles({ home, serverModules })
    const manifest = join(home, 'profiles', DESKTOP_PROFILE, 'package.json')
    const before = readFileSync(manifest, 'utf8')
    const again = seedBuiltinBundles({ home, serverModules })
    expect(again).toEqual(nothingHappened())
    expect(describeSeed(again)).toBeUndefined()
    expect(readFileSync(manifest, 'utf8')).toBe(before)
  })

  it('passes over the names this build already composes, each with its reason', () => {
    writeWebProfile(['dsh-at-file', ...WITHDRAWN_WEB_BUNDLES, userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([userPlugin])
    expect(report.skipped.join('\n')).not.toContain('@deepseek-ai/dsh-base')
    expect(report.skipped.join('\n')).not.toContain('@deepseek-ai/dsh-web-app')
    expect(report.skipped).toContain('dsh-at-file: covered by built-in')
    for (const withdrawn of WITHDRAWN_WEB_BUNDLES) {
      expect(report.skipped).toContain(`${withdrawn}: withdrawn, not migrated`)
      expect(bundlesNow()).not.toContain(withdrawn)
    }
  })

  it('leaves a name the desktop profile already lists to whoever put it there', () => {
    writeWebProfile([userPlugin])
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...webTemplate, userPlugin] } },
    }, undefined, 2))
    installIntoProfile(userPlugin, '9.9.9')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped).toContain(`${userPlugin}: already in the desktop profile`)
    expect((bundlesNow() as string[]).filter(name => name === userPlugin)).toEqual([userPlugin])
    // Nothing changed for this run to record, so no marker is written at all —
    // an empty marker carries no information a later boot needs.
    expect(migratedNow()).toBeUndefined()
  })

  it('writes no marker and says nothing on a home that has no web profile', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped).toEqual([])
    expect(migratedNow()).toBeUndefined()
    expect(describeSeed(report)).not.toContain('web profile')
  })

  it('writes no marker and says nothing when the web profile carries only the template', () => {
    // Every web profile lists the two in-box bundles, and a line saying they
    // were passed over would be on the first launch of every install.
    writeWebProfile([])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.copied).toEqual([])
    expect(report.skipped).toEqual([])
    expect(migratedNow()).toBeUndefined()
  })

  it('links at the web profile\'s own path rather than at what it resolves to', () => {
    // pnpm may hold the package anywhere and put a link of its own at that
    // path. Pointing past it would pin the desktop to today's copy, where the
    // path keeps answering with whatever the web profile installs next.
    writeWebProfile([userPlugin], { install: [] })
    const store = join(root, 'store', userPlugin)
    mkdirSync(store, { recursive: true })
    writeFileSync(join(store, 'package.json'), JSON.stringify({
      name: userPlugin, version: '1.2.3', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(store, 'index.js'), '')
    mkdirSync(join(home, 'profiles', WEB_PROFILE, 'node_modules'), { recursive: true })
    symlinkSync(store, webPackage(userPlugin), 'junction')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([userPlugin])
    expect(readlinkSync(migratedLink(userPlugin))).toBe(webPackage(userPlugin))
  })

  it('copies the version the web profile declared into the desktop dependencies', () => {
    writeWebProfile([userPlugin])
    seedBuiltinBundles({ home, serverModules })
    expect(readProfile()['dependencies']).toEqual({ [userPlugin]: '^1.2.3' })
  })

  it('leaves a version the desktop profile declares for itself', () => {
    writeWebProfile([userPlugin])
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell',
      private: true,
      dependencies: { [userPlugin]: 'file:../mine.tgz' },
      dsh: { profile: { bundles: [...webTemplate] } },
    }, undefined, 2))
    seedBuiltinBundles({ home, serverModules })
    expect(readProfile()['dependencies']).toEqual({ [userPlugin]: 'file:../mine.tgz' })
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('takes the web patch layer over while the desktop one is still the template', () => {
    writeWebProfile([userPlugin])
    const rows = '# mine\n- id: hello-world\n  config:\n    greeting: !!js/eval "1 + 1"\n'
    writeFileSync(join(home, 'profiles', WEB_PROFILE, PROFILE_PATCH_FILENAME), rows)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.copied).toEqual([PROFILE_PATCH_FILENAME])
    expect(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), 'utf8')).toBe(rows)
    expect(describeSeed(report)).toContain(`copied ${PROFILE_PATCH_FILENAME} from the web profile`)
  })

  it('keeps a desktop patch layer its owner edited, and says what to carry over', () => {
    desktopProfileFromAnEarlierBuild()
    const mine = '# mine\n- id: at-file\n  disabled: true\n'
    writeFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), mine)
    writeWebProfile([userPlugin])
    writeFileSync(join(home, 'profiles', WEB_PROFILE, PROFILE_PATCH_FILENAME), '- id: hello-world\n  disabled: true\n')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), 'utf8')).toBe(mine)
    expect(report.copied).toEqual([])
    expect(describeSeed(report)).toContain(
      `${PROFILE_PATCH_FILENAME}: the desktop copy is already edited; carry the web profile's rows for ${userPlugin} over by hand`,
    )
  })

  it('takes the web pnpm settings over under the same rule', () => {
    writeWebProfile([userPlugin])
    const settings = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nonlyBuiltDependencies:\n  - esbuild\n'
    writeFileSync(join(home, 'profiles', WEB_PROFILE, 'pnpm-workspace.yaml'), settings)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.copied).toEqual(['pnpm-workspace.yaml'])
    expect(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, 'pnpm-workspace.yaml'), 'utf8')).toBe(settings)
  })

  it('copies neither file on a run that migrated nothing', () => {
    writeWebProfile(['dsh-at-file'])
    writeFileSync(join(home, 'profiles', WEB_PROFILE, PROFILE_PATCH_FILENAME), '- id: at-file\n  disabled: true\n')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.copied).toEqual([])
    expect(readFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
  })

  it('migrates a scoped name through the link, the manifest, and the dependencies', () => {
    const scoped = '@acme/dsh-widgets'
    writeWebProfile([scoped])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([scoped])
    expect(lstatSync(join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', '@acme')).isDirectory()).toBe(true)
    expect(lstatSync(migratedLink(scoped)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(migratedLink(scoped))).toBe(webPackage(scoped))
    expect(bundlesNow()).toContain(scoped)
    expect(readProfile()['dependencies']).toEqual({ [scoped]: '^1.2.3' })
  })

  it('does not name a plugin the web profile lists but never installed', () => {
    writeWebProfile([userPlugin], { install: [] })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped.join('\n')).toContain(`${userPlugin}: not installed in the web profile`)
    expect(bundlesNow()).not.toContain(userPlugin)
    expect(lstatSync(migratedLink(userPlugin), { throwIfNoEntry: false })).toBeUndefined()
    expect(migratedNow()).toBeUndefined()
  })

  it('admits a package that is no bundle at all as defective rather than refusing it', () => {
    // `loadProfile` throws on a listed name whose package declares no
    // `dsh.bundle`, exactly as it throws on one it cannot resolve — so this
    // name is linked (inspectable, repairable) and kept out of the bundle
    // list, never silently dropped.
    writeWebProfile([userPlugin], { install: [] })
    installIntoWeb(userPlugin, {})
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.disabled).toEqual([`${userPlugin}: the installed package declares no dsh.bundle, which the server refuses as a bundle layer`])
    expect(bundlesNow()).not.toContain(userPlugin)
    expect(lstatSync(migratedLink(userPlugin)).isSymbolicLink()).toBe(true)
    expect(defectiveNow()).toEqual([{
      name: userPlugin, kind: 'not-a-bundle',
      detail: 'the installed package declares no dsh.bundle, which the server refuses as a bundle layer',
      at: expect.any(Number) as number,
    }])
  })

  it('admits a package with no built entry file as defective, naming the missing candidate', () => {
    // The field case: an unbuilt git install with `src/*.ts` and no `lib/` at
    // all, and no `prepare` script to build it on install.
    writeWebProfile([userPlugin], { install: [] })
    installIntoWeb(userPlugin, { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' }, false)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(bundlesNow()).not.toContain(userPlugin)
    expect(lstatSync(migratedLink(userPlugin)).isSymbolicLink()).toBe(true)
    const entries = defectiveNow() as Array<{ name: string; kind: string; detail: string }>
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ name: userPlugin, kind: 'entry-missing' })
    expect(entries[0]?.detail).toContain('lib/index.js')
    expect(describeSeed(report)).toContain(`disabled migrated ${userPlugin}:`)
  })

  it('migrates nothing into a hand-composed manifest that lists no bundles', () => {
    writeWebProfile([userPlugin])
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop-shell', dependencies: {} }, undefined, 2))
    const before = readFileSync(path, 'utf8')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(migratedNow()).toBeUndefined()
  })
})

describe('seedBuiltinBundles on a migration that stopped resolving', () => {
  /** Migrate one user plugin into a desktop profile an earlier build created. */
  function migrated(): void {
    desktopProfileFromAnEarlierBuild()
    writeWebProfile([userPlugin])
    expect(seedBuiltinBundles({ home, serverModules }).migrated).toEqual([userPlugin])
  }

  it('drops the name and the link when the web profile stopped holding the package', () => {
    migrated()
    rmSync(webPackage(userPlugin), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([`${userPlugin}: no longer resolves in the web profile`])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES])
    expect(lstatSync(migratedLink(userPlugin), { throwIfNoEntry: false })).toBeUndefined()
    expect(migratedNow()).toEqual([])
    expect(defectiveNow()).toEqual([])
    expect(removedNow()).toEqual([])
    expect(describeSeed(report)).toContain(`dropped migrated ${userPlugin}: no longer resolves in the web profile`)
  })

  it('keeps the profile bootable when the web profile is deleted wholesale', () => {
    // The link points into a directory this shell does not own, and
    // `loadProfile` ends the boot on one entry it cannot resolve.
    migrated()
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([`${userPlugin}: no longer resolves in the web profile`])
    expect(unresolvableBundles()).toEqual([])
  })

  it('tombstones a name into `removed` when its desktop link is gone but the web copy is still healthy', () => {
    // The user deleted the desktop-side link (or the migration marker's link)
    // by hand while leaving the plugin installed and working in the web
    // profile: this is a deliberate removal, not a lost package, so it must
    // not come back on its own.
    migrated()
    unlinkSync(migratedLink(userPlugin))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([])
    expect(report.removed).toEqual([
      `${userPlugin}: no longer linked in the desktop profile; still installed in the web profile, so it will not return on its own`,
    ])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES])
    expect(migratedNow()).toEqual([])
    expect(removedNow()).toEqual([userPlugin])
    expect(describeSeed(report)).toContain(`removed ${userPlugin}: no longer linked`)
  })

  it('never re-syncs a tombstoned name on its own, even though the web profile still has it', () => {
    migrated()
    unlinkSync(migratedLink(userPlugin))
    seedBuiltinBundles({ home, serverModules })
    const again = seedBuiltinBundles({ home, serverModules })
    expect(again).toEqual(nothingHappened())
    expect(removedNow()).toEqual([userPlugin])
    expect(bundlesNow()).not.toContain(userPlugin)
  })

  it('repairs once and stays quiet afterwards', () => {
    migrated()
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    seedBuiltinBundles({ home, serverModules })
    expect(seedBuiltinBundles({ home, serverModules })).toEqual(nothingHappened())
  })

  it('leaves a migrated name the profile now holds a copy of', () => {
    migrated()
    unlinkSync(migratedLink(userPlugin))
    installIntoProfile(userPlugin, '3.0.0')
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([])
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('leaves a link its owner re-pointed at a checkout of their own', () => {
    migrated()
    const checkout = join(root, 'checkout', userPlugin)
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({
      name: userPlugin, version: '4.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(checkout, 'index.js'), '')
    unlinkSync(migratedLink(userPlugin))
    symlinkSync(checkout, migratedLink(userPlugin), 'junction')
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([])
    expect(readlinkSync(migratedLink(userPlugin))).toBe(checkout)
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('leaves a migrated name this build started shipping itself', () => {
    migrated()
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    shipPlugins([userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.dropped).toEqual([])
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('self-heals an already-bricked machine: a pre-fix marker that admitted an entry-missing package becomes defective next boot', () => {
    // The exact field case: an earlier build's `bundleDefect` never checked for
    // an entry file, so it linked and listed `@yuxianglin/dsh-bridge-browser`
    // even though only `src/*.ts` was ever committed — package.json present,
    // `dsh.bundle` declared, `main: lib/index.js`, no `lib/` on disk at all —
    // and every boot since has thrown importing it. The desktop manifest and
    // the pre-sync marker both already name it, exactly as that build left them.
    const broken = '@yuxianglin/dsh-bridge-browser'
    writeWebProfile([broken], { install: [] })
    installIntoWeb(broken, { dsh: { bundle: { patch: './cordis.patch.yml' } }, main: 'lib/index.js' }, false)
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop-shell', private: true, dependencies: { [broken]: '^1.0.0' },
      dsh: { profile: { bundles: [...webTemplate, ...BUILTIN_WEB_BUNDLES, broken] } },
    }, undefined, 2))
    mkdirSync(join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', '@yuxianglin'), { recursive: true })
    symlinkSync(webPackage(broken), migratedLink(broken), 'junction')
    writeFileSync(
      join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME),
      JSON.stringify({ from: WEB_PROFILE, migrated: [broken] }),
    )

    const report = seedBuiltinBundles({ home, serverModules })

    // Boot safety: the name that used to end every boot is out of the list.
    expect(bundlesNow()).not.toContain(broken)
    // Inspectable and repairable: the link that resolves it stays.
    expect(lstatSync(migratedLink(broken)).isSymbolicLink()).toBe(true)
    expect(readlinkSync(migratedLink(broken))).toBe(webPackage(broken))
    // The path in the message is the desktop-side link `resolvedBundleDir`
    // resolved through, not the web copy it points at.
    const detail = `the installed package has no built entry file (looked for lib/index.js in ${migratedLink(broken)}); its build script has not been run`
    expect(report.disabled).toEqual([`${broken}: ${detail}`])
    expect(migratedNow()).toEqual([])
    expect(defectiveNow()).toEqual([{ name: broken, kind: 'entry-missing', detail, at: expect.any(Number) as number }])
    expect(unresolvableBundles()).toEqual([])
  })

  it('disables a migrated name whose installed version stopped being a bundle, keeping it visible and repairable', () => {
    // Updating the package in the web profile can replace it with one that
    // declares no `dsh.bundle`. It still resolves, so resolution alone says
    // nothing is wrong, and `loadProfile` still ends the boot over it — and a
    // `dsh plugin --profile web` reconcile repairs the web manifest, never this
    // one. The fix is no longer to drop the name outright: it stays linked and
    // visible as defective, so a person can see it and repair it.
    migrated()
    installIntoWeb(userPlugin, {})
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.disabled).toEqual([`${userPlugin}: the installed package declares no dsh.bundle, which the server refuses as a bundle layer`])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES])
    // The link stays — that is what makes the plugin inspectable and repairable.
    expect(lstatSync(migratedLink(userPlugin)).isSymbolicLink()).toBe(true)
    expect(migratedNow()).toEqual([])
    expect(defectiveNow()).toEqual([{
      name: userPlugin, kind: 'not-a-bundle',
      detail: 'the installed package declares no dsh.bundle, which the server refuses as a bundle layer',
      at: expect.any(Number) as number,
    }])
    expect(unresolvableBundles()).toEqual([])
    expect(describeSeed(report)).toContain(
      `disabled migrated ${userPlugin}: the installed package declares no dsh.bundle`,
    )
  })

  it('does not bring a disabled name back on its own when the bundle version returns', () => {
    // A defective entry is only ever promoted back by the plugin-admin
    // service's own `/recheck` and `/repair` routes — never by a later boot
    // finding it healthy again on its own.
    migrated()
    installIntoWeb(userPlugin, {})
    seedBuiltinBundles({ home, serverModules })
    installIntoWeb(userPlugin)
    const again = seedBuiltinBundles({ home, serverModules })
    expect(again).toEqual(nothingHappened())
    expect(bundlesNow()).not.toContain(userPlugin)
    expect(defectiveNow()).toHaveLength(1)
  })

  it('rebuilds a record deleted by hand from the links it made', () => {
    // Without this the plugin keeps working and nothing would ever take it back
    // out, which is the state the repair above exists to prevent.
    migrated()
    unlinkSync(join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped).not.toContain(`${userPlugin}: already in the desktop profile`)
    expect(migratedNow()).toEqual([userPlugin])
    expect((bundlesNow() as string[]).filter(name => name === userPlugin)).toEqual([userPlugin])
  })
})

describe('seedBuiltinBundles continuous sync', () => {
  it('picks up a plugin added to the web profile after an earlier sync already migrated a different one', () => {
    writeWebProfile([userPlugin])
    seedBuiltinBundles({ home, serverModules })
    const later = 'dsh-added-later'
    const webManifestPath = join(home, 'profiles', WEB_PROFILE, 'package.json')
    const webManifest = JSON.parse(readFileSync(webManifestPath, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
      dependencies: Record<string, string>
    }
    webManifest.dsh.profile.bundles.push(later)
    webManifest.dependencies[later] = '^2.0.0'
    writeFileSync(webManifestPath, JSON.stringify(webManifest, undefined, 2))
    installIntoWeb(later)

    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.migrated).toEqual([later])
    expect(bundlesNow()).toContain(later)
    expect(migratedNow()).toEqual([userPlugin, later])
    expect(readProfile()['dependencies']).toMatchObject({ [later]: '^2.0.0' })
    // The first sync's own copy already happened; a later arrival is not a
    // first sync, so nothing here overwrites the patch layer again.
    expect(report.copied).toEqual([])
  })

  it('upgrades a pre-sync marker that carried only `from` and `migrated`, reading defective and removed as empty', () => {
    // The format every marker before this feature wrote: no `defective` field
    // and no `removed` field at all, not merely empty arrays of them.
    mkdirSync(join(home, 'profiles', DESKTOP_PROFILE), { recursive: true })
    const path = join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME)
    writeFileSync(path, JSON.stringify({ from: WEB_PROFILE, migrated: [userPlugin] }))
    expect(readMigrationMarker(path)).toEqual({ from: WEB_PROFILE, migrated: [userPlugin], defective: [], removed: [] })
  })
})

describe('seedBuiltinBundles retiring the permission rows an earlier build copied into the patch layer', () => {
  /**
   * The two rows verbatim out of `cordis.patch.yml` in
   * `haoran-dsh-llm-permission-gateway-0.1.3.tgz` (commit `1229bc8049`), which
   * is the pairing the hand-written `web` patch layer held and the first sync
   * of a `desktop-shell` profile copied over with the rest of that file.
   */
  const seededRows = [
    '- insert:',
    '    - id: llm-permission-gateway',
    "      name: '@haoran/dsh-llm-permission-gateway'",
    '      config:',
    '        provider: deepseek-official',
    '        model: deepseek-v4-flash',
    '- id: permission',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '      yolo-access:',
    '        sandbox: danger-full-access',
    '        approval: ask',
    '        name: 自动审查',
    '        description: 沙箱完全关闭，文件系统与命令不再有操作系统层面的围墙；改由审查模型逐个判断工具调用，只在它自己拿不准时才弹审批框。安全性取决于模型的判断质量，不再取决于沙箱。必须与 llm-permission-gateway 一起使用。',
  ].join('\n')

  /** The preset table on its own, which is what the gateway row below sits beside. */
  const seededTable = seededRows.slice(seededRows.indexOf('- id: permission'))

  /**
   * The same gateway row as an id-targeted entry rather than an insert, the
   * form a patch layer written against a build that already mounts the plugin
   * takes. Every field is the shipped value.
   */
  const topLevelGateway = [
    '- id: llm-permission-gateway',
    "  name: '@haoran/dsh-llm-permission-gateway'",
    '  config:',
    '    provider: deepseek-official',
    '    model: deepseek-v4-flash',
  ].join('\n')

  /** The comment a reader of that file finds above the preset table. */
  const pairingComment = '# `yolo-access` turns the sandbox off and puts the review model in its place.\n'
    + '# It is only defensible while `llm-permission-gateway` is mounted.'

  /** One row of the owner's own, which every case here expects to survive untouched. */
  const ownRow = '- id: at-file\n  disabled: true'

  /** Stage the desktop profile with `text` as its patch layer and, unless `'none'`, a record beside it. */
  function profileWithPatch(text: string, marker: MigrationMarker | 'none' = {
    from: WEB_PROFILE, migrated: [], defective: [], removed: [],
  }): void {
    desktopProfileFromAnEarlierBuild()
    writeFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), `${text}\n`)
    if (marker !== 'none') writeMigrationMarker(markerPath(), marker)
  }

  /** The desktop profile's patch layer as it stands now. */
  function patchNow(): string {
    return readFileSync(join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME), 'utf8')
  }

  it('removes both rows, keeps everything else, and records the decision', () => {
    profileWithPatch(`${pairingComment}\n${seededRows}\n\n# mine\n${ownRow}`)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual(['the llm-permission-gateway row', 'the permission preset table'])
    expect(patchNow()).toBe(`# mine\n${ownRow}\n`)
    expect(readMigrationMarker(markerPath())?.permissionPatch).toBe('removed')
    expect(describeSeed(report)).toContain(
      `retired the llm-permission-gateway row, the permission preset table from ${PROFILE_PATCH_FILENAME}`,
    )
  })

  it('leaves the empty template behind when those rows were the whole file', () => {
    profileWithPatch(`${pairingComment}\n${seededRows}`)
    seedBuiltinBundles({ home, serverModules })
    const upstream = join(root, 'upstream-empty', DESKTOP_PROFILE)
    initProfile(upstream, ['@deepseek-ai/dsh-base'])
    expect(patchNow()).toBe(readFileSync(join(upstream, PROFILE_PATCH_FILENAME), 'utf8'))
  })

  it('leaves a table its owner has edited exactly as it is, and says why', () => {
    const edited = seededRows.replace('        approval: never', '        approval: ask')
    profileWithPatch(edited)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toBe(`${edited.slice(edited.indexOf('- id: permission'))}\n`)
    expect(report.retired).toEqual(['the llm-permission-gateway row'])
    expect(report.skipped).toContain(
      `${PROFILE_PATCH_FILENAME}: the permission preset table is not the one this shell wrote; left exactly as it is`,
    )
    expect(readMigrationMarker(markerPath())?.permissionPatch).toBe('removed')
  })

  it('matches a table whose fields were written in another order', () => {
    profileWithPatch(seededRows.replace(
      '        sandbox: danger-full-access\n        approval: ask\n        name: 自动审查',
      '        name: 自动审查\n        approval: ask\n        sandbox: danger-full-access',
    ))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual(['the llm-permission-gateway row', 'the permission preset table'])
  })

  it('leaves a gateway row whose judge route its owner has changed', () => {
    profileWithPatch(seededRows.replace('        model: deepseek-v4-flash', '        model: deepseek-v4-pro'))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toContain('deepseek-v4-pro')
    expect(report.skipped).toContain(
      `${PROFILE_PATCH_FILENAME}: the llm-permission-gateway row is not the one this shell wrote; left exactly as it is`,
    )
  })

  it('retires the gateway row in its id-targeted form as well', () => {
    profileWithPatch(`${seededTable}\n${topLevelGateway}`)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual(['the permission preset table', 'the llm-permission-gateway row'])
    expect(report.skipped).toEqual([])
  })

  it('leaves an id-targeted gateway row carrying a route of its owner\'s', () => {
    profileWithPatch(`${seededTable}\n${topLevelGateway.replace('deepseek-v4-flash', 'deepseek-flash')}`)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual(['the permission preset table'])
    expect(patchNow()).toBe(`${topLevelGateway.replace('deepseek-v4-flash', 'deepseek-flash')}\n`)
    expect(report.skipped).toContain(
      `${PROFILE_PATCH_FILENAME}: the llm-permission-gateway row is not the one this shell wrote; left exactly as it is`,
    )
  })

  it('reads an entry that only mentions the name as no row of this shell\'s', () => {
    profileWithPatch('- id: at-file\n  # kept for llm-permission-gateway reasons\n  disabled: true')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual([])
    expect(report.skipped).toEqual([])
    expect(readMigrationMarker(markerPath())?.permissionPatch).toBe('absent')
  })

  it('names the edited row by the id it declares, not by a name inside its own values', () => {
    profileWithPatch(seededTable
      .replace('- id: permission', "- id: 'permission'")
      .replace('        approval: never', '        approval: ask'))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.skipped).toEqual([
      `${PROFILE_PATCH_FILENAME}: the permission preset table is not the one this shell wrote; left exactly as it is`,
    ])
  })

  it('reads the file once: a profile whose record already carries a decision is left alone', () => {
    profileWithPatch(`${pairingComment}\n${seededRows}`, {
      from: WEB_PROFILE, migrated: [], defective: [], removed: [], permissionPatch: 'removed',
    })
    const before = patchNow()
    const report = seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toBe(before)
    expect(report.retired).toEqual([])
    expect(report.skipped).toEqual([])
  })

  it('records nothing on a profile that has never synced, and still takes the rows out', () => {
    profileWithPatch(`${seededRows}\n\n${ownRow}`, 'none')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual(['the llm-permission-gateway row', 'the permission preset table'])
    expect(patchNow()).toBe(`${ownRow}\n`)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('keeps a layer of prose alone readable as the empty array it was', () => {
    profileWithPatch(`${seededRows}\n\n# everything below is off for now`)
    seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toBe('# everything below is off for now\n\n[]\n')
  })

  it('leaves an entry whose meaning needs the loader\'s own schema', () => {
    const tagged = seededRows.replace('        provider: deepseek-official', '        provider: !!js/eval "route()"')
    profileWithPatch(tagged)
    const report = seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toContain('!!js/eval')
    expect(report.retired).toEqual(['the permission preset table'])
  })

  it('decides a patch layer still holding the empty template without parsing it', () => {
    writeWebProfile([userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.retired).toEqual([])
    expect(readMigrationMarker(markerPath())?.permissionPatch).toBe('absent')
  })

  it('leaves one trailing newline when the rows it removed ended the file', () => {
    profileWithPatch(`${ownRow}\n${seededRows}`)
    seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toBe(`${ownRow}\n`)
  })

  it('adds no second top-level node to a layer whose array is written []', () => {
    profileWithPatch(`# my own header\n[]\n${seededRows}`)
    seedBuiltinBundles({ home, serverModules })
    expect(patchNow()).toBe('# my own header\n[]\n')
  })
})

describe('bundleDefect', () => {
  /** A package directory this suite writes a manifest and, optionally, entry files into. */
  function packageDir(): string {
    const dir = join(root, 'pkg')
    mkdirSync(dir, { recursive: true })
    return dir
  }

  it('answers missing for a directory with no package.json', () => {
    expect(bundleDefect(join(root, 'nowhere'))).toBe('missing')
  })

  it('answers not-a-bundle before ever looking for an entry file', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }))
    expect(bundleDefect(dir)).toBe('not-a-bundle')
  })

  it('answers entry-missing for a bundle with no main and no index.js', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dsh: { bundle: {} } }))
    expect(bundleDefect(dir)).toBe('entry-missing')
  })

  it('passes a bundle whose bare index.js exists, with no exports or main declared', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dsh: { bundle: {} } }))
    writeFileSync(join(dir, 'index.js'), '')
    expect(bundleDefect(dir)).toBeUndefined()
  })

  it('reads main when exports is absent', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dsh: { bundle: {} }, main: 'lib/index.js' }))
    expect(bundleDefect(dir)).toBe('entry-missing')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), '')
    expect(bundleDefect(dir)).toBeUndefined()
  })

  it('reads a string exports field as the root entry directly', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', dsh: { bundle: {} }, exports: './lib/index.js' }))
    expect(bundleDefect(dir)).toBe('entry-missing')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'index.js'), '')
    expect(bundleDefect(dir)).toBeUndefined()
  })

  it('reads the "." condition map, one level of nested conditions deep', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x', dsh: { bundle: {} },
      exports: { '.': { import: { default: './lib/esm.js' }, require: './lib/cjs.js' } },
    }))
    expect(bundleDefect(dir)).toBe('entry-missing')
    mkdirSync(join(dir, 'lib'), { recursive: true })
    // Only the require target exists; entry-missing requires every candidate
    // absent, so one present target is enough to pass.
    writeFileSync(join(dir, 'lib', 'cjs.js'), '')
    expect(bundleDefect(dir)).toBeUndefined()
  })

  it('treats a subpath-only exports map as naming no root entry at all', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x', dsh: { bundle: {} }, exports: { './feature': './lib/feature.js' },
    }))
    // No candidate to check at all is still every candidate absent.
    expect(bundleDefect(dir)).toBe('entry-missing')
  })

  it('ignores main entirely once exports is declared', () => {
    const dir = packageDir()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'x', dsh: { bundle: {} }, main: 'index.js', exports: './lib/index.js',
    }))
    writeFileSync(join(dir, 'index.js'), '')
    // main's own target exists, but exports takes over entirely and its own
    // target does not.
    expect(bundleDefect(dir)).toBe('entry-missing')
  })
})

describe('quarantineLoadFailureFromOutput', () => {
  function stage(): { profileDir: string; markerPath: string } {
    const profileDir = join(home, 'profiles', DESKTOP_PROFILE)
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-desktop-shell', private: true, dependencies: {},
      dsh: { profile: { bundles: [...webTemplate, '@yuxianglin/dsh-bridge-browser'] } },
    }, undefined, 2))
    const path = join(profileDir, MIGRATION_MARKER_FILENAME)
    writeMigrationMarker(path, { from: WEB_PROFILE, migrated: ['@yuxianglin/dsh-bridge-browser'], defective: [], removed: [] })
    return { profileDir, markerPath: path }
  }

  /** The verbatim field stderr this mechanism exists for. */
  const fieldStderr = 'failed to apply loader entry include (cordis:include): failed to import loader entry '
    + 'bridge-browser (@yuxianglin/dsh-bridge-browser): Cannot find module '
    + '\'C:\\Users\\field\\.dsh\\profiles\\desktop\\node_modules\\@yuxianglin\\dsh-bridge-browser\\lib\\index.js\' '
    + 'imported from C:\\Users\\field\\.dsh\\profiles\\desktop\\'

  it('quarantines the migrated name the verbatim field error blames', () => {
    const { markerPath: path } = stage()
    const result = quarantineLoadFailureFromOutput(home, fieldStderr)
    expect(result?.name).toBe('@yuxianglin/dsh-bridge-browser')
    expect(result?.detail).toContain('Cannot find module')
    const marker = readMigrationMarker(path)
    expect(marker?.migrated).toEqual([])
    expect(marker?.defective).toEqual([{
      name: '@yuxianglin/dsh-bridge-browser', kind: 'load-failed', detail: result?.detail, at: expect.any(Number) as number,
    }])
  })

  it('drops the quarantined name from dsh.profile.bundles so a retry does not carry it back in', () => {
    const { profileDir } = stage()
    quarantineLoadFailureFromOutput(home, fieldStderr)
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }
    expect(manifest.dsh.profile.bundles).not.toContain('@yuxianglin/dsh-bridge-browser')
  })

  it('ignores a name the output blames that this shell never migrated', () => {
    stage()
    const line = 'failed to import loader entry other (some-other-package): Cannot find module \'x\''
    expect(quarantineLoadFailureFromOutput(home, line)).toBeUndefined()
  })

  it('answers undefined on a profile with no marker at all', () => {
    expect(quarantineLoadFailureFromOutput(home, fieldStderr)).toBeUndefined()
  })

  it('answers undefined when the output names nothing shaped like the loader\'s own message', () => {
    stage()
    expect(quarantineLoadFailureFromOutput(home, 'dsh server exited before its URL line (code 1).\nsome other crash\n')).toBeUndefined()
  })
})

describe('the repair-route primitives profile-seed.ts exports for plugin-admin-service.ts', () => {
  it('profileDependencySpec answers the declared specifier, or undefined for an undeclared name', () => {
    writeWebProfile([userPlugin])
    expect(profileDependencySpec(join(home, 'profiles', WEB_PROFILE), userPlugin)).toBe('^1.2.3')
    expect(profileDependencySpec(join(home, 'profiles', WEB_PROFILE), 'never-installed')).toBeUndefined()
  })

  it('addBundleName appends a name once and copies its declared web version', () => {
    writeWebProfile([userPlugin])
    const profileDir = join(home, 'profiles', DESKTOP_PROFILE)
    seedBuiltinBundles({ home, serverModules }) // creates the desktop profile's manifest and links
    // Not yet listed: this route path is the one `/enable` and `/recheck` use.
    const dropped = dropBundleNames(join(profileDir, 'package.json'), [userPlugin])
    expect(dropped).toEqual([userPlugin])
    expect(bundlesNow()).not.toContain(userPlugin)

    addBundleName(profileDir, home, userPlugin)
    expect((bundlesNow() as string[]).filter(name => name === userPlugin)).toEqual([userPlugin])
    expect(readProfile()['dependencies']).toMatchObject({ [userPlugin]: '^1.2.3' })

    // Already listed: a second call changes nothing.
    const before = readFileSync(join(profileDir, 'package.json'), 'utf8')
    addBundleName(profileDir, home, userPlugin)
    expect(readFileSync(join(profileDir, 'package.json'), 'utf8')).toBe(before)
  })

  it('ensureLink and removeLink round-trip a link this shell owns', () => {
    const link = join(root, 'link-target-test', 'name')
    const target = join(root, 'store', 'name')
    mkdirSync(target, { recursive: true })
    expect(ensureLink(link, target)).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(ensureLink(link, target)).toBe(false)
    removeLink(link)
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined()
    // Removing an already-absent link is a no-op, not a throw.
    expect(() => { removeLink(link) }).not.toThrow()
  })
})

describe('seedBuiltinBundles when the profile cannot be written', () => {
  it('reports the failure rather than throwing at the launch', () => {
    // A file where the profiles directory belongs: mkdir cannot pass it on any
    // platform, which is the one failure the seed reports as a failure.
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'profiles'), '')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.failed).toContain(join(home, 'profiles', DESKTOP_PROFILE))
    expect(report).toMatchObject({ seeded: [], linked: [], created: false })
    expect(describeSeed(report)).toContain('could not initialize the profile')
  })
})

describe('seedBuiltinBundles on a scoped built-in', () => {
  const scoped = '@haoran/dsh-screenshot'

  it('ships one in the built-in list, so every path below is exercised for real', () => {
    expect(BUILTIN_WEB_BUNDLES).toContain(scoped)
  })

  it('creates the scope directory the flat-fallback link needs', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.linked).toContain(scoped)
    const link = join(home, 'profiles', 'node_modules', scoped)
    expect(lstatSync(join(home, 'profiles', 'node_modules', '@haoran')).isDirectory()).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toBe(join(serverModules, scoped))
  })

  it('recognizes its own name in a bundle list rather than appending it twice', () => {
    writeProfile(JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', scoped] } } }, undefined, 2))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.seeded).not.toContain(scoped)
    expect((bundlesNow() as string[]).filter(name => name === scoped)).toEqual([scoped])
  })

  it('reports a shadowing profile copy under its full scoped name', () => {
    installIntoProfile(scoped, '0.0.9')
    expect(seedBuiltinBundles({ home, serverModules }).shadowed).toEqual([
      `profile copy ${scoped}@0.0.9 shadows the shipped 1.0.0 module; patch layer comes from the shipped copy`,
    ])
  })

  it('skips it by name when the closure does not hold it', async () => {
    await rm(join(serverModules, scoped), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.seeded).not.toContain(scoped)
    expect(report.skipped.join('\n')).toContain(`${scoped}: not in the shipped server closure`)
  })
})

describe('resolveHarnessHome', () => {
  it('prefers a set DSH_HOME', () => {
    expect(resolveHarnessHome({ DSH_HOME: root })).toBe(root)
  })

  it('treats a blank DSH_HOME as unset', () => {
    expect(resolveHarnessHome({ DSH_HOME: '   ' })).toBe(resolveHarnessHome({}))
  })

  it('falls back to ~/.dsh', () => {
    expect(resolveHarnessHome({})).toBe(join(homedir(), '.dsh'))
  })

  it('expands a tilde override', () => {
    expect(resolveHarnessHome({ DSH_HOME: '~/harness' })).toBe(join(homedir(), 'harness'))
  })
})

describe('describeSeed', () => {
  it('says nothing when a run changed nothing', () => {
    expect(describeSeed(nothingHappened())).toBeUndefined()
  })

  it('names what was seeded and linked on one line', () => {
    const line = describeSeed({ ...nothingHappened(), seeded: ['dsh-at-file'], linked: ['dsh-at-file'], created: true })
    expect(line).toBe('[desktop] profile desktop-shell: created with built-in bundles dsh-at-file; linked dsh-at-file\n')
  })

  it('carries every skip reason', () => {
    const line = describeSeed({ ...nothingHappened(), skipped: ['a: why', 'b: why'] })
    expect(line).toBe('[desktop] profile desktop-shell: skipped a: why; skipped b: why\n')
  })

  it('names what it migrated and what it copied out of the web profile', () => {
    const line = describeSeed({ ...nothingHappened(), migrated: ['dsh-hello-world', '@x/b'], copied: ['cordis.patch.yml'] })
    expect(line).toBe(
      '[desktop] profile desktop-shell: migrated dsh-hello-world, @x/b from the web profile; '
      + 'copied cordis.patch.yml from the web profile\n',
    )
  })

  it('gives each name it stopped tracking its own reason', () => {
    const line = describeSeed({ ...nothingHappened(), dropped: [
      'dsh-hello-world: no longer resolves in the web profile',
    ] })
    expect(line).toBe('[desktop] profile desktop-shell: dropped migrated dsh-hello-world: no longer resolves in the web profile\n')
  })

  it('gives each name it disabled as defective its own reason', () => {
    const line = describeSeed({ ...nothingHappened(), disabled: [
      '@x/b: the installed package declares no dsh.bundle, which the server refuses as a bundle layer',
    ] })
    expect(line).toBe(
      '[desktop] profile desktop-shell: disabled migrated @x/b: the installed package declares no dsh.bundle, '
      + 'which the server refuses as a bundle layer\n',
    )
  })

  it('names each tombstone it recorded', () => {
    const line = describeSeed({ ...nothingHappened(), removed: [
      'dsh-hello-world: no longer linked in the desktop profile; still installed in the web profile, so it will not return on its own',
    ] })
    expect(line).toBe(
      '[desktop] profile desktop-shell: removed dsh-hello-world: no longer linked in the desktop profile; '
      + 'still installed in the web profile, so it will not return on its own\n',
    )
  })

  it('names a withdrawn built-in it dropped and unlinked', () => {
    const line = describeSeed({ ...nothingHappened(), pruned: ['@x/gone'], unlinked: ['@x/gone'] })
    expect(line).toBe('[desktop] profile desktop-shell: dropped withdrawn built-in @x/gone; unlinked @x/gone\n')
  })
})

describe('sameLinkTarget', () => {
  const target = join('/opt', 'app', 'server', 'node_modules', 'dsh-at-file')
  const linkDir = join('/home', 'me', '.dsh', 'profiles', 'node_modules')

  it('accepts the exact path back', () => {
    expect(sameLinkTarget(target, target, linkDir)).toBe(true)
  })

  it('accepts the extended-length form Windows reads a junction back as', () => {
    expect(sameLinkTarget(`\\\\?\\${target}`, target, linkDir)).toBe(true)
  })

  it('accepts a trailing separator the link was not created with', () => {
    expect(sameLinkTarget(`${target}${sep}`, target, linkDir)).toBe(true)
    expect(sameLinkTarget(`\\\\?\\${target}${sep}`, target, linkDir)).toBe(true)
  })

  it('resolves a relative read against the link directory, not the working directory', () => {
    expect(sameLinkTarget('sibling', join(linkDir, 'sibling'), linkDir)).toBe(true)
  })

  it('rejects a link pointing somewhere else', () => {
    expect(sameLinkTarget(join('/opt', 'other', 'dsh-at-file'), target, linkDir)).toBe(false)
  })
})

describe('seedBuiltinBundles version reporting', () => {
  it('warns when the profile installed another version of a built-in', () => {
    installIntoProfile('dsh-at-file', '0.6.3')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.shadowed).toEqual([
      'profile copy dsh-at-file@0.6.3 shadows the shipped 1.0.0 module; patch layer comes from the shipped copy',
    ])
    expect(describeSeed(report)).toContain('warning: profile copy dsh-at-file@0.6.3 shadows the shipped 1.0.0')
  })

  it('stays quiet when the profile installed the shipped version', () => {
    installIntoProfile('@haoran/dsh-screenshot', '1.0.0')
    expect(seedBuiltinBundles({ home, serverModules }).shadowed).toEqual([])
  })

  it('changes nothing about the profile copy it reports', () => {
    installIntoProfile('dsh-at-file', '0.6.3')
    const installed = join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', 'dsh-at-file', 'package.json')
    const before = readFileSync(installed, 'utf8')
    seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(installed, 'utf8')).toBe(before)
  })

  it('says nothing when the profile copy has no readable manifest', () => {
    const dir = join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', 'dsh-at-file')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ oops')
    expect(seedBuiltinBundles({ home, serverModules }).shadowed).toEqual([])
  })
})

describe('seedBuiltinBundles on a home an earlier build seeded under the old profile name', () => {
  /** Where the profile this shell wrote before upstream reserved `desktop` stood. */
  const legacyDir = (): string => join(home, 'profiles', 'desktop')

  /**
   * Stage the profile an rc.31 client has: this shell's own manifest name, the
   * built-ins that build seeded, one plugin migrated out of the `web` profile
   * with its link, an edited patch layer, and the migration record.
   * @param manifestName - the `name` field to write, for the case where the
   * directory is upstream's rather than this shell's.
   */
  function legacyProfile(manifestName = 'dsh-profile-desktop'): void {
    const dir = legacyDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({
      name: manifestName,
      private: true,
      dependencies: { [userPlugin]: '^1.2.3' },
      dsh: { profile: { bundles: [...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin], patchReload: 'live' } },
    }, undefined, 2)}\n`)
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: at-file\n  disabled: true\n')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\n')
    writeFileSync(join(dir, MIGRATION_MARKER_FILENAME), `${JSON.stringify({
      from: 'web', migrated: [userPlugin], defective: [], removed: [],
    }, undefined, 2)}\n`)
    ensureLink(join(dir, 'node_modules', userPlugin), webPackage(userPlugin))
  }

  it('renames it into place with its patch layer, its record, and its migrated plugin', () => {
    writeWebProfile([userPlugin])
    legacyProfile()
    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.renamedFrom).toBe('desktop')
    expect(existsSync(legacyDir())).toBe(false)
    expect(report.created).toBe(false)
    // The name is rewritten, and it is the one file a rename replaces.
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop-shell', private: true })
    expect(readProfile()['dependencies']).toMatchObject({ [userPlugin]: '^1.2.3' })
    const dir = join(home, 'profiles', DESKTOP_PROFILE)
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toBe('- id: at-file\n  disabled: true\n')
    expect(migratedNow()).toEqual([userPlugin])
    expect(readlinkSync(migratedLink(userPlugin))).toBe(webPackage(userPlugin))
    // The user's own plugin survives beside every built-in this build ships.
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin])
    expect(unresolvableBundles()).toEqual([])
    expect(describeSeed(report)).toContain('renamed the desktop profile into place')
  })

  it('leaves a `desktop` profile upstream\'s own application wrote exactly as it is', () => {
    writeWebProfile([userPlugin])
    legacyProfile('@deepseek-ai/dsh-desktop-runtime')
    const before = readFileSync(join(legacyDir(), 'package.json'), 'utf8')
    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.renamedFrom).toBeUndefined()
    expect(readFileSync(join(legacyDir(), 'package.json'), 'utf8')).toBe(before)
    expect(report.created).toBe(true)
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop-shell' })
    expect(existsSync(join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME))).toBe(true)
    expect(describeSeed(report)).not.toContain('renamed')
  })

  it('renames once: a second launch leaves whatever stands at the old name alone', () => {
    writeWebProfile([userPlugin])
    legacyProfile()
    expect(seedBuiltinBundles({ home, serverModules }).renamedFrom).toBe('desktop')

    // Something at the old path again — a reinstalled older build, or upstream's
    // application — is not this run's to move: the profile it boots is there.
    legacyProfile()
    const second = seedBuiltinBundles({ home, serverModules })
    expect(second.renamedFrom).toBeUndefined()
    expect(existsSync(join(legacyDir(), 'package.json'))).toBe(true)
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop-shell' })
  })

  it('finishes the rewrite for a directory that moved before the name did', () => {
    writeWebProfile([userPlugin])
    legacyProfile()
    // What a run that died between the two writes leaves behind: the directory
    // stands at the new name carrying the old one inside.
    renameSync(legacyDir(), join(home, 'profiles', DESKTOP_PROFILE))
    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.renamedFrom).toBeUndefined()
    expect(report.created).toBe(false)
    expect(report.skipped.some(line => line.includes('name still reads'))).toBe(false)
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop-shell', private: true })
    // The rewrite replaces the name and nothing else the half-done run carried over.
    expect(readProfile()['dependencies']).toMatchObject({ [userPlugin]: '^1.2.3' })
    expect(migratedNow()).toEqual([userPlugin])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin])

    // Idempotent: the name it just wrote is not one it rewrites again.
    const manifest = join(home, 'profiles', DESKTOP_PROFILE, 'package.json')
    const settled = readFileSync(manifest, 'utf8')
    seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(manifest, 'utf8')).toBe(settled)
  })

  it('seeds a fresh profile and keeps the old one when the rename cannot happen', () => {
    writeWebProfile([userPlugin])
    legacyProfile()
    // A directory already at the new path with something in it: rename(2)
    // refuses a non-empty target on every platform this ships to.
    mkdirSync(join(home, 'profiles', DESKTOP_PROFILE, 'node_modules'), { recursive: true })
    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.renamedFrom).toBeUndefined()
    expect(report.failed).toBeUndefined()
    expect(report.skipped.some(line => line.includes(legacyDir()))).toBe(true)
    expect(describeSeed(report)).toContain(`could not be renamed to ${DESKTOP_PROFILE}`)
    // The old profile is left whole, and the launch still has a profile to boot.
    expect(existsSync(join(legacyDir(), MIGRATION_MARKER_FILENAME))).toBe(true)
    expect(report.created).toBe(true)
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES, userPlugin])
  })

  it('reports the failure it always reported when the new path is not a directory at all', () => {
    writeWebProfile([userPlugin])
    legacyProfile()
    writeFileSync(join(home, 'profiles', DESKTOP_PROFILE), '')
    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.renamedFrom).toBeUndefined()
    expect(report.failed).toContain(join(home, 'profiles', DESKTOP_PROFILE))
    expect(existsSync(join(legacyDir(), MIGRATION_MARKER_FILENAME))).toBe(true)
  })
})
