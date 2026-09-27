/**
 * The one-time `settings.yaml` migration that runs before the server's own
 * import: what each legacy section becomes, what is recorded and dropped, the
 * profile rows it writes, and how a run that was cut short finishes.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { AUTO_REVIEW_GUARD_TEXT, DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME } from '../src/profile-seed.ts'
import {
  acknowledgeSettingsMigrationNotices, DEFAULT_EXCLUDED_DIRECTORIES, GATEWAY_ALWAYS_ASK, migrateLegacySettings,
  readSettingsMigrationMarker, SETTINGS_MIGRATION_MARKER,
  type SettingsMigrationMarker,
} from '../src/settings-migration.ts'
import { storedLanguagePreference, storedThemePreference } from '../src/theme-preference.ts'

let home: string
let profileDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-settings-migration-'))
  // Every case reads and writes this home; it must never be the user's own.
  expect(home.startsWith(realpathSync(tmpdir())) || home.startsWith(tmpdir())).toBe(true)
  profileDir = join(home, 'profiles', DESKTOP_PROFILE)
  mkdirSync(profileDir, { recursive: true })
  writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH_TEMPLATE)
  // The seeding that runs before every migration has recorded its
  // permission-row retirement, which the gateway step waits for.
  writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), SETTLED_SEED_MARKER)
})

/** The seeding's `web-migration.json` once its permission-row retirement has run. */
const SETTLED_SEED_MARKER = '{\n  "from": "web",\n  "migrated": [],\n  "defective": [],\n  "removed": [],\n  "permissionPatch": "absent"\n}\n'

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** The empty profile patch layer the shell seeds. */
const PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/**
 * A settings file as rc.33's settings-file writes one: yaml's own
 * `Document#toString`, so the price table's `asOf` date is unquoted.
 */
const RC33_SETTINGS = `llm-permission-gateway:
  mode: auto
  walledReview: true
  judgeProvider: deepseek-official
  judgeModel: deepseek-v4-pro
  judgeReasoningEffort: high
auto-compact:
  enabled: false
  thresholdPercent: 75
mcp-servers:
  servers:
    - id: fixture
      command: node
      args:
        - fixture.mjs
balance:
  lowBalance: 5
  criticalBalance: 2
  maskBalance: true
  prices:
    asOf: 2026-09-10
    tables:
      CNY:
        entries:
          - model: deepseek-flash
            per: 1000000
            base:
              input: 1.5
              output: 8
agent-presets:
  default: code
ui-theme:
  preference: dark
  fontSize: 15
permission:
  defaultPreset: workspace-write
`

/** Write `settings.yaml` under the home. */
function writeSettings(text: string): void {
  writeFileSync(join(home, 'settings.yaml'), text)
}

/** The settings file as it stands, parsed. */
function settingsNow(): Record<string, unknown> {
  return parse(readFileSync(join(home, 'settings.yaml'), 'utf8')) as Record<string, unknown>
}

/** The profile patch layer as it stands, parsed; `!!js` scalars read as their source. */
function patchRows(): Record<string, unknown>[] {
  const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
  return (parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) ?? []) as Record<string, unknown>[]
}

/** The one row with `id` the patch layer declares. */
function rowOf(id: string): Record<string, unknown> | undefined {
  return patchRows().find(row => row['id'] === id)
}

/** The marker as it stands. */
function markerNow(): SettingsMigrationMarker {
  const marker = readSettingsMigrationMarker(join(profileDir, SETTINGS_MIGRATION_MARKER))
  if (marker === undefined) throw new Error('no settings migration marker')
  return marker
}

/** The permission bits of a file. */
function modeOf(path: string): number {
  return statSync(path).mode & 0o777
}

