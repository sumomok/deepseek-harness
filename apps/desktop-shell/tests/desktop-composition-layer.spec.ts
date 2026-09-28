/**
 * The rows a desktop profile ends up with, composed from the real layers a
 * launch applies rather than from a description of them.
 *
 * The layer patches seven rows and inserts two of its own.
 * `session-query-sqlite` opts into full-text search: dsh-base and dsh-web-app
 * both ship it off and
 * `apps/cli/tests/lazy-search-startup.compat.spec.ts` pins them that way, so
 * this product opts in from its own layer. `llm-deepseek` raises the
 * `Retry-After` wait a rate-limited request may accept, which dsh-llm-retry
 * reads from the provider's own `retryPolicy` rather than from its own config.
 * `vision-switch` names where an image sent on a text-only model moves the
 * session, which the plugin otherwise takes from a constant compiled into it,
 * and `llm-permission-gateway` names the review model's own route, which the
 * gate otherwise takes from the pair its own layer ships, and sends every
 * `plugin_manager` call to a person. `plugin-manager`
 * points upstream's plugin installer at the pnpm launcher the payload ships,
 * `office-to-pdf` is off because the payload carries no LibreOffice engine, and
 * `ui-chat` starts work details compact. The rows it inserts are
 * `desktop-brand`, this package itself, whose browser half names the product
 * in the sidebar, and `desktop-server-log`, which appends the server's own
 * logger records to the desktop log file.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { composeEntries, loadOverlayPatches, resolveBundleDir } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import { Config as DeepSeekConfig, type DeepSeekCatalogModel } from '@deepseek-ai/dsh-llm-deepseek'
import { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
import { apply as applyPluginManagerTool, inject as pluginManagerToolInject } from '@deepseek-ai/dsh-plugin-manager/tools'
import { PNPM_LAUNCHER_ENV } from '../src/pnpm-launcher.ts'
import { SERVER_LOG_ENV } from '../src/server.ts'
import { BUILTIN_WEB_BUNDLES, REQUIRED_WEB_BUNDLES } from '../src/profile-seed.ts'

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

/**
 * One shipped bundle's patch layer, every file its manifest's
 * `dsh.bundle.patch` names in order, read from workspace source.
 * @param dir - the bundle's package directory.
 * @returns the layer's patch list.
 */
function shippedPatches(dir: string): ReturnType<typeof loadOverlayPatches> {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dsh?: { bundle?: { patch?: string | string[] } }
  }
  const declared = manifest.dsh?.bundle?.patch
  if (declared === undefined) throw new Error(`shipped bundle ${dir} declares no dsh.bundle.patch`)
  return (typeof declared === 'string' ? [declared] : declared).flatMap(file => loadOverlayPatches('test', join(dir, file)))
}

