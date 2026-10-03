/**
 * When the packaging pipeline reuses a cached registry tarball and when it
 * packs the version again.
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { packedTarball, packedTarballName, tarballMatchesIntegrity, type PackSource } from '../scripts/npm-pack-cache.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'npm-pack-cache-'))
  roots.push(root)
  return root
}

function sri(algorithm: string, bytes: string): string {
  return `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
}

/** A registry that answers `integrity` and records every pack, writing `packed` as the tarball. */
function registry(integrity: string | undefined, packed: string | undefined): PackSource & { packs: string[] } {
  const packs: string[] = []
  return {
    packs,
    integrity: async () => integrity,
    pack: async (spec, directory) => {
      packs.push(spec)
      const at = spec.lastIndexOf('@')
      if (packed !== undefined) writeFileSync(join(directory, packedTarballName(spec.slice(0, at), spec.slice(at + 1))), packed)
    },
  }
}

describe('packedTarballName', () => {
  it('names the file as npm pack does', () => {
    expect(packedTarballName('pnpm', '11.7.0')).toBe('pnpm-11.7.0.tgz')
    expect(packedTarballName('@img/sharp-win32-x64', '0.35.5')).toBe('img-sharp-win32-x64-0.35.5.tgz')
  })
})

describe('tarballMatchesIntegrity', () => {
  it('compares the strongest algorithm the string names', async () => {
    const path = join(scratch(), 'a.tgz')
    writeFileSync(path, 'bytes')
    expect(await tarballMatchesIntegrity(path, sri('sha512', 'bytes'))).toBe(true)
    expect(await tarballMatchesIntegrity(path, sri('sha256', 'bytes'))).toBe(true)
    expect(await tarballMatchesIntegrity(path, sri('sha512', 'other'))).toBe(false)
    expect(await tarballMatchesIntegrity(path, `${sri('sha256', 'bytes')} ${sri('sha512', 'other')}`)).toBe(false)
    expect(await tarballMatchesIntegrity(path, `${sri('sha512', 'other')} ${sri('sha512', 'bytes')}`)).toBe(true)
  })

  it('matches nothing when the string names no supported algorithm', async () => {
    const path = join(scratch(), 'a.tgz')
    writeFileSync(path, 'bytes')
    expect(await tarballMatchesIntegrity(path, sri('sha1', 'bytes'))).toBe(false)
    expect(await tarballMatchesIntegrity(path, 'not an integrity string')).toBe(false)
  })
})

describe('packedTarball', () => {
  it('reuses a cached tarball that matches the registry without packing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = scratch()
    writeFileSync(join(dir, 'img-sharp-win32-x64-0.35.5.tgz'), 'cached')
    const source = registry(sri('sha512', 'cached'), 'fresh')
    expect(await packedTarball(dir, '@img/sharp-win32-x64', '0.35.5', source)).toBe(join(dir, 'img-sharp-win32-x64-0.35.5.tgz'))
    expect(source.packs).toEqual([])
    expect(readFileSync(join(dir, 'img-sharp-win32-x64-0.35.5.tgz'), 'utf8')).toBe('cached')
  })

  it('packs again when the cached tarball does not match', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-11.7.0.tgz'), 'truncated')
    const source = registry(sri('sha512', 'fresh'), 'fresh')
    expect(await packedTarball(dir, 'pnpm', '11.7.0', source)).toBe(join(dir, 'pnpm-11.7.0.tgz'))
    expect(source.packs).toEqual(['pnpm@11.7.0'])
    expect(readFileSync(join(dir, 'pnpm-11.7.0.tgz'), 'utf8')).toBe('fresh')
  })

  it('packs again when the registry gives no integrity', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-11.7.0.tgz'), 'cached')
    const source = registry(undefined, 'fresh')
    await packedTarball(dir, 'pnpm', '11.7.0', source)
    expect(source.packs).toEqual(['pnpm@11.7.0'])
  })

  it('packs into a cache that does not exist yet', async () => {
    const dir = join(scratch(), 'npm-pack')
    const source = registry(sri('sha512', 'fresh'), 'fresh')
    expect(await packedTarball(dir, 'pnpm', '11.7.0', source)).toBe(join(dir, 'pnpm-11.7.0.tgz'))
    expect(source.packs).toEqual(['pnpm@11.7.0'])
  })

  it('fails when the pack writes nothing, rather than keep the mismatched bytes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const dir = scratch()
    writeFileSync(join(dir, 'pnpm-11.7.0.tgz'), 'truncated')
    await expect(packedTarball(dir, 'pnpm', '11.7.0', registry(sri('sha512', 'fresh'), undefined)))
      .rejects.toThrow('npm pack produced no tarball for pnpm@11.7.0')
    expect(existsSync(join(dir, 'pnpm-11.7.0.tgz'))).toBe(false)
  })
})
