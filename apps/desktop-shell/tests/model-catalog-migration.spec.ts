/**
 * The one-time removal of the DeepSeek model tables earlier desktop builds
 * froze into a machine's own settings: which tables go, which stay, the
 * order it keeps with the settings migration, and how a run that was cut
 * short finishes.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  migrateModelCatalog, MODEL_CATALOG_MIGRATION_MARKER, readModelCatalogMigrationMarker, SHIPPED_MODEL_TABLES,
  type ShippedModelTable,
} from '../src/model-catalog-migration.ts'
import { DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME } from '../src/profile-seed.ts'
import { migrateLegacySettings, SETTINGS_MIGRATION_MARKER } from '../src/settings-migration.ts'

let home: string
let profileDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-model-catalog-migration-'))
  // Every case reads and writes this home; it must never be the user's own.
  expect(home.startsWith(realpathSync(tmpdir())) || home.startsWith(tmpdir())).toBe(true)
  profileDir = join(home, 'profiles', DESKTOP_PROFILE)
  mkdirSync(profileDir, { recursive: true })
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

/** The comment header the shell seeds into an empty profile patch layer. */
const PATCH_HEADER = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
`

/** The `models` block of the rc.34 to rc.36.1 table, as a save from the Models page writes it under `config`. */
const RC34_MODELS_BLOCK = `    models:
      - id: deepseek-flash
        name: DeepSeek-V4.1-Flash
        description: V4.1 Flash · 文本与图片
        contextWindow: 1000000
        inputModalities:
          - text
          - image
        systemPromptUpdate: in-history
        toolUpdate: addition-only
`

/**
 * A profile layer after a save from the Models page froze the rc.34 table,
 * beside rows holding values upstream keeps as stored: a pi-ai default model
 * with a reasoning effort, pi-ai routes naming models the installed catalog
 * dropped, an allow-list naming a retired official model, a review model on
 * a dropped pi-ai model, a vision target on a retired official model, and a
 * `!!js` expression.
 */
const KEPT_ROWS_BEFORE = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek
    model: deepseek-v4-flash
    reasoningEffort: high
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      moonshotai:
        apiKeyEnv: MOONSHOT_API_KEY
        modelOverrides:
          kimi-k2.5:
            contextWindow: 131072
      zai-coding-cn:
        apiKeyEnv: ZAI_API_KEY
        models:
          - id: glm-5.1
- id: subagent-model-selection-settings
  config:
    enabled: true
    allowedModels:
      - provider: deepseek-official
        model: deepseek-v4-flash
- id: llm-permission-gateway
  config:
    provider: deepseek-official
    model: deepseek-flash
    judgeProvider: moonshotai
    judgeModel: kimi-k2-thinking
- id: vision-switch
  config:
    enabled: true
    target:
      provider: deepseek-official
      model: deepseek-v4-flash-vision-exp
- id: plugin-manager
  config:
    pnpmCommand: !!js process.env.DSH_DESKTOP_PNPM ?? 'pnpm'
`

/** The `llm-deepseek` row a save froze the rc.34 table into, with the keys the save carried beside it. */
const FROZEN_ROW_HEAD = `- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    retryPolicy:
      mode: normal
      backoff:
        maxDelayMs: 300000
    baseURL: https://deepseek.example/anthropic
    apiKeyEnv: TEAM_DEEPSEEK_KEY
`

/** The full profile layer of the case above, and what it must become. */
const PROFILE_BEFORE = `${PATCH_HEADER}${KEPT_ROWS_BEFORE}${FROZEN_ROW_HEAD}${RC34_MODELS_BLOCK}`
const PROFILE_AFTER = `${PATCH_HEADER}${KEPT_ROWS_BEFORE}${FROZEN_ROW_HEAD}`

/** The profile's patch layer path. */
const patchPath = (): string => join(profileDir, 'cordis.patch.yml')
/** The Harness home's `settings.yaml`. */
const settingsPath = (): string => join(home, 'settings.yaml')
/** This module's marker. */
const markerPath = (): string => join(profileDir, MODEL_CATALOG_MIGRATION_MARKER)

/** Record the settings migration as finished, which is what lets the run clear `settings.yaml`. */
function settingsMigrationDone(): void {
  writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), `${JSON.stringify({ state: 'done', rows: [], dropped: [], skipped: [] })}\n`)
}

