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

import { existsSync, readFileSync } from 'node:fs'
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
/** The vendored `@haoran/dsh-auto-compact` tarball, relative to this package. */
const AUTO_COMPACT_TARBALL = 'vendor/haoran-dsh-auto-compact-0.5.1.tgz'
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

  it('depends on every package its rows load, on the package whose skills a row mounts, and on the vendored plugin\'s runtime import', () => {
    // `@deepseek-ai/schemastery` is no row's package: the vendored
    // `@haoran/dsh-auto-compact` imports it at runtime, and its optional peer
    // resolves to the workspace copy only through this manifest.
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual([
      '@deepseek-ai/dsh-agent-preset',
      '@deepseek-ai/dsh-command-compact',
      '@deepseek-ai/dsh-compaction-basic',
      '@deepseek-ai/dsh-compaction-tool-result-pruner',
      '@deepseek-ai/dsh-experimental-console-mcp',
      '@deepseek-ai/dsh-experimental-content-column',
      '@deepseek-ai/dsh-experimental-content-surface',
      '@deepseek-ai/dsh-experimental-library-skills',
      '@deepseek-ai/dsh-experimental-page-refresh',
      '@deepseek-ai/dsh-experimental-server-layout',
      '@deepseek-ai/dsh-experimental-server-sidebar',
      '@deepseek-ai/dsh-persona',
      '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/schemastery',
      '@haoran/dsh-auto-compact',
    ])
  })

  it('takes the automatic-compaction plugin from the tarball it vendors, never a link', () => {
    const spec = manifest.dependencies?.['@haoran/dsh-auto-compact']
    expect(spec).toBe(`file:./${AUTO_COMPACT_TARBALL}`)
    expect(existsSync(resolve(PACKAGE_ROOT, AUTO_COMPACT_TARBALL))).toBe(true)
  })

  it('ships the lock overlay beside the bundle layer, outside `dsh.bundle.patch`', () => {
    expect(manifest.files).toContain('permission-lock.patch.yml')
    expect(idsOf(LOCK_PATCH)).toEqual(['permission', 'agent-preset-registry', 'session-log-deepseek'])
    // In the bundle layer each row would sit below the profile patch, where a
    // settings write to `defaultPreset`, `selectedDefault`, or `enabled`
    // outranks it.
    expect(idsOf(CONSOLE_PATCH)).not.toContain('permission')
    expect(idsOf(CONSOLE_PATCH)).not.toContain('agent-preset-registry')
    expect(idsOf(CONSOLE_PATCH)).not.toContain('session-log-deepseek')
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

  it('inserts the shell, the sidebar, the page\'s build check, the MCP capability, the library-skills provider, and automatic compaction at stable ids', () => {
    for (const id of [
      'server-layout', 'content-surface', 'content-column', 'server-sidebar', 'page-refresh', 'console-mcp', 'library-skills',
      'auto-compact',
    ]) {
      expect(byId.has(id)).toBe(true)
      expect(byId.get(id)?.disabled).not.toBe(true)
    }
  })

  it('leaves `console` and its `standard` twin the only Agent preset rows it does not disable', () => {
    const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset')
    // Every shipped declaration is present to be disabled; a renamed one would
    // surface as a warning above and as a sixth id here.
    expect(presets.map(entry => entry.id).sort()).toEqual([
      'preset-console', 'preset-cordis', 'preset-minimal', 'preset-ptc', 'preset-standard', 'preset-standard-as-console',
    ])
    expect(presets.filter(entry => entry.disabled !== true).map(entry => entry.id).sort())
      .toEqual(['preset-console', 'preset-standard-as-console'])
  })

  it('declares `standard` with exactly `console`\'s plugins, so a session created under `standard` resumes with the customer tool set', () => {
    const twin = byId.get('preset-standard-as-console')
    expect(twin).toMatchObject({ name: '@deepseek-ai/dsh-agent-preset', config: { id: 'standard' } })
    expect((twin?.config as { plugins?: unknown }).plugins).toEqual((byId.get('preset-console')?.config as { plugins?: unknown }).plugins)
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
      'ui-settings-plugins', 'ui-settings-plugin-inventory', 'ui-settings-session-log',
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
    // section. The open-configuration-file action it also registers is
    // withheld by `server-sidebar`'s `settings-entries.ts` instead.
    expect(idsOf(CONSOLE_PATCH)).not.toContain('ui-settings-general')
    expect(byId.get('ui-settings-general')?.disabled).not.toBe(true)
  })

  it('starts Performance & usage at compact in the bundle layer, where a user\'s Settings choice still outranks it', () => {
    expect(rowOf(CONSOLE_PATCH, 'ui-chat')).toEqual({ id: 'ui-chat', config: { performanceUsage: 'compact' } })
    expect(byId.get('ui-chat')).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-chat', config: { performanceUsage: 'compact' } })
    // Above the profile patch, config-editor would refuse the user's write.
    expect(idsOf(LOCK_PATCH)).not.toContain('ui-chat')
  })

  it('turns live client plugin replacement off by id, while the shipped Web bundle still composes it', () => {
    // An open page that took the new bundles of an upgrade into its loaded
    // shell fails to draw; the page reloads instead (the next case).
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    expect(rowOf(CONSOLE_PATCH, 'client-hmr')).toEqual({ id: 'client-hmr', disabled: true })
    expect(shipped.get('client-hmr')).toMatchObject({ name: '@deepseek-ai/dsh-client-hmr' })
    expect(shipped.get('client-hmr')?.disabled).not.toBe(true)
    expect(byId.get('client-hmr')?.disabled).toBe(true)
  })

  it('turns the Web surface context off and restates the rest of the shipped `web-runtime` config', () => {
    // A patch replaces the whole config: a field the Web bundle adds later and
    // this row does not restate would fall to its schema default here.
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    const shippedConfig = shipped.get('web-runtime')?.config as Record<string, unknown> | undefined
    expect(shipped.get('web-runtime')).toMatchObject({ name: '@deepseek-ai/dsh-web-app', config: { surfaceContext: true } })
    expect(rowOf(CONSOLE_PATCH, 'web-runtime')).toEqual({ id: 'web-runtime', config: { ...shippedConfig, surfaceContext: false } })
    // The row keeps the shipped `inject`, which the restated expressions read.
    expect(byId.get('web-runtime')).toMatchObject({ name: '@deepseek-ai/dsh-web-app', inject: ['webStartup'] })
    expect(byId.get('web-runtime')?.disabled).not.toBe(true)
  })

  it('removes the deliverables surface and its prompt section by id, while the shipped Web bundle still composes it', () => {
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    expect(rowOf(CONSOLE_PATCH, 'ui-deliverables')).toEqual({ id: 'ui-deliverables', disabled: true })
    expect(shipped.get('ui-deliverables')).toMatchObject({ name: '@deepseek-ai/dsh-client-ui-deliverables' })
    expect(shipped.get('ui-deliverables')?.disabled).not.toBe(true)
    expect(byId.get('ui-deliverables')?.disabled).toBe(true)
  })

  it('mounts the page\'s build check by package name in the bundle layer, stating its config', () => {
    expect(byId.get('page-refresh')).toMatchObject({
      name: '@deepseek-ai/dsh-experimental-page-refresh',
      config: { checkOnVisible: true, reloadDelayMs: 0, disconnectNotice: true, stuckAfterSeconds: 60 },
    })
    expect(byId.get('page-refresh')?.disabled).not.toBe(true)
    // No field is volatile, so nothing a settings write could reach needs the lock.
    expect(idsOf(LOCK_PATCH)).not.toContain('page-refresh')
  })

  it('mounts automatic compaction on the host plane at 60%, as the inherited value a settings write may outrank', () => {
    // This layer inserts the row; no shipped layer composes the plugin.
    expect(entriesOf(CONSOLE_PATCH).flatMap(entry => entry.insert ?? []).map(row => row.id)).toContain('auto-compact')
    expect(composeEntries(web, () => {}).some(entry => entry.id === 'auto-compact')).toBe(false)
    expect(byId.get('auto-compact')).toMatchObject({
      name: '@haoran/dsh-auto-compact',
      config: { enabled: true, thresholdPercent: 60 },
    })
    expect(byId.get('auto-compact')?.disabled).not.toBe(true)
    // Both fields are volatile: above the profile patch, config-editor would
    // refuse every write to them.
    expect(idsOf(LOCK_PATCH)).not.toContain('auto-compact')
    // The engine it compacts with lives in each preset's `compaction` group,
    // which both the `console` preset and its `standard` twin carry.
    for (const id of ['preset-console', 'preset-standard-as-console']) {
      const plugins = (byId.get(id)?.config as { plugins?: Row[] } | undefined)?.plugins ?? []
      expect(plugins.find(row => row.id === 'compaction')).toMatchObject({
        name: 'cordis:group',
        isolate: { compaction: true },
      })
    }
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

describe('the lock overlay\'s Session-log row', () => {
  const sessionLog = rowOf(LOCK_PATCH, 'session-log-deepseek')

  it('patches the shipped row by id and by package name', () => {
    expect(sessionLog).toMatchObject({ id: 'session-log-deepseek', name: '@deepseek-ai/dsh-session-log-deepseek' })
  })

  it('holds the upload off with `enabled: false` in the config it restates', () => {
    // The row replaces the base bundle's config: without `enabled: false` here
    // the plugin's own default, which is on, would apply.
    expect(sessionLog?.config).toEqual({ enabled: false })
  })
})

describe.each(TEST_DEPLOYMENTS)('%s', (file) => {
  it('restates no row the console package owns', () => {
    const owned = new Set([...idsOf(CONSOLE_PATCH), ...idsOf(LOCK_PATCH)])
    expect(idsOf(file).filter(id => owned.has(id))).toEqual([])
  })
})
