/**
 * Keeping each profile's pnpm records in line with where it is: the store
 * setting written from the store its `node_modules` records, with the
 * settings around it kept, then changed or removed as the record changes; a
 * virtual store recorded at another location; Windows paths; the profiles and
 * files left alone; and the plugin manager's build approval keeping the
 * setting. Homes are temporary directories with recorded `.modules.yaml`
 * files; no pnpm runs here.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { approveBuilds } from '@deepseek-ai/dsh-plugin-manager/src/build-approval.ts'
import { PIN_COMMENT, pinProfileStores, storeSetting } from '../src/profile-store.ts'

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

/** The line a pin of {@link STORE} adds. */
const PIN_LINE = `storeDir: /Users/me/Library/pnpm/store # ${PIN_COMMENT}\n`

/**
 * Write a profile directory.
 * @param name - the directory name under `profiles`.
 * @param files - the `.modules.yaml` record (`undefined` for no `node_modules`) and the settings text (`undefined` for no file).
 * @returns the profile directory.
 */
function profile(name: string, files: { modules?: string | object; workspace?: string }): string {
  const dir = join(home, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  if (files.modules !== undefined) record(dir, files.modules)
  if (files.workspace !== undefined) writeFileSync(join(dir, 'pnpm-workspace.yaml'), files.workspace)
  return dir
}

/**
 * Write a profile's `.modules.yaml`.
 * @param dir - the profile directory.
 * @param modules - the record, as text or as fields pnpm writes as JSON.
 */
function record(dir: string, modules: string | object): void {
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.modules.yaml'), typeof modules === 'string' ? modules : JSON.stringify(modules, undefined, 2))
}

/** The settings file of a profile. */
const workspace = (dir: string): string => readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')

/** The `.modules.yaml` text of a profile. */
const modulesText = (dir: string): string => readFileSync(join(dir, 'node_modules', '.modules.yaml'), 'utf8')

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
  it('adds the recorded store with its comment after the settings already there', () => {
    const dir = profile('desktop-shell', { modules: { layoutVersion: 5, storeDir: STORE, virtualStoreDir: '.pnpm' }, workspace: TEMPLATE })
    expect(run()).toEqual({
      changed: [`desktop-shell: storeDir /Users/me/Library/pnpm/store (node_modules was linked from ${STORE})`], skipped: [],
    })
    expect(workspace(dir)).toBe(`${TEMPLATE}${PIN_LINE}`)
  })

  it('pins every profile with a recorded store, and repeating the run changes nothing', () => {
    const desktop = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    const web = profile('web', { modules: { storeDir: '/Volumes/Ext/.pnpm-store/v11' }, workspace: TEMPLATE })
    expect(run().changed).toHaveLength(2)
    const pinned = [workspace(desktop), workspace(web)]
    expect(parse(pinned[1] ?? '')).toMatchObject({ storeDir: '/Volumes/Ext/.pnpm-store' })
    expect(run()).toEqual({ changed: [], skipped: [] })
    expect([workspace(desktop), workspace(web)]).toEqual(pinned)
  })

  it('writes a Windows store path that reads back unchanged', () => {
    const recorded = 'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v11'
    const dir = profile('desktop-shell', { modules: { storeDir: recorded }, workspace: TEMPLATE })
    expect(run('win32').changed).toHaveLength(1)
    expect(parse(workspace(dir))).toMatchObject({ storeDir: 'C:\\Users\\me\\AppData\\Local\\pnpm\\store', nodeLinker: 'hoisted' })
  })

  it('keeps comments and the build decisions pnpm wrote', () => {
    const text = `# my settings\n${TEMPLATE}allowBuilds:\n  esbuild: true # needed\n  tiny-d: set this to true or false\n`
    const dir = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: text })
    run()
    expect(workspace(dir)).toBe(`${text}${PIN_LINE}`)
  })

  it('stays in the settings, comment included, when the plugin manager approves a pending build', async () => {
    const dir = profile('desktop-shell', {
      modules: { storeDir: STORE }, workspace: `${TEMPLATE}allowBuilds:\n  tiny-d: set this to true or false\n`,
    })
    run()
    await approveBuilds(dir, ['tiny-d'])
    expect(parse(workspace(dir))).toEqual({
      packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, allowBuilds: { 'tiny-d': true },
      storeDir: '/Users/me/Library/pnpm/store',
    })
    expect(workspace(dir)).toContain(PIN_LINE)
    record(dir, { storeDir: '/Volumes/Ext/.pnpm-store/v11' })
    expect(run().changed).toHaveLength(1)
  })

  it('moves a pin it wrote to the store the record names now', () => {
    const dir = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    run()
    record(dir, { storeDir: '/Volumes/Ext/.pnpm-store/v11' })
    expect(run()).toEqual({
      changed: [
        'desktop-shell: storeDir "/Users/me/Library/pnpm/store" changed to /Volumes/Ext/.pnpm-store'
        + ' (node_modules was linked from /Volumes/Ext/.pnpm-store/v11)',
      ],
      skipped: [],
    })
    expect(workspace(dir)).toBe(`${TEMPLATE}storeDir: /Volumes/Ext/.pnpm-store # ${PIN_COMMENT}\n`)
  })

  it('removes a pin it wrote once nothing records a store', async () => {
    const dir = profile('desktop-shell', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    run()
    await rm(join(dir, 'node_modules'), { recursive: true })
    expect(run()).toEqual({
      changed: ['desktop-shell: storeDir "/Users/me/Library/pnpm/store" removed, since nothing installed records a store'], skipped: [],
    })
    expect(workspace(dir)).toBe(TEMPLATE)
    record(dir, { layoutVersion: 5 })
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), `${TEMPLATE}${PIN_LINE}`)
    expect(run().changed).toHaveLength(1)
    expect(workspace(dir)).toBe(TEMPLATE)
  })

  it('leaves a store setting without the comment alone, and reports one that names another store', () => {
    const same = profile('same', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}storeDir: ${STORE}\n` })
    const kebab = profile('kebab', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}store-dir: /Users/me/Library/pnpm/store\n` })
    const other = profile('other', { modules: { storeDir: STORE }, workspace: `${TEMPLATE}storeDir: /srv/store # mine\n` })
    const unrecorded = profile('unrecorded', { workspace: `${TEMPLATE}storeDir: /srv/store\n` })
    expect(run()).toEqual({
      changed: [],
      skipped: [`other: pnpm-workspace.yaml sets storeDir "/srv/store", but node_modules was linked from ${STORE}; left as it is`],
    })
    expect(workspace(same)).toBe(`${TEMPLATE}storeDir: ${STORE}\n`)
    expect(workspace(kebab)).toBe(`${TEMPLATE}store-dir: /Users/me/Library/pnpm/store\n`)
    expect(workspace(other)).toBe(`${TEMPLATE}storeDir: /srv/store # mine\n`)
    expect(workspace(unrecorded)).toBe(`${TEMPLATE}storeDir: /srv/store\n`)
  })

  it('leaves alone what records no store, the shared fallback, and hidden entries', () => {
    const fresh = profile('fresh', { workspace: TEMPLATE })
    const unrecorded = profile('unrecorded', { modules: { layoutVersion: 5 }, workspace: TEMPLATE })
    const fallback = profile('node_modules', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    const hidden = profile('.trash', { modules: { storeDir: STORE }, workspace: TEMPLATE })
    expect(run()).toEqual({ changed: [], skipped: [] })
    for (const dir of [fresh, unrecorded, fallback, hidden]) expect(workspace(dir)).toBe(TEMPLATE)
  })

  it('reports a record or settings file it cannot use, and creates no settings file', () => {
    const missing = profile('missing', { modules: { storeDir: STORE } })
    const list = profile('list', { modules: { storeDir: STORE }, workspace: '- a\n' })
    profile('garbled', { modules: '{ storeDir: [', workspace: TEMPLATE })
    profile('relative', { modules: { storeDir: 'store/v11' }, workspace: TEMPLATE })
    const { changed, skipped } = run()
    expect(changed).toEqual([])
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
    expect(run()).toEqual({ changed: [], skipped: [] })
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
      expect(report.changed).toHaveLength(1)
      expect(workspace(open)).toContain(PIN_LINE)
    } finally {
      chmodSync(join(locked, 'pnpm-workspace.yaml'), 0o644)
    }
  })
})

