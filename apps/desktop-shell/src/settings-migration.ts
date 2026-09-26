/**
 * Prepare `$DSH_HOME/settings.yaml` and the desktop profile's patch layer for
 * the one-time settings import the server runs, once, before the first server
 * of a build that carries it starts.
 *
 * The server's `SettingsForms` renames `settings.yaml` to
 * `settings.yaml.imported` and writes each top-level section into the profile
 * row whose id is the section name. A section whose row does not exist, or
 * that holds one key the row does not declare volatile, is logged and left in
 * the renamed file, which nothing reads again. Several sections an rc.33
 * client wrote cannot pass that import as they stand, so this module rewrites
 * them first:
 *
 * - `agent-presets` becomes `agent-preset-registry: { selectedDefault }`, with
 *   `code` renamed `ptc`; a client that had turned mode selection off gets no
 *   `selectedDefault` and keeps the deployment default. The section is left to
 *   the import rather than written as a row, because an id-targeted row
 *   replaces the whole `config` and the registry's `default` is required.
 * - `ui-theme` is written into the profile's `ui-theme` row, which the boot
 *   window reads before the server exists (`theme-preference.ts`).
 * - `at-file` belonged to a plugin this build withdrew. `enabled: false` turns
 *   the `ui-reference` row off, and its exact file-name rules join the
 *   `file-reference-local` row's excluded directories; everything else in it
 *   has no counterpart and is recorded, then dropped.
 * - The four plugin sections keep only the keys their plugin declares
 *   volatile, each with a value that plugin accepts.
 * - `llm-deepseek.baseURL` on `api.deepseek.com` is dropped: every such
 *   address served the chat-completions protocol, and this build's adapter
 *   speaks Messages at its own default. Any other host is kept, and the user is
 *   told once that it may need changing.
 *
 * The profile's patch layer also loses a duplicate gateway `insert` row an
 * earlier sync kept because it had been edited: the gateway's own bundle
 * layer inserts that id, so the copy is rewritten as an id-targeted row
 * carrying the same config. That row, and every id-targeted gateway row whose
 * `config` has no `alwaysAsk`, gets {@link GATEWAY_ALWAYS_ASK}: its `config`
 * replaces the desktop layer's, which is where `plugin_manager` joins the map.
 *
 * The gateway rows are left alone until the seeding has retired the permission
 * rows an older build copied into the patch layer (`permissionPatch` in
 * `web-migration.json`): both steps are one-time, and a seeded gateway row
 * rewritten or completed first would no longer be the copy the retirement
 * recognizes. A profile without `web-migration.json` never received those
 * rows, and the seeding earlier in the same launch has already looked for
 * them, so its gateway step runs at once. The rest of the run goes ahead
 * either way; the gateway step waits, marked `gatewayDeferred`, for the first
 * launch whose seeding has recorded that retirement.
 *
 * The run's first step moves `settings.yaml` to `settings.yaml.pre-rc34`, the
 * untouched original, before anything else that can fail; the migrated copy
 * is written back as `settings.yaml` last. A launch whose run stops in
 * between starts its server with no `settings.yaml`, so that server imports
 * nothing and runs on the profile's rows; it can never import the file as an
 * rc.33 client left it. The next launch finds the original moved and writes
 * the migrated copy from it. A `settings.yaml` found while the marker is
 * absent or cannot be read replaces any `settings.yaml.pre-rc34` an earlier
 * run left, because the file in place is the one the server would import. A run that finds no `settings.yaml` but a
 * `settings.yaml.imported` another profile's import left, and no marker of
 * its own, copies that file to `settings.yaml.pre-rc34` and migrates it.
 * {@link SETTINGS_MIGRATION_MARKER} records every decision and makes the whole
 * run happen once: it is written `pending` after the move and `done` after the
 * last change. A marker that exists and cannot be read restores nothing: it
 * may stand for a finished run, whose import already happened.
 * @module @deepseek-ai/dsh-desktop-shell/settings-migration
 */

