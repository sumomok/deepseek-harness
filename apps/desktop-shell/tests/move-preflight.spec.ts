/**
 * Preflight: every rule the target must pass, the space formula, the
 * file-system readers, the capability probe on the real disk, and gathering
 * the facts for a fixture home.
 * @module
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  cloudRoots, DATA_DIR_NAME, evaluatePreflight, fileSystemOf, gatherPreflightFacts, iCloudSyncsDesktopAndDocuments,
  inspectTarget, isVolumeRootOnDisk, nodePreflightProbes, parseDarwinMounts, PROBE_DRIVE_ENV, probeCapabilities, realPathOf, requiredSpace,
  resolveMoveTarget, SPACE_RESERVE_BYTES, windowsFileSystem, WINDOWS_PATH_BUDGET,
  type PreflightFacts, type PreflightProbes, type PreflightRequest, type TargetState,
} from '../src/move/preflight.ts'
import { buildFixture, scratchDir, type Fixture } from './move-fixture.ts'

let fixture: Fixture | undefined
let scratch: string | undefined

afterEach(async () => {
  if (scratch !== undefined) {
    chmodSync(scratch, 0o700)
    await rm(scratch, { recursive: true, force: true })
  }
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true })
  fixture = undefined
  scratch = undefined
})

const MB = 1024 * 1024

/**
 * Facts for a move from `/Users/p/.dsh` to `/Volumes/Ext/DSH-Data` that passes
 * every rule.
 * @param overrides - fields to change.
 * @returns the facts.
 */
function facts(overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return {
    platform: 'darwin',
    source: '/Users/p/.dsh',
    target: { target: '/Volumes/Ext/DSH-Data', parent: '/Volumes/Ext', preexisting: false },
    targetState: 'absent',
    chosenUnreadable: false,
    parentExists: true,
    realTarget: '/Volumes/Ext/DSH-Data',
    sameVolume: false,
    freeBytes: 10_000 * MB,
    fileSystem: { type: 'apfs', network: false },
    capabilities: { ok: true, caseSensitive: false },
    scan: { bytes: 1000 * MB, allocatedBytes: 1000 * MB, caseCollisions: [], normalizationCollisions: [], longestRelative: 80 },
    forbidden: {
      install: ['/Applications/DSH Desktop.app'],
      userData: '/Users/p/Library/Application Support/@deepseek-ai/dsh-desktop',
      updateCache: '/Users/p/Library/Caches/@deepseek-aidsh-desktop-updater',
      workspaces: ['/Users/p/proj'],
      cloud: ['/Users/p/Library/Mobile Documents'],
    },
    ...overrides,
  }
}

/**
 * Facts for a move from `C:\\Users\\p\\.dsh` on Windows.
 * @param target - the target directory.
 * @param overrides - fields to change.
 * @returns the facts.
 */
function windowsFacts(target: string, overrides: Partial<PreflightFacts> = {}): PreflightFacts {
  return facts({
    platform: 'win32',
    source: 'C:\\Users\\p\\.dsh',
    target: { target, parent: win32.dirname(target), preexisting: false },
    realTarget: target,
    fileSystem: { type: 'ntfs', network: false },
    forbidden: { ...facts().forbidden, install: [], workspaces: [], cloud: [] },
    ...overrides,
  })
}

/**
 * The refusal kinds for a target somewhere else.
 * @param realTarget - where the data would go.
 * @returns the kinds.
 */
function refusedAt(realTarget: string): string[] {
  return evaluatePreflight(facts({ realTarget })).refusals.map(refusal => refusal.kind)
}

