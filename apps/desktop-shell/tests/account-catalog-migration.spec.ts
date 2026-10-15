/**
 * The one-time removal of the `models` field a Models page save left on the
 * DeepSeek account row: which values go, what the record keeps, the order it
 * keeps with the settings migration, files it cannot parse, and the profile
 * an rc.38 machine carries composing without that field.
 * @module
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import {
  ACCOUNT_CATALOG_MIGRATION_MARKER, migrateAccountCatalog, readAccountCatalogMigrationMarker,
} from '../src/account-catalog-migration.ts'
import { MODEL_CATALOG_MIGRATION_MARKER, migrateModelCatalog } from '../src/model-catalog-migration.ts'
import { DESKTOP_PROFILE, MIGRATION_MARKER_FILENAME } from '../src/profile-seed.ts'
import { migrateLegacySettings, SETTINGS_MIGRATION_MARKER } from '../src/settings-migration.ts'

let home: string
let profileDir: string

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-account-catalog-migration-'))
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

/** The account catalog rc.38's adapter shipped, as a save from the Models page writes it. */
const RC38_ACCOUNT_MODELS = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek-V41-Flash',
    contextWindow: 1_000_000,
    inputModalities: ['text', 'image'],
    systemPromptUpdate: 'in-history',
    toolUpdate: 'addition-only',
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek-V4-Pro',
    description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    contextWindow: 1_000_000,
  },
]

/** That catalog's `models` block under the row's `config`, as the yaml writer lays it out. */
const RC38_MODELS_BLOCK = `    models:
      - id: deepseek-flash
        name: DeepSeek-V41-Flash
        contextWindow: 1000000
        inputModalities:
          - text
          - image
        systemPromptUpdate: in-history
        toolUpdate: addition-only
      - id: deepseek-v4-pro
        name: DeepSeek-V4-Pro
        description: Stronger agentic coding, knowledge, and difficult reasoning; suited
          to complex or quality-critical tasks at higher cost.
        contextWindow: 1000000
`

/**
 * Rows an rc.38 profile layer holds beside the account row, none of which
 * this run reads: a default model, the `llm-deepseek` row with a table of its
 * own, and a `!!js` expression.
 */
const OTHER_ROWS = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
- id: llm-deepseek
  name: "@deepseek-ai/dsh-llm-deepseek-api-key"
  config:
    retryPolicy:
      mode: normal
    models:
      - id: deepseek-flash
        name: Mine
- id: plugin-manager
  config:
    pnpmCommand: !!js process.env.DSH_DESKTOP_PNPM ?? 'pnpm'
`

/** The account row head a save writes. */
const ACCOUNT_ROW_HEAD = `- id: llm-deepseek-account
  name: "@deepseek-ai/dsh-llm-deepseek-account"
  config:
`

/** Keys a save from the account editor writes beside `models`. */
const ACCOUNT_OTHER_KEYS = `    reasoningEffort: max
    maxTokens: 65536
