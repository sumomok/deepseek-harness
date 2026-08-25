/**
 * Seeding the desktop profile: what the shell writes on a fresh home, that it
 * writes the same three files `initProfile` writes, what it appends to a
 * profile it finds, what it brings over from the `web` profile once and takes
 * back out when that profile stops holding it, what it takes back out when a
 * built-in is withdrawn, and the profiles it declines to touch.
 * @module
 */

import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { initProfile, PROFILE_PATCH_FILENAME, PROFILE_TEMPLATES, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_WEB_BUNDLES, DESKTOP_PROFILE, describeSeed, MIGRATION_MARKER_FILENAME, resolveHarnessHome, sameLinkTarget,
  seedBuiltinBundles, type SeedReport, WEB_PROFILE, WITHDRAWN_WEB_BUNDLES,
} from '../src/profile-seed.ts'

/** A report of a run that changed nothing, for the cases that name one field at a time. */
function nothingHappened(): SeedReport {
  return {
    seeded: [], linked: [], pruned: [], unlinked: [], migrated: [], copied: [], staleMigrations: [],
    skipped: [], shadowed: [], created: false,
  }
}

let root: string
let home: string
let serverModules: string

/** Stage a shipped closure holding `names` as bundle packages at `version`. */
function shipPlugins(names: readonly string[], version = '1.0.0'): void {
  for (const name of names) {
    const dir = join(serverModules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
    )
  }
}

/** Put a copy of `name` in the profile's own node_modules, as `dsh plugin add` would. */
function installIntoProfile(name: string, version: string): void {
  const dir = join(home, 'profiles', DESKTOP_PROFILE, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } } }),
  )
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

/** Put a bundle package for `name` where the `web` profile's hoisted linker puts one. */
function installIntoWeb(name: string, manifest: Record<string, unknown> = { dsh: { bundle: { patch: './cordis.patch.yml' } } }): void {
  const dir = webPackage(name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', ...manifest }))
}

/**
 * Stage the desktop profile an rc.17-to-rc.22 build left: the manifest that
 * build's seed wrote, its three files, and no migration record.
 */
function desktopProfileFromAnEarlierBuild(): void {
  initProfile(join(home, 'profiles', DESKTOP_PROFILE), [...webTemplate, ...BUILTIN_WEB_BUNDLES])
}

/** The names the migration record holds, or undefined when there is no record. */
function migratedNow(): unknown {
  const path = join(home, 'profiles', DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME)
  if (!existsSync(path)) return undefined
  return (JSON.parse(readFileSync(path, 'utf8')) as { migrated?: unknown }).migrated
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
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-desktop', private: true, dependencies: {} })
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
    const webTemplate = PROFILE_TEMPLATES['web'] ?? []
    expect(webTemplate).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
    seedBuiltinBundles({ home, serverModules })
    const upstream = join(root, 'upstream', DESKTOP_PROFILE)
    initProfile(upstream, [...webTemplate, ...BUILTIN_WEB_BUNDLES])
    const seeded = join(home, 'profiles', DESKTOP_PROFILE)
    for (const name of ['package.json', PROFILE_PATCH_FILENAME, 'pnpm-workspace.yaml']) {
      expect(readFileSync(join(seeded, name), 'utf8')).toBe(readFileSync(join(upstream, name), 'utf8'))
    }
  })
})

describe('seedBuiltinBundles on an initialized profile', () => {
  it('appends only the missing names, after everything already listed', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop',
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
    // The rc.17 desktop profile, and the state every machine that installed it
    // is in: the manifest names the built-ins of its own build, and its patch
    // layer is whatever its owner has written there since.
    const shippedThen = ['dsh-at-file', 'dsh-better-sidebar', '@haoran/dsh-screenshot']
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...shippedThen] } },
    }, undefined, 2))
    const patch = join(home, 'profiles', DESKTOP_PROFILE, PROFILE_PATCH_FILENAME)
    const written = '# mine\n- id: better-sidebar\n  disabled: true\n'
    writeFileSync(patch, written)

    const report = seedBuiltinBundles({ home, serverModules })

    expect(report.seeded).toEqual(BUILTIN_WEB_BUNDLES.filter(name => !shippedThen.includes(name)))
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...shippedThen, ...report.seeded])
    // The patch layer is the user's own file; a new built-in never edits it.
    expect(readFileSync(patch, 'utf8')).toBe(written)
  })

  it('carries dependencies and unknown fields through untouched', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop',
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
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }, undefined, 2))
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
    await rm(join(serverModules, 'dsh-better-sidebar'), { recursive: true, force: true })
    const shipped = BUILTIN_WEB_BUNDLES.filter(name => name !== 'dsh-better-sidebar')
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

