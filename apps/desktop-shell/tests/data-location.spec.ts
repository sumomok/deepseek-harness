/**
 * The data-location pointer: reading and writing it, the identity marker both
 * sides carry, and the decision each launch makes between the default home,
 * the pointer, and an explicit `DSH_HOME`.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adoptEnvLocation, canAdoptEnv, checkChosenFolder, commitReady, DATA_ID_FILENAME, ensureDataId, hasHarnessStructure, isSetAside,
  keepPointerOverEnv, looksLikeHarnessHome, MOVE_STATE_FILENAME, normalizeDshHome, POINTER_BACKUP_FILENAME, POINTER_FILENAME,
  POINTER_VERSION, readDataId, readPointer, resolveDataLocation, RETIRED_FILENAME, writePointer,
  dataReference, GENERATION_FILENAME, readGeneration, withGeneration, writeGeneration,
  type DataId, type DataLocationPointer, type EnvUnverifiedReason,
} from '../src/data-location.ts'
import type { AbandonedCopy, MoveId } from '../src/move/journal.ts'

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

const posixOnly = process.platform === 'win32' ? it.skip : it
/** No abandoned copies and no reference. */
const NONE = { abandoned: [], reference: undefined }

const ID_A = '11111111-2222-4333-8444-555555555555' as DataId
const ID_B = '99999999-8888-4777-8666-555555555555' as DataId

/** A data directory under the temporary root, optionally with a marker and Harness structure. */
function dataDir(name: string, options: { id?: string; structure?: boolean } = {}): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  if (options.id !== undefined) writeFileSync(join(dir, DATA_ID_FILENAME), `${options.id}\n`)
  if (options.structure === true) {
    mkdirSync(join(dir, 'sessions'))
    mkdirSync(join(dir, 'profiles'))
  }
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
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: first })
    expect(existsSync(join(userData, POINTER_BACKUP_FILENAME))).toBe(false)
    const second = pointerAt('/data/two')
    writePointer(userData, second)
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: second })
    expect(JSON.parse(readFileSync(join(userData, POINTER_BACKUP_FILENAME), 'utf8'))).toEqual(first)
    expect(existsSync(join(userData, `${POINTER_FILENAME}.${String(process.pid)}.tmp`))).toBe(false)
  })

  it('reports a corrupt main file as corrupt, carrying the backup only as a suggestion', () => {
    const good = pointerAt('/data/one')
    writePointer(userData, good)
    writePointer(userData, pointerAt('/data/two'))
    writeFileSync(join(userData, POINTER_FILENAME), '{ not json')
    const read = readPointer(userData)
    expect(read).toMatchObject({ kind: 'corrupt', backup: good })
    expect(read.kind === 'corrupt' && read.detail).toContain('is not JSON')
    expect(resolveDataLocation({ read, env: undefined, defaultHome, abandoned: [] }))
      .toMatchObject({ kind: 'unavailable', reason: 'pointer-unreadable', suggestion: good })
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

  it('reports a backup left without a main file as corrupt, carrying the backup', () => {
    const good = pointerAt('/data/one')
    writeFileSync(join(userData, POINTER_BACKUP_FILENAME), JSON.stringify(good))
    const read = readPointer(userData)
    expect(read).toMatchObject({ kind: 'corrupt', backup: good })
    expect(read.kind === 'corrupt' && read.detail).toContain('is missing')
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

  it('recognizes a Harness home to adopt by two of its top-level folders, never one', () => {
    expect(looksLikeHarnessHome(dataDir('plain'))).toBe(false)
    expect(looksLikeHarnessHome(dataDir('home', { structure: true }))).toBe(true)
    const storages = dataDir('storages-home')
    for (const name of ['sessions', 'storages']) mkdirSync(join(storages, name))
    expect(looksLikeHarnessHome(storages)).toBe(true)
    // What a home holds after one start with no conversation yet (seen on a fresh DSH_HOME).
    const fresh = dataDir('fresh-home')
    for (const name of ['profiles', 'storages']) mkdirSync(join(fresh, name))
    expect(looksLikeHarnessHome(fresh)).toBe(true)
    for (const only of ['sessions', 'profiles', 'storages', 'attachments']) {
      const dir = dataDir(`only-${only}`)
      mkdirSync(join(dir, only))
      expect(looksLikeHarnessHome(dir)).toBe(false)
      // A move still refuses to take such a folder over.
      expect(hasHarnessStructure(dir)).toBe(true)
    }
    expect(hasHarnessStructure(dataDir('plain2'))).toBe(false)
  })
})

describe('resolveDataLocation without a pointer', () => {
  it('uses the default home, or the explicit DSH_HOME, as before', () => {
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'ready', home: defaultHome, via: 'default' })
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: '/somewhere', defaultHome, abandoned: [] }))
      .toEqual({ kind: 'ready', home: '/somewhere', via: 'env' })
  })

  it('stops on an unreadable pointer instead of falling back to the default home', () => {
    expect(resolveDataLocation({ read: { kind: 'corrupt', detail: 'x' }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'unavailable', reason: 'pointer-unreadable', detail: 'x' })
  })
})