/**
 * A profile layer holding one `llm-deepseek` row with the given `models`
 * value beside `retryPolicy` and `baseURL`, written as yaml writes it.
 * @param models - the value the row's `config.models` holds.
 * @returns the file text.
 */
function profileWithModels(models: unknown): string {
  return PATCH_HEADER + stringify([{
    id: 'llm-deepseek',
    name: '@deepseek-ai/dsh-llm-deepseek-api-key',
    config: { retryPolicy: { mode: 'normal', backoff: { maxDelayMs: 300_000 } }, baseURL: 'https://deepseek.example/anthropic', models },
  }])
}

/** The profile layer as it stands, parsed; `!!js` scalars read as their source. */
function profileRows(): { id?: string; config?: Record<string, unknown> }[] {
  return parse(readFileSync(patchPath(), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as { id?: string; config?: Record<string, unknown> }[]
}

/** The `settings.yaml` sections as they stand, parsed. */
function settingsSections(): Record<string, unknown> {
  return parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
}

const TABLE_NAMES = Object.keys(SHIPPED_MODEL_TABLES) as ShippedModelTable[]

describe('a profile row holding a table a release shipped', () => {
  it.each(TABLE_NAMES)('loses %s and keeps every other key of the row', (table) => {
    settingsMigrationDone()
    writeFileSync(patchPath(), profileWithModels(SHIPPED_MODEL_TABLES[table]))
    const report = migrateModelCatalog(home, profileDir)
    expect(profileRows()).toEqual([{
      id: 'llm-deepseek',
      name: '@deepseek-ai/dsh-llm-deepseek-api-key',
      config: { retryPolicy: { mode: 'normal', backoff: { maxDelayMs: 300_000 } }, baseURL: 'https://deepseek.example/anthropic' },
    }])
    expect(readModelCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done', removed: [{ file: 'cordis.patch.yml', table }], kept: [], skipped: [],
    })
    expect(report.lines).toEqual([`removed the ${table} models table from cordis.patch.yml's llm-deepseek row`])
  })

  it('loses a table whose keys a writer put in another order', () => {
    settingsMigrationDone()
    const [row] = SHIPPED_MODEL_TABLES['rc34-rc36']
    const reordered = Object.fromEntries(Object.entries(row ?? {}).reverse())
    writeFileSync(patchPath(), profileWithModels([reordered]))
    migrateModelCatalog(home, profileDir)
    expect(profileRows()[0]?.config).not.toHaveProperty('models')
  })

  // Only the `models` block goes: every other row, the `!!js` expression, and
  // every other key of the row are the bytes they were.
  it('leaves every stored model value upstream keeps, and every other byte of the file', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    migrateModelCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(PROFILE_AFTER)
  })

  it('writes the file with the private mode the settings migration uses', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    migrateModelCatalog(home, profileDir)
    if (process.platform !== 'win32') expect(statSync(patchPath()).mode & 0o777).toBe(0o600)
  })
})

describe('a profile row holding a table the user changed', () => {
  const [flash] = SHIPPED_MODEL_TABLES['rc34-rc36']
  const changed: [string, unknown][] = [
    ['a renamed row', [{ ...flash, name: 'My Flash' }]],
    ['one more row', [...SHIPPED_MODEL_TABLES['rc34-rc36'], { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }]],
    ['one field fewer', [Object.fromEntries(Object.entries(flash ?? {}).filter(([key]) => key !== 'toolUpdate'))]],
    ['the rows reordered', [...SHIPPED_MODEL_TABLES['rc20-rc30']].reverse()],
  ]

  it.each(changed)('keeps %s exactly as it is, and records it', (_label, models) => {
    settingsMigrationDone()
    const text = profileWithModels(models)
    writeFileSync(patchPath(), text)
    const report = migrateModelCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(readModelCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done', removed: [], kept: [{ file: 'cordis.patch.yml', models }], skipped: [],
    })
    expect(report.lines).toEqual(['kept the edited models table in cordis.patch.yml\'s llm-deepseek row; recorded in model-catalog-migration.json'])
  })
})

