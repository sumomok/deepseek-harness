/**
 * The Office engine's facts: which engine the shipped kit requires, where it
 * lives, how the server is pointed at it, what a prune may remove, and how an
 * install ends in every way it can end.
 *
 * Installs run a stand-in package manager — a Node script given its behavior
 * as its first argument — that writes what `pnpm add` would write, prints the
 * reporter records the real one prints (captured from pnpm 11.7.0 installing
 * `@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1`), and exits the way the
 * case asks.
 * @module
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ENGINE_DOWNLOAD_BYTES, ENGINE_MODULES_ENV, engineInstalled, engineModulesDir, engineServerEnv, installEngine,
  officeEngineRoot, officeEngineTarget, pruneEngineRoot, readEngineRequirement, readProgressLine,
  type EngineRequirement, type InstallProgress,
} from '../src/office-engine.ts'

/** The workspace's own desktop server closure, whose kit is the one the payload ships. */
const SERVER_MODULES = fileURLToPath(new URL('../../desktop-server/node_modules', import.meta.url))

const REQUIREMENT: EngineRequirement = {
  target: 'darwin-arm64',
  name: '@deepseek-ai/libreoffice-kit-darwin-arm64',
  version: '0.1.1',
  downloadBytes: 66_711_287,
}

const made: string[] = []

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A fresh temporary directory, removed after the case. */
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/**
 * A hoisted server closure whose kit declares the given engines.
 * @param optionalDependencies - the kit's `optionalDependencies`.
 * @returns the closure's `node_modules`.
 */
function serverTree(optionalDependencies: Record<string, string>): string {
  const modules = join(temp('dsh-engine-tree-'), 'node_modules')
  for (const name of ['@deepseek-ai/dsh', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-office-to-pdf']) {
    mkdirSync(join(modules, name), { recursive: true })
    writeFileSync(join(modules, name, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
  }
  mkdirSync(join(modules, '@deepseek-ai/libreoffice-kit'), { recursive: true })
  writeFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), JSON.stringify({ name: '@deepseek-ai/libreoffice-kit', version: '0.1.1', optionalDependencies }))
  return modules
}

describe('officeEngineTarget', () => {
  it('names the kit target for the macOS and Windows builds', () => {
    expect(officeEngineTarget('darwin', 'arm64')).toBe('darwin-arm64')
    expect(officeEngineTarget('darwin', 'x64')).toBe('darwin-x64')
    expect(officeEngineTarget('win32', 'x64')).toBe('win32-x64')
  })

  it('names none where the kit builds no native engine', () => {
    expect(officeEngineTarget('linux', 'x64')).toBeUndefined()
    expect(officeEngineTarget('win32', 'ia32')).toBeUndefined()
  })
})

describe('readEngineRequirement', () => {
  it('reads the engine name and exact version from the kit, and the size the table knows', () => {
    const modules = serverTree({ '@deepseek-ai/libreoffice-kit-darwin-arm64': '0.1.1', '@deepseek-ai/libreoffice-kit-wasm': '0.1.1' })
    expect(readEngineRequirement(modules, 'darwin', 'arm64')).toEqual({ ok: true, requirement: REQUIREMENT })
  })

  it('follows the kit to a version the size table does not know, and quotes no size', () => {
    const modules = serverTree({ '@deepseek-ai/libreoffice-kit-win32-x64': '0.2.0' })
    expect(readEngineRequirement(modules, 'win32', 'x64')).toEqual({
      ok: true,
      requirement: { target: 'win32-x64', name: '@deepseek-ai/libreoffice-kit-win32-x64', version: '0.2.0' },
    })
  })

  it('refuses a declared version that is not one exact version', () => {
    for (const declared of ['^0.1.1', 'latest', '../0.1.1', 'file:../engine']) {
      const found = readEngineRequirement(serverTree({ '@deepseek-ai/libreoffice-kit-darwin-arm64': declared }), 'darwin', 'arm64')
      expect(found).toEqual({ ok: false, reason: 'the LibreOffice kit declares no exact version of @deepseek-ai/libreoffice-kit-darwin-arm64' })
    }
  })

  it('offers nothing on a host the kit builds no native engine for', () => {
    expect(readEngineRequirement(serverTree({}), 'linux', 'x64')).toEqual({ ok: false, reason: 'no LibreOffice engine is built for linux-x64' })
  })

  // An unreadable manifest rather than a missing package: the test runner's
  // own NODE_PATH reaches the workspace's packages from any directory.
  it('says so when the kit manifest cannot be read', () => {
    const modules = serverTree({})
    writeFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), '{ not json')
    const found = readEngineRequirement(modules, 'darwin', 'arm64')
    expect(found.ok).toBe(false)
    expect(!found.ok && found.reason).toMatch(/^the LibreOffice kit could not be read: /)
  })

  // The table is what the download prompt quotes; a kit upgrade that moves
  // either desktop target's engine to a version the table lacks fails here.
  it('knows the download size of both desktop engines the shipped kit declares', () => {
    for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']] as const) {
      const found = readEngineRequirement(SERVER_MODULES, platform, arch)
      expect(found.ok && found.requirement.downloadBytes).toBeGreaterThan(0)
    }
    expect(Object.keys(ENGINE_DOWNLOAD_BYTES).length).toBe(2)
  })
})

