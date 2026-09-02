import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionTestRemote } from './test-remote.ts'

// Every case below asserts against the real filesystem except the UNC
// short-circuit case, which needs to prove stat is never called at all --
// a spy that passes through to the real implementation by default lets one
// mock cover both without disturbing the other cases' real-file assertions.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, stat: vi.fn(actual.stat) }
})

async function context(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Stage one real, empty file so it resolves for the probe's existence check. */
async function stageFile(root: string, name: string): Promise<string> {
  const path = join(root, name)
  await writeFile(path, '')
  return path
}

afterEach(() => {
  vi.mocked(stat).mockClear()
})

describe('session/probeTargets', () => {
  it('reports exists/kind for a file, a directory, and a missing path, in request order', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-probe-targets-'))
    const file = await stageFile(root, 'a.txt')
    const dir = join(root, 'sub')
    await mkdir(dir)
    const missing = join(root, 'missing.txt')

    await expect(remote.probeTargets({ paths: [file, dir, missing] })).resolves.toEqual({
      ok: true,
      value: {
        results: [
          { path: file, exists: true, kind: 'file' },
          { path: dir, exists: true, kind: 'dir' },
          { path: missing, exists: false },
        ],
      },
    })
  })

  it('answers a UNC target with exists:false without ever calling stat, while a real neighboring path still resolves', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-probe-targets-'))
    const real = await stageFile(root, 'a.txt')
    const statMock = vi.mocked(stat)
    const uncTarget = '\\\\attacker-host\\share\\a.txt'

    const response = await remote.probeTargets({ paths: [uncTarget, real] })

    expect(response).toEqual({
      ok: true,
      value: {
        results: [
          { path: uncTarget, exists: false },
          { path: real, exists: true, kind: 'file' },
        ],
      },
    })
    expect(statMock).toHaveBeenCalledTimes(1)
    expect(statMock).toHaveBeenCalledWith(real)
  })

  it('rejects an empty batch and a batch over the 64-path cap before probing anything', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    const statMock = vi.mocked(stat)

    await expect(remote.probeTargets({ paths: [] }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    await expect(remote.probeTargets({ paths: Array.from({ length: 65 }, (_v, i) => `/p${String(i)}`) }))
      .resolves.toMatchObject({ ok: false, error: { code: 'gateway/bad-request' } })
    expect(statMock).not.toHaveBeenCalled()
  })

  it('probes a full 64-path batch, one result per path in order', async () => {
    const ctx = await context()
    const remote = createSessionTestRemote(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/default',
    })
    const root = await mkdtemp(join(tmpdir(), 'dsh-probe-targets-'))
    const paths = await Promise.all(Array.from({ length: 64 }, (_v, i) => stageFile(root, `f${String(i)}.txt`)))

    const response = await remote.probeTargets({ paths })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('expected a successful response')
    expect(response.value.results).toEqual(paths.map(path => ({ path, exists: true, kind: 'file' })))
  })
})