`

/** The profile's patch layer path. */
const patchPath = (): string => join(profileDir, 'cordis.patch.yml')
/** The Harness home's `settings.yaml`. */
const settingsPath = (): string => join(home, 'settings.yaml')
/** This module's marker. */
const markerPath = (): string => join(profileDir, ACCOUNT_CATALOG_MIGRATION_MARKER)

/** The log line one removal from the profile layer writes. */
const PROFILE_REMOVED = 'removed models from cordis.patch.yml\'s llm-deepseek-account row; recorded in account-catalog-migration.json'
/** The log line one removal from `settings.yaml` writes. */
const SETTINGS_REMOVED = 'removed models from settings.yaml\'s llm-deepseek-account section; recorded in account-catalog-migration.json'
/** The log line a launch that waits for the settings migration writes. */
const SETTINGS_WAITING = 'left settings.yaml for a launch whose settings-migration.json reads done'

/**
 * Record the settings migration in the given state.
 * @param state - what `settings-migration.json` reads.
 */
function settingsMigration(state: 'pending' | 'done'): void {
  writeFileSync(join(profileDir, SETTINGS_MIGRATION_MARKER), `${JSON.stringify({ state, rows: [], dropped: [], skipped: [] })}\n`)
}

/** The profile layer as it stands, parsed; `!!js` scalars read as their source. */
function profileRows(): { id?: string; config?: Record<string, unknown> }[] {
  return parse(readFileSync(patchPath(), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as { id?: string; config?: Record<string, unknown> }[]
}

/** The `settings.yaml` sections as they stand, parsed. */
function settingsSections(): Record<string, unknown> {
  return parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>
}

describe('a profile account row holding models', () => {
  // Only the `models` block goes: every other row, the `!!js` expression, and
  // the other `models` field on `llm-deepseek` are the bytes they were.
  it('loses models when that was all its config held, and every other byte of the file stays', () => {
    settingsMigration('done')
    writeFileSync(patchPath(), `${PATCH_HEADER}${OTHER_ROWS}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)
    const report = migrateAccountCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(`${PATCH_HEADER}${OTHER_ROWS}${ACCOUNT_ROW_HEAD.replace('config:\n', 'config: {}\n')}`)
    expect(readAccountCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done', removed: [{ file: 'cordis.patch.yml', models: RC38_ACCOUNT_MODELS }], skipped: [],
    })
    expect(report.lines).toEqual([PROFILE_REMOVED])
  })

  it('loses models and keeps every other key of the row', () => {
    settingsMigration('done')
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}${RC38_MODELS_BLOCK}`)
    migrateAccountCatalog(home, profileDir)
    expect(readFileSync(patchPath(), 'utf8')).toBe(`${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}`)
    expect(profileRows()).toEqual([{
      id: 'llm-deepseek-account',
      name: '@deepseek-ai/dsh-llm-deepseek-account',
      config: { reasoningEffort: 'max', maxTokens: 65_536 },
    }])
  })

  // The upstream refusal tests for the field's presence, so no value is kept.
  it.each([
    ['an empty list', []],
    ['null', null],
    ['an edited table', [{ id: 'deepseek-flash', name: 'Mine', contextWindow: 131_072 }]],
  ])('loses %s and records it as it was', (_label, models) => {
    settingsMigration('done')
    writeFileSync(patchPath(), PATCH_HEADER + stringify([{ id: 'llm-deepseek-account', config: { reasoningEffort: 'high', models } }]))
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED])
    expect(profileRows()).toEqual([{ id: 'llm-deepseek-account', config: { reasoningEffort: 'high' } }])
    expect(readAccountCatalogMigrationMarker(markerPath())?.removed).toEqual([{ file: 'cordis.patch.yml', models }])
  })

  it('clears every id-targeted account row of the layer', () => {
    settingsMigration('done')
    writeFileSync(patchPath(), PATCH_HEADER + stringify([
      { id: 'llm-deepseek-account', config: { models: [] } },
      { id: 'llm-deepseek-account', config: { models: RC38_ACCOUNT_MODELS, maxTokens: 8192 } },
    ]))
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED, PROFILE_REMOVED])
    expect(profileRows()).toEqual([{ id: 'llm-deepseek-account', config: {} }, { id: 'llm-deepseek-account', config: { maxTokens: 8192 } }])
    expect(readAccountCatalogMigrationMarker(markerPath())?.removed).toEqual([
      { file: 'cordis.patch.yml', models: [] },
      { file: 'cordis.patch.yml', models: RC38_ACCOUNT_MODELS },
    ])
  })

  it('writes the file with the private mode the settings migration uses', () => {
    settingsMigration('done')
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)
    migrateAccountCatalog(home, profileDir)
    if (process.platform !== 'win32') expect(statSync(patchPath()).mode & 0o777).toBe(0o600)
  })
})

describe('a profile with nothing to remove', () => {
  it.each([
    ['no account row', `${PATCH_HEADER}${OTHER_ROWS}`],
    ['an account row without models', `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}`],
    ['the seeded empty layer', `${PATCH_HEADER}[]\n`],
    ['an insert list that names the account row', `${PATCH_HEADER}- insert:\n    - id: llm-deepseek-account\n      name: x\n      config:\n${RC38_MODELS_BLOCK.replaceAll(/^/gm, '    ')}`],
  ])('leaves %s unwritten and finishes', (_label, text) => {
    settingsMigration('done')
    writeFileSync(patchPath(), text)
    const before = statSync(patchPath()).mtimeMs
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([])
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(statSync(patchPath()).mtimeMs).toBe(before)
    expect(readAccountCatalogMigrationMarker(markerPath())).toEqual({ state: 'done', removed: [], skipped: [] })
  })
})

describe('a file it cannot parse', () => {
  it.each([
    ['a YAML error', `${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}    models: [\n`],
    ['a mapping', 'llm-deepseek-account:\n  models: []\n'],
  ])('leaves a profile layer holding %s alone, says so once, and clears it on the first launch that parses it', (_label, text) => {
    settingsMigration('done')
    writeFileSync(patchPath(), text)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual(['skipped cordis.patch.yml: not a YAML sequence this shell can edit'])
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(readAccountCatalogMigrationMarker(markerPath())).toMatchObject({ state: 'pending', removed: [] })

    const marker = readFileSync(markerPath(), 'utf8')
    const markerTime = statSync(markerPath()).mtimeMs
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([])
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker)
    expect(statSync(markerPath()).mtimeMs).toBe(markerTime)

    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}${RC38_MODELS_BLOCK}`)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED])
    expect(readFileSync(patchPath(), 'utf8')).toBe(`${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}`)
    expect(readAccountCatalogMigrationMarker(markerPath())?.state).toBe('done')
  })

  it('leaves a settings.yaml it cannot parse alone and says so once', () => {
    settingsMigration('done')
    const text = 'llm-deepseek-account:\n  models: [\n'
    writeFileSync(settingsPath(), text)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual(['skipped settings.yaml: not a YAML mapping of sections'])
    expect(readFileSync(settingsPath(), 'utf8')).toBe(text)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([])
    expect(readAccountCatalogMigrationMarker(markerPath())).toMatchObject({
      state: 'pending', skipped: ['settings.yaml: not a YAML mapping of sections'],
    })
  })
})

