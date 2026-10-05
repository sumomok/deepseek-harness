/**
 * Registry behavior on `session-persistence/relocated`: the header index swaps
 * before the listener returns, and queued work moves durable membership from
 * workspaces at other paths to the workspace at the new cwd. A move whose
 * event the registry missed is detached at the next start, and an attach at
 * the new path detaches the session from any workspace still listing it.
 * Attaches share the registry's mutation queue with that work; the module
 * mock below lands a relocation in the middle of a cwd check.
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

const hooks = vi.hoisted(() => ({
  /** Runs before each `stat` of the registry and its entities proceeds. */
  onStat: undefined as undefined | ((path: string) => void),
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    hooks.onStat?.(String(args[0]))
    return actual.stat(...args)
  }) as typeof actual.stat
  return { ...actual, stat }
})

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
  hooks.onStat = undefined
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

  it('stops listing the session in the old workspace as soon as the event returns', async () => {
    const run = await boot(root => directory(root, 'old'))
    const target = await run.registry.create(await directory(run.root, 'new'))
    run.relocate(target.path)

    // No await after the event: only the synchronous path invalidation hides the session.
    expect(run.origin.sessionIds).toEqual([])
    await run.drain()
    expect(target.sessionIds).toEqual([SESSION])
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

/** Durable state shared by registry instances started one after another, as by Host restarts. */
interface World {
  readonly root: string
  readonly pool: MemoryMediaPool
  /** The header session persistence lists. */
  stored: SessionHeader
  /** Other sessions session persistence lists before it. */
  ahead?: readonly SessionHeader[] | undefined
  /** Other sessions session persistence lists after it. */
  others?: readonly SessionHeader[] | undefined
  /** Runs inside each record write before it reaches the medium. */
  onPut?: ((table: string, key: string, value: unknown) => Promise<void> | void) | undefined
}

async function world(): Promise<World & { readonly from: string; readonly to: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-workspace-missed-')))
  roots.push(root)
  const from = await directory(root, 'old')
  return { root, pool: new MemoryMediaPool(), stored: headerAt(from), from, to: await directory(root, 'new') }
}

/** Start one registry over `world`; `before` composes listeners that run ahead of the registry's. */
async function start(w: World, before?: (ctx: Context) => void) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  const backend = new MemoryStorageBackend(w.pool)
  const open = backend.kv.open.bind(backend.kv)
  backend.kv.open = async (descriptor) => {
    const unit = await open(descriptor)
    const put = unit.putRecord.bind(unit)
    unit.putRecord = async (table, key, value) => {
      await w.onPut?.(table, key, value)
      await put(table, key, value)
    }
    return unit
  }
  ctx.storage.backend.register('memory', backend)
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', facility)
  ctx.provide('storageDomain', facility)
  const list = vi.fn(async (): Promise<SessionPersistenceSnapshot[]> =>
    [...w.ahead ?? [], w.stored, ...w.others ?? []].map(header => ({ header, revision: SessionPersistenceRevision('stored') })))
  ctx.provide('sessionPersistence', { list } as never)
  const written: string[] = []
  ctx.on('domain/changed', (change) => {
    if (change.table === 'workspaces') written.push(change.key)
  })
  const warnings: string[] = []
  const infos: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation((message: unknown) => { warnings.push(String(message)) })
  vi.spyOn(ctx.logger, 'info').mockImplementation((message: unknown) => { infos.push(String(message)) })
  before?.(ctx)
  await ctx.plugin(WorkspaceRegistry)
  const registry = ctx.workspaceRegistry
  const view = (): Array<[string, readonly SessionId[]]> => registry.list().map(workspace => [workspace.path, workspace.sessionIds])
  /** Emit the event a backend sends after moving the session to `cwd`. */
  const relocate = (cwd: string): void => {
    const previous = w.stored
    w.stored = headerAt(cwd)
    ctx.emit('session-persistence/relocated', SESSION, previous, { header: w.stored, revision: SessionPersistenceRevision('moved') })
  }
  /** Resolve after every registry operation queued so far settles. */
  const drain = (): Promise<void> => registry.unarchiveSession(SessionId('drain'))
  const stop = (): Promise<void> => ctx.fiber.dispose()
  return { ctx, registry, written, warnings, infos, view, relocate, drain, stop }
}

function storedIn(w: World, workspace: Workspace): readonly SessionId[] {
  return (w.pool.media.get('workspace')!.tables.get('workspaces')!.get(workspace.id) as WorkspaceRecord).sessionIds
}

/** Restart once more and require the registry to start with the session in `expected` alone. */
async function restartsWith(w: World & { readonly from: string }, expected: Workspace): Promise<void> {
  const again = await start(w)
  expect(again.view()).toEqual([[expected.path, [SESSION]], [w.from, []]])
  expect(again.warnings).toEqual([])
}

describe('WorkspaceRegistry after a relocation event it missed', () => {
  it('detaches a session that moved while the registry was not running at its next start, and the target can attach it', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    await first.stop()

    w.stored = headerAt(w.to)
    const second = await start(w)
    expect(storedIn(w, origin)).toEqual([])
    expect(second.infos).toEqual([
      `workspace '${origin.id}' detached session '${SESSION}': its canonical cwd '${w.to}' differs from workspace path '${w.from}'`,
    ])
    expect(second.view()).toEqual([[w.to, []], [w.from, []]])
    await second.registry.get(target.id)!.attachSession(SESSION)
    expect(storedIn(w, target)).toEqual([SESSION])
    await second.stop()
    await restartsWith(w, target)
  })

  it('detaches at the next start when a listener ahead of the registry threw', async () => {
    const w = await world()
    const first = await start(w, (ctx) => {
      ctx.on('session-persistence/relocated', () => { throw new Error('listener failed') })
    })
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    expect(() => { first.relocate(w.to) }).toThrow('listener failed')
    await first.registry.unarchiveSession(SessionId('drain'))
    expect(storedIn(w, origin)).toEqual([SESSION])
    expect(storedIn(w, target)).toEqual([])
    // Until the next start the index keeps the header from before the move.
    await expect(target.attachSession(SESSION)).rejects.toThrow(`its cwd resolves to '${w.from}'`)
    await first.stop()

    const second = await start(w)
    expect(storedIn(w, origin)).toEqual([])
    await second.registry.get(target.id)!.attachSession(SESSION)
    await second.stop()
    await restartsWith(w, target)
  })

  it('detaches the session from its old workspace when a caller attaches it after the queued detach failed', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    w.pool.failNextWrites = 1
    first.relocate(w.to)
    await first.registry.unarchiveSession(SessionId('drain'))
    expect(first.warnings).toEqual([expect.stringContaining(`workspace: re-indexing relocated session '${SESSION}' failed: `)])
    expect(storedIn(w, origin)).toEqual([SESSION])

    await target.attachSession(SESSION)
    expect(storedIn(w, origin)).toEqual([])
    expect(storedIn(w, target)).toEqual([SESSION])
    await first.stop()
    await restartsWith(w, target)
  })

  it('keeps the sessions of a workspace whose stored path did not resolve at startup', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    await first.stop()

    await rm(w.from, { recursive: true })
    w.stored = headerAt(w.to)
    const second = await start(w)
    expect(storedIn(w, origin)).toEqual([SESSION])
    expect(second.infos).toEqual([])
    expect(second.warnings).toContainEqual(expect.stringContaining(`workspace '${origin.id}' path '${w.from}' kept as stored`))
  })
})