describe('resolveDataLocation with a pointer', () => {
  it('uses the pointer when its directory carries the same identity', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir) }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })

  it('is unavailable when the directory is missing, never the default home', () => {
    const pointer = pointerAt(join(root, 'unplugged', 'DSH-Data'))
    mkdirSync(defaultHome, { recursive: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'unavailable', reason: 'missing', pointer })
  })

  it('is unavailable when the directory carries another identity or none', () => {
    const other = pointerAt(dataDir('other', { id: ID_B }))
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: other }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'unavailable', reason: 'id-mismatch', pointer: other })
    const none = pointerAt(dataDir('none', { structure: true }))
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: none }, env: undefined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'unavailable', reason: 'id-mismatch', pointer: none })
  })

  it('keeps the pointer when DSH_HOME equals the value last seen', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('old', { id: ID_B })
    const pointer = pointerAt(dir, { lastSeenEnv: env })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })

  it('records a new DSH_HOME equal to the pointer as seen without moving', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir) }, env: dir, defaultHome, abandoned: [] })
    expect(resolution).toEqual({ kind: 'ready', home: dir, via: 'pointer', pointer: pointerAt(dir, { lastSeenEnv: dir }) })
  })

  it('follows a new DSH_HOME whose directory carries an identity, adopting it', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('elsewhere', { id: ID_B })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir) }, env, defaultHome, abandoned: [] })
    expect(resolution.kind === 'ready' && resolution.via).toBe('followed-env')
    expect(resolution.kind === 'ready' && resolution.home).toBe(env)
    expect(resolution.kind === 'ready' && resolution.pointer).toMatchObject({ path: env, dataId: ID_B, lastSeenEnv: env })
    expect(resolution.kind === 'ready' && resolution.adoptId).toBeUndefined()
  })

  it('follows a new DSH_HOME that is a Harness home without a marker, asking for one', () => {
    const dir = dataDir('DSH-Data', { id: ID_A })
    const env = dataDir('legacy', { structure: true })
    const resolution = resolveDataLocation({ read: { kind: 'ok', pointer: pointerAt(dir) }, env, defaultHome, abandoned: [] })
    expect(resolution).toMatchObject({ kind: 'ready', home: env, via: 'followed-env', adoptId: true })
  })

  it('asks before following a new DSH_HOME that is missing or holds no Harness data', () => {
    const pointer = pointerAt(dataDir('DSH-Data', { id: ID_A }))
    const missing = join(root, 'typo')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: missing, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: missing, pointer, reason: 'missing' })
    const empty = dataDir('empty')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: empty, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: empty, pointer, reason: 'not-harness-data' })
  })

  it('asks, without offering to adopt it, about a new DSH_HOME that is a file or holds damaged data', () => {
    const pointer = pointerAt(dataDir('DSH-Data', { id: ID_A }))
    const file = join(root, 'a-file')
    writeFileSync(file, 'x')
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: file, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: file, pointer, reason: 'not-a-folder' })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: join(file, 'below'), defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: join(file, 'below'), pointer, reason: 'not-a-folder' })
    const badMarker = dataDir('bad', { id: 'garbage', structure: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: badMarker, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: badMarker, pointer, reason: 'damaged-data' })
    if (process.platform !== 'win32') {
      const dangling = join(root, 'dangling')
      symlinkSync(join(root, 'Unplugged', 'DSH-Data'), dangling)
      for (const env of [dangling, join(dangling, 'below')]) {
        expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env, defaultHome, abandoned: [] }))
          .toEqual({ kind: 'confirm-env', envPath: env, pointer, reason: 'not-a-folder' })
      }
      const linked = join(root, 'linked')
      symlinkSync(dataDir('real'), linked)
      for (const env of [join(root, 'new', 'place'), join(linked, 'new')]) {
        expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env, defaultHome, abandoned: [] }))
          .toEqual({ kind: 'confirm-env', envPath: env, pointer, reason: 'missing' })
      }
    }
    expect(['missing', 'not-harness-data', 'not-a-folder', 'damaged-data', 'set-aside', 'older', 'cannot-create']
      .map(reason => canAdoptEnv(reason as EnvUnverifiedReason)))
      .toEqual([true, true, false, false, false, false, false])
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
    expect(readPointer(userData)).toEqual({ kind: 'ok', pointer: committed })
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
    expect(checkChosenFolder(dataDir('none'), pointer, undefined, NONE)).toEqual({ kind: 'rejected', reason: 'no-data' })
    expect(checkChosenFolder(dataDir('other', { id: ID_B }), pointer, undefined, NONE)).toEqual({ kind: 'rejected', reason: 'other-data' })
    const same = dataDir('same', { id: ID_A })
    const accepted = checkChosenFolder(same, pointer, undefined, NONE)
    expect(accepted).toMatchObject({ kind: 'accepted', pointer: { path: same, dataId: ID_A, lastSeenEnv: '/env' } })
    expect(checkChosenFolder(same, pointer, '/env2', NONE)).toMatchObject({ pointer: { lastSeenEnv: '/env2' } })
  })

  it('accepts any marked folder when the pointer was unreadable', () => {
    const picked = dataDir('picked', { id: ID_B })
    expect(checkChosenFolder(picked, undefined, undefined, NONE)).toMatchObject({ kind: 'accepted', pointer: { path: picked, dataId: ID_B } })
    expect(checkChosenFolder(dataDir('none'), undefined, undefined, NONE)).toEqual({ kind: 'rejected', reason: 'no-data' })
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
    expect(resolveDataLocation({ read: { kind: 'ok', pointer: kept }, env: declined, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'ready', home: dir, via: 'pointer' })
  })
})

