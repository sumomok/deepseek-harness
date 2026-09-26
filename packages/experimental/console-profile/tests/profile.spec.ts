/**
 * The customer-console package: its manifest, how its bundle layer composes
 * over the shipped Web bundles, and the `permission` row of its lock overlay
 * pinned as a closed set.
 *
 * The `permission` row does three things no other file states: it renames the
 * three access presets into customer vocabulary, it isolates `commands` so the
 * `permission-presets` package never registers `/permission`, and it names the
 * preset every new session is pinned to. Nothing downstream would fail loudly
 * if one of them drifted — a fourth preset, a renamed row, a dropped `isolate`
 * key, or a `defaultPreset` naming a preset the table no longer has all boot a
 * console that simply behaves differently.
 *
 * The console e2e compositions under `apps/web/tests/` install this bundle and
 * add only deployment rows beside it, so the last block checks that none of
 * them restates a row this layer owns.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { DshBundleManifest } from '@deepseek-ai/dsh-package-manifest'

/** This package's directory. */
const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url))
/** Repository root, reached from this package's directory. */
const REPO_ROOT = resolve(PACKAGE_ROOT, '../../..')

interface Manifest {
  name: string
  private?: boolean
  publishConfig?: unknown
  files?: string[]
  dependencies?: Record<string, string>
  dsh?: { bundle?: DshBundleManifest }
}

/**
 * One package manifest.
 * @param dir - absolute package directory.
 * @returns the parsed `package.json`.
 */
function manifestOf(dir: string): Manifest {
  return JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as Manifest
}

/**
 * Every patch a bundle package declares, in layer order.
 * @param dir - absolute package directory.
 * @returns the bundle's patch list.
 */
function bundlePatches(dir: string): ReturnType<typeof loadOverlayPatches> {
  const bundle = manifestOf(dir).dsh?.bundle
  if (bundle === undefined) throw new Error(`${dir} declares no bundle`)
  return bundlePatchPaths(dir, bundle).flatMap(path => loadOverlayPatches('test', path))
}

/** The console bundle's own patch file. */
const CONSOLE_PATCH = resolve(PACKAGE_ROOT, 'cordis.patch.yml')
/** The overlay a deployment applies above the profile patch. */
const LOCK_PATCH = resolve(PACKAGE_ROOT, 'permission-lock.patch.yml')

/** The console e2e deployment layers, each composed beside this bundle. */
const TEST_DEPLOYMENTS = [
  'apps/web/tests/server-sidebar.overlay.yml',
  'apps/web/tests/server-sidebar-homepage.overlay.yml',
  'apps/web/tests/server-sidebar-views.overlay.yml',
] as const

/** The access presets the console names, by id, in table order. */
const PRESET_IDS = ['read-only', 'workspace-write', 'danger-full-access'] as const
/** The same three rows by the customer-facing name each renders under, in the same order. */
const PRESET_NAMES = ['只读', '可修改文件', '完全放开'] as const
/**
 * The knob pair each row bundles, in the same order. These are what the
 * deployment actually enforces, and what `defaultPreset` resolves against —
 * a row renamed in place would keep this file green, a row whose `sandbox`
 * moved would not.
 */
const PRESET_KNOBS = [
  { sandbox: 'read-only', approval: 'ask' },
  { sandbox: 'workspace-write', approval: 'ask' },
  { sandbox: 'danger-full-access', approval: 'never' },
] as const
/**
 * The two rows that draw Settings → Plugins: the section with its configurable
 * cards, and the read-only Loader inventory tab inside it. A console end user
 * administers no plugins, and every card in that section names a host-plane
 * subsystem in vendor vocabulary.
 */
const PLUGIN_SETTINGS_ROWS = [
  ['ui-settings-plugins', '@deepseek-ai/dsh-client-ui-settings-plugins'],
  ['ui-settings-plugin-inventory', '@deepseek-ai/dsh-client-ui-settings-plugin-inventory'],
] as const
/** The preset a new session is pinned to, absent a stored `permission.defaultPreset`. */
const PINNED_PRESET = 'workspace-write'

interface Row {
  id?: string
  name?: string
  isolate?: Record<string, unknown>
  disabled?: boolean
  insert?: Row[]
  config?: {
    defaultPreset?: unknown
    presets?: Record<string, { name?: unknown; sandbox?: unknown; approval?: unknown }>
    default?: unknown
  }
}

/**
 * Every top-level entry of one patch file.
 * @param file - repository-relative or absolute path to the patch.
 * @returns the parsed entry list.
 */