describe('WorkspaceRegistry attaches on its mutation queue', () => {
  it('validates the replacing header when a relocation lands during an attach\'s cwd check', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    await origin.detachSession(SESSION)
    first.written.length = 0
    hooks.onStat = (path) => {
      if (path !== w.from) return
      hooks.onStat = undefined
      first.relocate(w.to)
    }

    // The check of the old header passed, but the index holds the moved header by then.
    await expect(origin.attachSession(SESSION)).rejects.toThrow(`its cwd resolves to '${w.to}'`)
    await first.drain()
    expect(storedIn(w, origin)).toEqual([])
    expect(storedIn(w, target)).toEqual([SESSION])
    expect(first.written).toEqual([target.id])
    await first.stop()
    await restartsWith(w, target)
  })

  it('moves a session whose relocation lands while an attach writes it, after that write', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    await origin.detachSession(SESSION)
    w.onPut = async (table, key, value) => {
      if (table !== 'workspaces' || key !== origin.id || !(value as WorkspaceRecord).sessionIds.includes(SESSION)) return
      w.onPut = undefined
      first.relocate(w.to)
      // A slow durable write: the queued move must wait for it rather than read the table without it.
      await new Promise(resolve => setTimeout(resolve, 100))
    }

    await origin.attachSession(SESSION)
    await first.drain()
    expect(storedIn(w, origin)).toEqual([])
    expect(storedIn(w, target)).toEqual([SESSION])
    await first.stop()
    await restartsWith(w, target)
  })

  it('runs an attach after the create of another workspace that is still writing its record', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    await origin.detachSession(SESSION)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let holding!: () => void
    const held = new Promise<void>((resolve) => { holding = resolve })
    w.onPut = async (table, key) => {
      if (table !== 'workspaces' || key === origin.id) return
      w.onPut = undefined
      holding()
      await gate
    }
    const created = first.registry.create(w.to)
    await held

    let settled = false
    const attached = origin.attachSession(SESSION).finally(() => { settled = true })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    release()
    const target = await created
    await attached
    expect(storedIn(w, origin)).toEqual([SESSION])
    expect(storedIn(w, target)).toEqual([])
  })

  it('keeps a moved session out of its old workspace while a listing read before the move resolves the old header', async () => {
    const w = await world()
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    const other = SessionId('other')
    w.others = [{ ...headerAt(w.from), id: other }]
    let checks = 0
    let listedMeanwhile: readonly SessionId[] | undefined
    hooks.onStat = (path) => {
      if (path !== w.from) return
      checks += 1
      // The attach of an unindexed session lists every header; the move lands while the moved one resolves.
      if (checks === 1) first.relocate(w.to)
      if (checks === 2) listedMeanwhile = origin.sessionIds
    }

    await origin.attachSession(other)
    expect(listedMeanwhile).toEqual([])
    await first.drain()
    expect(storedIn(w, origin)).toEqual([other])
    expect(storedIn(w, target)).toEqual([SESSION])
  })

  it('keeps a moved session out of its old workspace when a listing read before the move indexes it after the event', async () => {
    const w = await world()
    const listedFirst = SessionId('listed-first')
    w.ahead = [{ ...headerAt(w.from), id: listedFirst }]
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    const other = SessionId('other')
    w.others = [{ ...headerAt(w.from), id: other }]
    let moved = false
    const listedMeanwhile: Array<readonly SessionId[]> = []
    hooks.onStat = (path) => {
      if (path !== w.from) return
      // The move lands while the session listed ahead of the moved one resolves.
      if (moved) listedMeanwhile.push(origin.sessionIds)
      else first.relocate(w.to)
      moved = true
    }

    await origin.attachSession(other)
    expect(listedMeanwhile.length).toBeGreaterThan(0)
    expect(listedMeanwhile.filter(ids => ids.includes(SESSION))).toEqual([])
    await first.drain()
    expect(storedIn(w, origin)).toEqual([other, listedFirst])
    expect(storedIn(w, target)).toEqual([SESSION])
  })

  it('validates attaches queued before a move against the moved header when a listing read before the move indexes it after the event', async () => {
    const w = await world()
    const listedFirst = SessionId('listed-first')
    w.ahead = [{ ...headerAt(w.from), id: listedFirst }]
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    await origin.detachSession(SESSION)
    first.written.length = 0
    hooks.onStat = (path) => {
      if (path !== w.from) return
      hooks.onStat = undefined
      first.relocate(w.to)
    }

    // Archiving an unknown id lists every stored header; both attaches queue behind it, before the event.
    const archived = first.registry.archiveSession(SessionId('unknown'))
    const toOrigin = origin.attachSession(SESSION)
    const toTarget = target.attachSession(SESSION)
    await expect(archived).rejects.toThrow('cannot archive session \'unknown\'')
    await expect(toOrigin).rejects.toThrow(`its cwd resolves to '${w.to}'`)
    expect(origin.sessionIds).toEqual([listedFirst])
    await toTarget
    expect(target.sessionIds).toEqual([SESSION])
    await first.drain()
    expect(first.written).toEqual([target.id])
    await first.stop()
    const again = await start(w)
    expect(again.view()).toEqual([[w.to, [SESSION]], [w.from, [listedFirst]]])
    expect(again.warnings).toEqual([])
  })

  it('skips a queued move that a later relocation of the session superseded', async () => {
    const w = await world()
    const third = await directory(w.root, 'third')
    const first = await start(w)
    const origin = first.registry.list()[0]!
    const target = await first.registry.create(w.to)
    const last = await first.registry.create(third)
    first.written.length = 0

    first.relocate(w.to)
    first.relocate(third)
    await first.drain()
    expect(first.written).toEqual([origin.id, last.id])
    expect(storedIn(w, target)).toEqual([])
    expect(storedIn(w, last)).toEqual([SESSION])

    first.written.length = 0
    hooks.onStat = (path) => {
      if (path !== w.to) return
      hooks.onStat = undefined
      first.relocate(third)
    }
    first.relocate(w.to)
    // The superseding event queues its move behind the first drain.
    await first.drain()
    await first.drain()
    // The move to `to` was superseded while it resolved that directory.
    expect(first.written).toEqual([])
    expect(first.view()).toEqual([[third, [SESSION]], [w.to, []], [w.from, []]])
    expect(first.warnings).toEqual([])
  })
})