/** A `settings.yaml` an earlier client left with the account section. */
const SETTINGS_WITH_ACCOUNT = `agent-default-model:
  provider: deepseek-account
  model: deepseek-flash
llm-deepseek-account:
  reasoningEffort: high
  models:
    - id: deepseek-flash
      name: DeepSeek-V41-Flash
auto-compact:
  enabled: true
`

describe('settings.yaml', () => {
  it('loses models from the account section before the server imports it, once the settings migration has finished', () => {
    settingsMigration('done')
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([SETTINGS_REMOVED])
    expect(readFileSync(settingsPath(), 'utf8')).toBe(`agent-default-model:
  provider: deepseek-account
  model: deepseek-flash
llm-deepseek-account:
  reasoningEffort: high
auto-compact:
  enabled: true
`)
    expect(readAccountCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done', removed: [{ file: 'settings.yaml', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }] }], skipped: [],
    })
  })

  it('takes the section out when models was all it held', () => {
    settingsMigration('done')
    writeFileSync(settingsPath(), stringify({ 'llm-deepseek-account': { models: [] }, 'auto-compact': { enabled: true } }))
    migrateAccountCatalog(home, profileDir)
    expect(settingsSections()).toEqual({ 'auto-compact': { enabled: true } })
  })

  it.each([
    ['reads pending', () => { settingsMigration('pending') }],
    ['is absent', () => {}],
  ])('waits while settings-migration.json %s, clearing the profile meanwhile, and clears the file once it reads done', (_label, arrange) => {
    arrange()
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)

    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED, SETTINGS_WAITING])
    expect(readFileSync(settingsPath(), 'utf8')).toBe(SETTINGS_WITH_ACCOUNT)
    expect(profileRows()).toEqual([{ id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account', config: {} }])
    expect(readAccountCatalogMigrationMarker(markerPath())).toMatchObject({ state: 'pending', settingsDeferred: true })

    // The server of that launch imported the section, `models` included, into the profile row.
    writeFileSync(patchPath(), PATCH_HEADER + stringify([{ id: 'llm-deepseek-account', config: { reasoningEffort: 'high', models: [] } }]))
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED, SETTINGS_WAITING])
    expect(profileRows()).toEqual([{ id: 'llm-deepseek-account', config: { reasoningEffort: 'high' } }])

    settingsMigration('done')
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([SETTINGS_REMOVED])
    expect(settingsSections()['llm-deepseek-account']).toEqual({ reasoningEffort: 'high' })
    expect(readAccountCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done',
      removed: [
        { file: 'cordis.patch.yml', models: RC38_ACCOUNT_MODELS },
        { file: 'cordis.patch.yml', models: [] },
        { file: 'settings.yaml', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }] },
      ],
      skipped: [],
    })
  })

  it('says nothing more and writes nothing while it keeps waiting', () => {
    settingsMigration('pending')
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    migrateAccountCatalog(home, profileDir)
    const marker = readFileSync(markerPath(), 'utf8')
    const before = statSync(markerPath()).mtimeMs
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([SETTINGS_WAITING])
    expect(readFileSync(markerPath(), 'utf8')).toBe(marker)
    expect(statSync(markerPath()).mtimeMs).toBe(before)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(SETTINGS_WITH_ACCOUNT)
  })
})