describe('evaluatePreflight', () => {
  it('accepts a move that passes every rule and reports what it will copy', () => {
    const result = evaluatePreflight(facts())
    expect(result.ok).toBe(true)
    expect(result.copyBytes).toBe(1000 * MB)
    expect(result.neededBytes).toBe(requiredSpace(1000 * MB))
  })

  it('compares places without regard to letter case on macOS and Windows', () => {
    expect(refusedAt('/USERS/P/.DSH/DSH-Data')).toEqual(['inside-source'])
    expect(refusedAt('/applications/dsh desktop.app/x')).toEqual(['inside-install'])
    expect(refusedAt('/Users/p/library/mobile documents/x')).toEqual(['cloud-synced'])
    expect(evaluatePreflight(facts({ platform: 'linux', realTarget: '/USERS/P/.DSH/x' })).refusals).toEqual([])
  })

  it('reads real paths in the letter case stored on disk', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const typed = fixture.home.replace('src-parent', 'SRC-PARENT')
    if (!existsSync(typed)) return
    expect(nodePreflightProbes(process.platform).realpath(typed)).toBe(fixture.home)
  })

  it('refuses the data directory typed in another case on a case-insensitive disk', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const probes = nodePreflightProbes(process.platform)
    const typed = fixture.home.replace('src-parent', 'SRC-PARENT')
    if (!existsSync(typed)) return
    const gathered = await gatherPreflightFacts(
      { platform: process.platform, source: fixture.home, chosen: typed, forbidden: { install: [], userData: '/x', updateCache: '/y', workspaces: [], cloud: [] } },
      probes,
    )
    expect(evaluatePreflight(gathered).refusals.map(r => r.kind)).toContain('inside-source')
  })

  it('refuses a target inside the source, and one that holds the source', () => {
    expect(refusedAt('/Users/p/.dsh/DSH-Data')).toEqual(['inside-source'])
    expect(refusedAt('/Users/p')).toEqual(['contains-source'])
    expect(refusedAt('/Users/p/.dsh')).toEqual(['inside-source'])
  })

  it('refuses the installation, user data, the update cache, a workspace, and a synced folder', () => {
    expect(refusedAt('/Applications/DSH Desktop.app/Contents/DSH-Data')).toEqual(['inside-install'])
    expect(refusedAt('/Users/p/Library/Application Support/@deepseek-ai/dsh-desktop/DSH-Data')).toEqual(['inside-user-data'])
    expect(refusedAt('/Users/p/Library/Caches/@deepseek-aidsh-desktop-updater/x')).toEqual(['inside-update-cache'])
    expect(evaluatePreflight(facts({ realTarget: '/Users/p/proj/data' })).refusals)
      .toEqual([{ kind: 'inside-workspace', workspace: '/Users/p/proj' }])
    expect(evaluatePreflight(facts({ realTarget: '/Users/p/Library/Mobile Documents/x/DSH-Data' })).refusals)
      .toEqual([{ kind: 'cloud-synced', root: '/Users/p/Library/Mobile Documents' }])
    expect(refusedAt('/Users/p/project-b/DSH-Data')).toEqual([])
  })

  it('refuses a target that is not empty, holds Harness data, or is not a folder', () => {
    const kinds = (targetState: TargetState): string[] => evaluatePreflight(facts({ targetState })).refusals.map(r => r.kind)
    expect(kinds('empty')).toEqual([])
    expect(kinds('not-empty')).toEqual(['not-empty'])
    expect(kinds('harness-data')).toEqual(['harness-data'])
    expect(kinds('not-a-folder')).toEqual(['not-a-folder'])
  })

  it('stops at a missing parent without judging the disk', () => {
    const result = evaluatePreflight(facts({ parentExists: false, freeBytes: 0, fileSystem: undefined }))
    expect(result.refusals).toEqual([{ kind: 'parent-missing' }])
  })

  it('refuses the file systems on the list and network locations', () => {
    expect(evaluatePreflight(facts({ fileSystem: { type: 'exfat', network: false } })).refusals)
      .toEqual([{ kind: 'unsupported-file-system', type: 'exfat' }])
    expect(evaluatePreflight(facts({ fileSystem: { type: 'smbfs', network: true } })).refusals)
      .toEqual([{ kind: 'network-location' }])
    expect(evaluatePreflight(windowsFacts('E:\\DSH-Data', { fileSystem: { type: 'fat32', network: false } })).refusals)
      .toEqual([{ kind: 'unsupported-file-system', type: 'fat32' }])
    expect(evaluatePreflight(windowsFacts('\\\\srv\\share\\DSH-Data', { fileSystem: undefined })).refusals)
      .toEqual([{ kind: 'network-location' }])
  })

  it('tells a permission refusal from a missing capability', () => {
    const denied = evaluatePreflight(facts({ capabilities: { ok: false, failure: { capability: 'write', code: 'EPERM', detail: 'd' } } }))
    expect(denied.refusals).toEqual([{ kind: 'no-permission', detail: 'd' }])
    const noLinks = { capability: 'hard-link' as const, code: 'EPERM', detail: 'd' }
    expect(evaluatePreflight(facts({ capabilities: { ok: false, failure: noLinks } })).refusals)
      .toEqual([{ kind: 'capability-missing', failure: noLinks }])
  })

  it('needs the data plus the margin and the reserve free on another volume, and nothing on the same one', () => {
    expect(requiredSpace(1000)).toBe(1100 + SPACE_RESERVE_BYTES)
    const rounded = facts({ scan: { ...facts().scan, bytes: 10, allocatedBytes: 1000 * MB } })
    expect(evaluatePreflight(rounded).neededBytes).toBe(requiredSpace(1000 * MB))
    const needed = requiredSpace(1000 * MB)
    expect(evaluatePreflight(facts({ freeBytes: needed })).ok).toBe(true)
    expect(evaluatePreflight(facts({ freeBytes: needed - 1 })).refusals).toEqual([{ kind: 'not-enough-space', needed, free: needed - 1 }])
    const same = evaluatePreflight(facts({ sameVolume: true, freeBytes: 0 }))
    expect(same).toMatchObject({ ok: true, copyBytes: 0, neededBytes: 0 })
  })

  it('refuses name clashes a copy would merge, but not on a rename or a case-sensitive target', () => {
    const scan = { bytes: 1, allocatedBytes: 4096, caseCollisions: [['a/B', 'a/b']], normalizationCollisions: [['c/e\u0301', 'c/\u00e9']], longestRelative: 3 }
    expect(evaluatePreflight(facts({ scan })).refusals.map(r => r.kind)).toEqual(['case-collision', 'normalization-collision'])
    expect(evaluatePreflight(facts({ scan, capabilities: { ok: true, caseSensitive: true } })).refusals.map(r => r.kind))
      .toEqual(['normalization-collision'])
    expect(evaluatePreflight(facts({ scan, sameVolume: true })).ok).toBe(true)
  })

  it('warns about long paths on Windows only', () => {
    const scan = { bytes: 1, allocatedBytes: 4096, caseCollisions: [], normalizationCollisions: [], longestRelative: WINDOWS_PATH_BUDGET }
    const windows = windowsFacts('D:\\DSH-Data', { scan })
    const length = 'D:\\DSH-Data'.length + 1 + WINDOWS_PATH_BUDGET
    expect(evaluatePreflight(windows).warnings).toEqual([{ kind: 'long-paths', length, budget: WINDOWS_PATH_BUDGET }])
    expect(evaluatePreflight(windows).ok).toBe(true)
    expect(evaluatePreflight(facts({ scan })).warnings).toEqual([])
  })
})

