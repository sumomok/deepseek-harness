/** Default workspaces: one registration step per member and process, retried after a failure, found again after a restart. */
import { readdirSync, statSync, symlinkSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { Workspace } from '@deepseek-ai/dsh-workspace/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { DefaultWorkspaces, DefaultWorkspaceUnregisteredError, type WorkspaceCreator } from '../src/default-workspace.ts'
import { openRootRegistry, type RootRegistry } from '../src/registry.ts'
import { captureLogs, principal, useTempHome } from './support.ts'

const temp = useTempHome()

const ALICE = principal('login-uid-alice-5501')
const BACKEND_TEXT = 'backend refused /srv/secret-path-9183'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function roots(): RootRegistry {
  return openRootRegistry({
    file: join(temp.home, 'console-members', 'roots.json'),
    membersRoot: join(temp.base, 'members'),
    seeds: [],
    platform: process.platform,
  })
}

function loggingContext(): { ctx: Context; lines: string[] } {
  const ctx = new Context()
  contexts.push(ctx)
  return { ctx, lines: captureLogs(ctx) }
}

interface Pending {
  readonly path: string
  resolve(workspace: Workspace): void
  reject(error: Error): void
}

/** A workspace registry whose `create` calls stay pending until the test settles them. */
function controlledCreator(): WorkspaceCreator & { readonly calls: Pending[] } {
  const calls: Pending[] = []
  return {
    calls,
    create: path => new Promise<Workspace>((resolve, reject) => { calls.push({ path, resolve, reject }) }),
  }
}

function workspaceAt(path: string): Workspace {
  return { id: 'workspace-1', path, title: basename(path), createdAt: '', updatedAt: '' } as Workspace
}

/** Let every queued promise reaction run. */
async function settle(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve))
}