describe('where the engine lives', () => {
  it('is a version directory under the data directory it is given', () => {
    const root = officeEngineRoot(join('/data', 'dsh'))
    expect(root).toBe(join('/data', 'dsh', 'engines', 'office'))
    expect(engineModulesDir(root, '0.1.1')).toBe(join('/data', 'dsh', 'engines', 'office', '0.1.1', 'node_modules'))
  })

  it('is named first in NODE_PATH, ahead of an inherited value, and in its own variable', () => {
    const root = join('/data', 'engines', 'office')
    const modules = engineModulesDir(root, '0.1.1')
    expect(engineServerEnv(root, REQUIREMENT, undefined)).toEqual({ NODE_PATH: modules, [ENGINE_MODULES_ENV]: modules })
    expect(engineServerEnv(root, REQUIREMENT, ['/mine', modules, ''].join(delimiter))).toEqual({
      NODE_PATH: [modules, '/mine'].join(delimiter),
      [ENGINE_MODULES_ENV]: modules,
    })
  })
})

describe('pruneEngineRoot', () => {
  it('keeps one version and removes the others and every staging directory, and nothing else', () => {
    const root = temp('dsh-engine-prune-')
    for (const name of ['0.1.0', '0.1.1', '0.2.0-rc.1', '.staging-abc', 'notes', 'my-fonts']) mkdirSync(join(root, name))
    writeFileSync(join(root, 'readme.txt'), 'kept')
    expect(pruneEngineRoot(root, '0.1.1')).toEqual({ removed: ['.staging-abc', '0.1.0', '0.2.0-rc.1'].sort(), failed: [] })
    expect(readdirSync(root).sort()).toEqual(['0.1.1', 'my-fonts', 'notes', 'readme.txt'])
  })

  it('removes every version when there is none to keep', () => {
    const root = temp('dsh-engine-prune-')
    mkdirSync(join(root, '0.1.1'))
    expect(pruneEngineRoot(root, undefined).removed).toEqual(['0.1.1'])
  })

  it('does nothing where nothing was ever installed', () => {
    expect(pruneEngineRoot(join(temp('dsh-engine-prune-'), 'absent'), '0.1.1')).toEqual({ removed: [], failed: [] })
  })
})

describe('readProgressLine', () => {
  const started = '{"level":"debug","name":"pnpm:fetching-progress","attempt":1,"packageId":"@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1","size":66711287,"status":"started"}'
  const moving = '{"level":"debug","name":"pnpm:fetching-progress","downloaded":205977,"packageId":"@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1","status":"in_progress"}'

  it('reads the size when the download starts and the running count while it continues', () => {
    expect(readProgressLine(started, REQUIREMENT)).toEqual({ size: 66_711_287 })
    expect(readProgressLine(moving, REQUIREMENT)).toEqual({ downloaded: 205_977 })
  })

  it('ignores another package, another record, and text that is not a record', () => {
    expect(readProgressLine(moving.replace('darwin-arm64@0.1.1', 'darwin-arm64@0.1.0'), REQUIREMENT)).toBeUndefined()
    expect(readProgressLine('{"name":"pnpm:progress","status":"resolved"}', REQUIREMENT)).toBeUndefined()
    expect(readProgressLine(started.replace('"size":66711287', '"size":null'), REQUIREMENT)).toBeUndefined()
    expect(readProgressLine('WARN something', REQUIREMENT)).toBeUndefined()
    expect(readProgressLine('null', REQUIREMENT)).toBeUndefined()
  })
})

