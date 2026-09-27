/**
 * Copying a home and checking the copy: what is copied and what is not, link
 * rewriting, permissions, resuming from the done log, every problem the check
 * reports, and the same jobs on a worker thread.
 * @module
 */

import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyTree, forgetDone, parseDoneLog, planLinkResolved, readDoneLog, type CopyRequest } from '../src/move/copier.ts'
import type { LinkMove } from '../src/move/links.ts'
import { REBUILDABLE_ENTRIES } from '../src/move/tree.ts'
import { verifyTree, type VerifyRequest } from '../src/move/verify.ts'
import { MoveJobError, runMoveJob } from '../src/move/worker.ts'
import { buildFixture, listTree, type Fixture } from './move-fixture.ts'

let fixture: Fixture | undefined

afterEach(async () => {
  if (fixture !== undefined) {
    for (const dir of [fixture.home, join(fixture.targetParent, 'partial')]) {
      if (existsSync(dir)) chmodTree(dir)
    }
    await rm(fixture.root, { recursive: true, force: true })
  }
  fixture = undefined
})

/**
 * Give every directory below `dir` write permission so the test can clean up.
 * @param dir - the root.
 */
function chmodTree(dir: string): void {
  for (const line of listTree(dir)) {
    if (line.startsWith('dir ')) chmodSync(join(dir, line.slice(4)), 0o700)
  }
}

/**
 * A copy request for the fixture: into `partial`, finally living at `DSH-Data`.
 * @param f - the fixture.
 * @returns the request.
 */
function request(f: Fixture): CopyRequest {
  const links: LinkMove = { sourceRoots: [f.home], destRoot: join(f.targetParent, 'DSH-Data'), platform: process.platform }
  return {
    source: f.home,
    dest: join(f.targetParent, 'partial'),
    exclude: [...REBUILDABLE_ENTRIES, '.dsh-data-id'],
    links,
    doneLog: join(f.root, 'done.jsonl'),
  }
}

/**
 * The check for the same copy.
 * @param f - the fixture.
 * @param hash - what to hash.
 * @returns the request.
 */
function check(f: Fixture, hash: VerifyRequest['hash'] = 'all'): VerifyRequest {
  return { ...request(f), hash }
}

const posixOnly = process.platform === 'win32' ? it.skip : it