import { chmodSync, existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { Document, isMap, isSeq, parseDocument, YAMLMap } from 'yaml'
import { MIGRATION_MARKER_FILENAME, readMigrationMarker, writeAtomic } from './profile-seed.ts'

/** The migration's record inside the desktop profile directory; distinct from the sync's `web-migration.json`. */
export const SETTINGS_MIGRATION_MARKER = 'settings-migration.json'

/** The legacy settings document under the Harness home. */
const SETTINGS_FILENAME = 'settings.yaml'

/** What the server's import renames {@link SETTINGS_FILENAME} to. */
const IMPORTED_SUFFIX = '.imported'

/** Where the run moves the untouched original before any other change; the only original from then on. */
const BACKUP_SUFFIX = '.pre-rc34'

/** The profile's own patch layer, inside the profile directory. */
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

/** Mode for every file this module writes: `settings.yaml` holds MCP server env and header values. */
const PRIVATE_FILE_MODE = 0o600

/** The parse options for a patch layer: `!!js` scalars are kept as their source text and written back tagged. */
const PATCH_PARSE_OPTIONS = { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }

/** One value a run removed, and why. */
export interface DroppedSetting {
  /** The `settings.yaml` section it was in. */
  section: string
  /** The key inside that section; absent when the whole section went. */
  key?: string
  /** The value as it was read. */
  value: unknown
  /** One sentence naming why nothing kept it. */
  reason: string
}

/** The contents of {@link SETTINGS_MIGRATION_MARKER}. */
export interface SettingsMigrationMarker {
  /** `pending` from the move of `settings.yaml` until the last change; `done` makes every later launch skip the run. */
  state: 'pending' | 'done'
  /** True when the original was copied from the `settings.yaml.imported` another profile's import left. */
  restoredImported?: boolean
  /** True while the gateway step waits for the seeding to record its permission-row retirement. */
  gatewayDeferred?: boolean
  /** The messages for the user that no window has shown yet; cleared by {@link acknowledgeSettingsMigrationNotices}. */
  notices?: string[]
  /** The duplicate gateway insert row as it stood before the rewrite, and the id-targeted row after it. */
  gatewayRow?: { before: string; after?: string }
  /** The legacy gateway `mode` value, which no build reads any more. */
  gatewayModeDropped?: unknown
  /**
   * How many gateway rows get {@link GATEWAY_ALWAYS_ASK}, counted before the
   * first change, so a run resumed from `pending` records the same number.
   */
  alwaysAskAdded?: number
  /** The `llm-deepseek.baseURL` a run found, and whether it was kept. */
  baseURL?: { value: string; kept: boolean }
  /** The ids of the profile rows this migration wrote. */
  rows: string[]
  /** Every value dropped instead of imported. */
  dropped: DroppedSetting[]
  /** One line per section or row left alone, each saying why. */
  skipped: string[]
}

/** What one run did, for the launch log and the window. */
export interface SettingsMigrationReport {
  /** Log lines; empty for a launch the marker already covers. */
  lines: string[]
  /** Plain-language messages the window shows the user once, after it has loaded. */
  notices: string[]
}

/** A predicate over one value read from `settings.yaml`, mirroring how the plugin's schema would judge it. */
export type SettingCheck = (value: unknown) => boolean

/** Absent or null: the schema substitutes a default, or keeps the absence. */
function isNullable(value: unknown): value is null | undefined {
  return value === null || value === undefined
}

/** A plain mapping, as the schema library accepts one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Any string. */
const text: SettingCheck = value => typeof value === 'string'

/** Any boolean. */
const flag: SettingCheck = value => typeof value === 'boolean'

/**
 * A number in a range and on a step, judged the way the schema library judges
 * one: the comparisons are `>` and `<`, so a bound only rejects what is past
 * it, and a step is counted from the minimum.
 */
function number(range: { min?: number; max?: number; step?: number } = {}): SettingCheck {
  const { min, max, step } = range
  return value => typeof value === 'number'
    && !(value > (max ?? Infinity)) && !(value < (min ?? -Infinity))
    && (step === undefined || (value - (min ?? 0)) % step === 0)
}

/** A value that may be absent: absent passes, or is judged as `fallback` when the schema substitutes one. */
function optional(check: SettingCheck, fallback?: unknown): SettingCheck {
  return value => (isNullable(value) ? fallback === undefined || check(fallback) : check(value))
}

/** A value that must be present. */
function required(check: SettingCheck): SettingCheck {
  return value => !isNullable(value) && check(value)
}

/** A list whose every member passes `member`, which judges absent members itself. */
function list(member: SettingCheck): SettingCheck {
  return value => Array.isArray(value) && value.every(member)
}

/** A mapping whose declared fields pass; undeclared fields are carried, as the schema carries them. */
function fields(shape: Record<string, SettingCheck>): SettingCheck {
  return value => isRecord(value) && Object.entries(shape).every(([key, check]) => check(value[key]))
}

/** A mapping whose every value passes `member`. */
function dictionary(member: SettingCheck): SettingCheck {
  return value => isRecord(value) && Object.values(value).every(member)
}

/** One price rate block (`@sumomok/dsh-balance` `rates`). */
const rates = fields({
  input: optional(number({ min: 0 })),
  inputCacheHit: optional(number({ min: 0 })),
  output: optional(number({ min: 0 })),
  cacheWrite: optional(number({ min: 0 })),
  reasoning: optional(number({ min: 0 })),
})

/** One time window of a price schedule. */
const priceWindow = fields({
  start: required(text),
  end: required(text),
  days: optional(list(optional(number({ min: 0, max: 6, step: 1 }))), []),
})

/** One price schedule. */
const schedule = fields({
  name: required(text),
  windows: required(list(optional(priceWindow, {}))),
  rates: optional(rates, {}),
  multiplier: optional(number({ min: 0 })),
})

/** One model's price entry. */
const priceEntry = fields({
  model: required(text),
  provider: optional(text),
  per: optional(number({ min: 1 }), 1_000_000),
  base: required(rates),
  baseName: optional(text),
  timezone: optional(text, 'UTC'),
  schedules: optional(list(optional(schedule, {})), []),
})

/** The whole price table `@sumomok/dsh-balance` 0.6.0 takes in `prices`. */
const priceTable = fields({
  asOf: required(text),
  tables: optional(dictionary(optional(fields({ entries: optional(list(optional(priceEntry, {})), []) }), {})), {}),
})

/**
 * The keys each plugin section may carry into the import, with the values the
 * plugin's own `Config` accepts for each: exactly the plugin's volatile fields.
 * The shell cannot import the plugins, so this is a copy;
 * `tests/settings-migration-whitelist.spec.ts` holds it to the vendored
 * packages' schemas key for key and value for value.
 */
export const PLUGIN_SECTION_KEYS: Readonly<Record<string, Readonly<Record<string, SettingCheck>>>> = {
  'llm-permission-gateway': {
    walledReview: flag,
    judgeProvider: text,
    judgeModel: text,
    judgeReasoningEffort: text,
  },
  'auto-compact': {
    enabled: flag,
    thresholdPercent: number({ min: 20, max: 95, step: 1 }),
  },
  'mcp-servers': {
    servers: value => Array.isArray(value),
  },
  balance: {
    lowBalance: number({ min: 0 }),
    criticalBalance: number({ min: 0 }),
    maskBalance: flag,
    prices: priceTable,
  },
}

/** `ui-theme`'s two volatile fields and their values (`packages/client/ui-theme/src/theme-settings.ts`). */
const THEME_KEYS: Readonly<Record<string, SettingCheck>> = {
  preference: value => value === 'light' || value === 'dark' || value === 'system',
  fontSize: number({ min: 12, max: 17, step: 1 }),
}

/**
 * `DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES` in
 * `packages/context/file-reference-local/src/search.ts`. A configured list
 * replaces it whole, so a row that adds names has to restate these first.
 */
export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = [
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', 'target', '.next', '.nuxt', '.turbo', '.venv',
  '__pycache__', '.pytest_cache', '.mypy_cache', '.gradle',
]

/** dsh-at-file 0.7.0's `DEFAULT_IGNORE_FILES`: what its global list meant when never configured. */
const AT_FILE_DEFAULT_IGNORE_FILES: readonly string[] = ['desktop.ini', 'Thumbs.db', '.DS_Store']

/**
 * The `alwaysAsk` map `apps/desktop-app/cordis.patch.yml` sets on the
 * `llm-permission-gateway` row. `tests/settings-migration.spec.ts` holds the
 * two equal, so the desktop layer stays the one source of the map.
 */
export const GATEWAY_ALWAYS_ASK: Readonly<Record<string, string>> = {
  browser_auth: '这一步会把你浏览器里这个网站的登录状态交给助手——那个网址下的所有登录信息都在内。之后它做的每一件事，都是以你本人的身份登录着做的。',
  plugin_manager: '这一步会改动这台电脑上装的插件：安装、移除、启用或停用插件，或者放行一个与当前版本不兼容的插件，停用的也可能是负责审查的这个插件本身。装上的插件代码在应用里运行，不受工作区沙箱限制，改动对之后的所有对话都生效。',
}

/** The host every chat-completions address DeepSeek published is on. */
const DEEPSEEK_API_HOST = 'api.deepseek.com'

/**
 * Run the migration once for this Harness home, or, when the marker says it is
 * done, finish a deferred gateway step and return the notices no window has
 * shown yet.
 *
 * Never throws: a fault leaves the marker `pending`, so the next launch runs
 * it again, and becomes one log line naming it.
 * @param home - the Harness home, holding `settings.yaml`.
 * @param profileDir - the desktop profile directory, holding the marker and the patch layer.
 * @returns the lines to log and the notices to show.
 */
export function migrateLegacySettings(home: string, profileDir: string): SettingsMigrationReport {
  const report: SettingsMigrationReport = { lines: [], notices: [] }
  try {
    runMigration(home, profileDir, report)
  } catch (error) {
    report.lines.push(`settings migration stopped and will run again next launch: ${String(error)}`)
    // The run that finishes records its own notices; showing these now would show them twice.
    report.notices.length = 0
  }
  return report
}

/**
 * Record that a window has shown every notice the marker holds, so no later
 * launch shows them again.
 * @param profileDir - the desktop profile directory, holding the marker.
 * @throws when the marker cannot be replaced.
 */
export function acknowledgeSettingsMigrationNotices(profileDir: string): void {
  const path = join(profileDir, SETTINGS_MIGRATION_MARKER)
  const read = readMarker(path)
  if (read.kind !== 'marker' || read.marker.notices === undefined) return
  const marker = { ...read.marker }
  delete marker.notices
  writeMarker(path, marker)
}

/** What reading {@link SETTINGS_MIGRATION_MARKER} found. */
type MarkerRead =
  | { kind: 'absent' }
  | { kind: 'corrupt'; detail: string }
  | { kind: 'marker'; marker: SettingsMigrationMarker }

/**
 * Read the marker, telling a file that is not there from one that cannot be read.
 * @param path - the marker path.
 * @returns what the path holds.
 */
function readMarker(path: string): MarkerRead {
  if (!existsSync(path)) return { kind: 'absent' }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    return { kind: 'corrupt', detail: String(error) }
  }
  return isSettingsMigrationMarker(parsed) ? { kind: 'marker', marker: parsed } : { kind: 'corrupt', detail: 'not a settings migration marker' }
}

