/**
 * Host-level relocation of a stored Session over real JSONL persistence, the
 * Workspace registry, and the Workspace controller: a Session no Agent owns
 * moves to another Workspace and continues there; a Session whose history
 * was followed owns a live Agent and refuses the move.
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WorkspaceController from '@deepseek-ai/dsh-api-workspace-controller'
import type { WorkspaceFollowFrame } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import {
  apply as storageDomainApply, Config as storageDomainConfig, inject as storageDomainInject, name as storageDomainName,
} from '@deepseek-ai/dsh-storage-domain'
import {
  apply as storageJsonApply, Config as storageJsonConfig, inject as storageJsonInject, name as storageJsonName,
} from '@deepseek-ai/dsh-storage-json'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { SessionRequestId } from '../src/types.ts'
import { createSessionTestRemote } from './test-remote.ts'

const SESSION = SessionId('session-relocated')
const PROMPT = { personaPrefix: 'Working directory: {{cwd}}' }

const roots: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

/** Store one finished conversation at `cwd` in a process that exits before the Host starts. */
async function storeConversation(sessions: string, cwd: string): Promise<void> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: PROMPT })
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  const harness = await mountAgentLoopTestHarness(ctx)
  ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('first reply')]))
  const agent = await harness.create(SESSION, { provider: 'mock', model: 'mock' }, { cwd })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first prompt' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  await ctx.fiber.dispose()
}

/** Start a Host over the stored Session; the registry bootstraps the Workspace it was created in. */
async function host() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-relocate-')))
  roots.push(root)
  const sessions = join(root, 'sessions')
  const origin = join(root, 'origin')
  const destination = join(root, 'destination')
  await mkdir(origin)
  await mkdir(destination)
  await storeConversation(sessions, origin)

  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { systemPrompt: PROMPT })
  await ctx.plugin(JsonlSessionPersistence, { root: sessions })
  await ctx.plugin(Storage)
  await ctx.plugin({ name: storageJsonName, inject: storageJsonInject, apply: storageJsonApply, Config: storageJsonConfig }, { root: join(root, 'storage') })
  await ctx.plugin({ name: storageDomainName, inject: storageDomainInject, apply: storageDomainApply, Config: storageDomainConfig }, { backend: 'json' })
  await ctx.plugin(WorkspaceRegistry)
  await mountAgentLoopTestHarness(ctx)
  const adapter = new MockAdapter([textResponse('reply after the move')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const sessionRemote = createSessionTestRemote(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
    cwd: root,
  })
  const workspaces = new WorkspaceController(ctx, { documentsDirectory: root })
  return { ctx, origin, destination, adapter, sessionRemote, workspaces }
}

async function nextFrame(iterator: AsyncIterator<WorkspaceFollowFrame>): Promise<WorkspaceFollowFrame> {
  const next = await iterator.next()
  if (next.done === true) throw new Error('Workspace stream ended before the expected frame')
  return next.value
}

describe('Session relocation in a composed Host', () => {
  it('moves a Session no Agent owns into another Workspace, where it continues', async () => {
    const { ctx, origin, destination, adapter, sessionRemote, workspaces } = await host()
    const [source] = ctx.workspaceRegistry.list()
    expect(source).toMatchObject({ path: origin, sessionIds: [SESSION] })
    const { workspace: target } = await workspaces.create({ path: destination })
    const follow = new AbortController()
    const frames = workspaces.follow(follow.signal)[Symbol.asyncIterator]()
    expect(await nextFrame(frames)).toMatchObject({ type: 'baseline' })

    const persistence = ctx.sessionPersistence
    expect(typeof persistence.relocate).toBe('function')
    await expect(persistence.relocate!(SESSION, target.path))
      .resolves.toMatchObject({ header: { id: SESSION, cwd: target.path } })

    const listed = await sessionRemote.list({})
    if (!listed.ok) throw listed.error
    expect(listed.value.items).toEqual([expect.objectContaining({ sessionId: SESSION, cwd: target.path })])
    expect(await nextFrame(frames)).toMatchObject({
      type: 'upsert', workspace: { workspaceId: source!.id, sessionIds: [] },
    })
    expect(await nextFrame(frames)).toMatchObject({
      type: 'upsert', workspace: { workspaceId: target.workspaceId, sessionIds: [SESSION] },
    })
    follow.abort()

    // Adopting an existing id compares the stored cwd with the requested one exactly.
    await expect(sessionRemote.create({ sessionId: SESSION, cwd: origin }))
      .resolves.toMatchObject({ ok: false, error: { code: 'session/conflict' } })
    await expect(sessionRemote.create({ sessionId: SESSION, workspaceId: target.workspaceId }))
      .resolves.toEqual({ ok: true, value: { sessionId: SESSION } })
    await expect(sessionRemote.prompt({
      requestId: 'relocated-prompt' as SessionRequestId,
      sessionId: SESSION,
      mode: 'queue',
      content: [{ type: 'text', text: 'after the move' }],
    })).resolves.toEqual({ ok: true, value: { accepted: true } })
    await ctx.agents.get(SESSION)!.whenIdle()

    const request = JSON.stringify(adapter.requests.at(-1)?.messages)
    expect(request).toContain(`Working directory: ${target.path}`)
    expect(request).toContain('first prompt')
    expect(request).toContain('after the move')
  })

  it('refuses to move a Session whose followed history resumed its Agent', async () => {
    const { ctx, origin, destination, sessionRemote } = await host()
    const follow = new AbortController()
    const history = sessionRemote.follow({ address: { kind: 'session', sessionId: SESSION } }, follow.signal)[Symbol.asyncIterator]()
    expect((await history.next()).value).toMatchObject({ type: 'snapshot' })
    // Delivery resumes past the snapshot only when the follower pulls again; that starts the Agent.
    const tail = history.next()
    await vi.waitFor(() => { expect(ctx.agents.get(SESSION)).toBeDefined() })

    await expect(ctx.sessionPersistence.relocate?.(SESSION, destination))
      .rejects.toBeInstanceOf(SessionAlreadyOwnedError)
    follow.abort()
    await tail
    expect((await ctx.sessionPersistence.stat(SESSION))?.header.cwd).toBe(origin)
  })
})
