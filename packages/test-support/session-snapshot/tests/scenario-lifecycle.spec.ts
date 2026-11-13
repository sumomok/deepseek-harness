import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it('releases scenario subscriptions and preserves deterministic file versions', async () => {
  // These Loader fixtures are plain JS modules; exercise them in their native Node environment.
  const fixture = fileURLToPath(new URL('./fixtures/scenario-lifecycle.mjs', import.meta.url))
  const result = await execute(process.execPath, ['--test', fixture], { timeout: 30_000 })
  expect(result.stdout).toMatch(/(?:#|ℹ) pass 5/)
  expect(result.stdout).toMatch(/(?:#|ℹ) fail 0/)
})
