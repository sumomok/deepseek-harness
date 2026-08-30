/**
 * `resolveOrCreateSession`'s resolution order in isolation:
 * `browser-plugin.client.spec.ts` and `open-page.client.spec.ts` cover it
 * indirectly through `openContentPage`; this file pins the `reuseCurrent`
 * branch directly, since the workbench and workflow degrade paths
 * (`workflow-actions.ts`) call it with `reuseCurrent: false`.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveOrCreateSession } from '../src/client/session-resolution.ts'

/**
 * Build a fake context, plus the raw `sessions.open` spy on the side: reading
 * it back off `ctx` for an assertion would type it as `ClientContext`'s
 * declared method (an unbound-method lint violation), not as the `vi.fn()`
 * it actually is.
 */
function fakeContext(overrides: {
  currentSessionId?: string
  recentWorkspaceId?: string
  connectWorkspace?: () => Promise<string>
}): { ctx: ClientContext; open: ReturnType<typeof vi.fn> } {
  const open = vi.fn()
  const ctx = {
    sessions: {
      list: { getSnapshot: () => ({ current: overrides.currentSessionId }) },
      open,
    },
    workspaces: {
      list: { getSnapshot: () => ({ recentWorkspaceId: overrides.recentWorkspaceId }) },
      connectWorkspace: overrides.connectWorkspace ?? (() => Promise.resolve('new-session')),
    },
  } as unknown as ClientContext
  return { ctx, open }
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

  it('propagates a connectWorkspace rejection to the caller', async () => {
    const { ctx } = fakeContext({ recentWorkspaceId: 'workspace-1', connectWorkspace: () => Promise.reject(new Error('boot failed')) })
    await expect(resolveOrCreateSession(ctx, { reuseCurrent: true, onNoWorkspace: 'unused' })).rejects.toThrow('boot failed')
  })
})
