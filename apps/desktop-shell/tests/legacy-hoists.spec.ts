/**
 * Which production dependencies of a legacy deploy hoist are copied into the
 * staging tree, and from where.
 * @module
 */

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreHoistedDependencies } from '../scripts/legacy-hoists.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/**
 * Write one package directory.
 * @param dir - the package directory.
 * @param dependencies - its production dependencies.
 * @param devDependencies - its development dependencies.
 */
function pkg(dir: string, dependencies: string[] = [], devDependencies: string[] = []): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: dir.split('/node_modules/').at(-1),
    dependencies: Object.fromEntries(dependencies.map(name => [name, 'workspace:*'])),
    devDependencies: Object.fromEntries(devDependencies.map(name => [name, 'workspace:*'])),
  }))
  writeFileSync(join(dir, 'index.js'), 'export {}\n')
}

/**
 * A deploy the way the legacy deployer leaves it: the installation package
 * beside the deploy source with its own nested `node_modules` linking into a
 * workspace, and a staging tree that already holds part of the closure.
 * @returns the staging `node_modules` and the hoisted package's directory.
 */
function deploy(): { staging: string; hoisted: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'legacy-hoists-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  pkg(join(workspace, 'bundle-base'), ['@x/settings', '@x/present', 'yaml', '@x/withheld'])
  pkg(join(workspace, 'settings'), ['yaml'])
  mkdirSync(join(workspace, 'settings', 'node_modules'), { recursive: true })
  pkg(join(workspace, 'settings', 'node_modules', 'yaml'))
  pkg(join(workspace, 'bundle-base', 'node_modules', 'yaml'))
  pkg(join(workspace, 'testkit'))
  const hoisted = join(root, 'source', 'node_modules', '@x', 'dsh')
  pkg(hoisted, ['@x/base', '@x/present'], ['@x/testkit'])
  const links = [
    [hoisted, '@x/base', 'bundle-base'], [hoisted, '@x/testkit', 'testkit'], [join(workspace, 'bundle-base'), '@x/settings', 'settings'],
  ] as const
  for (const [from, name, target] of links) {
    const link = join(from, 'node_modules', name)
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(workspace, target), link)
  }
  const staging = join(root, 'staging', 'node_modules')
  pkg(join(staging, '@x', 'present'))
  pkg(join(staging, '@x', 'dsh'), ['@x/base', '@x/present'])
  return { staging, hoisted, workspace }
}

describe('restoreHoistedDependencies', () => {
  it('copies the production dependencies found only inside the hoist, and theirs, as real files', async () => {
    const { staging, hoisted } = deploy()
    const result = await restoreHoistedDependencies(staging, [{ name: '@x/dsh', source: hoisted }], ['@x/withheld'])
    expect(result).toEqual({ copied: ['@x/base', '@x/settings', 'yaml'], unresolved: [] })
    for (const name of ['@x/base', '@x/settings', 'yaml']) expect(existsSync(join(staging, name, 'index.js'))).toBe(true)
    expect(lstatSync(join(staging, '@x', 'base')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(staging, '@x', 'base', 'package.json'), 'utf8')).toContain('@x/settings')
  })

  it('leaves development dependencies, withheld packages, and the nested trees out', async () => {
    const { staging, hoisted } = deploy()
    await restoreHoistedDependencies(staging, [{ name: '@x/dsh', source: hoisted }], ['@x/withheld'])
    expect(existsSync(join(staging, '@x', 'testkit'))).toBe(false)
    expect(existsSync(join(staging, '@x', 'withheld'))).toBe(false)
    expect(existsSync(join(staging, '@x', 'base', 'node_modules'))).toBe(false)
  })

  it('reports a production dependency no source provides', async () => {
    const { staging, hoisted } = deploy()
    const result = await restoreHoistedDependencies(staging, [{ name: '@x/dsh', source: hoisted }], [])
    expect(result.unresolved).toEqual(['@x/base -> @x/withheld'])
  })

  it('copies nothing when the staging tree already holds the closure', async () => {
    const { staging, hoisted } = deploy()
    await restoreHoistedDependencies(staging, [{ name: '@x/dsh', source: hoisted }], ['@x/withheld'])
    expect(await restoreHoistedDependencies(staging, [{ name: '@x/dsh', source: hoisted }], ['@x/withheld']))
      .toEqual({ copied: [], unresolved: [] })
  })
})
