/**
 * Relocation across real processes over one shared root. A child holding a
 * session's write lock excludes a relocation until it dies; and the built
 * backend in a plain-Node child recovers intents another process left at
 * either side of the commit point, then relocates through its bundled worker
 * verifier. Process death at every step is pinned by the barrier-driven crash
 * matrix in relocation.spec.ts; kernel lock release on death is pinned by
 * lease.two-process.e2e.ts. Keyless.
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { SessionAlreadyOwnedError } from '@deepseek-ai/dsh-session-persistence'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { generationLogFilename, sessionDir, toHeaderLine } from '../src/format.ts'
import { SessionWriteLease } from '../src/lease.ts'
import type { JsonlRelocationPhase } from '../src/relocation.ts'
import { createJsonlGenerationTestRuntime } from '../src/testing/generation.ts'
import { createJsonlRelocationTestRuntime } from '../src/testing/relocation.ts'
import { meta } from '../../session-persistence/tests/contract.ts'

const HOLDER = fileURLToPath(new URL('./fixtures/lease-holder.mjs', import.meta.url))
const RECOVER = fileURLToPath(new URL('./fixtures/relocation-recover.mjs', import.meta.url))

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-relocate-2proc-'))
  dirs.push(root)
  return root
}

class SimulatedCrash extends Error {}

/** Leave one relocation from /work/source to /work/target stopped after `phase`, with its locks released. */
async function leaveIntent(phase: JsonlRelocationPhase): Promise<{ root: string; id: SessionId }> {
  const root = await freshRoot()
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
  const header = meta('left', '/work/source')
  const handle = await ctx.sessionPersistence.create(header)
  await handle.append([
    { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ])
  await handle.close()
  const sourceDir = sessionDir(root, '/work/source', header.id)
  const targetDir = sessionDir(root, '/work/target', header.id)
  await mkdir(targetDir, { recursive: true })
  const leases = [await SessionWriteLease.acquire(sourceDir, header.id), await SessionWriteLease.acquire(targetDir, header.id)]
  const generation = createJsonlGenerationTestRuntime()
  const runtime = createJsonlRelocationTestRuntime({
    verify: (path, compression, id, count) => generation.verify(path, compression, id, count),
    barrier: (reached) => {
      if (reached === phase) throw new SimulatedCrash(phase)
    },
  })
  try {
    await expect(runtime.execute({
      root,
      id: header.id,
      compression: 'none',
      sourceDir,
      targetDir,
      sameDirectory: false,
      fromCwd: '/work/source',
      toCwd: '/work/target',
      headerLine: `${JSON.stringify(toHeaderLine({ ...header, cwd: '/work/target' }))}\n`,
      sourceEnd: undefined,
      recoveredBatch: '',
      eventCount: 2,
    })).rejects.toBeInstanceOf(SimulatedCrash)
  } finally {
    for (const lease of leases) await lease.release()
  }
  return { root, id: header.id }
}

/** What the recovery fixture prints. */
interface RecoveryReport {
  listed: Array<{ id: string; cwd: string | null }>
  relocated: string | null
}

/** Run the built recovery fixture and parse its one JSON line. */
async function recoverInChild(root: string, relocate?: [SessionId, string]): Promise<RecoveryReport> {
  const child = spawn(process.execPath, [RECOVER, root, 'none', ...(relocate ?? [])], { stdio: ['ignore', 'pipe', 'inherit'] })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
  const [code] = await once(child, 'exit') as [number | null]
  expect(code).toBe(0)
  return JSON.parse(output) as RecoveryReport
}

describe('two-process relocation (built lib)', () => {
  it('refuses while another process holds the session and moves it once that process dies', { timeout: 60_000 }, async () => {
    const root = await freshRoot()
    const holder = spawn(process.execPath, [HOLDER, root, 'held'], { stdio: ['ignore', 'pipe', 'inherit'] })
    const exited = new Promise<void>((resolve) => { holder.once('exit', () => { resolve() }) })
    try {
      await once(holder.stdout, 'data') // 'holding'
      const ctx = new Context()
      contexts.push(ctx)
      await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
      await expect(ctx.sessionPersistence.relocate!(SessionId('held'), '/moved')).rejects.toBeInstanceOf(SessionAlreadyOwnedError)
      holder.kill('SIGKILL')
      await exited
      expect((await ctx.sessionPersistence.relocate!(SessionId('held'), '/moved')).header.cwd).toBe('/moved')
      const reader = await ctx.sessionPersistence.open(SessionId('held'), 'read')
      expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
      await reader.close()
    } finally {
      if (holder.exitCode === null) holder.kill('SIGKILL')
    }
  })

  it('recovers intents left before and after the commit point in a built-backend child', { timeout: 60_000 }, async () => {
    const before = await leaveIntent('current-hidden')
    const rolledBack = await recoverInChild(before.root, [before.id, '/work/third'])
    expect(rolledBack).toEqual({ listed: [{ id: 'left', cwd: '/work/source' }], relocated: '/work/third' })
    expect((await readdir(before.root)).filter(name => name.startsWith('.relocate.'))).toEqual([])

    const after = await leaveIntent('published')
    expect(await recoverInChild(after.root)).toEqual({ listed: [{ id: 'left', cwd: '/work/target' }], relocated: null })
    expect((await readdir(after.root)).filter(name => name.startsWith('.relocate.'))).toEqual([])
    expect(await readdir(sessionDir(after.root, '/work/target', after.id))).toEqual(expect.arrayContaining([generationLogFilename(SESSION_FORMAT_VERSION, 'none')]))
  })
})