describe('the target folder', () => {
  const notRoot = (): boolean => false

  it('uses an empty picked folder itself and makes DSH-Data inside any other', () => {
    const states: Record<string, TargetState> = { '/e': 'empty', '/full': 'not-empty', [join('/full', DATA_DIR_NAME)]: 'absent' }
    const inspect = (path: string): TargetState => states[path] ?? 'absent'
    expect(resolveMoveTarget('/e', inspect, notRoot)).toEqual({ target: '/e', parent: '/', preexisting: true })
    expect(resolveMoveTarget('/full', inspect, notRoot)).toEqual({ target: join('/full', DATA_DIR_NAME), parent: '/full', preexisting: false })
  })

  it('never takes the root of a volume as the target itself, even empty', () => {
    const inspect = (path: string): TargetState => path === '/Volumes/USB' ? 'empty' : 'absent'
    const mounted = (path: string): boolean => path === '/Volumes/USB'
    expect(resolveMoveTarget('/Volumes/USB', inspect, mounted))
      .toEqual({ target: join('/Volumes/USB', DATA_DIR_NAME), parent: '/Volumes/USB', preexisting: false })
  })

  it('finds volume roots on disk: a path with no parent, not an ordinary folder', async () => {
    scratch = await scratchDir('dsh-preflight-')
    expect(isVolumeRootOnDisk('/')).toBe(true)
    expect(isVolumeRootOnDisk(scratch)).toBe(false)
    expect(isVolumeRootOnDisk(join(scratch, 'none'))).toBeUndefined()
  })

  it('probes the volume the target folder is on when it is a mount point', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const usb = join(fixture.root, 'usb')
    mkdirSync(usb)
    const real = nodePreflightProbes(process.platform)
    const probed: string[] = []
    const probes: PreflightProbes = {
      ...real,
      isVolumeRoot: path => path === usb,
      device: path => path.startsWith(usb) ? 9 : 1,
      freeBytes: (dir) => {
        probed.push(dir)
        return dir === usb ? 7 : 0
      },
    }
    const gathered = await gatherPreflightFacts(
      { platform: process.platform, source: fixture.home, chosen: usb, forbidden: { install: [], userData: '/x', updateCache: '/y', workspaces: [], cloud: [] } },
      probes,
    )
    expect(gathered.target).toEqual({ target: join(usb, DATA_DIR_NAME), parent: usb, preexisting: false })
    expect(gathered.sameVolume).toBe(false)
    expect(gathered.freeBytes).toBe(7)
    expect(probed).toEqual([usb])
  })

  it('refuses a picked folder whose volume cannot be told, and never takes it as the target itself', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const picked = join(fixture.root, 'picked')
    mkdirSync(picked)
    const probes: PreflightProbes = { ...nodePreflightProbes(process.platform), isVolumeRoot: () => undefined }
    const gathered = await gatherPreflightFacts(
      { platform: process.platform, source: fixture.home, chosen: picked, forbidden: { install: [], userData: '/x', updateCache: '/y', workspaces: [], cloud: [] } },
      probes,
    )
    expect(gathered.target.target).toBe(join(picked, DATA_DIR_NAME))
    expect(evaluatePreflight(gathered).refusals).toContainEqual({ kind: 'folder-unreadable' })
  })

  it('counts a folder holding only a file browser\'s files as empty', async () => {
    scratch = await scratchDir('dsh-preflight-')
    mkdirSync(join(scratch, 'finder'))
    writeFileSync(join(scratch, 'finder', '.DS_Store'), '')
    writeFileSync(join(scratch, 'finder', 'desktop.ini'), '')
    writeFileSync(join(scratch, 'finder', '.localized'), '')
    expect(inspectTarget(join(scratch, 'finder'))).toBe('empty')
  })

  it('reads what is on disk, never following a link', async () => {
    scratch = await scratchDir('dsh-preflight-')
    mkdirSync(join(scratch, 'empty'))
    mkdirSync(join(scratch, 'full'))
    writeFileSync(join(scratch, 'full', 'x'), '')
    mkdirSync(join(scratch, 'data', 'sessions'), { recursive: true })
    mkdirSync(join(scratch, 'data', 'profiles'))
    mkdirSync(join(scratch, 'marked'))
    writeFileSync(join(scratch, 'marked', '.dsh-data-id'), 'x')
    writeFileSync(join(scratch, 'file'), '')
    expect(inspectTarget(join(scratch, 'none'))).toBe('absent')
    expect(inspectTarget(join(scratch, 'empty'))).toBe('empty')
    expect(inspectTarget(join(scratch, 'full'))).toBe('not-empty')
    expect(inspectTarget(join(scratch, 'data'))).toBe('harness-data')
    expect(inspectTarget(join(scratch, 'marked'))).toBe('harness-data')
    expect(inspectTarget(join(scratch, 'file'))).toBe('not-a-folder')
  })

  it('resolves the existing part of a path that does not exist yet', () => {
    const real = (path: string): string => {
      if (path === '/link') return '/real'
      if (path === '/') return '/'
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }
    expect(realPathOf('/link/a/b', real, 'darwin')).toBe('/real/a/b')
    expect(realPathOf('/link', real, 'darwin')).toBe('/real')
  })
})

