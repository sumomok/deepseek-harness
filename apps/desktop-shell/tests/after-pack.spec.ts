/** The afterPack hook stops packaging when a bundled runtime fails the Undici gate. */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SHELL_ELECTRON_VERSION } from '../../../scripts/runtime-version-gate.mjs'

interface PackContext {
  electronPlatformName: 'darwin' | 'win32'
  appOutDir: string
  packager: { appInfo: { productFilename: string } }
}

interface PackFixture {
  root: string
  staging: string
  resources: string
  context: PackContext
}

const { createAfterPack } = createRequire(import.meta.url)('../scripts/after-pack.cjs') as {
  createAfterPack: (stagingRoot: string) => (context: PackContext) => Promise<void>
}

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Write a probe executable that prints one `process.versions` record. */
function writeProbe(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(record)}'\n`)
  chmodSync(path, 0o755)
}

/** Build the staged and packed layouts both platforms read. */
function fixture(platform: 'darwin' | 'win32', nodeRecord: Record<string, unknown>, electronRecord?: Record<string, unknown>): PackFixture {
  const root = mkdtempSync(join(tmpdir(), `after-pack-${platform}-`))
  roots.push(root)
  const staging = join(root, 'staging')
  const out = join(root, 'out')
  const mac = platform === 'darwin'
  const server = join(staging, mac ? 'server-mac' : 'server-win')
  mkdirSync(join(server, 'node_modules', 'third-party'), { recursive: true })
  writeFileSync(join(server, 'index.js'), 'staged server')
  writeFileSync(join(server, 'node_modules', 'third-party', 'package.json'), '{}')
  mkdirSync(join(staging, 'pnpm', 'bin'), { recursive: true })
  writeFileSync(join(staging, 'pnpm', 'bin', 'pnpm.mjs'), '')
  const launcher = join(staging, 'pnpm-launchers', mac ? 'dsh-pnpm' : 'dsh-pnpm.cmd')
  mkdirSync(join(staging, 'pnpm-launchers'), { recursive: true })
  writeFileSync(launcher, 'launcher')

  const appPath = join(out, 'DeepSeek Harness.app')
  const resources = mac ? join(appPath, 'Contents', 'Resources') : join(out, 'resources')
  mkdirSync(join(resources, 'app.asar.unpacked', 'lib'), { recursive: true })
  writeFileSync(join(resources, 'app.asar.unpacked', 'lib', 'listen-handoff.mjs'), '')
  mkdirSync(join(resources, 'runtime'), { recursive: true })
  if (mac) {
    writeProbe(join(resources, 'runtime', 'node'), nodeRecord)
    if (electronRecord !== undefined) {
      mkdirSync(join(appPath, 'Contents', 'MacOS'), { recursive: true })
      writeProbe(join(appPath, 'Contents', 'MacOS', 'DeepSeek Harness'), electronRecord)
    }
  } else writeFileSync(join(resources, 'runtime', 'node.exe'), 'corrupt Windows runtime')

  return {
    root, staging, resources,
    context: { electronPlatformName: platform, appOutDir: out, packager: { appInfo: { productFilename: 'DeepSeek Harness' } } },
  }
}

const PATCHED_NODE = { platform: 'darwin', arch: 'arm64', electron: null, node: '24.22.1', undici: '7.30.1' }
const PATCHED_ELECTRON = {
  platform: 'darwin', arch: 'arm64', electron: SHELL_ELECTRON_VERSION, node: '24.22.1', undici: '7.30.1',
}

describe.skipIf(process.platform === 'win32')('afterPack runtime gate', () => {
  it('proceeds to macOS signing after a patched Node and Electron probe', async () => {
    const { staging, context } = fixture('darwin', PATCHED_NODE, PATCHED_ELECTRON)
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    vi.stubEnv('DSH_MAC_SIGN', '0')
    try {
      await createAfterPack(staging)(context)
    } finally {
      log.mockRestore()
    }
    expect(logs.join('\n')).toContain('after-pack: bundled Node runtime')
    expect(logs.join('\n')).toContain('sign-mac: DSH_MAC_SIGN=0')
  })

  it.each([
    ['an Undici release below the patched line', { ...PATCHED_NODE, undici: '7.29.1' },
      'process.versions.undici 7.29.1 is below the patched 7.30.1'],
    ['a missing Undici field', { ...PATCHED_NODE, undici: null }, 'process.versions.undici is missing'],
  ])('stops macOS packaging at %s without signing', async (_name, nodeRecord, error) => {
    const { root, staging, resources, context } = fixture('darwin', nodeRecord, PATCHED_ELECTRON)
    const logs: string[] = []
    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')) })
    vi.stubEnv('DSH_MAC_SIGN', '0')
    try {
      await expect(createAfterPack(staging)(context)).rejects.toThrow(error)
    } finally {
      log.mockRestore()
    }
    expect(logs.join('\n')).not.toContain('sign-mac:')
    expect(existsSync(join(resources, 'server', 'index.js'))).toBe(true)
    expect(existsSync(join(root, 'out', 'DeepSeek Harness.app', 'Contents', 'Resources', 'server-deps.7z'))).toBe(false)
  })

  it('stops Windows packaging at a cached Node digest mismatch before sealing third-party packages', async () => {
    const { staging, resources, context } = fixture('win32', PATCHED_NODE)
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    try {
      await expect(createAfterPack(staging)(context)).rejects.toThrow('has SHA-256')
    } finally {
      log.mockRestore()
    }
    expect(existsSync(join(resources, 'server', 'node_modules', 'third-party', 'package.json'))).toBe(true)
    expect(existsSync(join(resources, 'server-deps.7z'))).toBe(false)
    expect(existsSync(join(resources, 'server-deps.txt'))).toBe(false)
  })
})
