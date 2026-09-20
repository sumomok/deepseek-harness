/**
 * The console overlay's `permission` row, pinned as a closed set.
 *
 * The row does three things no other file states: it renames the three access
 * presets into customer vocabulary, it isolates `commands` so the
 * `permission-presets` package never registers `/permission`, and it names the
 * preset every new session is pinned to. Nothing downstream would fail loudly
 * if one of them drifted — a fourth preset, a renamed row, a dropped `isolate`
 * key, or a `defaultPreset` naming a preset the table no longer has all boot a
 * console that simply behaves differently.
 *
 * `apps/web/tests/` carries three standalone copies of the same row, one per
 * console e2e composition. They are copies rather than includes because
 * `extraOverlayPath` takes exactly one path, so this file compares each copy
 * against the shipped row instead of trusting the duplication
 * (`apps/web/tests/library-skills.e2e.ts` is the existing precedent for
 * asserting that a test composition still carries the shipped one's row).
 *
 * The `.client.` suffix names the typecheck aggregate this package belongs to,
 * not the face under test.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

/** Repository root, reached from this package's `tests/` directory. */
const REPO_ROOT = fileURLToPath(new URL('../../../../', import.meta.url))

/** The shipped console overlay — the one a deployment applies with `--patch`. */
const CUSTOMER_OVERLAY = resolve(REPO_ROOT, 'packages/experimental/server-sidebar/overlay/customer.patch.yml')

/** The console e2e compositions, each a standalone copy of the shipped overlay. */
const TEST_OVERLAYS = [
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
/** The preset a new session is pinned to, absent a stored `permission.defaultPreset`. */
const PINNED_PRESET = 'workspace-write'

interface PermissionRow {
  id?: string
  name?: string
  isolate?: Record<string, unknown>
  disabled?: boolean
  config?: {
    defaultPreset?: unknown
    presets?: Record<string, { name?: unknown; sandbox?: unknown; approval?: unknown }>
  }
}

/**
 * Every top-level entry of one overlay.
 * @param file - repository-relative or absolute path to the overlay.
 * @returns the parsed entry list.
 */
function entriesOf(file: string): PermissionRow[] {
  return yaml.load(readFileSync(resolve(REPO_ROOT, file), 'utf8'), { schema: entryListSchema }) as PermissionRow[]
}

/**
 * The one row an overlay patches by id.
 * @param file - repository-relative or absolute path to the overlay.
 * @param id - the entry id to find.
 * @returns the row, or undefined when the overlay carries none.
 */
function rowOf(file: string, id: string): PermissionRow | undefined {
  return entriesOf(file).find(entry => entry.id === id)
}

const shipped = rowOf(CUSTOMER_OVERLAY, 'permission')

describe('the console overlay\'s permission row', () => {
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
    expect(rowOf(CUSTOMER_OVERLAY, 'ui-permission')).toMatchObject({
      name: '@deepseek-ai/dsh-client-ui-permission-presets',
      disabled: true,
    })
  })
})

/** The shipped `web` bundle patch, the surface the console overlay is applied over. */
const WEB_BUNDLE = 'packages/bundle/web-app/cordis.patch.yml'

/**
 * Every row a file states, with one level of `insert:` block flattened — a
 * composition mounts new rows inside those blocks and patches shipped rows at
 * the top level, and both are rows for the purpose of these assertions.
 * @param file - repository-relative or absolute path to the overlay.
 * @returns each stated row.
 */
function flatRowsOf(file: string): PermissionRow[] {
  return entriesOf(file).flatMap((entry) => {
    const inserted = (entry as { insert?: PermissionRow[] }).insert
    return inserted ?? [entry]
  })
}

/**
 * One row by id, reached inside an `insert:` block as well as at the top level.
 * @param file - repository-relative or absolute path to the overlay.
 * @param id - the entry id to find.
 * @returns the row, or undefined when the file states none.
 */
function flatRowOf(file: string, id: string): PermissionRow | undefined {
  return flatRowsOf(file).find(entry => entry.id === id)
}

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

describe('the console overlay\'s settings trim', () => {
  it.each(PLUGIN_SETTINGS_ROWS)('disables %s by id and by package name', (id, name) => {
    expect(rowOf(CUSTOMER_OVERLAY, id)).toEqual({ id, name, disabled: true })
  })

  it.each(PLUGIN_SETTINGS_ROWS)('leaves the shipped web bundle composing %s', (id, name) => {
    // The disable belongs to the console, not to the product: the plain `web`
    // profile still draws the Plugins section. A row retired upstream would
    // leave the console disabling something that no longer exists.
    expect(flatRowOf(WEB_BUNDLE, id)).toMatchObject({ name })
    expect(flatRowOf(WEB_BUNDLE, id)).not.toHaveProperty('disabled')
  })

  it('leaves the settings shell composed, since it draws everything else on the page', () => {
    // `ui-settings-general` owns the panel, the navigation, and the General
    // section. The open-configuration-file action it also registers is hidden
    // by `terminology-guard.ts` instead, because a list slot admits no
    // withdrawal by another plugin.
    expect(rowOf(CUSTOMER_OVERLAY, 'ui-settings-general')).toBeUndefined()
  })
})

describe('the console overlay\'s MCP row', () => {
  const mcp = flatRowOf(CUSTOMER_OVERLAY, 'console-mcp')

  it('mounts the capability by package name', () => {
    expect(mcp).toMatchObject({ id: 'console-mcp', name: '@deepseek-ai/dsh-experimental-console-mcp' })
  })

  it('states an empty server list rather than leaving it to a schema default', () => {
    // The empty list is the console's delivered state, and stating it is what
    // makes a deployment's own list an edit to a value it can already see.
    expect(mcp?.config).toEqual({ servers: [] })
  })

  it('is mounted, not disabled', () => {
    expect(mcp).not.toHaveProperty('disabled')
  })
})

describe.each(TEST_OVERLAYS)('%s', (file) => {
  it('carries the shipped permission row verbatim', () => {
    expect(rowOf(file, 'permission')).toEqual(shipped)
  })

  it('carries the shipped ui-permission disable row', () => {
    expect(rowOf(file, 'ui-permission')).toEqual(rowOf(CUSTOMER_OVERLAY, 'ui-permission'))
  })

  it.each(PLUGIN_SETTINGS_ROWS)('carries the shipped %s disable row', (id) => {
    expect(rowOf(file, id)).toEqual(rowOf(CUSTOMER_OVERLAY, id))
  })

  it('carries the shipped MCP row verbatim', () => {
    expect(flatRowOf(file, 'console-mcp')).toEqual(flatRowOf(CUSTOMER_OVERLAY, 'console-mcp'))
  })
})
