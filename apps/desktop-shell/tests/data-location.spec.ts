/**
 * The data-location pointer: reading and writing it, the identity marker both
 * sides carry, and the decision each launch makes between the default home,
 * the pointer, and an explicit `DSH_HOME`.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptEnvLocation, canAdoptEnv, checkChosenFolder, commitReady, DATA_ID_FILENAME, ensureDataId, keepPointerOverEnv,
  looksLikeHarnessHome, normalizeDshHome, POINTER_BACKUP_FILENAME, POINTER_FILENAME, POINTER_VERSION,
  readDataId, readPointer, resolveDataLocation, writePointer,
  type DataId, type DataLocationPointer,
} from '../src/data-location.ts'

let root: string
let userData: string
let defaultHome: string

beforeEach(async () => {
  root = realpathSync(await mkdtemp(join(tmpdir(), 'dsh-data-location-')))
  // Every case reads and writes under this directory; it must never be the user's own.
  expect(root.startsWith(realpathSync(tmpdir()))).toBe(true)
  userData = join(root, 'userData')
  defaultHome = join(root, 'home', '.dsh')
  mkdirSync(userData, { recursive: true })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const ID_A = '11111111-2222-4333-8444-555555555555' as DataId
const ID_B = '99999999-8888-4777-8666-555555555555' as DataId

/** A data directory under the temporary root, optionally with a marker and Harness structure. */
function dataDir(name: string, options: { id?: string; structure?: boolean } = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (options.id !== undefined) writeFileSync(join(dir, DATA_ID_FILENAME), `${options.id}\n`)
  if (options.structure === true) mkdirSync(join(dir, 'sessions'))
  return dir
}

function pointerAt(path: string, extra: Partial<DataLocationPointer> = {}): DataLocationPointer {
  return { version: POINTER_VERSION, path, dataId: ID_A, ...extra }
}

describe('normalizeDshHome', () => {
  it('treats blank as unset and expands ~ against the given home', () => {
    expect(normalizeDshHome(undefined, '/h')).toBeUndefined()
    expect(normalizeDshHome('  ', '/h')).toBeUndefined()
    expect(normalizeDshHome('~', '/h')).toBe('/h')
    expect(normalizeDshHome('~/data', '/h')).toBe('/h/data')
    expect(normalizeDshHome('/abs/x/', '/h')).toBe('/abs/x')
  })
})

describe('pointer file', () => {
  it('reads absent when neither file exists', () => {
    expect(readPointer(userData)).toEqual({ kind: 'absent' })
  })

  it('round-trips a pointer and keeps the previous one as the backup', () => {
    const first = pointerAt('/data/one', { lastSeenEnv: '/env/one' })
    writePointer(userData, first)
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: first, from: 'main' })
    expect(existsSync(join(userData, POINTER_BACKUP_FILENAME))).toBe(false)
    const second = pointerAt('/data/two')
    writePointer(userData, second)
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: second, from: 'main' })
    expect(JSON.parse(readFileSync(join(userData, POINTER_BACKUP_FILENAME), 'utf8'))).toEqual(first)
    expect(existsSync(join(userData, `${POINTER_FILENAME}.${String(process.pid)}.tmp`))).toBe(false)
  })

  it('falls back to the backup when the main file is corrupt', () => {
    const good = pointerAt('/data/one')
    writePointer(userData, good)
    writePointer(userData, pointerAt('/data/two'))
    writeFileSync(join(userData, POINTER_FILENAME), '{ not json')
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: good, from: 'backup' })
  })

  it('reports corrupt with the reason when neither file is usable', () => {
    writeFileSync(join(userData, POINTER_FILENAME), JSON.stringify({ version: 2, path: '/x', dataId: ID_A }))
    const read = readPointer(userData)
    expect(read.kind).toBe('corrupt')
    expect(read.kind === 'corrupt' && read.detail).toContain('unsupported version 2')
  })

  it.each([
    ['a relative path', { version: 1, path: 'rel', dataId: ID_A }, 'path is not an absolute path'],
    ['a non-UUID id', { version: 1, path: '/x', dataId: 'abc' }, 'dataId is not a UUID'],
    ['a relative lastSeenEnv', { version: 1, path: '/x', dataId: ID_A, lastSeenEnv: 'rel' }, 'lastSeenEnv'],
    ['a non-string movedAt', { version: 1, path: '/x', dataId: ID_A, movedAt: 3 }, 'movedAt'],
    ['an array', [], 'unsupported version'],
    ['null', null, 'not a JSON object'],
  ])('refuses %s', (_name, document, reason) => {
    writeFileSync(join(userData, POINTER_FILENAME), JSON.stringify(document))
    const read = readPointer(userData)
    expect(read.kind === 'corrupt' && read.detail).toContain(reason)
  })

  it('reads a backup left without a main file', () => {
    const good = pointerAt('/data/one')
    writeFileSync(join(userData, POINTER_BACKUP_FILENAME), JSON.stringify(good))
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: good, from: 'backup' })
  })

  it('reports an unreadable main file as corrupt', () => {
    mkdirSync(join(userData, POINTER_FILENAME))
    const read = readPointer(userData)
    expect(read.kind === 'corrupt' && read.detail).toContain('cannot read')
  })
})

