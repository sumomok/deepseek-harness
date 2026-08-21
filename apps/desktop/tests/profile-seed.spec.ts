/**
 * Seeding the shipped built-in plugins into the web profile: what the shell
 * writes on a fresh home, what it appends to a profile it finds, and the
 * profiles it declines to touch.
 * @module
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_WEB_BUNDLES, describeSeed, resolveHarnessHome, sameLinkTarget, seedBuiltinBundles,
} from '../src/profile-seed.ts'

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
  const dir = join(home, 'profiles', 'web', 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
}

/** Write a profile manifest verbatim. */
function writeProfile(content: string): string {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'package.json')
  writeFileSync(path, content)
  return path
}

/** The parsed profile manifest. */
function readProfile(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(home, 'profiles', 'web', 'package.json'), 'utf8')) as Record<string, unknown>
}

/** Every built-in but `dsh-at-file`, which several cases pre-list or block on its own. */
const withoutAtFile = BUILTIN_WEB_BUNDLES.filter(name => name !== 'dsh-at-file')

/** The bundle list the profile manifest now declares. */
function bundlesNow(): unknown {
  return (readProfile()['dsh'] as { profile?: { bundles?: unknown } }).profile?.bundles
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
    expect(readProfile()).toMatchObject({ name: 'dsh-profile-web', private: true, dependencies: {} })
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

  it('leaves the rest of the profile directory to the server', () => {
    seedBuiltinBundles({ home, serverModules })
    expect(existsSync(join(home, 'profiles', 'web', 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(home, 'profiles', 'web', 'pnpm-workspace.yaml'))).toBe(false)
  })
})

describe('seedBuiltinBundles on an initialized profile', () => {
  it('appends only the missing names, after everything already listed', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-web',
      private: true,
      dependencies: { 'dsh-at-file': '0.6.5' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file'] } },
    }, undefined, 2))
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.created).toBe(false)
    expect(report.seeded).toEqual(withoutAtFile)
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file', ...withoutAtFile])
  })

  it('carries dependencies and unknown fields through untouched', () => {
    writeProfile(JSON.stringify({
      name: 'dsh-profile-web',
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
    expect(again).toEqual({ seeded: [], linked: [], skipped: [], shadowed: [], created: false })
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
    const path = writeProfile(JSON.stringify({ name: 'dsh-profile-web', dependencies: {} }, undefined, 2))
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

  it('writes nothing at all when the closure holds neither plugin', async () => {
    await rm(join(root, 'server'), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report).toMatchObject({ seeded: [], linked: [], created: false })
    expect(report.skipped).toHaveLength(BUILTIN_WEB_BUNDLES.length)
    expect(existsSync(join(home, 'profiles'))).toBe(false)
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
    expect(describeSeed({ seeded: [], linked: [], skipped: [], shadowed: [], created: false })).toBeUndefined()
  })

  it('names what was seeded and linked on one line', () => {
    const line = describeSeed({ seeded: ['dsh-at-file'], linked: ['dsh-at-file'], skipped: [], shadowed: [], created: true })
    expect(line).toBe('[desktop] profile web: created with built-in bundles dsh-at-file; linked dsh-at-file\n')
  })

  it('carries every skip reason', () => {
    const line = describeSeed({ seeded: [], linked: [], skipped: ['a: why', 'b: why'], shadowed: [], created: false })
    expect(line).toBe('[desktop] profile web: skipped a: why; skipped b: why\n')
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
    const installed = join(home, 'profiles', 'web', 'node_modules', 'dsh-at-file', 'package.json')
    const before = readFileSync(installed, 'utf8')
    seedBuiltinBundles({ home, serverModules })
    expect(readFileSync(installed, 'utf8')).toBe(before)
  })

  it('says nothing when the profile copy has no readable manifest', () => {
    const dir = join(home, 'profiles', 'web', 'node_modules', 'dsh-at-file')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ oops')
    expect(seedBuiltinBundles({ home, serverModules }).shadowed).toEqual([])
  })
})
