/**
 * `resolveOrCreateSession`'s resolution order in isolation:
 * `browser-plugin.client.spec.ts` and `open-nav.client.spec.ts` cover it
 * indirectly through `openNavItem`; this file pins the `reuseCurrent`
 * branch directly, since the workbench and workflow degrade paths
 * (`workflow-actions.ts`) call it with `reuseCurrent: false`.
 *
 * It also pins the one step the package restates from
 * `dsh-client-ui-workspace` — which Workspace is the recent one, whose own
 * `recentWorkspace` is module-private there — since no other suite reaches
 * it: a divergence from `ui-workspace/src/client/navigation.ts` changes which
 * Workspace a click lands in. Connecting that Workspace is the service's job
 * (`ctx.uiWorkspace.connectWorkspace`, which also holds the in-flight map
 * that keeps a click beside the auto-open from minting a second session), so
 * these cases assert the delegation, not a second copy of its blank-session
 * reuse.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { resolveOrCreateSession } from '../src/client/session-resolution.ts'

/** One row of the fake Workspace list. */
interface FakeWorkspace {
  workspaceId: string
  path?: string
  sessionIds?: readonly string[]
  createdAt?: string
}

/** One row of the fake session list. */
interface FakeSession {
  id: string
  updatedAt?: number
}

/**
 * Build a fake context, plus the raw `sessions.open` and
 * `uiWorkspace.connectWorkspace` spies on the side: reading them back off
 * `ctx` for an assertion would type them as `ClientContext`'s declared
 * methods (an unbound-method lint violation), not as the `vi.fn()`s they
 * actually are.
 * @param overrides - the pieces of the two snapshots a case varies.
 * @returns the fake context and the two spies.
 */
function fakeContext(overrides: {
  currentSessionId?: string
  recentWorkspaceId?: string
  workspaces?: readonly FakeWorkspace[]
  sessions?: readonly FakeSession[]
  workspacesPhase?: 'pending' | 'ready'
  sessionsPhase?: 'pending' | 'ready'
  connect?: (workspaceId: string) => Promise<string>
}): { ctx: ClientContext; open: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const connect = vi.fn(overrides.connect ?? (() => Promise.resolve('new-session')))
  const rows = overrides.workspaces
    ?? (overrides.recentWorkspaceId === undefined ? [] : [{ workspaceId: overrides.recentWorkspaceId }])
  const items = rows.map(row => ({
    workspaceId: row.workspaceId,
    path: row.path ?? '/workspace',
    sessionIds: row.sessionIds ?? [],
    createdAt: row.createdAt ?? '2026-01-01T00:00:00.000Z',
  }))
  const summaries = overrides.sessions ?? []
  const ctx = {
    sessions: {
      list: {
        getSnapshot: () => ({
          current: overrides.currentSessionId,
          phase: overrides.sessionsPhase ?? 'ready',
          ids: summaries.map(summary => summary.id),
          byId: Object.fromEntries(summaries.map(summary => [summary.id, {
            id: summary.id,
            updatedAt: summary.updatedAt ?? 0,
          }])),
        }),
      },
      open,
    },
    uiWorkspace: { connectWorkspace: connect },
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: overrides.workspacesPhase ?? 'ready',
          items,
        }),
      },
    },
  } as unknown as ClientContext
  return { ctx, open, connect }
}

describe('resolveOrCreateSession', () => {
  it('reuses the current session when reuseCurrent is true', async () => {
    const { ctx } = fakeContext({ currentSessionId: 'session-a' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('session-a')
  })

  it('ignores a current session when reuseCurrent is false, connecting a workspace instead', async () => {
    const { ctx, open } = fakeContext({ currentSessionId: 'session-a', recentWorkspaceId: 'workspace-1' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: false, onNoWorkspace: 'unused' }))
      .toBe('new-session')
    expect(open).toHaveBeenCalledWith('new-session')
  })

  it('connects the recent workspace when there is no current session to reuse', async () => {
    const { ctx, connect, open } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('new-session')
    expect(connect).toHaveBeenCalledWith('workspace-1')
    expect(open).toHaveBeenCalledWith('new-session')
  })

  it('warns and answers undefined with no current session and no workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, connect } = fakeContext({})
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'server-sidebar: no workspace' }))
      .toBeUndefined()
    expect(warn).toHaveBeenCalledWith('server-sidebar: no workspace')
    expect(connect).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('propagates a connect rejection to the caller', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', connect: () => Promise.reject(new Error('boot failed')) })
    await expect(resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).rejects.toThrow('boot failed')
  })
})

describe('recent-workspace choice', () => {
  it('picks the workspace holding the most recently touched session', async () => {
    const { ctx, connect } = fakeContext({
      workspaces: [
        { workspaceId: 'workspace-old', path: '/old', sessionIds: ['session-old'] },
        { workspaceId: 'workspace-new', path: '/new', sessionIds: ['session-new'] },
      ],
      sessions: [
        { id: 'session-old', updatedAt: 1000 },
        { id: 'session-new', updatedAt: 2000 },
      ],
    })
    await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })
    expect(connect).toHaveBeenCalledWith('workspace-new')
  })

  it('keeps the earlier workspace when a later one is not more recent', async () => {
    const { ctx, connect } = fakeContext({
      workspaces: [
        { workspaceId: 'workspace-first', path: '/first', sessionIds: ['session-first'] },
        { workspaceId: 'workspace-second', path: '/second', sessionIds: ['session-second'] },
      ],
      sessions: [
        { id: 'session-first', updatedAt: 2000 },
        { id: 'session-second', updatedAt: 1000 },
      ],
    })
    await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })
    expect(connect).toHaveBeenCalledWith('workspace-first')
  })

  it('reads the most recent session of a workspace that lists several', async () => {
    const { ctx, connect } = fakeContext({
      workspaces: [
        { workspaceId: 'workspace-many', path: '/many', sessionIds: ['session-a', 'session-b'] },
        { workspaceId: 'workspace-one', path: '/one', sessionIds: ['session-c'] },
      ],
      sessions: [
        { id: 'session-a', updatedAt: 1000 },
        { id: 'session-b', updatedAt: 3000 },
        { id: 'session-c', updatedAt: 2000 },
      ],
    })
    await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })
    expect(connect).toHaveBeenCalledWith('workspace-many')
  })

  it('falls back to creation time for a session id the sessions baseline has not delivered', async () => {
    const { ctx, connect } = fakeContext({
      workspaces: [
        { workspaceId: 'workspace-older', path: '/older', sessionIds: ['absent'], createdAt: '2026-01-01T00:00:00.000Z' },
        { workspaceId: 'workspace-newer', path: '/newer', sessionIds: ['also-absent'], createdAt: '2026-02-01T00:00:00.000Z' },
      ],
    })
    await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })
    expect(connect).toHaveBeenCalledWith('workspace-newer')
  })

  it('answers undefined before the workspace baseline settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, connect } = fakeContext({ recentWorkspaceId: 'workspace-1', workspacesPhase: 'pending' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'pending' })).toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('answers undefined before the sessions baseline settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx, connect } = fakeContext({ recentWorkspaceId: 'workspace-1', sessionsPhase: 'pending' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'pending' })).toBeUndefined()
    expect(connect).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