// The two shipped bundles are workspace source here rather than payload
// packages: a launch resolves them from the installation, not from the deploy
// root the built-ins come from. dsh-web-app's layer includes its agent-preset
// files, which declare the presets whose child rows the cases below read.
const shippedLayers = [
  shippedPatches(join(repoRoot, 'packages', 'bundle', 'base')),
  shippedPatches(join(repoRoot, 'packages', 'bundle', 'web-app')),
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

  // The plugin's DEFAULT_TARGET is `deepseek-flash`, the same model the
  // composed default starts on. Comparing against the composed default is what
  // keeps the two moving together, rather than restating a model id here that a
  // later default change would leave behind.
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
    expect(entry(below, 'llm-permission-gateway').config?.['model']).toBe('deepseek-flash')
  })

  // The judge runs on the same model the product runs on. Comparing against
  // the composed default keeps the two moving together.
  it('reviews on the model sessions start on', () => {
    expect(entry(desktop, 'llm-permission-gateway').config?.['model'])
      .toBe(entry(desktop, 'agent-default-model').config?.['model'])
  })

  // `provider` and `model` are the gate's only required fields and the only
  // two its own layer sets, so replacing the whole config drops nothing but
  // the default `alwaysAsk` map the desktop row restates.
  it('replaces a config that held exactly the two keys it restates, adding alwaysAsk', () => {
    expect(Object.keys(entry(below, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['model', 'provider'])
    expect(Object.keys(entry(desktop, 'llm-permission-gateway').config ?? {}).sort())
      .toEqual(['alwaysAsk', 'model', 'provider'])
  })

  // The desktop map replaces the gate's default one, so every default entry
  // has to come back with the gate's own sentence, and the one entry it adds
  // is keyed by the name upstream's tool registers.
  it('asks a person before every plugin_manager call, and keeps each of the gate\'s own entries', async () => {
    const gatewayDir = resolveBundleDir('test', '@haoran/dsh-llm-permission-gateway', installAnchor, serverDir)
    const gateway = await import(pathToFileURL(join(gatewayDir, 'lib', 'index.js')).href) as {
      Config: (config: Record<string, unknown>) => { alwaysAsk: Record<string, string> }
    }
    const defaults = gateway.Config({ provider: 'p', model: 'm' }).alwaysAsk
    const registered: string[] = []
    applyPluginManagerTool({ tools: { register: (tool: { name: string }) => { registered.push(tool.name) } } } as never)
    expect(registered).toEqual(['plugin_manager'])

    const alwaysAsk = entry(desktop, 'llm-permission-gateway').config?.['alwaysAsk'] as Record<string, string>
    expect(Object.keys(alwaysAsk).sort()).toEqual([...Object.keys(defaults), ...registered].sort())
    for (const [tool, sentence] of Object.entries(defaults)) expect(alwaysAsk[tool]).toBe(sentence)
    expect(alwaysAsk['plugin_manager']?.trim().length).toBeGreaterThan(0)
  })
})

/**
 * The `tool-plugin-manager` row inside one preset's plugin list.
 * @param entries - a composed entry list.
 * @param presetId - the preset declaration row's id.
 * @returns the preset's child row.
 */
function presetToolRow(entries: Entry[], presetId: string): Entry {
  const plugins = entry(entries, presetId).config?.['plugins'] as Entry[] | undefined
  const found = plugins?.find(candidate => candidate.id === 'tool-plugin-manager')
  if (found === undefined) throw new Error(`${presetId} lists no tool-plugin-manager row`)
  return found
}

/**
 * Evaluate a composed `!!js` value the way the Loader does, against a given
 * `process.env`.
 * @param value - the composed field, `{ __jsExpr }` as `loadOverlayPatches` reads it.
 * @param env - the environment the expression sees.
 * @returns what the expression evaluates to.
 */
function evaluateWithEnv(value: unknown, env: Record<string, string>): unknown {
  const expression = (value as { __jsExpr?: unknown } | undefined)?.__jsExpr
  if (typeof expression !== 'string') throw new Error(`not a !!js value: ${JSON.stringify(value)}`)
  // oxlint-disable-next-line typescript/no-implied-eval -- evaluates this repository's own layer, as the Loader does
  return (new Function('process', `return (${expression})`) as (process: { env: Record<string, string> }) => unknown)({ env })
}

describe('the composed server-log row', () => {
  it('is the desktop layer\'s own, inserted by no layer below it', () => {
    expect(below.find(candidate => candidate.id === 'desktop-server-log')).toBeUndefined()
    expect((entry(desktop, 'desktop-server-log') as Entry & { name?: string }).name).toBe('@deepseek-ai/dsh-desktop-app/server-log')
  })

  // The shell names its log file in this variable for the server child; a
  // boot without the shell names nothing and mounts no exporter.
  it('mounts only when the shell names a file, and appends to that file', () => {
    const row = entry(desktop, 'desktop-server-log')
    expect(evaluateWithEnv(row.disabled, { [SERVER_LOG_ENV]: '/logs/dsh-server.log' })).toBe(false)
    expect(evaluateWithEnv(row.disabled, {})).toBe(true)
    expect(evaluateWithEnv(row.config?.['file'], { [SERVER_LOG_ENV]: '/logs/dsh-server.log' })).toBe('/logs/dsh-server.log')
  })

  // cordis orders ERROR 0 < INFO 1 < WARN 2 < DEBUG 3, so the threshold that
  // keeps warnings is 2, not the INFO a reader would expect to cover them.
  it('keeps warnings and drops debug', () => {
    expect(entry(desktop, 'desktop-server-log').config?.['level']).toBe(2)
  })
})

