/**
 * Calibrating `~/.dsh` to the data directory: every state the entry can be
 * in, on the real file system, and the Windows junction calls through a
 * recorded stand-in.
 * @module
 */

import {
  existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync, type Stats,
} from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DATA_ID_FILENAME, type DataId } from '../src/data-location.ts'
import { calibrateHomeLink, type LinkFs } from '../src/home-link.ts'

let root: string
let defaultHome: string
let dataHome: string

const ID = '11111111-2222-4333-8444-555555555555' as DataId
const OTHER = '99999999-8888-4777-8666-555555555555'
const posixOnly = process.platform === 'win32' ? it.skip : it

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-home-link-')))
  // `~/.dsh` below is inside this directory; it must never be the user's own.
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
  mkdirSync(join(root, 'home'))
  defaultHome = join(root, 'home', '.dsh')
  dataHome = join(root, 'Ext', 'DSH-Data')
  mkdirSync(dataHome, { recursive: true })
  writeFileSync(join(dataHome, DATA_ID_FILENAME), `${ID}\n`)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function calibrate(): ReturnType<typeof calibrateHomeLink> {
  return calibrateHomeLink({ defaultHome, dataHome, dataId: ID, platform: process.platform })
}

describe('calibrateHomeLink', () => {
  it('does nothing when the data lives at the default home', () => {
    expect(calibrateHomeLink({ defaultHome, dataHome: `${defaultHome}/`, dataId: ID, platform: process.platform }))
      .toEqual({ kind: 'not-needed' })
    expect(existsSync(defaultHome)).toBe(false)
  })

  posixOnly('creates the link when ~/.dsh is absent', () => {
    expect(calibrate()).toEqual({ kind: 'created' })
    expect(lstatSync(defaultHome).isSymbolicLink()).toBe(true)
    expect(readlinkSync(defaultHome)).toBe(dataHome)
  })

  posixOnly('leaves a correct link alone', () => {
    symlinkSync(dataHome, defaultHome)
    const before = lstatSync(defaultHome).mtimeMs
    expect(calibrate()).toEqual({ kind: 'already-correct' })
    expect(lstatSync(defaultHome).mtimeMs).toBe(before)
  })

  posixOnly('re-points a link to another directory without touching that directory', () => {
    const elsewhere = join(root, 'elsewhere')
    mkdirSync(elsewhere)
    writeFileSync(join(elsewhere, 'keep.txt'), 'data')
    symlinkSync(elsewhere, defaultHome)
    expect(calibrate()).toEqual({ kind: 'repointed', previous: elsewhere })
    expect(readlinkSync(defaultHome)).toBe(dataHome)
    expect(readFileSync(join(elsewhere, 'keep.txt'), 'utf8')).toBe('data')
  })

  posixOnly('re-points a dangling link', () => {
    const gone = join(root, 'Old', 'DSH-Data')
    symlinkSync(gone, defaultHome)
    expect(calibrate()).toEqual({ kind: 'repointed', previous: gone })
    expect(readlinkSync(defaultHome)).toBe(dataHome)
    expect(existsSync(join(root, 'Old'))).toBe(false)
  })

  it('keeps a real directory without a marker and reports it as foreign', () => {
    mkdirSync(join(defaultHome, 'sessions'), { recursive: true })
    writeFileSync(join(defaultHome, 'sessions', 'x'), 'mine')
    expect(calibrate()).toEqual({ kind: 'kept-directory', reason: 'foreign' })
    expect(lstatSync(defaultHome).isDirectory()).toBe(true)
    expect(readdirSync(defaultHome)).toEqual(['sessions'])
  })

  it('keeps a real directory with another identity, and one with this identity', () => {
    mkdirSync(defaultHome)
    writeFileSync(join(defaultHome, DATA_ID_FILENAME), `${OTHER}\n`)
    expect(calibrate()).toEqual({ kind: 'kept-directory', reason: 'foreign' })
    writeFileSync(join(defaultHome, DATA_ID_FILENAME), `${ID}\n`)
    expect(calibrate()).toEqual({ kind: 'kept-directory', reason: 'same-id' })
    expect(lstatSync(defaultHome).isDirectory()).toBe(true)
  })

  it('keeps a regular file', () => {
    writeFileSync(defaultHome, 'not a directory')
    expect(calibrate()).toEqual({ kind: 'kept-other' })
    expect(readFileSync(defaultHome, 'utf8')).toBe('not a directory')
  })

  it('reports a failure instead of throwing', () => {
    const fs: LinkFs = {
      lstat: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) },
      readlink: () => '',
      symlink: () => undefined,
      unlink: () => undefined,
    }
    expect(calibrateHomeLink({ defaultHome, dataHome, dataId: ID, platform: 'darwin', fs }).kind).toBe('failed')
    const refusing: LinkFs = { ...fs, lstat: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }, symlink: () => { throw new Error('EPERM') } }
    expect(calibrateHomeLink({ defaultHome, dataHome, dataId: ID, platform: 'darwin', fs: refusing }))
      .toEqual({ kind: 'failed', detail: 'Error: EPERM' })
  })
})

