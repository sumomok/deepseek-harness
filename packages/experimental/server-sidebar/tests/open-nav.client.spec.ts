/**
 * `openNavItem`'s dispatch and failure paths, and the snapshot replay over
 * the same dispatch table: `browser-plugin.client.spec.ts` covers the three
 * resolution branches (current session, recent-workspace handoff,
 * no-workspace no-op) against a successful command execution; this file
 * covers which command each kind runs, plus the console-warned failure
 * branches those benches never trigger — a failed workspace connect, a
 * transport-level command failure, and a command that ran but answered its
 * own `error` result.
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { SHOW_CONTENT_PAGE_COMMAND } from '@deepseek-ai/dsh-experimental-content-frame/src/command.ts'
import { SHOW_CONTENT_VIEW_COMMAND } from '@deepseek-ai/dsh-experimental-component-surface/src/view-command.ts'
import { openHome, openNavItem, replayNavSnapshot } from '../src/client/open-nav.ts'

const PAGE = { kind: 'page', entryId: 'home' } as const
const VIEW = { kind: 'view', entryId: 'sales' } as const

/** Build a minimal fake context exposing only what `open-nav.ts` reads. */
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

describe('the copied command names', () => {
  it('name the commands the two owning packages actually register', () => {
    expect(SHOW_CONTENT_PAGE_COMMAND).toBe('show-content-page')
    expect(SHOW_CONTENT_VIEW_COMMAND).toBe('show-content-view')
  })
})

describe('openNavItem', () => {
  it('runs show-content-page for a page row', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await openNavItem(fakeContext({ currentSessionId: 'session-a', execute }), PAGE)
    expect(execute).toHaveBeenCalledWith('session-a', '/show-content-page home', [])
  })

  it('runs show-content-view for a view row', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    await openNavItem(fakeContext({ currentSessionId: 'session-a', execute }), VIEW)
    expect(execute).toHaveBeenCalledWith('session-a', '/show-content-view sales', [])
  })

  it('leaves a click a contained no-op with no session and no workspace to create one in', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn()
    await openNavItem(fakeContext({ execute }), PAGE)
    expect(execute).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns and gives up when connecting the recent workspace throws', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn()
    await openNavItem(fakeContext({
      recentWorkspaceId: 'workspace-1',
      connectWorkspace: () => Promise.reject(new Error('boot failed')),
      execute,
    }), PAGE)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('failed to start a session'), expect.any(Error))
    expect(execute).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('warns on a transport-level command failure, naming the command and the id', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openNavItem(fakeContext({
      currentSessionId: 'session-a',
      execute: () => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }),
    }), VIEW)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('navigation failed for show-content-view "sales": unreachable: no connection'))
    warn.mockRestore()
  })

  it('warns when the command ran but answered its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await openNavItem(fakeContext({
      currentSessionId: 'session-a',
      execute: () => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: '没有这个视图。' } } }),
    }), VIEW)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('没有这个视图。'))
    warn.mockRestore()
  })
})

describe('openHome', () => {
  it('shows the configured home target on the session it is handed', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await openHome(ctx, 'session-a', VIEW)
    expect(execute).toHaveBeenCalledWith('session-a', '/show-content-view sales', [])
  })

  it('names itself in a failure warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn(() => Promise.resolve({ ok: false, error: { code: 'unreachable', message: 'no connection' } }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await openHome(ctx, 'session-a', PAGE)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('home failed for show-content-page "home"'))
    warn.mockRestore()
  })
})

describe('replayNavSnapshot', () => {
  it('runs each stop\'s own command, in order, against the given session', async () => {
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: undefined }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', [PAGE, VIEW])
    expect(execute).toHaveBeenNthCalledWith(1, 'session-a', '/show-content-page home', [])
    expect(execute).toHaveBeenNthCalledWith(2, 'session-a', '/show-content-view sales', [])
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
    await replayNavSnapshot(ctx, 'session-a', [PAGE, VIEW])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workflow replay failed for show-content-page "home"'))
    expect(execute).toHaveBeenCalledTimes(2)
    warn.mockRestore()
  })

  it('warns when a replayed command answers its own error result', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const execute = vi.fn(() => Promise.resolve({ ok: true, value: { result: { kind: 'error', text: 'unknown page id' } } }))
    const ctx = { remote: { commands: { execute } } } as unknown as ClientContext
    await replayNavSnapshot(ctx, 'session-a', [PAGE])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('unknown page id'))
    warn.mockRestore()
  })
})
