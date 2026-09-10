/**
 * The rows a desktop profile ends up with, composed from the real layers a
 * launch applies rather than from a description of them.
 *
 * The layer carries four. `session-query-sqlite` opts into full-text search:
 * dsh-base and dsh-web-app both ship it off and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way, so
 * this product opts in from its own layer. `llm-deepseek` raises the
 * `Retry-After` wait a rate-limited request may accept, which dsh-llm-retry
 * reads from the provider's own `retryPolicy` rather than from its own config.
 * `vision-switch` names where an image sent on a text-only model moves the
 * session, which the plugin otherwise takes from a constant compiled into it,
 * and `llm-permission-gateway` names the review model's own route, which the
 * gate otherwise takes from a factory pair naming a retired model.
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
  // whole config, so the restatement has to track it. It states more than that
  // layer does — the fields the shipped adapter's own `deepseek-flash` row
  // declares, which the vendored layer omits to inherit them — so what has to
  // hold is containment: the same rows in the same order, and every key that
  // layer states surviving with its value. A model or the vision default
  // dropped below fails here, which is what this case is for.
  it('carries every row and key the catalog below composes', () => {
    const inherited = entry(below, 'llm-deepseek').config?.['models'] as Partial<DeepSeekCatalogModel>[] | undefined
    expect(inherited).toBeDefined()
    const composed = entry(desktop, 'llm-deepseek').config?.['models'] as Partial<DeepSeekCatalogModel>[]
    expect(composed.map(row => row.id)).toEqual(inherited?.map(row => row.id))
    for (const [index, row] of (inherited ?? []).entries()) expect(composed[index]).toMatchObject(row)
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

describe('the composed llm-permission-gateway row', () => {
  it('takes the gate\'s own factory route through the layers below', () => {
    expect(entry(below, 'llm-permission-gateway').config?.['model']).toBe('deepseek-v4-flash')
  })

  // The judge runs on the same model the product runs on, rather than on a
  // retired name DeepSeek only redirects. Comparing against the composed
  // default keeps the two moving together.
  it('reviews on the model sessions start on', () => {
    expect(entry(desktop, 'llm-permission-gateway').config?.['model'])
      .toBe(entry(desktop, 'agent-default-model').config?.['model'])
  })

  // `provider` and `model` are the gate's only required fields and the only
  // two its own layer sets, so replacing the whole config drops nothing.
  it('replaces a config that held exactly the two keys it restates', () => {
    expect(Object.keys(entry(below, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['model', 'provider'])
    expect(Object.keys(entry(desktop, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['model', 'provider'])
  })
})

describe('the desktop composition layer as a whole', () => {
  it('changes exactly the four rows it owns and nothing else', () => {
    const changed = desktop.filter((row) => {
      const before = below.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    // Sorted, because the order these come back in is the order dsh-base
    // happens to list them and carries nothing about this layer.
    expect(changed.map(row => row.id).sort())
      .toEqual(['llm-deepseek', 'llm-permission-gateway', 'session-query-sqlite', 'vision-switch'])
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
  // (`resolveModels` reads `config.models ?? DEFAULT_MODELS`), which is what
  // lets this table drop the retired models the adapter still carries — and
  // what makes every field of the row it keeps this layer's responsibility.
  // The adapter now ships `deepseek-flash` itself, so the row is a restatement
  // of the shipped one: the keys are compared against it rather than listed
  // here, so a field upstream adds fails this case instead of composing a row
  // that quietly drops it. The vendored plugin one layer below ships its own
  // comparison against the adapter version its devDependencies pin — not the
  // one this payload carries, and whose test suite no gate here runs — so the
  // shipped row is pinned against the shipped adapter here instead.
  it('restates the adapter\'s own deepseek-flash row, naming only the label', () => {
    const factory = DeepSeekConfig({}) as { models: DeepSeekCatalogModel[]; defaultContextWindow: number }
    const composed = entry(desktop, 'llm-deepseek').config?.['models'] as Partial<DeepSeekCatalogModel>[]
    expect(composed.map(row => row.id)).toEqual(['deepseek-flash'])
    const shipped = factory.models.find(row => row.id === 'deepseek-flash')
    if (shipped === undefined) throw new Error('the shipped adapter carries no deepseek-flash row')
    // `description` is the one key the row adds; everything else the adapter
    // declares must be present, and `name` is the only one allowed to differ.
    expect(Object.keys(composed[0] ?? {}).sort())
      .toEqual([...new Set([...Object.keys(shipped), 'description'])].sort())
    const restated = Object.fromEntries(
      Object.entries(shipped).filter(([key]) => key !== 'name'),
    )
    expect(Object.fromEntries(
      Object.entries(composed[0] ?? {}).filter(([key]) => key !== 'name' && key !== 'description'),
    )).toEqual(restated)
    // The two keys this deployment owns: a dotted product name and the line
    // the picker shows under it.
    expect(composed[0]?.name).toBe('DeepSeek-V4.1-Flash')
    expect(composed[0]?.description).toBe('V4.1 Flash · 文本与图片')
    // Without this the loop rewrites system node 0 on a mid-session prompt
    // change instead of appending after the cached history.
    expect(composed[0]?.systemPromptUpdate).toBe('in-history')
    // The capacities the row now restates. The comparison above ties them to
    // the shipped adapter; these literals are what fails when a capacity moves
    // on both sides at once.
    expect({
      contextWindow: composed[0]?.contextWindow,
      imagePixelBudget: composed[0]?.imagePixelBudget,
      imageMaxBytes: composed[0]?.imageMaxBytes,
    }).toEqual({ contextWindow: 1_000_000, imagePixelBudget: 640_000, imageMaxBytes: 1_048_576 })
    expect(factory.defaultContextWindow).toBe(1_000_000)
    expect(composed[0]?.inputModalities).toEqual(['text', 'image'])
  })
})
