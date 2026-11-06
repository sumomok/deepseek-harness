/**
 * A Harness home to move, built in a temporary directory: sessions,
 * attachments, a credentials file, profiles with links that point inside the
 * home (absolute and relative), out of it, and at a sentinel directory outside
 * it, an NFD file name, a read-only file, an empty file, a file larger than
 * one read chunk, and the rebuildable entries a move leaves behind.
 * @module
 */

import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'

/** Identity written into the fixture home's marker. */
export const FIXTURE_ID = '11111111-2222-4333-8444-555555555555'

/** The paths of one fixture. */
export interface Fixture {
  /** Temporary directory holding everything below; removed by the caller. */
  root: string
  /** The Harness home to move. */
  home: string
  /** A directory outside the home that one link points at; must survive every move and deletion. */
  sentinel: string
  /** Where a move may put the data. */
  targetParent: string
}

/**
 * A new temporary directory under the system's temporary directory, asserted
 * to be there before anything is written into it.
 * @param prefix - the directory name prefix.
 * @returns its real path.
 */
export async function scratchDir(prefix: string): Promise<string> {
  const dir = realpathSync(await mkdtemp(join(tmpdir(), prefix)))
  expect(dir.startsWith(realpathSync(tmpdir()))).toBe(true)
  return dir
}

/**
 * Build the fixture home.
 * @param options - `bigBytes` sets the size of the large file (default 3 MiB).
 * @returns the fixture's paths.
 */
export async function buildFixture(options: { bigBytes?: number } = {}): Promise<Fixture> {
  const root = await scratchDir('dsh-move-')
  const home = join(root, 'src-parent', '.dsh')
  const sentinel = join(root, 'sentinel')
  const targetParent = join(root, 'dst-parent')
  mkdirSync(targetParent, { recursive: true })
  mkdirSync(sentinel)
  writeFileSync(join(sentinel, 'keep.txt'), 'sentinel\n')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  writeFileSync(join(home, '.dsh-data-id'), `${FIXTURE_ID}\n`, { mode: 0o600 })
  writeFileSync(join(home, '.credentials.yaml'), 'placeholder: not-a-secret\n', { mode: 0o600 })
  writeFileSync(join(home, '.anonymous-user-id'), 'anon\n')
  const session = join(home, 'sessions', '--Users-p-proj--', 'sess-1')
  mkdirSync(session, { recursive: true })
  writeFileSync(join(session, 'session.v4.jsonl.zstd'), randomBytes(4096))
  writeFileSync(join(session, 'session.lock'), '')
  mkdirSync(join(home, 'attachments', 'v1', 'objects'), { recursive: true })
  writeFileSync(join(home, 'attachments', 'v1', 'objects', 'big.bin'), randomBytes(options.bigBytes ?? 3 * 1024 * 1024))
  writeFileSync(join(home, 'attachments', 'v1', 'objects', 'empty.bin'), '')
  const readOnly = join(home, 'attachments', 'v1', 'objects', 'read-only.txt')
  writeFileSync(readOnly, 'read only\n')
  chmodSync(readOnly, 0o444)
  writeFileSync(join(home, 'attachments', 'v1', 'objects', 'café.txt'), 'nfd name\n')
  const profile = join(home, 'profiles', 'desktop-shell')
  const fallback = join(profile, '.dsh-module-fallback', 'node_modules', 'clsx')
  mkdirSync(fallback, { recursive: true })
  writeFileSync(join(fallback, 'index.js'), 'export default 1\n')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  symlinkSync(fallback, join(profile, 'node_modules', 'clsx'), 'junction')
  symlinkSync('../.dsh-module-fallback/node_modules/clsx', join(profile, 'node_modules', 'clsx-relative'))
  symlinkSync(sentinel, join(profile, 'node_modules', 'outside'), 'junction')
  symlinkSync(join(home, 'profiles', 'missing'), join(profile, 'node_modules', 'dangling-inside'))
  mkdirSync(join(home, 'storages', 'session_projcache'), { recursive: true })
  writeFileSync(join(home, 'storages', 'workspace.json'), '{}\n')
  writeFileSync(join(home, 'storages', 'session_projcache.json'), '{}\n')
  writeFileSync(join(home, 'storages', 'session_projcache', 'a.json'), '{}\n')
  mkdirSync(join(home, 'cache', 'attachments'), { recursive: true })
  writeFileSync(join(home, 'cache', 'attachments', 'c.bin'), 'cache\n')
  mkdirSync(join(home, 'session-search'))
  writeFileSync(join(home, 'session-search', 'desktop.db'), 'index\n')
  return { root, home, sentinel, targetParent }
}

/** One line of a tree listing: kind, path, and content digest or link text. */
export type ListingLine = string

/**
 * Everything below `dir` as sorted lines, links not followed, so two trees can
 * be compared as values.
 * @param dir - the directory.
 * @returns one line per entry.
 */
export function listTree(dir: string): ListingLine[] {
  const lines: ListingLine[] = []
  const walk = (rel: string): void => {
    for (const name of readdirSync(rel === '' ? dir : join(dir, rel)).sort()) {
      const child = rel === '' ? name : `${rel}/${name}`
      const path = join(dir, child)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) lines.push(`link ${child} -> ${readlinkSync(path)}`)
      else if (stats.isDirectory()) {
        lines.push(`dir ${child}`)
        walk(child)
      } else lines.push(`file ${child} ${createHash('sha256').update(readFileSync(path)).digest('hex')} ${(stats.mode & 0o777).toString(8)}`)
    }
  }
  walk('')
  return lines
}