describe('seedBuiltinBundles on a built-in this build withdrew', () => {
  const gone = WITHDRAWN_WEB_BUNDLES[0]!
  /** The flat-fallback link an earlier launch of this shell made for it. */
  const linkPath = (): string => join(home, 'profiles', 'node_modules', gone)

  /** The profile an earlier build left: the withdrawn name listed, and its link into that build's closure. */
  function profileFromTheBuildThatShippedIt(target: string): void {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...BUILTIN_WEB_BUNDLES, gone] } },
    }, undefined, 2))
    mkdirSync(join(home, 'profiles', 'node_modules', gone, '..'), { recursive: true })
    symlinkSync(target, linkPath(), 'junction')
  }

  it('names one, so every path below is exercised for real', () => {
    expect(WITHDRAWN_WEB_BUNDLES.length).toBeGreaterThan(0)
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
    // `dsh plugin --profile desktop add` puts the package under the profile's
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
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }, undefined, 2))
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
    const withdrawn = WITHDRAWN_WEB_BUNDLES[0]!
    writeWebProfile(['dsh-at-file', withdrawn, userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([userPlugin])
    expect(report.skipped.join('\n')).not.toContain('@deepseek-ai/dsh-base')
    expect(report.skipped.join('\n')).not.toContain('@deepseek-ai/dsh-web-app')
    expect(report.skipped).toContain('dsh-at-file: covered by built-in')
    expect(report.skipped).toContain(`${withdrawn}: withdrawn, not migrated`)
    expect(bundlesNow()).not.toContain(withdrawn)
  })

  it('leaves a name the desktop profile already lists to whoever put it there', () => {
    writeWebProfile([userPlugin])
    writeProfile(JSON.stringify({
      name: 'dsh-profile-desktop',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...webTemplate, userPlugin] } },
    }, undefined, 2))
    installIntoProfile(userPlugin, '9.9.9')
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped).toContain(`${userPlugin}: already in the desktop profile`)
    expect((bundlesNow() as string[]).filter(name => name === userPlugin)).toEqual([userPlugin])
    expect(migratedNow()).toEqual([])
  })

  it('records the run and says nothing on a home that has no web profile', () => {
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped).toEqual([])
    expect(migratedNow()).toEqual([])
    expect(describeSeed(report)).not.toContain('web profile')
  })

  it('records the run and says nothing when the web profile carries only the template', () => {
    // Every web profile lists the two in-box bundles, and a line saying they
    // were passed over would be on the first launch of every install.
    writeWebProfile([])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.copied).toEqual([])
    expect(report.skipped).toEqual([])
    expect(migratedNow()).toEqual([])
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
      name: 'dsh-profile-desktop',
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
    const mine = '# mine\n- id: better-sidebar\n  disabled: true\n'
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
    expect(migratedNow()).toEqual([])
  })

  it('does not name a package that is no bundle at all', () => {
    // `loadProfile` throws on a listed name whose package declares no
    // `dsh.bundle`, exactly as it throws on one it cannot resolve.
    writeWebProfile([userPlugin], { install: [] })
    installIntoWeb(userPlugin, {})
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.migrated).toEqual([])
    expect(report.skipped.join('\n')).toContain('declares no dsh.bundle')
    expect(bundlesNow()).not.toContain(userPlugin)
  })

  it('migrates nothing into a hand-composed manifest that lists no bundles', () => {
    writeWebProfile([userPlugin])
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-desktop', dependencies: {} }, undefined, 2))
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
    expect(report.staleMigrations).toEqual([`${userPlugin}: no longer resolves in the web profile`])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES])
    expect(lstatSync(migratedLink(userPlugin), { throwIfNoEntry: false })).toBeUndefined()
    expect(migratedNow()).toEqual([])
    expect(describeSeed(report)).toContain(`dropped migrated ${userPlugin}: no longer resolves in the web profile`)
  })

  it('keeps the profile bootable when the web profile is deleted wholesale', () => {
    // The link points into a directory this shell does not own, and
    // `loadProfile` ends the boot on one entry it cannot resolve.
    migrated()
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.staleMigrations).toEqual([`${userPlugin}: no longer resolves in the web profile`])
    expect(unresolvableBundles()).toEqual([])
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
    expect(report.staleMigrations).toEqual([])
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('leaves a link its owner re-pointed at a checkout of their own', () => {
    migrated()
    const checkout = join(root, 'checkout', userPlugin)
    mkdirSync(checkout, { recursive: true })
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({
      name: userPlugin, version: '4.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    unlinkSync(migratedLink(userPlugin))
    symlinkSync(checkout, migratedLink(userPlugin), 'junction')
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.staleMigrations).toEqual([])
    expect(readlinkSync(migratedLink(userPlugin))).toBe(checkout)
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('leaves a migrated name this build started shipping itself', () => {
    migrated()
    rmSync(join(home, 'profiles', WEB_PROFILE), { recursive: true, force: true })
    shipPlugins([userPlugin])
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.staleMigrations).toEqual([])
    expect(bundlesNow()).toContain(userPlugin)
  })

  it('drops a migrated name whose installed version stopped being a bundle', () => {
    // Updating the package in the web profile can replace it with one that
    // declares no `dsh.bundle`. It still resolves, so resolution alone says
    // nothing is wrong, and `loadProfile` still ends the boot over it — and a
    // `dsh plugin --profile web` reconcile repairs the web manifest, never this
    // one.
    migrated()
    installIntoWeb(userPlugin, {})
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.staleMigrations).toEqual([`${userPlugin}: its installed version no longer declares dsh.bundle`])
    expect(bundlesNow()).toEqual([...webTemplate, ...BUILTIN_WEB_BUNDLES])
    expect(lstatSync(migratedLink(userPlugin), { throwIfNoEntry: false })).toBeUndefined()
    expect(migratedNow()).toEqual([])
    expect(unresolvableBundles()).toEqual([])
    expect(describeSeed(report)).toContain(
      `dropped migrated ${userPlugin}: its installed version no longer declares dsh.bundle`,
    )
  })

  it('does not bring one back when the bundle version returns', () => {
    // The record is what makes the migration a one-time move, so a name it has
    // dropped is one the user adds back themselves.
    migrated()
    installIntoWeb(userPlugin, {})
    seedBuiltinBundles({ home, serverModules })
    installIntoWeb(userPlugin)
    const again = seedBuiltinBundles({ home, serverModules })
    expect(again).toEqual(nothingHappened())
    expect(bundlesNow()).not.toContain(userPlugin)
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
    expect(line).toBe('[desktop] profile desktop: created with built-in bundles dsh-at-file; linked dsh-at-file\n')
  })

  it('carries every skip reason', () => {
    const line = describeSeed({ ...nothingHappened(), skipped: ['a: why', 'b: why'] })
    expect(line).toBe('[desktop] profile desktop: skipped a: why; skipped b: why\n')
  })

  it('names what it migrated and what it copied out of the web profile', () => {
    const line = describeSeed({ ...nothingHappened(), migrated: ['dsh-hello-world', '@x/b'], copied: ['cordis.patch.yml'] })
    expect(line).toBe(
      '[desktop] profile desktop: migrated dsh-hello-world, @x/b from the web profile; '
      + 'copied cordis.patch.yml from the web profile\n',
    )
  })

  it('gives each migration it took back out its own reason', () => {
    const line = describeSeed({ ...nothingHappened(), staleMigrations: [
      'dsh-hello-world: no longer resolves in the web profile',
      '@x/b: its installed version no longer declares dsh.bundle',
    ] })
    expect(line).toBe(
      '[desktop] profile desktop: dropped migrated dsh-hello-world: no longer resolves in the web profile; '
      + 'dropped migrated @x/b: its installed version no longer declares dsh.bundle\n',
    )
  })

  it('names a withdrawn built-in it dropped and unlinked', () => {
    const line = describeSeed({ ...nothingHappened(), pruned: ['@x/gone'], unlinked: ['@x/gone'] })
    expect(line).toBe('[desktop] profile desktop: dropped withdrawn built-in @x/gone; unlinked @x/gone\n')
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
    installIntoProfile('dsh-better-sidebar', '1.0.0')
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