describe('copyTree', () => {
  posixOnly('copies the data, leaves out the identity and the rebuildable entries, and rewrites links into the home', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    const report = await copyTree(req)
    expect(report.skipped).toBe(0)
    const dest = req.dest
    expect(existsSync(join(dest, '.dsh-data-id'))).toBe(false)
    for (const excluded of REBUILDABLE_ENTRIES) expect(existsSync(join(dest, ...excluded.split('/')))).toBe(false)
    const nm = join(dest, 'profiles', 'desktop-shell', 'node_modules')
    expect(readlinkSync(join(nm, 'clsx'))).toBe(join(req.links.destRoot, 'profiles', 'desktop-shell', '.dsh-module-fallback', 'node_modules', 'clsx'))
    expect(readlinkSync(join(nm, 'clsx-relative'))).toBe('../.dsh-module-fallback/node_modules/clsx')
    expect(readlinkSync(join(nm, 'outside'))).toBe(fixture.sentinel)
    expect(readlinkSync(join(nm, 'dangling-inside'))).toBe(join(req.links.destRoot, 'profiles', 'missing'))
    expect(lstatSync(join(dest, '.credentials.yaml')).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(dest, 'attachments', 'v1', 'objects', 'read-only.txt')).mode & 0o777).toBe(0o444)
    const big = ['attachments', 'v1', 'objects', 'big.bin']
    expect(readFileSync(join(dest, ...big)).equals(readFileSync(join(fixture.home, ...big)))).toBe(true)
    expect((await verifyTree(check(fixture))).problems).toEqual([])
  })

  it('reports progress up to the total', async () => {
    fixture = await buildFixture()
    const seen: number[] = []
    let total = 0
    await copyTree(request(fixture), undefined, (progress) => {
      seen.push(progress.done)
      total = progress.total
    })
    expect(seen.at(-1)).toBe(total)
    expect(seen).toEqual([...seen].sort((a, b) => a - b))
  })

  it('skips what the done log holds and copies again what changed since', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    expect((await copyTree(req)).copied).toEqual([])
    // Same size, new content: only the source's modification time tells.
    const file = join(fixture.home, 'storages', 'workspace.json')
    writeFileSync(file, '[]\n')
    utimesSync(file, new Date(), new Date(Date.now() + 5000))
    expect((await copyTree(req)).copied).toEqual(['storages/workspace.json'])
    expect(readFileSync(join(req.dest, 'storages', 'workspace.json'), 'utf8')).toBe('[]\n')
  })

  it('copies again a file whose copy is not the recorded size', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    writeFileSync(join(req.dest, 'attachments', 'v1', 'objects', 'big.bin'), 'short')
    expect((await copyTree(req)).copied).toEqual(['attachments/v1/objects/big.bin'])
  })

  it('copies again what a forgotten record named', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    forgetDone(req.doneLog, new Set(['.anonymous-user-id']))
    expect(readDoneLog(req.doneLog).has('.anonymous-user-id')).toBe(false)
    expect((await copyTree(req)).copied).toEqual(['.anonymous-user-id'])
  })

  posixOnly('copies into a read-only directory it copied before, and gives it back its mode', async () => {
    fixture = await buildFixture()
    mkdirSync(join(fixture.home, 'locked'))
    writeFileSync(join(fixture.home, 'locked', 'f'), 'one')
    chmodSync(join(fixture.home, 'locked'), 0o555)
    const req = request(fixture)
    await copyTree(req)
    expect(lstatSync(join(req.dest, 'locked')).mode & 0o777).toBe(0o555)
    chmodSync(join(fixture.home, 'locked'), 0o755)
    writeFileSync(join(fixture.home, 'locked', 'f'), 'two!')
    await copyTree(req)
    expect(readFileSync(join(req.dest, 'locked', 'f'), 'utf8')).toBe('two!')
    expect(lstatSync(join(req.dest, 'locked')).mode & 0o777).toBe(0o755)
  })

  it('stops when aborted', async () => {
    fixture = await buildFixture()
    const controller = new AbortController()
    controller.abort()
    await expect(copyTree(request(fixture), controller.signal)).rejects.toThrow()
  })
})

describe('the done log', () => {
  it('ignores a torn line and lets a later line win', () => {
    const sha = 'a'.repeat(64)
    const text = [
      JSON.stringify({ rel: 'a', size: 1, mtimeMs: 1, ino: 1, sha256: sha }),
      JSON.stringify({ rel: 'a', size: 2, mtimeMs: 1, ino: 1, sha256: sha }),
      JSON.stringify({ rel: 'b', size: 1, mtimeMs: 1, ino: 1, sha256: 'short' }),
      '{"rel":"c","si',
    ].join('\n')
    const done = parseDoneLog(text)
    expect([...done.keys()]).toEqual(['a'])
    expect(done.get('a')?.size).toBe(2)
  })
})

describe('planLinkResolved', () => {
  posixOnly('rewrites a link that reaches the home through another link', async () => {
    fixture = await buildFixture()
    const alias = join(fixture.root, 'alias')
    symlinkSync(fixture.home, alias)
    const move: LinkMove = { sourceRoots: [fixture.home], destRoot: '/new', platform: process.platform }
    expect(planLinkResolved(join(alias, 'sessions'), 'profiles/x', move)).toEqual({ kind: 'rewrite', target: '/new/sessions', reason: 'inside-root' })
    expect(planLinkResolved(join(alias, 'none'), 'profiles/x', move)).toEqual({ kind: 'keep' })
    expect(planLinkResolved(fixture.sentinel, 'profiles/x', move)).toEqual({ kind: 'keep' })
  })
})