/**
 * Read the marker, or undefined when there is none or it is not one this
 * module wrote.
 * @param path - the marker path.
 * @returns the marker.
 */
export function readSettingsMigrationMarker(path: string): SettingsMigrationMarker | undefined {
  const read = readMarker(path)
  return read.kind === 'marker' ? read.marker : undefined
}

/** Whether parsed JSON holds the fields every marker this module writes carries. */
function isSettingsMigrationMarker(value: unknown): value is SettingsMigrationMarker {
  return isRecord(value) && (value['state'] === 'pending' || value['state'] === 'done')
    && Array.isArray(value['rows']) && Array.isArray(value['dropped']) && Array.isArray(value['skipped'])
}

/** Write the marker, private to the user like the files it describes. */
function writeMarker(path: string, marker: SettingsMigrationMarker): void {
  writeAtomic(path, `${JSON.stringify(marker, undefined, 2)}\n`, PRIVATE_FILE_MODE)
}

/** The body {@link migrateLegacySettings} guards. */
function runMigration(home: string, profileDir: string, report: SettingsMigrationReport): void {
  const markerPath = join(profileDir, SETTINGS_MIGRATION_MARKER)
  const read = readMarker(markerPath)
  const previous = read.kind === 'marker' ? read.marker : undefined
  const patchPath = join(profileDir, PROFILE_PATCH_FILENAME)
  if (previous?.state === 'done') {
    report.notices.push(...(previous.notices ?? []))
    if (previous.gatewayDeferred !== true || !permissionRowsSettled(profileDir)) return
    try {
      finishDeferredGatewayStep(markerPath, previous, patchPath, report)
    } catch (error) {
      report.lines.push(`the deferred llm-permission-gateway step stopped and will run again next launch: ${String(error)}`)
    }
    return
  }
  const settingsPath = join(home, SETTINGS_FILENAME)
  const importedPath = `${settingsPath}${IMPORTED_SUFFIX}`
  const backupPath = `${settingsPath}${BACKUP_SUFFIX}`

  const marker: SettingsMigrationMarker = { state: 'pending', rows: [], dropped: [], skipped: [] }
  if (read.kind === 'corrupt') {
    report.lines.push(`${SETTINGS_MIGRATION_MARKER} cannot be read (${read.detail}); only a ${SETTINGS_FILENAME} still in place is migrated, and nothing is restored from ${SETTINGS_FILENAME}${IMPORTED_SUFFIX} or ${SETTINGS_FILENAME}${BACKUP_SUFFIX}`)
  }
  const pending = previous?.state === 'pending'
  // The first step, before anything else that can fail: from here on this
  // launch's server finds no settings.yaml it could import as rc.33 left it.
  const inPlace = existsSync(settingsPath)
  let hasSettings = inPlace
  if (inPlace && !(pending && existsSync(backupPath))) {
    renameSync(settingsPath, backupPath)
    chmodSync(backupPath, PRIVATE_FILE_MODE)
  } else if (!inPlace && read.kind !== 'corrupt' && existsSync(backupPath)) {
    hasSettings = true
    report.lines.push(`the last run stopped before it finished; writing the migrated copy from ${SETTINGS_FILENAME}${BACKUP_SUFFIX}`)
  } else if (!inPlace && existsSync(importedPath) && (read.kind === 'absent' || pending)) {
    // S5: the only original is the file another profile's import renamed.
    hasSettings = true
    writeAtomic(backupPath, readFileSync(importedPath), PRIVATE_FILE_MODE)
    marker.restoredImported = true
    report.lines.push(`copied ${SETTINGS_FILENAME}${IMPORTED_SUFFIX} to ${SETTINGS_FILENAME}${BACKUP_SUFFIX} for this profile's import`)
  }
  if (previous?.restoredImported === true) marker.restoredImported = true

  const gatewayReady = permissionRowsSettled(profileDir)
  if (gatewayReady) planGatewayStep(patchPath, previous, marker)
  else {
    marker.gatewayDeferred = true
    report.lines.push(`left the llm-permission-gateway rows in ${PROFILE_PATCH_FILENAME} for a launch whose seeding has retired the copied permission rows`)
  }
  writeMarker(markerPath, marker)
  if (gatewayReady) applyGatewayStep(patchPath, marker, report)

  if (hasSettings) {
    const document = parseDocument(readFileSync(backupPath, 'utf8'))
    if (document.errors[0] !== undefined) {
      marker.skipped.push(`${SETTINGS_FILENAME}: not readable YAML, kept only in ${SETTINGS_FILENAME}${BACKUP_SUFFIX} (${document.errors[0].message})`)
    } else if (!isRecord(document.toJS())) {
      marker.skipped.push(`${SETTINGS_FILENAME}: not a mapping of sections, kept only in ${SETTINGS_FILENAME}${BACKUP_SUFFIX}`)
    } else {
      migratePresets(document, marker)
      migrateTheme(document, patchPath, marker)
      migrateAtFile(document, patchPath, marker)
      stripPluginSections(document, marker)
      migrateBaseUrl(document, marker, report)
      writeAtomic(settingsPath, document.toString(), PRIVATE_FILE_MODE)
    }
  }

  marker.state = 'done'
  if (report.notices.length > 0) marker.notices = [...report.notices]
  writeMarker(markerPath, marker)
  if (marker.rows.length > 0) report.lines.push(`wrote ${marker.rows.join(', ')} into ${PROFILE_PATCH_FILENAME} from ${SETTINGS_FILENAME}`)
  if (marker.dropped.length > 0) {
    report.lines.push(`dropped ${marker.dropped.map(entry => (entry.key === undefined ? entry.section : `${entry.section}.${entry.key}`)).join(', ')} from ${SETTINGS_FILENAME}; recorded in ${SETTINGS_MIGRATION_MARKER}`)
  }
  for (const line of marker.skipped) report.lines.push(`skipped ${line}`)
}

