/**
 * Registry behavior on `session-persistence/relocated`: the header index swaps
 * before the listener returns, and queued work moves durable membership from
 * workspaces at other paths to the workspace at the new cwd.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import WorkspaceRegistry from '../src/index.ts'
import type { Workspace, WorkspaceRecord } from '../src/index.ts'

const SESSION = SessionId('relocated')

const headerAt = (cwd: string): SessionHeader => ({
  version: SESSION_FORMAT_VERSION,
  id: SESSION,
  createdAt: 1,
  isSeeded: false,
  cwd,
})

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function directory(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await mkdir(path, { recursive: true })
  return path
}

/** Boot the registry over one stored session at `origin`; bootstrap groups it into a workspace there. */
async function boot(origin: (root: string) => Promise<string>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-relocate-')))
  roots.push(root)
  const from = await origin(root)
  const pool = new MemoryMediaPool()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  let stored = headerAt(from)
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    [{ header: stored, revision: SessionPersistenceRevision('stored') }])
  ctx.provide('sessionPersistence', { list } as never)
  const warnings: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.workspaceRegistry
  const origins = registry.list()
  expect(origins.map(workspace => [workspace.path, workspace.sessionIds])).toEqual([[from, [SESSION]]])
  changes.length = 0

  /** Emit the event a backend sends after moving the session to `cwd`; record writes are counted from here. */
  const relocate = (cwd: string): void => {
    changes.length = 0
    const previous = stored
    stored = headerAt(cwd)
    ctx.emit('session-persistence/relocated', SESSION, previous, {
      header: stored,
      revision: SessionPersistenceRevision('moved'),
    })
  }
  /** Resolve after every registry operation queued so far settles. */
  const drain = (): Promise<void> => registry.unarchiveSession(SessionId('drain'))
  const storedIds = (workspace: Workspace): readonly SessionId[] =>
    (pool.media.get('workspace')!.tables.get('workspaces')!.get(workspace.id) as WorkspaceRecord).sessionIds
  const writtenKeys = (): string[] =>
    changes.filter(change => change.table === 'workspaces').map(change => change.key)
  return { ctx, root, from, origin: origins[0] as Workspace, pool, registry, relocate, drain, storedIds, writtenKeys, warnings }
}

describe('WorkspaceRegistry on session-persistence/relocated', () => {
  it('validates an attach issued right after the event and moves durable membership', async () => {
    const run = await boot(root => directory(root, 'old'))
    const target = await run.registry.create(await directory(run.root, 'new'))
    const unrelated = await run.registry.create(await directory(run.root, 'unrelated'))
    run.relocate(target.path)

    // No await between the event and the attach: only the synchronous index swap can validate it.
    await target.attachSession(SESSION)
    expect(run.origin.sessionIds).toEqual([])
    expect(target.sessionIds).toEqual([SESSION])

    await run.drain()
    expect(run.storedIds(run.origin)).toEqual([])
    expect(run.storedIds(target)).toEqual([SESSION])
    expect(run.storedIds(unrelated)).toEqual([])
    // The caller's attach and the queued detach race on I/O; each record is written once.
    expect(run.writtenKeys().toSorted()).toEqual([target.id, run.origin.id].toSorted())
    expect(run.warnings).toEqual([])
  })

  it('attaches the session to the workspace at its new path without a caller', async () => {
    const run = await boot(root => directory(root, 'old'))
    const target = await run.registry.create(await directory(run.root, 'new'))
    run.relocate(target.path)
    await run.drain()

    expect(run.storedIds(run.origin)).toEqual([])
    expect(run.storedIds(target)).toEqual([SESSION])
    expect(run.writtenKeys()).toEqual([run.origin.id, target.id])
  })

  it('only detaches when no workspace owns the new path, and a later workspace there can attach it', async () => {
    const run = await boot(root => directory(root, 'old'))
    const fresh = await directory(run.root, 'fresh')
    run.relocate(fresh)
    await run.drain()

    expect(run.storedIds(run.origin)).toEqual([])
    expect(run.registry.list().flatMap(workspace => workspace.sessionIds)).toEqual([])
    expect(run.warnings).toEqual([])
    const created = await run.registry.create(fresh)
    await created.attachSession(SESSION)
    expect(run.storedIds(created)).toEqual([SESSION])
  })

  it.each([
    ['is not a directory', async (root: string) => {
      const file = join(root, 'file')
      await writeFile(file, '')
      return file
    }],
    ['does not resolve', (root: string) => Promise.resolve(join(root, 'missing'))],
  ])('detaches and warns when the new cwd %s', async (reason, target) => {
    const run = await boot(root => directory(root, 'old'))
    const cwd = await target(run.root)
    run.relocate(cwd)
    await run.drain()

    expect(run.storedIds(run.origin)).toEqual([])
    expect(run.warnings).toEqual([
      `workspace: relocated session '${SESSION}' joins no workspace: cwd '${cwd}' ${reason}`,
    ])
  })

  it('logs a failed move and keeps serving later registry operations', async () => {
    const run = await boot(root => directory(root, 'old'))
    run.pool.failNextWrites = 1
    run.relocate(await directory(run.root, 'new'))
    await run.drain()

    expect(run.warnings).toEqual([
      expect.stringContaining(`workspace: re-indexing relocated session '${SESSION}' failed: `),
    ])
    expect(run.storedIds(run.origin)).toEqual([SESSION])
    const later = await run.registry.create(await directory(run.root, 'later'))
    expect(run.registry.get(later.id)).toBe(later)
  })
})
