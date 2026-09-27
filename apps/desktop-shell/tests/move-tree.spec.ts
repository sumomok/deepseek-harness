/**
 * Scanning a home before a move: exclusions, per-path sizes, links recorded
 * and not followed, name clashes, and the longest path.
 * @module
 */

import { linkSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ESTIMATED_BLOCK_BYTES, isInsidePath, meaningfulNames, nativePath, REBUILDABLE_ENTRIES, scanTree } from '../src/move/tree.ts'
import { buildFixture, scratchDir, type Fixture } from './move-fixture.ts'

let fixture: Fixture | undefined
let scratch: string | undefined

afterEach(async () => {
  if (fixture !== undefined) await rm(fixture.root, { recursive: true, force: true })
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true })
  fixture = undefined
  scratch = undefined
})

describe('scanTree', () => {
  it('leaves out the rebuildable entries and everything below them', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const scan = await scanTree(fixture.home, { exclude: REBUILDABLE_ENTRIES })
    const rels = scan.entries.map(entry => entry.rel)
    expect(scan.excluded.sort()).toEqual([...REBUILDABLE_ENTRIES].sort())
    expect(rels.some(rel => rel.startsWith('cache') || rel.startsWith('session-search') || rel.includes('session_projcache'))).toBe(false)
    expect(rels).toContain('storages/workspace.json')
  })

  it('records links with their text and never walks into them', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const scan = await scanTree(fixture.home, { exclude: [] })
    const outside = scan.entries.find(entry => entry.rel === 'profiles/desktop-shell/node_modules/outside')
    expect(outside).toEqual({ kind: 'link', rel: 'profiles/desktop-shell/node_modules/outside', target: fixture.sentinel })
    expect(scan.entries.some(entry => entry.rel.startsWith('profiles/desktop-shell/node_modules/outside/'))).toBe(false)
    expect(scan.links).toBe(4)
  })

  it('adds sizes per path, so hard-linked files count once per name', async () => {
    scratch = await scratchDir('dsh-scan-')
    writeFileSync(join(scratch, 'a'), Buffer.alloc(100))
    linkSync(join(scratch, 'a'), join(scratch, 'b'))
    const scan = await scanTree(scratch, { exclude: [] })
    expect(scan.bytes).toBe(200)
    expect(scan.files).toBe(2)
  })

  it('lists entries parent first with names in order', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const scan = await scanTree(fixture.home, { exclude: [] })
    const seen = new Set<string>([''])
    for (const entry of scan.entries) {
      const parent = entry.rel.includes('/') ? entry.rel.slice(0, entry.rel.lastIndexOf('/')) : ''
      expect(seen.has(parent)).toBe(true)
      if (entry.kind === 'dir') seen.add(entry.rel)
    }
  })

  it('finds names that differ only in case or only in normalization', async () => {
    scratch = await scratchDir('dsh-scan-')
    mkdirSync(join(scratch, 'd'))
    // A case- or normalization-insensitive volume (APFS by default) keeps one
    // file for both spellings; the expectation follows what the volume kept.
    for (const name of ['Readme', 'readme', 'caf\u00e9', 'caf\u0065\u0301']) writeFileSync(join(scratch, 'd', name), '')
    const kept = new Set(readdirSync(join(scratch, 'd')))
    const scan = await scanTree(scratch, { exclude: [] })
    expect(scan.caseCollisions).toEqual(kept.has('Readme') && kept.has('readme') ? [['d/Readme', 'd/readme']] : [])
    expect(scan.normalizationCollisions).toEqual(
      kept.has('caf\u00e9') && kept.has('caf\u0065\u0301') ? [['d/caf\u0065\u0301', 'd/caf\u00e9']] : [],
    )
  })

  it('estimates allocated space in whole blocks', async () => {
    scratch = await scratchDir('dsh-scan-')
    writeFileSync(join(scratch, 'one'), Buffer.alloc(1))
    writeFileSync(join(scratch, 'empty'), '')
    mkdirSync(join(scratch, 'd'))
    const scan = await scanTree(scratch, { exclude: [] })
    expect(scan.bytes).toBe(1)
    expect(scan.allocatedBytes).toBe(2 * ESTIMATED_BLOCK_BYTES)
  })

  it('leaves a file browser\'s files out of what makes a folder non-empty', () => {
    expect(meaningfulNames(['.DS_Store', 'Thumbs.db', 'desktop.ini', 'a'])).toEqual(['a'])
  })

  it('reports the longest relative path', async () => {
    scratch = await scratchDir('dsh-scan-')
    mkdirSync(join(scratch, 'aaaa', 'bbbbbbbb'), { recursive: true })
    writeFileSync(join(scratch, 'aaaa', 'bbbbbbbb', 'c'), '')
    expect((await scanTree(scratch, { exclude: [] })).longestRelative).toBe('aaaa/bbbbbbbb/c'.length)
  })

  it('refuses a root that is a link', async () => {
    scratch = await scratchDir('dsh-scan-')
    mkdirSync(join(scratch, 'real'))
    symlinkSync(join(scratch, 'real'), join(scratch, 'alias'))
    await expect(scanTree(join(scratch, 'alias'), { exclude: [] })).rejects.toThrow(/not a directory/)
  })

  it('stops when aborted', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const controller = new AbortController()
    controller.abort()
    await expect(scanTree(fixture.home, { exclude: [], signal: controller.signal })).rejects.toThrow()
  })
})

describe('paths', () => {
  it('joins a relative path under a root', () => {
    expect(nativePath('/r', '')).toBe('/r')
    expect(nativePath('/r', 'a/b')).toBe(join('/r', 'a', 'b'))
  })

  it('tells inside from beside', () => {
    expect(isInsidePath('/a/b', '/a', 'darwin')).toBe(true)
    expect(isInsidePath('/a', '/a/', 'darwin')).toBe(true)
    expect(isInsidePath('/ab', '/a', 'darwin')).toBe(false)
    expect(isInsidePath('/a/..b', '/a', 'darwin')).toBe(true)
    expect(isInsidePath('/', '/a', 'darwin')).toBe(false)
    expect(isInsidePath('C:\\Data\\x', 'c:\\data', 'win32')).toBe(true)
    expect(isInsidePath('D:\\Data', 'C:\\Data', 'win32')).toBe(false)
    expect(isInsidePath('/Users/P/DATA/x', '/Users/p/Data', 'darwin')).toBe(true)
    expect(isInsidePath('/a/caf\u0065\u0301/x', '/a/caf\u00e9', 'darwin')).toBe(true)
    expect(isInsidePath('/Users/P/DATA/x', '/Users/p/Data', 'linux')).toBe(false)
  })
})