describe('default workspace registration', () => {
  it('is not ready while workspace.create is pending, and is once it settles', async () => {
    const members = roots()
    const root = members.ensureMember(ALICE)
    const creator = controlledCreator()
    const { ctx } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), creator, ctx.logger('console-members'))

    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    const step = defaults.ensureDefaultWorkspace(ALICE)
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    await vi.waitFor(() => { expect(creator.calls).toHaveLength(1) })
    const directory = join(root, 'workspace')
    expect(creator.calls[0]!.path).toBe(directory)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    await settle()
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)

    creator.calls[0]!.resolve(workspaceAt(directory))
    await expect(step).resolves.toEqual(workspaceAt(directory))
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(true)
    expect(defaults.ensureDefaultWorkspace(ALICE)).toBe(step)
    expect(creator.calls).toHaveLength(1)
  })

  it('runs one step for concurrent admissions of one member', async () => {
    const members = roots()
    members.ensureMember(ALICE)
    const create = vi.fn(async (path: string) => workspaceAt(path))
    const { ctx } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), { create }, ctx.logger('console-members'))

    const first = defaults.ensureDefaultWorkspace(ALICE)
    const second = defaults.ensureDefaultWorkspace(ALICE)
    expect(second).toBe(first)
    await first
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('forgets a failed step, reports it without the principal key or the failure text, and retries on the next call', async () => {
    const members = roots()
    members.ensureMember(ALICE)
    const creator = controlledCreator()
    const { ctx, lines } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), creator, ctx.logger('console-members'))

    const failing = defaults.ensureDefaultWorkspace(ALICE)
    await vi.waitFor(() => { expect(creator.calls).toHaveLength(1) })
    creator.calls[0]!.reject(new Error(BACKEND_TEXT))
    const failure = await failing.then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(DefaultWorkspaceUnregisteredError)
    expect(String((failure as Error).stack)).not.toContain(BACKEND_TEXT)
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    expect(lines.filter(line => line.startsWith('warn'))).toHaveLength(1)
    for (const line of lines) {
      expect(line).not.toContain(ALICE)
      expect(line).not.toContain('secret-path')
    }

    const retried = defaults.ensureDefaultWorkspace(ALICE)
    expect(retried).not.toBe(failing)
    await vi.waitFor(() => { expect(creator.calls).toHaveLength(2) })
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    creator.calls[1]!.resolve(workspaceAt(creator.calls[1]!.path))
    await retried
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(true)
  })

  it('refuses a symbolic link planted at <member root>/workspace without calling workspace.create', async () => {
    const BOB = principal('login-uid-bob-7702')
    const members = roots()
    const aliceRoot = members.ensureMember(ALICE)
    const bobRoot = members.ensureMember(BOB)
    symlinkSync(bobRoot, join(aliceRoot, 'workspace'))
    const creator = controlledCreator()
    const { ctx, lines } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), creator, ctx.logger('console-members'))

    await expect(defaults.ensureDefaultWorkspace(ALICE)).rejects.toBeInstanceOf(DefaultWorkspaceUnregisteredError)
    expect(creator.calls).toEqual([])
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    expect(lines.filter(line => line.startsWith('warn'))).toHaveLength(1)
    for (const line of lines) {
      expect(line).not.toContain(ALICE)
      expect(line).not.toContain(bobRoot)
    }
  })

  it('refuses a workspace the registry answers at another directory', async () => {
    const members = roots()
    const root = members.ensureMember(ALICE)
    const create = vi.fn(async () => workspaceAt(join(temp.base, 'elsewhere')))
    const { ctx } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), { create }, ctx.logger('console-members'))

    await expect(defaults.ensureDefaultWorkspace(ALICE)).rejects.toBeInstanceOf(DefaultWorkspaceUnregisteredError)
    expect(create).toHaveBeenCalledWith(join(root, 'workspace'))
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
  })

  it('fails the step for a member whose root is not registered', async () => {
    const members = roots()
    const create = vi.fn(async (path: string) => workspaceAt(path))
    const { ctx } = loggingContext()
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), { create }, ctx.logger('console-members'))

    await expect(defaults.ensureDefaultWorkspace(ALICE)).rejects.toBeInstanceOf(DefaultWorkspaceUnregisteredError)
    expect(create).not.toHaveBeenCalled()
    expect(defaults.defaultWorkspaceReady(ALICE)).toBe(false)
  })

  it('leaves no unhandled rejection when nobody waits for a failed step', async () => {
    const members = roots()
    members.ensureMember(ALICE)
    const unhandled: unknown[] = []
    const record = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', record)
    try {
      const { ctx } = loggingContext()
      const create = vi.fn(async () => { throw new Error(BACKEND_TEXT) })
      const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), { create }, ctx.logger('console-members'))
      void defaults.ensureDefaultWorkspace(ALICE)
      await vi.waitFor(() => { expect(create).toHaveBeenCalled() })
      await settle()
      await settle()
    } finally {
      process.off('unhandledRejection', record)
    }
    expect(unhandled).toEqual([])
  })
})

describe('default workspace after a restart', () => {
  /** One process: the root registry over the shared files and the real workspace registry over the shared storage. */
  async function boot(pool: MemoryMediaPool): Promise<{ members: RootRegistry; defaults: DefaultWorkspaces; ctx: Context }> {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SessionStore)
    await ctx.plugin(Storage)
    ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
    const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
    ctx.storage.mount('domain', storageDomain)
    ctx.provide('storageDomain', storageDomain)
    ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
    await ctx.plugin(WorkspaceRegistry)
    const members = roots()
    const registry = ctx.workspaceRegistry
    const defaults = new DefaultWorkspaces(principal => members.memberRoot(principal), registry, ctx.logger('console-members'))
    return { members, defaults, ctx }
  }

  it('finds the member\'s directory and workspace again, ready only once the new step settles', async () => {
    const pool = new MemoryMediaPool()
    const first = await boot(pool)
    const root = first.members.ensureMember(ALICE)
    const before = await first.defaults.ensureDefaultWorkspace(ALICE)
    expect(before.path).toBe(join(root, 'workspace'))
    await first.ctx.fiber.dispose()

    const second = await boot(pool)
    expect(second.members.ensureMember(ALICE)).toBe(root)
    expect(readdirSync(join(temp.base, 'members'))).toEqual([basename(root)])
    expect(second.defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    const step = second.defaults.ensureDefaultWorkspace(ALICE)
    expect(second.defaults.defaultWorkspaceReady(ALICE)).toBe(false)
    const after = await step
    expect(after.id).toBe(before.id)
    expect(second.defaults.defaultWorkspaceReady(ALICE)).toBe(true)
    expect(second.ctx.workspaceRegistry.list().map(workspace => workspace.id)).toEqual([before.id])
  })
})