/**
 * Whether the seeding's permission-row retirement, which the gateway step
 * must follow, has run for this profile.
 *
 * Only the web sync that writes `web-migration.json` copies those rows, and
 * the seeding retires them on every launch that finds no such file, earlier in
 * this same launch. So a profile without the file is settled, and one whose
 * file holds no `permissionPatch`, readable or not, is still waiting.
 * @param profileDir - the desktop profile directory.
 * @returns true when the gateway step may change the patch layer.
 */
function permissionRowsSettled(profileDir: string): boolean {
  const seeded = readMigrationMarker(join(profileDir, MIGRATION_MARKER_FILENAME))
  return seeded === undefined || seeded.permissionPatch !== undefined
}

/**
 * Record, before any change, what the gateway step will change: the duplicate
 * insert row's text and how many rows get {@link GATEWAY_ALWAYS_ASK}. A run
 * resumed from `pending` keeps what the first run recorded.
 */
function planGatewayStep(patchPath: string, previous: SettingsMigrationMarker | undefined, marker: SettingsMigrationMarker): void {
  const before = previous?.gatewayRow?.before ?? duplicateGatewayRowText(patchPath)
  if (before !== undefined) marker.gatewayRow = { before }
  const alwaysAskAdded = previous?.alwaysAskAdded ?? gatewayRowsWithoutAlwaysAsk(patchPath)
  if (alwaysAskAdded > 0) marker.alwaysAskAdded = alwaysAskAdded
}