describe('folders a data move set aside', () => {
  /** A folder with this data's identity, the Harness structure, and one move marker. */
  function marked(name: string, marker: string): string {
    const dir = dataDir(name, { id: ID_A, structure: true })
    writeFileSync(join(dir, marker), 'm\n')
    return dir
  }
  const markers = [MOVE_STATE_FILENAME, RETIRED_FILENAME]
  const copyAt = (path: string): AbandonedCopy => ({ path, dataId: ID_A, moveId: 'm' as MoveId, abandonedAt: '' })

  it('are never used through the pointer', () => {
    for (const marker of markers) {
      const pointer = pointerAt(marked(`p${marker}`, marker))
      expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: undefined, defaultHome, abandoned: [] }))
        .toEqual({ kind: 'unavailable', reason: 'set-aside', pointer, escapable: false })
    }
    const copy = dataDir('abandoned', { id: ID_A, structure: true })
    const pointer = pointerAt(copy)
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: undefined, defaultHome, abandoned: [copyAt(copy)] }))
      .toEqual({ kind: 'unavailable', reason: 'set-aside', pointer, escapable: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: undefined, defaultHome, abandoned: [] }))
      .toMatchObject({ kind: 'ready', home: copy })
  })

  it('are never followed through a changed DSH_HOME, and cannot be adopted', () => {
    const pointer = pointerAt(dataDir('DSH-Data', { id: ID_A }))
    for (const marker of markers) {
      const env = marked(`e${marker}`, marker)
      expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env, defaultHome, abandoned: [] }))
        .toEqual({ kind: 'confirm-env', envPath: env, pointer, reason: 'set-aside' })
      // Without the identity, only the structure: a partial copy is not taken for a legacy home.
      removeId(env)
      expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env, defaultHome, abandoned: [] }))
        .toEqual({ kind: 'confirm-env', envPath: env, pointer, reason: 'set-aside' })
    }
    const copy = dataDir('abandoned', { id: ID_A, structure: true })
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: copy, defaultHome, abandoned: [copyAt(copy)] }))
      .toEqual({ kind: 'confirm-env', envPath: copy, pointer, reason: 'set-aside' })
    expect(canAdoptEnv('set-aside')).toBe(false)
  })

  it('are never used as the default home or DSH_HOME without a pointer', () => {
    for (const marker of markers) {
      mkdirSync(defaultHome, { recursive: true })
      writeFileSync(join(defaultHome, marker), 'm\n')
      expect(resolveDataLocation({ read: { kind: 'absent' }, env: undefined, defaultHome, abandoned: [] }))
        .toEqual({ kind: 'unavailable', reason: 'set-aside', path: defaultHome, escapable: false })
      const env = marked(`n${marker}`, marker)
      expect(resolveDataLocation({ read: { kind: 'absent' }, env, defaultHome, abandoned: [] }))
        .toEqual({ kind: 'unavailable', reason: 'set-aside', path: env, escapable: false })
      removeFile(join(defaultHome, marker))
    }
    const copy = dataDir('abandoned', { id: ID_A, structure: true })
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: copy, defaultHome, abandoned: [copyAt(copy)] }))
      .toEqual({ kind: 'unavailable', reason: 'set-aside', path: copy, escapable: true })
  })

  it('are refused when the person picks them', () => {
    for (const marker of markers) {
      const dir = marked(`c${marker}`, marker)
      expect(checkChosenFolder(dir, pointerAt('/gone'), undefined, NONE)).toEqual({ kind: 'rejected', reason: 'set-aside' })
      expect(checkChosenFolder(dir, undefined, undefined, NONE)).toEqual({ kind: 'rejected', reason: 'set-aside' })
    }
    const copy = dataDir('abandoned', { id: ID_A })
    expect(checkChosenFolder(copy, pointerAt('/gone'), undefined, { abandoned: [copyAt(copy)], reference: undefined })).toEqual({ kind: 'rejected', reason: 'set-aside' })
    expect(checkChosenFolder(copy, pointerAt('/gone'), undefined, { abandoned: [{ ...copyAt(copy), dataId: ID_B }], reference: undefined })).toMatchObject({ kind: 'accepted' })
  })

  it('match a recorded path as the platform compares names', () => {
    if (process.platform !== 'darwin' && process.platform !== 'win32') return
    const copy = dataDir('Abandoned', { id: ID_A })
    const recorded = `${realpathSync(copy).toUpperCase()}${process.platform === 'win32' ? '\\' : '/'}`
    expect(isSetAside(copy, { abandoned: [copyAt(recorded)], reference: undefined })).toBe(true)
  })

  posixOnly('match an abandoned copy by its real path, so a link to the data in use at a recorded path is used', () => {
    const live = dataDir('DSH-Data', { id: ID_A, structure: true })
    const oldHome = join(root, 'home', '.dsh')
    mkdirSync(join(root, 'home'), { recursive: true })
    symlinkSync(live, oldHome)
    const abandoned = [copyAt(oldHome)]
    const pointer = pointerAt(live)
    expect(isSetAside(oldHome, { abandoned, reference: undefined })).toBe(false)
    expect(resolveDataLocation({ read: { kind: 'ok', pointer }, env: oldHome, defaultHome: oldHome, abandoned }))
      .toMatchObject({ kind: 'ready', home: oldHome, via: 'followed-env' })
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: undefined, defaultHome: oldHome, abandoned }))
      .toEqual({ kind: 'ready', home: oldHome, via: 'default' })
  })
})