/** The stand-in package manager; its first argument picks what it does. */
const FAKE_PNPM = `
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const [mode, ...args] = process.argv.slice(2)
writeFileSync(join(process.cwd(), 'fake-args.json'), JSON.stringify(args))
const spec = args[1]
const at = spec.lastIndexOf('@')
const name = spec.slice(0, at)
const version = mode === 'wrong-version' ? '9.9.9' : spec.slice(at + 1)
const store = args.find(arg => arg.startsWith('--store-dir='))?.slice('--store-dir='.length)
const say = record => { process.stdout.write(JSON.stringify(record) + '\\n') }
const id = name + '@' + version
if (mode === 'fail') {
  process.stderr.write(JSON.stringify({ level: 'error', name: 'pnpm', err: { message: 'GET https://registry.example/x.tgz: Not Found - 404' } }) + '\\n')
  process.exit(1)
}
if (mode === 'crash') {
  process.stderr.write('segfault-ish line\\n')
  process.exit(3)
}
say({ level: 'debug', name: 'pnpm:fetching-progress', attempt: 1, packageId: id, size: mode === 'no-size' ? null : 1000, status: 'started' })
say({ level: 'debug', name: 'pnpm:fetching-progress', packageId: id, downloaded: 400, status: 'in_progress' })
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
say({ level: 'debug', name: 'pnpm:fetching-progress', packageId: id, downloaded: 1000, status: 'in_progress' })
mkdirSync(join(store, 'v10'), { recursive: true })
writeFileSync(join(store, 'v10', 'blob'), 'x')
const dir = join(process.cwd(), 'node_modules', name)
mkdirSync(dir, { recursive: true })
writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
if (mode !== 'incomplete') writeFileSync(join(dir, 'prebuilds.json'), '{}')
`

/**
 * Run one install against the stand-in.
 * @param mode - what the stand-in does.
 * @param options - an existing root, an abort signal, or a deadline.
 * @returns the outcome, the root, and every progress report.
 */
async function install(mode: string, options: { root?: string; signal?: AbortSignal; timeoutMs?: number } = {}) {
  const bin = temp('dsh-fake-pnpm-')
  const script = join(bin, 'pnpm.mjs')
  writeFileSync(script, FAKE_PNPM)
  const root = options.root ?? join(temp('dsh-engine-data-'), 'engines', 'office')
  const progress: InstallProgress[] = []
  const outcome = await installEngine({
    root,
    requirement: REQUIREMENT,
    pnpm: { command: process.execPath, prefixArgs: [script, mode] },
    signal: options.signal ?? new AbortController().signal,
    timeoutMs: options.timeoutMs ?? 30_000,
    onProgress: (report) => { progress.push(report) },
  })
  return { outcome, root, progress }
}