describe('file-system readers', () => {
  const MOUNTS = [
    '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
    '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect, root data)',
    '/dev/disk5s1 on /Volumes/USB STICK (exfat, local, nodev, nosuid, noowners, noatime, fskit)',
    '//p@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by p)',
  ].join('\n')

  it('parses the macOS mount listing and picks the deepest mount', () => {
    const mounts = parseDarwinMounts(MOUNTS)
    expect(mounts).toHaveLength(4)
    expect(fileSystemOf(mounts, '/Volumes/USB STICK/x')).toEqual({ type: 'exfat', network: false })
    expect(fileSystemOf(mounts, '/Volumes/share/x')).toEqual({ type: 'smbfs', network: true })
    expect(fileSystemOf(mounts, '/System/Volumes/Data/Users/p')).toEqual({ type: 'apfs', network: false })
    expect(fileSystemOf([], '/x')).toBeUndefined()
  })

  it('reads a Windows drive through PowerShell with the drive in the environment', async () => {
    const calls: Array<Record<string, string>> = []
    const run = async (_script: string, env: Record<string, string>): Promise<{ code: number; stdout: string }> => {
      calls.push(env)
      return { code: 0, stdout: '{"format":"exFAT","type":"Removable"}' }
    }
    expect(await windowsFileSystem(run, 'E:\\DSH-Data')).toEqual({ type: 'exfat', network: false })
    expect(calls).toEqual([{ [PROBE_DRIVE_ENV]: 'E:' }])
    const network = async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: '{"format":"NTFS","type":"Network"}' })
    expect(await windowsFileSystem(network, 'Z:\\x')).toEqual({ type: 'ntfs', network: true })
    const broken = async (): Promise<{ code: number; stdout: string }> => ({ code: 0, stdout: 'oops' })
    expect(await windowsFileSystem(broken, 'Z:\\x')).toBeUndefined()
    expect(await windowsFileSystem(broken, '\\\\srv\\share')).toBeUndefined()
  })

  it('names the synced folders per platform', () => {
    expect(cloudRoots({ platform: 'darwin', home: '/Users/p', env: {}, iCloudDesktopAndDocuments: false }))
      .toEqual(['/Users/p/Library/Mobile Documents', '/Users/p/Library/CloudStorage'])
    expect(cloudRoots({ platform: 'darwin', home: '/Users/p', env: {}, iCloudDesktopAndDocuments: true }))
      .toContain('/Users/p/Documents')
    const env = { OneDrive: 'C:\\Users\\p\\OneDrive', OneDriveCommercial: ' ' }
    expect(cloudRoots({ platform: 'win32', home: 'C:\\Users\\p', env, iCloudDesktopAndDocuments: false }))
      .toEqual(['C:\\Users\\p\\OneDrive'])
    expect(iCloudSyncsDesktopAndDocuments('/Users/p', path => path.endsWith('com~apple~CloudDocs/Documents'))).toBe(true)
    expect(iCloudSyncsDesktopAndDocuments('/Users/p', () => false)).toBe(false)
  })
})

