/**
 * The customer-console package: its manifest, how its bundle layer composes
 * over the shipped Web bundles, the `permission` row of its lock overlay
 * pinned as a closed set, and the lock's other rows.
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
import { isVolatile } from '@deepseek-ai/cosmokit'
import type z from '@deepseek-ai/schemastery'
import { bundlePatchPaths, composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { DshBundleManifest } from '@deepseek-ai/dsh-package-manifest'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SandboxBashExecutor from '@deepseek-ai/dsh-bash-sandbox'
import { Config as LocaleConfig } from '@deepseek-ai/dsh-client-locale'
import { Config as UiChatConfig } from '@deepseek-ai/dsh-client-ui-chat'
import { Config as UiConversationConfig } from '@deepseek-ai/dsh-client-ui-conversation'
import { Config as UiSettingsConfig } from '@deepseek-ai/dsh-client-ui-settings'
import { Config as UiThemeConfig } from '@deepseek-ai/dsh-client-ui-theme'
import { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import SubagentModelSelectionConfig from '@deepseek-ai/dsh-tool-subagent/model-selection-settings'
import { Config as AutoCompactConfig } from '@haoran/dsh-auto-compact'

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
  'apps/web/tests/server-sidebar-org.overlay.yml',
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
/**
 * The two rows that compose Schedule in the shipped Web bundle: the Host task
 * store with its `schedule.*` Remote methods, and the Automation tasks page
 * over it. A console's visitors share one Host, so one visitor's reminder
 * would run in a deployment every other visitor shares.
 */
const SCHEDULE_ROWS = [
  ['schedule', '@deepseek-ai/dsh-schedule'],
  ['ui-schedule', '@deepseek-ai/dsh-client-ui-schedule'],
] as const
/** The preset-owned rows of the reminder stack: the four `schedule_*` tools and the clock reading. */
const SCHEDULE_PRESET_PACKAGES = ['@deepseek-ai/dsh-tool-schedule', '@deepseek-ai/dsh-time-context'] as const
/**
 * The rows that administer the Host's plugins: the Host service that installs
 * and switches bundles, the Loader inventory, the sidebar Plugins page with its
 * registry probe, and the four configuration pages that register only into
 * that page. Every visitor the console admits is the Host's operator, so each
 * Remote method these rows serve answers every visitor.
 */
const PLUGIN_ADMINISTRATION_ROWS = [
  ['plugin-manager', '@deepseek-ai/dsh-plugin-manager'],
  ['plugin-inventory', '@deepseek-ai/dsh-host-plugin-inventory'],
  ['ui-plugin-manager', '@deepseek-ai/dsh-client-ui-plugin-manager'],
  ['ui-settings-shell', '@deepseek-ai/dsh-client-ui-settings-shell'],
  ['ui-settings-agent-loop', '@deepseek-ai/dsh-client-ui-settings-agent-loop'],
  ['ui-settings-subagent', '@deepseek-ai/dsh-client-ui-settings-subagent'],
  ['ui-settings-web-search', '@deepseek-ai/dsh-client-ui-settings-web-search'],
] as const
/** The dynamic Cordis package runner, both halves, and the inspect providers that register into it. */
const DYNAMIC_CORDIS_ROWS = [
  ['cordis-host-runner', '@deepseek-ai/dsh-cordis-host-runner'],
  ['cordis-inspect-providers', '@deepseek-ai/dsh-tool-cordis/host'],
  ['cordis-client-runner', '@deepseek-ai/dsh-cordis-client-runner'],
] as const
/** The interactive terminal, both halves: the Host controller that spawns a shell and the right sidebar's tab. */
const TERMINAL_ROWS = [
  ['terminal-controller', '@deepseek-ai/dsh-api-terminal-controller'],
  ['ui-sidebar-terminal', '@deepseek-ai/dsh-client-ui-sidebar-terminal'],
] as const
/** The right sidebar's Files tab, a file tree labelled with the working directory's path on the Host. */
const FILES_TAB_ROWS = [
  ['ui-sidebar-files', '@deepseek-ai/dsh-client-ui-sidebar-files'],
] as const
/**
 * The right sidebar itself, its document tab, and the Remote the document tab
 * reads files through, which the console keeps beside the Files tab's removal.
 */
