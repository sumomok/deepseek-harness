/** The shipped runtime survives malformed Content-Encoding responses in an isolated process. */

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { undiciVersionProblem } from './runtime-version-gate.mjs'

const fixture = fileURLToPath(new URL('./fixtures/undici-content-encoding.mjs', import.meta.url))

// Runtimes below the patched line accept the layered response or can hang on
// the truncated one, so the assertions apply only where the fixes ship. CI runs
// the 24.9 engine floor, whose bundled Undici is below that line.
const unpatched = undiciVersionProblem(process.versions.undici)

it.skipIf(unpatched !== undefined)('rejects layered and truncated responses, then serves a healthy request from the same child', () => {
  const result = spawnSync(process.execPath, [fixture], { encoding: 'utf8', timeout: 20_000 })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
  const record = JSON.parse(result.stdout.trim()) as {
    layered?: { error?: { message?: string; cause?: { message?: string } } }
    truncated?: { error?: { message?: string }; response?: { body?: string } }
    health?: { response?: { status?: number; body?: string } }
  }

  const layeredError = record.layered?.error
  expect(layeredError).toBeDefined()
  expect([layeredError?.message, layeredError?.cause?.message].filter(Boolean).join(' | '))
    .toContain('too many content-encodings in response: 6, maximum allowed is 5')
  expect(record.truncated?.error).toBeDefined()
  expect(record.truncated?.response).toBeUndefined()
  expect(record.health).toEqual({ response: { status: 200, body: 'ok' } })
})