describe('identity marker', () => {
  it('reads absent, ok, and unreadable markers', () => {
    expect(readDataId(dataDir('none'))).toEqual({ kind: 'absent' })
    expect(readDataId(dataDir('good', { id: ID_A }))).toEqual({ kind: 'ok', id: ID_A })
    expect(readDataId(dataDir('bad', { id: 'garbage' })).kind).toBe('unreadable')
    const blocked = dataDir('blocked')
    mkdirSync(join(blocked, DATA_ID_FILENAME))
    expect(readDataId(blocked).kind).toBe('unreadable')
  })

  it('writes a marker once and returns the existing one afterwards', () => {
    const dir = dataDir('fresh')
    const id = ensureDataId(dir)
    expect(readDataId(dir)).toEqual({ kind: 'ok', id })
    expect(ensureDataId(dir)).toBe(id)
    expect(ensureDataId(dataDir('kept', { id: ID_B }))).toBe(ID_B)
  })

  it('refuses to overwrite an unreadable marker', () => {
    expect(() => ensureDataId(dataDir('bad', { id: 'garbage' }))).toThrow(/does not hold a UUID/)
  })

  it('recognizes a Harness home by its structure', () => {
    expect(looksLikeHarnessHome(dataDir('plain'))).toBe(false)
    expect(looksLikeHarnessHome(dataDir('home', { structure: true }))).toBe(true)
  })
})

describe('resolveDataLocation without a pointer', () => {
  it('uses the default home, or the explicit DSH_HOME, as before', () => {
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'ready', home: defaultHome, via: 'default' })
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: '/somewhere', defaultHome }))
      .toEqual({ kind: 'ready', home: '/somewhere', via: 'env' })
  })

  it('stops on an unreadable pointer instead of falling back to the default home', () => {
    expect(resolveDataLocation({ read: { kind: 'corrupt', detail: 'x' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'unavailable', reason: 'pointer-unreadable', detail: 'x' })
  })
})

describe('resolveDataLocation with a pointer', () => {
  it('uses the pointer when its directory carries the same identity', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir), from: 'main' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })

  it('rewrites the main file when the pointer came from the backup', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir), from: 'backup' }, env: undefined, defaultHome })
    expect(resolution).toEqual({ kind: 'ready', home: dir, via: 'pointer', pointer: pointerAt(dir) })
  })

  it('is unavailable when the directory is missing, never the default home', () => {
    const pointer = pointerAt(join(root, 'unplugged', 'DSH-Data'))
    mkdirSync(defaultHome, { recursive: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'unavailable', reason: 'missing', pointer })
  })

  it('is unavailable when the directory carries another identity or none', () => {
    const other = pointerAt(dataDir('other', { id: ID_B }))
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: other, from: 'main' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'unavailable', reason: 'id-mismatch', pointer: other })
    const none = pointerAt(dataDir('none', { structure: true }))
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: none, from: 'main' }, env: undefined, defaultHome }))
      .toEqual({ kind: 'unavailable', reason: 'id-mismatch', pointer: none })
  })

  it('keeps the pointer when DSH_HOME equals the value last seen', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('old', { id: ID_B })
    const pointer = pointerAt(dir, { lastSeenEnv: env })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env, defaultHome }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })

  it('records a new DSH_HOME equal to the pointer as seen without moving', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir), from: 'main' }, env: dir, defaultHome })
    expect(resolution).toEqual({ kind: 'ready', home: dir, via: 'pointer', pointer: pointerAt(dir, { lastSeenEnv: dir }) })
  })

  it('follows a new DSH_HOME whose directory carries an identity, adopting it', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('elsewhere', { id: ID_B })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir), from: 'main' }, env, defaultHome })
    expect(resolution.kind === 'ready' && resolution.via).toBe('followed-env')
    expect(resolution.kind === 'ready' && resolution.home).toBe(env)
    expect(resolution.kind === 'ready' && resolution.pointer).toMatchObject({ path: env, dataId: ID_B, lastSeenEnv: env })
    expect(resolution.kind === 'ready' && resolution.adoptId).toBeUndefined()
  })

  it('follows a new DSH_HOME that is a Harness home without a marker, asking for one', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('legacy', { structure: true })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir), from: 'main' }, env, defaultHome })
    expect(resolution).toMatchObject({ kind: 'ready', home: env, via: 'followed-env', adoptId: true })
  })

  it('asks before following a new DSH_HOME that is missing or holds no Harness data', () => {
    const pointer = pointerAt(dataDir('DSH-Data', { id: ID_A }))
    const missing = join(root, 'typo')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: missing, defaultHome }))
      .toEqual({ kind: 'confirm-env', envPath: missing, pointer, reason: 'missing' })
    const empty = dataDir('empty')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: empty, defaultHome }))
      .toEqual({ kind: 'confirm-env', envPath: empty, pointer, reason: 'not-harness-data' })
  })

  it('asks, without offering to adopt it, about a new DSH_HOME that is a file or holds damaged data', () => {
    const pointer = pointerAt(dataDir('DSH-Data', { id: ID_A }))
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: file, defaultHome }))
      .toEqual({ kind: 'confirm-env', envPath: file, pointer, reason: 'not-a-folder' })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: join(file, 'below'), defaultHome }))
      .toEqual({ kind: 'confirm-env', envPath: join(file, 'below'), pointer, reason: 'not-a-folder' })
    const badMarker = dataDir('bad', { id: 'garbage', structure: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer, from: 'main' }, env: badMarker, defaultHome }))
      .toEqual({ kind: 'confirm-env', envPath: badMarker, pointer, reason: 'damaged-data' })
    expect([canAdoptEnv('missing'), canAdoptEnv('not-harness-data'), canAdoptEnv('not-a-folder'), canAdoptEnv('damaged-data')])
      .toEqual([true, true, false, false])
  })
})

