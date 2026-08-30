/**
 * `openContentPage`'s failure paths: `browser-plugin.client.spec.ts` covers
 * the three resolution branches (current session, recent-workspace handoff,
 * no-workspace no-op) against a successful command execution; this file
 * covers the console-warned failure branches those benches never trigger —
 * a failed workspace connect, a transport-level command failure, and a
 * command that ran but answered its own `error` result.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { openContentPage, replayNavSnapshot } from '../src/client/open-page.ts'

/** Build a minimal fake context exposing only what `openContentPage` reads. */
function fakeContext(overrides: {
  currentSessionId?: string
  recentWorkspaceId?: string
  connectWorkspace?: () => Promise<string>
  execute?: () => Promise<unknown>
}): ClientContext {
  return {
    sessions: {
      list: { getSnapshot: () => ({ current: overrides.currentSessionId }) },
      open: vi.fn(),
    },
    workspaces: {
      list: { getSnapshot: () => ({ recentWorkspaceId: overrides.recentWorkspaceId }) },
      connectWorkspace: overrides.connectWorkspace ?? (() => Promise.resolve('new-session')),
    },
    remote: {
      commands: { execute: overrides.execute ?? (() => Promise.resolve({ ok: true, value: undefined })) },
    },
  } as unknown as ClientContext
}

describe('openContentPage failure paths', () => {
  it('leaves a page click a contained no-op with no session and no workspace to create one in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn()
    const ctx = fakeContext({ execute })
    await openContentPage(ctx, 'home')
    expect(execute).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns and gives up when connecting the recent workspace throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn()
    const ctx = fakeContext({
      recentWorkspaceId: 'workspace-1',
      connectWorkspace: () => Promise.reject(new Error('boot failed')),
      execute,
    })
    await openContentPage(ctx, 'home')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to start a session'), expect.any(Error))
    expect(execute).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns on a transport-level command failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext({
      currentSessionId: 'session-a',
      execute: () => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }),
    })
    await openContentPage(ctx, 'home')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unreachable: no connection'))
    warn.mockRestore()
  })

  it('warns when the command ran but answered its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ctx = fakeContext({
      currentSessionId: 'session-a',
      execute: () => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'unknown page id' } } }),
    })
    await openContentPage(ctx, 'missing')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown page id'))
    warn.mockRestore()
  })
})

describe('replayNavSnapshot', () => {
  it('executes show-content-page for every page id, in order, against the given session', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', ['home', 'reports'])
    expect(execute).toHaveBeenNthCalledWith(1, 'session-a', '/show-content-page home', [])
    expect(execute).toHaveBeenNthCalledWith(2, 'session-a', '/show-content-page reports', [])
  })

  it('does nothing for an empty snapshot', async () => {
    const execute = vi.fn()
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', [])
    expect(execute).not.toHaveBeenCalled()
  })

  it('warns on a transport-level failure but keeps replaying the rest of the snapshot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'unreachable', message: 'no connection' } })
      .mockResolvedValueOnce({ ok: true, value: undefined })
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', ['home', 'reports'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workflow replay failed for page "home"'))
    expect(execute).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('warns when a replayed command answers its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'unknown page id' } } }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', ['missing'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown page id'))
    warn.mockRestore()
  })
})