describe('migrateLegacySettings on a complete rc.33 settings file', () => {
  it('keeps an untouched private copy, and writes the file and its marker privately', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    const backup = join(home, 'settings.yaml.pre-rc34')
    expect(readFileSync(backup, 'utf8')).toBe(RC33_SETTINGS)
    expect(markerNow().state).toBe('done')
    if (process.platform === 'win32') return
    expect(modeOf(backup)).toBe(0o600)
    expect(modeOf(join(home, 'settings.yaml'))).toBe(0o600)
    expect(modeOf(join(profileDir, SETTINGS_MIGRATION_MARKER))).toBe(0o600)
    expect(modeOf(join(profileDir, 'cordis.patch.yml'))).toBe(0o600)
  })

  it('leaves only volatile keys in the four plugin sections, recording the gateway mode it drops', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    const settings = settingsNow()
    expect(settings['llm-permission-gateway']).toEqual({
      walledReview: true, judgeProvider: 'deepseek-official', judgeModel: 'deepseek-v4-pro', judgeReasoningEffort: 'high',
    })
    expect(settings['auto-compact']).toEqual({ enabled: false, thresholdPercent: 75 })
    expect(Object.keys(settings['mcp-servers'] as object)).toEqual(['servers'])
    expect(Object.keys(settings['balance'] as object)).toEqual(['lowBalance', 'criticalBalance', 'maskBalance', 'prices'])
    expect(markerNow().gatewayModeDropped).toBe('auto')
    expect(markerNow().dropped).toContainEqual(expect.objectContaining({ section: 'llm-permission-gateway', key: 'mode', value: 'auto' }))
  })

  it('renames agent-presets for the import, mapping code to ptc', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    const settings = settingsNow()
    expect(settings['agent-presets']).toBeUndefined()
    expect(settings['agent-preset-registry']).toEqual({ selectedDefault: 'ptc' })
  })

  it('moves ui-theme into the profile row the boot window reads, and out of the file', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()['ui-theme']).toBeUndefined()
    expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'dark', fontSize: 15 } })
    expect(storedThemePreference(home)).toBe('dark')
  })

  it('writes back every section it keeps byte for byte, unquoted dates, numbers, booleans, and comments included', () => {
    const kept = `# my own note
permission:
  defaultPreset: workspace-write # the one I use
balance:
  lowBalance: 5.50
  maskBalance: true
  prices:
    asOf: 2026-09-10
    tables: {}
`
    writeSettings(`${kept}ui-theme:\n  preference: light\n`)
    migrateLegacySettings(home, profileDir)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(kept)
    const prices = (settingsNow()['balance'] as { prices: { asOf: unknown } }).prices
    expect(prices.asOf).toBe('2026-09-10')
  })

  it('logs what it wrote and dropped, once', () => {
    writeSettings(RC33_SETTINGS)
    const first = migrateLegacySettings(home, profileDir)
    expect(first.lines).toContainEqual(expect.stringContaining('wrote ui-theme into cordis.patch.yml'))
    expect(first.lines).toContainEqual(expect.stringContaining('dropped llm-permission-gateway.mode'))
    writeSettings(RC33_SETTINGS)
    expect(migrateLegacySettings(home, profileDir)).toEqual({ lines: [], notices: [] })
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(RC33_SETTINGS)
  })
})