/** S3 and the `alwaysAsk` completion, recording the id-targeted row they leave. */
function applyGatewayStep(patchPath: string, marker: SettingsMigrationMarker, report: SettingsMigrationReport): void {
  if (rewriteDuplicateGatewayRow(patchPath) !== undefined) {
    report.lines.push(`rewrote the duplicate llm-permission-gateway insert row in ${PROFILE_PATCH_FILENAME} as an id-targeted row`)
  }
  if (addGatewayAlwaysAsk(patchPath) > 0) {
    report.lines.push(`added the desktop alwaysAsk map to ${String(marker.alwaysAskAdded ?? 0)} llm-permission-gateway row(s) in ${PROFILE_PATCH_FILENAME}`)
  }
  // A run resumed from `pending` finds the row already rewritten.
  const after = targetedGatewayRowText(patchPath)
  if (marker.gatewayRow !== undefined && after !== undefined) marker.gatewayRow.after = after
}

/**
 * Run the gateway step a finished migration deferred. The plan is written
 * first, still marked deferred, so a launch that stops partway records what
 * the first attempt found.
 */
function finishDeferredGatewayStep(
  markerPath: string, previous: SettingsMigrationMarker, patchPath: string, report: SettingsMigrationReport,
): void {
  const marker: SettingsMigrationMarker = { ...previous }
  planGatewayStep(patchPath, previous, marker)
  writeMarker(markerPath, marker)
  applyGatewayStep(patchPath, marker, report)
  delete marker.gatewayDeferred
  writeMarker(markerPath, marker)
}

/** A section of the document as plain data, or undefined when it is absent. */
function sectionOf(document: Document, section: string): unknown {
  const node: unknown = document.get(section, true)
  return node === undefined ? undefined : (document.toJS() as Record<string, unknown>)[section]
}

/** Record one dropped value and take it out of the document. */
function drop(document: Document, marker: SettingsMigrationMarker, entry: DroppedSetting): void {
  marker.dropped.push(entry)
  document.deleteIn(entry.key === undefined ? [entry.section] : [entry.section, entry.key])
}

/**
 * Rewrite `agent-presets` as the `agent-preset-registry` section the import
 * can take (S6 included).
 */
function migratePresets(document: Document, marker: SettingsMigrationMarker): void {
  const section = sectionOf(document, 'agent-presets')
  if (section === undefined) return
  document.deleteIn(['agent-presets'])
  if (!isRecord(section)) {
    marker.dropped.push({ section: 'agent-presets', value: section, reason: 'not a mapping' })
    return
  }
  let selected: string | undefined
  for (const [key, value] of Object.entries(section)) {
    if (key === 'default' && typeof value === 'string') {
      selected = value === 'code' ? 'ptc' : value
      continue
    }
    marker.dropped.push({ section: 'agent-presets', key, value, reason: key === 'modeSelectionEnabled' ? 'this build has no mode-selection switch' : 'no field of agent-preset-registry takes it' })
  }
  if (section['modeSelectionEnabled'] === false && selected !== undefined) {
    // Mode selection off meant new sessions ran the deployment default, and
    // this build has no switch to hide the choice again.
    marker.dropped.push({ section: 'agent-presets', key: 'default', value: section['default'], reason: 'mode selection was off, so new sessions keep the deployment default' })
    return
  }
  if (selected !== undefined) document.setIn(['agent-preset-registry', 'selectedDefault'], selected)
}

