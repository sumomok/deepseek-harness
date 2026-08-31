import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSessionTestController,
  createSessionTestRemote,
} from './test-remote.ts'

// The ENOENT pre-check's non-ENOENT fallthrough and its abort-during-stat
// race cannot be timed or injected against the real filesystem: both need
// `stat` itself to answer on this test's own schedule.
const state = vi.hoisted(() => ({
  statOverride: undefined as ((path: string) => Promise<unknown>) | undefined,
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    stat: (async (path: string) => {
      if (state.statOverride !== undefined) return state.statOverride(path)
      return actual.stat(path)
    }) as typeof actual.stat,
  }
})

afterEach(() => {
  state.statOverride = undefined
})

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Stage one real, empty file so it resolves for the openWorkspacePath existence check. */
async function stageFile(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, '')
  return path
}

describe('session/openWorkspacePath', () => {
  it('reports the deployment opener capability independently of a Session', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      canOpenPath: () => false,
    })

    await expect(remote.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: false })
  })

  it('derives opener availability from config, an injected opener, or the platform probe', async () => {
    const configured = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      nativeOpen: false,
    })
    await expect(configured.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: false })

    const injected = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath: () => Promise.resolve(),
    })
    await expect(injected.canOpenWorkspacePath()).resolves.toEqual({ ok: true, value: true })

    const detected = createSessionTestRemote(await context(), {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    await expect(detected.canOpenWorkspacePath()).resolves.toMatchObject({ ok: true })
  })

  it('hands a Client-resolved workspace path to the Host opener unchanged', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const signal = new AbortController().signal
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-path-'))
    const target = await stageFile(root, 'a.ts')

    await expect(remote.openWorkspacePath({ path: target }, signal))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(openPath).toHaveBeenCalledWith(target, signal)
    expect(ctx.agents.list()).toEqual([])
  })

  it('preserves relative and absolute Host-resolvable paths', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-path-'))
    const absolute = await stageFile(root, 'result.html')
    const priorCwd = process.cwd()
    process.chdir(root)
    try {
      await remote.openWorkspacePath({ path: absolute })
      await remote.openWorkspacePath({ path: 'result.html' })
    } finally {
      process.chdir(priorCwd)
    }
    expect(openPath.mock.calls.map(call => call[0])).toEqual([absolute, 'result.html'])
  })

  it('answers session/path-not-found for a path that does not resolve on disk, without invoking the native opener', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-path-'))
    const missing = join(root, 'missing.txt')

    await expect(remote.openWorkspacePath({ path: missing }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'session/path-not-found', details: { path: missing } },
      })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('falls through a non-ENOENT stat failure and still invokes the native opener', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    state.statOverride = () => Promise.reject(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    )

    await expect(remote.openWorkspacePath({ path: '/tmp/denied.txt' }))
      .resolves.toEqual({ ok: true, value: { opened: true } })
    expect(openPath).toHaveBeenCalledWith('/tmp/denied.txt', expect.anything())
  })

  it('answers cancelled when abort lands between the stat pre-check and the opener', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const aborted = new AbortController()
    state.statOverride = async (path) => {
      aborted.abort(new Error('gateway/cancelled'))
      return { path }
    }

    await expect(remote.openWorkspacePath({ path: '/tmp/a.txt' }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('rejects empty paths before opening anything', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) => Promise.resolve())
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })

    await expect(remote.openWorkspacePath({ path: '' }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(openPath).not.toHaveBeenCalled()
  })

  it('preserves native opener failure and cancellation results', async () => {
    const ctx = await context()
    const openPath = vi.fn((_path: string, _signal: AbortSignal) =>
      Promise.reject(new Error('desktop unavailable')))
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-path-'))
    const target = await stageFile(root, 'result.html')

    await expect(remote.openWorkspacePath({ path: target }))
      .resolves.toMatchObject({
        ok: false,
        error: { code: 'gateway/internal', message: 'path open failed: desktop unavailable' },
      })

    const aborted = new AbortController()
    aborted.abort(new Error('gateway/cancelled'))
    await expect(remote.openWorkspacePath({ path: target }, aborted.signal))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
  })

  it('classifies opener cancellation and non-Error failures', async () => {
    const ctx = await context()
    const aborted = new AbortController()
    const openPath = vi.fn()
      .mockImplementationOnce(async () => {
        aborted.abort(new Error('gateway/cancelled'))
        throw new Error('opening stopped')
      })
      .mockRejectedValueOnce('desktop unavailable')
    const controller = createSessionTestController(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
      openPath,
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-open-workspace-path-'))
    const first = await stageFile(root, 'first.html')
    const second = await stageFile(root, 'second.html')

    await expect(controller.openWorkspacePath({ path: first }, aborted.signal))
      .rejects.toMatchObject({ code: 'gateway/cancelled' })
    await expect(controller.openWorkspacePath({
      path: second,
    }, new AbortController().signal)).rejects.toMatchObject({
      code: 'gateway/internal', message: 'path open failed: desktop unavailable',
    })
  })
})
