/**
 * The pnpm launcher staging the packaging pipeline runs before `verifyStaging`,
 * and what that check refuses: a missing script, a script whose text drifted
 * from `src/pnpm-launcher.ts`, and a POSIX script without its executable bit.
 * @module
 */

import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pnpmLauncherProblems, stagePnpmLaunchers } from '../scripts/pnpm-launcher-staging.ts'
import { PNPM_LAUNCHERS } from '../src/pnpm-launcher.ts'

let root: string | undefined

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true })
  root = undefined
})

/** A fresh staging directory under the system temp directory. */
function stagingDir(): string {
  root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-launcher-staging-'))
  return join(root, 'pnpm-launchers')
}

describe('stagePnpmLaunchers', () => {
  it('stages both scripts as shipped, which the check accepts', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    expect(await pnpmLauncherProblems(dir)).toEqual([])
  })

  it.runIf(process.platform !== 'win32')('makes the POSIX script executable', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    expect(statSync(join(dir, PNPM_LAUNCHERS.darwin.file)).mode & 0o111).not.toBe(0)
  })

  it('replaces a script an earlier run left edited', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    writeFileSync(join(dir, PNPM_LAUNCHERS.win.file), 'stale')
    await stagePnpmLaunchers(dir)
    expect(await pnpmLauncherProblems(dir)).toEqual([])
  })
})

describe('pnpmLauncherProblems', () => {
  it('names a script that is not staged', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    rmSync(join(dir, PNPM_LAUNCHERS.win.file))
    expect(await pnpmLauncherProblems(dir)).toEqual([`${join(dir, PNPM_LAUNCHERS.win.file)} is not staged`])
  })

  it('names a script whose text is not the shipped one', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    writeFileSync(join(dir, PNPM_LAUNCHERS.darwin.file), '#!/bin/sh\nexec node "$@"\n')
    expect(await pnpmLauncherProblems(dir))
      .toEqual([`${join(dir, PNPM_LAUNCHERS.darwin.file)} is not the launcher src/pnpm-launcher.ts holds`])
  })

  it.runIf(process.platform !== 'win32')('names a POSIX script without its executable bit', async () => {
    const dir = stagingDir()
    await stagePnpmLaunchers(dir)
    chmodSync(join(dir, PNPM_LAUNCHERS.darwin.file), 0o644)
    expect(await pnpmLauncherProblems(dir)).toEqual([`${join(dir, PNPM_LAUNCHERS.darwin.file)} is not executable`])
  })
})