/** Write `ui-theme` into the profile's row, then take the section out. */
function migrateTheme(document: Document, patchPath: string, marker: SettingsMigrationMarker): void {
  const section = sectionOf(document, 'ui-theme')
  if (section === undefined) return
  if (!isRecord(section)) {
    drop(document, marker, { section: 'ui-theme', value: section, reason: 'not a mapping' })
    return
  }
  const config: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(section)) {
    const check = THEME_KEYS[key]
    if (check !== undefined && check(value)) config[key] = value
    else marker.dropped.push({ section: 'ui-theme', key, value, reason: check === undefined ? 'ui-theme has no such field' : 'not a value ui-theme accepts' })
  }
  if (Object.keys(config).length === 0 || writeProfileRow(patchPath, { id: 'ui-theme', config }, marker)) {
    document.deleteIn(['ui-theme'])
  }
}

/**
 * Carry what the withdrawn `at-file` section can express over to the rows that
 * replaced it, then take the section out.
 */
function migrateAtFile(document: Document, patchPath: string, marker: SettingsMigrationMarker): void {
  const section = sectionOf(document, 'at-file')
  if (section === undefined) return
  if (!isRecord(section)) {
    drop(document, marker, { section: 'at-file', value: section, reason: 'not a mapping' })
    return
  }
  let written = true
  for (const [key, value] of Object.entries(section)) {
    if (key === 'enabled' || key === 'ignoreFiles' || key === 'ignoreFilesConfigured') continue
    const empty = (key === 'workspaceIgnoreFiles' && Array.isArray(value) && value.length === 0)
      || (key === 'ignorePastedMentions' && value === true)
    if (!empty) marker.dropped.push({ section: 'at-file', key, value, reason: 'the @ references that replaced dsh-at-file have no such setting' })
  }
  if (section['enabled'] === false) written = writeProfileRow(patchPath, { id: 'ui-reference', disabled: true }, marker) && written
  const extra = excludedDirectoriesFrom(section, marker)
  if (extra.length > 0) {
    written = writeProfileRow(
      patchPath, { id: 'file-reference-local', config: { excludedDirectories: [...DEFAULT_EXCLUDED_DIRECTORIES, ...extra] } }, marker,
    ) && written
  }
  if (written) document.deleteIn(['at-file'])
}

/**
 * The names from at-file's global ignore list that `excludedDirectories` can
 * take: its exact rules, when the list differs from at-file's own default.
 *
 * at-file hid files by name, while `excludedDirectories` hides directories by
 * name, so these only act where a workspace has a directory of that name.
 * Regular expressions, case-sensitivity, and a name with a path separator have
 * no counterpart and are recorded instead.
 */
function excludedDirectoriesFrom(section: Record<string, unknown>, marker: SettingsMigrationMarker): string[] {
  const configured = section['ignoreFiles']
  if (configured !== undefined && !Array.isArray(configured)) {
    marker.dropped.push({ section: 'at-file', key: 'ignoreFiles', value: configured, reason: 'not a list' })
  }
  const rules: readonly unknown[] = Array.isArray(configured) && (configured.length > 0 || section['ignoreFilesConfigured'] === true)
    ? configured
    : AT_FILE_DEFAULT_IGNORE_FILES
  // at-file's own rule identity: an exact rule that is not case-sensitive compares lowercased.
  const keyOf = (rule: unknown): string => {
    if (typeof rule === 'string') return JSON.stringify(['exact', rule.trim().toLowerCase(), false])
    if (!isRecord(rule)) return JSON.stringify(rule)
    const pattern = typeof rule['pattern'] === 'string' ? rule['pattern'].trim() : rule['pattern']
    const folded = rule['kind'] === 'exact' && rule['caseSensitive'] !== true && typeof pattern === 'string' ? pattern.toLowerCase() : pattern
    return JSON.stringify([rule['kind'], folded, rule['caseSensitive'] === true])
  }
  const defaults = new Set(AT_FILE_DEFAULT_IGNORE_FILES.map(keyOf))
  const given = new Set(rules.map(keyOf))
  if (given.size === defaults.size && [...given].every(key => defaults.has(key))) return []

  const names: string[] = []
  for (const rule of rules) {
    const exact = typeof rule === 'string' ? rule : isRecord(rule) && rule['kind'] === 'exact' && typeof rule['pattern'] === 'string' ? rule['pattern'] : undefined
    if (exact === undefined) {
      marker.dropped.push({ section: 'at-file', key: 'ignoreFiles', value: rule, reason: 'excludedDirectories takes directory names, not patterns' })
      continue
    }
    const name = exact.trim()
    if (name.length === 0 || name.includes('/') || name.includes('\\')) {
      marker.dropped.push({ section: 'at-file', key: 'ignoreFiles', value: rule, reason: 'excludedDirectories takes a single non-empty name' })
      continue
    }
    if (isRecord(rule) && rule['caseSensitive'] === true) {
      marker.dropped.push({ section: 'at-file', key: 'ignoreFiles', value: { caseSensitive: true, pattern: name }, reason: 'excludedDirectories has no case setting; the name is kept' })
    }
    if (!DEFAULT_EXCLUDED_DIRECTORIES.includes(name) && !names.includes(name)) names.push(name)
  }
  return names
}