describe('committing and the person\'s choices', () => {
  it('writes the marker before the pointer when adopting a directory', () => {
    const env = dataDir('legacy', { structure: true })
    const committed = commitReady(userData, {
      kind: 'ready', home: env, via: 'followed-env', pointer: pointerAt(env, { lastSeenEnv: env }), adoptId: true,
    })
    const id = readDataId(env)
    expect(id.kind).toBe('ok')
    expect(committed?.dataId).toBe(id.kind === 'ok' ? id.id : undefined)
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: committed, from: 'main' })
  })

  it('gives an existing default home a marker without writing a pointer', () => {
    mkdirSync(defaultHome, { recursive: true })
    expect(commitReady(userData, { kind: 'ready', home: defaultHome, via: 'default' })).toBeUndefined()
    expect(readDataId(defaultHome).kind).toBe('ok')
    expect(readPointer(userData)).toEqual({ kind: 'absent' })
  })

  it('creates nothing for a default home that does not exist yet', () => {
    commitReady(userData, { kind: 'ready', home: defaultHome, via: 'default' })
    expect(existsSync(defaultHome)).toBe(false)
  })

  it('accepts a picked folder only with the pointer\'s identity', () => {
    const pointer = pointerAt('/gone', { lastSeenEnv: '/env' })
    expect(checkChosenFolder(dataDir('none'), pointer, undefined)).toEqual({ kind: 'rejected', reason: 'no-data' })
    expect(checkChosenFolder(dataDir('other', { id: ID_B }), pointer, undefined)).toEqual({ kind: 'rejected', reason: 'other-data' })
    const same = dataDir('same', { id: ID_A })
    const accepted = checkChosenFolder(same, pointer, undefined)
    expect(accepted).toMatchObject({ kind: 'accepted', pointer: { path: same, dataId: ID_A, lastSeenEnv: '/env' } })
    expect(checkChosenFolder(same, pointer, '/env2')).toMatchObject({ pointer: { lastSeenEnv: '/env2' } })
  })

  it('accepts any marked folder when the pointer was unreadable', () => {
    const picked = dataDir('picked', { id: ID_B })
    expect(checkChosenFolder(picked, undefined, undefined)).toMatchObject({ kind: 'accepted', pointer: { path: picked, dataId: ID_B } })
    expect(checkChosenFolder(dataDir('none'), undefined, undefined)).toEqual({ kind: 'rejected', reason: 'no-data' })
  })

  it('creates and marks a new DSH_HOME the person chose to use', () => {
    const env = join(root, 'new', 'place')
    const next = adoptEnvLocation(env, pointerAt('/old'))
    expect(readDataId(env)).toEqual({ kind: 'ok', id: next.dataId })
    expect(next).toMatchObject({ path: env, lastSeenEnv: env })
    expect(next.dataId).not.toBe(ID_A)
  })

  it('records a declined DSH_HOME as seen so the next launch does not ask again', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const declined = join(root, 'typo')
    const kept = keepPointerOverEnv(declined, pointerAt(dir))
    expect(kept).toEqual(pointerAt(dir, { lastSeenEnv: declined }))
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: kept, from: 'main' }, env: declined, defaultHome }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })
})