describe('a profile with nothing to remove', () => {
  it.each([
    ['no llm-deepseek row', `${PATCH_HEADER}${KEPT_ROWS_BEFORE}`],
    ['a row without models', `${PATCH_HEADER}${FROZEN_ROW_HEAD}`],
    ['the seeded empty layer', `${PATCH_HEADER}[]\n`],
    ['an insert list that names llm-deepseek', `${PATCH_HEADER}- insert:\n    - id: llm-deepseek\n      name: x\n      config:\n${RC34_MODELS_BLOCK.replaceAll(/^/gm, '    ')}`],
  ])('leaves %s unwritten and finishes', (_label, text) => {
    settingsMigrationDone()
    writeFileSync(patchPath(), text)
    const before = statSync(patchPath()).mtimeMs
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([])
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(statSync(patchPath()).mtimeMs).toBe(before)
    expect(readModelCatalogMigrationMarker(markerPath())?.state).toBe('done')
  })

  it('records a layer it cannot edit and leaves it alone', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), 'llm-deepseek: {}\n')
    const report = migrateModelCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe('llm-deepseek: {}\n')
    expect(report.lines).toEqual(['skipped cordis.patch.yml: not a YAML sequence this shell can edit'])
  })
})

/** The `settings.yaml` an rc.32 or rc.33 client wrote after the Models page's model list was touched. */
const RC33_SETTINGS = `agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
llm-deepseek:
  baseURL: https://deepseek.example/anthropic
  models:
    - id: deepseek-flash
      name: DeepSeek-V4.1-Flash
      description: V4.1 Flash · 文本与图片
      contextWindow: 1000000
      inputModalities:
        - text
        - image
      imagePixelBudget: 640000
      imageMaxBytes: 1048576
      systemPromptUpdate: in-history
auto-compact:
  enabled: true
`

