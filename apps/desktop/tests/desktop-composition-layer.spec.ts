/**
 * The rows a desktop profile ends up with, composed from the real layers a
 * launch applies rather than from a description of them.
 *
 * The layer carries three. `session-query-sqlite` opts into full-text search:
 * dsh-base and dsh-web-app both ship it off and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way, so
 * this product opts in from its own layer. `llm-deepseek` raises the
 * `Retry-After` wait a rate-limited request may accept, which dsh-llm-retry
 * reads from the provider's own `retryPolicy` rather than from its own config.
 * `vision-switch` names where an image sent on a text-only model moves the
 * session, which the plugin otherwise takes from a constant compiled into it.
 *
 * An id-targeted patch replaces the target row's whole `config`, so each row
 * restates every key it owns — `path` beside `openAt`, and the whole model
 * catalog beside `retryPolicy`, since a built-in plugin layer below sets it on
 * that same row. Composing every layer here is what catches a restatement that
 * stops replacing what it meant to, a built-in that starts patching one of
 * these rows, and a catalog that moves below without moving here.
 * @module
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { Config as DeepSeekConfig, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
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
})

describe('the composed llm-deepseek row', () => {
  it('accepts only the shipped ten-second Retry-After through the layers below', () => {
    expect(entry(below, 'llm-deepseek').config?.['retryPolicy']).toBeUndefined()
  })

  it('waits out a five-minute rate-limit window once the desktop layer applies', () => {
    expect(entry(desktop, 'llm-deepseek').config?.['retryPolicy']).toEqual({
      mode: 'normal',
      backoff: { maxDelayMs: 300_000 },
    })
  })

  // The layer below this one owns the picker catalog and this row replaces its
  // whole config, so the restatement has to track it. Comparing the two tables
  // fails here when that layer ships a different catalog, which is the one way
  // this row can silently drop a model or the vision default.
  it('restates the catalog the layer below composes, key for key', () => {
    const inherited = entry(below, 'llm-deepseek').config?.['models']
    expect(inherited).toBeDefined()
    expect(entry(desktop, 'llm-deepseek').config?.['models']).toEqual(inherited)
  })
})

describe('the composed vision-switch row', () => {
  it('takes the plugin\'s compiled-in target through the layers below', () => {
    expect(entry(below, 'vision-switch').config?.['target']).toBeUndefined()
  })

  // The plugin's DEFAULT_TARGET is `deepseek-v4-flash-vision-exp`, picked when
  // that was this deployment's starting model too. Comparing against the
  // composed default is what keeps the two moving together, rather than
  // restating a model id here that a later default change would leave behind.
  it('moves a session onto the model it already starts on', () => {
    expect(entry(desktop, 'vision-switch').config?.['target'])
      .toEqual(entry(desktop, 'agent-default-model').config)
  })

  it('restates enabled, which a whole-config replacement would drop', () => {
    expect(entry(desktop, 'vision-switch').config?.['enabled']).toBe(true)
  })
})

describe('the desktop composition layer as a whole', () => {
  it('changes exactly the three rows it owns and nothing else', () => {
    const changed = desktop.filter((row) => {
      const before = below.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    // Sorted, because the order these come back in is the order dsh-base
    // happens to list them and carries nothing about this layer.
    expect(changed.map(row => row.id).sort()).toEqual(['llm-deepseek', 'session-query-sqlite', 'vision-switch'])
  })

  // The invariant the catalog restatement broke once: this layer replaces
  // `llm-deepseek`'s whole config, so a default the layer below moved onto a
  // row this table does not carry composes a session on a model the picker
  // does not list.
  it('lists the model the composed default starts every session on', () => {
    const models = entry(desktop, 'llm-deepseek').config?.['models'] as { id: string }[]
    expect(models.map(row => row.id))
      .toContain(entry(desktop, 'agent-default-model').config?.['model'])
  })

  // A whole-table replacement never merges with the adapter's own catalog
  // (`resolveModels` reads `config.models ?? DEFAULT_MODELS`), so a factory row
  // that is added, dropped, renamed, or re-described upstream reaches no
  // picker until this table follows it. The vendored plugin ships that
  // comparison too, against the adapter version its own devDependencies pin —
  // which is not the one this payload carries, and whose test suite no gate
  // here runs. This is the same check against the shipped adapter.
  it('restates every factory row of the adapter this payload ships', () => {
    const factory = DeepSeekConfig({}) as { models: DeepSeekCatalogModel[]; defaultContextWindow: number }
    const composed = entry(desktop, 'llm-deepseek').config?.['models'] as Partial<DeepSeekCatalogModel>[]
    const byId = new Map(composed.map(row => [row.id, row]))
    for (const row of factory.models) {
      const shipped = byId.get(row.id)
      expect(shipped, row.id).toBeDefined()
      // Omitted capacities fall back to the adapter values the factory row
      // carries, so an omission stops reproducing the factory row the day one
      // of those defaults moves.
      expect({
        ...shipped,
        contextWindow: shipped?.contextWindow ?? factory.defaultContextWindow,
        inputModalities: shipped?.inputModalities ?? ['text'],
        ...(shipped?.inputModalities ?? []).includes('image')
          ? {
            imagePixelBudget: shipped?.imagePixelBudget ?? row.imagePixelBudget,
            imageMaxBytes: shipped?.imageMaxBytes ?? row.imageMaxBytes,
          }
          : {},
      }, row.id).toEqual({ ...row })
    }
  })
})