const KEPT_RIGHT_SIDEBAR_ROWS = [
  ['ui-sidebar-right', '@deepseek-ai/dsh-client-ui-sidebar-right'],
  ['ui-sidebar-documentpreview', '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'],
  ['workspace-files', '@deepseek-ai/dsh-api-workspace-files'],
] as const
/** The only model-discovery registrant, whose volatile `providers` field adds routes with their own endpoint and credential reference. */
const PROVIDER_DISCOVERY_ROWS = [
  ['llm-pi-ai', '@deepseek-ai/dsh-llm-pi-ai'],
] as const
/** The web search and fetch services, which no console preset's tool calls. */
const WEB_ROWS = [
  ['web', '@deepseek-ai/dsh-web'],
  ['web-search-deepseek', '@deepseek-ai/dsh-web-search-deepseek'],
  ['web-fetch-http', '@deepseek-ai/dsh-web-fetch-http'],
] as const
/** The rows that browse, create, open, or render paths on the Host outside any session's tools. */
const HOST_PATH_ROWS = [
  ['directory-picker', '@deepseek-ai/dsh-host-directory-picker-auto'],
  ['open-in-app', '@deepseek-ai/dsh-host-open-in-app'],
  ['ui-open-in-app', '@deepseek-ai/dsh-client-ui-open-in-app'],
  ['office-to-pdf', '@deepseek-ai/dsh-office-to-pdf'],
] as const
/** The goal service, its round driver, and the browser half; no console preset arms a goal. */
const GOAL_ROWS = [
  ['goal', '@deepseek-ai/dsh-goal'],
  ['goal-round-driver', '@deepseek-ai/dsh-goal-round-driver'],
  ['ui-goal', '@deepseek-ai/dsh-client-ui-goal'],
] as const
/** The profile-configuration reloader, disabled so an on-disk profile write applies only at the next Host restart. */
const LIVE_CONFIG_ROWS = [
  ['hmr', '@deepseek-ai/dsh-hmr'],
] as const
/** The preset a new session is pinned to, absent a stored `permission.defaultPreset`. */
const PINNED_PRESET = 'workspace-write'

/**
 * The lock's rows that hold every visitor's preferences and the Host's
 * tunables at one value, each with the package it patches and the whole config
 * it composes to. A settings page on the console saves into the one profile
 * patch every visitor shares, so each of these would otherwise be one write
 * away from changing every visitor's page or every session. Each value is what
 * the console ran before the row moved above the profile patch (the layers
 * below, then the schema default; the lock file names each source), except
 * `ui-settings.enabled`, which the console holds off.
 */
const FIXED_ROWS = [
  ['bash-sandbox', '@deepseek-ai/dsh-bash-sandbox', { timeoutMs: 60000 }],
  ['agent-loop', '@deepseek-ai/dsh-agent-loop', { agents: [], maxParallelToolCalls: 10 }],
  ['subagent', '@deepseek-ai/dsh-subagent', { maxDepth: 1, maxActiveSubagents: 8 }],
  ['subagent-model-selection-settings', '@deepseek-ai/dsh-tool-subagent/model-selection-settings', { enabled: false, allowedModels: [] }],
  ['auto-compact', '@haoran/dsh-auto-compact', { enabled: true, thresholdPercent: 60 }],
  ['locale', '@deepseek-ai/dsh-client-locale', {}],
  ['ui-theme', '@deepseek-ai/dsh-client-ui-theme', { preference: 'system', fontSize: 14 }],
  ['ui-chat', '@deepseek-ai/dsh-client-ui-chat', { performanceUsage: 'compact', linkOpening: 'sidebar', busyCompaction: 'turn-end' }],
  ['ui-conversation', '@deepseek-ai/dsh-client-ui-conversation', { busyEnter: 'queue' }],
  ['ui-settings', '@deepseek-ai/dsh-client-ui-settings', { enabled: false }],
] as const

