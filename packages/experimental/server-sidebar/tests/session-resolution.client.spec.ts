/**
 * `resolveOrCreateSession`'s resolution order in isolation:
 * `browser-plugin.client.spec.ts` and `open-page.client.spec.ts` cover it
 * indirectly through `openContentPage`; this file pins the `reuseCurrent`
 * branch directly, since the workbench and workflow degrade paths
 * (`workflow-actions.ts`) call it with `reuseCurrent: false`.
 *
 * It also pins the two steps the package restates from
 * `dsh-client-ui-workspace` (recent-Workspace choice and blank-session reuse),
 * which no other suite reaches: a divergence from
 * `ui-workspace/src/client/navigation.ts` changes which Workspace a click
 * lands in.
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
  blank?: boolean
  cwd?: string
}

/**
 * Build a fake context, plus the raw `sessions.open` and `sessions.create`
 * spies on the side: reading them back off `ctx` for an assertion would type
 * them as `ClientContext`'s declared methods (an unbound-method lint
 * violation), not as the `vi.fn()`s they actually are.
 * @param overrides - the pieces of the two snapshots a case varies.
 * @returns the fake context and the two spies.
 */
function fakeContext(overrides: {
  currentSessionId?: string
  recentWorkspaceId?: string
  workspaces?: readonly FakeWorkspace[]
  sessions?: readonly FakeSession[]
  /**
   * Ids the ordered baseline lists whose summary has not arrived in `byId`
   * yet — the transient divergence both restated steps guard against.
   */
  danglingSessionIds?: readonly string[]
  archivedSessionIds?: readonly string[]
  workspacesPhase?: 'pending' | 'ready'
  sessionsPhase?: 'pending' | 'ready'
  createSession?: () => Promise<string>
}): { ctx: ClientContext; open: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const create = vi.fn(overrides.createSession ?? (() => Promise.resolve('new-session')))
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
          ids: [...(overrides.danglingSessionIds ?? []), ...summaries.map(summary => summary.id)],
          byId: Object.fromEntries(summaries.map(summary => [summary.id, {
            id: summary.id,
            updatedAt: summary.updatedAt ?? 0,
            blank: summary.blank ?? false,
            cwd: summary.cwd ?? '/workspace',
          }])),
        }),
      },
      create,
      open,
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: overrides.workspacesPhase ?? 'ready',
          archivedSessionIds: overrides.archivedSessionIds ?? [],
          items,
        }),
      },
    },
  } as unknown as ClientContext
  return { ctx, open, create }
}

describe('resolveOrCreateSession', () => {
  it('reuses the current session when reuseCurrent is true', async () => {
    const { ctx } = fakeContext({ currentSessionId: 'session-a' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('session-a')
  })

  it('ignores a current session when reuseCurrent is false, creating a fresh one instead', async () => {
    const { ctx, open } = fakeContext({ currentSessionId: 'session-a', recentWorkspaceId: 'workspace-1' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: false, onNoWorkspace: 'unused' }))
      .toBe('new-session')
    expect(open).toHaveBeenCalledWith('new-session')
  })

  it('creates against the recent workspace when there is no current session to reuse', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('new-session')
  })

  it('warns and answers undefined with no current session and no workspace', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({})
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'server-sidebar: no workspace' }))
      .toBeUndefined()
    expect(warn).toHaveBeenCalledWith('server-sidebar: no workspace')
    warn.mockRestore()
  })

  it('propagates a session-create rejection to the caller', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', createSession: () => Promise.reject(new Error('boot failed')) })
    await expect(resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).rejects.toThrow('boot failed')
  })
})

describe('recent-workspace choice', () => {
  it('picks the workspace holding the most recently touched session', async () => {
    const { ctx, create } = fakeContext({
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
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-new' })
  })

  it('keeps the earlier workspace when a later one is not more recent', async () => {
    const { ctx, create } = fakeContext({
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
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-first' })
  })

  it('falls back to creation time for a session id the sessions baseline has not delivered', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [
        { workspaceId: 'workspace-older', path: '/older', sessionIds: ['absent'], createdAt: '2026-01-01T00:00:00.000Z' },
        { workspaceId: 'workspace-newer', path: '/newer', sessionIds: ['also-absent'], createdAt: '2026-02-01T00:00:00.000Z' },
      ],
    })
    await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-newer' })
  })

  it('answers undefined before the workspace baseline settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', workspacesPhase: 'pending' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'pending' })).toBeUndefined()
    warn.mockRestore()
  })

  it('answers undefined before the sessions baseline settles', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', sessionsPhase: 'pending' })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'pending' })).toBeUndefined()
    warn.mockRestore()
  })
})

describe('blank-session reuse', () => {
  const workspace = { workspaceId: 'workspace-1', path: '/workspace', sessionIds: ['session-blank'] }

  it('reuses the workspace unarchived blank session instead of creating one', async () => {
    const { ctx, open, create } = fakeContext({
      workspaces: [workspace],
      sessions: [{ id: 'session-blank', blank: true, cwd: '/workspace' }],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('session-blank')
    expect(create).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledWith('session-blank')
  })

  it('creates instead of reusing a session that carries work', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [workspace],
      sessions: [{ id: 'session-blank', blank: false, cwd: '/workspace' }],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).toBe('new-session')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
  })

  it('creates instead of reusing a blank session rooted elsewhere', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [workspace],
      sessions: [{ id: 'session-blank', blank: true, cwd: '/elsewhere' }],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).toBe('new-session')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
  })

  it('creates instead of reusing a blank session the workspace does not list', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [{ ...workspace, sessionIds: [] }],
      sessions: [{ id: 'session-blank', blank: true, cwd: '/workspace' }],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).toBe('new-session')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
  })

  it('creates instead of reusing an archived blank session', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [workspace],
      sessions: [{ id: 'session-blank', blank: true, cwd: '/workspace' }],
      archivedSessionIds: ['session-blank'],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).toBe('new-session')
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
  })

  it('skips an ordered id whose summary has not arrived, reusing the next blank session', async () => {
    const { ctx, create } = fakeContext({
      workspaces: [workspace],
      danglingSessionIds: ['session-unarrived'],
      sessions: [{ id: 'session-blank', blank: true, cwd: '/workspace' }],
    })
    expect(await resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' }))
      .toBe('session-blank')
    expect(create).not.toHaveBeenCalled()
  })
})