describe('installEngine', () => {
  it('installs the exact engine into its version directory, through a staging directory it renames', async () => {
    const { outcome, root, progress } = await install('ok')
    expect(outcome).toEqual({ ok: true })
    expect(engineInstalled(root, REQUIREMENT)).toBe(true)
    expect(readdirSync(root)).toEqual(['0.1.1'])
    const args = JSON.parse(readFileSync(join(root, '0.1.1', 'fake-args.json'), 'utf8')) as string[]
    expect(args.slice(0, 2)).toEqual(['add', '@deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1'])
    expect(args).toEqual(expect.arrayContaining([
      '--ignore-workspace', '--ignore-scripts', '--reporter=ndjson', '--config.node-linker=hoisted',
    ]))
    // The run's own package store is gone before the rename.
    const store = args.find(arg => arg.startsWith('--store-dir='))?.slice('--store-dir='.length) ?? ''
    expect(store).toMatch(/[\\/]\.staging-[^\\/]+[\\/]\.pnpm-store$/)
    expect(existsSync(join(root, '0.1.1', '.pnpm-store'))).toBe(false)
    expect(progress).toEqual([
      { transferredBytes: 0, totalBytes: 1000 },
      { transferredBytes: 400, totalBytes: 1000 },
      { transferredBytes: 1000, totalBytes: 1000 },
    ])
  })

  it('keeps the known download size when the registry sends none', async () => {
    const { outcome, progress } = await install('no-size')
    expect(outcome).toEqual({ ok: true })
    expect(progress[0]).toEqual({ transferredBytes: 400, totalBytes: REQUIREMENT.downloadBytes })
  })

  it('replaces a version directory an earlier, broken install left', async () => {
    const root = join(temp('dsh-engine-data-'), 'engines', 'office')
    mkdirSync(join(root, '0.1.1', 'node_modules', REQUIREMENT.name), { recursive: true })
    writeFileSync(join(root, '0.1.1', 'stale'), '')
    expect((await install('ok', { root })).outcome).toEqual({ ok: true })
    expect(existsSync(join(root, '0.1.1', 'stale'))).toBe(false)
    expect(engineInstalled(root, REQUIREMENT)).toBe(true)
  })

  it('reports the package manager\'s own error line and leaves nothing behind', async () => {
    const { outcome, root } = await install('fail')
    expect(outcome).toEqual({ ok: false, cancelled: false, reason: 'the package manager exited with 1: GET https://registry.example/x.tgz: Not Found - 404' })
    expect(readdirSync(root)).toEqual([])
  })

  it('quotes plain output when the package manager wrote no record', async () => {
    const { outcome } = await install('crash')
    expect(outcome).toEqual({ ok: false, cancelled: false, reason: 'the package manager exited with 3: segfault-ish line' })
  })

  it('refuses an engine missing its manifest, or of another version, and leaves nothing behind', async () => {
    for (const mode of ['incomplete', 'wrong-version']) {
      const { outcome, root } = await install(mode)
      expect(outcome).toEqual({ ok: false, cancelled: false, reason: 'the package manager finished, but @deepseek-ai/libreoffice-kit-darwin-arm64@0.1.1 is not complete on disk' })
      expect(readdirSync(root)).toEqual([])
    }
  })

  it('stops the package manager when aborted, and removes the staging directory', async () => {
    const controller = new AbortController()
    const running = install('hang', { signal: controller.signal })
    // Aborted once the stand-in has reported progress, so the child is running.
    await new Promise(resolve => setTimeout(resolve, 400))
    controller.abort()
    const { outcome, root } = await running
    expect(outcome).toEqual({ ok: false, cancelled: true, reason: 'cancelled' })
    expect(readdirSync(root)).toEqual([])
  })

  it('does not start when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { outcome, root } = await install('ok', { signal: controller.signal })
    expect(outcome).toEqual({ ok: false, cancelled: true, reason: 'cancelled' })
    expect(readdirSync(root)).toEqual([])
  })

  it('stops a package manager that outlives its deadline', async () => {
    const { outcome } = await install('hang', { timeoutMs: 300 })
    expect(outcome).toEqual({ ok: false, cancelled: false, reason: 'the download did not finish within 1 minutes' })
  })

  it('reports a package manager that cannot be started', async () => {
    const outcome = await installEngine({
      root: join(temp('dsh-engine-data-'), 'office'),
      requirement: REQUIREMENT,
      pnpm: { command: join(temp('dsh-nothing-'), 'no-such-pnpm'), prefixArgs: [] },
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      onProgress: () => {},
    })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toMatch(/^the package manager could not be started: .*ENOENT/)
  })

  it('reports a root it cannot create', async () => {
    const file = join(temp('dsh-engine-data-'), 'a-file')
    writeFileSync(file, '')
    const outcome = await installEngine({
      root: join(file, 'office'),
      requirement: REQUIREMENT,
      pnpm: { command: process.execPath, prefixArgs: [] },
      signal: new AbortController().signal,
      timeoutMs: 10_000,
      onProgress: () => {},
    })
    expect(outcome.ok).toBe(false)
    expect(!outcome.ok && outcome.reason).toMatch(/^the engine directory could not be prepared: /)
  })
})