describe('a later launch', () => {
  it('changes nothing on a second run', () => {
    settingsMigration('done')
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    writeFileSync(patchPath(), `${PATCH_HEADER}${OTHER_ROWS}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}${RC38_MODELS_BLOCK}`)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED, SETTINGS_REMOVED])
    const files = [patchPath(), settingsPath(), markerPath()]
    const contents = files.map(file => readFileSync(file, 'utf8'))
    const times = files.map(file => statSync(file).mtimeMs)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([])
    expect(files.map(file => readFileSync(file, 'utf8'))).toEqual(contents)
    expect(files.map(file => statSync(file).mtimeMs)).toEqual(times)
  })

  it('leaves models that appear after the marker reads done', () => {
    settingsMigration('done')
    writeFileSync(markerPath(), `${JSON.stringify({ state: 'done', removed: [], skipped: [] })}\n`)
    const text = `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`
    writeFileSync(patchPath(), text)
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    const markerTime = statSync(markerPath()).mtimeMs
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([])
    expect(readFileSync(patchPath(), 'utf8')).toBe(text)
    expect(readFileSync(settingsPath(), 'utf8')).toBe(SETTINGS_WITH_ACCOUNT)
    expect(statSync(markerPath()).mtimeMs).toBe(markerTime)
  })

  // rc.37 and rc.38 machines carry a finished model catalog record.
  it('runs on a machine whose model catalog migration already finished', () => {
    settingsMigration('done')
    writeFileSync(join(profileDir, MODEL_CATALOG_MIGRATION_MARKER), `${JSON.stringify({ state: 'done', removed: [], kept: [], skipped: [] })}\n`)
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED])
    expect(profileRows()[0]?.config).toEqual({})
  })

  it('runs again over a marker it cannot read', () => {
    settingsMigration('done')
    writeFileSync(markerPath(), '{ not json')
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([
      'account-catalog-migration.json cannot be read; running the migration again',
      PROFILE_REMOVED,
    ])
    expect(readAccountCatalogMigrationMarker(markerPath())?.state).toBe('done')
  })
})