function entriesOf(file: string): Row[] {
  return yaml.load(readFileSync(resolve(REPO_ROOT, file), 'utf8'), { schema: entryListSchema }) as Row[]
}

/**
 * The one row a patch addresses by id.
 * @param file - repository-relative or absolute path to the patch.
 * @param id - the entry id to find.
 * @returns the row, or undefined when the patch carries none.
 */
function rowOf(file: string, id: string): Row | undefined {
  return entriesOf(file).find(entry => entry.id === id)
}

/**
 * Every entry id a patch file addresses or inserts.
 * @param file - repository-relative or absolute path to the patch.
 * @returns the ids, in file order.
 */
function idsOf(file: string): string[] {
  return entriesOf(file).flatMap(entry => [
    ...entry.id === undefined ? [] : [entry.id],
    ...(entry.insert ?? []).flatMap(row => row.id === undefined ? [] : [row.id]),
  ])
}

const shipped = rowOf(LOCK_PATCH, 'permission')

describe('the console bundle manifest', () => {
  const manifest = manifestOf(PACKAGE_ROOT)

  it('is a private bundle whose one layer is its own patch', () => {
    expect(manifest.private).toBe(true)
    expect(manifest.publishConfig).toBeUndefined()
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('depends on every package its rows load, and on the package whose skills a row mounts', () => {
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-agent-preset',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-experimental-console-mcp',
      '@deepseek-ai/dsh-experimental-content-column',
      '@deepseek-ai/dsh-experimental-content-surface',
      '@deepseek-ai/dsh-experimental-library-skills',
      '@deepseek-ai/dsh-experimental-server-layout',
      '@deepseek-ai/dsh-experimental-server-sidebar',
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-tool-todo',
    ])
  })

  it('ships the lock overlay beside the bundle layer, outside `dsh.bundle.patch`', () => {
    expect(manifest.files).toContain('permission-lock.patch.yml')
    expect(idsOf(LOCK_PATCH)).toEqual(['permission', 'agent-preset-registry'])
    // In the bundle layer each row would sit below the profile patch, where a
    // settings write to `defaultPreset` or `selectedDefault` outranks it.
    expect(idsOf(CONSOLE_PATCH)).not.toContain('permission')
    expect(idsOf(CONSOLE_PATCH)).not.toContain('agent-preset-registry')
  })
})

describe('the console layer over the shipped Web bundles', () => {
  const web = [resolve(REPO_ROOT, 'packages/bundle/base'), resolve(REPO_ROOT, 'packages/bundle/web-app')]
    .map(dir => bundlePatches(dir))
  const warnings: string[] = []
  const entries = composeEntries([...web, bundlePatches(PACKAGE_ROOT)], message => warnings.push(message))
  const byId = new Map(entries.map(entry => [entry.id, entry]))

  it('addresses only rows the shipped layers compose', () => {
    // A disable row naming an id nothing inserts is a warning, not an error:
    // a renamed shipped row would otherwise leave its surface on the page.
    expect(warnings).toEqual([])
  })

  it('inserts the shell, the sidebar, the MCP capability, and the library-skills provider at stable ids', () => {
    for (const id of ['server-layout', 'content-surface', 'content-column', 'server-sidebar', 'console-mcp', 'library-skills']) {
      expect(byId.has(id)).toBe(true)
      expect(byId.get(id)?.disabled).not.toBe(true)
    }
  })

  it('leaves `console` the only Agent preset row it does not disable', () => {
    const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset')
    // Every shipped declaration is present to be disabled; a renamed one would
    // surface as a warning above and as a fifth id here.
    expect(presets.map(entry => entry.id).sort())
      .toEqual(['preset-console', 'preset-cordis', 'preset-minimal', 'preset-ptc', 'preset-standard'])
    expect(presets.filter(entry => entry.disabled !== true).map(entry => entry.id)).toEqual(['preset-console'])
  })

  it('declares the `console` Agent preset with the customer assistant\'s rows and no developer row', () => {
    const preset = byId.get('preset-console')
    expect(preset).toMatchObject({ name: '@deepseek-ai/dsh-agent-preset', config: { id: 'console' } })
    expect(preset?.disabled).not.toBe(true)
    const plugins = (preset?.config as { plugins?: Row[] } | undefined)?.plugins ?? []
    expect(plugins.map(row => row.id)).toEqual([
      'persona', 'tool-fs', 'skill-filesystem', 'tool-skill', 'compaction', 'tool-ask-user', 'tool-todo',
    ])
  })

  it('disables every shipped surface the customer page must not show', () => {
    for (const id of [
      'ui-layout', 'ui-sidebar', 'ui-agent-preset', 'ui-brand-official', 'ui-cordis', 'ui-trajectory',
      'ui-model-selection', 'session-log-download', 'ui-settings-models', 'ui-permission',
      'ui-settings-plugins', 'ui-settings-plugin-inventory',
    ]) {
      expect(byId.get(id)?.disabled).toBe(true)
    }
  })

  it('removes Settings → Plugins by id, both halves, while the shipped Web bundles still compose them', () => {
    // The disable belongs to the console, not to the product: without this
    // layer the two rows are composed and enabled, so a row retired upstream
    // surfaces as a warning above rather than as dead configuration here.
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    for (const [id, name] of PLUGIN_SETTINGS_ROWS) {
      expect(rowOf(CONSOLE_PATCH, id)).toEqual({ id, disabled: true })
      expect(shipped.get(id)).toMatchObject({ name })
      expect(shipped.get(id)?.disabled).not.toBe(true)
    }
  })

  it('leaves the settings shell composed, since it draws everything else on the page', () => {
    // `ui-settings-general` owns the panel, the navigation, and the General
    // section. The open-configuration-file action it also registers is hidden
    // by `terminology-guard.ts` instead.
    expect(idsOf(CONSOLE_PATCH)).not.toContain('ui-settings-general')
    expect(byId.get('ui-settings-general')?.disabled).not.toBe(true)
  })

  it('mounts the MCP capability by package name with an empty server list it states rather than defaults', () => {
    const mcp = byId.get('console-mcp')
    expect(mcp).toMatchObject({ name: '@deepseek-ai/dsh-experimental-console-mcp' })
    // A deployment's own list is then an edit to a value it can already see.
    expect(mcp?.config).toEqual({ servers: [] })
    expect(mcp?.disabled).not.toBe(true)
  })
})