/** S1: keep only each plugin section's volatile keys, and only values the plugin accepts. */
function stripPluginSections(document: Document, marker: SettingsMigrationMarker): void {
  for (const [section, keys] of Object.entries(PLUGIN_SECTION_KEYS)) {
    const values = sectionOf(document, section)
    if (values === undefined) continue
    if (!isRecord(values)) {
      drop(document, marker, { section, value: values, reason: 'not a mapping' })
      continue
    }
    for (const [key, value] of Object.entries(values)) {
      const check = keys[key]
      if (check !== undefined && check(value)) continue
      if (section === 'llm-permission-gateway' && key === 'mode') marker.gatewayModeDropped = value
      drop(document, marker, { section, key, value, reason: check === undefined ? `${section} declares no such setting` : `not a value ${section} accepts` })
    }
    if (Object.keys(sectionOf(document, section) as Record<string, unknown>).length === 0) document.deleteIn([section])
  }
}

/** S4: drop a DeepSeek chat-completions `baseURL`; keep any other and tell the user once. */
function migrateBaseUrl(document: Document, marker: SettingsMigrationMarker, report: SettingsMigrationReport): void {
  const section = sectionOf(document, 'llm-deepseek')
  if (!isRecord(section) || typeof section['baseURL'] !== 'string') return
  const value = section['baseURL']
  let host: string | undefined
  try {
    host = new URL(value).hostname
  } catch {
    // Not an absolute URL: not DeepSeek's host either, so it is kept and reported like any other.
    host = undefined
  }
  if (host === DEEPSEEK_API_HOST) {
    marker.baseURL = { value, kept: false }
    drop(document, marker, { section: 'llm-deepseek', key: 'baseURL', value, reason: 'a DeepSeek chat-completions address; this build uses its own default address' })
    if (Object.keys(sectionOf(document, 'llm-deepseek') as Record<string, unknown>).length === 0) document.deleteIn(['llm-deepseek'])
    return
  }
  marker.baseURL = { value, kept: true }
  report.notices.push(`新版本连接模型服务的方式变了。你之前设置的自定义服务地址 ${value} 可能需要换成新的地址，可以在设置的模型页里修改。`)
}

/**
 * Parse the profile patch layer, or undefined when it cannot be edited here.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @param marker - extended with the reason when the file cannot be edited.
 * @returns the document, holding a block sequence.
 */
function readPatchLayer(patchPath: string, marker?: SettingsMigrationMarker): Document | undefined {
  let text = '[]\n'
  if (existsSync(patchPath)) text = readFileSync(patchPath, 'utf8')
  const document = parseDocument(text, PATCH_PARSE_OPTIONS)
  if (document.errors[0] !== undefined || !isSeq(document.contents)) {
    marker?.skipped.push(`${PROFILE_PATCH_FILENAME}: not a YAML sequence this shell can edit`)
    return undefined
  }
  document.contents.flow = false
  return document
}

/**
 * Append one id-targeted row to the profile's patch layer.
 *
 * A top-level row for the same id that already carries the same fields counts
 * as written, which is what a run resumed from `pending` finds; one that
 * carries anything else is the user's and stays, and the section it would
 * have replaced is dropped with it.
 * @returns true when the row is in the file as given, or the file already
 * holds a row of its own for that id; false when the file could not be edited.
 */
function writeProfileRow(patchPath: string, row: { id: string } & Record<string, unknown>, marker: SettingsMigrationMarker): boolean {
  const document = readPatchLayer(patchPath, marker)
  if (document === undefined) return false
  const items = (document.contents as { items: unknown[] }).items
  const existing = items.findLast(item => isMap(item) && item.get('id') === row.id && !item.has('insert'))
  if (existing !== undefined) {
    if (JSON.stringify((existing as YAMLMap).toJSON()) === JSON.stringify(row)) marker.rows.push(row.id)
    else marker.skipped.push(`${PROFILE_PATCH_FILENAME}: already has its own ${row.id} row; left exactly as it is`)
    return true
  }
  document.add(document.createNode(row))
  writeAtomic(patchPath, document.toString(), PRIVATE_FILE_MODE)
  marker.rows.push(row.id)
  return true
}

/** The first top-level `insert` entry that inserts `llm-permission-gateway`, with that row's position in it. */
function findDuplicateGatewayRow(document: Document): { entry: number; row: number } | undefined {
  const items = (document.contents as { items: unknown[] }).items
  for (const [entry, item] of items.entries()) {
    if (!isMap(item)) continue
    const insert = item.get('insert', true)
    if (!isSeq(insert)) continue
    const row = insert.items.findIndex(inserted => isMap(inserted) && inserted.get('id') === 'llm-permission-gateway')
    if (row >= 0) return { entry, row }
  }
  return undefined
}