describe('a run that fails', () => {
  it('returns one line, records nothing, and finishes on the next launch', () => {
    settingsMigration('done')
    writeFileSync(patchPath(), `${PATCH_HEADER}${ACCOUNT_ROW_HEAD}${RC38_MODELS_BLOCK}`)
    // A directory where the file belongs cannot be read as one.
    mkdirSync(settingsPath())
    const report = migrateAccountCatalog(home, profileDir)
    expect(report.lines).toHaveLength(2)
    expect(report.lines[0]).toBe(PROFILE_REMOVED)
    expect(report.lines[1]).toMatch(/^stopped and will run again next launch: /)
    expect(existsSync(markerPath())).toBe(false)

    rmSync(settingsPath(), { recursive: true })
    writeFileSync(settingsPath(), SETTINGS_WITH_ACCOUNT)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([SETTINGS_REMOVED])
    expect(readAccountCatalogMigrationMarker(markerPath())).toEqual({
      state: 'done',
      removed: [{ file: 'settings.yaml', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' }] }],
      skipped: [],
    })
  })
})

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url))

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

/**
 * The refusal `resolveAccountOptions` makes from dsh-v0.2.1-alpha.4 on
 * (`packages/llm/llm-deepseek-account/src/config.ts`), whose `Config` passes
 * an unknown `models` key through to it unchanged.
 * TODO: call the plugin's own `resolveAccountOptions` once this tree carries dsh-v0.2.1-alpha.4.
 * @param options - the account row's composed `config`.
 * @throws the error that plugin load fails with when `models` is present.
 */
function refuseRetiredModels(options: Record<string, unknown>): void {
  if (Object.hasOwn(options, 'models')) {
    throw new Error('llm-deepseek-account: models is no longer configurable; the account /models listing supplies the catalog. '
      + 'Remove models from this entry and adjust single models with modelOverrides.<model id>')
  }
}

describe('an rc.38 desktop profile', () => {
  // Read the way the Loader reads them: the shipped layers below the profile's own patch layer.
  const lowerLayers = [
    shippedPatches(join(repoRoot, 'packages', 'bundle', 'base')),
    shippedPatches(join(repoRoot, 'packages', 'bundle', 'web-app')),
    shippedPatches(join(repoRoot, 'apps', 'desktop-app')),
  ]

  /** The account row's `config` the composed profile hands the plugin. */
  function composedAccountConfig(): Record<string, unknown> {
    const rows = composeEntries([...lowerLayers, loadOverlayPatches('dsh', patchPath())]) as { id?: string; config?: Record<string, unknown> }[]
    const row = rows.find(candidate => candidate.id === 'llm-deepseek-account')
    if (row === undefined) throw new Error('composed no llm-deepseek-account row')
    return row.config ?? {}
  }

  it('composes an account row the upstream account plugin loads, after the launch-time migrations run in order', () => {
    // What a machine that ran rc.37 or rc.38 holds: both earlier records finished, and a Models page save of the account row.
    writeFileSync(join(profileDir, MIGRATION_MARKER_FILENAME), '{"from":"web","migrated":[],"defective":[],"removed":[],"permissionPatch":"retired"}\n')
    settingsMigration('done')
    writeFileSync(join(profileDir, MODEL_CATALOG_MIGRATION_MARKER), `${JSON.stringify({ state: 'done', removed: [], kept: [], skipped: [] })}\n`)
    writeFileSync(patchPath(), `${PATCH_HEADER}${OTHER_ROWS}${ACCOUNT_ROW_HEAD}${ACCOUNT_OTHER_KEYS}${RC38_MODELS_BLOCK}`)
    expect(() => { refuseRetiredModels(composedAccountConfig()) }).toThrow(/models is no longer configurable/)

    migrateLegacySettings(home, profileDir)
    migrateModelCatalog(home, profileDir)
    expect(migrateAccountCatalog(home, profileDir).lines).toEqual([PROFILE_REMOVED])

    const config = composedAccountConfig()
    expect(() => { refuseRetiredModels(config) }).not.toThrow()
    expect(config).toEqual({ reasoningEffort: 'max', maxTokens: 65_536 })
  })
})
