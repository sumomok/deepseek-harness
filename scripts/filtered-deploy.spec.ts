/**
 * The deploy command line both packaging pipelines begin with, and the check
 * that covers what its unused-patch flag stops pnpm from reporting.
 * @module
 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { filteredDeployArgs, STAGED_PATCHES, verifyStagedPatches } from './filtered-deploy.ts'

const created: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of created.splice(0)) await rm(directory, { recursive: true, force: true })
})

/**
 * A staged closure holding one file per named patch, with its marker or
 * without it.
 * @param patched - the packages whose staged file carries its marker.
 * @returns the closure directory.
 */
async function closure(patched: readonly string[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-staged-closure-'))
  created.push(root)
  for (const patch of STAGED_PATCHES) {
    const path = join(root, 'node_modules', patch.package, patch.file)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, patched.includes(patch.package) ? `head\n${patch.marker}\ntail\n` : 'head\ntail\n')
  }
  return root
}

describe('filteredDeployArgs', () => {
  it('deploys the named package with the destination last', () => {
    const args = filteredDeployArgs('@deepseek-ai/dsh-desktop-server', '/tmp/staging/server')

    expect(args.slice(0, 5)).toEqual(['--filter', '@deepseek-ai/dsh-desktop-server', 'deploy', '--legacy', '--prod'])
    expect(args.at(-1)).toBe('/tmp/staging/server')
  })

  it('keeps the linker settings the staged tree is built for', () => {
    const args = filteredDeployArgs('dsh-python-runtime-closure', '/tmp/staging')

    expect(args).toContain('--config.node-linker=hoisted')
    expect(args).toContain('--config.auto-install-peers=false')
    expect(args).toContain('--config.link-workspace-packages=true')
  })

  it('allows unused patches, which is what lets a filtered deploy resolve at all', () => {
    // Every closure deployed here lacks at least one patched package —
    // electron-updater belongs to the Electron shell — and pnpm answers an
    // unused patch with ERR_PNPM_UNUSED_PATCH before it stages anything.
    for (const rootPackage of ['@deepseek-ai/dsh-desktop-server', 'dsh-python-runtime-closure']) {
      expect(filteredDeployArgs(rootPackage, '/tmp/staging')).toContain('--config.allow-unused-patches=true')
    }
  })
})

describe('verifyStagedPatches', () => {
  it('accepts a closure whose patched packages carry their markers', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const root = await closure(STAGED_PATCHES.map(patch => patch.package))

    await expect(verifyStagedPatches(root, 'probe')).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith(expect.stringContaining('probe: staged patched packages: node-pty'))
  })

  it('reports a staged copy that is the published package rather than the patched one', async () => {
    const root = await closure([])

    await expect(verifyStagedPatches(root, 'probe')).rejects.toThrow(
      'probe: the staged node-pty is unpatched (lib/unixTerminal.js carries no DSH_NODE_PTY_SPAWN_HELPER);'
      + ' the deploy allows unused patches, so pnpm reports nothing.',
    )
  })

  it('reports a package that never reached the closure, and where to say so', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-staged-closure-'))
    created.push(root)

    await expect(verifyStagedPatches(root, 'probe')).rejects.toThrow(
      'probe: node-pty never reached the closure (no lib/unixTerminal.js)'
      + ' — remove it from STAGED_PATCHES if this closure is no longer meant to carry it;'
      + ' the deploy allows unused patches, so pnpm reports nothing.',
    )
  })
})
