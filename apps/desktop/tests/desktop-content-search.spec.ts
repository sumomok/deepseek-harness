/**
 * The `session-query-sqlite` row a desktop profile ends up with, composed from
 * the real layers a launch applies rather than from a description of them.
 *
 * dsh-base and dsh-web-app both ship full-text search off, and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way; this
 * product opts in from its own layer instead. An id-targeted patch replaces the
 * target row's whole `config`, so the desktop layer restates `path` beside
 * `openAt`, and composing all three layers here is what catches a restatement
 * that stops replacing what it meant to.
 * @module
 */

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
// The deploy root whose closure becomes the payload's `server/node_modules`,
// which is the installation anchor the shipped Loader resolves bundles from.
const installAnchor = join(repoRoot, 'apps', 'desktop-server', 'package.json')
const basePatchPath = join(repoRoot, 'packages', 'bundle', 'base', 'cordis.patch.yml')
const webPatchPath = join(repoRoot, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')

const desktopDir = resolveBundleDir('test', DESKTOP_APP, installAnchor, join(repoRoot, 'apps', 'desktop-server'))
const basePatches = loadOverlayPatches('test', basePatchPath)
const webPatches = loadOverlayPatches('test', webPatchPath)
const desktopPatches = loadOverlayPatches('test', join(desktopDir, 'cordis.patch.yml'))

/** One composed entry by id; an absent id throws rather than returning undefined into an expectation. */
function entry(entries: Entry[], id: string): Entry {
  const found = entries.find(candidate => candidate.id === id)
  if (found === undefined) throw new Error(`composed no entry with id ${id}`)
  return found
}

const shipped = composeEntries([basePatches, webPatches]) as Entry[]
const desktop = composeEntries([basePatches, webPatches, desktopPatches]) as Entry[]

describe('the desktop payload', () => {
  it('seeds the composition layer, so the layer below is one a launch applies', () => {
    expect(BUILTIN_WEB_BUNDLES).toContain(DESKTOP_APP)
  })

  it('names it last, the one position a fresh and an upgraded profile agree on', () => {
    expect(BUILTIN_WEB_BUNDLES.at(-1)).toBe(DESKTOP_APP)
  })

  it('resolves the bundle from the deploy root that becomes the payload', () => {
    expect(desktopDir).toContain(join('apps', 'desktop-server'))
  })
})

describe('the composed session-query row', () => {
  it('leaves the shipped bundles with content search off', () => {
    expect(entry(shipped, 'session-query-sqlite').config?.['openAt']).toBe('never')
  })

  it('opens the index at the first search once the desktop layer applies', () => {
    const row = entry(desktop, 'session-query-sqlite')
    expect(row.config?.['openAt']).toBe('first-search')
    expect(row.disabled).toBeUndefined()
  })

  it('indexes into a durable derived database, not the ephemeral shipped one', () => {
    expect(entry(shipped, 'session-query-sqlite').config?.['path']).toBe(':memory:')
    expect(entry(desktop, 'session-query-sqlite').config?.['path']).toMatchObject({
      __jsExpr: "dshHomePath('session-search/desktop.db')",
    })
  })

  it('changes nothing else in the composition', () => {
    const changed = desktop.filter((row) => {
      const before = shipped.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    expect(changed.map(row => row.id)).toEqual(['session-query-sqlite'])
  })
})