/** One node of a patch layer as the YAML text it would be written as, `!!js` tags included. */
function nodeText(node: unknown): string {
  const document = new Document(undefined, PATCH_PARSE_OPTIONS)
  document.contents = node as Document['contents']
  return document.toString()
}

/** The text of the entry {@link rewriteDuplicateGatewayRow} would rewrite, or undefined when there is none. */
function duplicateGatewayRowText(patchPath: string): string | undefined {
  if (!existsSync(patchPath)) return undefined
  const document = readPatchLayer(patchPath)
  if (document === undefined) return undefined
  const found = findDuplicateGatewayRow(document)
  if (found === undefined) return undefined
  return nodeText((document.contents as { items: unknown[] }).items[found.entry])
}

/** The text of the last id-targeted gateway row in the patch layer, or undefined when there is none. */
function targetedGatewayRowText(patchPath: string): string | undefined {
  const document = readPatchLayer(patchPath)
  if (document === undefined) return undefined
  const items = (document.contents as { items: unknown[] }).items
  const row = items.findLast(item => isMap(item) && item.get('id') === 'llm-permission-gateway' && !item.has('insert'))
  return row === undefined ? undefined : nodeText(row)
}

/** A gateway row's `config` mapping when it has no `alwaysAsk`, which is what {@link addGatewayAlwaysAsk} completes. */
function configWithoutAlwaysAsk(row: unknown): YAMLMap | undefined {
  if (!isMap(row) || row.get('id') !== 'llm-permission-gateway') return undefined
  const config = row.get('config', true)
  return isMap(config) && !config.has('alwaysAsk') ? config : undefined
}

/**
 * How many gateway rows {@link rewriteDuplicateGatewayRow} and
 * {@link addGatewayAlwaysAsk} together give the desktop `alwaysAsk` map: the
 * id-targeted ones and the one inside a duplicate `insert` entry.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns the count, zero when the layer is absent or cannot be edited.
 */
function gatewayRowsWithoutAlwaysAsk(patchPath: string): number {
  if (!existsSync(patchPath)) return 0
  const document = readPatchLayer(patchPath)
  if (document === undefined) return 0
  const items = (document.contents as { items: unknown[] }).items
  const targeted = items.filter(item => isMap(item) && !item.has('insert') && configWithoutAlwaysAsk(item) !== undefined).length
  const duplicate = findDuplicateGatewayRow(document)
  if (duplicate === undefined) return targeted
  const insert = (items[duplicate.entry] as YAMLMap).get('insert', true)
  return targeted + (isSeq(insert) && configWithoutAlwaysAsk(insert.items[duplicate.row]) !== undefined ? 1 : 0)
}

/**
 * Give every top-level id-targeted gateway row whose `config` mapping has no
 * `alwaysAsk` the desktop layer's map. A row without a `config` mapping is left
 * alone: it does not replace the desktop layer's `config`, and giving it one
 * would drop that layer's required `provider` and `model`.
 * @param patchPath - the profile's `cordis.patch.yml`.
 * @returns how many rows it changed.
 */
function addGatewayAlwaysAsk(patchPath: string): number {
  if (!existsSync(patchPath)) return 0
  const document = readPatchLayer(patchPath)
  if (document === undefined) return 0
  let changed = 0
  for (const item of (document.contents as { items: unknown[] }).items) {
    const config = isMap(item) && !item.has('insert') ? configWithoutAlwaysAsk(item) : undefined
    if (config === undefined) continue
    config.set('alwaysAsk', document.createNode({ ...GATEWAY_ALWAYS_ASK }))
    changed += 1
  }
  if (changed > 0) writeAtomic(patchPath, document.toString(), PRIVATE_FILE_MODE)
  return changed
}

/**
 * S3: take the gateway row out of an `insert` list and restate it as an
 * id-targeted row with the same fields, `name` aside.
 *
 * The gateway's bundle layer inserts that id itself, and a second insert of
 * it keeps the gateway's settings page from mounting and makes `/review` fail;
 * an id-targeted row patches the one the bundle inserts instead. An `insert`
 * list left empty goes with it.
 * @returns the id-targeted row's text, or undefined when there was nothing to rewrite.
 */
function rewriteDuplicateGatewayRow(patchPath: string): string | undefined {
  if (!existsSync(patchPath)) return undefined
  const document = readPatchLayer(patchPath)
  if (document === undefined) return undefined
  const found = findDuplicateGatewayRow(document)
  if (found === undefined) return undefined
  const items = (document.contents as { items: unknown[] }).items
  const entry = items[found.entry] as YAMLMap
  const insert = entry.get('insert', true)
  if (!isSeq(insert)) return undefined
  const [inserted] = insert.items.splice(found.row, 1) as YAMLMap[]
  const targeted = new YAMLMap()
  targeted.set('id', 'llm-permission-gateway')
  for (const pair of inserted?.items ?? []) {
    const key = String((pair.key as { value?: unknown } | null)?.value ?? pair.key)
    if (key !== 'id' && key !== 'name') targeted.items.push(pair)
  }
  if (insert.items.length === 0) items.splice(found.entry, 1, targeted)
  else items.splice(found.entry + 1, 0, targeted)
  writeAtomic(patchPath, document.toString(), PRIVATE_FILE_MODE)
  return nodeText(targeted)
}
