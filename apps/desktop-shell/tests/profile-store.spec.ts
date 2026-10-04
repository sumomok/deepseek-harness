/**
 * Pinning each profile's pnpm store from the store its `node_modules` records:
 * the written setting and the bytes kept around it, Windows store paths, the
 * profiles and files left alone, and the plugin manager's build approval
 * keeping the setting. Homes are temporary directories with recorded
 * `.modules.yaml` files; no pnpm runs here.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { approveBuilds } from '@deepseek-ai/dsh-plugin-manager/src/build-approval.ts'
import { pinProfileStores, storeSetting } from '../src/profile-store.ts'

let home: string

beforeEach(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-profile-store-')))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

const posixOnly = process.platform === 'win32' ? it.skip : it

/** The settings file `initProfile` writes. */
const TEMPLATE = 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n'

/** A store path as pnpm 11 records it on this machine's file system. */
const STORE = '/Users/me/Library/pnpm/store/v11'

/**
 * Write a profile directory.
 * @param name - the directory name under `profiles`.
 * @param files - the `.modules.yaml` record (`undefined` for no `node_modules`) and the settings text (`undefined` for no file).
 * @returns the profile directory.
 */
function profile(name: string, files: { modules?: string | object; workspace?: string }): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  if (files.modules !== undefined) {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    const text = typeof files.modules === 'string' ? files.modules : JSON.stringify(files.modules, undefined, 2)
    writeFileSync(join(dir, 'node_modules', '.modules.yaml'), text)
  }
  if (files.workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), files.workspace)
  return dir
}

/** The settings file of a profile. */
const workspace = (dir: string): string => readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')

const run = (platform: NodeJS.Platform = 'darwin'): ReturnType<typeof pinProfileStores> => pinProfileStores({ home, platform })

describe('storeSetting', () => {
  it('drops a trailing store version, the form pnpm completes with its own', () => {
    expect(storeSetting(STORE, 'darwin')).toBe('/Users/me/Library/pnpm/store')
    expect(storeSetting('/Volumes/Ext/.pnpm-store/v11/', 'darwin')).toBe('/Volumes/Ext/.pnpm-store')
    expect(storeSetting('C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v11', 'win32')).toBe('C:\\Users\\me\\AppData\\Local\\pnpm\\store')
    expect(storeSetting('D:\\.pnpm-store\\v11', 'win32')).toBe('D:\\.pnpm-store')
  })

  it('keeps a path whose last segment is no store version, or whose rest is a root', () => {
    expect(storeSetting('/srv/pnpm-store', 'darwin')).toBe('/srv/pnpm-store')
    expect(storeSetting('/srv/v11-store', 'darwin')).toBe('/srv/v11-store')
    expect(storeSetting('/v11', 'darwin')).toBe('/v11')
    expect(storeSetting('D:\\v11', 'win32')).toBe('D:\\v11')
  })
})