/**
 * Each fixed row's own Config schema, which fills the fields a config leaves
 * out with the plugin's defaults: what the row runs with is the schema's
 * reading of its composed config, not the config as written.
 */
const FIXED_ROW_SCHEMAS: Record<typeof FIXED_ROWS[number][0], z> = {
  'bash-sandbox': SandboxBashExecutor.Config,
  'agent-loop': AgentLoop.Config,
  'subagent': SubagentRuntime.Config,
  'subagent-model-selection-settings': SubagentModelSelectionConfig.Config,
  'auto-compact': AutoCompactConfig,
  'locale': LocaleConfig,
  'ui-theme': UiThemeConfig,
  'ui-chat': UiChatConfig,
  'ui-conversation': UiConversationConfig,
  'ui-settings': UiSettingsConfig,
}

/**
 * A parsed config as plain data: a volatile field's reference becomes the
 * value it holds, so two readings compare by value.
 * @param value - a Config schema's output, or any part of it.
 * @returns the same data without references.
 */
function plain(value: unknown): unknown {
  if (isVolatile(value)) return plain(value.get())
  if (Array.isArray(value)) return value.map(plain)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, plain(child)]))
  return value
}

/**
 * The config two fixed rows carried in this package's bundle layer before the
 * lock took them over (`cordis.patch.yml` no longer states them): what the
 * console ran is the layers below with these fields over them.
 */
const MOVED_FROM_BUNDLE: Partial<Record<typeof FIXED_ROWS[number][0], Record<string, unknown>>> = {
  'auto-compact': { enabled: true, thresholdPercent: 60 },
  'ui-chat': { performanceUsage: 'compact' },
}

/** The one fixed row whose locked value differs from what the console ran before the lock. */
const CHANGED_ROW = 'ui-settings'

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
 * Every package a preset's plugin list loads, groups' members included.
 * @param rows - one preset's `config.plugins`, or a group's `config`.
 * @returns the package names, depth first.
 */