describe('migrateLegacySettings on the at-file section', () => {
  it('adds its exact names after the fifteen default directories and records the rest', () => {
    writeSettings(`at-file:
  enabled: true
  ignoreFilesConfigured: true
  ignoreFiles:
    - generated-assets
    - kind: regex
      pattern: \\.log$
      caseSensitive: false
  workspaceIgnoreFiles:
    - workspace: /work
      ignoreFiles: [secret.txt]
  ignorePastedMentions: false
`)
    migrateLegacySettings(home, profileDir)
    expect(DEFAULT_EXCLUDED_DIRECTORIES).toHaveLength(15)
    expect(rowOf('file-reference-local')).toEqual({
      id: 'file-reference-local', config: { excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES, 'generated-assets'] },
    })
    expect(rowOf('ui-reference')).toBeUndefined()
    expect(settingsNow()['at-file']).toBeUndefined()
    const dropped = markerNow().dropped.filter(entry => entry.section === 'at-file')
    expect(dropped).toContainEqual(expect.objectContaining({ key: 'ignoreFiles', value: { kind: 'regex', pattern: '\\.log$', caseSensitive: false } }))
    expect(dropped).toContainEqual(expect.objectContaining({ key: 'workspaceIgnoreFiles' }))
    expect(dropped).toContainEqual(expect.objectContaining({ key: 'ignorePastedMentions', value: false }))
  })

  it('turns the ui-reference row off for enabled: false and writes no directory list', () => {
    writeSettings('at-file:\n  enabled: false\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('ui-reference')).toEqual({ id: 'ui-reference', disabled: true })
    expect(rowOf('file-reference-local')).toBeUndefined()
    expect(settingsNow()).toEqual({})
  })

  it('writes nothing for at-file\'s own default list, in any order and case', () => {
    writeSettings('at-file:\n  ignoreFilesConfigured: true\n  ignoreFiles: [.ds_store, desktop.ini, Thumbs.db]\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('file-reference-local')).toBeUndefined()
    expect(markerNow().dropped).toEqual([])
  })

  it('reads an empty list that was never configured as at-file\'s default', () => {
    writeSettings('at-file:\n  ignoreFiles: []\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('file-reference-local')).toBeUndefined()
  })

  it('reads an empty configured list as the choice to hide nothing, which needs no row', () => {
    writeSettings('at-file:\n  ignoreFilesConfigured: true\n  ignoreFiles: []\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('file-reference-local')).toBeUndefined()
  })

  it('drops a name file-reference-local would refuse, and one it already excludes is not repeated', () => {
    writeSettings(String.raw`at-file:
  ignoreFilesConfigured: true
  ignoreFiles: ['', ' ', a/b, 'c\d', node_modules, { kind: exact, pattern: Build-Out, caseSensitive: true }]
`)
    migrateLegacySettings(home, profileDir)
    expect(rowOf('file-reference-local')).toEqual({
      id: 'file-reference-local', config: { excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES, 'Build-Out'] },
    })
    const refused = markerNow().dropped.filter(entry => entry.reason.includes('single non-empty name')).map(entry => entry.value)
    expect(refused).toEqual(['', ' ', 'a/b', 'c\\d'])
    expect(markerNow().dropped).toContainEqual(expect.objectContaining({ value: { caseSensitive: true, pattern: 'Build-Out' } }))
  })
})

describe('migrateLegacySettings on agent-presets with mode selection (S6)', () => {
  it('writes no selectedDefault when mode selection was off, recording both values', () => {
    writeSettings('agent-presets:\n  default: code\n  modeSelectionEnabled: false\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({})
    expect(markerNow().dropped).toEqual([
      expect.objectContaining({ section: 'agent-presets', key: 'modeSelectionEnabled', value: false }),
      expect.objectContaining({ section: 'agent-presets', key: 'default', value: 'code' }),
    ])
  })

  it('maps code to ptc and drops the switch when mode selection was on', () => {
    writeSettings('agent-presets:\n  default: code\n  modeSelectionEnabled: true\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({ 'agent-preset-registry': { selectedDefault: 'ptc' } })
    expect(markerNow().dropped).toEqual([expect.objectContaining({ key: 'modeSelectionEnabled', value: true })])
  })
})

describe('migrateLegacySettings on plugin sections (S1)', () => {
  it('strips a key the plugin does not declare and keeps the rest of the section', () => {
    writeSettings('balance:\n  refreshMs: 30000\n  lowBalance: 5\n  criticalBalance: 2\n  maskBalance: false\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()['balance']).toEqual({ lowBalance: 5, criticalBalance: 2, maskBalance: false })
    expect(markerNow().dropped).toEqual([expect.objectContaining({ section: 'balance', key: 'refreshMs', value: 30000 })])
  })

  it('strips only the key whose value the plugin would refuse', () => {
    writeSettings('auto-compact:\n  enabled: true\n  thresholdPercent: 100\nbalance:\n  lowBalance: -1\n  maskBalance: true\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({ 'auto-compact': { enabled: true }, balance: { maskBalance: true } })
  })

  it('removes a section left empty', () => {
    writeSettings('llm-permission-gateway:\n  mode: manual\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({})
    expect(markerNow().gatewayModeDropped).toBe('manual')
  })
})

describe('migrateLegacySettings on llm-deepseek.baseURL (S4)', () => {
  it('drops an api.deepseek.com address whatever its path, and the section with it when nothing else is left', () => {
    writeSettings('llm-deepseek:\n  baseURL: https://api.deepseek.com\n')
    const report = migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({})
    expect(markerNow().baseURL).toEqual({ value: 'https://api.deepseek.com', kept: false })
    expect(report.notices).toEqual([])
  })

  it('keeps the rest of the section', () => {
    writeSettings('llm-deepseek:\n  baseURL: https://api.deepseek.com/v1\n  apiKeyEnv: DEEPSEEK_API_KEY\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({ 'llm-deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY' } })
  })

  it('keeps another host and tells the user once', () => {
    writeSettings('llm-deepseek:\n  baseURL: https://proxy.example.com/v1\n')
    const first = migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({ 'llm-deepseek': { baseURL: 'https://proxy.example.com/v1' } })
    expect(markerNow().baseURL).toEqual({ value: 'https://proxy.example.com/v1', kept: true })
    expect(first.notices).toEqual([expect.stringContaining('https://proxy.example.com/v1')])
    expect(markerNow().notices).toEqual(first.notices)
    acknowledgeSettingsMigrationNotices(profileDir)
    expect(markerNow().notices).toBeUndefined()
    expect(migrateLegacySettings(home, profileDir).notices).toEqual([])
  })

  it('shows the notice again on every launch until a window has shown it', () => {
    // A launch the mandatory-update gate stops, or one whose server fails to
    // start, never reaches the window.
    writeSettings('llm-deepseek:\n  baseURL: https://proxy.example.com/v1\n')
    const first = migrateLegacySettings(home, profileDir)
    expect(migrateLegacySettings(home, profileDir)).toEqual({ lines: [], notices: first.notices })
    acknowledgeSettingsMigrationNotices(profileDir)
    expect(migrateLegacySettings(home, profileDir)).toEqual({ lines: [], notices: [] })
    expect(markerNow().baseURL).toEqual({ value: 'https://proxy.example.com/v1', kept: true })
  })
})

/** A patch layer an earlier sync kept because the gateway insert row in it had been edited. */
const EDITED_GATEWAY_PATCH = `# rows carried over from the web profile
- id: typert-loader
  disabled: !!js "!ctx.get('typert')"

# my own judge
- insert:
    - id: llm-permission-gateway
      name: '@haoran/dsh-llm-permission-gateway'
      config:
        provider: my-proxy
        model: my-model
`

describe('migrateLegacySettings on a duplicate gateway insert row (S3)', () => {
  it('rewrites it as an id-targeted row with the same config, keeping every other entry', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EDITED_GATEWAY_PATCH)
    writeSettings('llm-permission-gateway:\n  walledReview: true\n')
    migrateLegacySettings(home, profileDir)
    const text = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(text).toContain('disabled: !!js "!ctx.get(\'typert\')"')
    expect(text).not.toContain('insert:')
    expect(rowOf('llm-permission-gateway')).toEqual({
      id: 'llm-permission-gateway', config: { provider: 'my-proxy', model: 'my-model', alwaysAsk: GATEWAY_ALWAYS_ASK },
    })
    const { gatewayRow, alwaysAskAdded } = markerNow()
    expect(gatewayRow?.before).toContain('insert:')
    expect(gatewayRow?.after).toMatch(/^id: llm-permission-gateway\nconfig:\n {2}provider: my-proxy\n {2}model: my-model\n {2}alwaysAsk:\n/)
    expect(alwaysAskAdded).toBe(1)
  })

  it('keeps an insert list that holds other rows too, taking only the gateway out of it', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- insert:
    - id: mine
      name: my-plugin
    - id: llm-permission-gateway
      config: { provider: p, model: m }
`)
    migrateLegacySettings(home, profileDir)
    expect(patchRows()).toEqual([
      { insert: [{ id: 'mine', name: 'my-plugin' }] },
      { id: 'llm-permission-gateway', config: { provider: 'p', model: 'm', alwaysAsk: GATEWAY_ALWAYS_ASK } },
    ])
  })

  it('runs without a settings file, and still finishes', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EDITED_GATEWAY_PATCH)
    migrateLegacySettings(home, profileDir)
    expect(rowOf('llm-permission-gateway')).toEqual({
      id: 'llm-permission-gateway', config: { provider: 'my-proxy', model: 'my-model', alwaysAsk: GATEWAY_ALWAYS_ASK },
    })
    expect(markerNow().state).toBe('done')
    expect(existsSync(join(home, 'settings.yaml.pre-rc34'))).toBe(false)
  })
})

describe('migrateLegacySettings on the gateway rows\' alwaysAsk', () => {
  it('carries exactly the map the desktop layer sets on the gateway row', () => {
    const layer = parse(readFileSync(join(process.cwd(), 'apps', 'desktop-app', 'cordis.patch.yml'), 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }],
    }) as { id?: string; config?: { alwaysAsk?: unknown } }[]
    const row = layer.find(entry => entry.id === 'llm-permission-gateway')
    expect(row?.config?.alwaysAsk).toStrictEqual(GATEWAY_ALWAYS_ASK)
  })

  it('adds the map to an id-targeted row whose config has none, and to no other', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `- id: llm-permission-gateway
  config:
    provider: p
    model: m
- id: llm-permission-gateway
  config:
    provider: q
    model: n
    alwaysAsk:
      browser_auth: mine
- id: llm-permission-gateway
  disabled: false
`)
    const report = migrateLegacySettings(home, profileDir)
    expect(patchRows()).toEqual([
      { id: 'llm-permission-gateway', config: { provider: 'p', model: 'm', alwaysAsk: GATEWAY_ALWAYS_ASK } },
      { id: 'llm-permission-gateway', config: { provider: 'q', model: 'n', alwaysAsk: { browser_auth: 'mine' } } },
      { id: 'llm-permission-gateway', disabled: false },
    ])
    expect(markerNow().alwaysAskAdded).toBe(1)
    expect(report.lines).toContain('added the desktop alwaysAsk map to 1 llm-permission-gateway row(s) in cordis.patch.yml')
  })

  it('adds nothing on a later launch', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: llm-permission-gateway\n  config:\n    provider: p\n    model: m\n')
    migrateLegacySettings(home, profileDir)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: llm-permission-gateway\n  config:\n    provider: p\n    model: m\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('llm-permission-gateway')).toEqual({ id: 'llm-permission-gateway', config: { provider: 'p', model: 'm' } })
  })
})

describe('migrateLegacySettings with no settings file (F7)', () => {
  it('finishes without a backup and leaves the patch layer as it was', () => {
    migrateLegacySettings(home, profileDir)
    expect(markerNow()).toEqual({ state: 'done', rows: [], dropped: [], skipped: [] })
    expect(existsSync(join(home, 'settings.yaml.pre-rc34'))).toBe(false)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(PATCH_TEMPLATE)
  })
})

describe('migrateLegacySettings after another profile imported the file first (S5)', () => {
  it('copies the imported file back privately and migrates it, leaving web-migration.json alone', () => {
    const webMarker = SETTLED_SEED_MARKER
    writeFileSync(join(home, 'settings.yaml.imported'), RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    expect(markerNow().restoredImported).toBe(true)
    expect(readFileSync(join(home, 'settings.yaml.pre-rc34'), 'utf8')).toBe(RC33_SETTINGS)
    expect(settingsNow()['agent-preset-registry']).toEqual({ selectedDefault: 'ptc' })
    expect(readFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), 'utf8')).toBe(webMarker)
    if (process.platform !== 'win32') expect(modeOf(join(home, 'settings.yaml'))).toBe(0o600)
  })

  it('does not copy it back once this profile has finished its own run', () => {
    writeFileSync(join(home, 'settings.yaml.imported'), RC33_SETTINGS)
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), '{ "state": "done", "rows": [], "dropped": [], "skipped": [] }\n')
    migrateLegacySettings(home, profileDir)
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
  })

  it('does not copy it back over a marker it cannot read, and says so', () => {
    // A damaged marker may stand for a finished run whose import already
    // happened; copying the file back would import it a second time.
    writeFileSync(join(home, 'settings.yaml.imported'), RC33_SETTINGS)
    for (const damaged of ['{ "state": "do', '{ "state": "done" }\n']) {
      writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), damaged)
      const report = migrateLegacySettings(home, profileDir)
      expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
      expect(report.lines).toContainEqual(
        expect.stringMatching(/^settings-migration\.json cannot be read \(.+\); nothing is restored from settings\.yaml\.imported/),
      )
      expect(markerNow().restoredImported).toBeUndefined()
    }
  })
})

describe('migrateLegacySettings after a run that stopped partway', () => {
  it('leaves this launch\'s server no settings.yaml to import when a step after the move fails', () => {
    const raw = 'llm-deepseek:\n  baseURL: https://api.deepseek.com\nui-theme:\n  preference: dark\n'
    writeSettings(raw)
    // A patch layer that cannot be read makes the step after the move throw EISDIR.
    rmSync(join(profileDir, 'cordis.patch.yml'))
    mkdirSync(join(profileDir, 'cordis.patch.yml'))
    const failed = migrateLegacySettings(home, profileDir)
    expect(failed.lines).toEqual([expect.stringMatching(/^settings migration stopped and will run again next launch: .*EISDIR/)])
    expect(failed.notices).toEqual([])
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
    expect(readFileSync(join(home, 'settings.yaml.pre-rc34'), 'utf8')).toBe(raw)

    rmSync(join(profileDir, 'cordis.patch.yml'), { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH_TEMPLATE)
    const report = migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({})
    expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'dark' } })
    expect(markerNow()).toMatchObject({ state: 'done', baseURL: { value: 'https://api.deepseek.com', kept: false } })
    expect(report.lines).toContain('the last run stopped before it finished; writing the migrated copy from settings.yaml.pre-rc34')
  })

  it('writes the migrated copy from the moved original when the run stopped after moving it', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    const migrated = readFileSync(join(home, 'settings.yaml'), 'utf8')
    rmSync(join(home, 'settings.yaml'))

    // The state a run leaves when it stops after the move and its `pending` marker.
    writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH_TEMPLATE)
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), '{ "state": "pending", "rows": [], "dropped": [], "skipped": [] }\n')
    const report = migrateLegacySettings(home, profileDir)

    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(migrated)
    expect(markerNow().state).toBe('done')
    expect(markerNow().restoredImported).toBeUndefined()
    expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'dark', fontSize: 15 } })
    expect(report.lines).toContain('the last run stopped before it finished; writing the migrated copy from settings.yaml.pre-rc34')
  })

  it('writes the migrated copy from the moved original under a marker it cannot read, when no finished run could have left that state', () => {
    // A finished run leaves the migrated settings.yaml, or the server's
    // settings.yaml.imported once it has imported it; with neither, the run
    // that moved the original stopped before it wrote the copy.
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    const migrated = readFileSync(join(home, 'settings.yaml'), 'utf8')
    for (const damaged of ['{ "state": "pe', '{ "state": "pending" }\n']) {
      rmSync(join(home, 'settings.yaml'))
      writeFileSync(join(profileDir, 'cordis.patch.yml'), PATCH_TEMPLATE)
      writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), damaged)
      const report = migrateLegacySettings(home, profileDir)
      expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(migrated)
      expect(readFileSync(join(home, 'settings.yaml.pre-rc34'), 'utf8')).toBe(RC33_SETTINGS)
      expect(markerNow().state).toBe('done')
      expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'dark', fontSize: 15 } })
      expect(report.lines).toContain(
        'settings.yaml.pre-rc34 is here without settings.yaml or settings.yaml.imported, so the last run stopped before it finished; writing the migrated copy from settings.yaml.pre-rc34',
      )
    }
  })

  it('leaves the moved original alone under a marker it cannot read once the server has imported the migrated copy', () => {
    writeSettings(RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    writeFileSync(join(home, 'settings.yaml.imported'), readFileSync(join(home, 'settings.yaml')))
    rmSync(join(home, 'settings.yaml'))
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), '{ "state": "do')
    const report = migrateLegacySettings(home, profileDir)
    expect(existsSync(join(home, 'settings.yaml'))).toBe(false)
    expect(markerNow()).toEqual({ state: 'done', rows: [], dropped: [], skipped: [] })
    expect(report.lines.some(line => line.includes('writing the migrated copy'))).toBe(false)
  })

  it('migrates the imported file when a pending run left no original', () => {
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), '{ "state": "pending", "rows": [], "dropped": [], "skipped": [] }\n')
    writeFileSync(join(home, 'settings.yaml.imported'), RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    expect(readFileSync(join(home, 'settings.yaml.pre-rc34'), 'utf8')).toBe(RC33_SETTINGS)
    expect(settingsNow()['agent-preset-registry']).toEqual({ selectedDefault: 'ptc' })
    expect(markerNow()).toMatchObject({ state: 'done', restoredImported: true })
  })
})

describe('migrateLegacySettings before the seeding has retired the copied permission rows', () => {
  /** The gateway row an older build seeded, which the retirement takes out whole. */
  const SEEDED_GATEWAY_ROW = `- insert:
    - id: llm-permission-gateway
      name: '@haoran/dsh-llm-permission-gateway'
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
`

  it('leaves the gateway rows for a later launch and migrates the settings file now', () => {
    writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), '{ "from": "web", "migrated": [] }\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), SEEDED_GATEWAY_ROW)
    writeSettings('ui-theme:\n  preference: dark\n')
    const report = migrateLegacySettings(home, profileDir)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain(SEEDED_GATEWAY_ROW)
    expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'dark' } })
    expect(markerNow()).toMatchObject({ state: 'done', gatewayDeferred: true })
    expect(markerNow().gatewayRow).toBeUndefined()
    expect(report.lines).toContain('left the llm-permission-gateway rows in cordis.patch.yml for a launch whose seeding has retired the copied permission rows')
    // Still unsettled: nothing changes on the next launch either.
    migrateLegacySettings(home, profileDir)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain(SEEDED_GATEWAY_ROW)
  })

  it('runs the gateway step on the first launch after the retirement is recorded', () => {
    writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), '{ "from": "web", "migrated": [] }\n')
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EDITED_GATEWAY_PATCH)
    migrateLegacySettings(home, profileDir)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(EDITED_GATEWAY_PATCH)

    writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), SETTLED_SEED_MARKER)
    const report = migrateLegacySettings(home, profileDir)
    expect(rowOf('llm-permission-gateway')).toEqual({
      id: 'llm-permission-gateway', config: { provider: 'my-proxy', model: 'my-model', alwaysAsk: GATEWAY_ALWAYS_ASK },
    })
    const marker = markerNow()
    expect(marker.gatewayDeferred).toBeUndefined()
    expect(marker.gatewayRow?.before).toContain('insert:')
    expect(marker.alwaysAskAdded).toBe(1)
    expect(report.lines).toContain('rewrote the duplicate llm-permission-gateway insert row in cordis.patch.yml as an id-targeted row')
    expect(migrateLegacySettings(home, profileDir)).toEqual({ lines: [], notices: [] })
  })

  it('runs the gateway step at once on a profile the web sync never reached', () => {
    // A fresh profile: no web-migration.json, the guard row the seeding writes, and a gateway row its owner added.
    rmSync(join(profileDir, MIGRATION_MARKER_FILENAME))
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `${AUTO_REVIEW_GUARD_TEXT}- id: llm-permission-gateway\n  config:\n    provider: my-proxy\n    model: my-model\n`)
    const report = migrateLegacySettings(home, profileDir)
    expect(report.lines).toContain('added the desktop alwaysAsk map to 1 llm-permission-gateway row(s) in cordis.patch.yml')
    expect(rowOf('llm-permission-gateway')).toEqual({
      id: 'llm-permission-gateway', config: { provider: 'my-proxy', model: 'my-model', alwaysAsk: GATEWAY_ALWAYS_ASK },
    })
    expect(markerNow().gatewayDeferred).toBeUndefined()
    expect(markerNow().alwaysAskAdded).toBe(1)
  })
})

describe('migrateLegacySettings resumed from pending', () => {
  it('recomputes from the untouched copy and records exactly what one uninterrupted run records', async () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), EDITED_GATEWAY_PATCH)
    writeSettings(`${RC33_SETTINGS}at-file:\n  enabled: false\n  ignoreFilesConfigured: true\n  ignoreFiles: [generated-assets]\n`)
    migrateLegacySettings(home, profileDir)
    const uninterrupted = markerNow()
    const settingsAfter = readFileSync(join(home, 'settings.yaml'), 'utf8')
    const patchAfter = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')

    // The state a run leaves when it is killed after writing settings.yaml and
    // before marking itself done: every file rewritten, the marker as it was
    // first written.
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), JSON.stringify({
      state: 'pending', rows: [], dropped: [], skipped: [], gatewayRow: { before: uninterrupted.gatewayRow?.before },
      alwaysAskAdded: uninterrupted.alwaysAskAdded,
    }))
    migrateLegacySettings(home, profileDir)
    expect(markerNow()).toEqual(uninterrupted)
    expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toBe(settingsAfter)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(patchAfter)
    expect(readFileSync(join(home, 'settings.yaml.pre-rc34'), 'utf8')).toContain('mode: auto')
  })
})

describe('migrateLegacySettings next to rows the profile already has', () => {
  it('leaves a ui-theme row of the profile\'s own and drops the older section', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: light\n')
    writeSettings('ui-theme:\n  preference: dark\n')
    migrateLegacySettings(home, profileDir)
    expect(rowOf('ui-theme')).toEqual({ id: 'ui-theme', config: { preference: 'light' } })
    expect(settingsNow()).toEqual({})
    expect(markerNow().skipped).toEqual(['cordis.patch.yml: already has its own ui-theme row; left exactly as it is'])
  })

  it('leaves the sections for the server\'s import when the patch layer is not a sequence it can edit', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), 'not: a sequence\n')
    writeSettings('ui-theme:\n  preference: dark\nat-file:\n  enabled: false\n')
    migrateLegacySettings(home, profileDir)
    expect(settingsNow()).toEqual({ 'ui-theme': { preference: 'dark' }, 'at-file': { enabled: false } })
    expect(markerNow().skipped).toContain('cordis.patch.yml: not a YAML sequence this shell can edit')
  })
})

describe('storedThemePreference', () => {
  it('reads the profile row before settings.yaml', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: light\n')
    writeSettings('ui-theme:\n  preference: dark\n')
    expect(storedThemePreference(home)).toBe('light')
  })

  it('leaves the choice to the system for a row that says system, whatever settings.yaml says', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: system\n')
    writeSettings('ui-theme:\n  preference: dark\n')
    expect(storedThemePreference(home)).toBeUndefined()
  })

  it('reads settings.yaml while the profile has no row, as on the first launch after an upgrade', () => {
    writeSettings('ui-theme:\n  preference: dark\n')
    expect(storedThemePreference(home)).toBe('dark')
  })

  it('has no answer for a home with neither', () => {
    expect(storedThemePreference(home)).toBeUndefined()
  })
})

describe('storedLanguagePreference', () => {
  it('reads the profile locale row before settings.yaml, mapping a regional id to its language', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: ui-theme\n  config:\n    preference: dark\n- id: locale\n  config:\n    preference: en-US\n')
    writeSettings('locale:\n  preference: zh\n')
    expect(storedLanguagePreference(home)).toBe('en')
  })

  it('reads settings.yaml while the profile has no locale row', () => {
    writeSettings('locale:\n  preference: zh-CN\n')
    expect(storedLanguagePreference(home)).toBe('zh')
  })

  it('leaves the choice to the system for no preference or a language the shell has no copy in', () => {
    expect(storedLanguagePreference(home)).toBeUndefined()
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: fr\n')
    expect(storedLanguagePreference(home)).toBeUndefined()
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: locale\n  config: {}\n')
    expect(storedLanguagePreference(home)).toBeUndefined()
  })
})