/**
 * Remove a folder's identity marker.
 * @param dir - the folder.
 */
function removeId(dir: string): void {
  removeFile(join(dir, DATA_ID_FILENAME))
}

/**
 * Remove a file.
 * @param path - the file.
 */
function removeFile(path: string): void {
  unlinkSync(path)
}

describe('generations', () => {
  it('sets aside a folder with the identity in use and a lower number than the pointer or the pointer\'s folder', () => {
    const live = dataDir('live', { id: ID_A, structure: true })
    writeGeneration(live, 3)
    const old = dataDir('old', { id: ID_A, structure: true })
    writeGeneration(old, 2)
    const pointer = pointerAt(live, { generation: 3 })
    const read = { kind: 'ok' as const, pointer }
    expect(resolveDataLocation({ read, env: old, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'confirm-env', envPath: old, pointer, reason: 'older' })
    // A pointer one step behind its folder (a crash between the two writes) still takes the folder's number.
    const lagging = { kind: 'ok' as const, pointer: pointerAt(live, { generation: 2 }) }
    expect(dataReference(lagging, defaultHome)).toEqual({ dataId: ID_A, generation: 3 })
    expect(resolveDataLocation({ read: lagging, env: undefined, defaultHome, abandoned: [] })).toMatchObject({ kind: 'ready', home: live })
    expect(resolveDataLocation({ read: lagging, env: old, defaultHome, abandoned: [] })).toMatchObject({ reason: 'older' })
    // Another identity is never compared by number.
    const other = dataDir('other', { id: ID_B, structure: true })
    expect(resolveDataLocation({ read, env: other, defaultHome, abandoned: [] })).toMatchObject({ kind: 'ready', home: other })
    // A pointer naming the older folder is refused, with the way back offered.
    const stale = { kind: 'ok' as const, pointer: pointerAt(old, { generation: 3 }) }
    expect(resolveDataLocation({ read: stale, env: undefined, defaultHome, abandoned: [] }))
      .toMatchObject({ kind: 'unavailable', reason: 'older', escapable: true })
  })

  it('reads an absent or unreadable number as 0, which never makes a folder the newest', () => {
    const dir = dataDir('numbered', { id: ID_A })
    expect(readGeneration(dir)).toBe(0)
    writeFileSync(join(dir, GENERATION_FILENAME), 'garbage\n')
    expect(readGeneration(dir)).toBe(0)
    writeGeneration(dir, 12)
    expect(readGeneration(dir)).toBe(12)
    const damaged = dataDir('damaged', { id: ID_A })
    writeFileSync(join(damaged, GENERATION_FILENAME), '99x\n')
    const read = { kind: 'ok' as const, pointer: pointerAt(dir, { generation: 12 }) }
    expect(resolveDataLocation({ read, env: damaged, defaultHome, abandoned: [] })).toMatchObject({ reason: 'older' })
  })

  it('takes the reference from the default home when there is no pointer', () => {
    mkdirSync(defaultHome, { recursive: true })
    writeFileSync(join(defaultHome, DATA_ID_FILENAME), `${ID_A}\n`)
    writeGeneration(defaultHome, 4)
    const old = dataDir('old', { id: ID_A })
    writeGeneration(old, 3)
    expect(dataReference({ kind: 'absent' }, defaultHome)).toEqual({ dataId: ID_A, generation: 4 })
    expect(resolveDataLocation({ read: { kind: 'absent' }, env: old, defaultHome, abandoned: [] }))
      .toEqual({ kind: 'unavailable', reason: 'older', path: old, escapable: true })
  })

  it('gives a pointer that names another folder that folder\'s number, never the old one', () => {
    const live = dataDir('live', { id: ID_A })
    writeGeneration(live, 5)
    const pointer = pointerAt(live, { generation: 5 })
    const elsewhere = dataDir('elsewhere', { id: ID_B })
    const followed = resolveDataLocation({ read: { kind: 'ok', pointer }, env: elsewhere, defaultHome, abandoned: [] })
    expect(followed.kind === 'ready' ? followed.pointer?.generation : 'x').toBeUndefined()
    const legacy = dataDir('legacy', { structure: true })
    const adopted = resolveDataLocation({ read: { kind: 'ok', pointer }, env: legacy, defaultHome, abandoned: [] })
    expect(adopted.kind === 'ready' ? adopted.pointer?.generation : 'x').toBeUndefined()
    expect(adoptEnvLocation(join(root, 'fresh'), pointer).generation).toBeUndefined()
    const picked = dataDir('picked', { id: ID_A })
    writeGeneration(picked, 9)
    expect(checkChosenFolder(picked, pointerAt('/gone', { generation: 5 }), undefined, NONE))
      .toMatchObject({ kind: 'accepted', pointer: { path: picked, generation: 9 } })
    expect(withGeneration(pointerAt(live, { generation: 5 }), 0)).toEqual(pointerAt(live))
  })

  it('reads a pointer\'s number and refuses one that is not a count', () => {
    writePointer(userData, pointerAt('/data', { generation: 4 }))
    expect(readPointer(userData)).toMatchObject({ kind: 'ok', pointer: { generation: 4 } })
    writeFileSync(join(userData, POINTER_FILENAME), JSON.stringify({ ...pointerAt('/data'), generation: -1 }))
    expect(readPointer(userData)).toMatchObject({ kind: 'corrupt' })
  })
})