describe('calibrateHomeLink on Windows', () => {
  /** A stand-in file system holding one entry at `~/.dsh`, recording every call. */
  function windowsFs(entry: { kind: 'absent' } | { kind: 'junction'; target: string }): { fs: LinkFs; calls: string[] } {
    const calls: string[] = []
    const linkStats = { isSymbolicLink: () => true, isDirectory: () => false } as unknown as Stats
    const fs: LinkFs = {
      lstat: (path) => {
        calls.push(`lstat ${path}`)
        if (entry.kind === 'absent') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return linkStats
      },
      readlink: (path) => {
        calls.push(`readlink ${path}`)
        return entry.kind === 'junction' ? entry.target : ''
      },
      symlink: (target, path, type) => { calls.push(`symlink ${target} ${path} ${String(type)}`) },
      unlink: (path) => { calls.push(`unlink ${path}`) },
    }
    return { fs, calls }
  }

  const home = 'C:\\Users\\u\\.dsh'
  const data = 'D:\\DSH-Data'
  const onWindows = process.platform === 'win32' ? it : it.skip

  it('creates a junction, which needs no developer mode', () => {
    const { fs, calls } = windowsFs({ kind: 'absent' })
    expect(calibrateHomeLink({ defaultHome: home, dataHome: data, dataId: ID, platform: 'win32', fs })).toEqual({ kind: 'created' })
    expect(calls.at(-1)).toBe(`symlink ${data} ${home} junction`)
  })

  it('removes only the junction itself before re-pointing it', () => {
    const { fs, calls } = windowsFs({ kind: 'junction', target: '\\\\?\\E:\\Old\\' })
    expect(calibrateHomeLink({ defaultHome: home, dataHome: data, dataId: ID, platform: 'win32', fs }))
      .toEqual({ kind: 'repointed', previous: '\\\\?\\E:\\Old\\' })
    expect(calls.slice(-2)).toEqual([`unlink ${home}`, `symlink ${data} ${home} junction`])
  })

  it('leaves a junction that already points at the data directory', () => {
    const { fs, calls } = windowsFs({ kind: 'junction', target: data })
    expect(calibrateHomeLink({ defaultHome: home, dataHome: data, dataId: ID, platform: 'win32', fs })).toEqual({ kind: 'already-correct' })
    expect(calls.some(call => call.startsWith('unlink') || call.startsWith('symlink'))).toBe(false)
  })

  onWindows('reads back a junction in its extended-length form as correct', () => {
    const { fs, calls } = windowsFs({ kind: 'junction', target: '\\\\?\\D:\\DSH-Data\\' })
    expect(calibrateHomeLink({ defaultHome: home, dataHome: data, dataId: ID, platform: 'win32', fs })).toEqual({ kind: 'already-correct' })
    expect(calls.some(call => call.startsWith('unlink'))).toBe(false)
  })
})
