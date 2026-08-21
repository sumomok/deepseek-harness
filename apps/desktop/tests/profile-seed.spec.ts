/**
 * Seeding the shipped built-in plugins into the web profile: what the shell
 * writes on a fresh home, what it appends to a profile it finds, and the
 * profiles it declines to touch.
 * @module
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_WEB_BUNDLES, describeSeed, resolveHarnessHome, seedBuiltinBundles,
} from '../src/profile-seed.ts'

let root: string
let home: string
let serverModules: string

/** Stage a shipped closure holding `names` as bundle packages. */
function shipPlugins(names: readonly string[]): void {
  for (const name of names) {
    const dir = join(serverModules, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  }
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
    expect(report.seeded).toEqual(['dsh-better-sidebar'])
    expect(bundlesNow()).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file', 'dsh-better-sidebar',
    ])
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
    expect(again).toEqual({ seeded: [], linked: [], skipped: [], created: false })
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

  it('reports a real directory sitting where a link belongs, and keeps the other link', () => {
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-at-file'), { recursive: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.linked).toEqual(['dsh-better-sidebar'])
    expect(report.skipped.join('\n')).toContain('is not a symlink')
  })

  it('does not name a bundle the shipped closure does not hold', async () => {
    await rm(join(serverModules, 'dsh-better-sidebar'), { recursive: true, force: true })
    const report = seedBuiltinBundles({ home, serverModules })
    expect(report.seeded).toEqual(['dsh-at-file'])
    expect(bundlesNow()).toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-at-file'])
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
    expect(describeSeed({ seeded: [], linked: [], skipped: [], created: false })).toBeUndefined()
  })

  it('names what was seeded and linked on one line', () => {
    const line = describeSeed({ seeded: ['dsh-at-file'], linked: ['dsh-at-file'], skipped: [], created: true })
    expect(line).toBe('[desktop] profile web: created with built-in bundles dsh-at-file; linked dsh-at-file\n')
  })

  it('carries every skip reason', () => {
    const line = describeSeed({ seeded: [], linked: [], skipped: ['a: why', 'b: why'], created: false })
    expect(line).toBe('[desktop] profile web: skipped a: why; skipped b: why\n')
  })
})
