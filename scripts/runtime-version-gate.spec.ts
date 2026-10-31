import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_ELECTRON_MAJOR, DESKTOP_ELECTRON_MINIMUM, SHELL_ELECTRON_VERSION, UNDICI_MINIMUM_VERSIONS,
  WINDOWS_HOST_NODE_SHA256, WINDOWS_HOST_NODE_VERSION,
  assertRuntimeProbe, formatRuntimeProbe, probeRuntimeExecutable, sha256File, undiciVersionProblem,
  verifyFileSha256, type RuntimeProbe,
} from './runtime-version-gate.mjs'

function probe(overrides: Partial<RuntimeProbe> = {}): RuntimeProbe {
  return {
    executable: '/runtime/node', platform: 'linux', arch: 'x64', electron: undefined,
    node: '24.22.1', undici: '7.30.1', exitCode: 0, ...overrides,
  }
}

describe('bundled Undici gate', () => {
  it.each([
    ['6.29.0', 'below'], ['6.29.1', undefined], ['6.30.0', undefined],
    ['7.30.0', 'below'], ['7.30.1', undefined], ['7.31.0', undefined],
    ['8.12.1', 'below'], ['8.12.2', undefined], ['8.13.0', undefined],
  ])('classifies %s', (version, expected) => {
    const problem = undiciVersionProblem(version)
    if (expected === undefined) expect(problem).toBeUndefined()
    else expect(problem).toContain(expected)
  })

  it('rejects missing, malformed, prerelease and unknown major versions', () => {
    expect(undiciVersionProblem(undefined)).toContain('missing')
    expect(undiciVersionProblem('')).toContain('missing')
    expect(undiciVersionProblem('7.x')).toContain('not a semantic version')
    expect(undiciVersionProblem('7.30.1-rc.1')).toContain('below')
    expect(undiciVersionProblem('5.29.1')).toContain('unverified major 5')
    expect(undiciVersionProblem('9.0.0')).toContain('unverified major 9')
  })

  it('names the pinned patched releases', () => {
    expect(UNDICI_MINIMUM_VERSIONS).toEqual({ 6: '6.29.1', 7: '7.30.1', 8: '8.12.2' })
  })

  it('blocks packaging with the executable and runtime versions in the failure', () => {
    expect(() => assertRuntimeProbe(probe({ undici: '7.29.1' })))
      .toThrow('/runtime/node (linux/x64, Electron none, Node 24.22.1) rejected: process.versions.undici 7.29.1 is below')
  })

  it('checks platform, architecture, exact Node, and Electron expectations', () => {
    const electron = probe({ platform: 'darwin', arch: 'arm64', electron: '43.8.6' })
    expect(assertRuntimeProbe(electron, {
      platform: 'darwin', arch: 'arm64', node: '24.22.1', electron: SHELL_ELECTRON_VERSION,
    })).toBe(electron)
    expect(() => assertRuntimeProbe(electron, { platform: 'win32' })).toThrow('runs on darwin, expected win32')
    expect(() => assertRuntimeProbe(electron, { arch: 'x64' })).toThrow('runs on arm64, expected x64')
    expect(() => assertRuntimeProbe(probe(), { node: '24.21.0' })).toThrow('carries Node 24.22.1, expected 24.21.0')
    expect(() => assertRuntimeProbe(probe(), { electron: SHELL_ELECTRON_VERSION })).toThrow('is not an Electron runtime')
    expect(() => assertRuntimeProbe(electron, { electron: '43.8.1' })).toThrow('carries Electron 43.8.6, expected 43.8.1')
    expect(() => assertRuntimeProbe(probe({ electron: '44.10.0' }), {
      electron: { minimum: DESKTOP_ELECTRON_MINIMUM, major: DESKTOP_ELECTRON_MAJOR },
    })).not.toThrow()
    expect(() => assertRuntimeProbe(probe({ electron: '45.0.0' }), {
      electron: { minimum: DESKTOP_ELECTRON_MINIMUM, major: DESKTOP_ELECTRON_MAJOR },
    })).toThrow('expected major 44')
    expect(() => assertRuntimeProbe(probe({ electron: '44.9.3' }), {
      electron: { minimum: DESKTOP_ELECTRON_MINIMUM },
    })).toThrow('below 44.10.0')
  })

  it('executes the actual binary and reads its process.versions', () => {
    const actual = probeRuntimeExecutable(process.execPath)
    expect(actual.exitCode).toBe(0)
    expect(actual.executable).toBe(process.execPath)
    expect(actual.platform).toBe(process.platform)
    expect(actual.arch).toBe(process.arch)
    expect(actual.node).toBe(process.versions.node)
    expect(actual.undici).toBe(process.versions.undici)
    expect(formatRuntimeProbe(actual)).toContain(`node=${process.versions.node}`)
    expect(formatRuntimeProbe(actual)).toContain('exitCode=0')
  })

  it('hashes files and rejects a mismatched pinned digest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-gate-'))
    try {
      const path = join(root, 'runtime')
      await writeFile(path, 'runtime bytes')
      const digest = createHash('sha256').update('runtime bytes').digest('hex')
      expect(sha256File(path)).toBe(digest)
      expect(() => { verifyFileSha256(path, digest) }).not.toThrow()
      expect(() => { verifyFileSha256(path, '0'.repeat(64)) }).toThrow(`has SHA-256 ${digest}`)
      expect(WINDOWS_HOST_NODE_SHA256).toMatch(/^[0-9a-f]{64}$/u)
      expect(WINDOWS_HOST_NODE_VERSION).toBe('24.22.1')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