describe('settings.yaml', () => {
  it('loses a shipped table before the server imports it, once the settings migration has finished', () => {
    settingsMigrationDone()
    writeFileSync(settingsPath(), RC33_SETTINGS)
    migrateModelCatalog(home, profileDir)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(`agent-default-model:
  provider: deepseek-official
  model: deepseek-v4-flash
llm-deepseek:
  baseURL: https://deepseek.example/anthropic
auto-compact:
  enabled: true
`)
    expect(readModelCatalogMigrationMarker(markerPath())?.removed).toEqual([{ file: 'settings.yaml', table: 'rc32-rc33' }])
  })

  it('takes the section out when the table was all it held', () => {
    settingsMigrationDone()
    writeFileSync(settingsPath(), stringify({ 'llm-deepseek': { models: SHIPPED_MODEL_TABLES['rc20-rc30'] }, 'auto-compact': { enabled: true } }))
    migrateModelCatalog(home, profileDir)
    expect(settingsSections()).toEqual({ 'auto-compact': { enabled: true } })
  })

  it('keeps a table the user changed', () => {
    settingsMigrationDone()
    const text = stringify({ 'llm-deepseek': { models: [{ id: 'deepseek-flash', name: 'Mine' }] } })
    writeFileSync(settingsPath(), text)
    migrateModelCatalog(home, profileDir)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(text)
    expect(readModelCatalogMigrationMarker(markerPath())?.kept).toEqual([{ file: 'settings.yaml', models: [{ id: 'deepseek-flash', name: 'Mine' }] }])
  })

  // The settings migration stopped after it moved the original aside: its
  // next launch writes the migrated copy back from `settings.yaml.pre-rc34`,
  // and the server of that launch imports it.
  it('waits while the settings migration is pending, and clears the copy it writes back', () => {
    writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), '{"from":"web","migrated":[],"defective":[],"removed":[],"permissionPatch":"absent"}\n')
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), `${JSON.stringify({ state: 'pending', rows: [], dropped: [], skipped: [] })}\n`)
    writeFileSync(`${settingsPath()}.pre-rc34`, RC33_SETTINGS)
    writeFileSync(patchPath(), PROFILE_BEFORE)

    const first = migrateModelCatalog(home, profileDir)
    expect(first.lines).toEqual([
      'removed the rc34-rc36 models table from cordis.patch.yml\'s llm-deepseek row',
      'left settings.yaml for a launch whose settings-migration.json reads done',
    ])
    expect(readModelCatalogMigrationMarker(markerPath())).toMatchObject({ state: 'pending', settingsDeferred: true })
    expect(existsSync(settingsPath())).toBe(false)

    // The next launch: the settings migration finishes first.
    migrateLegacySettings(home, profileDir)
    expect(settingsSections()['llm-deepseek']).toHaveProperty('models')
    const second = migrateModelCatalog(home, profileDir)
    expect(settingsSections()['llm-deepseek']).toEqual({ baseURL: 'https://deepseek.example/anthropic' })
    expect(readModelCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done',
      removed: [{ file: 'cordis.patch.yml', table: 'rc34-rc36' }, { file: 'settings.yaml', table: 'rc32-rc33' }],
      kept: [],
      skipped: [],
    })
    // The profile, cleared on the first launch, had nothing left to remove.
    expect(second.lines).toEqual(['removed the rc32-rc33 models table from settings.yaml\'s llm-deepseek row'])
    expect(profileRows().find(row => row.id === 'llm-deepseek')?.config).not.toHaveProperty('models')
  })

  it('clears an rc.33 file on the first launch that migrates it', () => {
    writeFileSync(settingsPath(), RC33_SETTINGS)
    migrateLegacySettings(home, profileDir)
    migrateModelCatalog(home, profileDir)
    expect(settingsSections()['llm-deepseek']).toEqual({ baseURL: 'https://deepseek.example/anthropic' })
  })

  // The settings migration stopped at its first step, so the server of that
  // launch imported settings.yaml as rc.33 left it, table included, into the
  // profile; the settings migration finishes on the next launch.
  it('clears a table the server imported into the profile while the settings migration was unfinished', () => {
    writeFileSync(settingsPath(), RC33_SETTINGS)
    writeFileSync(patchPath(), `${PATCH_HEADER}[]\n`)
    // A non-empty directory where the original moves to makes that move fail.
    mkdirSync(join(home, 'settings.yaml.pre-rc34', 'occupied'), { recursive: true })

    expect(migrateLegacySettings(home, profileDir).lines[0]).toMatch(/^settings migration stopped and will run again next launch: /)
    expect(existsSync(settingsPath())).toBe(true)
    expect(migrateModelCatalog(home, profileDir).lines).toEqual(['left settings.yaml for a launch whose settings-migration.json reads done'])
    // That launch's server: the import renames the file and writes the section into the profile row.
    renameSync(settingsPath(), `${settingsPath()}.imported`)
    writeFileSync(patchPath(), profileWithModels(SHIPPED_MODEL_TABLES['rc32-rc33']))
    rmSync(join(home, 'settings.yaml.pre-rc34'), { recursive: true })

    migrateLegacySettings(home, profileDir)
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([
      'removed the rc32-rc33 models table from cordis.patch.yml\'s llm-deepseek row',
      'removed the rc32-rc33 models table from settings.yaml\'s llm-deepseek row',
    ])
    expect(profileRows()).toEqual([{
      id: 'llm-deepseek',
      name: '@deepseek-ai/dsh-llm-deepseek-api-key',
      config: { retryPolicy: { mode: 'normal', backoff: { maxDelayMs: 300_000 } }, baseURL: 'https://deepseek.example/anthropic' },
    }])
    expect(settingsSections()['llm-deepseek']).toEqual({ baseURL: 'https://deepseek.example/anthropic' })
    expect(readModelCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done',
      removed: [{ file: 'cordis.patch.yml', table: 'rc32-rc33' }, { file: 'settings.yaml', table: 'rc32-rc33' }],
      kept: [],
      skipped: [],
    })
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([])
  })

  it('says nothing more while it keeps waiting', () => {
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), `${JSON.stringify({ state: 'pending', rows: [], dropped: [], skipped: [] })}\n`)
    migrateModelCatalog(home, profileDir)
    const before = statSync(markerPath()).mtimeMs
    expect(migrateModelCatalog(home, profileDir).lines).toEqual(['left settings.yaml for a launch whose settings-migration.json reads done'])
    expect(statSync(markerPath()).mtimeMs).toBe(before)
  })

  it.each([
    ['an edited table', profileWithModels([{ id: 'deepseek-flash', name: 'Mine' }]), 'kept the edited models table in cordis.patch.yml\'s llm-deepseek row; recorded in model-catalog-migration.json'],
    ['a layer it cannot edit', 'llm-deepseek: {}\n', 'skipped cordis.patch.yml: not a YAML sequence this shell can edit'],
  ])('records %s once while it keeps waiting', (_label, text, line) => {
    writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), `${JSON.stringify({ state: 'pending', rows: [], dropped: [], skipped: [] })}\n`)
    writeFileSync(patchPath(), text)
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([line, 'left settings.yaml for a launch whose settings-migration.json reads done'])
    const marker = readFileSync(markerPath(), 'utf8')
    const before = statSync(markerPath()).mtimeMs
    expect(migrateModelCatalog(home, profileDir).lines).toEqual(['left settings.yaml for a launch whose settings-migration.json reads done'])
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker)
    expect(statSync(markerPath()).mtimeMs).toBe(before)
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)

    settingsMigrationDone()
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([])
    const done = readModelCatalogMigrationMarker(markerPath())
    expect(done?.state).toBe('done')
    expect((done?.kept.length ?? 0) + (done?.skipped.length ?? 0)).toBe(1)
  })
})