describe('verifyTree', () => {
  it('finds a copy whose content changed, only when asked to hash it', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    const copy = join(req.dest, 'attachments', 'v1', 'objects', 'big.bin')
    const bytes = readFileSync(copy)
    bytes[100] = (bytes[100] ?? 0) ^ 0xff
    writeFileSync(copy, bytes)
    expect((await verifyTree(check(fixture, 'none'))).problems).toEqual([])
    expect((await verifyTree(check(fixture, ['attachments/v1/objects/big.bin']))).problems)
      .toEqual([{ kind: 'content', rel: 'attachments/v1/objects/big.bin' }])
    expect((await verifyTree(check(fixture))).problems).toEqual([{ kind: 'content', rel: 'attachments/v1/objects/big.bin' }])
  })

  it('finds missing, extra, retyped, unrecorded, and changed-at-source entries', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    unlinkSync(join(req.dest, '.anonymous-user-id'))
    writeFileSync(join(req.dest, 'stray.txt'), '')
    writeFileSync(join(fixture.home, 'new.txt'), 'new')
    writeFileSync(join(req.dest, 'new.txt'), 'new')
    await rm(join(req.dest, 'storages', 'workspace.json'), { force: true })
    mkdirSync(join(req.dest, 'storages', 'workspace.json'))
    const problems = (await verifyTree(check(fixture))).problems
    expect(problems).toEqual(expect.arrayContaining([
      { kind: 'missing', rel: '.anonymous-user-id' },
      { kind: 'extra', rel: 'stray.txt' },
      { kind: 'not-recorded', rel: 'new.txt' },
      { kind: 'type', rel: 'storages/workspace.json' },
    ]))
    const source = join(fixture.home, 'sessions', '--Users-p-proj--', 'sess-1', 'session.v4.jsonl.zstd')
    utimesSync(source, new Date(), new Date(Date.now() + 5000))
    expect((await verifyTree(check(fixture, 'none'))).problems)
      .toContainEqual({ kind: 'source-changed', rel: 'sessions/--Users-p-proj--/sess-1/session.v4.jsonl.zstd' })
  })

  posixOnly('flags a link that resolves into the old home, by its text or on disk', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    const link = join(req.dest, 'profiles', 'desktop-shell', 'node_modules', 'clsx')
    unlinkSync(link)
    // Dangling: nothing on disk to resolve, so only the text shows where it points.
    symlinkSync(join(fixture.home, 'gone'), link)
    expect((await verifyTree(check(fixture, 'none'))).problems).toContainEqual({
      kind: 'link-into-old-root', rel: 'profiles/desktop-shell/node_modules/clsx', resolved: join(fixture.home, 'gone'),
    })
    const alias = join(fixture.root, 'alias')
    symlinkSync(fixture.home, alias)
    unlinkSync(link)
    symlinkSync(join(alias, 'profiles'), link)
    expect((await verifyTree(check(fixture, 'none'))).problems).toContainEqual({
      kind: 'link-into-old-root', rel: 'profiles/desktop-shell/node_modules/clsx', resolved: join(fixture.home, 'profiles'),
    })
  })

  posixOnly('flags a link whose text is not the planned one', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    await copyTree(req)
    const link = join(req.dest, 'profiles', 'desktop-shell', 'node_modules', 'outside')
    unlinkSync(link)
    symlinkSync('/elsewhere', link)
    expect((await verifyTree(check(fixture, 'none'))).problems)
      .toEqual([{ kind: 'link', rel: 'profiles/desktop-shell/node_modules/outside', expected: fixture.sentinel, actual: '/elsewhere' }])
  })
})

describe('runMoveJob', () => {
  it('copies and checks on a worker thread with progress', async () => {
    fixture = await buildFixture()
    const req = request(fixture)
    const seen: number[] = []
    const copied = await runMoveJob({ kind: 'copy', request: req }, { onProgress: (progress) => { seen.push(progress.done) } })
    expect(copied.kind).toBe('copy')
    expect(seen.length).toBeGreaterThan(0)
    const checked = await runMoveJob({ kind: 'verify', request: check(fixture) })
    expect(checked).toMatchObject({ kind: 'verify', problems: [] })
  })

  it('rejects with an aborted error when aborted', async () => {
    fixture = await buildFixture({ bigBytes: 64 * 1024 * 1024 })
    const controller = new AbortController()
    const job = runMoveJob({ kind: 'copy', request: request(fixture) }, {
      signal: controller.signal,
      onProgress: () => { controller.abort() },
    })
    await expect(job).rejects.toSatisfy((error: unknown) => error instanceof MoveJobError && error.aborted)
  })
})