function pluginPackages(rows: readonly Row[]): string[] {
  return rows.flatMap(row => [
    ...row.name === undefined || row.name === 'cordis:group' ? [] : [row.name],
    ...Array.isArray(row.config) ? pluginPackages(row.config as Row[]) : [],
  ])
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
    expect(idsOf(LOCK_PATCH)).toEqual([
      'permission', 'agent-preset-registry', 'session-log-deepseek', 'llm-deepseek', 'llm-deepseek-account', 'agent-default-model',
      ...FIXED_ROWS.map(([id]) => id),
    ])
  })

  it('configures no row the lock configures, and inserts one only with no config', () => {
    // In the bundle layer a row's config sits below the profile patch, where a
    // settings write to any of its volatile fields outranks it.
    const bundle = entriesOf(CONSOLE_PATCH)
    for (const id of idsOf(LOCK_PATCH)) {
      expect(bundle.filter(entry => entry.id === id)).toEqual([])
      for (const row of bundle.flatMap(entry => entry.insert ?? []).filter(row => row.id === id)) {
        expect(row).not.toHaveProperty('config')
      }
    }
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

  it('turns live client plugin replacement off by id, while the shipped Web bundle still composes it', () => {
    // An open page that took the new bundles of an upgrade into its loaded
    // shell fails to draw; the page reloads instead (the next case).
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    expect(rowOf(CONSOLE_PATCH, 'client-hmr')).toEqual({ id: 'client-hmr', disabled: true })
    expect(shipped.get('client-hmr')).toMatchObject({ name: '@deepseek-ai/dsh-client-hmr' })
    expect(shipped.get('client-hmr')?.disabled).not.toBe(true)
    expect(byId.get('client-hmr')?.disabled).toBe(true)
  })

  it('turns Schedule off by id, both halves, while the shipped Web bundle still composes them', () => {
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    for (const [id, name] of SCHEDULE_ROWS) {
      expect(rowOf(CONSOLE_PATCH, id)).toEqual({ id, disabled: true })
      expect(shipped.get(id)).toMatchObject({ name })
      expect(shipped.get(id)?.disabled).not.toBe(true)
      expect(byId.get(id)?.disabled).toBe(true)
    }
  })

  /**
   * Each row is a bare disable row here, composed and enabled by the shipped
   * layers, and disabled in the result: a row retired upstream surfaces as a
   * warning in the first case rather than as dead configuration here.
   * @param rows - the rows' ids and the package each shipped row names.
   */
  function expectDisabledHereComposedThere(rows: readonly (readonly [string, string])[]): void {
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    for (const [id, name] of rows) {
      expect(rowOf(CONSOLE_PATCH, id)).toEqual({ id, disabled: true })
      expect(shipped.get(id)).toMatchObject({ name })
      expect(shipped.get(id)?.disabled).not.toBe(true)
      expect(byId.get(id)?.disabled).toBe(true)
    }
  }

  it('turns plugin management off by id — the Host service, its inventory, and every page over them — while the shipped bundles still compose them', () => {
    // The base row's `disabled` is an expression that is false under
    // `dsh --profile`, which is how the console starts.
    expectDisabledHereComposedThere(PLUGIN_ADMINISTRATION_ROWS)
  })

  it('turns the dynamic Cordis runner off by id, both halves and the inspect providers that wait for it, while the shipped Web bundle still composes them', () => {
    expectDisabledHereComposedThere(DYNAMIC_CORDIS_ROWS)
  })

  it('turns interactive terminals off by id, both halves, while the shipped Web bundle still composes them', () => {
    expectDisabledHereComposedThere(TERMINAL_ROWS)
  })

  it('turns the right sidebar\'s Files tab off by id, and keeps the column, its document tab, and the file reads that tab makes', () => {
    expectDisabledHereComposedThere(FILES_TAB_ROWS)
    for (const [id, name] of KEPT_RIGHT_SIDEBAR_ROWS) {
      expect(rowOf(CONSOLE_PATCH, id)).toBeUndefined()
      expect(byId.get(id)).toMatchObject({ name })
      expect(byId.get(id)?.disabled).not.toBe(true)
    }
  })

  it('turns provider discovery off by id, while the shipped base bundle still composes it', () => {
    expectDisabledHereComposedThere(PROVIDER_DISCOVERY_ROWS)
  })

  it('turns web search and fetch off by id, all three Host rows, while the shipped base bundle still composes them', () => {
    expectDisabledHereComposedThere(WEB_ROWS)
    // No preset that stays composed mounts the web tool these rows serve.
    const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.disabled !== true)
    for (const preset of presets) {
      expect(pluginPackages((preset.config as { plugins?: Row[] } | undefined)?.plugins ?? [])).not.toContain('@deepseek-ai/dsh-tool-web')
    }
  })

  it('turns directory browsing, Open In, and Office rendering off by id, while the shipped Web bundle still composes them', () => {
    expectDisabledHereComposedThere(HOST_PATH_ROWS)
  })

  it('turns goals off by id — the service, its round driver, and the browser half — while the shipped bundles still compose them', () => {
    expectDisabledHereComposedThere(GOAL_ROWS)
    // No preset that stays composed mounts the goal tool that arms the driver.
    const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset' && entry.disabled !== true)
    for (const preset of presets) {
      expect(pluginPackages((preset.config as { plugins?: Row[] } | undefined)?.plugins ?? [])).not.toContain('@deepseek-ai/dsh-tool-goal')
    }
  })

  it('turns live profile-configuration reload off by id, while the shipped base bundle still composes it under a profile', () => {
    // The base row's `disabled` is the expression `!ctx.get('profileContext')`,
    // false under `dsh --profile`; `composeEntries` leaves it unevaluated, so it
    // is `not.toBe(true)` here the same way the plugin-manager row is.
    expectDisabledHereComposedThere(LIVE_CONFIG_ROWS)
  })

  it('leaves the reminder tools and the clock row only in Agent presets it disables', () => {
    // `tool-schedule` registers its four tools only once the `schedule` service
    // the rows above remove resolves, so an enabled preset declaring it would
    // load it and register none of them.
    const presets = entries.filter(entry => entry.name === '@deepseek-ai/dsh-agent-preset')
    const declaring = presets.filter((entry) => {
      const plugins = pluginPackages((entry.config as { plugins?: Row[] } | undefined)?.plugins ?? [])
      return SCHEDULE_PRESET_PACKAGES.some(name => plugins.includes(name))
    })
    expect(declaring.map(entry => entry.id).sort()).toEqual(['preset-cordis', 'preset-ptc', 'preset-standard'])
    expect(declaring.filter(entry => entry.disabled !== true)).toEqual([])
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

  it('omits the fixed harness identity sentence and restates the rest of the shipped `system-prompt` config', () => {
    // A patch replaces the whole config: a field the Web bundle adds later and
    // this row does not restate would fall to its schema default here.
    const shipped = new Map(composeEntries(web, () => {}).map(entry => [entry.id, entry]))
    const shippedConfig = shipped.get('system-prompt')?.config as Record<string, unknown> | undefined
    expect(shipped.get('system-prompt')).toMatchObject({ name: '@deepseek-ai/dsh-system-prompt' })
    expect(shippedConfig?.includeHarnessIdentity).toBeUndefined()
    expect(rowOf(CONSOLE_PATCH, 'system-prompt')).toEqual({ id: 'system-prompt', config: { ...shippedConfig, includeHarnessIdentity: false } })
    expect(byId.get('system-prompt')).toMatchObject({ name: '@deepseek-ai/dsh-system-prompt', config: { includeHarnessIdentity: false } })
    expect(byId.get('system-prompt')?.disabled).not.toBe(true)
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

  it('mounts automatic compaction on the host plane, leaving its config to the lock', () => {
    // This layer inserts the row; no shipped layer composes the plugin.
    expect(entriesOf(CONSOLE_PATCH).flatMap(entry => entry.insert ?? []).map(row => row.id)).toContain('auto-compact')
    expect(composeEntries(web, () => {}).some(entry => entry.id === 'auto-compact')).toBe(false)
    expect(byId.get('auto-compact')).toEqual({ id: 'auto-compact', name: '@haoran/dsh-auto-compact' })
    // The engine it compacts with lives in each preset's `compaction` group,
    // which both the `console` preset and its `standard` twin carry.
    for (const id of ['preset-console', 'preset-standard-as-console']) {
      const plugins = (byId.get(id)?.config as { plugins?: Row[] } | undefined)?.plugins ?? []
      const group = plugins.find(row => row.id === 'compaction')
      expect(group).toMatchObject({
        name: 'cordis:group',
        isolate: { compaction: true },
      })
      // No `command-compact`: the console offers no typed `/compact`, whose
      // card shows counts and the English summary.
      expect((group?.config as Row[] | undefined)?.map(row => row.id)).toEqual(['compaction-basic', 'tool-result-pruner'])
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

describe('the lock overlay\'s model rows', () => {
  const base = new Map(composeEntries([bundlePatches(resolve(REPO_ROOT, 'packages/bundle/base'))], () => {}).map(entry => [entry.id, entry]))

  it('patches `llm-deepseek` by id and by package name with the empty config the base bundle composes it with', () => {
    // A row with no `config` key would leave every field writable; `{}` is
    // the base bundle's configuration stated, which config-editor then holds.
    expect(base.get('llm-deepseek')).toMatchObject({ name: '@deepseek-ai/dsh-llm-deepseek-api-key' })
    expect(base.get('llm-deepseek')?.config ?? {}).toEqual({})
    expect(rowOf(LOCK_PATCH, 'llm-deepseek')).toEqual({ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: {} })
  })

  it('patches `llm-deepseek-account` by id and by package name with the empty config the base bundle composes it with', () => {
    // The account route shares the protocol Config, so its `baseURL` and model
    // catalog are volatile the same way; `{}` restates the base bundle's config.
    expect(base.get('llm-deepseek-account')).toMatchObject({ name: '@deepseek-ai/dsh-llm-deepseek-account' })
    expect(base.get('llm-deepseek-account')?.config ?? {}).toEqual({})
    expect(rowOf(LOCK_PATCH, 'llm-deepseek-account')).toEqual({ id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account', config: {} })
  })

  it('pins `agent-default-model` by id and by package name to the base bundle\'s provider and model', () => {
    const shippedConfig: unknown = base.get('agent-default-model')?.config
    expect(shippedConfig).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(rowOf(LOCK_PATCH, 'agent-default-model')).toEqual({
      id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: shippedConfig,
    })
  })
})

describe('the lock over the console layer', () => {
  const layers = [
    resolve(REPO_ROOT, 'packages/bundle/base'), resolve(REPO_ROOT, 'packages/bundle/web-app'), PACKAGE_ROOT,
  ].map(dir => bundlePatches(dir))
  const below = new Map(composeEntries(layers, () => {}).map(entry => [entry.id, entry]))
  const warnings: string[] = []
  const composed = new Map(
    composeEntries([...layers, loadOverlayPatches('test', LOCK_PATCH)], message => warnings.push(message))
      .map(entry => [entry.id, entry]),
  )

  it('patches only rows the layers below compose, under the package each one names', () => {
    // A `name` that no longer matches is a warning, and the loader skips that
    // row: its fields would stay writable with no other signal.
    expect(warnings).toEqual([])
    for (const id of idsOf(LOCK_PATCH)) {
      expect(below.has(id)).toBe(true)
      expect(rowOf(LOCK_PATCH, id)?.name).toBe(below.get(id)?.name)
    }
  })

  it.each(FIXED_ROWS)('holds `%s` (%s) at one config', (id, name, config) => {
    // Any `config` key in a layer above the profile patch makes config-editor
    // refuse a settings write to the row; the value is what every visitor gets.
    expect(rowOf(LOCK_PATCH, id)).toEqual({ id, name, config })
    expect(composed.get(id)?.config).toEqual(config)
  })

  it.each(FIXED_ROWS.filter(([id]) => id !== CHANGED_ROW))('runs `%s` at the value the layers below ran it with, defaults included', (id) => {
    // Compared with the composition below the lock, not with a copy of the
    // lock file: editing a locked value fails here whatever FIXED_ROWS says.
    // A field the plugin's schema defaults reads the same whether a layer
    // states it or not.
    const read = (config: unknown) => plain(FIXED_ROW_SCHEMAS[id](config))
    const before = { ...(below.get(id)?.config ?? {}) as Record<string, unknown>, ...MOVED_FROM_BUNDLE[id] }
    expect(read(composed.get(id)?.config ?? {})).toEqual(read(before))
  })

  it('turns the code working view off, the one value the lock changes', () => {
    const read = (config: unknown) => plain(FIXED_ROW_SCHEMAS[CHANGED_ROW](config))
    expect(read(below.get(CHANGED_ROW)?.config ?? {})).toEqual({ enabled: true })
    expect(read(composed.get(CHANGED_ROW)?.config ?? {})).toEqual({ enabled: false })
  })

  it.each(FIXED_ROWS)('restates every field the layers below set on `%s`, at the value they set', (id) => {
    // The lock replaces a row's whole config, so a field the layers below set
    // and the lock left out would fall to its schema default.
    const lower = (below.get(id)?.config ?? {}) as Record<string, unknown>
    const fixed = (composed.get(id)?.config ?? {}) as Record<string, unknown>
    for (const [field, value] of Object.entries(lower)) expect({ field, value: fixed[field] }).toEqual({ field, value })
  })
})

describe.each(TEST_DEPLOYMENTS)('%s', (file) => {
  it('restates no row the console package owns', () => {
    const owned = new Set([...idsOf(CONSOLE_PATCH), ...idsOf(LOCK_PATCH)])
    expect(idsOf(file).filter(id => owned.has(id))).toEqual([])
  })
})
