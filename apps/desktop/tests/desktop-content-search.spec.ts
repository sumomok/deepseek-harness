/**
 * The `session-query-sqlite` row a desktop profile ends up with, composed from
 * the real layers a launch applies rather than from a description of them.
 *
 * dsh-base and dsh-web-app both ship full-text search off, and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way; this
 * product opts in from its own layer instead. An id-targeted patch replaces the
 * target row's whole `config`, so the desktop layer restates `path` beside
 * `openAt`, and composing every layer here is what catches a restatement that
 * stops replacing what it meant to — or a built-in plugin that starts patching
 * the same row.
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { BUILTIN_WEB_BUNDLES } from '../src/profile-seed.ts'

/** The bundle under test, which is also this repository's own composition layer. */
const DESKTOP_APP = '@deepseek-ai/dsh-desktop-app'

/** The composed-entry fields these cases read. */
interface Entry {
  id?: string
  disabled?: unknown
  config?: Record<string, unknown>
}

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))
// The deploy root whose closure becomes the payload's `server/node_modules`;
// its manifest is the installation anchor the shipped Loader resolves bundles
// from.
const serverDir = join(repoRoot, 'apps', 'desktop-server')
const installAnchor = join(serverDir, 'package.json')

/**
 * One built-in bundle's patch layer, resolved and read the way `loadProfile`
 * reads it: the package directory from the installation anchor, then the file
 * its manifest's `dsh.bundle.patch` names. A name that does not resolve throws
 * out of `resolveBundleDir`, so a missing payload package fails these cases
 * rather than quietly composing one layer fewer.
 * @param packageName - the bundle package name from {@link BUILTIN_WEB_BUNDLES}.
 * @returns the layer's patch list.
 * @throws when the package does not resolve or declares no `dsh.bundle.patch`.
 */
function bundlePatches(packageName: string): ReturnType<typeof loadOverlayPatches> {
  const dir = resolveBundleDir('test', packageName, installAnchor, serverDir)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error(`profile bundle ${packageName} declares no dsh.bundle.patch`)
  return loadOverlayPatches('test', join(dir, declared))
}

/** One composed entry by id; an absent id throws rather than returning undefined into an expectation. */
function entry(entries: Entry[], id: string): Entry {
  const found = entries.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`composed no entry with id ${id}`)
  return found
}

// The two shipped bundles are workspace source here rather than payload
// packages: a launch resolves them from the installation, not from the deploy
// root the built-ins come from.
const shippedLayers = [
  loadOverlayPatches('test', join(repoRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')),
  loadOverlayPatches('test', join(repoRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')),
]
const builtinLayers = BUILTIN_WEB_BUNDLES.map(name => ({ name, patches: bundlePatches(name) }))

const below = composeEntries([
  ...shippedLayers,
  ...builtinLayers.filter(layer => layer.name !== DESKTOP_APP).map(layer => layer.patches),
]) as Entry[]
const desktop = composeEntries([...shippedLayers, ...builtinLayers.map(layer => layer.patches)]) as Entry[]

describe('the desktop payload', () => {
  it('seeds the composition layer, so the layer below is one a launch applies', () => {
    expect(BUILTIN_WEB_BUNDLES).toContain(DESKTOP_APP)
  })

  it('names it last, the one position a fresh and an upgraded profile agree on', () => {
    expect(BUILTIN_WEB_BUNDLES.at(-1)).toBe(DESKTOP_APP)
  })

  it('resolves the bundle from the deploy root that becomes the payload', () => {
    expect(resolveBundleDir('test', DESKTOP_APP, installAnchor, serverDir)).toContain(join('apps', 'desktop-server'))
  })
})

describe('the composed session-query row', () => {
  it('stays off through every bundle layer below the desktop one', () => {
    expect(entry(below, 'session-query-sqlite').config?.['openAt']).toBe('never')
  })

  it('opens the index at the first search once the desktop layer applies', () => {
    const row = entry(desktop, 'session-query-sqlite')
    expect(row.config?.['openAt']).toBe('first-search')
    expect(row.disabled).toBeUndefined()
  })

  it('indexes into a durable derived database, not the ephemeral shipped one', () => {
    expect(entry(below, 'session-query-sqlite').config?.['path']).toBe(':memory:')
    expect(entry(desktop, 'session-query-sqlite').config?.['path']).toMatchObject({
      __jsExpr: "dshHomePath('session-search/desktop.db')",
    })
  })

  it('changes nothing else in the composition', () => {
    const changed = desktop.filter((row) => {
      const before = below.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    expect(changed.map(row => row.id)).toEqual(['session-query-sqlite'])
  })
})