describe('a later launch', () => {
  it('writes nothing once the marker reads done', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    migrateModelCatalog(home, profileDir)
    const marker = readFileSync(markerPath(), 'utf8')
    const markerTime = statSync(markerPath()).mtimeMs
    expect(migrateModelCatalog(home, profileDir).lines).toEqual([])
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker)
    expect(statSync(markerPath()).mtimeMs).toBe(markerTime)
  })

  // A table the user builds again after the run is the user's.
  it('leaves a shipped table that appears after the run finished', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    migrateModelCatalog(home, profileDir)
    writeFileSync(patchPath(), PROFILE_BEFORE)
    migrateModelCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(PROFILE_BEFORE)
  })

  it('runs again over a marker it cannot read', () => {
    settingsMigrationDone()
    writeFileSync(markerPath(), '{ not json')
    writeFileSync(patchPath(), PROFILE_BEFORE)
    const report = migrateModelCatalog(home, profileDir)
    expect(report.lines[0]).toBe('model-catalog-migration.json cannot be read; running the migration again')
    expect(readFileSync(patchPath(), 'utf8')).toBe(PROFILE_AFTER)
    expect(readModelCatalogMigrationMarker(markerPath())?.state).toBe('done')
  })
})

describe('a run that fails', () => {
  it('returns one line, records nothing, and finishes on the next launch', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    // A directory where the file belongs cannot be read as one.
    mkdirSync(settingsPath())
    const report = migrateModelCatalog(home, profileDir)
    expect(report.lines).toHaveLength(2)
    expect(report.lines[0]).toBe('removed the rc34-rc36 models table from cordis.patch.yml\'s llm-deepseek row')
    expect(report.lines[1]).toMatch(/^stopped and will run again next launch: /)
    expect(existsSync(markerPath())).toBe(false)

    rmSync(settingsPath(), { recursive: true })
    writeFileSync(settingsPath(), RC33_SETTINGS)
    migrateModelCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(PROFILE_AFTER)
    expect(settingsSections()['llm-deepseek']).toEqual({ baseURL: 'https://deepseek.example/anthropic' })
    expect(readModelCatalogMigrationMarker(markerPath())?.state).toBe('done')
  })

  it('leaves the marker unfinished when the marker itself cannot be written', () => {
    settingsMigrationDone()
    writeFileSync(patchPath(), PROFILE_BEFORE)
    mkdirSync(markerPath())
    const report = migrateModelCatalog(home, profileDir)
    expect(report.lines).toHaveLength(3)
    expect(report.lines[0]).toBe('model-catalog-migration.json cannot be read; running the migration again')
    // The removal already made stays made, and the log still says so.
    expect(report.lines[1]).toBe('removed the rc34-rc36 models table from cordis.patch.yml\'s llm-deepseek row')
    expect(report.lines[2]).toMatch(/^stopped and will run again next launch: /)
    expect(readModelCatalogMigrationMarker(markerPath())).toBeUndefined()
    expect(readFileSync(patchPath(), 'utf8')).toBe(PROFILE_AFTER)
  })
})
