/**
 * Removal that never follows links: a sentinel behind a link survives, a link
 * given as the root is only unlinked, read-only entries go, busy Windows
 * entries are retried, and what stays is reported with its size.
 * @module
 */

import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOVE_ATTEMPTS, removeTree, type RemoveFs, type RemoveStats } from '../src/move/remove.ts'
import { buildFixture, listTree, scratchDir, type Fixture } from './move-fixture.ts'

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

const noWait = async (): Promise<void> => {}

describe('removeTree', () => {
  it('removes a whole home and leaves what its links point to', async () => {
    fixture = await buildFixture({ bigBytes: 1000 })
    const sentinelBefore = listTree(fixture.sentinel)
    const report = await removeTree(fixture.home, { platform: process.platform, sleep: noWait })
    expect(report.leftovers).toEqual([])
    expect(existsSync(fixture.home)).toBe(false)
    expect(listTree(fixture.sentinel)).toEqual(sentinelBefore)
  })

  it('only unlinks a root that is a link', async () => {
    scratch = await scratchDir('dsh-remove-')
    mkdirSync(join(scratch, 'real'))
    writeFileSync(join(scratch, 'real', 'x'), 'x')
    symlinkSync(join(scratch, 'real'), join(scratch, 'alias'), 'junction')
    const report = await removeTree(join(scratch, 'alias'), { platform: process.platform, sleep: noWait })
    expect(report).toEqual({ removed: 1, leftovers: [], leftoverBytes: 0 })
    expect(readdirSync(join(scratch, 'real'))).toEqual(['x'])
  })

  it('treats a path that is not there as removed', async () => {
    scratch = await scratchDir('dsh-remove-')
    expect(await removeTree(join(scratch, 'none'), { platform: process.platform, sleep: noWait }))
      .toEqual({ removed: 0, leftovers: [], leftoverBytes: 0 })
  })

  it('removes read-only files and directories inside the tree', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    scratch = await scratchDir('dsh-remove-')
    const tree = join(scratch, 'tree')
    mkdirSync(join(tree, 'locked'), { recursive: true })
    writeFileSync(join(tree, 'locked', 'f'), 'f')
    chmodSync(join(tree, 'locked', 'f'), 0o444)
    chmodSync(join(tree, 'locked'), 0o555)
    const report = await removeTree(tree, { platform: process.platform, sleep: noWait })
    expect(report.leftovers).toEqual([])
    expect(existsSync(tree)).toBe(false)
  })

  it('never changes the permissions of the directory holding the root', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    scratch = await scratchDir('dsh-remove-')
    const parent = join(scratch, 'parent')
    mkdirSync(join(parent, 'tree'), { recursive: true })
    chmodSync(parent, 0o555)
    const report = await removeTree(join(parent, 'tree'), { platform: process.platform, sleep: noWait })
    expect(report.leftovers).toEqual([{ path: join(parent, 'tree'), code: 'EACCES', bytes: 0 }])
    expect(lstatSync(parent).mode & 0o777).toBe(0o555)
    chmodSync(parent, 0o700)
  })
})

/**
 * A Windows stand-in: a tree held in a map, with entries that answer EBUSY
 * a number of times before they can be removed.
 * @param busy - how many times each path refuses.
 * @returns the fake and the calls it saw.
 */
function windowsFs(busy: Record<string, number>): { fs: RemoveFs; calls: string[] } {
  const calls: string[] = []
  const entries = new Map<string, { kind: 'dir' | 'file' | 'junction'; size: number }>([
    ['C:\\hidden', { kind: 'dir', size: 0 }],
    ['C:\\hidden\\f', { kind: 'file', size: 35 }],
    ['C:\\hidden\\nm', { kind: 'junction', size: 0 }],
  ])
  const stats = (kind: 'dir' | 'file' | 'junction', size: number): RemoveStats => ({
    isSymbolicLink: () => kind === 'junction',
    isDirectory: () => kind !== 'file',
    size,
  })
  const refuse = (path: string): void => {
    const left = busy[path] ?? 0
    if (left > 0) {
      busy[path] = left - 1
      throw Object.assign(new Error(`EBUSY: ${path}`), { code: 'EBUSY' })
    }
  }
  const fs: RemoveFs = {
    lstat: async (path) => {
      const entry = entries.get(path)
      if (entry === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return stats(entry.kind, entry.size)
    },
    readdir: async path => [...entries.keys()].filter(key => key.startsWith(`${path}\\`)).map(key => key.slice(path.length + 1)),
    unlink: async (path) => {
      calls.push(`unlink ${path}`)
      refuse(path)
      entries.delete(path)
    },
    rmdir: async (path) => {
      calls.push(`rmdir ${path}`)
      refuse(path)
      entries.delete(path)
    },
    chmod: async (path) => { calls.push(`chmod ${path}`) },
  }
  return { fs, calls }
}

describe('removeTree on Windows', () => {
  it('unlinks a junction and retries a busy file with growing waits', async () => {
    const { fs, calls } = windowsFs({ 'C:\\hidden\\f': 2 })
    const waits: number[] = []
    const report = await removeTree('C:\\hidden', { platform: 'win32', fs, sleep: async (ms) => { waits.push(ms) } })
    expect(report).toEqual({ removed: 3, leftovers: [], leftoverBytes: 0 })
    expect(calls.filter(call => call.includes('nm'))).toEqual(['unlink C:\\hidden\\nm'])
    expect(waits).toEqual([100, 200])
  })

  it('reports a file that stays busy, with its size, and keeps its directory', async () => {
    const { fs } = windowsFs({ 'C:\\hidden\\f': 100 })
    const report = await removeTree('C:\\hidden', { platform: 'win32', fs, sleep: noWait })
    expect(report.leftovers).toEqual([{ path: 'C:\\hidden\\f', code: 'EBUSY', bytes: 35 }])
    expect(report.leftoverBytes).toBe(35)
    expect(report.removed).toBe(1)
  })

  it('gives up after the set number of attempts', async () => {
    const { fs, calls } = windowsFs({ 'C:\\hidden\\f': 100 })
    await removeTree('C:\\hidden', { platform: 'win32', fs, sleep: noWait })
    expect(calls.filter(call => call === 'unlink C:\\hidden\\f')).toHaveLength(REMOVE_ATTEMPTS)
  })
})