describe('probeCapabilities', () => {
  it('passes on a local disk and leaves nothing behind', async () => {
    scratch = await scratchDir('dsh-preflight-')
    const report = probeCapabilities(scratch, process.platform)
    expect(report.ok).toBe(true)
    expect(readdirSync(scratch)).toEqual([])
  })

  it('reports a folder it may not write as a write failure', async () => {
    scratch = await scratchDir('dsh-preflight-')
    if (process.getuid?.() === 0 || process.platform === 'win32') return
    chmodSync(scratch, 0o500)
    const report = probeCapabilities(scratch, process.platform)
    expect(report).toMatchObject({ ok: false, failure: { capability: 'write', code: 'EACCES' } })
  })

  it('reports a folder that does not exist', () => {
    expect(probeCapabilities('/definitely/not/here', process.platform))
      .toMatchObject({ ok: false, failure: { capability: 'write', code: 'ENOENT' } })
  })
})

describe('gatherPreflightFacts', () => {
  const forbidden = { install: [], userData: '/nonexistent/user-data', updateCache: '/nonexistent/cache', workspaces: [], cloud: [] }
  const request = (source: string, chosen: string): PreflightRequest => ({ platform: process.platform, source, chosen, forbidden })

  it('takes an empty picked folder as the target itself', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const gathered = await gatherPreflightFacts(
      { platform: process.platform, source: fixture.home, chosen: fixture.targetParent, forbidden }, nodePreflightProbes(process.platform),
    )
    expect(gathered.target).toEqual({ target: fixture.targetParent, parent: fixture.root, preexisting: true })
    expect(evaluatePreflight(gathered).ok).toBe(true)
  })

  it('reads a fixture home into facts that pass', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    writeFileSync(join(fixture.targetParent, 'other.txt'), '')
    const probes = nodePreflightProbes(process.platform)
    const gathered = await gatherPreflightFacts(request(fixture.home, fixture.targetParent), probes)
    expect(gathered.target).toEqual({ target: join(fixture.targetParent, DATA_DIR_NAME), parent: fixture.targetParent, preexisting: false })
    expect(gathered.sameVolume).toBe(true)
    expect(gathered.scan.bytes).toBeGreaterThan(1000)
    expect(evaluatePreflight(gathered).ok).toBe(true)
  })

  it('sees another volume through the device numbers, and runs no disk probe under a missing parent', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    writeFileSync(join(fixture.targetParent, 'other.txt'), '')
    const real = nodePreflightProbes(process.platform)
    let probed = 0
    const probes: PreflightProbes = {
      ...real,
      device: path => path.startsWith(fixture?.targetParent ?? '') ? 2 : 1,
      capabilities: (dir) => {
        probed += 1
        return real.capabilities(dir)
      },
    }
    const other = await gatherPreflightFacts(request(fixture.home, fixture.targetParent), probes)
    expect(other.sameVolume).toBe(false)
    expect(probed).toBe(1)
    const missing = await gatherPreflightFacts(request(fixture.home, join(fixture.root, 'no', 'such')), probes)
    expect(missing.parentExists).toBe(false)
    expect(probed).toBe(1)
    expect(evaluatePreflight(missing).refusals.map(r => r.kind)).toContain('parent-missing')
  })

  it('refuses the data directory itself as the picked folder', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const gathered = await gatherPreflightFacts(
      { platform: process.platform, source: fixture.home, chosen: fixture.home, forbidden }, nodePreflightProbes(process.platform),
    )
    expect(evaluatePreflight(gathered).refusals.map(r => r.kind)).toContain('inside-source')
  })
})