describe('the composed plugin-manager rows', () => {
  const profileGate = { __jsExpr: "!ctx.get('profileContext')" }

  it('mounts upstream\'s installer under a profile through the layers below', () => {
    expect(entry(below, 'plugin-manager').disabled).toEqual(profileGate)
    expect(entry(below, 'plugin-manager').config).toBeUndefined()
    expect(entry(below, 'ui-plugin-manager').disabled).toBeUndefined()
  })

  it('keeps the Host service and the sidebar page on under a profile once the desktop layer applies', () => {
    expect(entry(desktop, 'plugin-manager').disabled).toEqual(profileGate)
    expect(entry(desktop, 'ui-plugin-manager').disabled).toBeUndefined()
  })

  it('sets pnpmCommand and requiredModules and nothing else', () => {
    expect(Object.keys(entry(desktop, 'plugin-manager').config ?? {})).toEqual(['pnpmCommand', 'requiredModules'])
  })

  // The seed puts a required bundle back into the profile at every launch and
  // the service locks the rows it names, so the two lists are one decision.
  it('requires exactly the bundles the shell seed puts back on at every launch', () => {
    expect(entry(desktop, 'plugin-manager').config?.['requiredModules']).toEqual([...REQUIRED_WEB_BUNDLES])
  })

  it('names in requiredModules only built-ins whose own layer inserts a row of that module', () => {
    for (const name of REQUIRED_WEB_BUNDLES) {
      expect(BUILTIN_WEB_BUNDLES).toContain(name)
      const inserted = composeEntries([bundlePatches(name)]) as (Entry & { name?: string })[]
      expect(inserted.map(row => row.name)).toContain(name)
    }
  })

  it('composes a config the plugin manager accepts', () => {
    const config = entry(desktop, 'plugin-manager').config ?? {}
    const resolved = PluginManager.Config({ ...config, pnpmCommand: String(evaluateWithEnv(config['pnpmCommand'], {})) })
    expect(resolved.requiredModules).toEqual([...REQUIRED_WEB_BUNDLES])
    expect(resolved.pnpmCommand).toBe('pnpm')
  })

  // The packaged shell names the launcher in this variable; a development
  // launch names nothing.
  it('runs the launcher the shell names, and pnpm on PATH when it names none', () => {
    const pnpmCommand = entry(desktop, 'plugin-manager').config?.['pnpmCommand']
    expect(evaluateWithEnv(pnpmCommand, { [PNPM_LAUNCHER_ENV]: '/app/runtime/dsh-pnpm' })).toBe('/app/runtime/dsh-pnpm')
    expect(evaluateWithEnv(pnpmCommand, {})).toBe('pnpm')
  })

  // The cordis preset enables the agent tool under a profile, and its row sits
  // in the preset's `config.plugins`, where no id-targeted patch reaches. It
  // injects the service the Host row provides, so with that row on it mounts;
  // the gateway row's `alwaysAsk` is what sends each of its calls to a person.
  it('leaves the cordis preset\'s tool row gated on the profile alone, over a service that now registers', () => {
    expect(presetToolRow(below, 'preset-cordis').disabled).toEqual(profileGate)
    expect(presetToolRow(desktop, 'preset-cordis').disabled).toEqual(profileGate)
    expect(pluginManagerToolInject).toContain('pluginManager')
  })
})

describe('the composed office-to-pdf row', () => {
  it('starts LibreOffice converters through the layers below', () => {
    expect(entry(below, 'office-to-pdf').disabled).toBeUndefined()
  })

  // The payload rules drop every engine package, so a converter this row
  // started would fail on its first conversion.
  it('is off once the desktop layer applies', () => {
    expect(entry(desktop, 'office-to-pdf').disabled).toBe(true)
  })
})

describe('the composed ui-chat row', () => {
  it('takes the form\'s default through the layers below', () => {
    expect(entry(below, 'ui-chat').config).toBeUndefined()
  })

  it('starts work details compact once the desktop layer applies', () => {
    expect(entry(desktop, 'ui-chat').config).toEqual({ transcriptView: 'compact' })
  })
})