describe('a virtual store recorded at another location', () => {
  /** A Windows install record as pnpm 11 writes it, with the absolute virtual store of the profile before a move. */
  const WINDOWS_RECORD = {
    layoutVersion: 5,
    nodeLinker: 'hoisted',
    prunedAt: 'Sat, 04 Oct 2026 08:00:00 GMT',
    storeDir: 'C:\\Users\\me\\AppData\\Local\\pnpm\\store\\v11',
    virtualStoreDir: 'C:\\Users\\me\\.dsh\\profiles\\desktop-shell\\node_modules\\.pnpm',
    virtualStoreDirMaxLength: 60,
  }

  it('becomes the relative .pnpm, written as pnpm writes the record, and a repeated run changes nothing', () => {
    const dir = profile('desktop-shell', { modules: WINDOWS_RECORD, workspace: TEMPLATE })
    expect(run('win32').changed).toEqual([
      `desktop-shell: virtualStoreDir ${WINDOWS_RECORD.virtualStoreDir} changed to .pnpm in node_modules/.modules.yaml`,
      `desktop-shell: storeDir C:\\Users\\me\\AppData\\Local\\pnpm\\store (node_modules was linked from ${WINDOWS_RECORD.storeDir})`,
    ])
    expect(modulesText(dir)).toBe(JSON.stringify({ ...WINDOWS_RECORD, virtualStoreDir: '.pnpm' }, undefined, 2))
    const settings = workspace(dir)
    expect(run('win32')).toEqual({ changed: [], skipped: [] })
    expect(modulesText(dir)).toBe(JSON.stringify({ ...WINDOWS_RECORD, virtualStoreDir: '.pnpm' }, undefined, 2))
    expect(workspace(dir)).toBe(settings)
  })

  it('is repaired in a profile that has no settings file', () => {
    const dir = profile('desktop-shell', { modules: WINDOWS_RECORD })
    expect(run('win32').changed).toHaveLength(1)
    expect(parse(modulesText(dir))).toMatchObject({ virtualStoreDir: '.pnpm' })
    expect(existsSync(join(dir, 'pnpm-workspace.yaml'))).toBe(false)
  })

  it('is left alone when it names the profile\'s own node_modules/.pnpm, compared without case on Windows', () => {
    const dir = profile('desktop-shell', { workspace: TEMPLATE })
    record(dir, { ...WINDOWS_RECORD, virtualStoreDir: win32.join(dir.toUpperCase(), 'node_modules', '.pnpm') })
    const before = modulesText(dir)
    expect(run('win32').changed).toHaveLength(1)
    expect(modulesText(dir)).toBe(before)
  })

  it('is repaired on any system when it is absolute, and left alone when relative or not a node_modules/.pnpm', () => {
    const moved = profile('moved', { modules: { storeDir: STORE, virtualStoreDir: '/Volumes/Old/DSH-Data/profiles/moved/node_modules/.pnpm' } })
    const relative = profile('relative', { modules: { storeDir: STORE, virtualStoreDir: '.pnpm' } })
    const own = profile('own', {})
    record(own, { storeDir: STORE, virtualStoreDir: join(own, 'node_modules', '.pnpm') })
    const elsewhere = profile('elsewhere', { modules: { storeDir: STORE, virtualStoreDir: '/srv/virtual-store' } })
    const texts = [modulesText(relative), modulesText(own), modulesText(elsewhere)]
    expect(run().changed).toEqual([
      'moved: virtualStoreDir /Volumes/Old/DSH-Data/profiles/moved/node_modules/.pnpm changed to .pnpm in node_modules/.modules.yaml',
    ])
    expect(parse(modulesText(moved))).toEqual({ storeDir: STORE, virtualStoreDir: '.pnpm' })
    expect([modulesText(relative), modulesText(own), modulesText(elsewhere)]).toEqual(texts)
  })

  it('is left alone, and reported, when the settings name a virtual store', () => {
    const dir = profile('desktop-shell', { modules: WINDOWS_RECORD, workspace: `${TEMPLATE}virtual-store-dir: D:\\vstore\n` })
    const before = modulesText(dir)
    expect(run('win32').skipped).toEqual([
      `desktop-shell: pnpm-workspace.yaml sets virtual-store-dir, so the recorded virtualStoreDir ${WINDOWS_RECORD.virtualStoreDir} is left as it is`,
    ])
    expect(modulesText(dir)).toBe(before)
  })

  posixOnly('keeps the record\'s permission bits', () => {
    const dir = profile('desktop-shell', { modules: WINDOWS_RECORD, workspace: TEMPLATE })
    chmodSync(join(dir, 'node_modules', '.modules.yaml'), 0o600)
    run('win32')
    expect(statSync(join(dir, 'node_modules', '.modules.yaml')).mode & 0o777).toBe(0o600)
  })
})