describe('pinProfileStores', () => {
  it('adds the recorded store to the settings, every byte before it kept', () => {
    const dir = profile('desktop-shell', { modules: { layoutVersion: 5, storeDir: STORE, virtualStoreDir: '.pnpm' }, workspace: TEMPLATE })
    expect(run()).toEqual({
      pinned: [`desktop-shell: storeDir /Users/me/Library/pnpm/store (node_modules was linked from ${STORE})`], skipped: [],
    })
    expect(workspace(dir)).toBe(`${TEMPLATE}storeDir: /Users/me/Library/pnpm/store\n`)
  })

  it('pins every profile with a recorded store, and repeating the run changes nothing', () => {
    const desktop = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    const web = profile('web', { modules: { storeDir: '/Volumes/Ext/.pnpm-store/v11' }, workspace: TEMPLATE })
    expect(run().pinned).toHaveLength(2)
    const pinned = [workspace(desktop), workspace(web)]
    expect(parse(pinned[1] ?? '')).toMatchObject({ storeDir: '/Volumes/Ext/.pnpm-store' })
    expect(run()).toEqual({ pinned: [], skipped: [] })
    expect([workspace(desktop), workspace(web)]).toEqual(pinned)
  })

  it('writes a Windows store path that reads back unchanged', () => {
    const recorded = 'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v11'
    const dir = profile('desktop-shell', { modules: { storeDir: recorded }, workspace: TEMPLATE })
    expect(run('win32').pinned).toHaveLength(1)
    expect(parse(workspace(dir))).toMatchObject({ storeDir: 'C:\\Users\\me\\AppData\\Local\\pnpm\\store', nodeLinker: 'hoisted' })
  })

  it('keeps comments and the build decisions pnpm wrote', () => {
    const text = `# my settings\n${TEMPLATE}allowBuilds:\n  esbuild: true # needed\n  tiny-d: set this to true or false\n`
    const dir = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: text })
    run()
    expect(workspace(dir)).toBe(`${text}storeDir: /Users/me/Library/pnpm/store\n`)
  })

  it('stays in the settings when the plugin manager approves a pending build', async () => {
    const dir = profile('desktop-shell', {
      modules: { storeDir: STORE }, workspace: `${TEMPLATE}allowBuilds:\n  tiny-d: set this to true or false\n`,
    })
    run()
    await approveBuilds(dir, ['tiny-d'])
    expect(parse(workspace(dir))).toEqual({
      packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, allowBuilds: { 'tiny-d': true },
      storeDir: '/Users/me/Library/pnpm/store',
    })
  })

  it('leaves a store setting alone, and reports one that names another store', () => {
    const same = profile('same', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}storeDir: ${STORE}\n` })
    const kebab = profile('kebab', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}store-dir: /Users/me/Library/pnpm/store\n` })
    const other = profile('other', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}storeDir: /srv/store\n` })
    expect(run()).toEqual({
      pinned: [],
      skipped: [`other: pnpm-workspace.yaml sets storeDir "/srv/store", but node_modules was linked from ${STORE}; left as it is`],
    })
    expect(workspace(same)).toBe(`${TEMPLATE}storeDir: ${STORE}\n`)
    expect(workspace(kebab)).toBe(`${TEMPLATE}store-dir: /Users/me/Library/pnpm/store\n`)
    expect(workspace(other)).toBe(`${TEMPLATE}storeDir: /srv/store\n`)
  })

  it('leaves alone what records no store, the shared fallback, and hidden entries', () => {
    const fresh = profile('fresh', { workspace: TEMPLATE })
    const unrecorded = profile('unrecorded', { modules: { layoutVersion: 5 }, workspace: TEMPLATE })
    const fallback = profile('node_modules', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    const hidden = profile('.trash', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    expect(run()).toEqual({ pinned: [], skipped: [] })
    for (const dir of [fresh, unrecorded, fallback, hidden]) expect(workspace(dir)).toBe(TEMPLATE)
  })

  it('reports a record or settings file it cannot use, and creates no settings file', () => {
    const missing = profile('missing', { modules: { storeDir: STORE } })
    const list = profile('list', { modules: { storeDir: STORE }, workspace: '- a\n' })
    profile('garbled', { modules: '{ storeDir: [', workspace: TEMPLATE })
    profile('relative', { modules: { storeDir: 'store/v11' }, workspace: TEMPLATE })
    const { pinned, skipped } = run()
    expect(pinned).toEqual([])
    expect(skipped).toHaveLength(4)
    expect(skipped[0]).toMatch(/^garbled: node_modules\/\.modules\.yaml is not YAML/)
    expect(skipped.slice(1)).toEqual([
      `list: pnpm-workspace.yaml is not a YAML mapping; the store ${STORE} is not recorded`,
      `missing: no pnpm-workspace.yaml to record the store ${STORE} in; left as it is`,
      'relative: node_modules/.modules.yaml records storeDir "store/v11", which is not an absolute path; left as it is',
    ])
    expect(existsSync(join(missing, 'pnpm-workspace.yaml'))).toBe(false)
    expect(workspace(list)).toBe('- a\n')
  })

  it('answers an empty report for a home without profiles', () => {
    expect(run()).toEqual({ pinned: [], skipped: [] })
  })

  posixOnly('keeps the settings file\'s permission bits', () => {
    const dir = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    chmodSync(join(dir, 'pnpm-workspace.yaml'), 0o600)
    run()
    expect(statSync(join(dir, 'pnpm-workspace.yaml')).mode & 0o777).toBe(0o600)
  })

  posixOnly('goes on to the next profile when one cannot be read', () => {
    const locked = profile('a-locked', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    const open = profile('b-open', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    chmodSync(join(locked, 'pnpm-workspace.yaml'), 0o000)
    try {
      const report = run()
      expect(report.skipped).toHaveLength(1)
      expect(report.skipped[0]).toMatch(/^a-locked: Error: EACCES/)
      expect(report.pinned).toHaveLength(1)
      expect(workspace(open)).toContain('storeDir: /Users/me/Library/pnpm/store')
    } finally {
      chmodSync(join(locked, 'pnpm-workspace.yaml'), 0o644)
    }
  })
})