describe('the composed brand row', () => {
  it('is absent below the desktop layer', () => {
    expect(below.find(row => row.id === 'desktop-brand')).toBeUndefined()
  })

  it('mounts this package, whose browser half occupies the sidebar brand name', () => {
    expect(entry(desktop, 'desktop-brand')).toEqual({ id: 'desktop-brand', name: DESKTOP_APP })
  })
})

describe('the composed telemetry rows', () => {
  // The composed row is what a launch applies, so a later bundle layer
  // re-enabling one of these shows up here and nowhere else. The shipped rows
  // belong to `packages/bundle/base/tests/base.spec.ts` and the reason a mode
  // cannot carry the decision to
  // `packages/session/session-telemetry-otel/tests/otel.spec.ts`; the second
  // layer — the `DSH_TELEMETRY_DISABLED` this shell puts on the spawned server,
  // which reaches the telemetry row alone — belongs to `tests/server.spec.ts`.
  it('composes every DeepSeek-bound reporter off, through every bundle layer', () => {
    expect(entry(desktop, 'session-telemetry-otel').disabled).toBe(true)
    expect(entry(desktop, 'plugin-package-inventory-deepseek').disabled).toBe(true)
    // Mounted rather than disabled: its own `enabled: false` makes `apply()`
    // return before it registers the request contribution.
    expect(entry(desktop, 'session-log-deepseek').config).toEqual({ enabled: false })
  })
})

describe('the desktop composition layer as a whole', () => {
  it('changes exactly seven rows, adds its own two, and nothing else', () => {
    const changed = desktop.filter((row) => {
      const before = below.find(candidate => candidate.id === row.id)
      return before === undefined || JSON.stringify(before) !== JSON.stringify(row)
    })
    // Sorted, because the order these come back in is the order dsh-base
    // happens to list them and carries nothing about this layer.
    expect(changed.map(row => row.id).sort()).toEqual([
      'desktop-brand', 'desktop-server-log', 'llm-deepseek', 'llm-permission-gateway', 'office-to-pdf', 'plugin-manager',
      'session-query-sqlite', 'ui-chat', 'vision-switch',
    ])
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
    const factory = DeepSeekConfig({})
    const composed = entry(desktop, 'llm-deepseek').config?.['models'] as Partial<DeepSeekCatalogModel>[]
    expect(composed.map(row => row.id)).toEqual(['deepseek-flash'])
    const shipped = factory.models.get().find(row => row.id === 'deepseek-flash')
    if (shipped === undefined) throw new Error('the shipped adapter carries no deepseek-flash row')
    // `description` is the one key the row adds; everything else the adapter
    // declares must be present with the adapter's value, and `name` is the only
    // one allowed to differ.
    expect(Object.keys(composed[0] ?? {}).sort())
      .toEqual([...new Set([...Object.keys(shipped), 'description'])].sort())
    const restated = Object.fromEntries(
      Object.entries(shipped).filter(([key]) => key !== 'name'),
    )
    expect(Object.fromEntries(
      Object.entries(composed[0] ?? {}).filter(([key]) => key !== 'name' && key !== 'description'),
    )).toEqual(restated)
    // The label keys this deployment owns: a dotted product name and the line
    // the picker shows under it.
    expect(composed[0]?.name).toBe('DeepSeek-V4.1-Flash')
    expect(composed[0]?.description).toBe('V4.1 Flash · 文本与图片')
    // Without this the loop rewrites system node 0 on a mid-session prompt
    // change instead of appending after the cached history.
    expect(composed[0]?.systemPromptUpdate).toBe('in-history')
    // Without this a tool that joins mid-session changes the declarations
    // ahead of the cached history instead of arriving as an addition.
    expect(composed[0]?.toolUpdate).toBe('addition-only')
    // The capacity the row states. The comparison above ties it to the shipped
    // adapter; this literal is what fails when the context window moves.
    expect(composed[0]?.contextWindow).toBe(1_000_000)
    expect(factory.defaultContextWindow.get()).toBe(1_000_000)
    expect(composed[0]?.inputModalities).toEqual(['text', 'image'])
  })
})
