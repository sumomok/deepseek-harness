/** The staging entry refuses a Windows Node cache entry that fails its official digest. */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { WINDOWS_HOST_NODE_SHA256, WINDOWS_HOST_NODE_VERSION } from '../../../scripts/runtime-version-gate.mjs'
import { stageRuntime } from '../scripts/stage-runtime.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

it('discards a cached Windows Node that fails its digest and stages no runtime', async () => {
  root = mkdtempSync(join(tmpdir(), 'stage-runtime-'))
  const cacheDirectory = join(root, 'cache')
  mkdirSync(cacheDirectory)
  const cached = join(cacheDirectory, `node-v${WINDOWS_HOST_NODE_VERSION}-win-x64.exe`)
  writeFileSync(cached, 'corrupt cached runtime')
  const fetchRuntime = vi.fn<typeof fetch>(async () => new Response('corrupt downloaded runtime'))
  const runtimeDirectory = join(root, 'runtime')

  await expect(stageRuntime({ platform: 'win', runtimeDirectory, cacheDirectory, fetchRuntime }))
    .rejects.toThrow('has SHA-256')

  expect(fetchRuntime).toHaveBeenCalledOnce()
  expect(existsSync(cached)).toBe(false)
  expect(existsSync(join(runtimeDirectory, 'node.exe'))).toBe(false)
  expect(WINDOWS_HOST_NODE_SHA256).toMatch(/^[0-9a-f]{64}$/u)
})

it('does not stage a cached Windows Node when the replacement download fails', async () => {
  root = mkdtempSync(join(tmpdir(), 'stage-runtime-'))
  const cacheDirectory = join(root, 'cache')
  mkdirSync(cacheDirectory)
  const cached = join(cacheDirectory, `node-v${WINDOWS_HOST_NODE_VERSION}-win-x64.exe`)
  writeFileSync(cached, 'corrupt cached runtime')
  const fetchRuntime = vi.fn<typeof fetch>(async () => new Response('unavailable', { status: 503, statusText: 'Service Unavailable' }))
  const runtimeDirectory = join(root, 'runtime')

  await expect(stageRuntime({ platform: 'win', runtimeDirectory, cacheDirectory, fetchRuntime }))
    .rejects.toThrow('Node runtime download failed: 503 Service Unavailable')

  expect(existsSync(cached)).toBe(false)
  expect(existsSync(join(runtimeDirectory, 'node.exe'))).toBe(false)
})