describe('the lock overlay\'s permission row', () => {
  it('patches the shipped row by id and by package name', () => {
    expect(shipped).toMatchObject({ id: 'permission', name: '@deepseek-ai/dsh-permission-presets' })
  })

  it('names exactly the three access presets, in table order, with their customer-facing names', () => {
    const presets = shipped?.config?.presets
    expect(Object.keys(presets ?? {})).toEqual([...PRESET_IDS])
    expect(PRESET_IDS.map(id => presets?.[id]?.name)).toEqual([...PRESET_NAMES])
  })

  it('keeps each row on the knob pair it bundles', () => {
    const presets = shipped?.config?.presets
    expect(PRESET_IDS.map(id => ({ sandbox: presets?.[id]?.sandbox, approval: presets?.[id]?.approval })))
      .toEqual(PRESET_KNOBS.map(knobs => ({ ...knobs })))
  })

  it('isolates the command registry, and only that name, which is what keeps /permission unregistered', () => {
    expect(shipped?.isolate?.['commands']).toBe(true)
    // A second isolated name would silence a different injected child of the
    // same package with no other signal.
    expect(Object.keys(shipped?.isolate ?? {})).toEqual(['commands'])
  })

  it('states the pinned default rather than leaving it to be derived', () => {
    expect(shipped?.config?.defaultPreset).toBe(PINNED_PRESET)
    expect(PRESET_IDS).toContain(shipped?.config?.defaultPreset)
  })

  it('reconfigures the row rather than disabling it', () => {
    // A `disabled: true` here would take the whole permission service with it —
    // the chip's projection and the per-session pin included — while every
    // assertion above still passed.
    expect(shipped).not.toHaveProperty('disabled')
  })

  it('disables the Settings row that would otherwise still write that default', () => {
    expect(rowOf(CONSOLE_PATCH, 'ui-permission')).toEqual({ id: 'ui-permission', disabled: true })
  })
})

describe('the lock overlay\'s Agent-preset registry row', () => {
  const registry = rowOf(LOCK_PATCH, 'agent-preset-registry')

  it('patches the shipped row by id and by package name', () => {
    expect(registry).toMatchObject({ id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry' })
  })

  it('makes the bundle layer\'s `console` preset the default and stores no selection of its own', () => {
    // The whole config is restated: `selectedDefault` absent here is what a
    // refused settings write leaves in effect.
    expect(registry?.config).toEqual({ default: 'console' })
    expect(idsOf(CONSOLE_PATCH)).toContain('preset-console')
  })
})

describe.each(TEST_DEPLOYMENTS)('%s', (file) => {
  it('restates no row the console package owns', () => {
    const owned = new Set([...idsOf(CONSOLE_PATCH), ...idsOf(LOCK_PATCH)])
    expect(idsOf(file).filter(id => owned.has(id))).toEqual([])
  })
})
